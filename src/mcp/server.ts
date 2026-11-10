// MCP stdio server started by Claude Code / Codex. Runs under Electron's own binary with
// ELECTRON_RUN_AS_NODE=1, so no separate Node install is needed. All tool work happens in the
// running app; this process only forwards over SLASHPCB_IPC (Unix socket or named pipe).
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Defaults match src/main/mcpHub.ts, so a .mcp.json written for VS Code needs neither the token
// nor the socket path (both stay out of project files).
function defaultUserData(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "SlashPCB");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "SlashPCB");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "SlashPCB");
}
function defaultAddress(): string {
  const user = (process.env.USER || process.env.USERNAME || "user").replace(/[^a-zA-Z0-9_-]/g, "");
  return process.platform === "win32" ? `\\\\.\\pipe\\slashpcb-${user}` : join(process.env.XDG_RUNTIME_DIR || tmpdir(), `slashpcb-${user}.sock`);
}
function readToken(): string | undefined {
  try { return readFileSync(join(defaultUserData(), "mcp-token"), "utf8").trim(); } catch { return undefined; }
}
const address = process.env.SLASHPCB_IPC || defaultAddress();
const token = process.env.SLASHPCB_TOKEN || readToken();
const PROTOCOL = "2025-06-18";

let sock: Socket | null = null;
let hubBuf = "";
let nextHubId = 1;
const hubPending = new Map<number, (v: any) => void>();

function out(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function hub(op: string, body: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = sock;
    if (!s) return reject(new Error("SlashPCB is not running (no connection to the app)."));
    const id = nextHubId++;
    hubPending.set(id, resolve);
    s.write(JSON.stringify({ id, op, ...body }) + "\n");
  });
}

async function connectHub(): Promise<void> {
  if (!address || !token) throw new Error("SLASHPCB_IPC/SLASHPCB_TOKEN missing");
  await new Promise<void>((resolve, reject) => {
    const s = connect(address);
    s.setEncoding("utf8");
    let authed = false;
    s.on("connect", () => s.write(JSON.stringify({ token }) + "\n"));
    s.on("data", (chunk: string) => {
      hubBuf += chunk;
      let i: number;
      while ((i = hubBuf.indexOf("\n")) >= 0) {
        const line = hubBuf.slice(0, i);
        hubBuf = hubBuf.slice(i + 1);
        const m = JSON.parse(line);
        if (!authed) { authed = !!m.ok; sock = s; resolve(); continue; }
        hubPending.get(m.id)?.(m);
        hubPending.delete(m.id);
      }
    });
    s.on("error", (e) => { sock = null; reject(e); });
    s.on("close", () => { sock = null; });
  });
}

const ready = connectHub().catch((e) => process.stderr.write(`slashpcb: ${e.message}\n`));

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize":
        out({ jsonrpc: "2.0", id, result: {
          protocolVersion: params?.protocolVersion || PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "slashpcb", version: "0.1.0" },
          instructions: "KiCad design tools for the project open in SlashPCB: get_design, list_components, get_component, list_nets, get_net, run_checks, render_view, highlight, list_annotations, resolve_annotation.",
        } });
        return;
      case "ping":
        out({ jsonrpc: "2.0", id, result: {} });
        return;
      case "tools/list": {
        await ready;
        const r = await hub("list");
        out({ jsonrpc: "2.0", id, result: { tools: r.tools } });
        return;
      }
      case "tools/call": {
        await ready;
        const r = await hub("call", { name: params?.name, args: params?.arguments ?? {} });
        out({ jsonrpc: "2.0", id, result: r.result });
        return;
      }
      default:
        if (isRequest) out({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e: any) {
    if (isRequest) {
      if (method === "tools/call") out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true } });
      else out({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
    }
  }
}

let inBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  inBuf += chunk;
  let i: number;
  while ((i = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); } catch { /* ignore */ }
  }
});
process.stdin.on("end", () => process.exit(0));
