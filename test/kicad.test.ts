// Parser checks against KiCad's own netlist. Run with `npm test` (needs kicad-cli and samples/).
// For every sample project: board pads ↔ netlist nodes, schematic references ↔ netlist components,
// and schematic pin positions ↔ wire end points.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskWebs, padGap } from "../src/main/kicad/analysis";
import { subscriptionVerdict } from "../src/main/agents/billing";
import { diffBoards } from "../src/main/kicad/compare";
import { diffDesignRules, isRelaxation, readDesignRules } from "../src/main/kicad/designrules";
import { evaluateRules, readRules } from "../src/main/kicad/invariants";
import { compareWithReference } from "../src/main/kicad/libfp";
import { polarityReview } from "../src/main/kicad/polarity";
import { changedInputs, exportRelease, hashInputs, matchHoles, parseExcellon } from "../src/main/kicad/release";
import { KicadProject } from "../src/main/project";
import { setFields } from "../src/main/kicad/edit";
import { cleanNote, notesSummary, partKey } from "../src/main/kicad/partnotes";
import { parseBoard } from "../src/main/kicad/pcb";
import { parseSchematic } from "../src/main/kicad/sch";
import { child, children, isList, parseSexpr, pts, type SList } from "../src/main/kicad/sexpr";

const root = process.env.SLASHPCB_SAMPLES || join(__dirname, "..", "..", "samples");
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

const segs: number[][] = []; // wire segments of the sheets read by wireEnds (pins may touch a wire mid-segment)
function onSegment(x: number, y: number): boolean {
  return segs.some(([ax, ay, bx, by]) => {
    const l = Math.hypot(bx - ax, by - ay);
    if (l < 1e-9) return false;
    const cross = Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / l;
    const t = ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (l * l);
    return cross < 0.01 && t >= -1e-6 && t <= 1 + 1e-6;
  });
}
function wireEnds(file: string, seen = new Set<string>()): number[][] {
  if (seen.has(file)) return [];
  seen.add(file);
  const t = parseSexpr(readFileSync(file, "utf8"))[0] as SList;
  const out: number[][] = [];
  for (const w of children(t, "wire")) { const p = pts(w); out.push([p[0], p[1]], [p[p.length - 2], p[p.length - 1]]); segs.push([p[0], p[1], p[p.length - 2], p[p.length - 1]]); }
  for (const h of ["label", "global_label", "hierarchical_label", "no_connect", "junction"]) {
    for (const l of children(t, h)) { const a = child(l, "at"); if (a) out.push([Number(a[1]), Number(a[2])]); }
  }
  return out;
}

