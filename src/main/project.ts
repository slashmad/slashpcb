// A KiCad project folder: file tree, watcher, diffs and the background pipeline
// (parse → schematic SVG → ERC/DRC → 3D model).
//
// Nothing is written into the project folder by the app: its state (shadow folder, exports,
// markers) lives under <userData>/projects/<id>/. kicad-cli always runs in the shadow folder.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { CheckReport, DesignSnapshot, FileDiff, FileNode, KicadLock, PipelineState, ProjectInfo } from "../shared/types";
import { runDrc, runErc } from "./kicad/checks";
import { loadDesignRules, type DesignRules } from "./kicad/designrules";
import { evaluateRules, newRuleId, prepareRule, readRules, rulesFileName, writeRules, type Rule } from "./kicad/invariants";
import { polarityReview, type PolarityEntry } from "./kicad/polarity";
import { kicadCliPath, runCli } from "./kicad/cli";
import { libraryMap } from "./kicad/libfp";
import { duplicateUuids } from "./kicad/analysis";
import { cleanNote, isEmptyNote, partKey, partLines, partsFileName, readParts, writeParts, type PartLine, type PartNote } from "./kicad/partnotes";
import { parseBoard } from "./kicad/pcb";
import { assignSheetSvgs, parseSchematic } from "./kicad/sch";
import { folderStamp, syncShadow } from "./kicad/shadow";
import { makeDiff } from "./diff";

const IGNORE = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".history"]);
const TEXT_EXT = [".kicad_sch", ".kicad_pcb", ".kicad_pro", ".kicad_dru", ".kicad_sym", ".md", ".txt", ".json", ".csv", ".py", ".yaml", ".yml", ".toml"];
const DESIGN_RE = /\.kicad_(sch|pcb|pro|dru)$|(^|\/)slashpcb\.rules\.json$/i;
const MAX_TEXT = 6_000_000;
const MAX_TREE_NODES = 4000;
const MAX_TREE_DEPTH = 6;
const MAX_SNAPSHOT_FILES = 300;
const FROZEN_RE = /(FINAL_MANIFEST.*\.json|^FROZEN(\.md|\.txt)?)$/i;

export interface PipelineOptions { checks: boolean; glb: boolean; timeoutSec: number }

/** Pick the .kicad_pro to open for a path (folder, .kicad_pro, .kicad_sch or .kicad_pcb). */
export function resolveProject(path: string): { dir: string; pro: string } | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  if (st.isFile()) {
    const dir = dirname(path);
    const stem = basename(path).replace(/\.kicad_(pro|sch|pcb|prl)$/i, "");
    if (stem === basename(path)) return null;
    const pro = `${stem}.kicad_pro`;
    if (existsSync(join(dir, pro))) return { dir, pro };
    // A board or schematic without project file: still usable, KiCad creates defaults.
    return { dir, pro };
  }
  const pros = readdirSync(path).filter((f) => f.toLowerCase().endsWith(".kicad_pro")).sort();
  if (!pros.length) {
    const any = readdirSync(path).find((f) => /\.kicad_(pcb|sch)$/i.test(f));
    return any ? { dir: path, pro: any.replace(/\.kicad_(pcb|sch)$/i, ".kicad_pro") } : null;
  }
  const byName = pros.find((p) => p.replace(/\.kicad_pro$/i, "") === basename(path));
  return { dir: path, pro: byName ?? pros[0] };
}

export class KicadProject extends EventEmitter {
  readonly dir: string;
  readonly pro: string;
  readonly stem: string;
  readonly stateDir: string;
  readonly shadowDir: string;
  readonly outDir: string;
  info: ProjectInfo;
  design: DesignSnapshot = { n: 0, board: null, schematic: null, erc: null, drc: null, rules: null, rulesFile: null, glb: null, errors: [] };
  state: PipelineState = { running: false, n: 0 };
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private snapshots = new Map<string, string>();
  private diffs: FileDiff[] = [];
  private runPromise: Promise<DesignSnapshot> | null = null;
  private again: { trigger: string; checks: boolean; glb: boolean } | null = null;
  private want3d = false;
  opts: PipelineOptions = { checks: true, glb: false, timeoutSec: 300 };
  truncated = false;

  constructor(dir: string, pro: string, stateRoot: string) {
    super();
    this.dir = dir;
    this.pro = pro;
    this.stem = pro.replace(/\.kicad_pro$/i, "");
    const id = createHash("sha1").update(join(dir, pro)).digest("hex").slice(0, 16);
    this.stateDir = join(stateRoot, "projects", id);
    this.shadowDir = join(this.stateDir, "shadow");
    this.outDir = join(this.stateDir, "out");
    mkdirSync(this.outDir, { recursive: true });
    try { writeFileSync(join(this.stateDir, "source.txt"), join(dir, pro) + "\n"); } catch { /* state folder read-only */ }
    this.info = this.readInfo();
    this.snapshotTexts();
  }

