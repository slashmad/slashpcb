// Electron main process: window, display backend, KiCad project, agents, MCP hub, IPC.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { AgentEvent, AgentKind, DesignSnapshot, HighlightRequest, PermissionDecision, SnapshotRequest } from "../shared/types";
import { AgentSession } from "./agents/base";
import { claudeAuthStatus, claudeLogin, codexAuthStatus, codexLogin, writeLoginInput } from "./agents/auth";
import { pickBinary } from "./agents/binaries";
import { ClaudeSession, listClaudeSessions, loadClaudeHistory } from "./agents/claude";
import { CodexSession, listCodexSessions } from "./agents/codex";
import { Annotations } from "./annotations";
import { integrateDesktop } from "./desktopIntegration";
import { detectKicad, openInKicad } from "./kicad/cli";
import { McpHub } from "./mcpHub";
import { KicadProject, resolveProject } from "./project";
import { getSettings, rememberProject, setSettings } from "./settings";
import { registerTools } from "./tools";

// ---------------------------------------------------------------- data folder
// The portable exe (electron-builder "portable") sets PORTABLE_EXECUTABLE_DIR: keep settings,
// the MCP token and project state next to the exe instead of in %APPDATA%.
if (process.env.PORTABLE_EXECUTABLE_DIR) app.setPath("userData", join(process.env.PORTABLE_EXECUTABLE_DIR, "SlashPCB-data"));
// Test/second-profile hook: own single-instance lock, settings and MCP socket.
if (process.env.SLASHPCB_USER_DATA) app.setPath("userData", process.env.SLASHPCB_USER_DATA);

// ---------------------------------------------------------------- display backend (Linux)
// Wayland first, X11/XWayland as fallback (same policy as SlashCAD).
const ozone = app.commandLine.getSwitchValue("ozone-platform");
const ozoneHint = app.commandLine.getSwitchValue("ozone-platform-hint");
const effectiveOzone = ozone || (ozoneHint === "auto" && process.env.WAYLAND_DISPLAY ? "wayland" : ozoneHint === "wayland" ? "wayland" : "x11");

function relaunchWith(platform: string): void {
  process.env.SLASHPCB_RELAUNCHED = "1";
  const args = [...process.argv.slice(1).filter((a) => !a.startsWith("--ozone-platform")), `--ozone-platform=${platform}`];
  app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args } : { args });
  app.exit(0);
}

if (process.platform === "linux" && !process.env.SLASHPCB_RELAUNCHED) {
  const pref = getSettings().displayBackend;
  const want = pref === "auto" ? (process.env.WAYLAND_DISPLAY ? "wayland" : "x11") : pref;
  if (effectiveOzone !== want) relaunchWith(want);
}
const displayBackend = process.platform === "linux" ? effectiveOzone : process.platform;
let gpuCrashes = 0;
app.on("child-process-gone", (_e, d) => {
  if (d.type !== "GPU" || d.reason === "clean-exit") return;
  gpuCrashes++;
  if (process.platform === "linux" && displayBackend === "wayland" && gpuCrashes >= 2) {
    setSettings({ displayBackend: "x11" });
    relaunchWith("x11");
  }
});

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);

// ---------------------------------------------------------------- state
let win: BrowserWindow | null = null;
let project: KicadProject | null = null;
let annotations: Annotations | null = null;
const hub = new McpHub(app.getPath("userData"), process.env.SLASHPCB_USER_DATA ? "test" : "");
let agent: AgentSession | null = null;
const snapshotWaiters = new Map<string, { resolve: (u: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

const send = (channel: string, ...args: unknown[]) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); };

