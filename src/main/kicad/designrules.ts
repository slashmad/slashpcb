// Board design rules as KiCad stores them (.kicad_pro design_settings, net classes, .kicad_dru custom
// rules) and a comparison that flags relaxations: smaller minimums, checks switched to "ignore", new
// DRC exclusions, weaker net classes, changed custom rules. "Never make a check pass by lowering a rule."
import { existsSync, readFileSync } from "node:fs";
import { parseSexpr, child, isList, str, type SList } from "./sexpr";

export interface NetClassRules { name: string; clearance?: number; track_width?: number; via_diameter?: number; via_drill?: number; diff_pair_gap?: number; diff_pair_width?: number }
export interface CustomRule { name: string; condition: string; constraints: string[]; text: string }
export interface DesignRules {
  rules: Record<string, number | boolean>; // board.design_settings.rules
  ignored: string[]; // rule_severities == "ignore"
  severities: Record<string, string>;
  exclusions: string[]; // drc_exclusions entries
  classes: NetClassRules[];
  custom: CustomRule[]; // .kicad_dru
}

/** Minimum-type rules: a smaller value is a relaxation. */
const MINIMUMS = ["min_clearance", "min_track_width", "min_via_diameter", "min_via_annular_width", "min_via_annulus", "min_through_hole_diameter", "min_hole_clearance",
  "min_hole_to_hole", "min_copper_edge_clearance", "min_microvia_diameter", "min_microvia_drill", "min_silk_clearance", "min_text_height", "min_text_thickness",
  "solder_mask_to_copper_clearance", "min_connection", "min_groove_width"];

export function readDesignRules(proText: string | null, druText: string | null): DesignRules {
  const r: DesignRules = { rules: {}, ignored: [], severities: {}, exclusions: [], classes: [], custom: [] };
  if (proText) {
    try {
      const j = JSON.parse(proText);
      const ds = j?.board?.design_settings ?? {};
      for (const [k, v] of Object.entries(ds.rules ?? {})) if (typeof v === "number" || typeof v === "boolean") r.rules[k] = v;
      r.severities = { ...(ds.rule_severities ?? {}) };
      r.ignored = Object.entries(r.severities).filter(([, v]) => v === "ignore").map(([k]) => k).sort();
      r.exclusions = (ds.drc_exclusions ?? []).map((e: unknown) => (typeof e === "string" ? e : JSON.stringify(e)));
      r.classes = (j?.net_settings?.classes ?? []).map((c: any) => ({
        name: String(c.name), clearance: c.clearance, track_width: c.track_width, via_diameter: c.via_diameter, via_drill: c.via_drill, diff_pair_gap: c.diff_pair_gap, diff_pair_width: c.diff_pair_width,
      }));
    } catch { /* unreadable project file */ }
  }
  if (druText) {
    try {
      const top = parseSexpr(druText);
      for (const it of top) {
        if (!isList(it) || it[0] !== "rule") continue;
        const constraints = (it as SList).slice(1).filter((c): c is SList => isList(c) && c[0] === "constraint").map((c) => sx(c));
        r.custom.push({ name: String(it[1] ?? ""), condition: str(it as SList, "condition") ?? "", constraints, text: sx(it as SList) });
      }
    } catch { /* unparsable custom rules */ }
  }
  return r;
}

