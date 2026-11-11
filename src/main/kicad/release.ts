// Fabrication/assembly release packages per supplier profile: preflight gates, Gerber + drill,
// BOM and CPL in the supplier's columns, a zip for upload and a manifest with SHA-256 hashes.
//
// Lessons from real projects: an export can look complete while the board is not (parts outside
// the outline, unrouted nets, paste on THT pads), BOM/CPL/board drift apart, and bottom-side
// rotations differ per assembler. The gates below make those visible before anything is sent.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { BoardModel, CheckReport, Footprint, SchematicModel } from "../../shared/types";
import { kicadEnv, runCli } from "./cli";

export interface SupplierProfile {
  id: string;
  name: string;
  note: string;
  needsPartNumber: "lcsc" | "mpn" | "none";
  bomColumns: string[];
  cplColumns: string[];
  cplLayer: { top: string; bottom: string };
  rotationField?: string[]; // per-footprint rotation offset fields (assembler-specific)
}

export const PROFILES: SupplierProfile[] = [
  {
    id: "jlcpcb", name: "JLCPCB", needsPartNumber: "lcsc",
    note: "Gerber + Excellon zip, BOM (Comment, Designator, Footprint, LCSC Part #) and CPL (Designator, Mid X, Mid Y, Layer, Rotation). Rotation offsets from the footprint field “JLCPCB Rotation Offset” are applied. Check every rotation in JLCPCB's placement preview.",
    bomColumns: ["Comment", "Designator", "Footprint", "LCSC Part #"],
    cplColumns: ["Designator", "Mid X", "Mid Y", "Layer", "Rotation"],
    cplLayer: { top: "Top", bottom: "Bottom" },
    rotationField: ["JLCPCB Rotation Offset", "JLC Rotation Offset", "JLC_ROT"],
  },
  {
    id: "pcbway", name: "PCBWay", needsPartNumber: "mpn",
    note: "Gerber + Excellon zip, BOM (Item #, Designator, Qty, Manufacturer, Mfg Part #, Description / Value, Package/Footprint, Type) and CPL (Designator, Mid X, Mid Y, Layer, Rotation).",
    bomColumns: ["Item #", "Designator", "Qty", "Manufacturer", "Mfg Part #", "Description / Value", "Package/Footprint", "Type"],
    cplColumns: ["Designator", "Mid X", "Mid Y", "Layer", "Rotation"],
    cplLayer: { top: "Top", bottom: "Bottom" },
  },
  {
    id: "generic", name: "Generic (KiCad native)", needsPartNumber: "mpn",
    note: "Gerber + Excellon, KiCad's own position file, and a BOM with all fields. For assemblers without a dedicated profile.",
    bomColumns: ["Designator", "Qty", "Value", "Footprint", "Manufacturer", "MPN", "LCSC", "DNP"],
    cplColumns: ["Designator", "Value", "Footprint", "Mid X", "Mid Y", "Rotation", "Layer"],
    cplLayer: { top: "top", bottom: "bottom" },
  },
];

export type GateStatus = "pass" | "warn" | "fail";
export interface Gate { id: string; title: string; status: GateStatus; detail: string; refs?: string[] }
export interface Preflight { profile: string; ok: boolean; gates: Gate[]; assembled: number; ranAt: number }

const field = (f: Record<string, string>, names: string[]) => names.map((n) => f[n]).find((v) => v && v !== "~")?.trim() ?? "";
export const MPN_FIELDS = ["MPN", "Manufacturer Part Number", "MFR PN", "Mfr PN", "PartNumber", "Part Number", "MANUFACTURER_PART_NUMBER"];
export const LCSC_FIELDS = ["LCSC", "LCSC Part #", "LCSC Part", "JLCPCB Part #", "JLC", "LCSC#"];
const MFR_FIELDS = ["Manufacturer", "MFR", "Mfr", "MANUFACTURER"];

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const isDnp = (f: Footprint) => f.attrs.includes("dnp");
const inBom = (f: Footprint) => !f.attrs.includes("exclude_from_bom") && !f.attrs.includes("board_only") && !!f.ref && !f.ref.startsWith("#");
const inPos = (f: Footprint) => !f.attrs.includes("exclude_from_pos_files") && !isDnp(f) && inBom(f);

/**
 * Board features that are footprints but not parts: no pads at all, or only pads without solder
 * paste and without holes (key/dome contacts, test pads, solder jumpers, edge-connector fingers).
 * An assembler has nothing to place there.
 */
