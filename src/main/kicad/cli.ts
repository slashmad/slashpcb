// Finding and running kicad-cli (the user's own KiCad install; SlashPCB does not bundle KiCad).
//
// Safety: kicad-cli writes "<project>.kicad_prl" next to the project when it is missing (seen with
// KiCad 10.0.8), so it is never run inside the user's folder. Every call runs against a shadow
// folder (see shadow.ts) where only the project/local-settings files are real copies.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { KicadInfo } from "../../shared/types";

let cached: KicadInfo | null = null;

/**
 * Environment for host programs (KiCad, the live-link Python). Inside an AppImage, AppRun puts the
 * bundle's own folders first in PATH, LD_LIBRARY_PATH, XDG_DATA_DIRS and GSETTINGS_SCHEMA_DIR; host
 * programs would then load the bundle's libraries ("Failed to load" from kicad-cli). Remove them.
 */
export function hostEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const appdir = env.APPDIR;
  if (!appdir || process.platform !== "linux") return env;
  for (const k of ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"]) {
    const v = env[k];
    if (v === undefined) continue;
    const kept = v.split(":").filter((d) => d && !d.startsWith(appdir));
    if (kept.length) env[k] = kept.join(":"); else delete env[k];
  }
  // KiCad itself supports running as an AppImage and locates its kiface libraries from APPDIR.
  for (const k of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete env[k];
  return env;
}

/**
 * Environment for KiCad processes. KiCad's embedded Python honours VIRTUAL_ENV/PYTHONPATH/PYTHONHOME:
 * a venv inherited from a terminal or VS Code (without wxPython) makes pcbnew report "No module
 * named 'wx'" and disables its Python plugins. Strip them so KiCad uses its normal interpreter.
 */
export function kicadEnv(): NodeJS.ProcessEnv {
  const env = hostEnv();
  const venv = env.VIRTUAL_ENV;
  for (const k of ["VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE", "CONDA_PREFIX", "ELECTRON_RUN_AS_NODE"]) delete env[k];
  if (venv && env.PATH) env.PATH = env.PATH.split(process.platform === "win32" ? ";" : ":").filter((d) => !d.startsWith(venv)).join(process.platform === "win32" ? ";" : ":");
  return env;
}

interface Cmd { file: string; pre: string[] }
let cmd: Cmd | null = null;

function candidates(custom?: string): Cmd[] {
  const out: Cmd[] = [];
  if (custom) out.push({ file: custom, pre: [] });
  if (process.platform === "win32") {
    const pf = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")].filter(Boolean) as string[];
    for (const base of pf) for (const v of ["10.0", "9.0", "11.0", "8.0"]) out.push({ file: join(base, "KiCad", v, "bin", "kicad-cli.exe"), pre: [] });
    out.push({ file: "kicad-cli.exe", pre: [] });
  } else if (process.platform === "darwin") {
    out.push({ file: "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli", pre: [] });
    out.push({ file: "kicad-cli", pre: [] });
  } else {
    out.push({ file: "/usr/bin/kicad-cli", pre: [] }, { file: "/usr/local/bin/kicad-cli", pre: [] }, { file: "kicad-cli", pre: [] });
    out.push({ file: "flatpak", pre: ["run", "--command=kicad-cli", "org.kicad.KiCad"] });
    out.push({ file: "flatpak", pre: ["run", "--command=kicad-cli", "org.kicad.kicad"] });
  }
  return out;
}

function tryVersion(c: Cmd): Promise<string | null> {
  return new Promise((resolve) => {
    if (c.file.includes("/") || c.file.includes("\\")) { if (!existsSync(c.file)) return resolve(null); }
    execFile(c.file, [...c.pre, "version"], { timeout: 20000, windowsHide: true, env: kicadEnv() }, (err, stdout) => {
      const v = String(stdout ?? "").trim().split("\n").pop()?.trim();
      resolve(err || !v || !/^\d+\.\d+/.test(v) ? null : v);
    });
  });
}

function guiFor(c: Cmd): string | null {
  if (c.file === "flatpak") return "flatpak";
  if (process.platform === "win32") return c.file.replace(/kicad-cli\.exe$/i, "kicad.exe");
  if (process.platform === "darwin") return "/Applications/KiCad/KiCad.app";
  const sib = c.file.replace(/kicad-cli$/, "kicad");
  return sib.includes("/") && existsSync(sib) ? sib : "kicad";
}

export async function detectKicad(custom?: string, refresh = false): Promise<KicadInfo> {
  if (cached && !refresh) return cached;
  for (const c of candidates(custom)) {
    const v = await tryVersion(c);
    if (v) {
      cmd = c;
      cached = { cli: [c.file, ...c.pre].join(" "), version: v, flatpak: c.file === "flatpak", gui: guiFor(c) };
      return cached;
    }
  }
  cmd = null;
  cached = { cli: null, version: null, flatpak: false, gui: null, error: "kicad-cli was not found. Install KiCad 9 or 10, or set the path in Settings." };
  return cached;
}

export function kicadMajor(): number {
  return cached?.version ? parseInt(cached.version, 10) : 0;
}

export interface CliResult { code: number; stdout: string; stderr: string; seconds: number }

/** Run kicad-cli with `args` in `cwd` (always a shadow folder). Rejects only when it cannot start. */
export async function runCli(args: string[], cwd: string, timeoutMs = 300000): Promise<CliResult> {
  if (!cmd) await detectKicad();
  if (!cmd) throw new Error(cached?.error ?? "kicad-cli not found");
  const c = cmd;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    // Flatpak sandboxes only see the user's files when the folder is shared; --filesystem grants it.
    const pre = c.file === "flatpak" ? [c.pre[0], `--filesystem=${cwd}`, ...c.pre.slice(1)] : c.pre;
    const p = spawn(c.file, [...pre, ...args], { cwd, windowsHide: true, env: kicadEnv() });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; if (stdout.length > 2e6) stdout = stdout.slice(-1e6); });
    p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 2e6) stderr = stderr.slice(-1e6); });
    const timer = setTimeout(() => { p.kill(); stderr += `\n(timed out after ${Math.round(timeoutMs / 1000)} s)`; }, timeoutMs);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, seconds: (Date.now() - t0) / 1000 }); });
  });
}

/** Open a file or project in the user's KiCad (detached). */
export function openInKicad(target: string): boolean {
  const info = cached;
  if (!info?.gui) return false;
  try {
    let p;
    if (info.gui === "flatpak") p = spawn("flatpak", ["run", `--filesystem=${target}`, cmd?.pre[cmd.pre.length - 1] ?? "org.kicad.KiCad", target], { detached: true, stdio: "ignore", env: kicadEnv() });
    else if (process.platform === "darwin") p = spawn("open", ["-a", info.gui, target], { detached: true, stdio: "ignore", env: kicadEnv() });
    else p = spawn(info.gui, [target], { detached: true, stdio: "ignore", windowsHide: false, env: kicadEnv() });
    p.on("error", () => {});
    p.unref();
    return true;
  } catch { return false; }
}
