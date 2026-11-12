// Fabrication/assembly release packages per supplier profile: preflight gates, Gerber + drill,
// BOM and CPL in the supplier's columns, a zip for upload and a manifest with SHA-256 hashes.
//
// Lessons from real projects: an export can look complete while the board is not (parts outside
// the outline, unrouted nets, paste on THT pads), BOM/CPL/board drift apart, and bottom-side
// rotations differ per assembler. The gates below make those visible before anything is sent.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { BoardModel, CheckReport, Footprint, SchematicModel } from "../../shared/types";
import { kicadEnv, runCli } from "./cli";
import { notesSummary, partKey, type PartNote } from "./partnotes";

export interface SupplierProfile {
  id: string;
  name: string;
  note: string;
  needsPartNumber: "lcsc" | "mpn" | "none";
  bomColumns: string[];
  cplColumns: string[];
  cplLayer: { top: string; bottom: string };
  rotationField?: string[]; // per-footprint rotation offset fields (assembler-specific)
  caps?: SupplierCaps; // documented manufacturing limits; user overrides in Settings › Release tab
}

/** Manufacturing limits for a supplier/process. Only values someone verified belong here. */
export interface SupplierCaps {
  minTrack?: number; minGap?: number; minDrill?: number; minRing?: number; minViaDiameter?: number;
  minMaskWeb?: number; thicknesses?: number[]; tenting?: boolean; source?: string;
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
    id: "aisler", name: "Aisler", needsPartNumber: "mpn",
    note: "Gerber + Excellon zip with BOM and CPL in generic columns. Limits from Aisler's published 4-layer ENIG rules as recorded in a project review (Nov 2026): 0.125 mm minimum gap, 0.1 mm minimum mask web, no via tenting (via rings stay open). Confirm against Aisler's current rules.",
    bomColumns: ["Designator", "Qty", "Value", "Footprint", "Manufacturer", "MPN"],
    cplColumns: ["Designator", "Mid X", "Mid Y", "Rotation", "Layer"],
    cplLayer: { top: "top", bottom: "bottom" },
    caps: { minGap: 0.125, minMaskWeb: 0.1, tenting: false, thicknesses: [0.8, 1.6], source: "Aisler 4-layer ENIG rules as recorded 2026-11; verify" },
  },
  {
    id: "danishpcb", name: "DanishPCB", needsPartNumber: "mpn",
    note: "Gerber + Excellon zip with BOM and CPL in generic columns. Limits as DanishPCB stated them for a prototype review (Oct 2026): drill ≥ 0.25 mm, annular ring ≥ 0.15 mm, copper gap ≥ 0.125 mm. Confirm for your order.",
    bomColumns: ["Designator", "Qty", "Value", "Footprint", "Manufacturer", "MPN"],
    cplColumns: ["Designator", "Mid X", "Mid Y", "Rotation", "Layer"],
    cplLayer: { top: "top", bottom: "bottom" },
    caps: { minDrill: 0.25, minRing: 0.15, minGap: 0.125, source: "DanishPCB statement for a prototype review, 2026-10; verify" },
  },
  {
    id: "eurocircuits", name: "Eurocircuits", needsPartNumber: "mpn",
    note: "Gerber + Excellon zip with BOM and CPL in generic columns. Enter the limits of the Eurocircuits pool/class you order in the Release tab.",
    bomColumns: ["Designator", "Qty", "Value", "Footprint", "Manufacturer", "MPN"],
    cplColumns: ["Designator", "Mid X", "Mid Y", "Rotation", "Layer"],
    cplLayer: { top: "top", bottom: "bottom" },
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

export interface PreflightExtras {
  rules?: CheckReport | null; // design invariants
  ignoredChecks?: string[]; // DRC/ERC checks set to "ignore" in the project
  exclusions?: number; // DRC exclusions in the project
  designMinClearance?: number; // board-setup minimum clearance (what DRC enforces)
  polarity?: { total: number; verified: number; errors: { ref: string; text: string }[] };
  caps?: SupplierCaps; // user-provided override of the profile's limits
  viaPaste?: { overlaps: number; holeInPad: number; otherNet: number; refs: string[] };
  testPads?: { total: number; paste: number; blocked: number; refs: string[] };
  duplicateUuids?: number;
  maskWeb?: { minWeb: number; source: string; risky: number; merged: number; narrowest?: number; maskDefined: string[]; refs: string[] };
  partNotes?: Record<string, PartNote>; // offline sourcing notes (slashpcb.parts.json)
}

export interface BoardMinima { minTrack?: number; minDrill?: number; minViaDiameter?: number; minViaRing?: number; minPadRing?: number; vias: number; tentedVias: number; thickness?: number }

/** Smallest manufactured features on the board (from the parsed geometry). */
export function boardMinima(b: BoardModel): BoardMinima {
  const m: BoardMinima = { vias: b.vias.length, tentedVias: 0, thickness: b.thickness };
  const lo = (k: keyof BoardMinima, v: number) => { if (v > 0 && (m[k] === undefined || v < (m[k] as number))) (m as any)[k] = +v.toFixed(4); };
  for (const t of b.tracks) lo("minTrack", t.w);
  const def = b.stackup?.tentingDefault;
  for (const v of b.vias) {
    lo("minDrill", v.drill); lo("minViaDiameter", v.size); lo("minViaRing", (v.size - v.drill) / 2);
    const front = v.tenting?.front && v.tenting.front !== "none" ? v.tenting.front : def?.front;
    const back = v.tenting?.back && v.tenting.back !== "none" ? v.tenting.back : def?.back;
    if (front === "yes" || back === "yes") m.tentedVias++;
  }
  for (const f of b.footprints) for (const p of f.pads) {
    if (!p.drill || p.type !== "thru_hole") continue;
    lo("minDrill", p.drill);
    // Slots: compare each axis (long slot along the long pad side); round holes: the smaller pad side.
    const dMin = p.drillMin ?? p.drill;
    lo("minPadRing", Math.min(Math.min(p.w, p.h) - dMin, Math.max(p.w, p.h) - p.drill) / 2);
  }
  return m;
}

export function effectiveCaps(profileId: string, override?: SupplierCaps): SupplierCaps {
  const base = PROFILES.find((p) => p.id === profileId)?.caps ?? {};
  const o = Object.fromEntries(Object.entries(override ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  return { ...base, ...o };
}

export function preflight(profileId: string, b: BoardModel | null, sch: SchematicModel | null, erc: CheckReport | null, drc: CheckReport | null, x: PreflightExtras = {}): Preflight {
  const profile = PROFILES.find((p) => p.id === profileId) ?? PROFILES[0];
  const gates: Gate[] = [];
  const add = (g: Gate) => gates.push(g);
  if (!b) {
    add({ id: "board", title: "Board file", status: "fail", detail: "This project has no .kicad_pcb." });
    return { profile: profile.id, ok: false, gates, assembled: 0, ranAt: Date.now() };
  }
  // Checks.
  if (!sch) add({ id: "schematic", title: "Schematic", status: "warn", detail: "No schematic in this project: ERC, schematic ↔ board parity and schematic part checks are NOT covered (missing coverage, not a pass)." });
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
  // Project rules that DRC cannot know.
  if (x.rules) add({ id: "invariants", title: "Design invariants (slashpcb.rules.json)", status: x.rules.errors ? "fail" : x.rules.warnings ? "warn" : "pass",
    detail: x.rules.violations.length ? x.rules.violations.slice(0, 3).map((v) => v.description).join("; ") : "all rules hold", refs: x.rules.violations.flatMap((v) => v.items.map((i) => i.ref).filter(Boolean) as string[]).slice(0, 60) });
  else add({ id: "invariants", title: "Design invariants", status: "warn", detail: "No project rules yet (Checks › Rules). Pin/net, footprint, layer and lock rules turn known constraints into gates." });
  if (x.polarity) {
    const unverified = x.polarity.total - x.polarity.verified;
    add({ id: "polarity", title: "Polarity and pin-1 review", status: x.polarity.errors.length ? "fail" : unverified ? "warn" : "pass",
      detail: x.polarity.errors.length ? `${x.polarity.errors.length} contradiction(s): ${x.polarity.errors.slice(0, 3).map((e) => `${e.ref} ${e.text}`).join("; ")}` : `${x.polarity.verified} of ${x.polarity.total} polarized parts verified by you`,
      refs: x.polarity.errors.map((e) => e.ref) });
  }
  if ((x.exclusions ?? 0) > 0 || (x.ignoredChecks ?? []).length) add({ id: "suppressed", title: "Suppressed checks", status: "warn",
    detail: `${x.exclusions ?? 0} DRC exclusion(s); checks set to ignore: ${(x.ignoredChecks ?? []).join(", ") || "none"}. A suppressed check is not a pass.` });
  // Supplier limits versus the board.
  const caps = effectiveCaps(profile.id, x.caps);
  const mins = boardMinima(b);
  const capKeys = ["minTrack", "minGap", "minDrill", "minRing", "minViaDiameter"] as const;
  if (!capKeys.some((k) => caps[k] !== undefined) && caps.tenting === undefined && !caps.thicknesses) {
    add({ id: "limits", title: "Supplier limits", status: "warn", detail: `No manufacturing limits known for ${profile.name}; enter them in the Release tab. Board minima: track ${mins.minTrack ?? "–"}, drill ${mins.minDrill ?? "–"}, via ring ${mins.minViaRing ?? "–"} mm.` });
  } else {
    const bad: string[] = [];
    const chk = (label: string, have: number | undefined, need: number | undefined) => { if (need !== undefined && have !== undefined && have + 1e-6 < need) bad.push(`${label} ${have} < ${need}`); };
    chk("track", mins.minTrack, caps.minTrack); chk("drill", mins.minDrill, caps.minDrill); chk("via ring", mins.minViaRing, caps.minRing);
    chk("pad ring", mins.minPadRing, caps.minRing); chk("via diameter", mins.minViaDiameter, caps.minViaDiameter);
    if (caps.minGap !== undefined && x.designMinClearance !== undefined && x.designMinClearance + 1e-6 < caps.minGap) bad.push(`board rule min_clearance ${x.designMinClearance} < supplier gap ${caps.minGap} (DRC does not enforce the supplier's gap)`);
    add({ id: "limits", title: `Supplier limits (${profile.name})`, status: bad.length ? "fail" : "pass",
      detail: bad.length ? bad.join("; ") : `track ${mins.minTrack ?? "–"}, drill ${mins.minDrill ?? "–"}, via ring ${mins.minViaRing ?? "–"}, pad ring ${mins.minPadRing ?? "–"} mm within limits${caps.source ? ` (${caps.source})` : ""}` });
  }
  if (caps.thicknesses?.length && mins.thickness) {
    const near = caps.thicknesses.reduce((a, c) => (Math.abs(c - mins.thickness!) < Math.abs(a - mins.thickness!) ? c : a));
    add({ id: "thickness", title: "Board thickness", status: Math.abs(near - mins.thickness) > 0.1 ? "warn" : "pass",
      detail: `design ${mins.thickness} mm → order ${near} mm. Make sure the quote uses this thickness (offers have come back for 1.6 mm on 0.8 mm designs).` });
  } else if (mins.thickness) add({ id: "thickness", title: "Board thickness", status: "pass", detail: `design ${mins.thickness} mm: state it explicitly in the order.` });
  if (x.viaPaste) {
    const vp = x.viaPaste;
    add({ id: "via-paste", title: "Vias at paste openings", status: vp.otherNet || vp.holeInPad ? "warn" : vp.overlaps ? "warn" : "pass",
      detail: vp.overlaps ? `${vp.overlaps} via ring(s) reach a pasted pad (${vp.holeInPad} hole in pad, ${vp.otherNet} on another net${caps.tenting === false ? "; the supplier does not tent, so rings stay open" : ""}): solder can wick into the via. Ask the assembler how they handle them.` : "no via reaches a pasted pad", refs: vp.refs.slice(0, 40) });
  }
  if (x.testPads && x.testPads.total) add({ id: "test-pads", title: "Test pads", status: x.testPads.paste || x.testPads.blocked ? "warn" : "pass",
    detail: `${x.testPads.total} test pads, ${x.testPads.paste} with paste, ${x.testPads.blocked} where a Ø0.5 mm probe touches a neighbour`, refs: x.testPads.refs });
  if (x.duplicateUuids !== undefined) add({ id: "uuids", title: "Unique object IDs", status: x.duplicateUuids ? "fail" : "pass", detail: x.duplicateUuids ? `${x.duplicateUuids} duplicated UUID(s) in the board/schematic (scripted edits or copy-paste); KiCad may mix up objects` : "no duplicates" });
  if (x.partNotes) {
    const s = notesSummary(assembled, x.partNotes);
    const bad = s.lifecycle.length;
    add({ id: "part-notes", title: "Sourcing notes", status: bad || s.unknownLifecycle.length ? "warn" : "pass",
      detail: !s.noted ? "No sourcing notes yet (Parts tab): lifecycle, consigned parts, alternates and lead times are optional." :
        [`${s.noted} placed part(s) with notes`, bad && `${bad} not active (${s.lifecycle.slice(0, 6).map((l) => `${l.ref} ${l.status.toUpperCase()}`).join(", ")}${bad > 6 ? ", …" : ""})`,
          s.missingAlternates.length && `${s.missingAlternates.length} of them without an approved alternate`, s.unknownLifecycle.length && `${s.unknownLifecycle.length} with unknown lifecycle`,
          s.consigned.length && `${s.consigned.length} customer-supplied (send them with the order)`].filter(Boolean).join("; "),
      refs: [...s.lifecycle.map((l) => l.ref), ...s.consigned, ...s.unknownLifecycle].slice(0, 60) });
  }
  if (x.maskWeb) {
    const m = x.maskWeb;
    add({ id: "mask-web", title: "Solder-mask webs", status: m.risky ? "warn" : "pass",
      detail: (m.risky ? `${m.risky} pad pair(s) on different nets with a mask web below ${m.minWeb} mm (${m.merged} merged openings): CAM will usually remove these webs, leaving no mask between the pads.` : `no web between different nets below ${m.minWeb} mm${m.narrowest !== undefined ? `; narrowest ${m.narrowest} mm` : ""}.`)
        + ` Threshold: ${m.source}.` + (m.maskDefined.length ? ` Mask-defined lands on ${m.maskDefined.join(", ")}: state this to the fabricator.` : ""),
      refs: [...m.refs, ...m.maskDefined].slice(0, 40) });
  }
  if (caps.tenting === false && mins.tentedVias > 0) add({ id: "tenting", title: "Via tenting", status: "warn",
    detail: `${mins.tentedVias} via(s) are tented in the design, but ${profile.name} does not tent: rings will be exposed. Check vias next to paste openings and contacts.` });
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
  extras?: PreflightExtras; review?: boolean; step?: boolean;
  /** Hashes of the input files taken before the checks ran; the package is bound to these bytes. */
  inputHashes?: Record<string, string>;
  /** Test hook: runs after the exports, before the final input check. */
  afterExports?: () => void;
}): Promise<ReleaseResult> {
  const t0 = Date.now();
  const inputs = o.inputHashes ?? hashInputs(o.sourceFiles);
  const stale = () => changedInputs(inputs);
  if (stale().length) throw new Error(`the project changed after its checks ran (${stale().join(", ")}); run the release again`);
  const profile = PROFILES.find((p) => p.id === o.profileId) ?? PROFILES[0];
  const pf = preflight(profile.id, o.board, o.schematic, o.erc, o.drc, o.extras);
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
  // Sourcing notes next to the BOM (the supplier's BOM template stays unchanged).
  const notes = o.extras?.partNotes ?? {};
  let sourcingFile: string | null = null;
  const noted = [...groups.values()].map((g) => ({ g, n: notes[partKey(g[0])] })).filter((e) => e.n);
  if (noted.length) {
    const rows = [["Designator", "Qty", "Value", "Manufacturer", "MPN", "Lifecycle", "Customer-supplied", "Approved alternates", "Lead time (days)", "Quote unit price", "Quote currency", "Quote qty", "Quote supplier", "Quote date", "Note"]];
    for (const { g, n } of noted.sort((a, c) => natural(a.g[0].ref, c.g[0].ref))) {
      const f = g[0], q = n!.quote;
      rows.push([g.map((x) => x.ref).sort(natural).join(","), String(g.length), f.value, field(f.fields, MFR_FIELDS), field(f.fields, MPN_FIELDS), n!.lifecycle ?? "", n!.consigned ? "yes" : "",
        (n!.alternates ?? []).join(" / "), n!.leadTimeDays !== undefined ? String(n!.leadTimeDays) : "", q?.unitPrice !== undefined ? String(q.unitPrice) : "", q?.currency ?? "", q?.qty ? String(q.qty) : "", q?.supplier ?? "", q?.date ?? "", n!.note ?? ""]);
    }
    sourcingFile = join(o.outDir, `${stem}-sourcing-notes.csv`);
    writeFileSync(sourcingFile, csv(rows));
  }

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
  // Read the exports back: the files must describe this board, not just exist.
  pf.gates.push(readBack(gerberDir, b, stem));
  pf.ok = !pf.gates.some((g) => g.status === "fail");

  // Review material for the supplier and for you: assembly drawings, every layer, PCBA STEP, build spec.
  const extra: string[] = [];
  if (o.review !== false) {
    const rev = join(o.outDir, "review");
    mkdirSync(rev, { recursive: true });
    const soft = async (what: string, args: string[], out: string) => {
      const r = await runCli(args, o.shadowDir, o.timeoutMs).catch((e) => ({ code: -1, stderr: String(e), stdout: "" }));
      if (r.code === 0 && existsSync(out)) extra.push(out); else pf.gates.push({ id: `review-${what}`, title: `Review material: ${what}`, status: "warn", detail: `not generated: ${(r.stderr || r.stdout).trim().slice(-200)}` });
    };
    const top = join(rev, `${stem}-assembly-top.pdf`), bottom = join(rev, `${stem}-assembly-bottom.pdf`);
    await soft("assembly top", ["pcb", "export", "pdf", "--mode-single", "--layers", "F.Fab,F.Silkscreen,Edge.Cuts", "--sp", "--include-border-title", "-o", top, o.pcb], top);
    await soft("assembly bottom", ["pcb", "export", "pdf", "--mode-single", "--mirror", "--layers", "B.Fab,B.Silkscreen,Edge.Cuts", "--sp", "--include-border-title", "-o", bottom, o.pcb], bottom);
    const layerDir = join(rev, "layers");
    mkdirSync(layerDir, { recursive: true });
    const used = [...b.copper, "F.Silkscreen", "B.Silkscreen", "F.Mask", "B.Mask", "F.Paste", "B.Paste", "F.Fab", "B.Fab", "Edge.Cuts"];
    const r = await runCli(["pcb", "export", "svg", "--mode-multi", "--page-size-mode", "2", "--layers", used.join(","), "--cl", "Edge.Cuts", "--drill-shape-opt", "2", "-o", layerDir + "/", o.pcb], o.shadowDir, o.timeoutMs).catch(() => null);
    const svgs = existsSync(layerDir) ? readdirSync(layerDir).filter((f) => f.endsWith(".svg")).sort() : [];
    if (r && svgs.length) {
      const index = join(layerDir, "index.html");
      writeFileSync(index, `<!doctype html><meta charset="utf-8"><title>${stem} layers</title><style>body{font:14px sans-serif;background:#222;color:#eee;margin:16px}figure{display:inline-block;margin:8px;background:#fff;padding:6px}figcaption{color:#222;font-weight:600}img{max-width:46vw;max-height:60vh}</style><h1>${stem} — all layers</h1>${svgs.map((f) => `<figure><img src="${f}"><figcaption>${f.replace(/\.svg$/, "")}</figcaption></figure>`).join("")}\n`);
      extra.push(...svgs.map((f) => join(layerDir, f)), index);
    }
    if (o.step !== false) {
      const step = join(rev, `${stem}-PCBA.step`);
      await soft("PCBA STEP", ["pcb", "export", "step", "--force", "--subst-models", "--no-dnp", "-o", step, o.pcb], step);
    }
  }
  const spec = join(o.outDir, "BUILD_SPEC.md");
  writeFileSync(spec, buildSpec(b, stem, profile, o.extras, parts));
  extra.push(spec);

  // kicad-cli read the live project files: if any input changed while the package was made, the outputs
  // and the checks no longer belong to the same bytes. Never publish such a package.
  o.afterExports?.();
  const changed = stale();
  if (changed.length) {
    writeFileSync(join(o.outDir, "INVALID.txt"), `This package is INVALID and must not be ordered: these inputs changed while it was being made:\n${changed.join("\n")}\n\nRun the release again.\n`);
    const bad = `${o.outDir}-INVALID`;
    try { renameSync(o.outDir, bad); } catch { /* keep the marker in place */ }
    throw new Error(`the project changed while the package was made (${changed.join(", ")}); the folder was marked INVALID. Run the release again.`);
  }

  // Manifest + readme.
  const git = await new Promise<string | null>((res) => execFile("git", ["-C", o.projectDir, "rev-parse", "--short", "HEAD"], { env: kicadEnv(), timeout: 5000 }, (e, out) => res(e ? null : out.trim())));
  const outputs = [...gerbers.map((g) => join(gerberDir, g)), zipFile, bomFile, cplFile, posFile, ...(sourcingFile ? [sourcingFile] : []), ...extra];
  const manifest = {
    format: "slashpcb-release/1", createdAt: new Date().toISOString(), app: `SlashPCB ${o.appVersion}`, kicad: o.kicadVersion,
    profile: { id: profile.id, name: profile.name }, board: { file: basename(o.pcb), title: b.title, rev: b.rev, sizeMm: [+(b.bbox[2] - b.bbox[0]).toFixed(3), +(b.bbox[3] - b.bbox[1]).toFixed(3)], copperLayers: b.copper.length, thicknessMm: b.thickness },
    projectGit: git, status: pf.ok ? "PREFLIGHT_PASSED_NOT_RELEASED" : "PREFLIGHT_FAILED_DO_NOT_ORDER",
    preflight: pf.gates.map((g) => ({ id: g.id, status: g.status, detail: g.detail, refs: g.refs?.slice(0, 50) })),
    // The bytes the checks ran on (verified unchanged after the exports).
    sources: Object.entries(inputs).filter(([, h]) => h !== "missing").map(([f, h]) => ({ file: relative(o.projectDir, f).split("\\").join("/"), sha256: h, bytes: statSync(f).size })),
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
    ...(sourcingFile ? ["", `Sourcing notes (lifecycle, customer-supplied parts, approved alternates): ${basename(sourcingFile)}`] : []),
    "",
    "For the supplier and for review: BUILD_SPEC.md (stack, finish, limits, assembly notes), review/ (assembly drawings top and bottom, every layer with index.html, PCBA STEP).",
    "Coordinates: CPL in KiCad's absolute millimetres, X right and Y up, bottom-side X not mirrored; rotations are KiCad's (plus the profile's offsets).",
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

/** Read the generated Gerber job file and Excellon drills back and compare them with the board. */
export function readBack(gerberDir: string, b: BoardModel, stem: string): Gate {
  const problems: string[] = [];
  const notes: string[] = [];
  const files = existsSync(gerberDir) ? readdirSync(gerberDir) : [];
  const job = files.find((f) => f.endsWith(".gbrjob"));
  if (!job) problems.push("no Gerber job file");
  else {
    try {
      const j = JSON.parse(readFileSync(join(gerberDir, job), "utf8"));
      const fns: string[] = (j.FilesAttributes ?? []).map((f: any) => String(f.FileFunction ?? ""));
      const layers = Number(j.GeneralSpecs?.LayerNumber ?? 0);
      if (layers !== b.copper.length) problems.push(`job says ${layers} copper layers, board has ${b.copper.length}`);
      for (let i = 1; i <= b.copper.length; i++) if (!fns.some((f) => f.startsWith(`Copper,L${i},`))) problems.push(`copper L${i} missing`);
      for (const need of ["SolderMask,Top", "SolderMask,Bot", "Legend,Top", "Legend,Bot", "Profile"]) if (!fns.some((f) => f.startsWith(need))) problems.push(`${need} missing`);
      const size = j.GeneralSpecs?.Size;
      if (size && (Math.abs(size.X - (b.bbox[2] - b.bbox[0])) > 0.2 || Math.abs(size.Y - (b.bbox[3] - b.bbox[1])) > 0.2)) problems.push(`job size ${size.X}×${size.Y} differs from the board`);
      if (j.GeneralSpecs?.BoardThickness) notes.push(`job thickness ${j.GeneralSpecs.BoardThickness} mm`);
      notes.push(`${fns.length} Gerber files in the job`);
    } catch (e: any) { problems.push(`Gerber job unreadable: ${e?.message ?? e}`); }
  }
  // Every Gerber the job lists must exist and be non-empty (job metadata alone proves nothing).
  if (job) {
    try {
      const j = JSON.parse(readFileSync(join(gerberDir, job), "utf8"));
      for (const fa of j.FilesAttributes ?? []) {
        const path = String(fa.Path ?? "");
        if (!path || !files.includes(path)) problems.push(`job lists ${path || "a file without a path"}, which was not written`);
        else if (statSync(join(gerberDir, path)).size < 64 || !/%FS|%MO|G04/.test(readFileSync(join(gerberDir, path), "utf8").slice(0, 4000))) problems.push(`${path} is empty or not a Gerber file`);
      }
    } catch { /* reported above */ }
  }
  // Drill read-back: every expected hole (via, plated pad hole, non-plated hole, slot) must appear in the
  // right file at its position with its tool diameter (slots: tool = slot width, length end to end).
  const read = (suffix: string) => { const f = files.find((x) => x.endsWith(suffix)); return f ? parseExcellon(readFileSync(join(gerberDir, f), "utf8")) : null; };
  const pth = read("-PTH.drl"), npth = read("-NPTH.drl");
  const expPth: ExpectedHole[] = [], expNpth: ExpectedHole[] = [];
  for (const v of b.vias) if (!v.type || v.type === "through") expPth.push({ what: `via ${v.net || ""} (${v.x}, ${v.y})`.replace("  ", " "), x: v.x, y: v.y, d: v.drill });
  for (const f of b.footprints) for (const p of f.pads) {
    if (!p.drill || (p.type !== "thru_hole" && p.type !== "np_thru_hole")) continue;
    const [hx, hy] = p.hole ?? [p.x, p.y];
    const slot = p.drillMin !== undefined && p.drillMin !== p.drill;
    const h: ExpectedHole = { what: `${f.ref}.${p.num}`, x: hx, y: hy, d: slot ? p.drillMin! : p.drill, len: slot ? p.drill : undefined };
    (p.type === "np_thru_hole" ? expNpth : expPth).push(h);
  }
  const check = (label: string, exp: ExpectedHole[], got: DrillHit[] | null) => {
    if (!got) { if (exp.length) problems.push(`no ${label} drill file`); return; }
    const r = matchHoles(exp, got);
    if (r.missing.length) problems.push(`${label}: ${r.missing.length} expected hole(s) not found at their position with their size (${r.missing.slice(0, 4).join("; ")}${r.missing.length > 4 ? " …" : ""})`);
    if (r.extra.length) problems.push(`${label}: ${r.extra.length} hole(s) in the file that the board does not have (${r.extra.slice(0, 3).join("; ")})`);
    if (!r.missing.length && !r.extra.length) notes.push(`${got.length} ${label} holes match the board by position and tool (largest diameter rounding ${r.maxRound.toFixed(4)} mm)`);
  };
  check("plated", expPth, pth);
  check("non-plated", expNpth, npth);
  void stem;
  const uniq = [...new Set(problems)];
  return { id: "readback", title: "Exports read back", status: uniq.length ? "fail" : "pass", detail: uniq.length ? uniq.join("; ") : notes.join("; ") };
}

/** SHA-256 per input file ("missing" for absent files). */
export function hashInputs(files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [...new Set(files)].sort()) out[f] = existsSync(f) ? sha256(f) : "missing";
  return out;
}
/** Inputs whose bytes differ from `before` (or that appeared/disappeared). */
export function changedInputs(before: Record<string, string>): string[] {
  return Object.entries(before).filter(([f, h]) => (existsSync(f) ? sha256(f) : "missing") !== h).map(([f]) => basename(f));
}

export interface DrillHit { x: number; y: number; d: number; len?: number }
interface ExpectedHole { what: string; x: number; y: number; d: number; len?: number }

/** Excellon (KiCad: metric, decimal, absolute) → holes in board coordinates (Y down) with tool diameters. Slots: G85 or M15/M16 routes. */
export function parseExcellon(text: string): DrillHit[] {
  const tools = new Map<string, number>();
  const out: DrillHit[] = [];
  let tool = 0, start: [number, number] | null = null;
  const xy = (s: string) => { const m = /X(-?[\d.]+)Y(-?[\d.]+)/.exec(s); return m ? [Number(m[1]), -Number(m[2])] as [number, number] : null; };
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith(";")) continue;
    let m = /^T(\d+)C([\d.]+)/.exec(l);
    if (m) { tools.set(m[1], Number(m[2])); continue; }
    m = /^T(\d+)$/.exec(l);
    if (m) { tool = tools.get(m[1]) ?? 0; continue; }
    if (l.includes("G85")) {
      const [a, c] = l.split("G85").map(xy);
      if (a && c) out.push({ x: (a[0] + c[0]) / 2, y: (a[1] + c[1]) / 2, d: tool, len: Math.hypot(c[0] - a[0], c[1] - a[1]) + tool });
      continue;
    }
    if (/^G00/.test(l)) { start = xy(l); continue; }
    if (/^G01/.test(l) && start) { const e = xy(l); if (e) out.push({ x: (start[0] + e[0]) / 2, y: (start[1] + e[1]) / 2, d: tool, len: Math.hypot(e[0] - start[0], e[1] - start[1]) + tool }); start = null; continue; }
    if (/^X-?[\d.]+Y-?[\d.]+$/.test(l)) { const p = xy(l)!; out.push({ x: p[0], y: p[1], d: tool }); }
  }
  return out;
}

/** One-to-one matching of expected holes to drilled hits (position ≤ 0.005 mm, diameter and slot length ≤ 0.005 mm). */
export function matchHoles(exp: ExpectedHole[], got: DrillHit[], posTol = 0.005, dTol = 0.005): { missing: string[]; extra: string[]; maxRound: number } {
  const used = new Set<number>();
  const missing: string[] = [];
  let maxRound = 0;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;
  got.forEach((g, i) => { const k = key(g.x, g.y); (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  for (const e of exp) {
    let hit = -1;
    for (let dx = -1; dx <= 1 && hit < 0; dx++) for (let dy = -1; dy <= 1 && hit < 0; dy++) {
      for (const i of grid.get(`${Math.round(e.x) + dx},${Math.round(e.y) + dy}`) ?? []) {
        const g = got[i];
        if (used.has(i) || Math.hypot(g.x - e.x, g.y - e.y) > posTol || Math.abs(g.d - e.d) > dTol) continue;
        if ((e.len === undefined) !== (g.len === undefined) || (e.len !== undefined && Math.abs(e.len - g.len!) > dTol)) continue;
        hit = i; break;
      }
    }
    if (hit < 0) { missing.push(`${e.what} Ø${e.d}${e.len ? `×${e.len}` : ""}`); continue; }
    used.add(hit);
    maxRound = Math.max(maxRound, Math.abs(got[hit].d - e.d));
  }
  const extra = got.map((g, i) => (used.has(i) ? null : `Ø${g.d} at (${+g.x.toFixed(3)}, ${+g.y.toFixed(3)})`)).filter((x): x is string => !!x);
  return { missing, extra, maxRound };
}

/** A build specification the supplier can read next to the Gerbers. */
export function buildSpec(b: BoardModel, stem: string, profile: SupplierProfile, x: PreflightExtras | undefined, parts: Footprint[]): string {
  const su = b.stackup;
  const mins = boardMinima(b);
  const caps = effectiveCaps(profile.id, x?.caps);
  const cu = su?.layers.filter((l) => l.type === "copper") ?? [];
  const noPaste = b.footprints.filter((f) => isPcbFeature(f) && f.pads.length && f.ref && !f.ref.startsWith("#")).sort((a, c) => natural(a.ref, c.ref));
  const bottom = parts.filter((f) => f.side === "B").length;
  const fine = parts.filter((f) => f.pads.length >= 8 && f.pads.some((p) => Math.min(p.w, p.h) <= 0.3)).map((f) => f.ref);
  const dnp = b.footprints.filter((f) => f.attrs.includes("dnp")).map((f) => f.ref);
  const notes = notesSummary(parts, x?.partNotes ?? {});
  const consigned = [...new Set([...notes.consigned, ...parts.filter((f) => /consign|customer|kund/i.test(Object.entries(f.fields).map(([k, v]) => `${k}=${v}`).join(" "))).map((f) => f.ref)])].sort(natural);
  const alternates = [...new Map(parts.map((f) => [partKey(f), f])).entries()].map(([k, f]) => ({ f, n: x?.partNotes?.[k] })).filter((e) => e.n?.alternates?.length);
  const L: (string | null)[] = [
    `# ${stem} — fabrication and assembly specification`,
    "",
    `Generated by SlashPCB for ${profile.name} from the KiCad board. Review it against the order form; the supplier's CAM/DFM report is authoritative. No order, payment or supplier acceptance is implied.`,
    "",
    "## Fabrication",
    "",
    `- Board: ${(b.bbox[2] - b.bbox[0]).toFixed(2)} × ${(b.bbox[3] - b.bbox[1]).toFixed(2)} mm, ${b.copper.length} copper layers (${b.copper.join(" / ")}). Design thickness ${b.thickness ?? "?"} mm: order this thickness, do not substitute.`,
    su?.finish ? `- Surface finish: ${su.finish}.` : "- Surface finish: not set in the board stackup (set it in KiCad › Board Setup › Physical Stackup).",
    `- Solder mask: top ${su?.maskColorTop ?? "?"}, bottom ${su?.maskColorBottom ?? "?"}. Silkscreen: top ${su?.silkColorTop ?? "?"}, bottom ${su?.silkColorBottom ?? "?"}.`,
    cu.length ? `- Copper: ${cu.map((l) => `${l.name} ${l.thickness ? `${(l.thickness * 1000).toFixed(1)} µm` : "?"}`).join(", ")}.` : null,
    su?.layers.some((l) => l.type !== "copper" && l.thickness) ? `- Dielectrics: ${su!.layers.filter((l) => /prepreg|core/i.test(l.type)).map((l) => `${l.name} ${l.thickness} mm ${l.material ?? ""}`.trim()).join("; ")}. Confirm the supplier's actual stack and any impedance targets.` : null,
    `- Smallest features: track ${mins.minTrack ?? "–"} mm, drill ${mins.minDrill ?? "–"} mm, via ${mins.minViaDiameter ?? "–"} mm with ring ${mins.minViaRing ?? "–"} mm, plated pad ring ${mins.minPadRing ?? "–"} mm. Board rule minimum clearance ${x?.designMinClearance ?? "?"} mm.`,
    `- Vias: ${mins.vias}, of which ${mins.tentedVias} tented in the design.${caps.tenting === false ? ` ${profile.name} does not tent vias: rings will be exposed.` : ""}`,
    caps.source ? `- Supplier limits used for the checks: ${[caps.minTrack && `track ${caps.minTrack}`, caps.minGap && `gap ${caps.minGap}`, caps.minDrill && `drill ${caps.minDrill}`, caps.minRing && `ring ${caps.minRing}`, caps.minMaskWeb && `mask web ${caps.minMaskWeb}`].filter(Boolean).join(", ")} mm (${caps.source}).` : null,
    x?.maskWeb ? `- Solder-mask webs: narrowest between different nets ${x.maskWeb.narrowest ?? "–"} mm; ${x.maskWeb.risky} pair(s) below ${x.maskWeb.minWeb} mm.${x.maskWeb.maskDefined.length ? ` Mask-defined lands (negative mask expansion, keep the mask openings as drawn): ${x.maskWeb.maskDefined.join(", ")}.` : ""}` : null,
    noPaste.length ? `- ${noPaste.length} board-only pad groups have no paste and must stay as supplied (contacts, test pads, jumpers, edge fingers): ${noPaste.slice(0, 40).map((f) => f.ref).join(", ")}${noPaste.length > 40 ? " …" : ""}. Do not cover them with labels or markings.` : null,
    "- The Gerbers describe one unpanelized board. Please propose rails, fiducials and depanelization outside the outline.",
    "",
    "## Assembly",
    "",
    `- ${parts.length} placed parts (${parts.length - bottom} top, ${bottom} bottom)${bottom ? ": double-sided assembly" : ""}. Use the exact MPNs in the BOM; propose substitutes explicitly, never silently.`,
    "- CPL: KiCad absolute millimetres, X right, Y up, bottom-side X not mirrored, KiCad rotations. Check pin 1 / cathode of every polarized part in your placement preview against the assembly drawings in review/.",
    fine.length ? `- Fine-pitch parts (pads ≤ 0.3 mm): ${fine.join(", ")}. Qualify stencil, paste inspection and X-ray where joints are hidden.` : null,
    dnp.length ? `- Do not place: ${dnp.join(", ")}.` : null,
    consigned.length ? `- Customer-supplied (consigned) parts: ${consigned.join(", ")}. Do not buy these; they arrive with the order.` : null,
    notes.lifecycle.length ? `- Parts not in active production (from our notes): ${notes.lifecycle.map((l) => `${l.ref} ${l.status.toUpperCase()}`).join(", ")}. Tell us before substituting.` : null,
    alternates.length ? `- Approved alternates: ${alternates.map((e) => `${field(e.f.fields, MPN_FIELDS) || e.f.value} → ${e.n!.alternates!.join(" / ")}`).join("; ")}. Any other substitute needs written approval.` : null,
    "",
    "## Not covered",
    "",
    "Function, RF/EMC, thermal behaviour and mechanical fit are not verified by these files. First articles need inspection and bench testing before any larger build.",
    "",
  ];
  return (L.filter((l) => l !== null) as string[]).join("\n");
}
