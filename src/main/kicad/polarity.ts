// Polarity and pin-1 review. DRC and netlists cannot see a land pattern whose pad numbering does not
// match the real package (a mirrored back-side copy, a wrong pin order); real boards have shipped with
// such parts. This lists every polarized part with pad-1 net and pin names for a fast human check, flags
// obvious contradictions, and remembers what the user verified (invalidated when the part changes).
import { createHash } from "node:crypto";
import type { BoardModel, Footprint, SchematicModel } from "../../shared/types";

export type PartKind = "diode" | "led" | "transistor" | "ic" | "polarized-cap" | "connector" | "battery" | "crystal" | "other";
export interface PolarityPin { num: string; name: string; net: string }
export interface PolarityEntry {
  ref: string; value: string; lib: string; side: "F" | "B"; x: number; y: number; rot: number;
  kind: PartKind; pins: PolarityPin[]; pad1?: [number, number];
  issues: { level: "error" | "warning" | "info"; text: string }[];
  fingerprint: string;
  verified?: string; // ISO time when the user verified this exact fingerprint
}

const GND_NET = /(^|\/)(A|D|P|S)?GND|VSS|0V|EARTH|SHIELD/i;
const GND_PIN = /^(A|D|P|S)?GND(_\d+)?$|^VSS[A-Z]?(_\d+)?$|^0V$/i;
const SUPPLY_PIN = /^(VCC|VDD|VIN|VBUS|VBAT|VSYS|VDDA|AVDD|DVDD|VDDIO|VS|V\+|PVIN|AVIN|VCCIO)(_\d+)?$/i;
const NC_PIN = /^(NC|N\.C\.?|DNC|NIC)(_\d+)?$/i;

function classify(f: Footprint): PartKind | null {
  const r = f.ref.toUpperCase(), lib = f.lib.toUpperCase(), val = f.value.toUpperCase();
  const pads = new Set(f.pads.map((p) => p.num).filter(Boolean)).size;
  if (/^(LED|LD)\d/.test(r) || (/^D\d/.test(r) && /LED/.test(lib + " " + val))) return "led";
  if (/^D\d/.test(r)) return "diode";
  if (/^Q\d/.test(r)) return "transistor";
  if (/^(U|IC)\d/.test(r)) return "ic";
  if (/^C\d/.test(r) && /CP_|POLARI|ELEC|TANT|_POL|CAPACITOR_TANTALUM/.test(lib)) return "polarized-cap";
  if (/^(J|P|CN|CON|USB|X)\d/.test(r)) return "connector";
  if (/^BT\d/.test(r)) return "battery";
  if (/^Y\d/.test(r) && pads > 2) return "crystal";
  if (/^(R|C|L|FB|SW|TP|H|MH|FID|JP|NT|LOGO|G)\d/.test(r)) return null;
  return pads >= 3 ? "other" : null;
}

const fp = (f: Footprint) => createHash("sha1").update(JSON.stringify([f.lib, f.side, +f.x.toFixed(3), +f.y.toFixed(3), +f.rot.toFixed(2), f.pads.map((p) => [p.num, p.net, +p.x.toFixed(3), +p.y.toFixed(3)])])).digest("hex").slice(0, 16);

