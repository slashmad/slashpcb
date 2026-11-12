// Minimal, surgical edits of KiCad text files (KiCad 10 has no schematic IPC API yet).
//
// Only the bytes of one property value change, or one property block is inserted, inside the
// top-level item identified by its UUID. Everything else stays byte-identical. Writes are atomic
// (temp file + rename in the same folder).
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, basename, join } from "node:path";

/** Spans [start, end) of the root's direct children that are lists. */
export function topLevelSpans(text: string): { start: number; end: number; head: string }[] {
  const out: { start: number; end: number; head: string }[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) { // skip strings
      i++;
      while (i < text.length && text.charCodeAt(i) !== 34) { if (text.charCodeAt(i) === 92) i++; i++; }
      continue;
    }
    if (c === 40) {
      depth++;
      if (depth === 2) start = i;
    } else if (c === 41) {
      if (depth === 2 && start >= 0) {
        const m = /^\(([A-Za-z_]+)/.exec(text.slice(start, start + 40));
        out.push({ start, end: i + 1, head: m?.[1] ?? "" });
        start = -1;
      }
      depth--;
    }
  }
  return out;
}

export const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** Index just after the end of the direct-child list starting at `open` (an index of "("). */
function listEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) { i++; while (i < text.length && text.charCodeAt(i) !== 34) { if (text.charCodeAt(i) === 92) i++; i++; } continue; }
    if (c === 40) depth++;
    else if (c === 41 && --depth === 0) return i + 1;
  }
  return -1;
}

/** Direct-child property of an item span: value range of (property "Name" "VALUE" …). */
function findProperty(item: string, name: string): { valStart: number; valEnd: number } | null {
  // Direct children of a top-level item sit at depth 2 relative to the file (one level in the item).
  let depth = 0;
  for (let i = 0; i < item.length; i++) {
    const c = item.charCodeAt(i);
    if (c === 34) { i++; while (i < item.length && item.charCodeAt(i) !== 34) { if (item.charCodeAt(i) === 92) i++; i++; } continue; }
    if (c === 40) {
      depth++;
      if (depth === 2 && item.startsWith(`(property ${quote(name)} "`, i)) {
        const vs = i + `(property ${quote(name)} `.length;
        let j = vs + 1;
        while (j < item.length && item.charCodeAt(j) !== 34) { if (item.charCodeAt(j) === 92) j++; j++; }
        return { valStart: vs, valEnd: j + 1 };
      }
    } else if (c === 41) depth--;
  }
  return null;
}

/** Position to insert a new property: after the last direct-child property, else before the item's closing paren. */
function insertPoint(item: string): number {
  let last = -1, depth = 0;
  for (let i = 0; i < item.length; i++) {
    const c = item.charCodeAt(i);
    if (c === 34) { i++; while (i < item.length && item.charCodeAt(i) !== 34) { if (item.charCodeAt(i) === 92) i++; i++; } continue; }
    if (c === 40) { depth++; if (depth === 2 && item.startsWith("(property ", i)) last = listEnd(item, i); }
    else if (c === 41) depth--;
  }
  return last >= 0 ? last : item.lastIndexOf(")");
}

