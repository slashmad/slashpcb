// .kicad_pcb → BoardModel (absolute geometry in board millimetres, y down).
// Supports KiCad 8/9 (numbered nets with a top-level net table) and KiCad 10 (net names inline).
import { readFileSync } from "node:fs";
import type { BoardModel, Footprint, LayerInfo, Pad, Shape, Stackup, Track, Via, Zone } from "../../shared/types";
import { arcPoints, at, child, children, head, isList, num, parseSexpr, pts, str, type SList } from "./sexpr";

type Xf = (x: number, y: number) => [number, number];

const rad = (d: number) => (d * Math.PI) / 180;

/** Local → absolute transform for a placement at (X, Y) rotated by `rot` degrees (KiCad: CCW on screen). */
function placement(X: number, Y: number, rot: number): Xf {
  const c = Math.cos(rad(rot)), s = Math.sin(rad(rot));
  return (x, y) => [X + x * c + y * s, Y - x * s + y * c];
}

function mapPts(p: number[], f: Xf): number[] {
  const out = new Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    const [x, y] = f(p[i], p[i + 1]);
    out[i] = x;
    out[i + 1] = y;
  }
  return out;
}

function strokeWidth(l: SList): number {
  const s = child(l, "stroke");
  return num(s, "width") ?? num(l, "width") ?? 0;
}

function isFilled(l: SList): boolean {
  const f = child(l, "fill");
  if (!f) return false;
  const v = f[1];
  if (v === "yes" || v === "solid") return true;
  const t = str(f, "type");
  return t === "solid" || t === "color";
}

function isHidden(l: SList): boolean {
  if (child(l, "hide")?.[1] === "yes" || l.includes("hide")) return true;
  const e = child(l, "effects");
  return !!e && (child(e, "hide")?.[1] === "yes" || e.includes("hide"));
}

/** Graphic item (gr_* / fp_*) → Shape, with an optional local→absolute transform. */
function shape(l: SList, f: Xf | null): Shape | null {
  const h = head(l)!;
  const kind = h.replace(/^(gr|fp)_/, "");
  const layer = str(l, "layer") ?? "";
  const w = strokeWidth(l);
  const tf = f ?? ((x: number, y: number) => [x, y] as [number, number]);
  const pt = (name: string): [number, number] => { const c = child(l, name); return [Number(c?.[1] ?? 0), Number(c?.[2] ?? 0)]; };
  switch (kind) {
    case "line": {
      const [a, b] = [tf(...pt("start")), tf(...pt("end"))];
      return { kind: "line", layer, w, pts: [a[0], a[1], b[0], b[1]] };
    }
    case "rect": {
      const [x0, y0] = pt("start"), [x1, y1] = pt("end");
      return { kind: "poly", layer, w, fill: isFilled(l), pts: mapPts([x0, y0, x1, y0, x1, y1, x0, y1], tf) };
    }
    case "circle": {
      const c = pt("center"), e = pt("end");
      const [cx, cy] = tf(c[0], c[1]);
      return { kind: "circle", layer, w, fill: isFilled(l), cx, cy, r: Math.hypot(e[0] - c[0], e[1] - c[1]) };
    }
    case "arc": {
      const s = pt("start"), m = child(l, "mid") ? pt("mid") : null, e = pt("end");
      if (!m) return { kind: "line", layer, w, pts: mapPts([...s, ...e], tf) };
      return { kind: "line", layer, w, pts: mapPts(arcPoints(s, m, e), tf) };
    }
    case "poly": {
      const p = pts(l);
      return p.length >= 6 ? { kind: "poly", layer, w, fill: isFilled(l) || !child(l, "fill"), pts: mapPts(p, tf) } : null;
    }
    case "curve": {
      const p = pts(l);
      if (p.length < 8) return null;
      const out: number[] = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16, u = 1 - t;
        const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        out.push(b[0] * p[0] + b[1] * p[2] + b[2] * p[4] + b[3] * p[6], b[0] * p[1] + b[1] * p[3] + b[2] * p[5] + b[3] * p[7]);
      }
      return { kind: "line", layer, w, pts: mapPts(out, tf) };
    }
    case "text": {
      if (isHidden(l)) return null;
      const [x, y, a] = at(l);
      const [ax, ay] = tf(x, y);
      const font = child(child(l, "effects"), "font");
      const size = num(font, "size") ?? 1;
      const j = child(child(l, "effects"), "justify");
      // fp_text: (fp_text reference "R1" ...) ; gr_text: (gr_text "TEXT" ...)
      const text = h === "fp_text" ? String(l[2] ?? "") : String(l[1] ?? "");
      return { kind: "text", layer, w, text, x: ax, y: ay, size, angle: a, mirror: !!j?.includes("mirror") };
    }
    default:
      return null;
  }
}