export const isPcbFeature = (f: Footprint) => !f.pads.length || (!f.pads.some((p) => p.layers.some((l) => /Paste$/.test(l))) && !f.pads.some((p) => p.type === "thru_hole"));
const LOOKS_LIKE_PART = /^(C|R|L|U|D|Q|Y|X|F|K|T|IC|LED|RN|FB)\d/i;

/** Parts the assembler places: in the BOM, not DNP, not excluded from position files, not a PCB-only feature. */
export function assembledParts(b: BoardModel): Footprint[] {
  return b.footprints.filter((f) => inBom(f) && inPos(f) && !isPcbFeature(f)).sort((x, y) => natural(x.ref, y.ref));
}

export function preflight(profileId: string, b: BoardModel | null, sch: SchematicModel | null, erc: CheckReport | null, drc: CheckReport | null): Preflight {
  const profile = PROFILES.find((p) => p.id === profileId) ?? PROFILES[0];
  const gates: Gate[] = [];
  const add = (g: Gate) => gates.push(g);
  if (!b) {
    add({ id: "board", title: "Board file", status: "fail", detail: "This project has no .kicad_pcb." });
    return { profile: profile.id, ok: false, gates, assembled: 0, ranAt: Date.now() };
  }
  // Checks.
  if (!erc && sch) add({ id: "erc", title: "ERC", status: "fail", detail: "ERC has not run yet." });
  else if (erc) add({ id: "erc", title: "ERC", status: !erc.ok || erc.errors ? "fail" : erc.warnings ? "warn" : "pass", detail: erc.ok ? `${erc.errors} error(s), ${erc.warnings} warning(s)` : `failed: ${erc.error}` });
  if (!drc) add({ id: "drc", title: "DRC", status: "fail", detail: "DRC has not run yet." });
  else {
    add({ id: "drc", title: "DRC", status: !drc.ok || drc.errors ? "fail" : drc.warnings ? "warn" : "pass", detail: drc.ok ? `${drc.errors} error(s), ${drc.warnings} warning(s)` : `failed: ${drc.error}` });
    add({ id: "unrouted", title: "Unrouted connections", status: (drc.unconnected ?? 0) ? "fail" : "pass", detail: `${drc.unconnected ?? 0} unconnected item(s)` });
    if (sch) add({ id: "parity", title: "Schematic ↔ board parity", status: (drc.parity ?? 0) ? "fail" : "pass", detail: `${drc.parity ?? 0} difference(s)`, refs: drc.violations.filter((v) => v.source === "parity").flatMap((v) => v.items.map((i) => i.ref).filter(Boolean) as string[]) });
  }
  // Geometry.
  const edge = b.graphics.some((g) => g.layer === "Edge.Cuts");
  add({ id: "outline", title: "Board outline", status: edge ? "pass" : "fail", detail: edge ? `${(b.bbox[2] - b.bbox[0]).toFixed(2)} × ${(b.bbox[3] - b.bbox[1]).toFixed(2)} mm` : "No Edge.Cuts outline." });
  const tol = 0.01;
  const outside = b.footprints.filter((f) => inBom(f) && (f.x < b.bbox[0] - tol || f.x > b.bbox[2] + tol || f.y < b.bbox[1] - tol || f.y > b.bbox[3] + tol)).map((f) => f.ref);
  const padsOutside = b.footprints.filter((f) => inBom(f) && !outside.includes(f.ref) && f.pads.some((p) => p.x < b.bbox[0] - tol || p.x > b.bbox[2] + tol || p.y < b.bbox[1] - tol || p.y > b.bbox[3] + tol)).map((f) => f.ref);
  add({ id: "inside", title: "Parts inside the outline", status: outside.length ? "fail" : padsOutside.length ? "warn" : "pass",
    detail: outside.length ? `${outside.length} part(s) outside the board extent` : padsOutside.length ? `${padsOutside.length} part(s) with pads past the board extent (edge connectors?)` : "All part origins and pads inside the board extent (bounding box check).",
    refs: [...outside, ...padsOutside] });
  const thtPaste = b.footprints.filter((f) => !isDnp(f) && f.pads.some((p) => p.type === "thru_hole" && p.layers.some((l) => /Paste$/.test(l)))).map((f) => f.ref);
  add({ id: "tht-paste", title: "No solder paste on through-hole pads", status: thtPaste.length ? "warn" : "pass", detail: thtPaste.length ? `${thtPaste.length} footprint(s) have paste on THT pads (usually unintended)` : "OK", refs: thtPaste });
  // References and parts data.
  const counts = new Map<string, number>();
  for (const f of b.footprints) if (f.ref && !f.ref.startsWith("#")) counts.set(f.ref, (counts.get(f.ref) ?? 0) + 1);
  const dup = [...counts].filter(([, n]) => n > 1).map(([r]) => r);
  const unannotated = b.footprints.filter((f) => /\?$/.test(f.ref)).map((f) => f.ref);
  add({ id: "refs", title: "Unique, annotated references", status: dup.length || unannotated.length ? "fail" : "pass", detail: dup.length || unannotated.length ? `${dup.length} duplicate(s), ${unannotated.length} unannotated` : "OK", refs: [...dup, ...unannotated] });
  const assembled = assembledParts(b);
  const features = b.footprints.filter((f) => inBom(f) && inPos(f) && isPcbFeature(f));
  const suspicious = features.filter((f) => LOOKS_LIKE_PART.test(f.ref) && f.pads.length).map((f) => f.ref);
  add({ id: "pcb-features", title: "PCB-only footprints left out of BOM/CPL", status: suspicious.length ? "warn" : "pass",
    detail: `${features.length} footprint(s) without paste or holes (contacts, test pads, jumpers, edge fingers) are not placed` + (suspicious.length ? `; check ${suspicious.length} that look like parts (missing paste?)` : ""),
    refs: suspicious.length ? suspicious : features.map((f) => f.ref).slice(0, 30) });
  if (profile.needsPartNumber !== "none") {
    const names = profile.needsPartNumber === "lcsc" ? LCSC_FIELDS : MPN_FIELDS;
    const missing = assembled.filter((f) => !field(f.fields, names) && !(profile.needsPartNumber === "lcsc" && field(f.fields, MPN_FIELDS) === "")).map((f) => f.ref);
    const missingStrict = assembled.filter((f) => !field(f.fields, names)).map((f) => f.ref);
    add({ id: "partnumbers", title: profile.needsPartNumber === "lcsc" ? "LCSC part numbers" : "Manufacturer part numbers",
      status: missingStrict.length ? (profile.needsPartNumber === "lcsc" ? "fail" : "warn") : "pass",
      detail: missingStrict.length ? `${missingStrict.length} of ${assembled.length} placed part(s) lack ${profile.needsPartNumber === "lcsc" ? "an LCSC number" : "an MPN"}` : `all ${assembled.length} placed parts have one`, refs: missingStrict.length ? missingStrict : missing });
  }
  if (sch) {
    const schRefs = new Set(sch.symbols.filter((s) => !s.power && s.onBoard).map((s) => s.ref));
    const notOnBoard = [...schRefs].filter((r) => !counts.has(r));
    add({ id: "sch-board", title: "Every schematic part is on the board", status: notOnBoard.length ? "fail" : "pass", detail: notOnBoard.length ? `${notOnBoard.length} missing` : "OK", refs: notOnBoard });
  }
  const bottom = assembled.filter((f) => f.side === "B").length;
  add({ id: "bottom", title: "Bottom-side assembly", status: bottom ? "warn" : "pass", detail: bottom ? `${bottom} part(s) on the bottom: double-sided assembly; check rotations in the supplier's preview` : "single-sided" });
  add({ id: "physical", title: "Physical verification", status: "warn", detail: "Checks are rule-based. They do not prove function, RF/EMC, thermal behaviour or mechanical fit." });
  const ok = !gates.some((g) => g.status === "fail");
  return { profile: profile.id, ok, gates, assembled: assembled.length, ranAt: Date.now() };
}

