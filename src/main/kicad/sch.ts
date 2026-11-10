// .kicad_sch hierarchy → SchematicModel: sheets, placed symbols (with instance references for
// multi-instance sheets), approximate symbol bounding boxes and pin connection points in sheet
// millimetres (y down, same coordinates as kicad-cli's SVG export).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { SchLabel, SchPin, SchSheet, SchSymbol, SchematicModel } from "../../shared/types";
import { at, child, children, isList, num, parseSexpr, pts, str, type SList } from "./sexpr";

const PAPER: Record<string, [number, number]> = {
  A5: [210, 148], A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
  USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4],
};

function paper(root: SList): { name: string; w: number; h: number } {
  const p = child(root, "paper");
  const name = String(p?.[1] ?? "A4");
  let [w, h] = name === "User" ? [Number(p?.[2] ?? 297), Number(p?.[3] ?? 210)] : PAPER[name] ?? [297, 210];
  if (p?.includes("portrait")) [w, h] = [h, w];
  return { name, w, h };
}

interface LibGeom { box: [number, number, number, number] | null; pins: { num: string; name: string; x: number; y: number }[]; power: boolean }

/** Geometry of one lib symbol for a given unit (unit 0 = shared by all units), in lib coordinates (y up). */
function libGeom(lib: SList, unit: number): LibGeom {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const g = (x: number, y: number) => { box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y); };
  const pins: LibGeom["pins"] = [];
  const name = String(lib[1] ?? "");
  const stem = name.includes(":") ? name.split(":").pop()! : name;
  const visit = (l: SList) => {
    for (const c of l) {
      if (!isList(c)) continue;
      const h = c[0];
      if (h === "symbol") {
        // Sub-symbol "<stem>_<unit>_<style>": keep shared (0) and the requested unit, body style 0/1.
        const m = /_(\d+)_(\d+)$/.exec(String(c[1] ?? ""));
        if (m && String(c[1]).startsWith(stem)) {
          const u = Number(m[1]), s = Number(m[2]);
          if ((u === 0 || u === unit) && s <= 1) visit(c);
        } else if (!m) visit(c);
      } else if (h === "rectangle") {
        const s = child(c, "start"), e = child(c, "end");
        g(Number(s?.[1]), Number(s?.[2])); g(Number(e?.[1]), Number(e?.[2]));
      } else if (h === "polyline" || h === "bezier") {
        const p = pts(c);
        for (let i = 0; i < p.length; i += 2) g(p[i], p[i + 1]);
      } else if (h === "circle") {
        const ce = child(c, "center"), r = num(c, "radius") ?? 0;
        g(Number(ce?.[1]) - r, Number(ce?.[2]) - r); g(Number(ce?.[1]) + r, Number(ce?.[2]) + r);
      } else if (h === "arc") {
        for (const k of ["start", "mid", "end"]) { const q = child(c, k); if (q) g(Number(q[1]), Number(q[2])); }
      } else if (h === "pin") {
        const [x, y, r] = at(c);
        const len = num(c, "length") ?? 2.54;
        const a = (r * Math.PI) / 180;
        g(x, y); g(x + len * Math.cos(a), y + len * Math.sin(a));
        pins.push({ num: String(child(c, "number")?.[1] ?? ""), name: String(child(c, "name")?.[1] ?? ""), x, y });
      }
    }
  };
  visit(lib);
  return { box: Number.isFinite(box[0]) ? box : null, pins, power: !!child(lib, "power") };
}

/** Lib (y up) → sheet (y down) for a symbol at (X, Y) with rotation and mirror. */
function symXf(X: number, Y: number, rot: number, mirror: string | undefined) {
  const a = (rot * Math.PI) / 180, c = Math.round(Math.cos(a) * 1e6) / 1e6, s = Math.round(Math.sin(a) * 1e6) / 1e6;
  return (lx: number, ly: number): [number, number] => {
    let x = lx, y = -ly; // y up → y down
    // Rotation CCW on screen (y down).
    let rx = x * c + y * s, ry = -x * s + y * c;
    if (mirror === "x") ry = -ry; // mirror about the horizontal axis
    else if (mirror === "y") rx = -rx; // mirror about the vertical axis
    return [X + rx, Y + ry];
  };
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]/g, "_");
}