function expandLayers(names: string[], copper: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (n === "*.Cu") copper.forEach((c) => out.add(c));
    else if (n === "F&B.Cu") { out.add("F.Cu"); out.add("B.Cu"); }
    else if (n.startsWith("*.")) { out.add(`F.${n.slice(2)}`); out.add(`B.${n.slice(2)}`); }
    else out.add(n);
  }
  return [...out];
}

function rectPoly(w: number, h: number, r = 0, segs = 6): number[] {
  const hw = w / 2, hh = h / 2;
  if (r <= 1e-6) return [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
  r = Math.min(r, hw, hh);
  const out: number[] = [];
  const corners: [number, number, number][] = [[hw - r, -hh + r, -90], [hw - r, hh - r, 0], [-hw + r, hh - r, 90], [-hw + r, -hh + r, 180]];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= segs; k++) {
      const a = rad(a0 + (90 * k) / segs);
      out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
  }
  return out;
}

function ovalPoly(w: number, h: number): number[] {
  return rectPoly(w, h, Math.min(w, h) / 2, 10);
}

function pad(l: SList, fpX: Xf, copper: string[], netOf: (l: SList) => string): Pad {
  const numStr = String(l[1] ?? "");
  const type = String(l[2] ?? "smd");
  const shp = String(l[3] ?? "rect");
  const [lx, ly, rot] = at(l);
  const [x, y] = fpX(lx, ly);
  const size = child(l, "size");
  const w = Number(size?.[1] ?? 0), h = Number(size?.[2] ?? size?.[1] ?? 0);
  const layers = expandLayers((child(l, "layers") ?? []).slice(1).map(String), copper);
  const drillNode = child(l, "drill");
  let drill: number | undefined, drillMin: number | undefined;
  if (drillNode) {
    const nums = drillNode.slice(1).filter((v): v is number => typeof v === "number");
    if (nums.length) { drill = Math.max(...nums); drillMin = Math.min(...nums); }
  }
  const padX = placement(x, y, rot);
  const off = child(drillNode, "offset");
  const hole = off && (Number(off[1]) || Number(off[2])) ? padX(Number(off[1]) || 0, Number(off[2]) || 0) as [number, number] : undefined;
  const p: Pad = { num: numStr, type, shape: shp, x, y, rot, w, h, layers, net: netOf(l), drill, drillMin, pinFunction: str(l, "pinfunction"), maskMargin: num(l, "solder_mask_margin"), hole };
  if (shp === "circle") p.r = w / 2;
  else if (shp === "oval") p.polys = [mapPts(ovalPoly(w, h), padX)];
  else if (shp === "roundrect" || shp === "chamfered_rect") p.polys = [mapPts(rectPoly(w, h, (num(l, "roundrect_rratio") ?? 0.25) * Math.min(w, h)), padX)];
  else if (shp === "custom") {
    const polys: number[][] = [];
    const anchor = str(child(l, "options"), "anchor") ?? "rect";
    if (anchor === "circle") {
      const c: number[] = [];
      for (let k = 0; k < 24; k++) c.push((w / 2) * Math.cos((k / 24) * 2 * Math.PI), (w / 2) * Math.sin((k / 24) * 2 * Math.PI));
      polys.push(mapPts(c, padX));
    } else polys.push(mapPts(rectPoly(w, h), padX));
    for (const prim of (child(l, "primitives") ?? []).slice(1)) {
      if (!isList(prim)) continue;
      const s = shape(prim, padX);
      if (!s) continue;
      if (s.kind === "poly" && s.pts) polys.push(s.pts);
      else if (s.kind === "circle") {
        const c: number[] = [];
        for (let k = 0; k < 24; k++) c.push(s.cx! + s.r! * Math.cos((k / 24) * 2 * Math.PI), s.cy! + s.r! * Math.sin((k / 24) * 2 * Math.PI));
        polys.push(c);
      } else if (s.kind === "line" && s.pts && s.pts.length >= 4) {
        // Thick line primitive: approximate by a quad per segment.
        for (let i = 0; i + 3 < s.pts.length; i += 2) {
          const [ax, ay, bx, by] = [s.pts[i], s.pts[i + 1], s.pts[i + 2], s.pts[i + 3]];
          const len = Math.hypot(bx - ax, by - ay) || 1, nx = (-(by - ay) / len) * (s.w / 2), ny = ((bx - ax) / len) * (s.w / 2);
          polys.push([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]);
        }
      }
    }
    p.polys = polys;
  } else p.polys = [mapPts(rectPoly(w, h), padX)];
  return p;
}

