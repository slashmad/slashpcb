// Parser checks against KiCad's own netlist. Run with `npm test` (needs kicad-cli and samples/).
// For every sample project: board pads ↔ netlist nodes, schematic references ↔ netlist components,
// and schematic pin positions ↔ wire end points.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
console.log(failed ? `${failed} failure(s)` : "all checks passed");
process.exit(failed ? 1 : 0);