// ---------------------------------------------------------------- export

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Minimal zip (deflate) writer: enough for Gerber uploads. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc32 = (b: Buffer) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), comp = deflateRawSync(f.data), crc = crc32(f.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

export interface ReleaseResult { dir: string; files: string[]; preflight: Preflight; manifest: string; seconds: number }

/** Writes the package for `profileId` into `outDir` (created; must be empty or new). kicad-cli runs in `shadowDir`. */
export async function exportRelease(o: {
  profileId: string; board: BoardModel; schematic: SchematicModel | null; erc: CheckReport | null; drc: CheckReport | null;
  projectDir: string; shadowDir: string; pcb: string; sourceFiles: string[]; outDir: string; appVersion: string; kicadVersion: string | null; timeoutMs: number;
}): Promise<ReleaseResult> {
  const t0 = Date.now();
  const profile = PROFILES.find((p) => p.id === o.profileId) ?? PROFILES[0];
  const pf = preflight(profile.id, o.board, o.schematic, o.erc, o.drc);
  mkdirSync(o.outDir, { recursive: true });
  if (readdirSync(o.outDir).length) throw new Error(`the output folder is not empty: ${o.outDir}`);
  const stem = basename(o.pcb).replace(/\.kicad_pcb$/i, "");
  const gerberDir = join(o.outDir, "gerber");
  mkdirSync(gerberDir, { recursive: true });
  const b = o.board;
  const layers = [...b.copper, "F.Paste", "B.Paste", "F.Silkscreen", "B.Silkscreen", "F.Mask", "B.Mask", "Edge.Cuts"];
  const fail = (what: string, r: { code: number; stderr: string; stdout: string }) => { if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().slice(-600)}`); };
  fail("Gerber export", await runCli(["pcb", "export", "gerbers", "--layers", layers.join(","), "--subtract-soldermask", "--precision", "6", "-o", gerberDir + "/", o.pcb], o.shadowDir, o.timeoutMs));
  fail("Drill export", await runCli(["pcb", "export", "drill", "--format", "excellon", "--drill-origin", "absolute", "--excellon-units", "mm", "--excellon-zeros-format", "decimal", "--excellon-oval-format", "alternate", "--excellon-separate-th", "--generate-map", "--map-format", "gerberx2", "-o", gerberDir + "/", o.pcb], o.shadowDir, o.timeoutMs));
  const posFile = join(o.outDir, `${stem}-pos-kicad.csv`);
  fail("Position export", await runCli(["pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "--exclude-dnp", "-o", posFile, o.pcb], o.shadowDir, o.timeoutMs));

  // Zip the fabrication files for upload.
  const gerbers = readdirSync(gerberDir).sort();
  const zipFile = join(o.outDir, `${stem}-${profile.id}-gerber.zip`);
  writeFileSync(zipFile, zip(gerbers.map((n) => ({ name: n, data: readFileSync(join(gerberDir, n)) }))));

  // BOM from the board (the assembled truth), grouped.
  const parts = assembledParts(b);
  const groups = new Map<string, Footprint[]>();
  for (const f of parts) {
    const key = [f.value, f.lib, field(f.fields, MPN_FIELDS), field(f.fields, LCSC_FIELDS), field(f.fields, MFR_FIELDS)].join("\u0001");
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const fpName = (f: Footprint) => f.lib.split(":").pop() ?? f.lib;
  const bomRows: string[][] = [profile.bomColumns];
  let item = 0;
  for (const g of [...groups.values()].sort((x, y) => natural(x[0].ref, y[0].ref))) {
    const f = g[0], refs = g.map((x) => x.ref).sort(natural).join(",");
    const type = f.attrs.includes("through_hole") ? "THT" : "SMD";
    const val: Record<string, string> = {
      "Comment": f.value, "Designator": refs, "Footprint": fpName(f), "LCSC Part #": field(f.fields, LCSC_FIELDS),
      "Item #": String(++item), "Qty": String(g.length), "Manufacturer": field(f.fields, MFR_FIELDS), "Mfg Part #": field(f.fields, MPN_FIELDS),
      "Description / Value": f.value, "Package/Footprint": fpName(f), "Type": type,
      "Value": f.value, "MPN": field(f.fields, MPN_FIELDS), "LCSC": field(f.fields, LCSC_FIELDS), "DNP": "",
    };
    bomRows.push(profile.bomColumns.map((c) => val[c] ?? ""));
  }
  const bomFile = join(o.outDir, `${stem}-${profile.id}-bom.csv`);
  writeFileSync(bomFile, csv(bomRows));

  // CPL from KiCad's own position file (exact coordinates), mapped to the profile.
  const posLines = readFileSync(posFile, "utf8").trim().split(/\r?\n/);
  const header = posLines[0].split(",").map((h) => h.replace(/"/g, ""));
  const idx = (n: string) => header.indexOf(n);
  const byRef = new Map(parts.map((f) => [f.ref, f]));
  const cplRows: string[][] = [profile.cplColumns];
  const cplRefs: string[] = [];
  for (const line of posLines.slice(1)) {
    const c = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((x) => x.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    const ref = c[idx("Ref")], fp = byRef.get(ref);
    if (!fp) continue; // excluded from BOM/assembly
    const side = c[idx("Side")] === "bottom" ? "bottom" : "top";
    let rot = Number(c[idx("Rot")]);
    const off = profile.rotationField ? Number(field(fp.fields, profile.rotationField) || 0) : 0;
    rot = ((rot + off) % 360 + 360) % 360;
    const val: Record<string, string> = {
      "Designator": ref, "Mid X": `${Number(c[idx("PosX")]).toFixed(4)}mm`, "Mid Y": `${Number(c[idx("PosY")]).toFixed(4)}mm`,
      "Layer": side === "bottom" ? profile.cplLayer.bottom : profile.cplLayer.top, "Rotation": String(Math.round(rot * 1000) / 1000),
      "Value": c[idx("Val")], "Footprint": c[idx("Package")],
    };
    if (profile.id === "generic") { val["Mid X"] = c[idx("PosX")]; val["Mid Y"] = c[idx("PosY")]; }
    cplRows.push(profile.cplColumns.map((k) => val[k] ?? ""));
    cplRefs.push(ref);
  }
  const cplFile = join(o.outDir, `${stem}-${profile.id}-cpl.csv`);
  writeFileSync(cplFile, csv(cplRows));

  // Consistency: BOM ↔ CPL ↔ board.
  const bomRefs = parts.map((f) => f.ref).sort(natural);
  const missingInCpl = bomRefs.filter((r) => !cplRefs.includes(r));
  pf.gates.push({ id: "bom-cpl", title: "BOM ↔ CPL ↔ board", status: missingInCpl.length ? "fail" : "pass",
    detail: missingInCpl.length ? `${missingInCpl.length} BOM part(s) missing in the CPL` : `${bomRefs.length} placed parts, ${groups.size} BOM lines, CPL complete`, refs: missingInCpl });
  pf.ok = !pf.gates.some((g) => g.status === "fail");

  // Manifest + readme.
  const git = await new Promise<string | null>((res) => execFile("git", ["-C", o.projectDir, "rev-parse", "--short", "HEAD"], { env: kicadEnv(), timeout: 5000 }, (e, out) => res(e ? null : out.trim())));
  const outputs = [...gerbers.map((g) => join(gerberDir, g)), zipFile, bomFile, cplFile, posFile];
  const manifest = {
    format: "slashpcb-release/1", createdAt: new Date().toISOString(), app: `SlashPCB ${o.appVersion}`, kicad: o.kicadVersion,
    profile: { id: profile.id, name: profile.name }, board: { file: basename(o.pcb), title: b.title, rev: b.rev, sizeMm: [+(b.bbox[2] - b.bbox[0]).toFixed(3), +(b.bbox[3] - b.bbox[1]).toFixed(3)], copperLayers: b.copper.length, thicknessMm: b.thickness },
    projectGit: git, status: pf.ok ? "PREFLIGHT_PASSED_NOT_RELEASED" : "PREFLIGHT_FAILED_DO_NOT_ORDER",
    preflight: pf.gates.map((g) => ({ id: g.id, status: g.status, detail: g.detail, refs: g.refs?.slice(0, 50) })),
    sources: o.sourceFiles.filter((f) => existsSync(f)).map((f) => ({ file: relative(o.projectDir, f).split("\\").join("/"), sha256: sha256(f), bytes: statSync(f).size })),
    outputs: outputs.map((f) => ({ file: relative(o.outDir, f).split("\\").join("/"), sha256: sha256(f), bytes: statSync(f).size })),
    counts: { placedParts: parts.length, bomLines: groups.size, bottomParts: parts.filter((f) => f.side === "B").length },
  };
  const manifestFile = join(o.outDir, "MANIFEST.json");
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  const readme = [
    `${stem} — ${profile.name} package`,
    "",
    `Status: ${manifest.status}`,
    `Created ${manifest.createdAt} by ${manifest.app} with KiCad ${o.kicadVersion ?? "?"}${git ? `, project commit ${git}` : ""}.`,
    "",
    "Upload:",
    `  ${basename(zipFile)}  (Gerber + Excellon drill)`,
    `  ${basename(bomFile)}`,
    `  ${basename(cplFile)}`,
    "",
    "Preflight:",
    ...pf.gates.map((g) => `  [${g.status.toUpperCase()}] ${g.title}: ${g.detail}`),
    "",
    profile.note,
    "This package is not a release by itself: review the supplier's DFM report and placement preview before ordering.",
    "",
  ].join("\n");
  writeFileSync(join(o.outDir, "README.txt"), readme);
  return { dir: o.outDir, files: [...outputs, manifestFile, join(o.outDir, "README.txt")], preflight: pf, manifest: manifestFile, seconds: (Date.now() - t0) / 1000 };
}
