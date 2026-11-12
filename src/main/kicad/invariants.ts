// Design invariants: project rules the user (or an approved agent) writes down once and SlashPCB checks
// on every run, next to ERC/DRC. They capture what DRC cannot know, e.g. "diode pad 1 is on a COL net",
// "U1 keeps the TI DCK0005A land pattern", "In2.Cu carries only GND", "key contacts do not move",
// "no design rule is relaxed below the baseline".
//
// File: <project>/slashpcb.rules.json (versioned with the project). Frozen or read-only projects keep
// their rules in SlashPCB's state folder instead, so nothing is written into them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { BoardModel, CheckReport, CheckViolation, SchematicModel } from "../../shared/types";
import { diffDesignRules, isRelaxation, type DesignRules } from "./designrules";
import { compareWithReference, loadReference } from "./libfp";

export type RuleKind = "pin_net" | "pin_unconnected" | "footprint" | "land_pattern" | "layer_nets" | "locked" | "part_present" | "rules_floor";
export interface Rule {
  id: string;
  kind: RuleKind;
  note?: string;
  severity?: "error" | "warning";
  pins?: string; // "D*.1", "J3.1", "U8.5"
  net?: string; // glob, "!" prefix negates: "!GND"
  refs?: string; // "U1", "SW*", "U1 U2"
  footprint?: string; // "Lib:Name" glob
  reference?: string; // land_pattern: trusted "Lib:Name" or path to a .kicad_mod
  layer?: string; // "In2.Cu"
  nets?: string; // allowed nets on the layer (globs separated by spaces)
  positions?: Record<string, [number, number, number, "F" | "B"]>; // locked snapshot
  tolerance?: number; // mm / degrees
  baseline?: Pick<DesignRules, "rules" | "ignored" | "exclusions" | "classes" | "custom">;
  createdAt?: string;
}
export interface RulesFile { version: 1; rules: Rule[] }

const FILE = "slashpcb.rules.json";
export const rulesFileName = FILE;

