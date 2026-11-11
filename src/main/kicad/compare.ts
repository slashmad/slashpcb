// Revision comparison: the open board/schematic against another revision (a sibling folder such as
// R45 vs R46, or the last Git commit). The other revision is only parsed, never touched by kicad-cli.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { BoardModel, Footprint, SchematicModel } from "../../shared/types";
import { kicadEnv } from "./cli";
import { parseBoard } from "./pcb";
import { parseSchematic } from "./sch";

export interface Change<T = string> { ref: string; from: T; to: T }
export interface Moved { ref: string; dx: number; dy: number; from: [number, number]; to: [number, number] }
export interface BoardDiff {
  added: string[];
  removed: { ref: string; x: number; y: number; bbox: [number, number, number, number] }[];
  moved: Moved[];
  rotated: Change<number>[];
  flipped: string[];
  value: Change[];
  footprint: Change[];
  fields: (Change & { field: string })[];
  padNets: (Change & { pad: string })[];
  netsAdded: string[];
  netsRemoved: string[];
  before: { size: [number, number]; copper: number; footprints: number; tracks: number; vias: number; trackLengthMm: number; zones: number };
  after: BoardDiff["before"];
}
export interface SchDiff { added: string[]; removed: string[]; value: Change[]; footprint: Change[]; fields: (Change & { field: string })[]; sheets: [number, number] }
export interface RevisionDiff { other: string; label: string; board: BoardDiff | null; schematic: SchDiff | null; ranAt: number }

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const IGNORE_FIELDS = new Set(["Reference", "Value", "Footprint", "Datasheet", "Description", "ki_fp_filters", "ki_keywords", "ki_description"]);

function summary(b: BoardModel) {
  return { size: [+(b.bbox[2] - b.bbox[0]).toFixed(3), +(b.bbox[3] - b.bbox[1]).toFixed(3)] as [number, number], copper: b.copper.length, footprints: b.stats.footprints, tracks: b.stats.tracks, vias: b.stats.vias, trackLengthMm: b.stats.trackLengthMm, zones: b.stats.zones };
}

export function diffBoards(old: BoardModel, cur: BoardModel): BoardDiff {
  const byRef = (b: BoardModel) => { const m = new Map<string, Footprint>(); for (const f of b.footprints) if (f.ref && !m.has(f.ref)) m.set(f.ref, f); return m; };
  const A = byRef(old), B = byRef(cur);
  const d: BoardDiff = { added: [], removed: [], moved: [], rotated: [], flipped: [], value: [], footprint: [], fields: [], padNets: [], netsAdded: [], netsRemoved: [], before: summary(old), after: summary(cur) };
  for (const [ref, f] of A) if (!B.has(ref)) d.removed.push({ ref, x: f.x, y: f.y, bbox: f.bbox });
  for (const [ref, f] of B) {
    const o = A.get(ref);
    if (!o) { d.added.push(ref); continue; }
    const dx = f.x - o.x, dy = f.y - o.y;
    if (Math.abs(dx) > 0.0005 || Math.abs(dy) > 0.0005) d.moved.push({ ref, dx: +dx.toFixed(4), dy: +dy.toFixed(4), from: [o.x, o.y], to: [f.x, f.y] });
    const dr = (((f.rot - o.rot) % 360) + 540) % 360 - 180;
    if (Math.abs(dr) > 0.01) d.rotated.push({ ref, from: o.rot, to: f.rot });
    if (f.side !== o.side) d.flipped.push(ref);
    if (f.value !== o.value) d.value.push({ ref, from: o.value, to: f.value });
    if (f.lib !== o.lib) d.footprint.push({ ref, from: o.lib, to: f.lib });
    for (const k of new Set([...Object.keys(o.fields), ...Object.keys(f.fields)])) {
      if (IGNORE_FIELDS.has(k)) continue;
      const a = o.fields[k] ?? "", b = f.fields[k] ?? "";
      if (a !== b) d.fields.push({ ref, field: k, from: a, to: b });
    }
    const oldPads = new Map(o.pads.map((p) => [p.num, p.net]));
    for (const p of f.pads) {
      const was = oldPads.get(p.num);
      if (was !== undefined && was !== p.net) d.padNets.push({ ref, pad: p.num, from: was, to: p.net });
    }
  }
  const nA = new Set(old.nets), nB = new Set(cur.nets);
  d.netsAdded = cur.nets.filter((n) => !nA.has(n));
  d.netsRemoved = old.nets.filter((n) => !nB.has(n));
  d.added.sort(natural); d.removed.sort((a, b) => natural(a.ref, b.ref)); d.moved.sort((a, b) => natural(a.ref, b.ref));
  return d;
}

