import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, CheckViolation, SchSheet, SchSymbol, SchematicModel, SnapshotRequest } from "../../shared/types";
import { api } from "../api";
import { drawPin } from "../board/BoardCanvas";
import { useT } from "../i18n";

export interface SchematicHandle {
  focus(refs: string[]): void;
  focusPoint(sheet: string, x: number, y: number): void;
  snapshot(req: SnapshotRequest): Promise<string>;
}

interface View { x: number; y: number; scale: number } // sheet mm at the top-left corner, px per mm

interface Props {
  schematic: SchematicModel | null;
  markers: CheckViolation[];
  activeMarker: number | null;
  annotations: Annotation[];
  activeAnnotation: string | null;
  highlightRefs: string[];
  selectedRef: string | null;
  onSelect(ref: string | null, sym?: SchSymbol): void;
  onAddAnnotation(sheet: string, x: number, y: number, ref?: string): void;
  onAsk(chip: string): void;
  handle: React.MutableRefObject<SchematicHandle | null>;
}

const urlCache = new Map<string, string>();
async function svgUrl(path: string): Promise<string> {
  const c = urlCache.get(path);
  if (c) return c;
  const bytes = await api.design.file(path);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/svg+xml" }));
  urlCache.set(path, url);
  if (urlCache.size > 40) { const [k, u] = urlCache.entries().next().value!; URL.revokeObjectURL(u); urlCache.delete(k); }
  return url;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("image")); i.src = url; });
}

function fit(sheet: SchSheet, w: number, h: number, box?: [number, number, number, number]): View {
  const b = box ?? [0, 0, sheet.w, sheet.h];
  const bw = Math.max(b[2] - b[0], 5), bh = Math.max(b[3] - b[1], 5);
  const scale = Math.min(w / bw, h / bh) * 0.94;
  return { scale, x: (b[0] + b[2]) / 2 - w / 2 / scale, y: (b[1] + b[3]) / 2 - h / 2 / scale };
}

