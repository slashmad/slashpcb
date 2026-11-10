// Locate the user's own Claude Code / Codex (ChatGPT) binaries on Linux, Windows and macOS.
// Never bundled, never modified. Covers VS Code-family extensions, native installers, npm global
// installs (including Windows .cmd shims, which Node cannot spawn directly), WinGet, Scoop and
// Homebrew.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const exe = (n: string) => (isWin ? `${n}.exe` : n);
const home = homedir();
const env = (k: string) => process.env[k] ?? "";

export interface SpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function onPath(name: string): string[] {
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const n of isWin ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name]) {
      const p = join(dir, n);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function extensionDirs(): string[] {
  return [".vscode", ".vscode-insiders", ".vscode-oss", ".cursor", ".windsurf", ".vscode-server"]
    .map((d) => join(home, d, "extensions"))
    .filter(existsSync);
}

function byVersionDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true });
}

/** The extension's bin/<platform> folder for this OS and CPU (names differ between releases). */
function platformBinDir(binRoot: string): string | null {
  let dirs: string[] = [];
  try { dirs = readdirSync(binRoot); } catch { return null; }
  const os = isWin ? ["windows", "win32", "win"] : isMac ? ["macos", "darwin", "mac"] : ["linux"];
  const arch = process.arch === "arm64" ? ["aarch64", "arm64"] : ["x86_64", "x64", "amd64"];
  return dirs.find((d) => os.some((o) => d.toLowerCase().includes(o)) && arch.some((a) => d.toLowerCase().includes(a)))
    ?? dirs.find((d) => os.some((o) => d.toLowerCase().includes(o))) ?? null;
}

