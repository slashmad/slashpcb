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
  let text = readFileSync(file, "utf8");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const spans = topLevelSpans(text).filter((s) => s.head === (kind === "sch" ? "symbol" : "footprint"));
  const res: EditResult = { file, changed: 0, inserted: 0, missing: [] };
  // Apply from the end of the file so earlier offsets stay valid.
  const jobs = edits.map((e) => ({ e, span: spans.find((s) => text.slice(s.start, s.end).includes(`(uuid ${quote(e.uuid)})`)) }));
  for (const j of jobs) if (!j.span) res.missing.push(j.e.uuid);
  const valid = jobs.filter((j) => j.span).sort((a, b) => b.span!.start - a.span!.start || 0);
  for (const { e, span } of valid) {
    const item = text.slice(span!.start, span!.end);
    const prop = findProperty(item, e.field);
    let next: string;
    if (prop) {
      if (item.slice(prop.valStart, prop.valEnd) === quote(e.value)) continue;
      next = item.slice(0, prop.valStart) + quote(e.value) + item.slice(prop.valEnd);
      res.changed++;
    } else {
      if (!e.value) continue;
      const [x, y] = at?.(e.uuid) ?? [0, 0];
      const t = (n: number) => "\t".repeat(n);
      const block = kind === "sch"
        ? [`${t(2)}(property ${quote(e.field)} ${quote(e.value)}`, `${t(3)}(at ${x} ${y} 0)`, `${t(3)}(hide yes)`, `${t(3)}(effects`, `${t(4)}(font`, `${t(5)}(size 1.27 1.27)`, `${t(4)})`, `${t(3)})`, `${t(2)})`]
        : [`${t(2)}(property ${quote(e.field)} ${quote(e.value)}`, `${t(3)}(at 0 0 0)`, `${t(3)}(unlocked yes)`, `${t(3)}(layer "F.Fab")`, `${t(3)}(hide yes)`, `${t(3)}(uuid ${quote(randomUUID())})`, `${t(3)}(effects`, `${t(4)}(font`, `${t(5)}(size 1 1)`, `${t(5)}(thickness 0.15)`, `${t(4)})`, `${t(3)})`, `${t(2)})`];
      const ip = insertPoint(item);
      next = item.slice(0, ip) + nl + block.join(nl) + item.slice(ip);
      res.inserted++;
    }
    text = text.slice(0, span!.start) + next + text.slice(span!.end);
  }
  if (res.changed || res.inserted) atomicWrite(file, text);
  return res;
}
