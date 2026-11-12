// Board analyses beyond DRC: vias at paste openings, layout metrics (for before/after comparison),
// decoupling distance, test-pad probe access, duplicate UUIDs. Geometry is the parsed board; paste
// openings are approximated by the pad copper (paste margins are not applied).
import type { BoardModel, Footprint, Pad, Via } from "../../shared/types";

const GND = /(^|\/)(A|D|P|S)?GND|VSS|0V/i;

function pointInPoly(x: number, y: number, pts: number[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
/** Distance from a point to the pad copper (0 inside). */
export function padDistance(p: Pad, x: number, y: number): number {
  if (p.r !== undefined) return Math.max(0, Math.hypot(x - p.x, y - p.y) - p.r);
  let best = Infinity;
  for (const poly of p.polys ?? []) {
    if (pointInPoly(x, y, poly)) return 0;
    for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) best = Math.min(best, segDist(x, y, poly[j], poly[j + 1], poly[i], poly[i + 1]));
  }
  return best;
}

const viaOn = (v: Via, side: "F" | "B") => (side === "F" ? v.layers[0] === "F.Cu" || v.layers[1] === "F.Cu" : v.layers[0] === "B.Cu" || v.layers[1] === "B.Cu") || !v.type;
function tented(v: Via, side: "F" | "B", def?: { front: string; back: string }): boolean {
  const t = side === "F" ? v.tenting?.front : v.tenting?.back;
  const d = side === "F" ? def?.front : def?.back;
  return (t && t !== "none" ? t : d) === "yes";
}

export interface ViaPasteIssue { ref: string; pad: string; padNet: string; viaNet: string; x: number; y: number; side: "F" | "B"; kind: "hole-in-pad" | "ring-overlap" | "ring-near"; gap: number; sameNet: boolean; tented: boolean }

/** Vias whose hole or ring reaches a pad that gets solder paste (solder wicking, bridges, voids). */
export function viasAtPaste(b: BoardModel, nearMm = 0.1): ViaPasteIssue[] {
  const out: ViaPasteIssue[] = [];
  const def = b.stackup?.tentingDefault;
  const pasted: { f: Footprint; p: Pad; side: "F" | "B"; reach: number }[] = [];
  for (const f of b.footprints) for (const p of f.pads) {
    for (const side of ["F", "B"] as const) {
      if (!p.layers.includes(`${side}.Paste`) || !p.layers.includes(`${side}.Cu`)) continue;
      pasted.push({ f, p, side, reach: Math.max(p.w, p.h) / 2 + 1 });
    }
  }
  for (const v of b.vias) {
    for (const s of pasted) {
      if (!viaOn(v, s.side) || Math.abs(v.x - s.p.x) > s.reach + v.size || Math.abs(v.y - s.p.y) > s.reach + v.size) continue;
      const d = padDistance(s.p, v.x, v.y); // centre to pad copper
      const holeGap = d - v.drill / 2, ringGap = d - v.size / 2;
      let kind: ViaPasteIssue["kind"] | null = null;
      if (holeGap <= 0) kind = "hole-in-pad";
      else if (ringGap <= 0) kind = "ring-overlap";
      else if (ringGap < nearMm) kind = "ring-near";
      if (!kind) continue;
      out.push({ ref: s.f.ref, pad: s.p.num, padNet: s.p.net, viaNet: v.net, x: v.x, y: v.y, side: s.side, kind, gap: +(kind === "ring-overlap" ? holeGap : kind === "ring-near" ? ringGap : 0).toFixed(4), sameNet: s.p.net === v.net, tented: tented(v, s.side, def) });
    }
  }
  const rank = { "hole-in-pad": 0, "ring-overlap": 1, "ring-near": 2 };
  return out.sort((a, c) => rank[a.kind] - rank[c.kind] || a.ref.localeCompare(c.ref, undefined, { numeric: true }));
}

// ---------------------------------------------------------------- layout metrics

export interface LayoutMetrics {
  layers: { layer: string; tracks: number; lengthMm: number }[];
  segments: number; arcs: number; shortSegments: number; offAngle: number; directionChanges: number;
  vias: number; groundVias: number; signalVias: number;
  viasPerNet: { net: string; vias: number }[];
  detour: { net: string; ratio: number; lengthMm: number; directMm: number }[];
  diffPairs: { p: string; n: string; lenP: number; lenN: number; delta: number }[];
  islands: { layer: string; net: string; pieces: number }[];
  totalLengthMm: number;
}

const r1 = (v: number) => Math.round(v * 1000) / 1000;

export function layoutMetrics(b: BoardModel): LayoutMetrics {
  const perLayer = new Map<string, { tracks: number; len: number }>();
  const netLen = new Map<string, number>();
  let segments = 0, arcs = 0, short = 0, off = 0, total = 0;
  const ends = new Map<string, { dx: number; dy: number }[]>(); // net|layer|x|y → directions leaving the point
  const key = (net: string, layer: string, x: number, y: number) => `${net}|${layer}|${Math.round(x * 1000)}|${Math.round(y * 1000)}`;
  for (const t of b.tracks) {
    const p = t.pts ?? [t.x1, t.y1, t.x2, t.y2];
    let len = 0;
    for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (t.pts) arcs++; else {
      segments++;
      if (len < 0.1) short++;
      const ang = (Math.atan2(t.y2 - t.y1, t.x2 - t.x1) * 180) / Math.PI;
      const m = ((ang % 45) + 45) % 45;
      if (len >= 0.1 && m > 0.5 && m < 44.5) off++;
      const push = (k: string, dx: number, dy: number) => { const l = Math.hypot(dx, dy) || 1; (ends.get(k) ?? ends.set(k, []).get(k)!).push({ dx: dx / l, dy: dy / l }); };
      push(key(t.net, t.layer, t.x1, t.y1), t.x2 - t.x1, t.y2 - t.y1);
      push(key(t.net, t.layer, t.x2, t.y2), t.x1 - t.x2, t.y1 - t.y2);
    }
    const L = perLayer.get(t.layer) ?? { tracks: 0, len: 0 };
    L.tracks++; L.len += len;
    perLayer.set(t.layer, L);
    netLen.set(t.net, (netLen.get(t.net) ?? 0) + len);
    total += len;
  }
  // A joint of exactly two segments that is not straight counts as one direction change.
  let changes = 0;
  for (const dirs of ends.values()) {
    if (dirs.length !== 2) continue;
    const dot = dirs[0].dx * dirs[1].dx + dirs[0].dy * dirs[1].dy; // straight-through = -1
    if (dot > -0.9998) changes++;
  }
  const viaNet = new Map<string, number>();
  let gv = 0;
  for (const v of b.vias) { viaNet.set(v.net, (viaNet.get(v.net) ?? 0) + 1); if (GND.test(v.net)) gv++; }
  // Detour for two-pad nets: routed length versus straight distance between the pads.
  const padsByNet = new Map<string, Pad[]>();
  for (const f of b.footprints) for (const p of f.pads) if (p.net && !/^unconnected-/i.test(p.net)) (padsByNet.get(p.net) ?? padsByNet.set(p.net, []).get(p.net)!).push(p);
  const detour: LayoutMetrics["detour"] = [];
  for (const [net, pads] of padsByNet) {
    if (pads.length !== 2) continue;
    const len = netLen.get(net) ?? 0, direct = Math.hypot(pads[0].x - pads[1].x, pads[0].y - pads[1].y);
    if (len > 0 && direct > 0.5) detour.push({ net, ratio: +(len / direct).toFixed(2), lengthMm: r1(len), directMm: r1(direct) });
  }
  detour.sort((a, c) => c.ratio - a.ratio);
  // Differential pairs by name: X_P/X_N, X+/X-, XDP/XDM(N), X_PLUS/X_MINUS (also inside the name, e.g. USB_D_PLUS_ISO).
  const pairs: LayoutMetrics["diffPairs"] = [];
  const nets = [...netLen.keys()];
  const partner = (n: string): string[] => {
    const out: string[] = [];
    const swaps: [RegExp, string][] = [[/PLUS/i, "MINUS"], [/_P(?=$|_)/, "_N"], [/\+(?=$|_|\))/, "-"], [/DP(?=$|_)/, "DM"], [/DP(?=$|_)/, "DN"], [/P$/, "N"]];
    for (const [re, rep] of swaps) if (re.test(n)) out.push(n.replace(re, rep));
    return out;
  };
  for (const n of nets) {
    const cand = partner(n).find((x) => x !== n && netLen.has(x));
    if (!cand || pairs.some((q) => q.n === n || q.p === cand || q.n === cand)) continue;
    const lp = netLen.get(n)!, ln = netLen.get(cand)!;
    pairs.push({ p: n, n: cand, lenP: r1(lp), lenN: r1(ln), delta: r1(Math.abs(lp - ln)) });
  }
  const islands: LayoutMetrics["islands"] = [];
  for (const z of b.zones) {
    if (z.keepout) continue;
    const per = new Map<string, number>();
    for (const f of z.fills) per.set(f.layer, (per.get(f.layer) ?? 0) + 1);
    for (const [layer, pieces] of per) if (pieces > 1) islands.push({ layer, net: z.net, pieces });
  }
  return {
    layers: [...perLayer].map(([layer, v]) => ({ layer, tracks: v.tracks, lengthMm: r1(v.len) })).sort((a, c) => b.copper.indexOf(a.layer) - b.copper.indexOf(c.layer)),
    segments, arcs, shortSegments: short, offAngle: off, directionChanges: changes,
    vias: b.vias.length, groundVias: gv, signalVias: b.vias.length - gv,
    viasPerNet: [...viaNet].filter(([n]) => !GND.test(n)).map(([net, vias]) => ({ net, vias })).sort((a, c) => c.vias - a.vias).slice(0, 15),
    detour: detour.slice(0, 15), diffPairs: pairs, islands, totalLengthMm: r1(total),
  };
}