export function diffSchematics(old: SchematicModel, cur: SchematicModel): SchDiff {
  const byRef = (s: SchematicModel) => { const m = new Map<string, SchematicModel["symbols"][number]>(); for (const x of s.symbols) if (!x.power && !m.has(x.ref)) m.set(x.ref, x); return m; };
  const A = byRef(old), B = byRef(cur);
  const d: SchDiff = { added: [], removed: [], value: [], footprint: [], fields: [], sheets: [old.sheets.length, cur.sheets.length] };
  for (const r of A.keys()) if (!B.has(r)) d.removed.push(r);
  for (const [r, s] of B) {
    const o = A.get(r);
    if (!o) { d.added.push(r); continue; }
    if (o.value !== s.value) d.value.push({ ref: r, from: o.value, to: s.value });
    if (o.footprint !== s.footprint) d.footprint.push({ ref: r, from: o.footprint, to: s.footprint });
    for (const k of new Set([...Object.keys(o.fields), ...Object.keys(s.fields)])) {
      if (IGNORE_FIELDS.has(k)) continue;
      if ((o.fields[k] ?? "") !== (s.fields[k] ?? "")) d.fields.push({ ref: r, field: k, from: o.fields[k] ?? "", to: s.fields[k] ?? "" });
    }
  }
  d.added.sort(natural); d.removed.sort(natural);
  return d;
}

/** Compare with another KiCad project file/folder (resolved by the caller to dir + stem). */
export function compareWithFolder(otherDir: string, otherStem: string, cur: { board: BoardModel | null; schematic: SchematicModel | null }): RevisionDiff {
  const pcb = join(otherDir, `${otherStem}.kicad_pcb`), sch = join(otherDir, `${otherStem}.kicad_sch`);
  const ob = existsSync(pcb) ? parseBoard(pcb) : null;
  const os = existsSync(sch) ? parseSchematic(sch, otherDir) : null;
  return {
    other: join(otherDir, otherStem), label: otherStem, ranAt: Date.now(),
    board: ob && cur.board ? diffBoards(ob, cur.board) : null,
    schematic: os && cur.schematic ? diffSchematics(os, cur.schematic) : null,
  };
}

const git = (dir: string, args: string[]) => new Promise<string>((res, rej) =>
  execFile("git", ["-C", dir, ...args], { env: kicadEnv(), maxBuffer: 200 * 1024 * 1024, timeout: 30000 }, (e, out) => (e ? rej(e) : res(out))));

/** Compare the board with its version in a Git revision (default HEAD) of the project's repository. */
export async function compareWithGit(projectDir: string, pcbRel: string, cur: { board: BoardModel | null }, rev = "HEAD"): Promise<RevisionDiff> {
  const top = (await git(projectDir, ["rev-parse", "--show-toplevel"])).trim();
  const path = relative(top, join(projectDir, pcbRel)).split("\\").join("/");
  const text = await git(top, ["show", `${rev}:${path}`]);
  const short = (await git(top, ["rev-parse", "--short", rev])).trim();
  const ob = parseBoard(`${rev}:${path}`, text);
  return { other: `${rev}:${path}`, label: `git ${short}`, ranAt: Date.now(), board: cur.board ? diffBoards(ob, cur.board) : null, schematic: null };
}

export function diffText(d: RevisionDiff, max = 40): string {
  const L: string[] = [`Comparison: ${d.label} → current`];
  const list = <T,>(title: string, xs: T[], fmt: (x: T) => string) => { if (xs.length) L.push(`${title} (${xs.length}): ${xs.slice(0, max).map(fmt).join("; ")}${xs.length > max ? " …" : ""}`); };
  const b = d.board;
  if (b) {
    L.push(`Board: ${b.before.size.join(" × ")} → ${b.after.size.join(" × ")} mm, Cu ${b.before.copper} → ${b.after.copper}, footprints ${b.before.footprints} → ${b.after.footprints}, tracks ${b.before.tracks} → ${b.after.tracks} (${b.before.trackLengthMm} → ${b.after.trackLengthMm} mm), vias ${b.before.vias} → ${b.after.vias}, zones ${b.before.zones} → ${b.after.zones}`);
    list("Added", b.added, (r) => r);
    list("Removed", b.removed, (r) => r.ref);
    list("Moved", b.moved, (m) => `${m.ref} (${m.dx >= 0 ? "+" : ""}${m.dx}, ${m.dy >= 0 ? "+" : ""}${m.dy})`);
    list("Rotated", b.rotated, (c) => `${c.ref} ${c.from}→${c.to}°`);
    list("Flipped side", b.flipped, (r) => r);
    list("Value", b.value, (c) => `${c.ref} ${c.from}→${c.to}`);
    list("Footprint", b.footprint, (c) => `${c.ref} ${c.from}→${c.to}`);
    list("Fields", b.fields, (c) => `${c.ref}.${c.field} "${c.from}"→"${c.to}"`);
    list("Pad nets", b.padNets, (c) => `${c.ref}.${c.pad} ${c.from || "–"}→${c.to || "–"}`);
    list("Nets added", b.netsAdded, (n) => n);
    list("Nets removed", b.netsRemoved, (n) => n);
  } else L.push("Board: not compared (missing on one side).");
  const s = d.schematic;
  if (s) {
    L.push(`Schematic: sheets ${s.sheets[0]} → ${s.sheets[1]}`);
    list("Symbols added", s.added, (r) => r);
    list("Symbols removed", s.removed, (r) => r);
    list("Symbol values", s.value, (c) => `${c.ref} ${c.from}→${c.to}`);
    list("Symbol footprints", s.footprint, (c) => `${c.ref} ${c.from}→${c.to}`);
    list("Symbol fields", s.fields, (c) => `${c.ref}.${c.field} "${c.from}"→"${c.to}"`);
  }
  return L.join("\n");
}