function npmGlobalDirs(): string[] {
  const dirs = [
    isWin ? join(env("APPDATA"), "npm") : "",
    join(home, ".npm-global", "bin"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    isMac ? "/opt/homebrew/bin" : "",
    "/usr/local/bin",
  ];
  return dirs.filter((d) => d && existsSync(d));
}

export function claudeCandidates(): string[] {
  const out: string[] = [];
  for (const ext of extensionDirs()) {
    for (const d of readdirSync(ext).filter((d) => d.startsWith("anthropic.claude-code-")).sort(byVersionDesc)) {
      const p = join(ext, d, "resources", "native-binary", exe("claude"));
      if (existsSync(p)) out.push(p);
    }
  }
  out.push(
    join(home, ".local", "bin", exe("claude")), // native installer (all platforms)
    join(home, ".claude", "local", exe("claude")), // older "local" installs
    ...(isWin ? [join(env("LOCALAPPDATA"), "Programs", "claude", "claude.exe"), join(env("LOCALAPPDATA"), "Microsoft", "WinGet", "Links", "claude.exe")] : []),
    ...(isMac ? ["/opt/homebrew/bin/claude"] : []),
  );
  out.push(...onPath("claude"));
  for (const d of npmGlobalDirs()) out.push(join(d, isWin ? "claude.cmd" : "claude"));
  return [...new Set(out.filter(existsSync))];
}

export function codexCandidates(): string[] {
  const out: string[] = [];
  for (const ext of extensionDirs()) {
    for (const d of readdirSync(ext).filter((d) => d.startsWith("openai.chatgpt-")).sort(byVersionDesc)) {
      const binRoot = join(ext, d, "bin");
      const plat = platformBinDir(binRoot);
      if (plat) {
        const p = join(binRoot, plat, exe("codex"));
        if (existsSync(p)) out.push(p);
      }
    }
  }
  out.push(
    join(home, ".local", "bin", exe("codex")),
    join(home, ".codex", "bin", exe("codex")),
    ...(isWin ? [join(env("LOCALAPPDATA"), "Programs", "OpenAI", "Codex", "codex.exe"), join(env("LOCALAPPDATA"), "Microsoft", "WinGet", "Links", "codex.exe"), join(home, "scoop", "shims", "codex.exe")] : []),
    ...(isMac ? ["/opt/homebrew/bin/codex", "/Applications/Codex.app/Contents/Resources/codex"] : []),
  );
  out.push(...onPath("codex"));
  for (const d of npmGlobalDirs()) out.push(join(d, isWin ? "codex.cmd" : "codex"));
  return [...new Set(out.filter(existsSync))];
}

/**
 * How to start a binary. Windows .cmd/.bat npm shims cannot be spawned without a shell (and
 * shell quoting would mangle our JSON arguments), so resolve them to the real program: a native
 * exe inside the package, or a JS entry run with Electron's own Node (ELECTRON_RUN_AS_NODE).
 */
export function spawnSpec(bin: string, args: string[]): SpawnSpec {
  if (!/\.(cmd|bat)$/i.test(bin)) return { command: bin, args, env: {} };
  let text = "";
  try { text = readFileSync(bin, "utf8"); } catch { /* fall through */ }
  const m = text.match(/"%(?:~?dp0%?|dp0%)\\?([^"]+?\.(?:js|cjs|mjs|exe))"/i) ?? text.match(/%~?dp0%?\\([^\s"]+?\.(?:js|cjs|mjs|exe))/i);
  if (m) {
    const target = resolve(dirname(bin), m[1].replace(/\\/g, "/"));
    if (target.toLowerCase().endsWith(".exe") && existsSync(target)) return { command: target, args, env: {} };
    if (existsSync(target)) {
      const native = findNativeInPackage(target);
      if (native) return { command: native, args, env: {} };
      return { command: process.execPath, args: [target, ...args], env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
  }
  // Last resort: cmd.exe. Arguments containing quotes may not survive; prefer the paths above.
  return { command: env("ComSpec") || "cmd.exe", args: ["/d", "/s", "/c", bin, ...args], env: {} };
}

/** npm packages of Codex ship platform executables under vendor/; Claude may ship bin/claude.exe. */
function findNativeInPackage(entry: string): string | null {
  let dir = dirname(entry);
  for (let i = 0; i < 4 && dir !== dirname(dir); i++, dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) break;
  }
  const want = /codex/i.test(dir) ? "codex.exe" : "claude.exe";
  const stack = [join(dir, "vendor"), join(dir, "bin")];
  let budget = 400;
  while (stack.length && budget-- > 0) {
    const d = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          if (process.arch === "arm64" ? !/x86_64|x64/i.test(e) : !/aarch64|arm64/i.test(e)) stack.push(p);
        } else if (e.toLowerCase() === want) return p;
      } catch { /* skip */ }
    }
  }
  return null;
}

export function versionOf(bin: string): string {
  try {
    const s = spawnSpec(bin, ["--version"]);
    return execFileSync(s.command, s.args, { timeout: 15000, encoding: "utf8", windowsHide: true, env: { ...process.env, ...s.env } }).trim().split("\n")[0];
  } catch {
    return "";
  }
}

function semverKey(v: string): string {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1].padStart(5, "0")}.${m[2].padStart(5, "0")}.${m[3].padStart(6, "0")}` : "0";
}

/** Pick the explicitly configured binary, else the highest version found. */
export function pickBinary(kind: "claude" | "codex", configured?: string): { path: string; version: string } | null {
  if (configured && existsSync(configured)) return { path: configured, version: versionOf(configured) };
  const cands = kind === "claude" ? claudeCandidates() : codexCandidates();
  let best: { path: string; version: string } | null = null;
  for (const p of cands) {
    const v = versionOf(p);
    if (!v) continue;
    if (!best || semverKey(v) > semverKey(best.version)) best = { path: p, version: v };
  }
  return best;
}

/** Environment for agent CLIs: never let an API key switch them from subscription to API billing. */
export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e = { ...process.env, ...extra };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete e[k];
  if (!extra.ELECTRON_RUN_AS_NODE) delete e.ELECTRON_RUN_AS_NODE;
  return e;
}