export function metricsText(m: LayoutMetrics, old?: LayoutMetrics): string {
  const d = (k: keyof LayoutMetrics) => (old ? ` (was ${old[k] as number})` : "");
  const L = [
    `Layout: ${m.totalLengthMm}${old ? ` (was ${old.totalLengthMm})` : ""} mm of track in ${m.segments} segments${d("segments")} and ${m.arcs} arcs; ${m.vias} vias${d("vias")} (${m.groundVias} on ground nets, ${m.signalVias} signal${d("signalVias")}).`,
    `Per layer: ${m.layers.map((l) => `${l.layer} ${l.lengthMm} mm/${l.tracks}`).join(", ")}.`,
    `Short segments (<0.1 mm): ${m.shortSegments}${d("shortSegments")}; off-45° segments: ${m.offAngle}${d("offAngle")}; direction changes: ${m.directionChanges}${d("directionChanges")}.`,
  ];
  if (m.viasPerNet.length) L.push(`Signal nets with most vias: ${m.viasPerNet.slice(0, 8).map((v) => `${v.net} ${v.vias}`).join(", ")}.`);
  if (m.detour.length) L.push(`Largest detours (routed/straight, two-pad nets): ${m.detour.slice(0, 8).map((x) => `${x.net} ×${x.ratio} (${x.lengthMm}/${x.directMm} mm)`).join(", ")}.`);
  if (m.diffPairs.length) L.push(`Differential pairs (total routed length per net, branches included): ${m.diffPairs.map((p) => `${p.p}/${p.n} ${p.lenP}/${p.lenN} mm, Δ ${p.delta}`).join("; ")}.`);
  if (m.islands.length) L.push(`Zone fills split into islands: ${m.islands.map((i) => `${i.net} on ${i.layer}: ${i.pieces}`).join(", ")}.`);
  L.push("These are review measures (gate B), not pass/fail rules: compare candidates and explain trade-offs.");
  return L.join("\n");
}

