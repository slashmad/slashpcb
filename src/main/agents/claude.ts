// Claude Code adapter: the unmodified, user-installed `claude` binary over stream-json.
// Verified 2026-11-08 with 2.1.319: permission prompts reach the host only with BOTH an
// `initialize` control request AND `--permission-prompt-tool stdio`.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, PermissionDecision, SessionSummary, UsageSnapshot } from "../../shared/types";
import { AgentSession, type AgentStartOptions } from "./base";
import { agentEnv, spawnSpec } from "./binaries";
import { PCB_INSTRUCTIONS } from "./prompt";

export const MCP_NAME = "slashpcb";

function projectSessionsDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
  return "";
}

function summarize(content: unknown, max = 2000): string {
  let s = "";
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) s = content.map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("\n");
  else if (content) s = JSON.stringify(content);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export class ClaudeSession extends AgentSession {
  readonly kind = "claude" as const;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private pendingPerms = new Map<string, any>();
  private usage: UsageSnapshot = { agent: "claude", windows: [] };
  private sessionTotals = { input: 0, output: 0, cached: 0 };
  private turnStart = 0;
  private ctlId = 1;

  async start(o: AgentStartOptions): Promise<void> {
    const servers: Record<string, unknown> = { [MCP_NAME]: { type: "stdio", command: o.mcp.command, args: o.mcp.args, env: o.mcp.env } };
    for (const [name, m] of Object.entries(o.extraMcp ?? {})) servers[name] = { type: "stdio", command: m.command, args: m.args, env: m.env };
    const mcpConfig = { mcpServers: servers };
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool", "stdio",
      "--mcp-config", JSON.stringify(mcpConfig),
      "--allowedTools", `mcp__${MCP_NAME}`, "Read", "Glob", "Grep",
      "--append-system-prompt", PCB_INSTRUCTIONS + (o.extraInstructions ?? ""),
    ];
    if (o.model) args.push("--model", o.model);
    if (o.resumeId) args.push("--resume", o.resumeId);
    this.emitEvent({ type: "status", state: "starting" });
    const spec = spawnSpec(o.binary, args);
    const proc = spawn(spec.command, spec.args, { cwd: o.cwd, env: agentEnv(spec.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c: string) => this.onData(c));
    proc.stderr.setEncoding("utf8");
    let errTail = "";
    proc.stderr.on("data", (d: string) => { errTail = (errTail + d).slice(-4000); });
    proc.on("error", (e) => this.emitEvent({ type: "error", message: `Could not start Claude: ${e.message}` }));
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.busy = false;
      if (code && errTail.trim()) this.emitEvent({ type: "error", message: `Claude exited (${code}): ${errTail.trim().slice(-800)}` });
      this.emitEvent({ type: "status", state: "stopped" });
    });
    this.control({ subtype: "initialize" });
    if (o.resumeId) this.sessionId = o.resumeId;
    this.emitEvent({ type: "status", state: "idle" });
  }

  private write(obj: unknown): void {
    this.proc?.stdin.write(JSON.stringify(obj) + "\n");
  }

  private control(request: Record<string, unknown>): void {
    this.write({ type: "control_request", request_id: `host-${this.ctlId++}`, request });
  }

  async send(text: string): Promise<void> {
    if (!this.proc) throw new Error("the Claude session is not running");
    this.busy = true;
    this.turnStart = Date.now();
    this.emitEvent({ type: "status", state: "busy" });
    this.write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> {
    this.control({ subtype: "interrupt" });
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    const req = this.pendingPerms.get(requestId);
    if (!req) return;
    this.pendingPerms.delete(requestId);
    const response =
      decision === "deny"
        ? { behavior: "deny", message: "The user denied this action in SlashPCB." }
        : {
            behavior: "allow",
            updatedInput: req.input,
            ...(decision === "allow-always" && req.permission_suggestions ? { updatedPermissions: req.permission_suggestions } : {}),
          };
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    this.emitEvent({ type: "permission-resolved", requestId, decision });
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    if (p) { p.stdin.end(); setTimeout(() => p.kill(), 1500); }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      try { this.handle(JSON.parse(line)); } catch (e) { /* ignore malformed line */ }
    }
  }

  private msgId = "";

  private handle(ev: any): void {
    const now = Date.now();
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") {
          this.sessionId = ev.session_id;
          this.emitEvent({ type: "session", sessionId: ev.session_id, model: ev.model });
          const mcp = (ev.mcp_servers ?? []).find((s: any) => s.name === MCP_NAME);
          if (mcp && mcp.status !== "connected") this.emitEvent({ type: "error", message: `the SlashPCB tools (MCP) have status ${mcp.status}` });
        }
        break;
      case "stream_event": {
        const e = ev.event;
        if (ev.parent_tool_use_id) break; // subagent internals
        if (e?.type === "message_start") this.msgId = e.message?.id ?? `m${now}`;
        else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta")
          this.emitEvent({ type: "text-delta", id: `${this.msgId}:${e.index}`, text: e.delta.text });
        else if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta")
          this.emitEvent({ type: "thinking", id: `${this.msgId}:${e.index}`, text: e.delta.thinking });
        break;
      }
      case "assistant": {
        if (ev.parent_tool_use_id) break;
        const m = ev.message;
        (m?.content ?? []).forEach((b: any, idx: number) => {
          if (b.type === "text") this.emitEvent({ type: "text", id: `${m.id}:${idx}`, text: b.text, ts: now });
          else if (b.type === "tool_use") this.emitEvent({ type: "tool", id: b.id, name: b.name, input: b.input, status: "running", ts: now });
        });
        const u = m?.usage;
        if (u) {
          this.usage.contextUsed = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          this.emitEvent({ type: "usage", usage: { ...this.usage } });
        }
        break;
      }
      case "user": {
        if (ev.parent_tool_use_id) break;
        const content = ev.message?.content;
        if (Array.isArray(content))
          for (const b of content)
            if (b.type === "tool_result")
              this.emitEvent({ type: "tool", id: b.tool_use_id, name: "", input: undefined, status: b.is_error ? "error" : "done", output: summarize(b.content), ts: now });
        break;
      }
      case "control_request":
        if (ev.request?.subtype === "can_use_tool") {
          const r = ev.request;
          this.pendingPerms.set(ev.request_id, r);
          this.emitEvent({
            type: "permission", requestId: ev.request_id, tool: r.display_name || r.tool_name, input: r.input,
            description: r.description || r.title, canAlways: Array.isArray(r.permission_suggestions) && r.permission_suggestions.length > 0,
          });
        }
        break;
      case "rate_limit_event": {
        const info = ev.rate_limit_info ?? {};
        const w = info.unifiedWindows ?? {};
        const label: Record<string, string> = { five_hour: "5 h", seven_day: "7 days", seven_day_opus: "7 d Opus", seven_day_sonnet: "7 d Sonnet" };
        this.usage.windows = Object.entries(w).map(([k, v]: [string, any]) => ({
          label: label[k] ?? k, usedPercent: Math.round((v.utilization ?? 0) * 1000) / 10, resetsAt: v.resetsAt, status: v.status,
        }));
        if (!this.usage.windows.length && info.utilization !== undefined)
          this.usage.windows = [{ label: info.rateLimitType ?? "limit", usedPercent: info.utilization * 100, resetsAt: info.resetsAt, status: info.status }];
        this.usage.note = info.status === "rejected" ? "Limit reached" : undefined;
        this.emitEvent({ type: "usage", usage: { ...this.usage } });
        break;
      }
      case "result": {
        this.busy = false;
        const u = ev.usage ?? {};
        const mu: any = Object.values(ev.modelUsage ?? {})[0] ?? {};
        if (mu.contextWindow) this.usage.contextWindow = mu.contextWindow;
        this.sessionTotals.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        this.sessionTotals.output += u.output_tokens ?? 0;
        this.sessionTotals.cached += u.cache_read_input_tokens ?? 0;
        this.usage.sessionTokens = { ...this.sessionTotals };
        this.emitEvent({ type: "usage", usage: { ...this.usage } });
        this.emitEvent({
          type: "turn-complete", durationMs: ev.duration_ms ?? now - this.turnStart,
          usage: {
            inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens,
            cacheWriteTokens: u.cache_creation_input_tokens, reasoningTokens: u.output_tokens_details?.thinking_tokens, costEstimateUsd: ev.total_cost_usd,
          },
          error: ev.subtype !== "success" ? `${ev.subtype}${ev.result ? ": " + ev.result : ""}` : undefined,
        });
        this.emitEvent({ type: "status", state: "idle" });
        break;
      }
    }
  }
}

