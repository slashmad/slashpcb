// Release packages for the open project: where they go and how they are produced. Shared by the
// IPC handlers (Release tab) and the MCP tools.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectKicad } from "./kicad/cli";
import { effectiveCaps, exportRelease, preflight, PROFILES, type Preflight, type PreflightExtras, type ReleaseResult } from "./kicad/release";
import { getSettings } from "./settings";
import { maskWebs, testAccess, viasAtPaste } from "./kicad/analysis";
import type { KicadProject } from "./project";

export interface PackageInfo { dir: string; name: string; profile: string; status: string; createdAt: string }

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);

/** <project>/fab normally; the app's state folder for frozen or read-only projects (never write into them). */
export function releaseRoot(p: KicadProject): string {
  return p.info.frozen || !p.info.writable ? join(p.stateDir, "fab") : join(p.dir, "fab");
}

export function defaultReleaseDir(p: KicadProject, profileId: string): string {
  return join(releaseRoot(p), `${p.stem}-${profileId}-${stamp()}`);
}

/** Everything the preflight needs beyond ERC/DRC: invariants, polarity, suppressed checks, limits. */
export function preflightExtras(p: KicadProject, profileId: string): PreflightExtras {
  const dr = p.designRules();
  const pol = p.polarity();
  return {
    rules: p.design.rules,
    ignoredChecks: dr.ignored,
    exclusions: dr.exclusions.length,
    designMinClearance: typeof dr.rules.min_clearance === "number" ? dr.rules.min_clearance : undefined,
    polarity: { total: pol.length, verified: pol.filter((e) => e.verified).length, errors: pol.flatMap((e) => e.issues.filter((i) => i.level === "error").map((i) => ({ ref: e.ref, text: i.text }))) },
    caps: getSettings().supplierCaps?.[profileId],
    partNotes: p.partsData().data.parts,
    ...boardHints(p, profileId),
  };
}

/** Mask-web report with the profile's (or the user's) minimum web and the supplier's tenting. */
export function maskReport(p: KicadProject, profileId?: string) {
  const b = p.design.board;
  if (!b) return null;
  const caps = profileId ? effectiveCaps(profileId, getSettings().supplierCaps?.[profileId]) : {};
  const name = PROFILES.find((x) => x.id === profileId)?.name;
  return maskWebs(b, caps.minMaskWeb, caps.minMaskWeb !== undefined ? `${name ?? "supplier"} ${caps.minMaskWeb} mm` : undefined, { viasOpen: caps.tenting === false });
}

function boardHints(p: KicadProject, profileId: string): Pick<PreflightExtras, "viaPaste" | "testPads" | "duplicateUuids" | "maskWeb"> {
  const b = p.design.board;
  if (!b) return {};
  const vp = viasAtPaste(b).filter((i) => i.kind !== "ring-near");
  const tp = testAccess(b);
  return {
    viaPaste: { overlaps: vp.length, holeInPad: vp.filter((i) => i.kind === "hole-in-pad").length, otherNet: vp.filter((i) => !i.sameNet).length, refs: [...new Set(vp.map((i) => i.ref))] },
    testPads: { total: tp.length, paste: tp.filter((t) => t.paste).length, blocked: tp.filter((t) => t.clearanceMm < 0).length, refs: tp.filter((t) => t.paste || t.clearanceMm < 0).map((t) => t.ref) },
    duplicateUuids: p.duplicateUuidCount(),
    maskWeb: maskSummary(maskReport(p, profileId)!),
  };
}

function maskSummary(r: NonNullable<ReturnType<typeof maskReport>>): PreflightExtras["maskWeb"] {
  const risky = r.webs.filter((w) => !w.sameNet && !w.allowed);
  return { minWeb: r.minWeb, source: r.thresholdSource, risky: risky.length, merged: risky.filter((w) => w.kind === "merged").length, narrowest: r.narrowest?.web, maskDefined: r.maskDefined.map((m) => m.ref), refs: [...new Set(risky.flatMap((w) => w.refs))] };
}

export async function runPreflight(p: KicadProject, profileId: string, fresh = false): Promise<Preflight> {
  const d = fresh || !p.design.drc ? await p.request("release", { checks: true }) : p.design;
  return preflight(profileId, d.board, d.schematic, d.erc, d.drc, preflightExtras(p, profileId));
}

/** Fresh checks, then the package. Refuses an output folder inside a frozen project. */
export async function runRelease(p: KicadProject, profileId: string, appVersion: string, outDir?: string, opts: { review?: boolean; step?: boolean } = {}): Promise<ReleaseResult> {
  if (!PROFILES.some((x) => x.id === profileId)) throw new Error(`unknown profile ${profileId} (use ${PROFILES.map((x) => x.id).join(", ")})`);
  const dir = outDir ?? defaultReleaseDir(p, profileId);
  if ((p.info.frozen || !p.info.writable) && (dir + "/").startsWith(p.dir + "/")) throw new Error("the project is frozen: write the package outside its folder");
  const d = await p.request("release", { checks: true });
  if (!d.board || !p.info.pcb) throw new Error("this project has no board");
  const sources = [p.info.pcb, p.info.pro, ...(d.schematic?.sheets.map((s) => s.file) ?? []), `${p.stem}.kicad_dru`].map((f) => p.abs(f));
  const kicad = await detectKicad();
  return exportRelease({
    profileId, board: d.board, schematic: d.schematic, erc: d.erc, drc: d.drc,
    projectDir: p.dir, shadowDir: p.shadowDir, pcb: p.info.pcb, sourceFiles: [...new Set(sources)],
    outDir: dir, appVersion, kicadVersion: kicad.version, timeoutMs: p.opts.timeoutSec * 1000,
    extras: preflightExtras(p, profileId), review: opts.review, step: opts.step,
  });
}

/** Packages made earlier (folders with a SlashPCB MANIFEST.json), newest first. */
export function listPackages(p: KicadProject): PackageInfo[] {
  const out: PackageInfo[] = [];
  for (const root of new Set([join(p.dir, "fab"), join(p.stateDir, "fab")])) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const m = join(root, name, "MANIFEST.json");
      try {
        const j = JSON.parse(readFileSync(m, "utf8"));
        if (j.format !== "slashpcb-release/1") continue;
        out.push({ dir: join(root, name), name, profile: j.profile?.name ?? j.profile?.id ?? "?", status: j.status, createdAt: j.createdAt ?? new Date(statSync(m).mtimeMs).toISOString() });
      } catch { /* not a package */ }
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function preflightText(pf: Preflight): string {
  const icon = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;
  return [`Preflight for ${pf.profile}: ${pf.ok ? "no blocking failures" : "BLOCKED"} (${pf.assembled} placed parts)`,
    ...pf.gates.map((g) => `[${icon[g.status]}] ${g.title}: ${g.detail}${g.refs?.length ? ` — ${g.refs.slice(0, 20).join(", ")}${g.refs.length > 20 ? " …" : ""}` : ""}`)].join("\n");
}
