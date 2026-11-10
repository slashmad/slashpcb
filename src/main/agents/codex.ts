// Codex adapter: the user's own `codex app-server` (JSON-RPC without the jsonrpc field, JSONL over stdio).
// Verified 2026-11-08 with the VS Code-bundled 0.162.0-alpha: initialize, account, rate limits, thread/start.
// Turns and approvals were blocked by the user's weekly limit and are implemented from the schema.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { PermissionDecision, SessionSummary, UsageSnapshot } from "../../shared/types";
import { AgentSession, type AgentStartOptions } from "./base";
import { agentEnv, spawnSpec } from "./binaries";
import { MCP_NAME } from "./claude";
import { PCB_INSTRUCTIONS } from "./prompt";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

function tomlString(s: string): string {
  return JSON.stringify(s); // JSON string literals are valid TOML basic strings
}

export class CodexRpc {
  proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (id: number | string, method: string, params: any) => void = () => {};
  onExit: (code: number | null, stderr: string) => void = () => {};

  constructor(binary: string, cwd: string, mcp?: AgentStartOptions["mcp"], extra: Record<string, AgentStartOptions["mcp"]> = {}) {
    const args = ["app-server"];
    const servers: Record<string, NonNullable<AgentStartOptions["mcp"]>> = mcp ? { [MCP_NAME]: mcp, ...extra } : {};
    for (const [name, m] of Object.entries(servers)) {
      const envToml = "{" + Object.entries(m.env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(", ") + "}";
      args.push(
        "-c", `mcp_servers.${name}.command=${tomlString(m.command)}`,
        "-c", `mcp_servers.${name}.args=[${m.args.map(tomlString).join(", ")}]`,
        "-c", `mcp_servers.${name}.env=${envToml}`,
      );
    }
    const spec = spawnSpec(binary, args);
    this.proc = spawn(spec.command, spec.args, { cwd, env: agentEnv(spec.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c: string) => this.onData(c));
    let err = "";
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d: string) => { err = (err + d).slice(-4000); });
    this.proc.on("exit", (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`codex exited (${code})`));
      this.pending.clear();
      this.onExit(code, err);
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && !m.method) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
        else p?.resolve(m.result);
      } else if (m.id !== undefined && m.method) this.onRequest(m.id, m.method, m.params);
      else if (m.method) this.onNotification(m.method, m.params);
    }
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + "\n");
  }

  respond(id: number | string, result: unknown): void {
    this.proc.stdin.write(JSON.stringify({ id, result }) + "\n");
  }

  async init(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "slashpcb", title: "SlashPCB", version: "0.1.0" } });
    this.notify("initialized");
  }

  kill(): void { this.proc.stdin.end(); setTimeout(() => this.proc.kill(), 1500); }
}

function windowsFrom(rl: any): UsageSnapshot["windows"] {
  const out: UsageSnapshot["windows"] = [];
  const label = (mins?: number) => (!mins ? "window" : mins <= 300 ? `${Math.round(mins / 60)} h` : mins >= 10080 ? "7 days" : `${Math.round(mins / 1440)} d`);
  for (const w of [rl?.primary, rl?.secondary]) if (w) out.push({ label: label(w.windowDurationMins), usedPercent: w.usedPercent ?? 0, resetsAt: w.resetsAt });
  return out;
}

export class CodexSession extends AgentSession {
  readonly kind = "codex" as const;
  private rpc: CodexRpc | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private pendingApprovals = new Map<string, { id: number | string; method: string }>();
  private usage: UsageSnapshot = { agent: "codex", windows: [] };
  private turnStart = 0;