// ---------------------------------------------------------------- decoupling and test access

const SUPPLY_NET = /^\+?\d+V\d*|V(CC|DD|IN|BUS|BAT|SYS|REG|OUT)|^\+|3V\d|5V|1V\d|AVDD|DVDD|VREF/i;

export interface DecouplingHint { ic: string; pin: string; net: string; cap: string | null; distanceMm: number | null }

/** For each IC power pin: the nearest capacitor on the same net whose other pad is on ground. */
export function decoupling(b: BoardModel, schPinNames?: Map<string, Map<string, string>>): DecouplingHint[] {
  const caps = b.footprints.filter((f) => /^C\d/i.test(f.ref) && f.pads.length === 2 && f.pads.some((p) => GND.test(p.net)));
  const out: DecouplingHint[] = [];
  for (const f of b.footprints) {
    if (!/^(U|IC)\d/i.test(f.ref)) continue;
    const seen = new Set<string>();
    for (const p of f.pads) {
      if (!p.net || GND.test(p.net) || seen.has(p.net)) continue;
      const name = p.pinFunction ?? schPinNames?.get(f.ref)?.get(p.num) ?? "";
      if (!SUPPLY_NET.test(p.net) && !/^(VCC|VDD|VIN|VBAT|VSYS|AVDD|DVDD|PVIN|VS)/i.test(name)) continue;
      seen.add(p.net);
      let best: { cap: string; d: number } | null = null;
      for (const c of caps) for (const cp of c.pads) {
        if (cp.net !== p.net) continue;
        const d = Math.hypot(cp.x - p.x, cp.y - p.y);
        if (!best || d < best.d) best = { cap: c.ref, d };
      }
      out.push({ ic: f.ref, pin: p.num, net: p.net, cap: best?.cap ?? null, distanceMm: best ? r1(best.d) : null });
    }
  }
  return out.sort((a, c) => (c.distanceMm ?? 1e9) - (a.distanceMm ?? 1e9));
}

