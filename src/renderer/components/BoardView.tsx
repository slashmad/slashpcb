import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, BoardModel, CheckViolation, SnapshotRequest } from "../../shared/types";
import { BoardScene, canon, drawBoard, fitView, layerColor, toBoard, type BoardHit, type BoardView as View } from "../board/BoardCanvas";
import { useT } from "../i18n";

export interface BoardHandle {
  focus(refs: string[], nets?: string[]): void;
  focusPoint(x: number, y: number): void;
  snapshot(req: SnapshotRequest): string;
}

interface Props {
  board: BoardModel | null;
  dark: boolean;
  markers: CheckViolation[];
  activeMarker: number | null;
  annotations: Annotation[];
  activeAnnotation: string | null;
  highlightRefs: string[];
  highlightNets: string[];
  selection: BoardHit | null;
  onSelect(h: BoardHit | null): void;
  onAddAnnotation(h: BoardHit, layer: string): void;
  onAsk(chip: string): void;
  handle: React.MutableRefObject<BoardHandle | null>;
}

const DEFAULT_OFF = /\.(Mask|Paste|Adhes|CrtYd)$|^(Cmts|Eco1|Eco2)\.User$|^Margin$|^User\.\d+$/;

export function BoardView(p: Props) {
  const t = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View | null>(null);
  const [side, setSide] = useState<"top" | "bottom">("top");
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; hit: BoardHit | null; bx: number; by: number } | null>(null);
  const scene = useMemo(() => (p.board ? new BoardScene(p.board) : null), [p.board]);
  const fileRef = useRef<string | null>(null);

  // Layers: keep the user's choice across reloads of the same board.
  const allLayers = useMemo(() => {
    if (!p.board) return [];
    const present = new Set<string>(scene ? [...scene.layers.keys()] : []);
    const names = [...p.board.copper, ...p.board.layers.map((l) => canon(l.name)).filter((n) => !n.endsWith(".Cu"))];
    return [...new Set(names)].filter((n) => present.has(n) || p.board!.copper.includes(n));
  }, [p.board, scene]);

  useEffect(() => {
    if (!p.board) return;
    const first = fileRef.current !== p.board.file;
    fileRef.current = p.board.file;
    if (first) {
      setVisible(new Set(allLayers.filter((l) => !DEFAULT_OFF.test(l))));
      setView(null);
    }
  }, [p.board, allLayers]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const v: View | null = view ?? (p.board ? fitView(p.board.bbox, size.w, size.h) : null);

  // Draw.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !scene || !v) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) { c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr); }
    const g = c.getContext("2d")!;
    const raf = requestAnimationFrame(() => drawBoard(g, scene, v, size.w, size.h, {
      visible, side, highlightRefs: new Set(p.highlightRefs), highlightNets: new Set(p.highlightNets),
      selectedRef: p.selection?.ref ?? null, selectedNet: p.selection?.ref ? null : p.selection?.net ?? null,
      markers: p.markers, activeMarker: p.activeMarker, annotations: p.annotations, activeAnnotation: p.activeAnnotation, dark: p.dark,
    }, dpr));
    return () => cancelAnimationFrame(raf);
  }, [scene, v?.cx, v?.cy, v?.scale, size, visible, side, p.highlightRefs, p.highlightNets, p.selection, p.markers, p.activeMarker, p.annotations, p.activeAnnotation, p.dark]);

  const bboxOf = (refs: string[], nets: string[] = []): [number, number, number, number] | null => {
    if (!p.board) return null;
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const g = (x: number, y: number) => { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); };
    for (const f of p.board.footprints) {
      if (refs.includes(f.ref)) { g(f.bbox[0], f.bbox[1]); g(f.bbox[2], f.bbox[3]); }
      else if (nets.length) for (const pd of f.pads) if (nets.includes(pd.net)) g(pd.x, pd.y);
    }
    for (const tr of p.board.tracks) if (nets.includes(tr.net)) { g(tr.x1, tr.y1); g(tr.x2, tr.y2); }
    if (!Number.isFinite(b[0])) return null;
    const pad = Math.max(2, Math.max(b[2] - b[0], b[3] - b[1]) * 0.25);
    return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  };

  p.handle.current = {
    focus(refs, nets = []) {
      const b = bboxOf(refs, nets);
      if (b) setView(fitView(b, size.w, size.h, 0.85));
      const f = p.board?.footprints.find((x) => refs.includes(x.ref));
      if (f && f.side === "B" && side === "top") setSide("bottom");
      if (f && f.side === "F" && side === "bottom") setSide("top");
    },
    focusPoint(x, y) {
      const cur = v ?? { cx: x, cy: y, scale: 10 };
      setView({ cx: x, cy: y, scale: Math.max(cur.scale, 12) });
    },
    snapshot(req) {
      if (!scene || !p.board) throw new Error("no board");
      const c = document.createElement("canvas");
      c.width = req.width; c.height = req.height;
      const g = c.getContext("2d")!;
      const b = (req.focusRefs?.length ? bboxOf(req.focusRefs) : null) ?? p.board.bbox;
      const vis = req.layers?.length ? new Set(req.layers.map(canon)) : visible;
      drawBoard(g, scene, fitView(b, req.width, req.height, 0.9), req.width, req.height, {
        visible: vis, side: req.side ?? "top", highlightRefs: new Set(req.highlightRefs ?? []), highlightNets: new Set(req.highlightNets ?? []),
        markers: p.markers, annotations: p.annotations, dark: true,
      });
      return c.toDataURL("image/png");
    },
  };

  // Interaction: wheel zooms at the cursor, drag pans, click selects.
  const drag = useRef<{ x: number; y: number; v: View; moved: boolean; button: number } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!v) return;
    const [sx, sy] = local(e);
    const [bx, by] = toBoard(v, side, size.w, size.h, sx, sy);
    const k = Math.exp(-e.deltaY * 0.0015);
    const scale = Math.min(Math.max(v.scale * k, 0.5), 4000);
    const m = side === "bottom" ? -1 : 1;
    setView({ scale, cx: bx - (m * (sx - size.w / 2)) / scale, cy: by - (sy - size.h / 2) / scale });
  };
  const onDown = (e: React.PointerEvent) => {
    if (!v || e.button === 2) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, v, moved: false, button: e.button };
  };
  const onMove = (e: React.PointerEvent) => {
    if (v) { const [sx, sy] = local(e); setCursor(toBoard(v, side, size.w, size.h, sx, sy)); }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const m = side === "bottom" ? -1 : 1;
    setView({ ...d.v, cx: d.v.cx - (m * dx) / d.v.scale, cy: d.v.cy - dy / d.v.scale });
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !scene || !v || d.button !== 0) return;
    const [sx, sy] = local(e);
    const [bx, by] = toBoard(v, side, size.w, size.h, sx, sy);
    p.onSelect(scene.hit(bx, by, side, visible));
  };
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!scene || !v) return;
    const [sx, sy] = local(e);
    const [bx, by] = toBoard(v, side, size.w, size.h, sx, sy);
    setCtx({ x: sx, y: sy, hit: scene.hit(bx, by, side, visible), bx, by });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("textarea, input, select") || !wrap.current?.offsetParent) return;
      const k = e.key.toLowerCase();
      if (k === "f" || k === "home") setView(null);
      else if (k === "b") setSide((s) => (s === "top" ? "bottom" : "top"));
      else if (e.key === "Escape") p.onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggle = (l: string) => setVisible((s) => { const n = new Set(s); n.has(l) ? n.delete(l) : n.add(l); return n; });
  const activeLayer = side === "top" ? (p.board?.copper[0] ?? "F.Cu") : (p.board?.copper[p.board.copper.length - 1] ?? "B.Cu");
  const sel = p.selection;
  const selFp = sel?.ref ? p.board?.footprints.find((f) => f.ref === sel.ref) : null;

  if (!p.board) return <div className="empty-view muted">{t("board.none")}</div>;

  return (
    <div className="board-view" ref={wrap}>
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onDoubleClick={() => setView(null)} onContextMenu={onContext} onPointerLeave={() => setCursor(null)} />
      <div className="layer-panel">
        <div className="lp-head">
          <button className={side === "top" ? "on" : ""} onClick={() => setSide("top")}>{t("board.top")}</button>
          <button className={side === "bottom" ? "on" : ""} onClick={() => setSide("bottom")}>{t("board.bottom")}</button>
        </div>
        {allLayers.map((l) => (
          <label key={l} className={`lp-row ${visible.has(l) ? "" : "off"}`}>
            <input type="checkbox" checked={visible.has(l)} onChange={() => toggle(l)} />
            <span className="swatch" style={{ background: layerColor(l, p.board!.copper) }} />{l}
          </label>
        ))}
        <div className="lp-actions">
          <button className="link" onClick={() => setVisible(new Set(allLayers))}>{t("board.all")}</button>
          <button className="link" onClick={() => setVisible(new Set([...p.board!.copper, "Edge.Cuts"]))}>{t("board.copperOnly")}</button>
          <button className="link" onClick={() => setVisible(new Set(allLayers.filter((l) => !DEFAULT_OFF.test(l))))}>{t("board.default")}</button>
        </div>
      </div>
      {sel && (
        <div className="sel-card">
          {selFp ? <>
            <div className="sel-name">{selFp.ref} <span className="muted">{selFp.value}</span></div>
            <div className="muted small">{selFp.lib} · {selFp.side === "B" ? t("board.bottom") : t("board.top")} · ({selFp.x.toFixed(2)}, {selFp.y.toFixed(2)}) {selFp.rot}°</div>
            {sel.pad && <div className="small">{t("board.pad")} {sel.pad}{sel.net ? ` · ${sel.net}` : ""}</div>}
            {Object.entries(selFp.fields).filter(([k, val]) => val && !["Reference", "Value", "Footprint", "Datasheet", "Description"].includes(k)).slice(0, 6).map(([k, val]) => (
              <div key={k} className="small"><span className="muted">{k}:</span> {val}</div>
            ))}
          </> : <div className="sel-name">{t("board.net")} {sel.net}</div>}
          <div className="sel-actions">
            <button className="primary" onClick={() => p.onAddAnnotation(sel, activeLayer)}>{t("vp.mark")}</button>
            <button onClick={() => p.onAsk(selFp ? `${selFp.ref} (${selFp.value}${sel.pad ? `, pad ${sel.pad}` : ""}${sel.net ? `, net ${sel.net}` : ""}) at (${sel.x.toFixed(2)}, ${sel.y.toFixed(2)}) mm` : `net ${sel.net}`)}>{t("vp.ask")}</button>
            {selFp && <button onClick={() => p.handle.current?.focus([selFp.ref])}>{t("vp.zoom")}</button>}
            {sel.net && selFp && <button onClick={() => p.onSelect({ net: sel.net, x: sel.x, y: sel.y })}>{t("board.showNet")}</button>}
          </div>
        </div>
      )}
      {ctx && (
        <div className="ctx-back" onPointerDown={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }}>
          <div className="menu ctx" style={{ left: ctx.x, top: ctx.y }} onPointerDown={(e) => e.stopPropagation()}>
            {ctx.hit?.ref && <div className="menu-title">{ctx.hit.ref}{ctx.hit.pad ? ` · ${t("board.pad")} ${ctx.hit.pad}` : ""}{ctx.hit.net ? ` · ${ctx.hit.net}` : ""}</div>}
            <div className="menu-item strong" onClick={() => { setCtx(null); p.onAddAnnotation(ctx.hit ?? { x: ctx.bx, y: ctx.by }, activeLayer); }}>{t("ctx.mark")}</div>
            {ctx.hit && <div className="menu-item" onClick={() => { setCtx(null); p.onSelect(ctx.hit); }}>{t("ctx.select")}</div>}
            {ctx.hit?.net && <div className="menu-item" onClick={() => { setCtx(null); p.onSelect({ net: ctx.hit!.net, x: ctx.bx, y: ctx.by }); }}>{t("board.showNet")} {ctx.hit.net}</div>}
            <div className="menu-sep" />
            <div className="menu-item" onClick={() => { setCtx(null); setView(null); }}>{t("ctx.fitAll")}</div>
            <div className="menu-item" onClick={() => { setCtx(null); setSide(side === "top" ? "bottom" : "top"); }}>{t("board.flip")}</div>
          </div>
        </div>
      )}
      <div className="view-status muted small">
        {cursor ? `X ${cursor[0].toFixed(3)}  Y ${cursor[1].toFixed(3)} mm` : ""} · {side === "top" ? t("board.top") : t("board.bottom")} · {t("board.keys")}
      </div>
    </div>
  );
}