function atomicWrite(file: string, text: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.slashpcb-${process.pid}.tmp`);
  const mode = statSync(file).mode;
  writeFileSync(tmp, text);
  try { chmodSync(tmp, mode & 0o777); } catch { /* not supported */ }
  renameSync(tmp, file);
}

export interface FieldEdit { uuid: string; field: string; value: string }
export interface EditResult { file: string; changed: number; inserted: number; missing: string[] }

/**
 * Set fields on items (placed symbols in .kicad_sch or footprints in .kicad_pcb) found by UUID.
 * kind decides the format of inserted properties. An empty value on a missing field is a no-op.
 */
export function setFields(file: string, kind: "sch" | "pcb", edits: FieldEdit[], at?: (uuid: string) => [number, number]): EditResult {
  const original = readFileSync(file, "utf8");
  let text = original;
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const head = kind === "sch" ? "symbol" : "footprint";
  const spans = topLevelSpans(text).filter((s) => s.head === head);
  const res: EditResult = { file, changed: 0, inserted: 0, missing: [] };
  // Group by item: every edit of one item is applied to that item's text in sequence (offsets are
  // recomputed after each edit), then the item is replaced once. Items are replaced from the end of
  // the file so earlier offsets stay valid.
  const byUuid = new Map<string, FieldEdit[]>();
  for (const e of edits) byUuid.set(e.uuid, [...(byUuid.get(e.uuid) ?? []), e]);
  const jobs: { span: { start: number; end: number }; edits: FieldEdit[] }[] = [];
  for (const [uuid, list] of byUuid) {
    const hits = spans.filter((s) => text.slice(s.start, s.end).includes(`(uuid ${quote(uuid)})`));
    if (hits.length !== 1) { res.missing.push(hits.length ? `${uuid} (ambiguous: ${hits.length} items)` : uuid); continue; }
    jobs.push({ span: hits[0], edits: list });
  }
  jobs.sort((a, b) => b.span.start - a.span.start);
  for (const { span, edits: list } of jobs) {
    let item = text.slice(span.start, span.end);
    for (const e of list) {
      const prop = findProperty(item, e.field);
      if (prop) {
        if (item.slice(prop.valStart, prop.valEnd) === quote(e.value)) continue;
        item = item.slice(0, prop.valStart) + quote(e.value) + item.slice(prop.valEnd);
        res.changed++;
      } else {
        if (!e.value) continue;
        const [x, y] = at?.(e.uuid) ?? [0, 0];
        const t = (n: number) => "\t".repeat(n);
        const block = kind === "sch"
          ? [`${t(2)}(property ${quote(e.field)} ${quote(e.value)}`, `${t(3)}(at ${x} ${y} 0)`, `${t(3)}(hide yes)`, `${t(3)}(effects`, `${t(4)}(font`, `${t(5)}(size 1.27 1.27)`, `${t(4)})`, `${t(3)})`, `${t(2)})`]
          : [`${t(2)}(property ${quote(e.field)} ${quote(e.value)}`, `${t(3)}(at 0 0 0)`, `${t(3)}(unlocked yes)`, `${t(3)}(layer "F.Fab")`, `${t(3)}(hide yes)`, `${t(3)}(uuid ${quote(randomUUID())})`, `${t(3)}(effects`, `${t(4)}(font`, `${t(5)}(size 1 1)`, `${t(5)}(thickness 0.15)`, `${t(4)})`, `${t(3)})`, `${t(2)})`];
        const ip = insertPoint(item);
        item = item.slice(0, ip) + nl + block.join(nl) + item.slice(ip);
        res.inserted++;
      }
    }
    text = text.slice(0, span.start) + item + text.slice(span.end);
  }
  if (!res.changed && !res.inserted) return res;
  verifyEdit(original, text, head, jobs.map((j) => j.edits).flat());
  atomicWrite(file, text);
  return res;
}

/**
 * Structural check before anything is written: the same top-level items in the same order, each
 * edited item still carries its UUID as a direct child, and every requested field reads back with
 * the requested value as a direct-child property. Throws instead of writing a damaged file.
 */
function verifyEdit(before: string, after: string, head: string, edits: FieldEdit[]): void {
  const a = topLevelSpans(before), b = topLevelSpans(after);
  if (a.length !== b.length || a.some((s, i) => s.head !== b[i].head)) throw new Error("edit check failed: the file's top-level structure changed");
  const items = b.filter((s) => s.head === head);
  for (const e of edits) {
    const it = items.map((s) => after.slice(s.start, s.end)).filter((t) => directChildUuid(t) === e.uuid);
    if (it.length !== 1) throw new Error(`edit check failed: item ${e.uuid} lost its UUID`);
    const prop = findProperty(it[0], e.field);
    if (!e.value && !prop) continue;
    if (!prop || it[0].slice(prop.valStart, prop.valEnd) !== quote(e.value)) throw new Error(`edit check failed: ${e.field} of ${e.uuid} does not read back`);
  }
}

/** The (uuid "…") that is a direct child of an item (not of a nested pin/property). */
function directChildUuid(item: string): string | null {
  let depth = 0;
  for (let i = 0; i < item.length; i++) {
    const c = item.charCodeAt(i);
    if (c === 34) { i++; while (i < item.length && item.charCodeAt(i) !== 34) { if (item.charCodeAt(i) === 92) i++; i++; } continue; }
    if (c === 40) {
      depth++;
      if (depth === 2 && item.startsWith("(uuid ", i)) { const m = /^\(uuid "?([^")\s]+)"?\)/.exec(item.slice(i, i + 60)); if (m) return m[1]; }
    } else if (c === 41) depth--;
  }
  return null;
}