function mcpScript(): string {
  const p = join(app.getAppPath(), "dist", "mcp", "server.js");
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

function mcpLaunch() {
  return { command: process.execPath, args: [mcpScript()], env: { ELECTRON_RUN_AS_NODE: "1", SLASHPCB_IPC: hub.address, SLASHPCB_TOKEN: hub.token } };
}

function applyPipelineSettings(p: KicadProject): void {
  const s = getSettings();
  p.opts = { checks: s.autoChecks, glb: s.auto3d, timeoutSec: s.checkTimeoutSec };
}

// ---------------------------------------------------------------- project
/** Open a KiCad project from a folder, .kicad_pro, .kicad_sch or .kicad_pcb (optionally a given .kicad_pro in that folder). */
async function openPath(path: string, proName?: string): Promise<boolean> {
  const r = resolveProject(path);
  if (!r) {
    if (win) await dialog.showMessageBox(win, { type: "warning", message: "No KiCad project found", detail: `Open a folder with a .kicad_pro, or a .kicad_pro/.kicad_sch/.kicad_pcb file.\n${path}` });
    return false;
  }
  project?.dispose();
  stopAgent();
  const p = new KicadProject(r.dir, proName ?? r.pro, app.getPath("userData"));
  project = p;
  applyPipelineSettings(p);
  annotations?.removeAllListeners();
  annotations = new Annotations(p.stateDir);
  annotations.on("changed", (list) => send("annotations:changed", list));
  rememberProject(join(r.dir, proName ?? r.pro));
  p.on("changed", ({ files, diffs }) => send("project:changed", { files, diffs, tree: p.tree() }));
  p.on("info", (info) => send("project:info", info));
  p.on("design", (d: DesignSnapshot, stage: string) => send("design:update", d, stage));
  p.on("state", (s) => send("design:state", s));
  p.startWatching();
  send("project:opened", { info: p.info, tree: p.tree() });
  send("annotations:changed", annotations.list());
  p.request("opened").catch((e) => console.error("pipeline", e));
  return true;
}

function projectContext(p: KicadProject): string {
  const i = p.info;
  const notes: string[] = [];
  if (i.frozen) notes.push(`This project is FROZEN (${i.frozenReason}). Do not edit any of its files; propose a new derivative folder instead.`);
  if (i.otherProjects.length) notes.push(`The folder also contains other KiCad projects (${i.otherProjects.join(", ")}); the open one is ${i.pro}.`);
  return notes.length ? `\n\nProject notes:\n- ${notes.join("\n- ")}` : "";
}

// ---------------------------------------------------------------- agents
function stopAgent(): void {
  agent?.removeAllListeners();
  agent?.stop();
  agent = null;
}

async function startAgent(kind: AgentKind, resumeId?: string): Promise<{ ok: boolean; error?: string; binary?: string; version?: string }> {
  if (!project) return { ok: false, error: "Open a KiCad project first." };
  stopAgent();
  const s = getSettings();
  const bin = pickBinary(kind, kind === "claude" ? s.claudePath : s.codexPath);
  if (!bin) {
    return { ok: false, error: kind === "claude"
      ? "Claude Code was not found. Install the Claude Code VS Code extension or CLI, or set its path in Settings > Agents."
      : "Codex was not found. Install the ChatGPT/Codex VS Code extension or the codex CLI, or set its path in Settings > Agents." };
  }
  setSettings({ lastAgent: kind });
  const a: AgentSession = kind === "claude" ? new ClaudeSession() : new CodexSession();
  agent = a;
  a.on("event", (ev: AgentEvent) => { if (agent === a) send("agent:event", kind, ev); });
  send("agent:event", kind, { type: "history-reset" } satisfies AgentEvent);
  if (resumeId && kind === "claude") for (const ev of loadClaudeHistory(project.dir, resumeId)) send("agent:event", kind, ev);
  try {
    await a.start({ cwd: project.dir, resumeId, mcp: mcpLaunch(), binary: bin.path, model: kind === "claude" ? s.claudeModel : s.codexModel, extraInstructions: projectContext(project) || undefined });
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  return { ok: true, binary: bin.path, version: bin.version };
}

// ---------------------------------------------------------------- window
function createWindow(): void {
  win = new BrowserWindow({
    width: 1680, height: 1020, minWidth: 1000, minHeight: 640, backgroundColor: "#15171c", show: false,
    title: "SlashPCB",
    icon: join(__dirname, "..", "renderer", "icon-256.png"),
    webPreferences: {
      preload: join(__dirname, "..", "preload", "index.js"), contextIsolation: true, sandbox: true, backgroundThrottling: false,
      spellcheck: false, // Chromium would download dictionaries; the app makes no network requests of its own
    },
  });
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(join(app.getAppPath(), "dist", "renderer", "index.html"));
  win.on("closed", () => { win = null; });
  if (process.env.SLASHPCB_DEBUG) {
    win.webContents.on("console-message", (e: any) => console.log(`[renderer ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`));
  }
}

/** Files the renderer may read: only inside the open project's state/out folder. */
function readOutput(path: string): Buffer {
  if (!project) throw new Error("no project");
  const abs = resolve(path);
  if (relative(project.outDir, abs).startsWith("..")) throw new Error("invalid path");
  return readFileSync(abs);
}

// ---------------------------------------------------------------- IPC
function registerIpc(): void {
  ipcMain.handle("app:info", async () => ({
    displayBackend, platform: process.platform, version: app.getVersion(), settings: getSettings(),
    project: project ? { info: project.info, tree: project.tree(), design: project.design, state: project.state } : null,
    claude: pickBinary("claude", getSettings().claudePath), codex: pickBinary("codex", getSettings().codexPath),
    kicad: await detectKicad(getSettings().kicadCliPath),
  }));
  ipcMain.handle("settings:set", async (_e, patch) => {
    const r = setSettings(patch);
    if ("kicadCliPath" in patch) await detectKicad(r.kicadCliPath, true);
    if (project) applyPipelineSettings(project);
    return r;
  });
  ipcMain.handle("kicad:info", (_e, refresh?: boolean) => detectKicad(getSettings().kicadCliPath, !!refresh));
  ipcMain.handle("kicad:open", (_e, rel?: string) => {
    if (!project) return false;
    return openInKicad(project.abs(rel ?? project.pro));
  });

  ipcMain.handle("project:openDialog", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "Open KiCad project folder" });
    if (r.canceled || !r.filePaths[0]) return false;
    return openPath(r.filePaths[0]);
  });
  ipcMain.handle("project:openFileDialog", async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openFile"], title: "Open KiCad project",
      filters: [{ name: "KiCad", extensions: ["kicad_pro", "kicad_sch", "kicad_pcb"] }, { name: "All files", extensions: ["*"] }],
    });
    if (r.canceled || !r.filePaths[0]) return false;
    return openPath(r.filePaths[0]);
  });
  ipcMain.handle("project:open", (_e, path: string) => (existsSync(path) ? openPath(path) : false));
  ipcMain.handle("project:switch", (_e, pro: string) => (project ? openPath(project.dir, pro) : false));
  ipcMain.handle("project:readText", (_e, rel: string) => project?.readText(rel) ?? "");
  ipcMain.handle("project:diffs", () => project?.recentDiffs() ?? []);
  ipcMain.handle("project:reveal", (_e, rel: string) => project && shell.showItemInFolder(project.abs(rel)));
  ipcMain.handle("project:setFrozen", (_e, v: boolean | null) => { project?.setFrozen(v ?? undefined); return project?.info ?? null; });
  ipcMain.handle("project:installMcp", () => {
    // Writes .mcp.json so Claude Code inside VS Code can use the tools while this app runs.
    if (!project || project.info.frozen) return false;
    const cfg = { mcpServers: { slashpcb: { type: "stdio", command: process.execPath, args: [mcpScript()], env: { ELECTRON_RUN_AS_NODE: "1" } } } };
    writeFileSync(join(project.dir, ".mcp.json"), JSON.stringify(cfg, null, 2));
    return true;
  });

  ipcMain.handle("design:run", () => project?.request("manual") ?? null);
  ipcMain.handle("design:want3d", (_e, force?: boolean) => (project ? (force ? project.request("3d", { checks: false, glb: true }) : project.request3d()) : null));
  ipcMain.handle("design:file", (_e, path: string) => readOutput(path));

  ipcMain.handle("annotations:list", () => annotations?.list() ?? []);
  ipcMain.handle("annotations:add", (_e, a) => annotations?.add(a) ?? null);
  ipcMain.handle("annotations:update", (_e, id: string, patch) => annotations?.update(id, patch) ?? null);
  ipcMain.handle("annotations:remove", (_e, id: string) => annotations?.remove(id));
  ipcMain.handle("annotations:clearDone", () => annotations?.clearDone());

  ipcMain.handle("agent:start", (_e, kind: AgentKind, resumeId?: string) => startAgent(kind, resumeId));
  ipcMain.handle("agent:send", async (_e, text: string) => {
    if (!agent) {
      const r = await startAgent(getSettings().lastAgent);
      if (!r.ok) throw new Error(r.error);
    }
    send("agent:event", agent!.kind, { type: "user", id: `u${Date.now()}`, text, ts: Date.now() } satisfies AgentEvent);
    await agent!.send(text);
    return true;
  });
  ipcMain.handle("agent:interrupt", () => agent?.interrupt());
  ipcMain.handle("agent:stop", () => { stopAgent(); return true; });
  ipcMain.handle("agent:permission", (_e, requestId: string, decision: PermissionDecision) => agent?.answerPermission(requestId, decision));
  ipcMain.handle("agent:auth", async (_e, kind: AgentKind) => {
    const s = getSettings();
    const bin = pickBinary(kind, kind === "claude" ? s.claudePath : s.codexPath);
    if (!bin) return { loggedIn: false, error: "not installed" };
    return kind === "claude" ? claudeAuthStatus(bin.path) : codexAuthStatus(bin.path, project?.dir ?? app.getPath("home"));
  });
  ipcMain.handle("agent:login", async (_e, kind: AgentKind) => {
    const s = getSettings();
    const bin = pickBinary(kind, kind === "claude" ? s.claudePath : s.codexPath);
    if (!bin) return { loggedIn: false, error: "not installed" };
    const line = (l: string) => send("agent:login-output", kind, l);
    const r = kind === "claude" ? await claudeLogin(bin.path, line) : await codexLogin(bin.path, project?.dir ?? app.getPath("home"), line);
    send("agent:auth-changed", kind, r);
    return r;
  });
  ipcMain.handle("agent:loginInput", (_e, text: string) => writeLoginInput(text));
  ipcMain.handle("agent:sessions", async (_e, kind: AgentKind) => {
    if (!project) return [];
    if (kind === "claude") return listClaudeSessions(project.dir);
    const bin = pickBinary("codex", getSettings().codexPath);
    return bin ? listCodexSessions(bin.path, project.dir).catch(() => []) : [];
  });

  ipcMain.on("viewer:snapshot-done", (_e, reqId: string, dataUrl: string | null, error?: string) => {
    const w = snapshotWaiters.get(reqId);
    if (!w) return;
    snapshotWaiters.delete(reqId);
    clearTimeout(w.timer);
    if (dataUrl) w.resolve(dataUrl);
    else w.reject(new Error(error || "no image"));
  });
}