function grow(b: [number, number, number, number], x: number, y: number, m = 0): void {
  if (x - m < b[0]) b[0] = x - m;
  if (y - m < b[1]) b[1] = y - m;
  if (x + m > b[2]) b[2] = x + m;
  if (y + m > b[3]) b[3] = y + m;
}

/** Extent of a shape; `stroke=false` uses the centre line (mechanical outlines: the cut follows the line centre). */
function growShape(b: [number, number, number, number], s: Shape, stroke = true): void {
  const half = stroke ? s.w / 2 : 0;
  if (s.kind === "circle") { grow(b, s.cx!, s.cy!, s.r! + half); return; }
  if (s.kind === "text") { grow(b, s.x!, s.y!, (s.size ?? 1) / 2); return; }
  const p = s.pts ?? [];
  for (let i = 0; i < p.length; i += 2) grow(b, p[i], p[i + 1], half);
}

/** KiCad escapes some characters in net names on the board ("{slash}" for "/"). */
export function unescapeKicad(s: string): string {
  if (!s.includes("{")) return s;
  return s.replace(/\{(slash|backslash|lt|gt|colon|dblquote|quote|tab|return|space|brace|lbrace|rbrace)\}/g, (_m, k: string) =>
    ({ slash: "/", backslash: "\\", lt: "<", gt: ">", colon: ":", dblquote: '"', quote: "'", tab: "\t", return: "\n", space: " ", brace: "{", lbrace: "{", rbrace: "}" } as Record<string, string>)[k]);
}

const EMPTY = (): [number, number, number, number] => [Infinity, Infinity, -Infinity, -Infinity];