export function polarityReview(b: BoardModel | null, verified: Record<string, { fingerprint: string; at: string }> = {}, sch: SchematicModel | null = null): PolarityEntry[] {
  if (!b) return [];
  const out: PolarityEntry[] = [];
  // Pin names from the schematic (all units of a reference); boards often carry no pin functions.
  const schPins = new Map<string, Map<string, string>>();
  for (const sym of sch?.symbols ?? []) {
    const m = schPins.get(sym.ref) ?? new Map<string, string>();
    for (const p of sym.pins) if (p.name && p.name !== "~" && !m.has(p.num)) m.set(p.num, p.name);
    schPins.set(sym.ref, m);
  }
  const pinName = (f: Footprint, num: string, fn?: string) => (fn ? fn.replace(/_\d+$/, "") : schPins.get(f.ref)?.get(num) ?? "");
  for (const f of b.footprints) {
    if (!f.ref || f.ref.startsWith("#") || f.attrs.includes("dnp")) continue;
    const kind = classify(f);
    if (!kind) continue;
    const pins: PolarityPin[] = [];
    const seen = new Set<string>();
    for (const p of f.pads) {
      if (!p.num || seen.has(p.num)) continue;
      seen.add(p.num);
      pins.push({ num: p.num, name: pinName(f, p.num, p.pinFunction), net: p.net });
    }
    pins.sort((a, c) => a.num.localeCompare(c.num, undefined, { numeric: true }));
    const issues: PolarityEntry["issues"] = [];
    for (const p of f.pads) {
      const name = pinName(f, p.num, p.pinFunction);
      if (!name || !p.net || /^unconnected-/i.test(p.net)) continue;
      if (GND_PIN.test(name) && !GND_NET.test(p.net)) issues.push({ level: "error", text: `pin ${p.num} “${name}” is on ${p.net}, not a ground net` });
      if (SUPPLY_PIN.test(name) && GND_NET.test(p.net) && !/VBUS|SHIELD/i.test(p.net)) issues.push({ level: "error", text: `supply pin ${p.num} “${name}” is on ground net ${p.net}` });
      if (NC_PIN.test(name)) issues.push({ level: "warning", text: `NC pin ${p.num} is connected to ${p.net}` });
    }
    // A back-side footprint must have its copper on B.Cu (a KiCad flip). Mostly front copper on a bottom
    // part means an unflipped copy. A single opposite-side pad is normal (thermal-via exposed pads).
    const own = f.side === "B" ? "B.Cu" : "F.Cu", other = f.side === "B" ? "F.Cu" : "B.Cu";
    const smd = f.pads.filter((p) => p.type === "smd" && p.num);
    const wrong = smd.filter((p) => p.layers.includes(other) && !p.layers.includes(own)).length;
    const right = smd.filter((p) => p.layers.includes(own)).length;
    if (wrong > right) issues.push({ level: "error", text: `on the ${f.side === "B" ? "bottom" : "top"} side but ${wrong} of ${smd.length} SMD pads are on ${other} (not flipped in KiCad?)` });
    if ((kind === "diode" || kind === "led") && !f.pads.some((p) => /^(K|A|CATHODE|ANODE)$/i.test(pinName(f, p.num, p.pinFunction)))) {
      issues.push({ level: "info", text: "pad functions not named K/A: check which pad is the cathode in the datasheet" });
    }
    if (!f.pads.some((p) => p.num === "1" || p.num === "A1")) issues.push({ level: "info", text: "no pad 1 / A1" });
    const p1 = f.pads.find((p) => p.num === "1" || p.num === "A1");
    const print = fp(f);
    const v = verified[f.ref];
    out.push({
      ref: f.ref, value: f.value, lib: f.lib, side: f.side, x: f.x, y: f.y, rot: f.rot, kind, pins, pad1: p1 ? [p1.x, p1.y] : undefined, issues,
      fingerprint: print, verified: v && v.fingerprint === print ? v.at : undefined,
    });
  }
  const order: PartKind[] = ["ic", "transistor", "diode", "led", "polarized-cap", "connector", "battery", "crystal", "other"];
  return out.sort((a, c) => order.indexOf(a.kind) - order.indexOf(c.kind) || a.ref.localeCompare(c.ref, undefined, { numeric: true }));
}

export function polarityText(list: PolarityEntry[], onlyIssues = false): string {
  const rows = list.filter((e) => !onlyIssues || e.issues.some((i) => i.level !== "info") || !e.verified);
  const errors = list.reduce((n, e) => n + e.issues.filter((i) => i.level === "error").length, 0);
  const lines = [`Polarity review: ${list.length} polarized/multi-pin parts, ${list.filter((e) => e.verified).length} verified by the user, ${errors} contradiction(s).`];
  for (const e of rows.slice(0, 200)) {
    const pins = e.pins.slice(0, 12).map((p) => `${p.num}${p.name ? `(${p.name})` : ""}=${p.net || "–"}`).join(" ");
    lines.push(`${e.ref} ${e.kind} ${e.value} [${e.lib}] ${e.side === "B" ? "bottom" : "top"} ${e.rot}° ${e.verified ? "VERIFIED" : "unverified"}: ${pins}${e.pins.length > 12 ? " …" : ""}`);
    for (const i of e.issues) lines.push(`   ${i.level.toUpperCase()}: ${i.text}`);
  }
  return lines.join("\n");
}
