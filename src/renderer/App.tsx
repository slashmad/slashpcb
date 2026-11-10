import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AgentEvent, AgentKind, Annotation, CheckViolation, DesignSnapshot, FileDiff, FileNode, HighlightRequest, KicadInfo, McpActivity, PipelineState, ProjectInfo, Settings, SnapshotRequest, ViewKind } from "../shared/types";
import { addActivity, initialAgent, reduce, type AgentState } from "./agentStore";
import { api } from "./api";
import type { BoardHit } from "./board/BoardCanvas";
import { LangContext, translate } from "./i18n";
import { AgentPanel } from "./components/AgentPanel";
import { Board3D } from "./components/Board3D";
import { BoardView, type BoardHandle } from "./components/BoardView";
import { LeftPanel, type LeftTab } from "./components/LeftPanel";
import { SchematicView, type SchematicHandle } from "./components/SchematicView";
import { SettingsDialog } from "./components/SettingsDialog";
import { SourceDrawer } from "./components/SourceDrawer";

type AgentAction = { t: "ev"; kind: AgentKind; ev: AgentEvent } | { t: "act"; a: McpActivity } | { t: "kind"; kind: AgentKind };

function agentReducer(s: AgentState, a: AgentAction): AgentState {
  if (a.t === "ev") return reduce(s, a.kind, a.ev);
  if (a.t === "act") return addActivity(s, a.a);
  return { ...s, kind: a.kind };
}