export function SchematicView(p: Props) {
  const t = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [sheetPath, setSheetPath] = useState("/");
  const [view, setView] = useState<View | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; sx: number; sy: number; sym: SchSymbol | null } | null>(null);
  const sheets = p.schematic?.sheets ?? [];
  const sheet = sheets.find((s) => s.path === sheetPath) ?? sheets[0] ?? null;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    if (sheet?.svg) svgUrl(sheet.svg).then((u) => live && setUrl(u)).catch(() => live && setUrl(null));
    else setUrl(null);
    return () => { live = false; };
  }, [sheet?.svg]);

  useEffect(() => { setView(null); }, [sheet?.path]);

  const v: View | null = view ?? (sheet ? fit(sheet, size.w, size.h) : null);
  const syms = useMemo(() => (p.schematic?.symbols ?? []).filter((s) => sheet && s.sheet === sheet.path), [p.schematic, sheet]);

  // Overlay: highlights, selection, ERC markers, user markers.
  useEffect(() => {
    const c = overlay.current;
    if (!c || !v) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr); c.height = Math.round(size.h * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);
    drawOverlay(g, v, syms, sheet?.path ?? "/", p, null);
  }, [v?.x, v?.y, v?.scale, size, syms, p.highlightRefs, p.selectedRef, p.markers, p.activeMarker, p.annotations, p.activeAnnotation]);

  const findRefs = (refs: string[]) => (p.schematic?.symbols ?? []).filter((s) => refs.includes(s.ref));
  const boxOf = (list: SchSymbol[]): [number, number, number, number] => {
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const s of list) { b[0] = Math.min(b[0], s.bbox[0]); b[1] = Math.min(b[1], s.bbox[1]); b[2] = Math.max(b[2], s.bbox[2]); b[3] = Math.max(b[3], s.bbox[3]); }
    const m = 15;
    return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
  };

  p.handle.current = {
    focus(refs) {
      const list = findRefs(refs);
      if (!list.length) return;
      const sh = list[0].sheet;
      const target = sheets.find((s) => s.path === sh);
      if (!target) return;
      setSheetPath(sh);
      setTimeout(() => setView(fit(target, size.w, size.h, boxOf(list.filter((s) => s.sheet === sh)))), 0);
    },
    focusPoint(sh, x, y) {
      const target = sheets.find((s) => s.path === sh) ?? sheet;
      if (!target) return;
      setSheetPath(target.path);
      setTimeout(() => setView(fit(target, size.w, size.h, [x - 40, y - 30, x + 40, y + 30])), 0);
    },
    async snapshot(req) {
      if (!p.schematic) throw new Error("no schematic");
      const want = req.sheet ? sheets.find((s) => s.path === req.sheet || s.name === req.sheet || s.path === `/${req.sheet}/`) : null;
      const focusList = req.focusRefs?.length ? findRefs(req.focusRefs) : [];
      const target = want ?? (focusList[0] ? sheets.find((s) => s.path === focusList[0].sheet) : null) ?? sheet;
      if (!target?.svg) throw new Error("the schematic SVG is not ready yet");
      const img = await loadImage(await svgUrl(target.svg));
      const c = document.createElement("canvas");
      c.width = req.width; c.height = req.height;
      const g = c.getContext("2d")!;
      const box = focusList.filter((s) => s.sheet === target.path);
      const vv = fit(target, req.width, req.height, box.length ? boxOf(box) : undefined);
      g.fillStyle = "#f5f4ef";
      g.fillRect(0, 0, req.width, req.height);
      g.drawImage(img, -vv.x * vv.scale, -vv.y * vv.scale, target.w * vv.scale, target.h * vv.scale);
      const list = p.schematic.symbols.filter((s) => s.sheet === target.path);
      drawOverlay(g, vv, list, target.path, { ...p, highlightRefs: req.highlightRefs ?? p.highlightRefs, selectedRef: null }, null);
      return c.toDataURL("image/png");
    },
  };

  // Interaction.
  const drag = useRef<{ x: number; y: number; v: View; moved: boolean; button: number } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => { const r = wrap.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const toSheet = (sx: number, sy: number): [number, number] => [v!.x + sx / v!.scale, v!.y + sy / v!.scale];
  const hit = (x: number, y: number): SchSymbol | null => {
    const inside = syms.filter((s) => x >= s.bbox[0] - 0.6 && x <= s.bbox[2] + 0.6 && y >= s.bbox[1] - 0.6 && y <= s.bbox[3] + 0.6);
    inside.sort((a, b) => Number(a.power) - Number(b.power) || (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]));
    return inside[0] ?? null;
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!v) return;
    const [sx, sy] = local(e);
    const [x, y] = toSheet(sx, sy);
    const scale = Math.min(Math.max(v.scale * Math.exp(-e.deltaY * 0.0015), 0.2), 200);
    setView({ scale, x: x - sx / scale, y: y - sy / scale });
  };
  const onDown = (e: React.PointerEvent) => {
    if (!v || e.button === 2) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, v, moved: false, button: e.button };
  };
  const onMove = (e: React.PointerEvent) => {
    if (v) { const [sx, sy] = local(e); setCursor(toSheet(sx, sy)); }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    setView({ ...d.v, x: d.v.x - dx / d.v.scale, y: d.v.y - dy / d.v.scale });
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !v || d.button !== 0) return;
    const [sx, sy] = local(e);
    const s = hit(...toSheet(sx, sy));
    p.onSelect(s?.ref ?? null, s ?? undefined);
  };
  const onDouble = () => setView(null);
  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!v) return;
    const [sx, sy] = local(e);
    const [x, y] = toSheet(sx, sy);
    setCtx({ x: sx, y: sy, sx: x, sy: y, sym: hit(x, y) });
  };

  if (!p.schematic) return <div className="empty-view muted">{t("sch.none")}</div>;
  const selSym = p.selectedRef ? (p.schematic.symbols.find((s) => s.ref === p.selectedRef) ?? null) : null;

  return (
    <div className="sch-view" ref={wrap} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={onDouble} onContextMenu={onContext} onPointerLeave={() => setCursor(null)}>
      {url && sheet && v ? (
        <img className="sch-img" src={url} alt="" draggable={false}
          style={{ width: sheet.w * v.scale, height: sheet.h * v.scale, transform: `translate(${-v.x * v.scale}px, ${-v.y * v.scale}px)` }} />
      ) : <div className="empty-view muted">{t("sch.exporting")}</div>}
      <canvas ref={overlay} className="sch-overlay" style={{ width: size.w, height: size.h }} />
      {sheets.length > 1 && (
        <div className="sheet-tabs" onPointerDown={(e) => e.stopPropagation()}>
          {sheets.map((s) => (
            <button key={s.path} className={s.path === sheet?.path ? "on" : ""} onClick={() => setSheetPath(s.path)} title={`${s.path} · ${s.file}`}>
              {s.page ? `${s.page}. ` : ""}{s.path === "/" ? t("sch.root") : s.name}
            </button>
          ))}
        </div>
      )}
      {selSym && (
        <div className="sel-card" onPointerDown={(e) => e.stopPropagation()}>
          <div className="sel-name">{selSym.ref} <span className="muted">{selSym.value}</span></div>
          <div className="muted small">{selSym.libId} · {t("sch.sheet")} {selSym.sheet}</div>
          {selSym.footprint && <div className="small"><span className="muted">Footprint:</span> {selSym.footprint}</div>}
          {Object.entries(selSym.fields).filter(([k, val]) => val && !["Reference", "Value", "Footprint", "Datasheet", "Description"].includes(k)).slice(0, 6).map(([k, val]) => (
            <div key={k} className="small"><span className="muted">{k}:</span> {val}</div>
          ))}
          <div className="sel-actions">
            <button className="primary" onClick={() => p.onAddAnnotation(selSym.sheet, (selSym.bbox[0] + selSym.bbox[2]) / 2, selSym.bbox[1], selSym.ref)}>{t("vp.mark")}</button>
            <button onClick={() => p.onAsk(`${selSym.ref} (${selSym.value}, ${selSym.libId}) on sheet ${selSym.sheet}`)}>{t("vp.ask")}</button>
            <button onClick={() => p.handle.current?.focus([selSym.ref])}>{t("vp.zoom")}</button>
          </div>
        </div>
      )}
      {ctx && (
        <div className="ctx-back" onPointerDown={(e) => { e.stopPropagation(); setCtx(null); }} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx(null); }}>
          <div className="menu ctx" style={{ left: ctx.x, top: ctx.y }} onPointerDown={(e) => e.stopPropagation()}>
            {ctx.sym && <div className="menu-title">{ctx.sym.ref} · {ctx.sym.value}</div>}
            <div className="menu-item strong" onClick={() => { setCtx(null); p.onAddAnnotation(sheet?.path ?? "/", ctx.sx, ctx.sy, ctx.sym?.ref); }}>{t("ctx.mark")}</div>
            {ctx.sym && <div className="menu-item" onClick={() => { setCtx(null); p.onSelect(ctx.sym!.ref, ctx.sym!); }}>{t("ctx.select")}</div>}
            <div className="menu-sep" />
            <div className="menu-item" onClick={() => { setCtx(null); setView(null); }}>{t("ctx.fitAll")}</div>
          </div>
        </div>
      )}
      <div className="view-status muted small">{cursor ? `X ${cursor[0].toFixed(2)}  Y ${cursor[1].toFixed(2)} mm` : ""} · {sheet?.file} · {t("sch.keys")}</div>
    </div>
  );
}