export async function listClaudeSessions(cwd: string): Promise<SessionSummary[]> {
  const dir = projectSessionsDir(cwd);
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const p = join(dir, f);
    let title = "";
    try {
      const fd = readFileSync(p, "utf8").split("\n").slice(0, 200);
      for (const l of fd) {
        if (!l) continue;
        const j = JSON.parse(l);
        if (j.type === "summary" && j.summary) { title = j.summary; break; }
        if (!title && j.type === "user" && !j.isMeta) {
          const t = textOf(j.message?.content).trim();
          if (t && !t.startsWith("<")) title = t.slice(0, 80);
        }
      }
    } catch { /* skip unreadable */ }
    out.push({ id: f.replace(/\.jsonl$/, ""), title: title || "(untitled session)", updatedAt: statSync(p).mtimeMs, agent: "claude" });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
}

export function loadClaudeHistory(cwd: string, id: string): AgentEvent[] {
  const p = join(projectSessionsDir(cwd), `${id}.jsonl`);
  if (!existsSync(p)) return [];
  const events: AgentEvent[] = [];
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l) continue;
    let j: any;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.isSidechain || j.isMeta) continue;
    const ts = Date.parse(j.timestamp ?? "") || 0;
    if (j.type === "user") {
      const c = j.message?.content;
      if (typeof c === "string") { if (!c.startsWith("<")) events.push({ type: "user", id: j.uuid, text: c, ts }); }
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "text" && !String(b.text).startsWith("<")) events.push({ type: "user", id: j.uuid, text: b.text, ts });
          if (b.type === "tool_result") events.push({ type: "tool", id: b.tool_use_id, name: "", input: undefined, status: b.is_error ? "error" : "done", output: summarize(b.content, 600), ts });
        }
      }
    } else if (j.type === "assistant") {
      (j.message?.content ?? []).forEach((b: any, idx: number) => {
        if (b.type === "text") events.push({ type: "text", id: `${j.message.id}:${idx}`, text: b.text, ts });
        else if (b.type === "tool_use") events.push({ type: "tool", id: b.id, name: b.name, input: b.input, status: "running", ts });
      });
    }
  }
  return events;
}