export function parseSchematic(rootFile: string, projectDir: string): SchematicModel {
  const t0 = Date.now();
  const sheets: SchSheet[] = [];
  const symbols: SchSymbol[] = [];
  const labels: SchLabel[] = [];
  const cache = new Map<string, SList>();
  const load = (abs: string): SList | null => {
    if (cache.has(abs)) return cache.get(abs)!;
    if (!existsSync(abs)) return null;
    const r = parseSexpr(readFileSync(abs, "utf8"))[0];
    if (!isList(r) || r[0] !== "kicad_sch") return null;
    cache.set(abs, r);
    return r;
  };
  const rel = (abs: string) => relative(projectDir, abs).split(sep).join("/");
  const rootTree = load(rootFile);
  if (!rootTree) throw new Error("not a KiCad schematic file");
  const rootUuid = str(rootTree, "uuid") ?? "";
  // KiCad 6 stored references for all sheets in the root file.
  const legacyRefs = new Map<string, { ref: string; unit: number }>();
  for (const p of children(child(rootTree, "symbol_instances"), "path")) legacyRefs.set(String(p[1]), { ref: str(p, "reference") ?? "", unit: num(p, "unit") ?? 1 });

  const walk = (abs: string, tree: SList, path: string, name: string, chain: string, depth: number, page?: string) => {
    const pp = paper(tree);
    sheets.push({ path, name, file: rel(abs), paper: pp.name, w: pp.w, h: pp.h, svg: null, page });
    const libs = new Map<string, SList>();
    for (const l of children(child(tree, "lib_symbols"), "symbol")) libs.set(String(l[1]), l);
    for (const s of children(tree, "symbol")) {
      const libId = str(s, "lib_id") ?? "";
      const lib = libs.get(str(s, "lib_name") ?? libId) ?? libs.get(libId);
      const [X, Y, R] = at(s);
      const mirror = str(s, "mirror");
      const fields: Record<string, string> = {};
      for (const p of children(s, "property")) fields[String(p[1])] = String(p[2] ?? "");
      let ref = fields.Reference ?? "";
      let unit = num(s, "unit") ?? 1;
      const uuid = str(s, "uuid") ?? "";
      let matched = false;
      for (const proj of children(child(s, "instances"), "project")) {
        for (const p of children(proj, "path")) {
          if (String(p[1]) === chain) { ref = str(p, "reference") ?? ref; unit = num(p, "unit") ?? unit; matched = true; }
        }
      }
      if (!matched) { const lr = legacyRefs.get(`${chain}/${uuid}`); if (lr) { ref = lr.ref; unit = lr.unit; } }
      const geom = lib ? libGeom(lib, unit) : { box: null, pins: [], power: false };
      const xf = symXf(X, Y, R, mirror);
      const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      const g = (x: number, y: number) => { bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y); bbox[2] = Math.max(bbox[2], x); bbox[3] = Math.max(bbox[3], y); };
      if (geom.box) {
        const [a, b, c, d] = geom.box;
        for (const [x, y] of [[a, b], [c, b], [c, d], [a, d]] as const) g(...xf(x, y));
      } else { g(X - 1.27, Y - 1.27); g(X + 1.27, Y + 1.27); }
      const pins: SchPin[] = geom.pins.map((p) => { const [x, y] = xf(p.x, p.y); return { num: p.num, name: p.name, x, y }; });
      const yes = (k: string, def: boolean) => { const v = str(s, k); return v === undefined ? def : v === "yes"; };
      symbols.push({
        ref, value: fields.Value ?? "", footprint: fields.Footprint ?? "", libId, sheet: path, sheetName: name,
        x: X, y: Y, rot: R, mirror: mirror === "x" || mirror === "y" ? mirror : undefined, unit, fields,
        dnp: yes("dnp", false), inBom: yes("in_bom", true), onBoard: yes("on_board", true), bbox, pins,
        power: geom.power || ref.startsWith("#"),
      });
    }
    for (const [kind, h] of [["label", "label"], ["global", "global_label"], ["hier", "hierarchical_label"]] as const) {
      for (const l of children(tree, h)) { const [x, y] = at(l); labels.push({ text: String(l[1] ?? ""), kind, sheet: path, x, y }); }
    }
    if (depth > 12) return;
    for (const sh of children(tree, "sheet")) {
      const props: Record<string, string> = {};
      for (const p of children(sh, "property")) props[String(p[1])] = String(p[2] ?? "");
      const sname = props.Sheetname ?? props["Sheet name"] ?? "sheet";
      const sfile = props.Sheetfile ?? props["Sheet file"];
      if (!sfile) continue;
      const childAbs = join(dirname(abs), sfile);
      const sub = load(childAbs);
      if (!sub) continue;
      const suuid = str(sh, "uuid") ?? "";
      let subPage: string | undefined;
      for (const proj of children(child(sh, "instances"), "project")) for (const p of children(proj, "path")) if (String(p[1]) === chain) subPage = str(p, "page");
      walk(childAbs, sub, `${path}${sname}/`, sname, `${chain}/${suuid}`, depth + 1, subPage);
    }
  };
  walk(rootFile, rootTree, "/", "Root", `/${rootUuid}`, 0, "1");
  return { root: rel(rootFile), sheets, symbols, labels, parseMs: Date.now() - t0 };
}

/** Match kicad-cli's per-sheet SVG files (<stem>.svg, <stem>-<sheet>.svg) to sheets. */
export function assignSheetSvgs(model: SchematicModel, files: string[], stem: string): void {
  const left = new Set(files);
  const take = (f: string | undefined) => { if (f) left.delete(f); return f ?? null; };
  for (const s of model.sheets) {
    if (s.path === "/") { s.svg = take(files.find((f) => f.endsWith(`${sep}${stem}.svg`) || f.endsWith(`/${stem}.svg`))); continue; }
    const parts = s.path.split("/").filter(Boolean).map(sanitize);
    const want = [`${stem}-${parts.join("-")}.svg`, `${stem}-${parts[parts.length - 1]}.svg`];
    s.svg = take([...left].find((f) => want.some((w) => f.endsWith(w))));
  }
}
