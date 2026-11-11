// Offline sourcing notes per part: lifecycle, customer-supplied (consigned), approved alternates, lead
// time, a free note and an optional quote with an explicit currency. Notes are keyed by MPN (or value +
// footprint when there is no MPN), so they apply to every reference of that BOM line. They live in
// slashpcb.parts.json next to the project, or in SlashPCB's state folder for frozen/read-only projects.
// Nothing here is looked up online.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { BoardModel, Footprint, SchematicModel } from "../../shared/types";

export const partsFileName = "slashpcb.parts.json";
export const LIFECYCLES = ["active", "nrnd", "eol", "obsolete", "unknown"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export interface Quote { supplier?: string; unitPrice?: number; currency: string; qty?: number; date?: string }
export interface PartNote {
  lifecycle?: Lifecycle;
  consigned?: boolean; // customer-supplied: the assembler does not buy it
  alternates?: string[]; // approved substitutes (MPNs)
  leadTimeDays?: number;
  note?: string;
  quote?: Quote;
  updatedAt?: string;
}
export interface PartsFile { version: 1; parts: Record<string, PartNote> }

const MPN = ["MPN", "Manufacturer Part Number", "MFR PN", "Mfr PN", "PartNumber", "Part Number", "MANUFACTURER_PART_NUMBER"];
const MFR = ["Manufacturer", "MFR", "Mfr", "MANUFACTURER"];
const LCSC = ["LCSC", "LCSC Part #", "LCSC Part", "JLCPCB Part #", "JLC", "LCSC#"];
const fieldOf = (f: Record<string, string>, names: string[]) => names.map((n) => f[n]).find((v) => v && v !== "~")?.trim() ?? "";

/** The note key of a part: its MPN, else value and footprint. */
export function partKey(p: { value: string; lib: string; fields: Record<string, string> }): string {
  const mpn = fieldOf(p.fields, MPN);
  return mpn ? `mpn:${mpn}` : `vf:${p.value}|${p.lib}`;
}

export function readParts(paths: string[]): { file: string | null; data: PartsFile } {
  for (const f of paths) {
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      if (j && typeof j.parts === "object" && j.parts) return { file: f, data: { version: 1, parts: j.parts } };
    } catch { /* unreadable: treated as empty, never overwritten silently */ }
    return { file: f, data: { version: 1, parts: {} } };
  }
  return { file: null, data: { version: 1, parts: {} } };
}

export function writeParts(file: string, data: PartsFile): void {
  const sorted = Object.fromEntries(Object.entries(data.parts).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })));
  writeFileSync(file, JSON.stringify({ version: 1, note: "SlashPCB sourcing notes (offline): lifecycle, consigned, alternates, lead time, quotes. Keyed by MPN or value|footprint.", parts: sorted }, null, 2) + "\n");
}

/** Validate and normalise a note from a tool or the UI. Throws on bad input. */
export function cleanNote(n: Partial<PartNote> & Record<string, unknown>): PartNote {
  const out: PartNote = {};
  if (n.lifecycle !== undefined && n.lifecycle !== null && String(n.lifecycle) !== "") {
    if (!LIFECYCLES.includes(n.lifecycle as Lifecycle)) throw new Error(`lifecycle must be one of ${LIFECYCLES.join(", ")}`);
    out.lifecycle = n.lifecycle as Lifecycle;
  }
  if (n.consigned) out.consigned = true;
  const alts = Array.isArray(n.alternates) ? n.alternates : typeof n.alternates === "string" ? String(n.alternates).split(/[,;\n]/) : [];
  const a = alts.map((s) => String(s).trim()).filter(Boolean);
  if (a.length) out.alternates = [...new Set(a)];
  if (n.leadTimeDays !== undefined && n.leadTimeDays !== null && String(n.leadTimeDays) !== "") {
    const d = Number(n.leadTimeDays);
    if (!Number.isFinite(d) || d < 0) throw new Error("leadTimeDays must be a non-negative number");
    out.leadTimeDays = Math.round(d);
  }
  if (typeof n.note === "string" && n.note.trim()) out.note = n.note.trim().slice(0, 2000);
  if (n.quote && typeof n.quote === "object") {
    const q = n.quote as Partial<Quote>;
    const has = q.unitPrice !== undefined && q.unitPrice !== null && String(q.unitPrice) !== "";
    if (has) {
      const price = Number(q.unitPrice);
      if (!Number.isFinite(price) || price < 0) throw new Error("quote.unitPrice must be a non-negative number");
      const cur = String(q.currency ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) throw new Error("quote.currency must be an explicit ISO code such as EUR, SEK or USD");
      out.quote = { unitPrice: price, currency: cur };
      if (q.supplier) out.quote.supplier = String(q.supplier).trim().slice(0, 100);
      if (q.qty !== undefined && String(q.qty) !== "" && Number(q.qty) > 0) out.quote.qty = Math.round(Number(q.qty));
      out.quote.date = q.date && /^\d{4}-\d{2}-\d{2}/.test(String(q.date)) ? String(q.date).slice(0, 10) : new Date().toISOString().slice(0, 10);
    }
  }
  return out;
}