/** Glob to regex: * and ? wildcards, case-insensitive, leading "/" of hierarchical nets optional. */
function glob(p: string): RegExp {
  const esc = p.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^/?${esc.replace(/^\\?\//, "")}$`, "i");
}
const anyGlob = (list: string | undefined) => (list ?? "*").split(/[\s,]+/).filter(Boolean).map(glob);
const matchAny = (res: RegExp[], s: string) => res.some((r) => r.test(s));

export const RULE_KINDS: RuleKind[] = ["pin_net", "pin_unconnected", "footprint", "land_pattern", "layer_nets", "locked", "part_present", "rules_floor"];
const REQUIRED: Record<RuleKind, (keyof Rule)[]> = {
  pin_net: ["pins", "net"], pin_unconnected: ["pins"], footprint: ["refs", "footprint"], land_pattern: ["refs", "reference"],
  layer_nets: ["layer", "nets"], locked: ["refs"], part_present: ["refs"], rules_floor: [],
};

/** Why a rule is not valid (null when it is). Unknown kinds and missing fields are errors, never ignored. */
export function validateRule(r: unknown): string | null {
  if (!r || typeof r !== "object") return "not an object";
  const x = r as Record<string, unknown>;
  const id = typeof x.id === "string" && x.id ? x.id : "(no id)";
  if (typeof x.id !== "string" || !x.id) return "rule without an id";
  if (!RULE_KINDS.includes(x.kind as RuleKind)) return `${id}: unknown kind ${JSON.stringify(x.kind)} (known: ${RULE_KINDS.join(", ")})`;
  for (const k of REQUIRED[x.kind as RuleKind]) if (typeof x[k] !== "string" || !(x[k] as string).trim()) return `${id}: ${x.kind} needs "${k}"`;
  if (x.severity !== undefined && x.severity !== "error" && x.severity !== "warning") return `${id}: severity must be error or warning`;
  if (x.tolerance !== undefined && (typeof x.tolerance !== "number" || !(x.tolerance >= 0))) return `${id}: tolerance must be a non-negative number`;
  return null;
}

/**
 * Reads the first existing rules file. Absent → no rules. Present but unreadable, of an unknown version
 * or with an invalid rule → `error` (a blocking result; writes are refused so the file is never
 * replaced by a partial copy). Valid rules of an invalid file are still returned for display.
 */
export function readRules(paths: string[]): { file: string | null; data: RulesFile; error?: string } {
  for (const f of paths) {
    if (!existsSync(f)) continue;
    let j: any;
    try { j = JSON.parse(readFileSync(f, "utf8")); } catch (e: any) { return { file: f, data: { version: 1, rules: [] }, error: `rules file is not valid JSON: ${e?.message ?? e}` }; }
    if (!j || typeof j !== "object" || !Array.isArray(j.rules)) return { file: f, data: { version: 1, rules: [] }, error: "rules file has no \"rules\" list" };
    if (j.version !== 1) return { file: f, data: { version: 1, rules: [] }, error: `unsupported rules file version ${JSON.stringify(j.version)} (expected 1)` };
    const problems = j.rules.map(validateRule).filter((x: string | null): x is string => !!x);
    const ids = j.rules.map((r: any) => r?.id).filter(Boolean);
    const dup = ids.filter((id: string, i: number) => ids.indexOf(id) !== i);
    if (dup.length) problems.push(`duplicate rule id(s): ${[...new Set(dup)].join(", ")}`);
    const valid = j.rules.filter((r: unknown) => !validateRule(r));
    return { file: f, data: { version: 1, rules: valid }, error: problems.length ? `invalid rule(s): ${problems.join("; ")}` : undefined };
  }
  return { file: null, data: { version: 1, rules: [] } };
}

export function writeRules(file: string, data: RulesFile): void {
  writeFileSync(file, JSON.stringify({ version: 1, note: "SlashPCB design invariants: checked on every run and before release packages.", rules: data.rules }, null, 2) + "\n");
}

export function newRuleId(existing: Rule[]): string {
  let n = existing.length + 1;
  while (existing.some((r) => r.id === `r${n}`)) n++;
  return `r${n}`;
}

/** Fills snapshot data for rules that need it (locked positions, rules baseline). */
export function prepareRule(r: Rule, board: BoardModel | null, rules: DesignRules | null): Rule {
  const out = { ...r, createdAt: r.createdAt ?? new Date().toISOString() };
  if (r.kind === "locked" && !r.positions && board) {
    const res = anyGlob(r.refs);
    out.positions = Object.fromEntries(board.footprints.filter((f) => f.ref && matchAny(res, f.ref)).map((f) => [f.ref, [+f.x.toFixed(4), +f.y.toFixed(4), +f.rot.toFixed(3), f.side]]));
    out.tolerance ??= 0.001;
  }
  if (r.kind === "rules_floor" && !r.baseline && rules) out.baseline = { rules: rules.rules, ignored: rules.ignored, exclusions: rules.exclusions, classes: rules.classes, custom: rules.custom };
  return out;
}

export function describeRule(r: Rule): string {
  switch (r.kind) {
    case "pin_net": return `${r.pins} must be on net ${r.net}`;
    case "pin_unconnected": return `${r.pins} must stay unconnected`;
    case "footprint": return `${r.refs} must use footprint ${r.footprint}`;
    case "land_pattern": return `${r.refs} must match the land pattern ${r.reference} exactly (every pad: position, number, size, shape, type, drill)`;
    case "layer_nets": return `only nets ${r.nets} on ${r.layer} (tracks, zones, SMD pads, copper graphics; vias and through-hole pads pass through)`;
    case "locked": return `${r.refs} keep their positions (${Object.keys(r.positions ?? {}).length} parts, ±${r.tolerance ?? 0.001})`;
    case "part_present": return `${r.refs} must exist on the board`;
    case "rules_floor": return "design rules not relaxed below the baseline";
  }
}

export function evaluateRules(file: string | null, data: RulesFile, board: BoardModel | null, sch: SchematicModel | null, rules: DesignRules | null,
  libs?: { map: Map<string, string>; projectDir: string }, fileError?: string): CheckReport {
  const t0 = Date.now();
  const violations: CheckViolation[] = [];
  // An unreadable requirement is not an absent requirement: block until the file is fixed.
  if (fileError) violations.push({ source: "rules", type: "rules-file", severity: "error", description: `${file ?? "rules file"}: ${fileError}. Fix the file; SlashPCB will not overwrite it.`, items: [] });
  const add = (r: Rule, description: string, items: CheckViolation["items"]) =>
    violations.push({ source: "rules", type: `${r.id}:${r.kind}`, severity: r.severity ?? "error", description: `${r.note ? `${r.note} — ` : ""}${description}`, items });
  const fps = board?.footprints ?? [];
  for (const r of data.rules) {
    try {
      if (r.kind === "pin_net" || r.kind === "pin_unconnected") {
        const [refPat, padPat] = (r.pins ?? "").split(".");
        const refRe = glob(refPat ?? "*"), padRe = glob(padPat ?? "*");
        const neg = (r.net ?? "").startsWith("!");
        const netRe = anyGlob((r.net ?? "*").replace(/^!/, ""));
        const bad: CheckViolation["items"] = [];
        let seen = 0;
        for (const f of fps) {
          if (!refRe.test(f.ref)) continue;
          for (const p of f.pads) {
            if (!padRe.test(p.num)) continue;
            seen++;
            const unconnected = !p.net || /^unconnected-/i.test(p.net);
            const ok = r.kind === "pin_unconnected" ? unconnected : neg ? !matchAny(netRe, p.net) : matchAny(netRe, p.net);
            if (!ok) bad.push({ description: `${f.ref}.${p.num} is on ${p.net || "(no net)"}`, x: p.x, y: p.y, ref: f.ref });
          }
        }
        if (!seen) add(r, `no pads match ${r.pins}`, []);
        else if (bad.length) add(r, `${describeRule(r)}: ${bad.length} of ${seen} pads differ`, bad.slice(0, 200));
      } else if (r.kind === "footprint") {
        const refRe = anyGlob(r.refs), fpRe = glob(r.footprint ?? "*");
        const hit = fps.filter((f) => matchAny(refRe, f.ref));
        if (!hit.length) add(r, `no footprints match ${r.refs}`, []);
        const bad = hit.filter((f) => !fpRe.test(f.lib));
        if (bad.length) add(r, describeRule(r), bad.map((f) => ({ description: `${f.ref} uses ${f.lib}`, x: f.x, y: f.y, ref: f.ref })));
      } else if (r.kind === "land_pattern") {
        const refRe = anyGlob(r.refs);
        const ref = libs && r.reference ? loadReference(r.reference, libs.map, libs.projectDir) : null;
        if (!ref) add(r, `reference land pattern ${r.reference} not found (use Lib:Name from the library tables or a path to a .kicad_mod)`, []);
        else {
          const hit = fps.filter((f) => matchAny(refRe, f.ref));
          if (!hit.length) add(r, `no footprints match ${r.refs}`, []);
          for (const f of hit) {
            const c = compareWithReference(f, ref.pads);
            if (c.status !== "match") add(r, `${f.ref}: ${c.detail}`, [{ description: `${f.ref} ${c.status}${c.swaps?.length ? `: ${c.swaps.slice(0, 4).join("; ")}` : c.differences?.length ? `: ${c.differences.slice(0, 4).join("; ")}` : ""}`, x: f.x, y: f.y, ref: f.ref }]);
          }
        }
      } else if (r.kind === "part_present") {
        for (const ref of (r.refs ?? "").split(/[\s,]+/).filter(Boolean)) {
          if (!fps.some((f) => f.ref === ref)) add(r, `${ref} is missing from the board`, []);
          if (sch && !sch.symbols.some((s) => s.ref === ref)) add(r, `${ref} is missing from the schematic`, []);
        }
      } else if (r.kind === "layer_nets" && board) {
        const ok = anyGlob(r.nets), layer = r.layer ?? "";
        const items: CheckViolation["items"] = [];
        const seenNets = new Set<string>();
        for (const t of board.tracks) if (t.layer === layer && !matchAny(ok, t.net) && !seenNets.has(t.net)) { seenNets.add(t.net); items.push({ description: `track on ${layer} in net ${t.net || "(no net)"}`, x: (t.x1 + t.x2) / 2, y: (t.y1 + t.y2) / 2 }); }
        for (const z of board.zones) if (!z.keepout && z.layers.includes(layer) && !matchAny(ok, z.net)) items.push({ description: `zone ${z.name ?? ""} on ${layer} in net ${z.net || "(no net)"}`, x: z.outline[0], y: z.outline[1] });
        // Surface copper on the layer: SMD pads and copper graphics. Vias and through-hole pads only pass
        // through the layer (their barrel and annulus are expected in a plane) and are not counted.
        for (const f of board.footprints) for (const p of f.pads) {
          if (p.type !== "smd" || !p.layers.includes(layer) || matchAny(ok, p.net)) continue;
          items.push({ description: `SMD pad ${f.ref}.${p.num} on ${layer} in net ${p.net || "(no net)"}`, x: p.x, y: p.y, ref: f.ref });
        }
        for (const g of board.graphics) {
          if (g.layer !== layer || g.kind === "text" || matchAny(ok, g.net ?? "")) continue;
          const [x, y] = g.kind === "circle" ? [g.cx!, g.cy!] : [g.pts?.[0] ?? 0, g.pts?.[1] ?? 0];
          items.push({ description: `copper ${g.kind} on ${layer} in net ${g.net || "(no net)"}`, x, y });
        }
        if (items.length) add(r, describeRule(r), items);
      } else if (r.kind === "locked") {
        const tol = r.tolerance ?? 0.001;
        const items: CheckViolation["items"] = [];
        for (const [ref, [x, y, rot, side]] of Object.entries(r.positions ?? {})) {
          const f = fps.find((q) => q.ref === ref);
          if (!f) { items.push({ description: `${ref} is gone`, ref }); continue; }
          const dr = Math.abs((((f.rot - rot) % 360) + 540) % 360 - 180);
          if (Math.abs(f.x - x) > tol || Math.abs(f.y - y) > tol || dr > Math.max(tol, 0.01) || f.side !== side) {
            items.push({ description: `${ref} moved: (${x}, ${y}) ${rot}° ${side} → (${f.x.toFixed(4)}, ${f.y.toFixed(4)}) ${f.rot}° ${f.side}`, x: f.x, y: f.y, ref });
          }
        }
        if (items.length) add(r, describeRule(r), items);
      } else if (r.kind === "layer_nets") {
        add(r, "no board to check", []);
      } else if (r.kind === "rules_floor") {
        if (!rules || !r.baseline) { add(r, "no design-rule baseline or no board setup to compare", []); continue; }
        const changes = diffDesignRules({ ...r.baseline, severities: {} } as DesignRules, rules).filter(isRelaxation);
        if (changes.length) add(r, `${changes.length} design rule change(s) since the baseline that can relax checks (custom rules need review; capture a new baseline if intended)`, changes.map((c) => ({ description: `${c.kind} ${c.what}${c.from !== undefined ? `: ${c.from} → ${c.to}` : ""}` })));
      } else {
        add(r, `unknown rule kind ${JSON.stringify((r as Rule).kind)}: not evaluated`, []);
      }
    } catch (e: any) {
      add(r, `rule could not be evaluated: ${e?.message ?? e}`, []);
    }
  }
  const errors = violations.filter((v) => v.severity === "error").length;
  return { kind: "rules", ok: true, ranAt: Date.now(), seconds: (Date.now() - t0) / 1000, errors, warnings: violations.length - errors, violations };
}