export interface TestPadHint { ref: string; net: string; side: "F" | "B"; paste: boolean; clearanceMm: number; blocker?: string }

/** Test pads: no paste, and room for a probe (radius `probe` mm) before another part's body on that side. */
export function testAccess(b: BoardModel, probe = 0.25): TestPadHint[] {
  const tps = b.footprints.filter((f) => /^TP\d/i.test(f.ref) || /testpoint|test_point/i.test(f.lib));
  const out: TestPadHint[] = [];
  for (const f of tps) {
    const p = f.pads[0];
    if (!p) continue;
    let clear = Infinity, blocker: string | undefined;
    for (const o of b.footprints) {
      if (o === f || o.side !== f.side || /^(TP|SW|LOGO|H|MH|FID)\d/i.test(o.ref)) continue;
      const [x0, y0, x1, y1] = o.bbox;
      const dx = Math.max(x0 - p.x, 0, p.x - x1), dy = Math.max(y0 - p.y, 0, p.y - y1);
      const d = Math.hypot(dx, dy) - probe;
      if (d < clear) { clear = d; blocker = o.ref; }
    }
    out.push({ ref: f.ref, net: p.net, side: f.side, paste: p.layers.some((l) => /Paste$/.test(l)), clearanceMm: Number.isFinite(clear) ? r1(clear) : 99, blocker });
  }
  return out.sort((a, c) => a.clearanceMm - c.clearanceMm);
}

/** Duplicate UUIDs in a KiCad file (scripted edits and copy-paste can produce them). */
export function duplicateUuids(text: string): string[] {
  const seen = new Map<string, number>();
  for (const m of text.matchAll(/\((?:uuid|tstamp) "?([0-9a-fA-F-]{8,})"?\)/g)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([u]) => u);
}

