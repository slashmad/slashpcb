// Parser checks against KiCad's own netlist. Run with `npm test` (needs kicad-cli and samples/).
// For every sample project: board pads ↔ netlist nodes, schematic references ↔ netlist components,
// and schematic pin positions ↔ wire end points.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskWebs } from "../src/main/kicad/analysis";
import { setFields } from "../src/main/kicad/edit";
import { cleanNote, notesSummary, partKey } from "../src/main/kicad/partnotes";
import { parseBoard } from "../src/main/kicad/pcb";
import { parseSchematic } from "../src/main/kicad/sch";
import { child, children, isList, parseSexpr, pts, type SList } from "../src/main/kicad/sexpr";

const root = join(__dirname, "..", "..", "samples");
let failed = 0;
const fail = (m: string) => { failed++; console.log(`  FAIL ${m}`); };

function netlist(sch: string, out: string) {
  execFileSync("kicad-cli", ["sch", "export", "netlist", "--format", "kicadxml", "-o", out, sch], { stdio: "ignore" });
  const xml = readFileSync(out, "utf8");
  const comps = new Set([...xml.matchAll(/<comp ref="([^"]+)"/g)].map((m) => m[1]));
  const nodes = new Map<string, string>(); // "REF.PIN" → net
  for (const m of xml.matchAll(/<net code="\d+" name="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g)) {
    for (const n of m[2].matchAll(/<node ref="([^"]+)" pin="([^"]+)"/g)) nodes.set(`${n[1]}.${n[2]}`, m[1]);
  }
  return { comps, nodes };
}

function wireEnds(file: string, seen = new Set<string>()): number[][] {
  if (seen.has(file)) return [];
  seen.add(file);
  const t = parseSexpr(readFileSync(file, "utf8"))[0] as SList;
  const out: number[][] = [];
  for (const w of children(t, "wire")) { const p = pts(w); out.push([p[0], p[1]], [p[p.length - 2], p[p.length - 1]]); }
  for (const h of ["label", "global_label", "hierarchical_label", "no_connect", "junction"]) {
    for (const l of children(t, h)) { const a = child(l, "at"); if (a) out.push([Number(a[1]), Number(a[2])]); }
  }
  return out;
}

for (const dir of existsSync(root) ? readdirSync(root) : []) {
  const abs = join(root, dir);
  if (!statSync(abs).isDirectory()) continue;
  for (const pro of readdirSync(abs).filter((f) => f.endsWith(".kicad_pro"))) {
    const stem = pro.replace(/\.kicad_pro$/, "");
    console.log(`${dir}/${stem}`);
    const pcbFile = join(abs, `${stem}.kicad_pcb`), schFile = join(abs, `${stem}.kicad_sch`);
    const tmp = mkdtempSync(join(tmpdir(), "slashpcb-test-"));
    let nl: ReturnType<typeof netlist> | null = null;
    if (existsSync(schFile)) {
      nl = netlist(schFile, join(tmp, "net.xml"));
      const sch = parseSchematic(schFile, abs);
      const refs = new Set(sch.symbols.filter((s) => !s.power && s.onBoard !== false).map((s) => s.ref));
      const missing = [...nl.comps].filter((r) => !refs.has(r));
      const extra = [...refs].filter((r) => !nl!.comps.has(r) && !r.endsWith("?"));
      console.log(`  sch: ${sch.sheets.length} sheet(s), ${sch.symbols.length} symbols, ${sch.labels.length} labels, ${sch.parseMs} ms`);
      if (missing.length) fail(`schematic misses ${missing.length} netlist components: ${missing.slice(0, 8).join(" ")}`);
      if (extra.length) console.log(`  note: ${extra.length} schematic refs not in netlist (excluded from board/BOM?): ${extra.slice(0, 8).join(" ")}`);
      // Pin connection points should land on wire ends.
      let onWire = 0, total = 0;
      for (const sh of sch.sheets) {
        const ends = wireEnds(join(abs, sh.file));
        const key = new Set(ends.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`));
        for (const s of sch.symbols.filter((s) => s.sheet === sh.path)) for (const p of s.pins) { total++; if (key.has(`${p.x.toFixed(2)},${p.y.toFixed(2)}`)) onWire++; }
      }
      console.log(`  pins on wire ends/labels/no-connects: ${onWire}/${total}`);
    }
    if (existsSync(pcbFile)) {
      const b = parseBoard(pcbFile);
      const w = b.bbox[2] - b.bbox[0], h = b.bbox[3] - b.bbox[1];
      console.log(`  pcb: ${b.copper.length} Cu, ${w.toFixed(2)} × ${h.toFixed(2)} mm, ${JSON.stringify(b.stats)}, ${b.parseMs} ms`);
      if (nl) {
        let ok = 0, bad = 0;
        const badList: string[] = [];
        for (const f of b.footprints) for (const p of f.pads) {
          if (!p.num || !p.net) continue;
          const want = nl.nodes.get(`${f.ref}.${p.num}`);
          if (want === undefined) continue;
          if (want === p.net || want.replace(/^\//, "") === p.net.replace(/^\//, "")) ok++;
          else { bad++; if (badList.length < 5) badList.push(`${f.ref}.${p.num}: board ${p.net} vs sch ${want}`); }
        }
        console.log(`  pad nets matching netlist: ${ok}, differing: ${bad}`);
        if (bad) console.log(`  (differences can be real parity issues) ${badList.join("; ")}`);
      }
    }
  }
}
// Surgical field edits on a copy: only the intended lines change and KiCad still reads the files.
{
  const src = join(root, "demo-complex_hierarchy");
  if (existsSync(src)) {
    console.log("edit test (copy of demo-complex_hierarchy)");
    const dir = mkdtempSync(join(tmpdir(), "slashpcb-edit-"));
    cpSync(src, dir, { recursive: true });
    const schFile = join(dir, "complex_hierarchy.kicad_sch"), pcbFile = join(dir, "complex_hierarchy.kicad_pcb");
    const sch = parseSchematic(schFile, dir);
    const u = sch.symbols.find((x) => x.ref === "U101")!;
    const subFile = join(dir, sch.symbols.find((x) => x.ref === "RV201")!.file);
    const rv = sch.symbols.find((x) => x.ref === "RV201")!;
    const before = { sch: readFileSync(schFile, "utf8"), sub: readFileSync(subFile, "utf8"), pcb: readFileSync(pcbFile, "utf8") };
    const r1 = setFields(schFile, "sch", [{ uuid: u.uuid, field: "MPN", value: "MC78L05ACP" }, { uuid: u.uuid, field: "Value", value: "78L05 \"TO-92\"" }], () => [u.x, u.y + 5]);
    const r2 = setFields(subFile, "sch", [{ uuid: rv.uuid, field: "LCSC", value: "C12345" }], () => [rv.x, rv.y]);
    const b = parseBoard(pcbFile);
    const fp = b.footprints.find((f) => f.ref === "U101")!;
    const r3 = setFields(pcbFile, "pcb", [{ uuid: fp.uuid, field: "MPN", value: "MC78L05ACP" }]);
    console.log(`  edits: sch ${r1.changed}/${r1.inserted}, sub ${r2.changed}/${r2.inserted}, pcb ${r3.changed}/${r3.inserted}`);
    const sch2 = parseSchematic(schFile, dir);
    const u2 = sch2.symbols.find((x) => x.ref === "U101")!;
    if (u2.fields.MPN !== "MC78L05ACP" || u2.value !== '78L05 "TO-92"') fail(`schematic fields not read back: ${JSON.stringify(u2.fields)}`);
    const rvs = sch2.symbols.filter((x) => x.libId === rv.libId && x.file === rv.file && x.fields.LCSC === "C12345").map((x) => x.ref);
    console.log(`  multi-instance symbol shares the field: ${rvs.join(", ")}`);
    if (parseBoard(pcbFile).footprints.find((f) => f.ref === "U101")?.fields.MPN !== "MC78L05ACP") fail("board field not read back");
    const diffLines = (a: string, c: string) => {
      const ta = join(dir, "a.txt"), tc = join(dir, "c.txt");
      require("node:fs").writeFileSync(ta, a); require("node:fs").writeFileSync(tc, c);
      return (spawnSync("diff", [ta, tc], { encoding: "utf8" }).stdout.match(/^[<>] /gm) ?? []).length;
    };
    const lines = { sch: diffLines(before.sch, readFileSync(schFile, "utf8")), sub: diffLines(before.sub, readFileSync(subFile, "utf8")), pcb: diffLines(before.pcb, readFileSync(pcbFile, "utf8")) };
    if (lines.sch !== 11 || lines.sub !== 9 || lines.pcb !== 13) fail(`unexpected diff size ${JSON.stringify(lines)} (want sch 11, sub 9, pcb 13)`);
    console.log(`  diff lines (want 11/9/13): ${JSON.stringify(lines)}`);
        const erc = spawnSync("kicad-cli", ["sch", "erc", "--format", "json", "-o", join(dir, "erc.json"), schFile], { encoding: "utf8" });
    const drc = spawnSync("kicad-cli", ["pcb", "drc", "--format", "json", "--schematic-parity", "-o", join(dir, "drc.json"), pcbFile], { encoding: "utf8" });
    if (!existsSync(join(dir, "erc.json")) || !existsSync(join(dir, "drc.json"))) fail(`kicad-cli could not read the edited files: ${erc.stderr} ${drc.stderr}`);
    else {
      const e = JSON.parse(readFileSync(join(dir, "erc.json"), "utf8")), d = JSON.parse(readFileSync(join(dir, "drc.json"), "utf8"));
      console.log(`  kicad-cli reads edited files: ERC ${e.sheets.reduce((n: number, s: any) => n + s.violations.length, 0)} violation(s), DRC ${d.violations.length} violation(s), parity ${d.schematic_parity.length}`);
    }
    const nl2 = netlist(schFile, join(dir, "net2.xml"));
    if (!readFileSync(join(dir, "net2.xml"), "utf8").includes("MC78L05ACP")) fail("netlist does not carry the new MPN");
    console.log(`  netlist components after edit: ${nl2.comps.size}`);
  }
}

// Solder-mask webs and sourcing notes on a synthetic board (no samples needed).
{
  console.log("mask webs and part notes (synthetic)");
  const rect = (x: number, y: number, w: number, h: number) => [x - w / 2, y - h / 2, x + w / 2, y - h / 2, x + w / 2, y + h / 2, x - w / 2, y + h / 2];
  const pad = (num: string, x: number, net: string, maskMargin?: number) => ({ num, type: "smd", shape: "rect", x, y: 0, rot: 0, w: 0.3, h: 1, layers: ["F.Cu", "F.Mask", "F.Paste"], net, polys: [rect(x, 0, 0.3, 1)], maskMargin });
  const fp = (ref: string, pads: any[], fields: Record<string, string> = {}, maskMargin?: number) => ({ ref, value: "X", lib: "L:X", side: "F", x: 0, y: 0, rot: 0, fields, attrs: ["smd"], bbox: [-1, -1, 1, 1], pads, graphics: [], uuid: ref, path: "", maskMargin });
  // Pitch 0.5, pad width 0.3: copper gap 0.2. Margin 0.05 each side → web 0.1; margin 0.06 → 0.08 (thin).
  const board: any = { footprints: [fp("U1", [pad("1", 0, "A", 0.06), pad("2", 0.5, "B", 0.06), pad("3", 1.0, "B")], {}, 0.05)], vias: [], tracks: [], zones: [], copper: ["F.Cu", "B.Cu"], mask: { padToMask: 0, minWidth: 0, bridgesInFootprints: false } };
  const r = maskWebs(board, 0.1);
  const w12 = r.webs.find((w) => w.a === "U1.1" && w.b === "U1.2");
  if (!w12 || Math.abs(w12.web - 0.08) > 1e-6 || w12.kind !== "thin" || w12.allowed) fail(`mask web U1.1/U1.2 expected 0.08 thin, got ${JSON.stringify(w12)}`);
  const w23 = r.webs.find((w) => w.a === "U1.2" && w.b === "U1.3");
  if (!w23 || !w23.sameNet || Math.abs(w23.web - 0.09) > 1e-6) fail(`mask web U1.2/U1.3 expected 0.09 same net (pad 0.06 + footprint 0.05), got ${JSON.stringify(w23)}`);
  if (r.narrowest?.web !== 0.08) fail(`narrowest web ${r.narrowest?.web}`);
  board.mask.bridgesInFootprints = true;
  if (!maskWebs(board, 0.1).webs.find((w) => w.a === "U1.1")?.allowed) fail("bridges in footprints not honoured");
  board.footprints[0].pads[0].maskMargin = -0.05; // mask-defined land
  if (!maskWebs(board, 0.1).maskDefined.some((m) => m.ref === "U1")) fail("mask-defined land not reported");
  // Notes: validation, keys, summary.
  let threw = false;
  try { cleanNote({ quote: { unitPrice: 1.2, currency: "" } } as any); } catch { threw = true; }
  if (!threw) fail("a quote without currency must be refused");
  const n = cleanNote({ lifecycle: "eol", consigned: true, alternates: "A1, A2;A1", leadTimeDays: "12" } as any);
  if (n.alternates?.length !== 2 || n.leadTimeDays !== 12 || !n.consigned) fail(`cleanNote ${JSON.stringify(n)}`);
  const parts: any[] = [fp("U2", [], { MPN: "ABC-1" }), fp("U3", [], { MPN: "ABC-1" }), fp("R1", [])];
  if (partKey(parts[0]) !== "mpn:ABC-1" || partKey(parts[2]) !== "vf:X|L:X") fail("partKey");
  const s = notesSummary(parts, { "mpn:ABC-1": { lifecycle: "nrnd" }, "vf:X|L:X": { consigned: true } });
  if (s.lifecycle.length !== 2 || s.missingAlternates.length !== 2 || s.consigned.join() !== "R1") fail(`notesSummary ${JSON.stringify(s)}`);
}

console.log(failed ? `${failed} failure(s)` : "all checks passed");
process.exit(failed ? 1 : 0);
