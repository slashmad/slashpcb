// 2D board renderer on a Canvas 2D context. Geometry comes pre-transformed (absolute mm, y down)
// from the main process; this class caches Path2D objects per layer and redraws on demand.
import type { Annotation, BoardModel, CheckViolation, Footprint, Pad } from "../../shared/types";

export interface BoardView { cx: number; cy: number; scale: number } // board mm at canvas centre, px per mm
export interface BoardHit { ref?: string; pad?: string; net?: string; x: number; y: number }
export interface DrawOptions {
  visible: Set<string>;
  side: "top" | "bottom";
  highlightRefs: Set<string>;
  highlightNets: Set<string>;
  selectedRef?: string | null;
  selectedNet?: string | null;
  markers?: CheckViolation[];
  activeMarker?: number | null;
  annotations?: Annotation[];
  activeAnnotation?: string | null;
  dark: boolean;
}

const COPPER_COLORS = ["#c83434", "#c2c200", "#c261c2", "#33a59d", "#d68a2b", "#7f7fe0", "#8fbf4f", "#e06f9e"];
const LAYER_COLORS: Record<string, string> = {
  "B.Cu": "#4d7fc4", "F.SilkS": "#f2eda1", "B.SilkS": "#e8b2a7", "F.Silkscreen": "#f2eda1", "B.Silkscreen": "#e8b2a7",
  "F.Fab": "#afafaf", "B.Fab": "#585d84", "F.CrtYd": "#ff26e2", "B.CrtYd": "#26e9ff", "F.Courtyard": "#ff26e2", "B.Courtyard": "#26e9ff",
  "Edge.Cuts": "#d0d238", "Dwgs.User": "#c2c2c2", "Cmts.User": "#5980c0", "Margin": "#ff26e2",
  "F.Mask": "#d864ff", "B.Mask": "#02ffee", "F.Paste": "#b4a0a0", "B.Paste": "#00c2c2", "Eco1.User": "#b4dbd2", "Eco2.User": "#d8c852",
};
const SILK = (l: string) => /^[FB]\.(SilkS|Silkscreen)$/.test(l);

export function layerColor(layer: string, copper: string[]): string {
  const i = copper.indexOf(layer);
  if (layer === "B.Cu") return LAYER_COLORS["B.Cu"];
  if (i >= 0) return COPPER_COLORS[i % COPPER_COLORS.length];
  return LAYER_COLORS[layer] ?? "#9aa3ad";
}

/** Canonical name: KiCad 6+ uses F.SilkS internally with the user name F.Silkscreen. */
export const canon = (l: string) => l.replace("Silkscreen", "SilkS").replace("Courtyard", "CrtYd").replace("Adhesive", "Adhes");

interface LayerPaths {
  zones: Path2D;
  strokes: Map<number, Path2D>; // width → tracks and graphic strokes
  fills: Path2D; // filled graphics
  pads: Path2D;
  texts: { text: string; x: number; y: number; size: number; angle: number }[];
}

function polyPath(p: Path2D, pts: number[]): void {
  if (pts.length < 6) return;
  p.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
  p.closePath();
}

function linePath(p: Path2D, pts: number[]): void {
  p.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
}

function padPath(p: Path2D, pad: Pad): void {
  if (pad.r !== undefined) { p.moveTo(pad.x + pad.r, pad.y); p.arc(pad.x, pad.y, pad.r, 0, Math.PI * 2); }
  else for (const poly of pad.polys ?? []) polyPath(p, poly);
}