export const isEmptyNote = (n: PartNote) => !n.lifecycle && !n.consigned && !n.alternates?.length && n.leadTimeDays === undefined && !n.note && !n.quote;

export interface PartLine {
  key: string; value: string; lib: string; mpn: string; manufacturer: string; lcsc: string;
  refs: string[]; qty: number; placed: number; // placed = not DNP, on the board
  note?: PartNote;
}

/** BOM lines (board first, schematic-only parts added) with their notes. */
export function partLines(b: BoardModel | null, sch: SchematicModel | null, notes: Record<string, PartNote>): PartLine[] {
  const lines = new Map<string, PartLine>();
  const add = (ref: string, value: string, lib: string, fields: Record<string, string>, placed: boolean) => {
    const key = partKey({ value, lib, fields });
    const l = lines.get(key) ?? { key, value, lib, mpn: fieldOf(fields, MPN), manufacturer: fieldOf(fields, MFR), lcsc: fieldOf(fields, LCSC), refs: [], qty: 0, placed: 0 };
    if (l.refs.includes(ref)) return;
    l.refs.push(ref); l.qty++; if (placed) l.placed++;
    lines.set(key, l);
  };
  const seen = new Set<string>();
  for (const f of b?.footprints ?? []) {
    if (!f.ref || f.ref.startsWith("#") || f.attrs.includes("exclude_from_bom") || f.attrs.includes("board_only")) continue;
    seen.add(f.ref);
    add(f.ref, f.value, f.lib, f.fields, !f.attrs.includes("dnp"));
  }
  for (const s of sch?.symbols ?? []) {
    if (s.power || !s.ref || s.ref.startsWith("#") || seen.has(s.ref) || !s.inBom) continue;
    add(s.ref, s.value, s.footprint, s.fields, false);
  }
  const out = [...lines.values()];
  for (const l of out) { l.refs.sort((a, c) => a.localeCompare(c, undefined, { numeric: true })); if (notes[l.key]) l.note = notes[l.key]; }
  return out.sort((a, c) => a.refs[0].localeCompare(c.refs[0], undefined, { numeric: true }));
}

/** Notes summary for the assembled parts (preflight, BUILD_SPEC). */
export function notesSummary(parts: Footprint[], notes: Record<string, PartNote>) {
  const consigned: string[] = [], lifecycle: { ref: string; status: Lifecycle }[] = [], missingAlternates: string[] = [], unknownLifecycle: string[] = [];
  let noted = 0;
  for (const f of parts) {
    const n = notes[partKey(f)];
    if (!n) continue;
    noted++;
    if (n.consigned) consigned.push(f.ref);
    if (n.lifecycle && n.lifecycle !== "active" && n.lifecycle !== "unknown") {
      lifecycle.push({ ref: f.ref, status: n.lifecycle });
      if (!n.alternates?.length) missingAlternates.push(f.ref);
    }
    if (n.lifecycle === "unknown") unknownLifecycle.push(f.ref);
  }
  return { noted, consigned, lifecycle, missingAlternates, unknownLifecycle };
}

export function partsText(lines: PartLine[], onlyNoted = false): string {
  const rows = lines.filter((l) => !onlyNoted || l.note);
  const L = [`Parts: ${lines.length} BOM lines, ${lines.filter((l) => l.note).length} with sourcing notes. Notes are offline (typed by the user or an agent), not live supplier data.`];
  for (const l of rows.slice(0, 300)) {
    const n = l.note;
    const bits = n ? [n.lifecycle && `lifecycle ${n.lifecycle.toUpperCase()}`, n.consigned && "CONSIGNED (customer-supplied)", n.alternates?.length && `alternates ${n.alternates.join(", ")}`,
      n.leadTimeDays !== undefined && `lead time ${n.leadTimeDays} d`, n.quote && `quote ${n.quote.unitPrice} ${n.quote.currency}${n.quote.qty ? ` @${n.quote.qty}` : ""}${n.quote.supplier ? ` ${n.quote.supplier}` : ""} (${n.quote.date})`, n.note && `note: ${n.note}`].filter(Boolean) : [];
    L.push(`${l.key} ×${l.qty} [${l.refs.slice(0, 12).join(",")}${l.refs.length > 12 ? ",…" : ""}] ${l.value}${l.mpn ? ` ${l.manufacturer} ${l.mpn}`.trimEnd() : ""}${bits.length ? ` — ${bits.join("; ")}` : ""}`);
  }
  return L.join("\n");
}