// Parser oracle: every printed comparison is an assertion. Intentional source differences (a sample
// whose schematic and board really disagree) must be listed here explicitly, as "dir/stem": ["REF.PAD"].
const EXPECTED_PARITY: Record<string, string[]> = {};
let projects = 0;
for (const dir of existsSync(root) ? readdirSync(root) : []) {
  const abs = join(root, dir);
  if (!statSync(abs).isDirectory()) continue;
  for (const pro of readdirSync(abs).filter((f) => f.endsWith(".kicad_pro"))) {
    const stem = pro.replace(/\.kicad_pro$/, "");
    console.log(`${dir}/${stem}`);
    projects++;
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
      // Oracle for parsed pin positions: every pin that KiCad's netlist connects to something must sit on a
      // wire end, a wire segment, a label or another pin. Unconnected pins (single-node nets) are skipped.
      const netSize = new Map<string, number>();
      for (const n of nl.nodes.values()) netSize.set(n, (netSize.get(n) ?? 0) + 1);
      let onWire = 0, total = 0;
      const off: string[] = [];
      for (const sh of sch.sheets) {
        segs.length = 0;
        const ends = wireEnds(join(abs, sh.file));
        const here = sch.symbols.filter((s) => s.sheet === sh.path);
        const key = new Set([...ends, ...here.flatMap((s) => s.pins.map((p) => [p.x, p.y]))].map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`));
        const pinCount = new Map<string, number>();
        for (const s of here) for (const p of s.pins) { const k = `${p.x.toFixed(2)},${p.y.toFixed(2)}`; pinCount.set(k, (pinCount.get(k) ?? 0) + 1); }
        for (const s of here) for (const p of s.pins) {
          const net = nl.nodes.get(`${s.ref}.${p.num}`);
          if (!net || (netSize.get(net) ?? 0) < 2 || /^unconnected-/i.test(net)) continue;
          total++;
          const k = `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
          const touchesOther = (pinCount.get(k) ?? 0) > 1;
          if ((ends.some(([x, y]) => Math.abs(x - p.x) < 0.01 && Math.abs(y - p.y) < 0.01)) || touchesOther || onSegment(p.x, p.y) || key.has(k) && touchesOther) onWire++;
          else if (off.length < 6) off.push(`${s.ref}.${p.num} at (${p.x}, ${p.y}) on ${net}`);
        }
      }
      console.log(`  connected pins on a wire/label/pin: ${onWire}/${total}`);
      if (onWire !== total) fail(`${dir}/${stem}: ${total - onWire} connected pin(s) are not on a wire, label or pin: ${off.join("; ")}`);
      if (!total) fail(`${dir}/${stem}: no connected pin was checked`);
    }
    if (existsSync(pcbFile)) {
      const b = parseBoard(pcbFile);
      const w = b.bbox[2] - b.bbox[0], h = b.bbox[3] - b.bbox[1];
      console.log(`  pcb: ${b.copper.length} Cu, ${w.toFixed(2)} × ${h.toFixed(2)} mm, ${JSON.stringify(b.stats)}, ${b.parseMs} ms`);
      if (nl) {
        let ok = 0, bad = 0;
        const badList: string[] = [];
        const expected = new Set(EXPECTED_PARITY[`${dir}/${stem}`] ?? []);
        for (const f of b.footprints) for (const p of f.pads) {
          if (!p.num || !p.net) continue;
          const want = nl.nodes.get(`${f.ref}.${p.num}`);
          if (want === undefined) continue;
          if (want === p.net || want.replace(/^\//, "") === p.net.replace(/^\//, "")) ok++;
          else if (expected.has(`${f.ref}.${p.num}`)) ok++;
          else { bad++; if (badList.length < 5) badList.push(`${f.ref}.${p.num}: board ${p.net} vs sch ${want}`); }
        }
        console.log(`  pad nets matching netlist: ${ok}, differing: ${bad}`);
        if (bad) fail(`${dir}/${stem}: ${bad} pad net(s) differ from KiCad's netlist: ${badList.join("; ")}`);
        if (!ok) fail(`${dir}/${stem}: no pad was compared with the netlist`);
      }
    }
  }
}
if (!projects && !process.env.SLASHPCB_TEST_NO_SAMPLES) fail(`no sample project ran (samples/ missing or empty at ${root}); set SLASHPCB_TEST_NO_SAMPLES=1 to run only the synthetic tests`);

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


// Negative tests for the independent review's findings (each must fail closed).
{
  console.log("review regressions (synthetic)");
  const tmpd = mkdtempSync(join(tmpdir(), "slashpcb-neg-"));
  const rect = (x: number, y: number, w: number, h: number) => [x - w / 2, y - h / 2, x + w / 2, y - h / 2, x + w / 2, y + h / 2, x - w / 2, y + h / 2];
  const mkPad = (num: string, x: number, y: number, w = 0.5, h = 0.5, net = "N" + num, extra: any = {}) => ({ num, type: "smd", shape: "rect", x, y, rot: 0, w, h, layers: ["F.Cu", "F.Mask", "F.Paste"], net, polys: [rect(x, y, w, h)], ...extra });
  const mkFp = (ref: string, pads: any[], extra: any = {}) => ({ ref, value: "V", lib: "L:F", side: "F", x: 0, y: 0, rot: 0, fields: {}, attrs: ["smd"], bbox: [-5, -5, 5, 5], pads, graphics: [], uuid: ref, path: "", ...extra });
  const mkBoard = (fps: any[], extra: any = {}): any => ({ footprints: fps, vias: [], tracks: [], zones: [], graphics: [], copper: ["F.Cu", "In2.Cu", "B.Cu"], nets: [], bbox: [0, 0, 10, 10], stats: { footprints: fps.length, pads: 0, tracks: 0, vias: 0, zones: 0, nets: 0, trackLengthMm: 0 }, ...extra });

  // S01: invalid JSON, unknown kinds and missing fields fail closed.
  const rf = join(tmpd, "rules.json");
  writeFileSync(rf, "{ invalid");
  let rr = readRules([rf]);
  if (!rr.error) fail("S01: invalid rules JSON was not an error");
  if (!evaluateRules(rr.file, rr.data, mkBoard([]), null, null, undefined, rr.error).errors) fail("S01: invalid rules file did not produce an error");
  writeFileSync(rf, JSON.stringify({ version: 1, rules: [{ id: "r1", kind: "pin_nett", pins: "U1.1", net: "GND" }] }));
  rr = readRules([rf]);
  if (!rr.error || !/unknown kind/.test(rr.error)) fail(`S01: misspelled kind accepted (${rr.error})`);
  writeFileSync(rf, JSON.stringify({ version: 1, rules: [{ id: "r1", kind: "pin_net", pins: "U1.1" }] }));
  if (!readRules([rf]).error) fail("S01: pin_net without net accepted");
  writeFileSync(rf, JSON.stringify({ version: 2, rules: [] }));
  if (!readRules([rf]).error) fail("S01: unknown file version accepted");

  // S02: only a confirmed subscription login may start an agent.
  const v = (k: "claude" | "codex", st: any) => subscriptionVerdict(k, st).ok;
  if (!v("claude", { loggedIn: true, method: "claude.ai", apiBilling: false })) fail("S02: claude.ai subscription refused");
  if (!v("codex", { loggedIn: true, method: "chatgpt", apiBilling: false })) fail("S02: ChatGPT subscription refused");
  if (v("claude", { loggedIn: true, method: "console", apiBilling: true })) fail("S02: Console/API billing accepted");
  if (v("codex", { loggedIn: true, method: "apiKey", apiBilling: true })) fail("S02: Codex API key accepted");
  if (v("claude", { loggedIn: true, method: undefined, apiBilling: false })) fail("S02: unknown method accepted");
  if (v("claude", { loggedIn: false, error: "timeout" }) || v("claude", null)) fail("S02: unreadable status accepted");

  // P02: frozen project: rules go to SlashPCB's copy, removal never touches the original.
  const proj = join(tmpd, "frozen"), stateRoot = join(tmpd, "state");
  mkdirSync(proj); writeFileSync(join(proj, "x.kicad_pro"), "{}"); writeFileSync(join(proj, "FROZEN"), "");
  const orig = JSON.stringify({ version: 1, rules: [{ id: "old", kind: "part_present", refs: "U1" }] }, null, 2);
  writeFileSync(join(proj, "slashpcb.rules.json"), orig);
  const kp = new KicadProject(proj, "x.kicad_pro", stateRoot);
  if (!kp.info.frozen) fail("P02: fixture not detected as frozen");
  kp.addRule({ id: "new", kind: "part_present", refs: "U2" } as any);
  const ids = () => kp.rulesData().data.rules.map((r) => r.id).sort().join(",");
  if (ids() !== "new,old") fail(`P02: effective rules after add are ${ids()}`);
  kp.removeRule("old");
  if (ids() !== "new") fail(`P02: effective rules after remove are ${ids()}`);
  if (readFileSync(join(proj, "slashpcb.rules.json"), "utf8") !== orig) fail("P02: the frozen original was modified");
  // An invalid effective rules file refuses writes instead of replacing it.
  writeFileSync(join(stateRoot, "projects", readdirSync(join(stateRoot, "projects"))[0], "rules.json"), "{ broken");
  let refused = false;
  try { kp.addRule({ kind: "part_present", refs: "U3" } as any); } catch { refused = true; }
  if (!refused) fail("S01: a rule was added over an invalid rules file");

  // P03: several fields on one item, both orders, growing and shrinking values.
  const sym = (uuid: string) => `\t(symbol\n\t\t(lib_id "Device:R")\n\t\t(at 10 10 0)\n\t\t(property "Reference" "R1"\n\t\t\t(at 0 0 0)\n\t\t)\n\t\t(property "Value" "1k"\n\t\t\t(at 0 0 0)\n\t\t)\n\t\t(pin "1"\n\t\t\t(uuid "${uuid}-p1")\n\t\t)\n\t\t(uuid "${uuid}")\n\t)`;
  const schText = `(kicad_sch\n\t(version 20250114)\n${sym("aaaa-1")}\n${sym("bbbb-2")}\n)\n`;
  for (const order of [["Value", "MPN"], ["MPN", "Value"]]) for (const val of ["a much longer value than before", "x"]) {
    const f = join(tmpd, `e-${order[0]}-${val.length}.kicad_sch`);
    writeFileSync(f, schText);
    setFields(f, "sch", order.map((field) => ({ uuid: "aaaa-1", field, value: field === "MPN" ? "MPN-123" : val })));
    const t = readFileSync(f, "utf8");
    const root = parseSexpr(t)[0] as SList;
    const s1 = children(root, "symbol").find((x) => String(child(x, "uuid")?.[1]) === "aaaa-1");
    const props = Object.fromEntries(children(s1!, "property").map((p) => [String(p[1]), String(p[2])]));
    if (props.Value !== val || props.MPN !== "MPN-123") fail(`P03: fields wrong after ${order.join("+")} (${JSON.stringify(props)})`);
    if (children(s1!, "uuid").length !== 1 || String(child(s1!, "uuid")?.[1]) !== "aaaa-1") fail(`P03: item UUID damaged after ${order.join("+")}`);
    if (children(root, "symbol").length !== 2) fail("P03: item count changed");
  }
  const dupF = join(tmpd, "dup.kicad_sch");
  writeFileSync(dupF, `(kicad_sch\n${sym("dddd-1")}\n${sym("dddd-1")}\n)\n`);
  if (!setFields(dupF, "sch", [{ uuid: "dddd-1", field: "MPN", value: "X" }]).missing.length) fail("P03: duplicate UUID was edited");

  // P04: strict land pattern: a missing pad or resized pads are not a match.
  const ref10 = Array.from({ length: 10 }, (_, i) => ({ num: String(i + 1), x: i * 0.5, y: 0, w: 0.3, h: 0.8, rot: 0, type: "smd", shape: "rect" }));
  const fp10 = (drop = false, size = 0.3) => mkFp("U9", ref10.filter((_, i) => !(drop && i === 9)).map((p) => ({ ...mkPad(p.num, p.x, p.y, size, size === 0.3 ? 0.8 : size) })));
  if (compareWithReference(fp10() as any, ref10).status !== "match") fail("P04: identical land pattern not matched");
  if (compareWithReference(fp10(true) as any, ref10).status === "match") fail("P04: missing pad accepted");
  if (compareWithReference(fp10(false, 20) as any, ref10).status === "match") fail("P04: 20 × 20 mm pads accepted");

  // P05: a verification goes stale when the MPN or a pad size changes.
  const pfp = () => mkFp("U5", [mkPad("1", 0, 0), mkPad("2", 1, 0), mkPad("3", 2, 0)], { fields: { MPN: "A-1" } });
  const pb = mkBoard([pfp()]);
  const e0 = polarityReview(pb)[0];
  const ver = { U5: { fingerprint: e0.fingerprint, at: "t", identity: e0.identity } };
  if (!polarityReview(pb, ver)[0].verified) fail("P05: verification not applied");
  const pb2 = mkBoard([pfp()]); pb2.footprints[0].fields.MPN = "B-2";
  const e2 = polarityReview(pb2, ver)[0];
  if (e2.verified || !e2.stale?.some((x) => /part/.test(x))) fail("P05: MPN change kept the verification");
  const pb3 = mkBoard([pfp()]); pb3.footprints[0].pads[0].w = 0.9;
  if (polarityReview(pb3, ver)[0].verified) fail("P05: pad size change kept the verification");

  // P06: a removed minimum and a removed net class are reported as relaxations.
  const pro = (rules: any, classes: any[]) => JSON.stringify({ board: { design_settings: { rules } }, net_settings: { classes } });
  const ch = diffDesignRules(readDesignRules(pro({ min_clearance: 0.2 }, [{ name: "Default", clearance: 0.2 }, { name: "Power", clearance: 0.3 }]), null), readDesignRules(pro({}, [{ name: "Default", clearance: 0.2 }]), null));
  if (!ch.some((c) => c.what === "min_clearance" && isRelaxation(c))) fail(`P06: removed min_clearance not reported (${JSON.stringify(ch)})`);
  if (!ch.some((c) => c.kind === "class-" && isRelaxation(c))) fail("P06: removed net class not reported");

  // P07: layer_nets sees SMD pads and copper graphics on the layer.
  const lb = mkBoard([mkFp("U7", [{ ...mkPad("1", 0, 0, 0.5, 0.5, "SIG"), layers: ["In2.Cu"] }])], { graphics: [{ kind: "poly", layer: "In2.Cu", w: 0, pts: rect(3, 3, 1, 1), net: "SIG2" }] });
  const lr = evaluateRules(null, { version: 1, rules: [{ id: "g", kind: "layer_nets", layer: "In2.Cu", nets: "GND" }] }, lb, null, null);
  if (!lr.violations[0]?.items.some((i) => /SMD pad U7\.1/.test(i.description)) || !lr.violations[0]?.items.some((i) => /copper/.test(i.description))) fail("P07: pad or copper graphic on the layer not reported");

  // P08: DNP, a removed pad and a widened pad show up in the comparison.
  const before = mkBoard([mkFp("U1", [mkPad("1", 0, 0), mkPad("2", 1, 0), mkPad("3", 2, 0)])]);
  const after = mkBoard([mkFp("U1", [mkPad("1", 0, 0, 0.9, 0.5), mkPad("2", 1, 0)], { attrs: ["smd", "dnp"] })]);
  const bd = diffBoards(before, after);
  if (!bd.attrs.some((a) => a.ref === "U1" && /dnp/.test(a.to))) fail("P08: DNP change not reported");
  if (!bd.pads.some((p) => p.pad === "3" && p.change === "removed") || !bd.pads.some((p) => p.pad === "1" && p.change === "geometry")) fail(`P08: pad changes not reported (${JSON.stringify(bd.pads)})`);

  // P09: drill read-back compares holes, not counts.
  const exc = "M48\nMETRIC\nT1C9.990\n%\nG90\nT1\nX999.0Y-999.0\nM30\n";
  const mh = matchHoles([{ what: "via", x: 0, y: 0, d: 0.3 }], parseExcellon(exc));
  if (!mh.missing.length || !mh.extra.length) fail("P09: a wrong hole with the right count passed");
  const ok = matchHoles([{ what: "via", x: 1, y: 2, d: 0.3 }, { what: "slot", x: 5, y: 5, d: 0.6, len: 1.7 }], parseExcellon("M48\nT1C0.300\nT2C0.600\n%\nT1\nX1.0Y-2.0\nT2\nX5.0Y-5.55G85X5.0Y-4.45\nM30\n"));
  if (ok.missing.length || ok.extra.length) fail(`P09: correct holes and slot not matched (${JSON.stringify(ok)})`);

  // P10: board size follows the cut-line centre, not the drawing stroke.
  const eb = parseBoard("t.kicad_pcb", `(kicad_pcb (version 20250114) (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    (gr_rect (start 0 0) (end 10 5) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "e1")))`);
  if (Math.abs(eb.bbox[2] - eb.bbox[0] - 10) > 1e-9 || Math.abs(eb.bbox[3] - eb.bbox[1] - 5) > 1e-9) fail(`P10: board extent ${JSON.stringify(eb.bbox)} includes the stroke`);

  // P11: crossing pads overlap (gap 0), even with no vertex inside the other.
  const cross1: any = { ...mkPad("1", 0, 0, 2, 0.1) }, cross2: any = { ...mkPad("2", 0, 0, 0.1, 2) };
  if (padGap(cross1, cross2) !== 0) fail(`P11: crossing pads report gap ${padGap(cross1, cross2)}`);
  const apart: any = mkPad("3", 3, 0, 0.5, 0.5);
  if (Math.abs(padGap(mkPad("4", 0, 0, 0.5, 0.5) as any, apart) - 2.5) > 1e-9) fail("P11: gap between separated pads wrong");

  // P13: inputs that change while a package is made are detected.
  const inF = join(tmpd, "in.kicad_pcb");
  writeFileSync(inF, "a");
  const h0 = hashInputs([inF]);
  if (changedInputs(h0).length) fail("P13: unchanged input reported as changed");
  writeFileSync(inF, "b");
  if (changedInputs(h0).join() !== "in.kicad_pcb") fail("P13: changed input not detected");
  console.log("  done");
}

// P13 end to end on a copy: a save during the export marks the package INVALID.
const releaseTest = (async () => {
  const src = join(root, "demo-stickhub");
  if (!existsSync(src)) return;
  console.log("release input binding (copy of demo-stickhub)");
  const dir = mkdtempSync(join(tmpdir(), "slashpcb-rel-"));
  cpSync(src, join(dir, "p"), { recursive: true });
  const pd = join(dir, "p"), pcb = join(pd, "StickHub.kicad_pcb");
  const b = parseBoard(pcb);
  const inputs = hashInputs([pcb, join(pd, "StickHub.kicad_pro"), join(pd, "StickHub.kicad_sch")]);
  const out = join(dir, "out");
  let threw = "";
  try {
    await exportRelease({ profileId: "generic", board: b, schematic: null, erc: null, drc: null, projectDir: pd, shadowDir: pd, pcb: "StickHub.kicad_pcb", sourceFiles: Object.keys(inputs),
      outDir: out, appVersion: "test", kicadVersion: null, timeoutMs: 120000, review: false, step: false, inputHashes: inputs,
      afterExports: () => writeFileSync(pcb, readFileSync(pcb, "utf8") + "\n") });
  } catch (e: any) { threw = e?.message ?? String(e); }
  if (!/changed while the package was made/.test(threw)) fail(`P13: a save during export was not detected (${threw || "no error"})`);
  if (existsSync(join(out, "MANIFEST.json")) || !existsSync(join(`${out}-INVALID`, "INVALID.txt"))) fail("P13: the package was not marked INVALID");
  // Unchanged inputs: the package is written and its read-back matches every hole.
  const b2 = parseBoard(pcb), in2 = hashInputs(Object.keys(inputs));
  const r = await exportRelease({ profileId: "generic", board: b2, schematic: null, erc: null, drc: null, projectDir: pd, shadowDir: pd, pcb: "StickHub.kicad_pcb", sourceFiles: Object.keys(in2),
    outDir: join(dir, "out2"), appVersion: "test", kicadVersion: null, timeoutMs: 120000, review: false, step: false, inputHashes: in2 });
  const rb = r.preflight.gates.find((g) => g.id === "readback");
  console.log(`  read-back: ${rb?.status} ${rb?.detail}`);
  if (rb?.status !== "pass") fail(`read-back of an unchanged StickHub package: ${rb?.detail}`);
})();

// Live-link identity (Python bridge with fake KiCad documents).
{
  const py = ["/usr/bin/python3", "/usr/bin/python3.13", "python3"].find((x) => x === "python3" || existsSync(x))!;
  const r = spawnSync(py, ["-I", join(__dirname, "..", "..", "test", "bridge_identity.py")], { encoding: "utf8" });
  console.log(`  ${(r.stdout || r.stderr).trim()}`);
  if (r.status !== 0) fail("P01: live-link identity test failed");
}

releaseTest.catch((e) => fail(`release test crashed: ${e?.stack ?? e}`)).then(() => {
  console.log(failed ? `${failed} failure(s)` : "all checks passed");
  process.exit(failed ? 1 : 0);
});