function drawOverlay(g: CanvasRenderingContext2D, v: View, syms: SchSymbol[], sheet: string, p: Pick<Props, "highlightRefs" | "selectedRef" | "markers" | "activeMarker" | "annotations" | "activeAnnotation">, _unused: null): void {
  const sx = (x: number) => (x - v.x) * v.scale, sy = (y: number) => (y - v.y) * v.scale;
  const hl = new Set(p.highlightRefs);
  for (const s of syms) {
    const sel = s.ref === p.selectedRef;
    if (!sel && !hl.has(s.ref)) continue;
    g.fillStyle = sel ? "rgba(79,195,255,0.18)" : "rgba(255,210,90,0.25)";
    g.strokeStyle = sel ? "#2ea8e6" : "#e0a800";
    g.lineWidth = 2;
    const x = sx(s.bbox[0] - 1), y = sy(s.bbox[1] - 1), w = (s.bbox[2] - s.bbox[0] + 2) * v.scale, h = (s.bbox[3] - s.bbox[1] + 2) * v.scale;
    g.fillRect(x, y, w, h);
    g.strokeRect(x, y, w, h);
  }
  p.markers.forEach((m, i) => {
    if (m.source !== "erc" || (m.sheet ?? "/") !== sheet) return;
    for (const it of m.items) {
      if (it.x === undefined || it.y === undefined) continue;
      const x = sx(it.x), y = sy(it.y), active = p.activeMarker === i;
      g.fillStyle = m.severity === "error" ? "#e53935" : "#f59e0b";
      const k = Math.max(0.45, Math.min(1, v.scale / 4));
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + 10 * k, y - 16 * k); g.lineTo(x - 6 * k, y - 12 * k); g.closePath(); g.fill();
      if (active) { g.strokeStyle = g.fillStyle; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.stroke(); }
    }
  });
  for (const a of p.annotations) if (a.view === "schematic" && (a.sheet ?? "/") === sheet) drawPin(g, sx(a.x), sy(a.y), a.n, a.status === "done", a.id === p.activeAnnotation);
}