  async start(o: AgentStartOptions): Promise<void> {
    this.emitEvent({ type: "status", state: "starting" });
    const rpc = new CodexRpc(o.binary, o.cwd, o.mcp, o.extraMcp);
    this.rpc = rpc;
    rpc.onExit = (code, err) => {
      if (this.rpc !== rpc) return;
      this.rpc = null;
      this.busy = false;
      if (code) this.emitEvent({ type: "error", message: `Codex exited (${code}): ${err.trim().slice(-800)}` });
      this.emitEvent({ type: "status", state: "stopped" });
    };
    rpc.onNotification = (m, p) => this.onNotification(m, p);
    rpc.onRequest = (id, m, p) => this.onServerRequest(id, m, p);
    await rpc.init();
    try {
      const acct = await rpc.request("account/read", {});
      this.usage.plan = acct?.account?.planType;
      const rl = await rpc.request("account/rateLimits/read", {});
      this.applyRateLimits(rl?.rateLimits, rl?.ordinaryUsageAllowed);
    } catch { /* optional */ }
    const common = { cwd: o.cwd, approvalPolicy: "on-request", sandbox: "workspace-write", developerInstructions: PCB_INSTRUCTIONS + (o.extraInstructions ?? ""), ...(o.model ? { model: o.model } : {}) };
    const open = (params: Record<string, unknown>) => (o.resumeId ? rpc.request("thread/resume", { threadId: o.resumeId, ...params }) : rpc.request("thread/start", params));
    let res: any;
    try {
      res = await open(common);
    } catch (e: any) {
      // Some platforms (e.g. older Windows builds) reject the workspace-write sandbox: fall back to
      // the user's own Codex configuration instead of failing the session.
      if (!/sandbox/i.test(String(e?.message))) throw e;
      const { sandbox: _drop, ...rest } = common as Record<string, unknown>;
      res = await open(rest);
      this.emitEvent({ type: "error", message: `Codex sandbox "workspace-write" is not available here; using your Codex configuration instead (${e.message}).` });
    }
    this.threadId = res?.thread?.id ?? res?.threadId ?? null;
    this.sessionId = this.threadId;
    if (this.threadId) this.emitEvent({ type: "session", sessionId: this.threadId, model: res?.model });
    if (o.resumeId && res?.thread?.turns) this.replayTurns(res.thread.turns);
    this.emitEvent({ type: "status", state: "idle" });
  }

  private replayTurns(turns: any[]): void {
    for (const t of turns) for (const item of t.items ?? []) this.emitItem(item, true);
  }

  private applyRateLimits(rl: any, ordinaryAllowed?: boolean): void {
    if (!rl) return;
    const w = windowsFrom(rl);
    if (w.length) this.usage.windows = w;
    this.usage.plan = rl.planType ?? this.usage.plan;
    this.usage.note = ordinaryAllowed === false || rl.rateLimitReachedType ? "Limit reached" : undefined;
    this.emitEvent({ type: "usage", usage: { ...this.usage } });
  }

  async send(text: string): Promise<void> {
    if (!this.rpc || !this.threadId) throw new Error("the Codex session is not running");
    this.busy = true;
    this.turnStart = Date.now();
    this.emitEvent({ type: "status", state: "busy" });
    const r = await this.rpc.request("turn/start", { threadId: this.threadId, input: [{ type: "text", text, text_elements: [] }] });
    this.turnId = r?.turn?.id ?? this.turnId;
  }

  async interrupt(): Promise<void> {
    if (this.rpc && this.threadId && this.turnId) await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    const req = this.pendingApprovals.get(requestId);
    if (!req || !this.rpc) return;
    this.pendingApprovals.delete(requestId);
    const d = decision === "deny" ? "decline" : decision === "allow-always" ? "acceptForSession" : "accept";
    const legacy = req.method === "execCommandApproval" || req.method === "applyPatchApproval";
    this.rpc.respond(req.id, { decision: legacy ? (d === "decline" ? "denied" : d === "acceptForSession" ? "approved_for_session" : "approved") : d });
    this.emitEvent({ type: "permission-resolved", requestId, decision });
  }

  stop(): void {
    this.rpc?.kill();
    this.rpc = null;
  }

  private onServerRequest(id: number | string, method: string, p: any): void {
    if (/requestApproval$|Approval$/.test(method)) {
      const requestId = `codex-${id}`;
      this.pendingApprovals.set(requestId, { id, method });
      const tool = method.includes("fileChange") || method === "applyPatchApproval" ? "File change" : method.includes("permissions") ? "Permission" : "Command";
      this.emitEvent({
        type: "permission", requestId, tool, input: p?.command ?? p?.changes ?? p, description: p?.reason ?? p?.cwd ?? undefined, canAlways: true,
      });
    } else {
      // Unsupported interactive request (user input, elicitation): decline so the turn continues.
      this.rpc?.respond(id, method.includes("requestUserInput") ? { answers: {} } : { action: "decline" });
    }
  }