export function hintsText(v: ViaPasteIssue[], dc: DecouplingHint[], tp: TestPadHint[], dupPcb: string[], dupSch: string[], farMm = 5): string {
  const L: string[] = [];
  const hard = v.filter((i) => i.kind !== "ring-near");
  L.push(`Vias at paste openings: ${hard.length} overlap(s) (${v.filter((i) => i.kind === "hole-in-pad").length} hole in pad), ${v.length - hard.length} within 0.1 mm.`);
  for (const i of v.slice(0, 25)) L.push(`  ${i.kind} ${i.ref}.${i.pad} (${i.padNet}) via ${i.viaNet} at (${i.x}, ${i.y}) ${i.side === "B" ? "bottom" : "top"}, gap ${i.gap} mm, ${i.sameNet ? "same net" : "OTHER NET"}, ${i.tented ? "tented" : "open"}`);
  const far = dc.filter((d) => d.distanceMm === null || d.distanceMm > farMm);
  L.push(`Decoupling: ${dc.length} IC supply pins; ${far.length} without a capacitor within ${farMm} mm${far.length ? `: ${far.slice(0, 12).map((d) => `${d.ic}.${d.pin} ${d.net} ${d.cap ? `${d.cap} at ${d.distanceMm} mm` : "no capacitor on the net"}`).join("; ")}` : ""}. Modules with internal decoupling can be fine; check datasheets.`);
  if (tp.length) L.push(`Test pads: ${tp.length}; with paste ${tp.filter((t) => t.paste).length}; probe (Ø0.5 mm) blocked by a neighbour ${tp.filter((t) => t.clearanceMm < 0).length}; tightest ${tp.slice(0, 3).map((t) => `${t.ref} ${t.clearanceMm} mm (${t.blocker})`).join(", ")}.`);
  else L.push("Test pads: none found (refs TP*, TestPoint footprints).");
  L.push(`Duplicate UUIDs: board ${dupPcb.length}, schematic ${dupSch.length}.`);
  return L.join("\n");
}

// ---------------------------------------------------------------- solder-mask webs

/** A pad's copper outlines, one closed polygon each (circles sampled with 32 points: error ≤ 0.5 % of r). */
function outline(p: Pad): number[][] {
  if (p.r !== undefined) {
    const o: number[] = [];
    for (let k = 0; k < 32; k++) o.push(p.x + p.r * Math.cos((k / 32) * 2 * Math.PI), p.y + p.r * Math.sin((k / 32) * 2 * Math.PI));
    return [o];
  }
  return (p.polys ?? []).filter((q) => q.length >= 6);
}
function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy), o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}
/**
 * Copper-to-copper distance of two pads (0 when they touch, overlap or cross). Edges that cross are
 * detected explicitly; otherwise the minimum is the distance of a vertex of one outline to the other
 * outline, which is exact for polygons (and for sampled circles within the sampling error).
 */
export function padGap(a: Pad, b: Pad, oa = outline(a), ob = outline(b)): number {
  for (const pa of oa) for (const pb of ob) {
    for (let i = 0, j = pa.length - 2; i < pa.length; j = i, i += 2)
      for (let k = 0, l = pb.length - 2; k < pb.length; l = k, k += 2)
        if (segsCross(pa[j], pa[j + 1], pa[i], pa[i + 1], pb[l], pb[l + 1], pb[k], pb[k + 1])) return 0;
  }
  let d = Infinity;
  for (const pa of oa) for (let i = 0; i < pa.length && d > 0; i += 2) d = Math.min(d, padDistance(b, pa[i], pa[i + 1]));
  for (const pb of ob) for (let i = 0; i < pb.length && d > 0; i += 2) d = Math.min(d, padDistance(a, pb[i], pb[i + 1]));
  return d;
}