function sx(n: unknown): string {
  return Array.isArray(n) ? `(${n.map(sx).join(" ")})` : typeof n === "string" && /[\s()"]/.test(n) ? JSON.stringify(n) : String(n);
}

export function loadDesignRules(proPath: string, druPath: string): DesignRules {
  return readDesignRules(existsSync(proPath) ? readFileSync(proPath, "utf8") : null, existsSync(druPath) ? readFileSync(druPath, "utf8") : null);
}

export interface RuleChange { kind: "relaxed" | "tightened" | "removed" | "added" | "ignored" | "unignored" | "exclusion+" | "exclusion-" | "class" | "class+" | "class-" | "custom+" | "custom-" | "custom~"; what: string; from?: string; to?: string }

/** Differences from `old` to `cur`; relaxations first. */
export function diffDesignRules(old: DesignRules, cur: DesignRules): RuleChange[] {
  const out: RuleChange[] = [];
  for (const k of MINIMUMS) {
    const a = old.rules[k], b = cur.rules[k];
    const na = typeof a === "number", nb = typeof b === "number";
    // A removed minimum falls back to a default SlashPCB cannot resolve: never "unchanged".
    if (na && !nb) { out.push({ kind: "removed", what: k, from: String(a), to: b === undefined ? "(removed: KiCad default applies)" : String(b) }); continue; }
    if (!na && nb) { out.push({ kind: "added", what: k, from: a === undefined ? "(default)" : String(a), to: String(b) }); continue; }
    if (!na || !nb || Math.abs((a as number) - (b as number)) < 1e-9) continue;
    out.push({ kind: (b as number) < (a as number) ? "relaxed" : "tightened", what: k, from: String(a), to: String(b) });
  }
  for (const k of cur.ignored) if (!old.ignored.includes(k)) out.push({ kind: "ignored", what: k, from: old.severities[k] ?? "default", to: "ignore" });
  for (const k of old.ignored) if (!cur.ignored.includes(k)) out.push({ kind: "unignored", what: k, from: "ignore", to: cur.severities[k] ?? "default" });
  for (const e of cur.exclusions) if (!old.exclusions.includes(e)) out.push({ kind: "exclusion+", what: e.slice(0, 160) });
  for (const e of old.exclusions) if (!cur.exclusions.includes(e)) out.push({ kind: "exclusion-", what: e.slice(0, 160) });
  for (const c of cur.classes) {
    const o = old.classes.find((x) => x.name === c.name);
    if (!o) { out.push({ kind: "class+", what: `net class ${c.name}` }); continue; }
    for (const k of ["clearance", "track_width", "via_diameter", "via_drill", "diff_pair_gap"] as const) {
      const a = o[k], b = c[k];
      if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) > 1e-9) out.push({ kind: b < a ? "relaxed" : "tightened", what: `net class ${c.name}.${k}`, from: String(a), to: String(b) });
      else if (typeof a === "number" && typeof b !== "number") out.push({ kind: "removed", what: `net class ${c.name}.${k}`, from: String(a), to: "(removed: inherits Default)" });
    }
  }
  // A removed class moves its nets to Default (or another class): their effective rules may be weaker.
  for (const o of old.classes) if (!cur.classes.some((c) => c.name === o.name)) out.push({ kind: "class-", what: `net class ${o.name}`, from: [o.clearance !== undefined && `clearance ${o.clearance}`, o.track_width !== undefined && `track ${o.track_width}`].filter(Boolean).join(", ") || "defined", to: "(removed: its nets fall back to another class)" });
  for (const c of cur.custom) {
    const o = old.custom.find((x) => x.name === c.name);
    if (!o) out.push({ kind: "custom+", what: c.name, to: c.constraints.join(" ") });
    else if (o.text !== c.text) out.push({ kind: "custom~", what: c.name, from: `${o.condition} ${o.constraints.join(" ")}`, to: `${c.condition} ${c.constraints.join(" ")}` });
  }
  for (const o of old.custom) if (!cur.custom.some((c) => c.name === o.name)) out.push({ kind: "custom-", what: o.name, from: o.constraints.join(" ") });
  const rank = (k: RuleChange["kind"]) => ["relaxed", "removed", "class-", "ignored", "exclusion+", "custom+", "custom~", "custom-", "class", "class+", "added", "tightened", "unignored", "exclusion-"].indexOf(k);
  return out.sort((a, b) => rank(a.kind) - rank(b.kind));
}

export const isRelaxation = (c: RuleChange) => c.kind === "relaxed" || c.kind === "removed" || c.kind === "class-" || c.kind === "ignored" || c.kind === "exclusion+" || c.kind === "custom+" || c.kind === "custom~" || c.kind === "custom-";

export function rulesText(changes: RuleChange[]): string {
  if (!changes.length) return "Design rules: unchanged.";
  const label = (c: RuleChange) => (c.kind === "relaxed" || c.kind === "ignored" || c.kind === "exclusion+" ? "RELAXED" : isRelaxation(c) ? "REVIEW" : "ok");
  return ["Design rule changes:", ...changes.map((c) => `- [${label(c)}] ${c.kind} ${c.what}${c.from !== undefined || c.to !== undefined ? `: ${c.from ?? ""} → ${c.to ?? ""}` : ""}`)].join("\n");
}