  private emitItem(item: any, completed: boolean): void {
    const ts = Date.now();
    switch (item?.type) {
      case "userMessage": {
        const text = (item.content ?? []).map((c: any) => c.text ?? "").join("");
        if (completed && text) this.emitEvent({ type: "user", id: item.id, text, ts });
        break;
      }
      case "agentMessage":
        if (completed) this.emitEvent({ type: "text", id: item.id, text: item.text ?? "", ts });
        break;
      case "reasoning":
        if (completed && item.summary?.length) this.emitEvent({ type: "thinking", id: item.id, text: item.summary.join("\n") });
        break;
      case "commandExecution":
        this.emitEvent({ type: "tool", id: item.id, name: "Command", input: { command: item.command }, status: completed ? (item.exitCode ? "error" : "done") : "running", output: completed ? String(item.aggregatedOutput ?? "").slice(-2000) : undefined, ts });
        break;
      case "fileChange":
        this.emitEvent({ type: "tool", id: item.id, name: "File change", input: (item.changes ?? []).map((c: any) => c.path), status: completed ? (item.status === "failed" ? "error" : "done") : "running", ts });
        break;
      case "mcpToolCall":
        this.emitEvent({ type: "tool", id: item.id, name: `${item.server}.${item.tool}`, input: item.arguments, status: completed ? (item.error ? "error" : "done") : "running", output: completed ? JSON.stringify(item.error ?? item.result ?? "").slice(0, 2000) : undefined, ts });
        break;
      case "webSearch":
        this.emitEvent({ type: "tool", id: item.id, name: "Web search", input: { query: item.query }, status: completed ? "done" : "running", ts });
        break;
    }
  }

  private onNotification(method: string, p: any): void {
    switch (method) {
      case "turn/started":
        this.turnId = p?.turn?.id ?? this.turnId;
        break;
      case "item/agentMessage/delta":
        this.emitEvent({ type: "text-delta", id: p.itemId, text: p.delta });
        break;
      case "item/started":
        this.emitItem(p.item, false);
        break;
      case "item/completed":
        this.emitItem(p.item, true);
        break;
      case "thread/tokenUsage/updated": {
        const t = p.tokenUsage;
        if (t?.modelContextWindow) this.usage.contextWindow = t.modelContextWindow;
        if (t?.last) this.usage.contextUsed = t.last.inputTokens + t.last.outputTokens;
        if (t?.total) this.usage.sessionTokens = { input: t.total.inputTokens, output: t.total.outputTokens, cached: t.total.cachedInputTokens };
        this.emitEvent({ type: "usage", usage: { ...this.usage } });
        break;
      }
      case "account/rateLimits/updated":
        if (p?.rateLimits?.primary || p?.rateLimits?.secondary) this.applyRateLimits(p.rateLimits);
        break;
      case "error":
        this.emitEvent({ type: "error", message: p?.error?.message ?? "unknown error from Codex" });
        break;
      case "turn/completed": {
        this.busy = false;
        const t = p?.turn;
        this.emitEvent({ type: "turn-complete", durationMs: Date.now() - this.turnStart, error: t?.status === "failed" ? t?.error?.message : undefined });
        this.emitEvent({ type: "status", state: "idle" });
        break;
      }
    }
  }
}

export async function listCodexSessions(binary: string, cwd: string): Promise<SessionSummary[]> {
  const rpc = new CodexRpc(binary, cwd);
  try {
    await rpc.init();
    const r = await rpc.request("thread/list", { cwd, limit: 50 });
    return (r?.data ?? []).map((t: any) => ({
      id: t.id, title: (t.name || t.preview || "(untitled thread)").slice(0, 80),
      updatedAt: (t.updatedAt ?? t.createdAt ?? 0) * (String(t.updatedAt ?? "").length > 11 ? 1 : 1000), agent: "codex" as const,
    }));
  } finally {
    rpc.kill();
  }
}