export interface MaskWeb {
  a: string; b: string; refs: string[]; netA: string; netB: string; side: "F" | "B";
  web: number; // mask between the two openings (≤ 0: the openings merge)
  kind: "merged" | "thin";
  sameNet: boolean; sameFootprint: boolean;
  allowed: boolean; // KiCad allows a bridge here (same footprint and bridges allowed)
  via: boolean; // one side is an open via
}
export interface MaskReport {
  minWeb: number; // threshold used
  thresholdSource: string;
  webs: MaskWeb[]; // pairs below the threshold
  narrowest?: { a: string; b: string; web: number }; // narrowest web between pads on different nets (any width)
  maskDefined: { ref: string; pads: number; margin: number }[]; // negative expansion: the mask defines the land
  openings: number; openVias: number; viasOpenAssumed: boolean;
  bridgesInFootprints: boolean; padToMask: number; boardMinWidth: number;
}

/**
 * Solder-mask webs (dams) between neighbouring pad openings on the same side. An opening is the pad copper
 * grown by its mask expansion (pad › footprint › board pad_to_mask_clearance; negative = mask-defined land).
 * Webs narrower than the supplier's minimum are usually removed in CAM (ganged opening), so the pads are
 * then no longer separated by mask: a solder-bridge risk on fine pitch.
 */
