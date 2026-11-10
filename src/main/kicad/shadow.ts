// Shadow folder: kicad-cli runs here instead of in the user's project folder.
//
// Every top-level entry of the project folder is linked into the shadow folder, except the files
// kicad-cli may write (.kicad_pro, .kicad_prl), which are real copies refreshed before each run.
// Relative paths (${KIPRJMOD}/..., sub-sheets, 3D models) therefore resolve exactly as in the
// project. On Windows, file symlinks need extra rights: files fall back to copies (refreshed by
// mtime), folders use junctions.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const COPY = /\.kicad_(pro|prl)$/i;
const SKIP = new Set([".git", ".history", "node_modules"]);

export function syncShadow(projectDir: string, shadowDir: string): void {
  mkdirSync(shadowDir, { recursive: true });
  const want = new Set<string>();
  for (const name of readdirSync(projectDir)) {
    if (SKIP.has(name) || name.endsWith("-backups") || name.startsWith("~") || name.endsWith(".lck")) continue;
    want.add(name);
    const src = join(projectDir, name);
    const dst = join(shadowDir, name);
    let srcStat;
    try { srcStat = statSync(src); } catch { continue; }
    if (COPY.test(name) && srcStat.isFile()) {
      let need = true;
      try { const d = lstatSync(dst); need = d.isSymbolicLink() || d.mtimeMs < srcStat.mtimeMs || d.size !== srcStat.size; if (d.isSymbolicLink()) unlinkSync(dst); } catch { /* missing */ }
      if (need) copyFileSync(src, dst);
      continue;
    }
    let existing;
    try { existing = lstatSync(dst); } catch { existing = null; }
    if (existing?.isSymbolicLink()) {
      try { if (readlinkSync(dst) === src) continue; } catch { /* broken */ }
      unlinkSync(dst);
    } else if (existing && existing.isFile() && process.platform === "win32") {
      if (existing.mtimeMs >= srcStat.mtimeMs && existing.size === srcStat.size) continue;
      unlinkSync(dst);
    } else if (existing) {
      rmSync(dst, { recursive: true, force: true });
    }
    try {
      symlinkSync(src, dst, srcStat.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file");
    } catch {
      if (srcStat.isFile()) copyFileSync(src, dst);
    }
  }
  // Remove entries that no longer exist in the project, but keep files kicad-cli made here
  // (a .kicad_prl the project lacks) and our own output folder.
  for (const name of readdirSync(shadowDir)) {
    if (want.has(name) || name === "__out" || COPY.test(name)) continue;
    const p = join(shadowDir, name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) unlinkSync(p);
      else if (process.platform === "win32" && st.isFile()) unlinkSync(p);
    } catch { /* gone */ }
  }
}

/** Fingerprint of the project's top-level files (name, size, mtime) to prove a run wrote nothing there. */
export function folderStamp(dir: string): string {
  const parts: string[] = [];
  try {
    for (const name of readdirSync(dir).sort()) {
      try { const s = statSync(join(dir, name)); parts.push(`${name}:${s.size}:${Math.round(s.mtimeMs)}`); } catch { /* raced */ }
    }
  } catch { /* gone */ }
  return parts.join("|");
}

export function shadowExists(dir: string): boolean { return existsSync(dir); }