function pointInPoly(x: number, y: number, pts: number[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class BoardScene {
  model: BoardModel;
  layers = new Map<string, LayerPaths>();
  viaPath = new Path2D();
  holePath = new Path2D();
  private hlCache = new Map<string, { strokes: Map<number, Path2D>; fills: Path2D }>();

  constructor(model: BoardModel) {
    this.model = model;
    const L = (name: string): LayerPaths => {
      const k = canon(name);
      let l = this.layers.get(k);
      if (!l) { l = { zones: new Path2D(), strokes: new Map(), fills: new Path2D(), pads: new Path2D(), texts: [] }; this.layers.set(k, l); }
      return l;
    };
    const stroke = (lp: LayerPaths, w: number) => { const k = Math.round(Math.max(w, 0.01) * 1000) / 1000; let p = lp.strokes.get(k); if (!p) { p = new Path2D(); lp.strokes.set(k, p); } return p; };
    for (const z of model.zones) if (!z.keepout) for (const f of z.fills) polyPath(L(f.layer).zones, f.pts);
    for (const t of model.tracks) linePath(stroke(L(t.layer), t.w), t.pts ?? [t.x1, t.y1, t.x2, t.y2]);
    const shape = (s: import("../../shared/types").Shape) => {
      const lp = L(s.layer);
      if (s.kind === "text") { if (s.text) lp.texts.push({ text: s.text, x: s.x!, y: s.y!, size: s.size ?? 1, angle: s.angle ?? 0 }); return; }
      if (s.kind === "circle") {
        const c = new Path2D();
        c.moveTo(s.cx! + s.r!, s.cy!);
        c.arc(s.cx!, s.cy!, s.r!, 0, Math.PI * 2);
        if (s.fill) lp.fills.addPath(c);
        if (s.w > 0 || !s.fill) stroke(lp, s.w || 0.05).addPath(c);
        return;
      }
      if (!s.pts) return;
      if (s.kind === "poly") {
        if (s.fill) polyPath(lp.fills, s.pts);
        if (s.w > 0 || !s.fill) { const p = stroke(lp, s.w || 0.05); polyPath(p, s.pts); }
      } else linePath(stroke(lp, s.w || 0.05), s.pts);
    };
    for (const g of model.graphics) shape(g);
    for (const f of model.footprints) {
      for (const g of f.graphics) shape(g);
      for (const p of f.pads) {
        for (const l of p.layers) if (l.endsWith(".Cu")) padPath(L(l).pads, p);
        if (p.drill) { this.holePath.moveTo(p.x + p.drill / 2, p.y); this.holePath.arc(p.x, p.y, p.drill / 2, 0, Math.PI * 2); }
      }
    }
    for (const v of model.vias) {
      this.viaPath.moveTo(v.x + v.size / 2, v.y); this.viaPath.arc(v.x, v.y, v.size / 2, 0, Math.PI * 2);
      this.holePath.moveTo(v.x + v.drill / 2, v.y); this.holePath.arc(v.x, v.y, v.drill / 2, 0, Math.PI * 2);
    }
  }

  /** Paths for a set of nets/refs, built once per key. */
  highlightPaths(nets: Set<string>, refs: Set<string>) {
    const key = [...nets].sort().join("\u0001") + "\u0002" + [...refs].sort().join("\u0001");
    let h = this.hlCache.get(key);
    if (h) return h;
    const strokes = new Map<number, Path2D>();
    const fills = new Path2D();
    const st = (w: number) => { const k = Math.round(w * 1000) / 1000; let p = strokes.get(k); if (!p) { p = new Path2D(); strokes.set(k, p); } return p; };
    if (nets.size) {
      for (const t of this.model.tracks) if (nets.has(t.net)) linePath(st(t.w), t.pts ?? [t.x1, t.y1, t.x2, t.y2]);
      for (const v of this.model.vias) if (nets.has(v.net)) { fills.moveTo(v.x + v.size / 2, v.y); fills.arc(v.x, v.y, v.size / 2, 0, Math.PI * 2); }
      for (const z of this.model.zones) if (!z.keepout && nets.has(z.net)) for (const f of z.fills) polyPath(fills, f.pts);
    }
    for (const f of this.model.footprints) for (const p of f.pads) if (nets.has(p.net) || refs.has(f.ref)) padPath(fills, p);
    h = { strokes, fills };
    if (this.hlCache.size > 20) this.hlCache.clear();
    this.hlCache.set(key, h);
    return h;
  }

  footprint(ref: string): Footprint | undefined { return this.model.footprints.find((f) => f.ref === ref); }

  /** Item under a board point (mm). Prefers pads, then tracks/vias, then the smallest footprint box. */
  hit(x: number, y: number, side: "top" | "bottom", visible: Set<string>): BoardHit | null {
    const front = side === "top" ? "F" : "B";
    const fps = this.model.footprints.filter((f) => x >= f.bbox[0] && x <= f.bbox[2] && y >= f.bbox[1] && y <= f.bbox[3]);
    fps.sort((a, b) => Number(b.side === front) - Number(a.side === front) || (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]));
    for (const f of fps) {
      for (const p of f.pads) {
        if (!p.layers.some((l) => visible.has(canon(l)))) continue;
        const inside = p.r !== undefined ? Math.hypot(x - p.x, y - p.y) <= p.r : (p.polys ?? []).some((poly) => pointInPoly(x, y, poly));
        if (inside) return { ref: f.ref, pad: p.num, net: p.net || undefined, x, y };
      }
    }
    for (const v of this.model.vias) if (Math.hypot(x - v.x, y - v.y) <= v.size / 2) return { net: v.net, x, y };
    let best: { d: number; net: string } | null = null;
    for (const t of this.model.tracks) {
      if (!visible.has(t.layer)) continue;
      const p = t.pts ?? [t.x1, t.y1, t.x2, t.y2];
      for (let i = 2; i < p.length; i += 2) {
        const d = segDist(x, y, p[i - 2], p[i - 1], p[i], p[i + 1]);
        if (d <= t.w / 2 && (!best || d < best.d)) best = { d, net: t.net };
      }
    }
    if (best) return { net: best.net, x, y };
    if (fps[0]) return { ref: fps[0].ref, x, y };
    return null;
  }

  /** Draw order for a side: far copper first, near copper last, then near-side silk/fab. */
  order(side: "top" | "bottom"): string[] {
    const cu = [...this.model.copper];
    if (side === "top") cu.reverse();
    const far = side === "top" ? "B" : "F", near = side === "top" ? "F" : "B";
    return [
      `${far}.Fab`, `${far}.CrtYd`, `${far}.SilkS`, `${far}.Mask`, `${far}.Paste`,
      ...cu,
      `${near}.Mask`, `${near}.Paste`, `${near}.SilkS`, `${near}.Fab`, `${near}.CrtYd`,
      "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Margin", "Edge.Cuts",
    ];
  }
}

export function fitView(bbox: [number, number, number, number], w: number, h: number, margin = 0.92): BoardView {
  const bw = Math.max(bbox[2] - bbox[0], 1), bh = Math.max(bbox[3] - bbox[1], 1);
  return { cx: (bbox[0] + bbox[2]) / 2, cy: (bbox[1] + bbox[3]) / 2, scale: Math.min(w / bw, h / bh) * margin };
}

/** Screen ↔ board transform (bottom side is mirrored in x, as KiCad's flipped view). */
export function toBoard(v: BoardView, side: "top" | "bottom", w: number, h: number, sx: number, sy: number): [number, number] {
  const m = side === "bottom" ? -1 : 1;
  return [v.cx + (m * (sx - w / 2)) / v.scale, v.cy + (sy - h / 2) / v.scale];
}

export function toScreen(v: BoardView, side: "top" | "bottom", w: number, h: number, x: number, y: number): [number, number] {
  const m = side === "bottom" ? -1 : 1;
  return [w / 2 + m * (x - v.cx) * v.scale, h / 2 + (y - v.cy) * v.scale];
}

export function drawBoard(ctx: CanvasRenderingContext2D, scene: BoardScene, v: BoardView, w: number, h: number, o: DrawOptions, dpr = 1): void {
  const m = scene.model;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = o.dark ? "#0d1117" : "#f4f5f7";
  ctx.fillRect(0, 0, w, h);
  const mirror = o.side === "bottom" ? -1 : 1;
  const world = () => ctx.setTransform(dpr * v.scale * mirror, 0, 0, dpr * v.scale, dpr * (w / 2 - mirror * v.cx * v.scale), dpr * (h / 2 - v.cy * v.scale));
  world();
  const hl = o.highlightNets.size > 0 || o.highlightRefs.size > 0 || !!o.selectedNet || !!o.selectedRef;
  const minPx = 1 / v.scale; // hairline in mm
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Board body.
  ctx.fillStyle = o.dark ? "#16211a" : "#dfe7dc";
  const edge = scene.layers.get("Edge.Cuts");
  ctx.fillRect(m.bbox[0], m.bbox[1], m.bbox[2] - m.bbox[0], m.bbox[3] - m.bbox[1]);
  void edge;

  for (const name of scene.order(o.side)) {
    if (!o.visible.has(name)) continue;
    const lp = scene.layers.get(name);
    if (!lp) continue;
    const isCu = name.endsWith(".Cu");
    const color = layerColor(name, m.copper);
    ctx.globalAlpha = hl ? 0.22 : isCu ? 0.78 : 0.95;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (isCu) {
      // Planes: outer layers medium, inner layers faint (they would otherwise tint the whole board).
      const inner = name !== "F.Cu" && name !== "B.Cu";
      const near = name === (o.side === "top" ? "F.Cu" : "B.Cu");
      ctx.globalAlpha = (hl ? 0.12 : 1) * (inner ? 0.16 : near ? 0.42 : 0.28);
      ctx.fill(lp.zones, "nonzero");
      ctx.globalAlpha = hl ? 0.22 : inner ? 0.6 : 0.82;
    }
    for (const [wd, p] of lp.strokes) { ctx.lineWidth = Math.max(wd, minPx); ctx.stroke(p); }
    ctx.fill(lp.fills, "nonzero");
    if (isCu) ctx.fill(lp.pads, "nonzero");
    if (SILK(name) || /Fab$/.test(name)) {
      const px = v.scale;
      for (const t of lp.texts) {
        if (t.size * px < 5) continue;
        ctx.save();
        ctx.translate(t.x, t.y);
        ctx.scale(mirror, 1);
        ctx.rotate((-t.angle * Math.PI) / 180 * mirror);
        ctx.font = `${t.size}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(t.text, 0, 0);
        ctx.restore();
      }
    }
  }
  ctx.globalAlpha = hl ? 0.3 : 1;
  if (m.copper.some((c) => o.visible.has(c))) {
    ctx.fillStyle = "#c8b25a";
    ctx.fill(scene.viaPath, "nonzero");
    ctx.fillStyle = o.dark ? "#0d1117" : "#3b3f46";
    ctx.globalAlpha = 1;
    ctx.fill(scene.holePath, "nonzero");
  }

  // Highlights: nets and parts on top, full brightness with a light outline.
  if (hl) {
    const nets = new Set(o.highlightNets); if (o.selectedNet) nets.add(o.selectedNet);
    const refs = new Set(o.highlightRefs); if (o.selectedRef) refs.add(o.selectedRef);
    const h = scene.highlightPaths(nets, refs);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ffd25a";
    ctx.fillStyle = "#ffd25a";
    for (const [wd, p] of h.strokes) { ctx.lineWidth = Math.max(wd, 2 * minPx); ctx.stroke(p); }
    ctx.fill(h.fills, "nonzero");
    ctx.strokeStyle = o.dark ? "#ffffff" : "#000000";
    ctx.lineWidth = 1.2 * minPx;
    ctx.stroke(h.fills);
    for (const r of refs) {
      const f = scene.footprint(r);
      if (!f) continue;
      ctx.strokeStyle = r === o.selectedRef ? "#4fc3ff" : "#ffd25a";
      ctx.lineWidth = 2 * minPx;
      ctx.setLineDash([6 * minPx, 4 * minPx]);
      ctx.strokeRect(f.bbox[0], f.bbox[1], f.bbox[2] - f.bbox[0], f.bbox[3] - f.bbox[1]);
      ctx.setLineDash([]);
    }
  }

  // Overlays in screen space: check markers and user markers.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  (o.markers ?? []).forEach((mk, i) => {
    for (const it of mk.items) {
      if (it.x === undefined || it.y === undefined) continue;
      const [sx, sy] = toScreen(v, o.side, w, h, it.x, it.y);
      const active = o.activeMarker === i;
      ctx.strokeStyle = mk.severity === "error" ? "#ff4d4d" : "#ffb02e";
      ctx.lineWidth = active ? 3 : 2;
      const r = active ? 11 : 7;
      ctx.beginPath(); ctx.moveTo(sx - r, sy - r); ctx.lineTo(sx + r, sy + r); ctx.moveTo(sx + r, sy - r); ctx.lineTo(sx - r, sy + r); ctx.stroke();
      if (active) { ctx.beginPath(); ctx.arc(sx, sy, r + 6, 0, Math.PI * 2); ctx.stroke(); }
    }
  });
  for (const a of o.annotations ?? []) {
    if (a.view !== "board") continue;
    const [sx, sy] = toScreen(v, o.side, w, h, a.x, a.y);
    drawPin(ctx, sx, sy, a.n, a.status === "done", a.id === o.activeAnnotation);
  }
}

export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, done: boolean, active: boolean): void {
  ctx.save();
  ctx.fillStyle = done ? "#3fae6a" : active ? "#ff7a1a" : "#e8553a";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 7, y - 14);
  ctx.arc(x, y - 18, 9, Math.PI * 0.8, Math.PI * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(n), x, y - 18);
  ctx.restore();
}