export function maskWebs(b: BoardModel, minWeb?: number, source?: string, opts: { viasOpen?: boolean } = {}): MaskReport {
  const setup = b.mask ?? { padToMask: 0, minWidth: 0, bridgesInFootprints: false };
  const thr = minWeb ?? 0.1;
  type Op = { f: Footprint | null; p: Pad; label: string; side: "F" | "B"; m: number; o: number[][]; box: [number, number, number, number] };
  const ops: Op[] = [];
  const md = new Map<string, { pads: number; margin: number }>();
  const push = (f: Footprint | null, p: Pad, label: string, side: "F" | "B", m: number) => {
    const o = outline(p);
    if (!o.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of o) for (let i = 0; i < q.length; i += 2) { x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]); y0 = Math.min(y0, q[i + 1]); y1 = Math.max(y1, q[i + 1]); }
    ops.push({ f, p, label, side, m, o, box: [x0 - m, y0 - m, x1 + m, y1 + m] });
  };
  for (const f of b.footprints) for (const p of f.pads) {
    const m = p.maskMargin ?? f.maskMargin ?? setup.padToMask;
    for (const side of ["F", "B"] as const) {
      if (!p.layers.includes(`${side}.Mask`)) continue;
      push(f, p, `${f.ref || "?"}.${p.num || "?"}`, side, m);
      if (m < 0 && p.layers.includes(`${side}.Cu`)) { const e = md.get(f.ref) ?? { pads: 0, margin: m }; e.pads++; e.margin = Math.min(e.margin, m); md.set(f.ref, e); }
    }
  }
  // Untented vias are mask openings too (all of them when the supplier does not tent).
  const def = b.stackup?.tentingDefault;
  let openVias = 0;
  for (const v of b.vias) for (const side of ["F", "B"] as const) {
    if (!viaOn(v, side) || (!opts.viasOpen && tented(v, side, def))) continue;
    openVias++;
    push(null, { num: "", type: "via", shape: "circle", x: v.x, y: v.y, rot: 0, w: v.size, h: v.size, r: v.size / 2, layers: [], net: v.net }, `via (${+v.x.toFixed(3)}, ${+v.y.toFixed(3)})`, side, setup.padToMask);
  }
  // Spatial grid so only nearby openings are compared.
  const cell = 2, reach = Math.max(thr, 0.3);
  const grid = new Map<string, number[]>();
  ops.forEach((op, i) => {
    for (let gx = Math.floor((op.box[0] - reach) / cell); gx <= Math.floor((op.box[2] + reach) / cell); gx++)
      for (let gy = Math.floor((op.box[1] - reach) / cell); gy <= Math.floor((op.box[3] + reach) / cell); gy++) {
        const k = `${op.side}${gx},${gy}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
      }
  });
  const webs: MaskWeb[] = [];
  const done = new Set<number>();
  let narrowest: MaskReport["narrowest"];
  for (const list of grid.values()) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const i = Math.min(list[x], list[y]), j = Math.max(list[x], list[y]);
      const key = i * ops.length + j;
      if (done.has(key)) continue;
      done.add(key);
      const A = ops[i], B = ops[j];
      if (A.p === B.p || (!A.f && !B.f)) continue; // via-to-via webs are not reported
      if (A.box[0] - B.box[2] > reach || B.box[0] - A.box[2] > reach || A.box[1] - B.box[3] > reach || B.box[1] - A.box[3] > reach) continue;
      const gap = padGap(A.p, B.p, A.o, B.o);
      if (gap === 0 && A.f && A.f === B.f && A.p.num === B.p.num) continue; // one pad drawn as several overlapping pads
      const web = +(gap - A.m - B.m).toFixed(4);
      const sameNet = !!A.p.net && A.p.net === B.p.net;
      if (!sameNet && (!narrowest || web < narrowest.web)) narrowest = { a: A.label, b: B.label, web };
      if (web >= thr) continue;
      const sameFootprint = !!A.f && A.f === B.f;
      const allowed = sameFootprint && (setup.bridgesInFootprints || A.f!.attrs.includes("allow_soldermask_bridges"));
      webs.push({ a: A.label, b: B.label, refs: [A.f?.ref, B.f?.ref].filter((r): r is string => !!r), netA: A.p.net, netB: B.p.net, side: A.side, web, kind: web <= 0 ? "merged" : "thin", sameNet, sameFootprint, allowed, via: !A.f || !B.f });
    }
  }
  webs.sort((p, q) => Number(p.sameNet) - Number(q.sameNet) || Number(p.allowed) - Number(q.allowed) || p.web - q.web);
  return {
    minWeb: thr, thresholdSource: source ?? (minWeb === undefined ? "assumed 0.1 mm (typical; enter the supplier's value)" : "supplier limit"),
    webs, narrowest, openings: ops.length, openVias, viasOpenAssumed: !!opts.viasOpen,
    maskDefined: [...md].map(([ref, v]) => ({ ref, ...v })).sort((p, q) => p.ref.localeCompare(q.ref, undefined, { numeric: true })),
    bridgesInFootprints: setup.bridgesInFootprints, padToMask: setup.padToMask, boardMinWidth: setup.minWidth,
  };
}

export function maskText(r: MaskReport): string {
  const risky = r.webs.filter((w) => !w.sameNet && !w.allowed);
  const L = [
    `Solder-mask webs: ${r.openings} openings (${r.openVias} open via sides${r.viasOpenAssumed ? ", all vias open because the supplier does not tent" : ""}); threshold ${r.minWeb} mm (${r.thresholdSource}). ${risky.length} pair(s) on different nets below it (${risky.filter((w) => w.kind === "merged").length} with merged openings), ${r.webs.filter((w) => w.allowed && !w.sameNet).length} inside footprints where KiCad allows bridges, ${r.webs.filter((w) => w.sameNet).length} on the same net.`,
    `Board setup: pad_to_mask_clearance ${r.padToMask} mm, solder_mask_min_width ${r.boardMinWidth} mm, bridges in footprints ${r.bridgesInFootprints ? "allowed" : "not allowed"}.`,
  ];
  if (r.narrowest) L.push(`Narrowest web between different nets: ${r.narrowest.web} mm (${r.narrowest.a} / ${r.narrowest.b}).`);
  for (const w of r.webs.filter((x) => !x.sameNet).slice(0, 30)) L.push(`  ${w.kind} ${w.a} (${w.netA || "–"}) / ${w.b} (${w.netB || "–"}) ${w.side === "B" ? "bottom" : "top"}: web ${w.web} mm${w.allowed ? " (allowed in footprint)" : ""}`);
  if (r.maskDefined.length) L.push(`Mask-defined lands (negative expansion): ${r.maskDefined.map((m) => `${m.ref} ${m.pads} pads ${m.margin} mm`).join(", ")}. Tell the fabricator; a CAM rule may otherwise open them to copper size.`);
  L.push("Webs below the supplier minimum are normally removed in CAM, leaving the pads without mask between them.");
  return L.join("\n");
}