function useSplitter(initial: number, min: number, max: number, side: "left" | "right") {
  const [w, setW] = useState(() => {
    try { return Number(localStorage.getItem(`split-${side}`)) || initial; } catch { return initial; }
  });
  const start = (e: React.PointerEvent) => {
    const x0 = e.clientX, w0 = w;
    const move = (ev: PointerEvent) => {
      const nw = Math.min(max, Math.max(min, side === "left" ? w0 + ev.clientX - x0 : w0 - (ev.clientX - x0)));
      setW(nw);
      try { localStorage.setItem(`split-${side}`, String(nw)); } catch { /* storage unavailable */ }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return [w, start] as const;
}

const EMPTY: DesignSnapshot = { n: 0, board: null, schematic: null, erc: null, drc: null, glb: null, errors: [] };

export function App() {
  const [appInfo, setAppInfo] = useState<any>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [kicad, setKicad] = useState<KicadInfo | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [design, setDesign] = useState<DesignSnapshot>(EMPTY);
  const [pipe, setPipe] = useState<PipelineState>({ running: false, n: 0 });
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [activeAnn, setActiveAnn] = useState<string | null>(null);
  const [agent, dispatch] = useReducer(agentReducer, initialAgent("claude"));
  const [tab, setTab] = useState<ViewKind>(() => { try { return (localStorage.getItem("view-tab") as ViewKind) || "board"; } catch { return "board"; } });
  const [leftTab, setLeftTab] = useState<LeftTab>("parts");
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [boardSel, setBoardSel] = useState<BoardHit | null>(null);
  const [hl, setHl] = useState<{ refs: string[]; nets: string[] }>({ refs: [], nets: [] });
  const [activeMarker, setActiveMarker] = useState<{ kind: "erc" | "drc"; i: number } | null>(null);
  const [chip, setChip] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [fileVersion, setFileVersion] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState<"open" | "frozen" | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const boardH = useRef<BoardHandle | null>(null);
  const schH = useRef<SchematicHandle | null>(null);
  const langRef = useRef<"en" | "sv">("en");
  langRef.current = settings?.language ?? "en";
  const tr = (k: string, v?: Record<string, string | number>) => translate(langRef.current, k, v);
  const [leftW, leftDrag] = useSplitter(300, 200, 620, "left");
  const [rightW, rightDrag] = useSplitter(420, 300, 760, "right");
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const showToast = useCallback((t: string, ms = 5000) => {
    setToast(t);
    window.clearTimeout((showToast as any)._t);
    (showToast as any)._t = window.setTimeout(() => setToast(null), ms);
  }, []);

  const switchTab = (t: ViewKind) => { setTab(t); try { localStorage.setItem("view-tab", t); } catch { /* none */ } };
  (window as any).__setTab = switchTab; // test hook

  useEffect(() => {
    api.info().then((i: any) => {
      setAppInfo(i);
      setSettings(i.settings);
      setKicad(i.kicad);
      dispatch({ t: "kind", kind: i.settings.lastAgent ?? "claude" });
      if (i.project) {
        setInfo(i.project.info); setTree(i.project.tree); setDesign(i.project.design); setPipe(i.project.state);
        api.annotations.list().then(setAnnotations);
      }
    });
    const hlTimer = { id: 0 };
    const offs = [
      api.project.onOpened((p: any) => {
        setInfo(p.info); setTree(p.tree); setDesign(EMPTY); setDiffs([]); setSelectedRef(null); setBoardSel(null); setActiveMarker(null); setActiveAnn(null);
      }),
      api.project.onInfo((i: ProjectInfo) => setInfo(i)),
      api.project.onChanged((c: any) => {
        setTree(c.tree);
        if (c.diffs?.length) setDiffs((d) => [...d, ...c.diffs].slice(-200));
        setFileVersion((n) => n + 1);
      }),
      api.design.onUpdate((d: DesignSnapshot) => setDesign(d)),
      api.design.onState((s: PipelineState) => setPipe(s)),
      api.annotations.onChanged((list: Annotation[]) => setAnnotations(list)),
      api.agent.onEvent((kind: AgentKind, ev: AgentEvent) => dispatch({ t: "ev", kind, ev })),
      api.agent.onMcpActivity((a: McpActivity) => {
        dispatch({ t: "act", a });
        if (a.tool === "render_view") showToast(tr("toast.agentLooks", { view: (a.args as any)?.view ?? "board" }), 1800);
      }),
      api.viewer.onSnapshot(async (req: SnapshotRequest) => {
        try {
          const url = req.view === "schematic"
            ? await schH.current!.snapshot(req)
            : boardH.current!.snapshot(req);
          api.viewer.snapshotDone(req.reqId, url);
        } catch (e: any) { api.viewer.snapshotDone(req.reqId, null, e?.message ?? String(e)); }
      }),
      api.viewer.onHighlight((h: HighlightRequest) => {
        setHl({ refs: h.refs ?? [], nets: h.nets ?? [] });
        if (h.view) switchTab(h.view);
        if (h.focus) setTimeout(() => {
          if ((h.view ?? tabRef.current) === "schematic") schH.current?.focus(h.refs ?? []);
          else boardH.current?.focus(h.refs ?? [], h.nets ?? []);
        }, 50);
        if (h.message) showToast(tr("toast.agentSays", { msg: h.message }), 9000);
        window.clearTimeout(hlTimer.id);
        hlTimer.id = window.setTimeout(() => setHl({ refs: [], nets: [] }), 12000);
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [showToast]);

  // Selection is shared: a reference picked anywhere is selected on the board and in the schematic.
  const pickRef = (ref: string) => {
    setSelectedRef(ref);
    const f = design.board?.footprints.find((x) => x.ref === ref);
    setBoardSel(f ? { ref, x: f.x, y: f.y } : null);
    const t = tab === "3d" ? "board" : tab;
    if (t !== tab) switchTab(t);
    setTimeout(() => {
      if (t === "schematic" || !f) { if (!f) switchTab("schematic"); schH.current?.focus([ref]); }
      else boardH.current?.focus([ref]);
    }, 30);
  };
  const pickNet = (net: string) => {
    setSelectedRef(null);
    setBoardSel({ net, x: 0, y: 0 });
    if (tab !== "board") switchTab("board");
    setTimeout(() => boardH.current?.focus([], [net]), 30);
  };
  const pickMarker = (kind: "erc" | "drc", i: number, v: CheckViolation) => {
    setActiveMarker({ kind, i });
    const it = v.items.find((x) => x.x !== undefined);
    const ref = v.items.find((x) => x.ref)?.ref;
    if (ref) setSelectedRef(ref);
    if (kind === "erc") {
      switchTab("schematic");
      if (it) setTimeout(() => schH.current?.focusPoint(v.sheet ?? "/", it.x!, it.y!), 30);
    } else {
      switchTab("board");
      if (it) setTimeout(() => boardH.current?.focusPoint(it.x!, it.y!), 30);
    }
  };

  const addBoardAnnotation = async (h: BoardHit, layer: string) => {
    const a = await api.annotations.add({ view: "board", x: h.x, y: h.y, layer, ref: h.ref, net: h.net, text: "" });
    if (a) setActiveAnn(a.id);
  };
  const addSchAnnotation = async (sheet: string, x: number, y: number, ref?: string) => {
    const a = await api.annotations.add({ view: "schematic", sheet, x, y, ref, text: "" });
    if (a) setActiveAnn(a.id);
  };
  const activateAnnotation = (id: string | null) => {
    setActiveAnn(id);
    const a = annotations.find((x) => x.id === id);
    if (!a) return;
    if (a.view === "board") { switchTab("board"); setTimeout(() => boardH.current?.focusPoint(a.x, a.y), 30); }
    else { switchTab("schematic"); setTimeout(() => schH.current?.focusPoint(a.sheet ?? "/", a.x, a.y), 30); }
  };

  const switchAgent = async (kind: AgentKind, resumeId?: string) => {
    if (agent.status === "busy" && !confirm(tr("confirm.switchAgent"))) return;
    dispatch({ t: "kind", kind });
    const r = await api.agent.start(kind, resumeId);
    if (!r.ok) dispatch({ t: "ev", kind, ev: { type: "error", message: r.error } });
  };

  const dropProps = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } },
    onDragLeave: (e: React.DragEvent) => { if (e.currentTarget === e.target) setDragOver(false); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) api.project.open(api.project.pathForFile(f));
    },
  };

  const lang = settings?.language ?? "en";
  if (!appInfo) return <div className="boot">{tr("app.starting")}</div>;

  if (!info || !tree) {
    return (
      <LangContext.Provider value={lang}>
        <div className={`welcome ${dragOver ? "drag" : ""}`} {...dropProps}>
          <img className="welcome-mark" src="./icon-256.png" alt="" />
          <h1>SlashPCB</h1>
          <p className="muted">{tr("app.tagline")}</p>
          {!kicad?.cli && <p className="err-msg">{kicad?.error ?? tr("kicad.missing")}</p>}
          <div className="welcome-actions">
            <button className="primary" onClick={() => api.project.openFileDialog()}>{tr("app.openFile")}</button>
            <button onClick={() => api.project.openDialog()}>{tr("app.openFolder")}</button>
          </div>
          <p className="muted small">{tr("app.dropHint")}</p>
          {settings?.recentProjects?.length ? (
            <div className="recent">
              <h4>{tr("app.recent")}</h4>
              {settings.recentProjects.map((d) => <div key={d} className="recent-row" onClick={() => api.project.open(d)}>{d}</div>)}
            </div>
          ) : null}
          {kicad?.version && <p className="muted small">KiCad {kicad.version}{kicad.flatpak ? " (Flatpak)" : ""}</p>}
        </div>
      </LangContext.Provider>
    );
  }

  const dark = (settings?.theme ?? "dark") === "dark";
  const erc = design.erc, drc = design.drc;
  const lockOn = (f: string | null) => !!f && info.locks.some((l) => l.file === f);
  const checkSummary = (r: typeof erc, k: string) => !r ? null : !r.ok ? <span className="bad">{k} ✕</span>
    : <span className={r.errors ? "bad" : r.warnings ? "warn" : "ok"}>{k} {r.errors}/{r.warnings}</span>;

  return (
    <LangContext.Provider value={lang}>
    <div className={`app ${dark ? "" : "light"} ${dragOver ? "drag" : ""}`} {...dropProps} style={{ gridTemplateColumns: `${leftW}px 4px 1fr 4px ${rightW}px` }}>
      <div className="topbar">
        <span className="brand"><img src="./icon-64.png" alt="" />SlashPCB</span>
        <span className="proj" title={`${info.dir}/${info.pro}`}>{info.name}</span>
        {info.otherProjects.length > 0 && (
          <select className="proj-switch" value={info.pro} onChange={(e) => api.project.switchTo(e.target.value)} title={tr("app.otherProjects")}>
            <option value={info.pro}>{info.pro}</option>
            {info.otherProjects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <span className="menu-wrap">
          <button className={`pill ${info.frozen ? "frozen" : "edit"}`} title={info.frozenReason ?? tr("frozen.editableTitle")} onClick={() => setMenu(menu === "frozen" ? null : "frozen")}>
            {info.frozen ? `❄ ${tr("frozen.frozen")}` : `✎ ${tr("frozen.editable")}`}
          </button>
          {menu === "frozen" && (
            <div className="menu" onMouseLeave={() => setMenu(null)}>
              <div className="menu-note">{info.frozen ? tr("frozen.explain", { r: info.frozenReason ?? "" }) : tr("frozen.explainEdit")}</div>
              <div className="menu-item" onClick={() => { setMenu(null); api.project.setFrozen(true); }}>{tr("frozen.mark")}</div>
              <div className="menu-item" onClick={() => { setMenu(null); api.project.setFrozen(false); }}>{tr("frozen.allow")}</div>
              <div className="menu-item" onClick={() => { setMenu(null); api.project.setFrozen(null); }}>{tr("frozen.auto")}</div>
            </div>
          )}
        </span>
        {info.locks.length > 0 && <span className="pill lock" title={info.locks.map((l) => `${l.file}${l.user ? ` (${l.user})` : ""}`).join("\n")}>🔒 {tr("kicad.openIn", { f: info.locks.map((l) => l.file.replace(/^.*\.kicad_/, "")).join(", ") })}</span>}
        <span className="menu-wrap">
          <button onClick={() => setMenu(menu === "open" ? null : "open")}>{tr("app.open")} ▾</button>
          {menu === "open" && (
            <div className="menu open-menu" onMouseLeave={() => setMenu(null)}>
              <div className="menu-item" onClick={() => { setMenu(null); api.project.openFileDialog(); }}>{tr("app.openFile")}</div>
              <div className="menu-item" onClick={() => { setMenu(null); api.project.openDialog(); }}>{tr("app.openFolder")}</div>
              {(settings?.recentProjects ?? []).slice(0, 8).map((d) => <div key={d} className="menu-item small" onClick={() => { setMenu(null); api.project.open(d); }}>{d.split(/[\\/]/).slice(-2).join("/")}</div>)}
            </div>
          )}
        </span>
        <span className="grow" />
        <button className="kicad-btn" disabled={!kicad?.gui} title={kicad?.cli ?? kicad?.error ?? ""} onClick={() => api.kicad.open(tab === "schematic" && info.sch ? info.sch : tab !== "schematic" && info.pcb ? info.pcb : info.pro)}>
          {tr("kicad.open")}{kicad?.version ? ` ${kicad.version}` : ""}
        </button>
        <button onClick={() => api.design.run()} disabled={pipe.running} title={tr("checks.runTitle")}>{tr("checks.run")}</button>
        <button onClick={() => setShowSettings(true)}>{tr("app.settings")}</button>
      </div>
      <LeftPanel
        info={info} tree={tree} design={design} diffs={diffs} tab={leftTab} onTab={setLeftTab}
        selectedRef={selectedRef} selectedNet={boardSel?.ref ? null : boardSel?.net ?? null} activeMarker={activeMarker}
        onOpenFile={setSource} onPickRef={pickRef} onPickNet={pickNet} onPickMarker={pickMarker} onRunChecks={() => api.design.run()}
      />
      <div className="splitter" onPointerDown={leftDrag} />
      <div className="center">
        <div className="view-tabs">
          {(["schematic", "board", "3d"] as ViewKind[]).map((k) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => switchTab(k)}>
              {tr(`tab.${k}`)}{k === "schematic" && lockOn(info.sch) ? " 🔒" : ""}{k === "board" && lockOn(info.pcb) ? " 🔒" : ""}
            </button>
          ))}
          <span className="grow" />
          {design.board && <span className="muted small">{(design.board.bbox[2] - design.board.bbox[0]).toFixed(2)} × {(design.board.bbox[3] - design.board.bbox[1]).toFixed(2)} mm · {design.board.copper.length} Cu · {design.board.stats.footprints} {tr("stat.parts")} · {design.board.stats.nets} {tr("stat.nets")}</span>}
        </div>
        <div className="view-area">
          <div className={`view ${tab === "schematic" ? "" : "hidden"}`}>
            <SchematicView schematic={design.schematic} markers={erc?.violations ?? []} activeMarker={activeMarker?.kind === "erc" ? activeMarker.i : null}
              annotations={annotations} activeAnnotation={activeAnn} highlightRefs={hl.refs} selectedRef={selectedRef} handle={schH}
              onSelect={(ref) => { setSelectedRef(ref); const f = ref ? design.board?.footprints.find((x) => x.ref === ref) : null; setBoardSel(f ? { ref: f.ref, x: f.x, y: f.y } : null); }}
              onAddAnnotation={addSchAnnotation} onAsk={setChip} />
          </div>
          <div className={`view ${tab === "board" ? "" : "hidden"}`}>
            <BoardView board={design.board} dark={dark} markers={drc?.violations ?? []} activeMarker={activeMarker?.kind === "drc" ? activeMarker.i : null}
              annotations={annotations} activeAnnotation={activeAnn} highlightRefs={hl.refs} highlightNets={hl.nets} selection={boardSel} handle={boardH}
              onSelect={(h) => { setBoardSel(h); setSelectedRef(h?.ref ?? null); }} onAddAnnotation={addBoardAnnotation} onAsk={setChip} />
          </div>
          <div className={`view ${tab === "3d" ? "" : "hidden"}`}>
            <Board3D glb={design.glb} active={tab === "3d"} running={pipe.running && pipe.stage === "3d"} dark={dark} />
          </div>
          {toast && <div className="toast">{toast}</div>}
          {source && <SourceDrawer path={source} errorLine={null} version={fileVersion} onClose={() => setSource(null)} />}
        </div>
        <div className="statusbar">
          <span className={`st ${pipe.running ? "run" : pipe.error ? "bad" : "ok"}`}>
            {pipe.running ? <><span className="spinner" /> {tr(`stage.${pipe.stage ?? "parse"}`)}{pipe.queued ? tr("st.queued") : ""}</>
              : pipe.n ? tr("st.done", { n: pipe.n, s: (pipe.lastSeconds ?? 0).toFixed(1) }) : tr("st.ready")}
          </span>
          {checkSummary(erc, "ERC")}
          {checkSummary(drc, "DRC")}
          {pipe.error && <span className="bad small" title={design.errors.join("\n")}>{pipe.error.slice(0, 80)}</span>}
          <span className="grow" />
          <span className="muted">{kicad?.version ? `KiCad ${kicad.version}` : tr("kicad.missing")} · {appInfo.displayBackend}</span>
        </div>
      </div>
      <div className="splitter" onPointerDown={rightDrag} />
      <AgentPanel
        state={agent}
        binaries={{ claude: appInfo.claude, codex: appInfo.codex }}
        selectionChip={chip}
        onClearChip={() => setChip(null)}
        projectOpen={!!info}
        onSwitch={switchAgent}
        annotations={annotations}
        activeAnnotation={activeAnn}
        onActivateAnnotation={activateAnnotation}
      />
      {showSettings && settings && <SettingsDialog settings={settings} info={{ ...appInfo, kicad }} onClose={() => setShowSettings(false)} onSaved={(s) => { setSettings(s); api.kicad.info().then(setKicad); }} />}
    </div>
    </LangContext.Provider>
  );
}
