// ERC/DRC through kicad-cli's JSON reports → CheckReport.
import { readFileSync } from "node:fs";
import type { CheckItem, CheckReport, CheckViolation } from "../../shared/types";
import { runCli } from "./cli";

// "Pad 2 [GND] of U5 on F.Cu", "Symbol R12 [10k]", "Pin 3 [VCC, Power input] of symbol U1", "Footprint J1"
const REF_RE = /\b(?:of(?: symbol)?|[Ss]ymbol|[Ff]ootprint)\s+([A-Za-z#_]+\d+[A-Za-z0-9_.]*)/;

function item(i: any, sheet?: string): CheckItem {
  const description = String(i?.description ?? "");
  const m = REF_RE.exec(description);
  return { description, x: i?.pos?.x, y: i?.pos?.y, uuid: i?.uuid, ref: m?.[1], sheet };
}

function violation(v: any, source: CheckViolation["source"], sheet?: string): CheckViolation {
  return {
    source, type: String(v?.type ?? source), severity: String(v?.severity ?? "error"), description: String(v?.description ?? ""),
    items: (v?.items ?? []).map((i: any) => item(i, sheet)), sheet,
  };
}

function count(list: CheckViolation[]) {
  let errors = 0, warnings = 0;
  for (const v of list) { if (v.severity === "error") errors++; else if (v.severity === "warning") warnings++; }
  return { errors, warnings };
}

export async function runErc(cwd: string, sch: string, out: string, timeoutMs: number): Promise<CheckReport> {
  const t0 = Date.now();
  const r = await runCli(["sch", "erc", "--format", "json", "--units", "mm", "-o", out, sch], cwd, timeoutMs);
  try {
    const j = JSON.parse(readFileSync(out, "utf8"));
    const violations: CheckViolation[] = [];
    for (const s of j.sheets ?? []) for (const v of s.violations ?? []) violations.push(violation(v, "erc", s.path));
    return { kind: "erc", ok: true, ranAt: Date.now(), seconds: (Date.now() - t0) / 1000, violations, ...count(violations) };
  } catch (e: any) {
    return { kind: "erc", ok: false, ranAt: Date.now(), seconds: (Date.now() - t0) / 1000, errors: 0, warnings: 0, violations: [], error: (r.stderr || r.stdout || e?.message || "ERC failed").trim().slice(-1500) };
  }
}

export async function runDrc(cwd: string, pcb: string, out: string, timeoutMs: number, parity: boolean): Promise<CheckReport> {
  const t0 = Date.now();
  const args = ["pcb", "drc", "--format", "json", "--units", "mm", "-o", out];
  if (parity) args.push("--schematic-parity");
  const r = await runCli([...args, pcb], cwd, timeoutMs);
  try {
    const j = JSON.parse(readFileSync(out, "utf8"));
    const violations: CheckViolation[] = [
      ...(j.violations ?? []).map((v: any) => violation(v, "drc")),
      ...(j.unconnected_items ?? []).map((v: any) => violation(v, "unconnected")),
      ...(j.schematic_parity ?? []).map((v: any) => violation(v, "parity")),
    ];
    return {
      kind: "drc", ok: true, ranAt: Date.now(), seconds: (Date.now() - t0) / 1000, violations, ...count(violations),
      unconnected: (j.unconnected_items ?? []).length, parity: (j.schematic_parity ?? []).length,
    };
  } catch (e: any) {
    return { kind: "drc", ok: false, ranAt: Date.now(), seconds: (Date.now() - t0) / 1000, errors: 0, warnings: 0, violations: [], error: (r.stderr || r.stdout || e?.message || "DRC failed").trim().slice(-1500) };
  }
}

export function summarizeReport(r: CheckReport | null, max = 40): string {
  if (!r) return "not run yet";
  if (!r.ok) return `${r.kind.toUpperCase()} failed to run: ${r.error}`;
  const head = `${r.kind.toUpperCase()} (${r.seconds.toFixed(1)} s): ${r.errors} error(s), ${r.warnings} warning(s)` +
    (r.kind === "drc" ? `, ${r.unconnected ?? 0} unconnected, ${r.parity ?? 0} schematic-parity issue(s)` : "");
  const lines = r.violations.slice(0, max).map((v, i) => {
    const where = v.items.map((it) => `${it.description}${it.x !== undefined ? ` @(${it.x.toFixed(2)}, ${it.y!.toFixed(2)})` : ""}`).join("; ");
    return `${i + 1}. [${v.severity}] ${v.source}/${v.type}: ${v.description}${v.sheet && v.sheet !== "/" ? ` (sheet ${v.sheet})` : ""} — ${where}`;
  });
  if (r.violations.length > max) lines.push(`… and ${r.violations.length - max} more`);
  return [head, ...lines].join("\n");
}