  private settingsFile() { return join(this.stateDir, "project.json"); }
  private localSettings(): { frozen?: boolean } {
    try { return JSON.parse(readFileSync(this.settingsFile(), "utf8")); } catch { return {}; }
  }

  /** User override: treat as frozen (true), allow edits (false) or auto-detect (undefined). */
  setFrozen(v: boolean | undefined): void {
    const s = this.localSettings();
    if (v === undefined) delete s.frozen; else s.frozen = v;
    writeFileSync(this.settingsFile(), JSON.stringify(s, null, 2));
    this.info = this.readInfo();
    this.emit("info", this.info);
  }

  readInfo(): ProjectInfo {
    const names = (() => { try { return readdirSync(this.dir); } catch { return [] as string[]; } })();
    const sch = names.includes(`${this.stem}.kicad_sch`) ? `${this.stem}.kicad_sch` : null;
    const pcb = names.includes(`${this.stem}.kicad_pcb`) ? `${this.stem}.kicad_pcb` : null;
    let writable = true;
    try { accessSync(this.dir, constants.W_OK); } catch { writable = false; }
    const marker = names.find((n) => FROZEN_RE.test(n));
    const override = this.localSettings().frozen;
    const frozen = override ?? (!!marker || !writable);
    const frozenReason = override === true ? "marked frozen in SlashPCB" : override === false ? undefined
      : marker ? `release marker ${marker}` : !writable ? "folder is read-only" : undefined;
    return {
      dir: this.dir, name: this.stem, pro: this.pro, sch, pcb,
      otherProjects: names.filter((n) => n.toLowerCase().endsWith(".kicad_pro") && n !== this.pro),
      frozen, frozenReason, writable, locks: this.locks(names),
    };
  }

  private locks(names: string[]): KicadLock[] {
    const out: KicadLock[] = [];
    for (const n of names) {
      const m = /^~(.+)\.lck$/.exec(n);
      if (!m) continue;
      const lock: KicadLock = { file: m[1] };
      try { const j = JSON.parse(readFileSync(join(this.dir, n), "utf8")); lock.user = j.username; lock.host = j.hostname; } catch { /* old format */ }
      out.push(lock);
    }
    return out;
  }

  abs(rel: string): string {
    const p = join(this.dir, rel);
    if (relative(this.dir, p).startsWith("..")) throw new Error("the path is outside the project");
    return p;
  }

  readText(rel: string): string {
    const p = this.abs(rel);
    if (statSync(p).size > MAX_TEXT) throw new Error("the file is too large to show");
    return readFileSync(p, "utf8");
  }

  recentDiffs(): FileDiff[] { return this.diffs.slice(-30); }

