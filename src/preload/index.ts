import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";

const on = (channel: string) => (cb: (...args: any[]) => void) => {
  const h = (_e: IpcRendererEvent, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

const api = {
  info: () => ipcRenderer.invoke("app:info"),
  setSettings: (patch: unknown) => ipcRenderer.invoke("settings:set", patch),
  kicad: {
    info: (refresh?: boolean) => ipcRenderer.invoke("kicad:info", refresh),
    open: (rel?: string) => ipcRenderer.invoke("kicad:open", rel),
  },
  project: {
    openDialog: () => ipcRenderer.invoke("project:openDialog"),
    openFileDialog: () => ipcRenderer.invoke("project:openFileDialog"),
    /** Absolute path of a dropped File (Electron removed File.path). */
    pathForFile: (f: File) => webUtils.getPathForFile(f),
    open: (path: string) => ipcRenderer.invoke("project:open", path),
    switchTo: (pro: string) => ipcRenderer.invoke("project:switch", pro),
    readText: (rel: string) => ipcRenderer.invoke("project:readText", rel),
    diffs: () => ipcRenderer.invoke("project:diffs"),
    reveal: (rel: string) => ipcRenderer.invoke("project:reveal", rel),
    setFrozen: (v: boolean | null) => ipcRenderer.invoke("project:setFrozen", v),
    installMcp: () => ipcRenderer.invoke("project:installMcp"),
    onOpened: on("project:opened"),
    onChanged: on("project:changed"),
    onInfo: on("project:info"),
  },
  design: {
    run: () => ipcRenderer.invoke("design:run"),
    want3d: (force?: boolean) => ipcRenderer.invoke("design:want3d", force),
    file: (path: string): Promise<Uint8Array> => ipcRenderer.invoke("design:file", path),
    onUpdate: on("design:update"),
    onState: on("design:state"),
  },
  live: {
    status: () => ipcRenderer.invoke("live:status"),
    enable: (on: boolean) => ipcRenderer.invoke("live:enable", on),
    setup: () => ipcRenderer.invoke("live:setup"),
    select: (refs: string[]) => ipcRenderer.invoke("live:select", refs),
    onStatus: on("live:status"),
    onSelection: on("live:selection"),
    onLog: on("live:log"),
  },
  agent: {
    start: (kind: string, resumeId?: string) => ipcRenderer.invoke("agent:start", kind, resumeId),
    send: (text: string) => ipcRenderer.invoke("agent:send", text),
    interrupt: () => ipcRenderer.invoke("agent:interrupt"),
    stop: () => ipcRenderer.invoke("agent:stop"),
    permission: (id: string, decision: string) => ipcRenderer.invoke("agent:permission", id, decision),
    sessions: (kind: string) => ipcRenderer.invoke("agent:sessions", kind),
    auth: (kind: string) => ipcRenderer.invoke("agent:auth", kind),
    login: (kind: string) => ipcRenderer.invoke("agent:login", kind),
    loginInput: (text: string) => ipcRenderer.invoke("agent:loginInput", text),
    onLoginOutput: on("agent:login-output"),
    onAuthChanged: on("agent:auth-changed"),
    onEvent: on("agent:event"),
    onMcpActivity: on("mcp:activity"),
  },
  annotations: {
    list: () => ipcRenderer.invoke("annotations:list"),
    add: (a: unknown) => ipcRenderer.invoke("annotations:add", a),
    update: (id: string, patch: unknown) => ipcRenderer.invoke("annotations:update", id, patch),
    remove: (id: string) => ipcRenderer.invoke("annotations:remove", id),
    clearDone: () => ipcRenderer.invoke("annotations:clearDone"),
    onChanged: on("annotations:changed"),
  },
  viewer: {
    onSnapshot: on("viewer:snapshot"),
    snapshotDone: (reqId: string, dataUrl: string | null, error?: string) => ipcRenderer.send("viewer:snapshot-done", reqId, dataUrl, error),
    onHighlight: on("viewer:highlight"),
  },
};

contextBridge.exposeInMainWorld("slashpcb", api);
export type SlashPcbApi = typeof api;
