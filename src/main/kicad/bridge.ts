// Live link to a running KiCad through its IPC API (python/kicad_bridge.py with kicad-python).
//
// Python: settings.bridgePython, else <repo>/.venv (source runs), else <userData>/bridge-venv
// created on request by setupBridge() (python3.13/3.12/3.11 + pip install kicad-python: the one
// network step, started only by the user). Nothing runs until the user enables the live link.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { kicadEnv } from "./cli";

export interface BridgeStatus { enabled: boolean; running: boolean; connected: boolean; version?: string | null; boards?: string[]; error?: string; python?: string | null }

function venvPython(dir: string): string {
  return process.platform === "win32" ? join(dir, "Scripts", "python.exe") : join(dir, "bin", "python");
}

export class KicadBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  status: BridgeStatus = { enabled: false, running: false, connected: false };

  constructor(private script: string, private appDir: string, private userData: string, private custom?: () => string | undefined) { super(); }

  python(): string | null {
    const c = [this.custom?.(), venvPython(join(this.appDir, ".venv")), venvPython(join(this.userData, "bridge-venv"))].filter(Boolean) as string[];
    return c.find((p) => existsSync(p)) ?? null;
  }

  private set(patch: Partial<BridgeStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  start(): BridgeStatus {
    if (this.proc) return this.status;
    const py = this.python();
    if (!py) { this.set({ enabled: true, running: false, connected: false, python: null, error: "no Python with kicad-python: use “Set up live link”" }); return this.status; }
    const p = spawn(py, ["-I", "-u", this.script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: kicadEnv() });
    this.proc = p;
    this.set({ enabled: true, running: true, python: py, error: undefined });
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => this.onData(d));
    let err = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (d: string) => { err = (err + d).slice(-2000); });
    p.on("error", (e) => this.set({ running: false, connected: false, error: e.message }));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      for (const w of this.pending.values()) { clearTimeout(w.timer); w.reject(new Error("the live link stopped")); }
      this.pending.clear();
      this.set({ running: false, connected: false, error: code ? `bridge exited (${code}): ${err.trim().split("\n").pop() ?? ""}` : undefined });
    });
    return this.status;
  }

  stop(): void {
    const p = this.proc;
    this.proc = null;
    p?.kill();
    this.set({ enabled: false, running: false, connected: false });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.event === "status") this.set({ connected: !!m.connected, version: m.version ?? this.status.version, boards: m.boards, error: m.connected ? undefined : m.error });
      else if (m.event) this.emit(m.event, m);
      else if (m.id !== undefined) {
        const w = this.pending.get(m.id);
        if (!w) continue;
        this.pending.delete(m.id);
        clearTimeout(w.timer);
        m.ok ? w.resolve(m.result) : w.reject(new Error(m.error ?? "KiCad call failed"));
      }
    }
  }

  request(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 20000): Promise<any> {
    if (!this.proc) this.start();
    const p = this.proc;
    if (!p) return Promise.reject(new Error(this.status.error ?? "the live link is not running"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`KiCad did not answer (${cmd})`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      p.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
    });
  }
}

/** Creates <userData>/bridge-venv with a Python that has kicad-python wheels and installs it. */
export async function setupBridge(userData: string, log: (l: string) => void): Promise<string> {
  const dir = join(userData, "bridge-venv");
  const candidates = process.platform === "win32"
    ? [["py", ["-3.13"]], ["py", ["-3.12"]], ["py", ["-3.11"]], ["python", []]]
    : [["/usr/bin/python3.13", []], ["python3.13", []], ["python3.12", []], ["python3.11", []], ["python3", []]];
  const run = (cmd: string, args: string[]) => new Promise<number>((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, env: kicadEnv() });
    p.stdout.on("data", (d) => log(String(d).trimEnd()));
    p.stderr.on("data", (d) => log(String(d).trimEnd()));
    p.on("error", () => resolve(-1));
    p.on("exit", (c) => resolve(c ?? -1));
  });
  const works = (cmd: string, args: string[]) => new Promise<boolean>((resolve) =>
    execFile(cmd, [...args, "-c", "import sys; assert sys.version_info >= (3, 10)"], { timeout: 15000, env: kicadEnv() }, (e) => resolve(!e)));
  for (const [cmd, args] of candidates as [string, string[]][]) {
    if (!(await works(cmd, args))) continue;
    log(`Using ${cmd} ${args.join(" ")}`.trim());
    if (await run(cmd, [...args, "-m", "venv", "--clear", dir]) !== 0) continue;
    const py = venvPython(dir);
    log("Installing kicad-python from PyPI…");
    if (await run(py, ["-m", "pip", "install", "--disable-pip-version-check", "kicad-python"]) === 0) return py;
    log("kicad-python could not be installed with this Python; trying the next one.");
  }
  throw new Error("No suitable Python found (3.11–3.13 recommended). Install Python 3.13 and try again.");
}

/** Same file on disk (symlinks resolved; case-insensitive on Windows). Never compares bare file names. */
export function sameFile(a: string, b: string): boolean {
  if (!a || !b || !isAbsolute(a) || !isAbsolute(b)) return false;
  const canon = (p: string) => { let r = resolve(p); try { r = realpathSync(r); } catch { /* missing: compare as given */ } return process.platform === "win32" ? r.toLowerCase() : r; };
  return canon(a) === canon(b);
}