  tree(): FileNode {
    let count = 0;
    this.truncated = false;
    const walk = (abs: string, depth: number): FileNode[] => {
      if (depth > MAX_TREE_DEPTH) return [];
      let entries: string[] = [];
      try { entries = readdirSync(abs); } catch { return []; }
      const nodes: FileNode[] = [];
      for (const name of entries.sort((a, b) => a.localeCompare(b))) {
        if (count >= MAX_TREE_NODES) { this.truncated = true; break; }
        if (IGNORE.has(name) || name.startsWith(".") || name.startsWith("~") || name.endsWith("-backups")) continue;
        const p = join(abs, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        count++;
        const rel = relative(this.dir, p).split(sep).join("/");
        if (st.isDirectory()) nodes.push({ name, path: rel, dir: true, children: walk(p, depth + 1) });
        else nodes.push({ name, path: rel, dir: false, size: st.size });
      }
      return nodes.sort((a, b) => Number(b.dir) - Number(a.dir));
    };
    return { name: basename(this.dir), path: "", dir: true, children: walk(this.dir, 0) };
  }

  private isText(rel: string): boolean { return TEXT_EXT.some((e) => rel.toLowerCase().endsWith(e)); }

  private snapshotTexts(): void {
    let n = 0;
    const walk = (node: FileNode) => {
      for (const c of node.children ?? []) {
        if (n >= MAX_SNAPSHOT_FILES) return;
        if (c.dir) walk(c);
        else if (this.isText(c.path) && (c.size ?? 0) < MAX_TEXT) {
          try { this.snapshots.set(c.path, readFileSync(this.abs(c.path), "utf8")); n++; } catch { /* ignore */ }
        }
      }
    };
    walk(this.tree());
  }

  startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_ev, file) => {
        if (!file) return;
        const rel = file.toString().split(sep).join("/");
        if (rel.split("/").some((seg) => IGNORE.has(seg) || seg.endsWith("-backups"))) return;
        this.pending.add(rel);
        if (this.timer) clearTimeout(this.timer);
        // KiCad writes several files per save (board + project + local settings): settle first.
        this.timer = setTimeout(() => this.flush(), 400);
      });
      this.watcher.on("error", () => { /* folder removed or not watchable */ });
    } catch { /* recursive watch unsupported: no live updates */ }
  }

  private flush(): void {
    const changed = [...this.pending];
    this.pending.clear();
    const diffs: FileDiff[] = [];
    for (const rel of changed) {
      if (!this.isText(rel)) continue;
      let now: string | null = null;
      try { now = statSync(this.abs(rel)).size < MAX_TEXT ? readFileSync(this.abs(rel), "utf8") : null; } catch { now = null; }
      const before = this.snapshots.get(rel) ?? "";
      if (now === null) { this.snapshots.delete(rel); continue; }
      if (now === before) continue;
      this.snapshots.set(rel, now);
      // Board/schematic diffs can be huge (zone refills): keep them out of the diff list.
      if (before.length + now.length > 1_500_000) continue;
      const d = makeDiff(rel, before, now);
      diffs.push(d);
      this.diffs.push(d);
    }
    if (this.diffs.length > 200) this.diffs.splice(0, this.diffs.length - 200);
    const lockChange = changed.some((f) => f.endsWith(".lck"));
    if (lockChange || changed.some((f) => FROZEN_RE.test(f))) { this.info = this.readInfo(); this.emit("info", this.info); }
    this.emit("changed", { files: changed, diffs });
    if (changed.some((f) => DESIGN_RE.test(f) && !f.endsWith(".lck"))) this.request("file").catch(() => {});
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.removeAllListeners();
  }

  // ------------------------------------------------------------ pipeline

  /** Ask for the 3D model (the 3D tab opened); runs once if not present yet. */
  request3d(): Promise<DesignSnapshot> {
    this.want3d = true;
    if (this.design.glb && existsSync(this.design.glb)) return Promise.resolve(this.design);
    return this.request("3d", { checks: false, glb: true });
  }

  /** Run the pipeline; calls during a run coalesce into one follow-up run. */
  request(trigger: string, o: { checks?: boolean; glb?: boolean } = {}): Promise<DesignSnapshot> {
    const checks = o.checks ?? (this.opts.checks || trigger === "manual" || trigger === "opened" || trigger === "agent");
    const glb = o.glb ?? (this.opts.glb || this.want3d);
    if (this.runPromise) {
      this.again = { trigger, checks: (this.again?.checks ?? false) || checks, glb: (this.again?.glb ?? false) || glb };
      this.state = { ...this.state, queued: true };
      this.emit("state", this.state);
      return this.runPromise.then(() => this.runPromise ?? this.design);
    }
    this.runPromise = this.run(trigger, checks, glb).finally(() => {
      this.runPromise = null;
      const a = this.again;
      this.again = null;
      if (a) this.request(a.trigger, a).catch(() => {});
    });
    return this.runPromise;
  }

  private stage(stage: string): void {
    this.state = { ...this.state, running: true, stage, queued: !!this.again };
    this.emit("state", this.state);
  }

  private async run(trigger: string, checks: boolean, glb: boolean): Promise<DesignSnapshot> {
    const t0 = Date.now();
    const n = this.state.n + 1;
    const errors: string[] = [];
    this.info = this.readInfo();
    const info = this.info;
    const d: DesignSnapshot = { ...this.design, n, errors };
    const outN = join(this.outDir, `run-${n}`);
    mkdirSync(outN, { recursive: true });
    const timeout = this.opts.timeoutSec * 1000;

    this.stage("parse");
    try { d.schematic = info.sch ? parseSchematic(join(this.dir, info.sch), this.dir) : null; } catch (e: any) { errors.push(`schematic: ${e?.message ?? e}`); }
    try { d.board = info.pcb ? parseBoard(join(this.dir, info.pcb)) : null; } catch (e: any) { errors.push(`board: ${e?.message ?? e}`); }
    // Keep previous SVGs until new ones exist, so the view does not blank during a run.
    if (d.schematic && this.design.schematic) {
      for (const s of d.schematic.sheets) s.svg = this.design.schematic.sheets.find((o) => o.path === s.path)?.svg ?? null;
    }
    this.evaluateRulesInto(d);
    this.design = { ...d };
    this.emit("design", this.design, "parse");

    const before = folderStamp(this.dir);
    try { syncShadow(this.dir, this.shadowDir); } catch (e: any) { errors.push(`shadow folder: ${e?.message ?? e}`); }

    if (info.sch && d.schematic) {
      this.stage("schematic");
      try {
        const svgDir = join(outN, "sch");
        mkdirSync(svgDir, { recursive: true });
        const r = await runCli(["sch", "export", "svg", "-o", svgDir, info.sch], this.shadowDir, timeout);
        const files = existsSync(svgDir) ? readdirSync(svgDir).filter((f) => f.endsWith(".svg")).map((f) => join(svgDir, f)) : [];
        if (!files.length) errors.push(`schematic SVG export failed: ${(r.stderr || r.stdout).trim().slice(-400)}`);
        else {
          assignSheetSvgs(d.schematic, files, this.stem);
          this.design = { ...this.design, schematic: d.schematic };
          this.emit("design", this.design, "schematic");
        }
      } catch (e: any) { errors.push(`kicad-cli: ${e?.message ?? e}`); }
    }

    if (checks) {
      this.stage("checks");
      const [erc, drc] = await Promise.all([
        info.sch ? runErc(this.shadowDir, info.sch, join(outN, "erc.json"), timeout).catch((e) => fail("erc", e)) : Promise.resolve(null),
        info.pcb ? runDrc(this.shadowDir, info.pcb, join(outN, "drc.json"), timeout, !!info.sch).catch((e) => fail("drc", e)) : Promise.resolve(null),
      ]);
      this.design = { ...this.design, erc, drc };
      this.emit("design", this.design, "checks");
    }

    if (glb && info.pcb) {
      this.stage("3d");
      const file = join(outN, `${this.stem}.glb`);
      try {
        const r = await runCli(["pcb", "export", "glb", "--force", "--subst-models", "--include-tracks", "--include-pads", "--include-zones", "--include-silkscreen", "--include-soldermask", "-o", file, info.pcb], this.shadowDir, timeout);
        if (existsSync(file)) { this.design = { ...this.design, glb: file }; this.emit("design", this.design, "3d"); }
        else errors.push(`3D export failed: ${(r.stderr || r.stdout).trim().slice(-400)}`);
      } catch (e: any) { errors.push(`3D export: ${e?.message ?? e}`); }
    }

    // The project folder must be untouched by our own runs (user saves during the run are fine).
    if (folderStamp(this.dir) !== before && this.pending.size === 0 && !this.timer) {
      console.warn("[slashpcb] project folder changed during a pipeline run", this.dir);
    }
    this.pruneOutputs(n);
    this.design = { ...this.design, n, errors };
    this.state = { running: false, n, lastSeconds: (Date.now() - t0) / 1000, error: errors[0] };
    this.emit("design", this.design, "done");
    this.emit("state", this.state);
    return this.design;
  }

  // ------------------------------------------------------------ design rules, invariants, polarity

  designRules(): DesignRules {
    return loadDesignRules(join(this.dir, this.pro), join(this.dir, `${this.stem}.kicad_dru`));
  }

  /** Rules live in the project unless it is frozen/read-only; then in SlashPCB's state folder. */
  rulesWritePath(): string {
    return this.info.frozen || !this.info.writable ? join(this.stateDir, "rules.json") : join(this.dir, rulesFileName);
  }

  rulesData() {
    return readRules([join(this.dir, rulesFileName), join(this.stateDir, "rules.json")]);
  }

  /** Duplicated UUIDs across the board and every schematic sheet file. */
  duplicateUuidCount(): number {
    const files = [this.info.pcb, ...(this.design.schematic?.sheets.map((s) => s.file) ?? [])].filter(Boolean) as string[];
    let n = 0;
    for (const f of new Set(files)) { try { n += duplicateUuids(readFileSync(this.abs(f), "utf8")).length; } catch { /* unreadable */ } }
    return n;
  }

  private libCache: { at: number; map: Map<string, string> } | null = null;
  /** Footprint library tables (project + global), cached for a minute. */
  libs(): { map: Map<string, string>; projectDir: string } {
    if (!this.libCache || Date.now() - this.libCache.at > 60000) this.libCache = { at: Date.now(), map: libraryMap(this.dir, kicadCliPath()) };
    return { map: this.libCache.map, projectDir: this.dir };
  }

  private evaluateRulesInto(d: DesignSnapshot): void {
    try {
      const { file, data } = this.rulesData();
      d.rules = data.rules.length ? evaluateRules(file, data, d.board, d.schematic, this.designRules(), this.libs()) : null;
      d.rulesFile = file;
    } catch (e: any) { d.errors.push(`rules: ${e?.message ?? e}`); }
  }

  addRule(r: Omit<Rule, "id"> & { id?: string }): Rule {
    const { file, data } = this.rulesData();
    const target = file && !(file.startsWith(this.dir) && (this.info.frozen || !this.info.writable)) ? file : this.rulesWritePath();
    const rule = prepareRule({ ...r, id: r.id ?? newRuleId(data.rules) } as Rule, this.design.board, this.designRules());
    data.rules = [...data.rules.filter((x) => x.id !== rule.id), rule];
    writeRules(target, data);
    return rule;
  }

  removeRule(id: string): boolean {
    const { file, data } = this.rulesData();
    if (!file) return false;
    const n = data.rules.length;
    data.rules = data.rules.filter((r) => r.id !== id);
    if (data.rules.length === n) return false;
    writeRules(file, data);
    return true;
  }

  /** Re-evaluate invariants without a full pipeline run (after rule edits). */
  refreshRules(): void {
    const d = { ...this.design, errors: [...this.design.errors] };
    this.evaluateRulesInto(d);
    this.design = d;
    this.emit("design", this.design, "rules");
  }

  // ------------------------------------------------------------ sourcing notes

  /** Same placement rule as the invariants file: the project unless frozen/read-only. */
  partsData() {
    return readParts([join(this.dir, partsFileName), join(this.stateDir, "parts.json")]);
  }
  partLines(): PartLine[] {
    return partLines(this.design.board, this.design.schematic, this.partsData().data.parts);
  }
  /** Set (or with null, remove) the note of a BOM line, addressed by its key or by any of its references. Merges unless `replace`. */
  setPartNote(keyOrRef: string, note: Partial<PartNote> | null, replace = false): { key: string; note: PartNote | null; file: string } {
    let key = keyOrRef;
    if (!/^(mpn|vf):/.test(keyOrRef)) {
      const f = this.design.board?.footprints.find((x) => x.ref === keyOrRef);
      const s = this.design.schematic?.symbols.find((x) => x.ref === keyOrRef && !x.power);
      if (f) key = partKey(f);
      else if (s) key = partKey({ value: s.value, lib: s.footprint, fields: s.fields });
      else throw new Error(`no part ${keyOrRef}`);
    }
    const { file, data } = this.partsData();
    const locked = this.info.frozen || !this.info.writable;
    const target = file && !(file.startsWith(this.dir) && locked) ? file : locked ? join(this.stateDir, "parts.json") : join(this.dir, partsFileName);
    const clean = note ? cleanNote({ ...(replace ? {} : data.parts[key] ?? {}), ...note } as any) : null;
    if (!clean || isEmptyNote(clean)) delete data.parts[key];
    else data.parts[key] = { ...clean, updatedAt: new Date().toISOString() };
    writeParts(target, data);
    return { key, note: data.parts[key] ?? null, file: target };
  }

  private polarityFile() { return join(this.stateDir, "polarity.json"); }
  private polarityVerified(): Record<string, { fingerprint: string; at: string }> {
    try { return JSON.parse(readFileSync(this.polarityFile(), "utf8")); } catch { return {}; }
  }
  polarity(): PolarityEntry[] { return polarityReview(this.design.board, this.polarityVerified(), this.design.schematic, this.libs()); }
  setPolarityVerified(ref: string, fingerprint: string | null): PolarityEntry[] {
    const v = this.polarityVerified();
    if (fingerprint) v[ref] = { fingerprint, at: new Date().toISOString() }; else delete v[ref];
    writeFileSync(this.polarityFile(), JSON.stringify(v, null, 1));
    return this.polarity();
  }

  /** Keep the newest runs that the current snapshot still references. */
  private pruneOutputs(n: number): void {
    const keep = new Set<string>([`run-${n}`]);
    const refs = [this.design.glb, ...(this.design.schematic?.sheets.map((s) => s.svg) ?? [])].filter(Boolean) as string[];
    for (const r of refs) { const m = /run-\d+/.exec(r); if (m) keep.add(m[0]); }
    for (const name of readdirSync(this.outDir)) {
      if (!keep.has(name)) rmSync(join(this.outDir, name), { recursive: true, force: true });
    }
  }
}

function fail(kind: "erc" | "drc", e: any): CheckReport {
  return { kind, ok: false, ranAt: Date.now(), seconds: 0, errors: 0, warnings: 0, violations: [], error: String(e?.message ?? e) };
}