export function parseBoard(file: string, text?: string): BoardModel {
  const t0 = Date.now();
  const src = text ?? readFileSync(file, "utf8");
  const root = parseSexpr(src)[0];
  if (!isList(root) || root[0] !== "kicad_pcb") throw new Error("not a KiCad board file");

  // Layers.
  const layers: LayerInfo[] = [];
  for (const l of (child(root, "layers") ?? []).slice(1)) {
    if (isList(l)) layers.push({ id: Number(l[0]), name: String(l[1]), type: String(l[2] ?? ""), user: l[3] !== undefined ? String(l[3]) : undefined });
  }
  const inner = layers.filter((l) => /^In\d+\.Cu$/.test(l.name)).map((l) => l.name).sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
  const copper = [
    ...(layers.some((l) => l.name === "F.Cu") ? ["F.Cu"] : []),
    ...inner,
    ...(layers.some((l) => l.name === "B.Cu") ? ["B.Cu"] : []),
  ];

  // Nets: KiCad ≤ 9 has (net N "name") at top level and (net N "name") / (net N) on items.
  const netTable = new Map<number, string>();
  for (const n of children(root, "net")) if (typeof n[1] === "number") netTable.set(n[1], String(n[2] ?? ""));
  const netOf = (l: SList): string => {
    const c = child(l, "net");
    if (!c) return "";
    if (typeof c[2] === "string") return unescapeKicad(c[2]);
    if (typeof c[1] === "string") return unescapeKicad(c[1]);
    if (typeof c[1] === "number") return unescapeKicad(netTable.get(c[1]) ?? str(l, "net_name") ?? "");
    return "";
  };

  const footprints: Footprint[] = [];
  const tracks: Track[] = [];
  const vias: Via[] = [];
  const zones: Zone[] = [];
  const graphics: Shape[] = [];
  const nets = new Set<string>();
  let padCount = 0;
  let trackLen = 0;

  for (let i = 1; i < root.length; i++) {
    const it = root[i];
    if (!isList(it)) continue;
    const h = it[0];
    if (h === "footprint" || h === "module") {
      const [X, Y, R] = at(it);
      const fx = placement(X, Y, R);
      const fields: Record<string, string> = {};
      for (const p of children(it, "property")) fields[String(p[1])] = String(p[2] ?? "");
      for (const t of children(it, "fp_text")) {
        if (t[1] === "reference" && !fields.Reference) fields.Reference = String(t[2] ?? "");
        if (t[1] === "value" && !fields.Value) fields.Value = String(t[2] ?? "");
      }
      const attr = child(it, "attr");
      const attrs = attr ? attr.slice(1).map(String) : [];
      if (child(it, "dnp") || it.includes("dnp")) attrs.push("dnp");
      const g: Shape[] = [];
      const bbox = EMPTY();
      const court = EMPTY();
      for (const c of it) {
        if (!isList(c)) continue;
        const ch = c[0];
        if (typeof ch === "string" && ch.startsWith("fp_")) {
          const s = shape(c, fx);
          if (s) {
            g.push(s);
            if (/CrtYd/.test(s.layer)) growShape(court, s);
            else if (/Fab|SilkS|Silkscreen|Cu/.test(s.layer) && s.kind !== "text") growShape(bbox, s);
          }
        } else if (ch === "property" && !isHidden(c) && child(c, "at") && /SilkS|Silkscreen|Fab/.test(str(c, "layer") ?? "")) {
          const [x, y, a] = at(c);
          const [ax, ay] = fx(x, y);
          const font = child(child(c, "effects"), "font");
          const val = String(c[2] ?? "");
          if (val) g.push({ kind: "text", layer: str(c, "layer")!, w: num(font, "thickness") ?? 0.1, text: val, x: ax, y: ay, size: num(font, "size") ?? 1, angle: a });
        }
      }
      // KiCad text variables in footprint texts: ${REFERENCE}, ${VALUE} and other field names.
      const vars: Record<string, string> = { REFERENCE: fields.Reference ?? "", VALUE: fields.Value ?? "" };
      for (const [k, v] of Object.entries(fields)) vars[k.toUpperCase()] = v;
      for (const s of g) if (s.kind === "text" && s.text?.includes("${")) s.text = s.text.replace(/\$\{([^}]+)\}/g, (m, k: string) => vars[k.toUpperCase()] ?? m);
      const pads: Pad[] = [];
      for (const p of children(it, "pad")) {
        const pd = pad(p, fx, copper, netOf);
        pads.push(pd);
        if (pd.net) nets.add(pd.net);
        if (pd.r !== undefined) grow(bbox, pd.x, pd.y, pd.r);
        for (const poly of pd.polys ?? []) for (let k = 0; k < poly.length; k += 2) grow(bbox, poly[k], poly[k + 1]);
      }
      padCount += pads.length;
      const layer = str(it, "layer") ?? "F.Cu";
      const box = Number.isFinite(court[0]) ? court : Number.isFinite(bbox[0]) ? bbox : ([X - 0.5, Y - 0.5, X + 0.5, Y + 0.5] as [number, number, number, number]);
      footprints.push({
        ref: fields.Reference ?? "", value: fields.Value ?? "", lib: String(it[1] ?? ""),
        side: layer.startsWith("B.") ? "B" : "F", x: X, y: Y, rot: R, fields, attrs, bbox: box, pads, graphics: g, maskMargin: num(it, "solder_mask_margin"),
        uuid: str(it, "uuid") ?? str(it, "tstamp") ?? "", path: str(it, "path") ?? "",
      });
    } else if (h === "segment") {
      const s = child(it, "start"), e = child(it, "end");
      const tr: Track = { x1: Number(s?.[1]), y1: Number(s?.[2]), x2: Number(e?.[1]), y2: Number(e?.[2]), w: num(it, "width") ?? 0.2, layer: str(it, "layer") ?? "", net: netOf(it) };
      trackLen += Math.hypot(tr.x2 - tr.x1, tr.y2 - tr.y1);
      tracks.push(tr);
      if (tr.net) nets.add(tr.net);
    } else if (h === "arc") {
      const s = child(it, "start"), m = child(it, "mid"), e = child(it, "end");
      const p = arcPoints([Number(s?.[1]), Number(s?.[2])], [Number(m?.[1]), Number(m?.[2])], [Number(e?.[1]), Number(e?.[2])], 0.1);
      for (let k = 2; k < p.length; k += 2) trackLen += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
      const tr: Track = { x1: p[0], y1: p[1], x2: p[p.length - 2], y2: p[p.length - 1], w: num(it, "width") ?? 0.2, layer: str(it, "layer") ?? "", net: netOf(it), pts: p };
      tracks.push(tr);
      if (tr.net) nets.add(tr.net);
    } else if (h === "via") {
      const [x, y] = at(it);
      const ls = (child(it, "layers") ?? []).slice(1).map(String);
      const tent = child(it, "tenting");
      const v: Via = {
        x, y, size: num(it, "size") ?? 0.6, drill: num(it, "drill") ?? 0.3, layers: [ls[0] ?? "F.Cu", ls[1] ?? "B.Cu"], net: netOf(it), type: typeof it[1] === "string" ? it[1] : undefined,
        tenting: tent ? { front: str(tent, "front") ?? "none", back: str(tent, "back") ?? "none" } : undefined,
      };
      vias.push(v);
      if (v.net) nets.add(v.net);
    } else if (h === "zone") {
      const ls = child(it, "layers") ? child(it, "layers")!.slice(1).map(String) : [str(it, "layer") ?? ""];
      const z: Zone = {
        net: netOf(it) || str(it, "net_name") || "", name: str(it, "name"), layers: expandLayers(ls, copper),
        outline: pts(child(it, "polygon")), fills: [], keepout: !!child(it, "keepout"), priority: num(it, "priority"),
      };
      for (const fp of children(it, "filled_polygon")) z.fills.push({ layer: str(fp, "layer") ?? z.layers[0] ?? "", pts: pts(fp) });
      zones.push(z);
      if (z.net) nets.add(z.net);
    } else if (typeof h === "string" && h.startsWith("gr_")) {
      const s = shape(it, null);
      if (s) {
        if (s.layer.endsWith(".Cu") && child(it, "net")) s.net = netOf(it);
        graphics.push(s);
      }
    }
  }

  // Board extent: Edge.Cuts when present, otherwise everything.
  const bbox = EMPTY();
  for (const g of graphics) if (g.layer === "Edge.Cuts" && g.kind !== "text") growShape(bbox, g, false);
  if (!Number.isFinite(bbox[0])) {
    for (const f of footprints) { grow(bbox, f.bbox[0], f.bbox[1]); grow(bbox, f.bbox[2], f.bbox[3]); }
    for (const t of tracks) { grow(bbox, t.x1, t.y1); grow(bbox, t.x2, t.y2); }
    for (const g of graphics) growShape(bbox, g);
  }
  if (!Number.isFinite(bbox[0])) bbox.splice(0, 4, 0, 0, 100, 80);

  // Stackup (setup › stackup): layer materials and thicknesses, mask/silk colours, surface finish.
  const setup = child(root, "setup");
  const su = child(setup, "stackup");
  let stackup: Stackup | undefined;
  if (su) {
    stackup = { layers: [], finish: str(su, "copper_finish") };
    for (const l of children(su, "layer")) {
      const name = String(l[1] ?? ""), type = str(l, "type") ?? "";
      const e: Stackup["layers"][number] = { name, type, thickness: num(l, "thickness"), material: str(l, "material"), color: str(l, "color"), epsilonR: num(l, "epsilon_r") };
      stackup.layers.push(e);
      if (name === "F.Mask") stackup.maskColorTop = e.color;
      if (name === "B.Mask") stackup.maskColorBottom = e.color;
      if (name === "F.SilkS") stackup.silkColorTop = e.color;
      if (name === "B.SilkS") stackup.silkColorBottom = e.color;
    }
  }
  const tentDefault = child(setup, "tenting");
  if (tentDefault) (stackup ??= { layers: [] }).tentingDefault = { front: str(tentDefault, "front") ?? "no", back: str(tentDefault, "back") ?? "no" };

  const mask = { padToMask: num(setup, "pad_to_mask_clearance") ?? 0, minWidth: num(setup, "solder_mask_min_width") ?? 0, bridgesInFootprints: str(setup, "allow_soldermask_bridges_in_footprints") === "yes" };

  const tb = child(root, "title_block");
  return {
    file, version: num(root, "version") ?? 0, generator: str(root, "generator") ?? "",
    title: str(tb, "title"), rev: str(tb, "rev"), date: str(tb, "date"),
    thickness: num(child(root, "general"), "thickness"), stackup, mask,
    layers, copper, bbox, footprints, tracks, vias, zones, graphics,
    nets: [...nets].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    stats: { footprints: footprints.length, pads: padCount, tracks: tracks.length, vias: vias.length, zones: zones.length, nets: nets.size, trackLengthMm: Math.round(trackLen * 10) / 10 },
    parseMs: Date.now() - t0,
  };
}