function snapshot(req: Omit<SnapshotRequest, "reqId">): Promise<string> {
  if (!win) return Promise.reject(new Error("the window is closed"));
  const reqId = `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { snapshotWaiters.delete(reqId); reject(new Error("the view did not answer")); }, 30000);
    snapshotWaiters.set(reqId, { resolve, reject, timer });
    send("viewer:snapshot", { ...req, reqId });
  });
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(async () => {
  const desktopReady = integrateDesktop(join(__dirname, "..", "renderer"));
  registerIpc();
  registerTools(hub, {
    project: () => project, annotations: () => annotations, snapshot,
    highlight: (h: HighlightRequest) => send("viewer:highlight", h),
  });
  try { await hub.start(); } catch (e) { console.error("MCP hub:", e); }
  hub.on("activity", (a) => send("mcp:activity", a));
  void detectKicad(getSettings().kicadCliPath);

  // Test hook: SLASHPCB_SCREENSHOT=<png> captures the window after the first full pipeline run,
  // plus an offscreen board and schematic snapshot (SLASHPCB_TAB=board|schematic|3d picks the tab).
  const shot = process.env.SLASHPCB_SCREENSHOT;
  const onFirstDone = (fn: () => void) => {
    const check = setInterval(() => { if (project && project.state.n > 0 && !project.state.running) { clearInterval(check); fn(); } }, 300);
  };
  if (shot) {
    onFirstDone(() => setTimeout(async () => {
      try {
        if (process.env.SLASHPCB_TAB) await win!.webContents.executeJavaScript(`window.__setTab && window.__setTab(${JSON.stringify(process.env.SLASHPCB_TAB)})`);
        await new Promise((r) => setTimeout(r, Number(process.env.SLASHPCB_TAB_DELAY_MS ?? 2500)));
        writeFileSync(shot, (await win!.webContents.capturePage()).toPNG());
        console.log(`screenshot written: ${shot}`);
        for (const view of ["board", "schematic"] as const) {
          try {
            const url = await snapshot({ view, width: 1000, height: 700 });
            writeFileSync(shot.replace(/\.png$/, `-${view}.png`), Buffer.from(url.split(",")[1], "base64"));
          } catch (e) { console.error(`snapshot ${view} failed`, e); }
        }
        if (process.env.SLASHPCB_TEST_TOOLS) {
          for (const name of process.env.SLASHPCB_TEST_TOOLS.split(",")) {
            const [tool, argJson] = name.split(":");
            const r = await hub.call(tool, argJson ? JSON.parse(Buffer.from(argJson, "base64").toString()) : {});
            const t = r.content.map((c) => (c.type === "text" ? c.text : `[image ${c.data.length} b64 chars]`)).join("\n");
            console.log(`[tool ${tool}]\n${t.slice(0, 3000)}`);
          }
        }
      } catch (e) { console.error("screenshot failed", e); }
      if (process.env.SLASHPCB_EXIT_AFTER_SCREENSHOT) app.quit();
    }, Number(process.env.SLASHPCB_SCREENSHOT_DELAY_MS ?? 1500)));
  }

  // Test hook: SLASHPCB_E2E_PROMPT runs one real agent turn after the first pipeline run
  // (auto-approves permission prompts ONLY in this mode), screenshots, then quits.
  const e2e = process.env.SLASHPCB_E2E_PROMPT;
  if (e2e) {
    onFirstDone(async () => {
      const kind = (process.env.SLASHPCB_E2E_AGENT as AgentKind) || "claude";
      if (process.env.SLASHPCB_E2E_MODEL) setSettings(kind === "claude" ? { claudeModel: process.env.SLASHPCB_E2E_MODEL } : { codexModel: process.env.SLASHPCB_E2E_MODEL });
      const r = await startAgent(kind);
      console.log("[e2e] start", JSON.stringify(r));
      if (!r.ok) return app.quit();
      agent!.on("event", async (ev: AgentEvent) => {
        if (ev.type === "text-delta" || ev.type === "thinking") return;
        console.log("[e2e]", JSON.stringify(ev).slice(0, 600));
        if (ev.type === "permission") agent!.answerPermission(ev.requestId, "allow");
        if (ev.type === "turn-complete") {
          await new Promise((res) => setTimeout(res, 2500));
          const out = process.env.SLASHPCB_SCREENSHOT || join(app.getPath("temp"), "slashpcb-e2e.png");
          try { writeFileSync(out, (await win!.webContents.capturePage()).toPNG()); console.log("[e2e] screenshot", out); } catch (e) { console.error("[e2e] screenshot failed", e); }
          app.quit();
        }
      });
      await agent!.send(e2e);
    });
  }

  await desktopReady;
  createWindow();
  win!.webContents.once("did-finish-load", () => {
    const s = getSettings();
    const arg = process.argv.slice(1).find((a) => !a.startsWith("-") && a !== "." && existsSync(a) && !a.endsWith(".js"));
    const initial = process.env.SLASHPCB_PROJECT || arg || s.recentProjects.find((d) => existsSync(d));
    if (initial) void openPath(initial);
  });
}).catch((e) => {
  dialog.showErrorBox("SlashPCB could not start", String(e?.stack ?? e));
  app.exit(1);
});

app.on("second-instance", (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const path = argv.slice(1).find((a) => !a.startsWith("-") && a !== "." && !a.endsWith(".js") && existsSync(a));
  if (path) void openPath(path);
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { if (!primaryInstance) return; stopAgent(); hub.stop(); project?.dispose(); });
