// Footprint libraries (project and global fp-lib-table, KiCad's standard libraries) and a comparison
// of placed footprints with a library or reference land pattern. This catches what DRC and the
// netlist cannot: the same pad positions with a different pad numbering (a reversed pin order, a
// mirrored copy), and placed footprints that drifted from their library version.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Footprint } from "../../shared/types";
import { child, children, isList, num, parseSexpr, str, type SList } from "./sexpr";

export interface LibPad { num: string; x: number; y: number; w: number; h: number; rot: number; type: string }

/** KiCad's shared data folder (footprints, templates) for the detected kicad-cli. */
function kicadShare(cli: string | null): string[] {
  const out: string[] = [];
  if (cli && !cli.startsWith("flatpak")) {
    const bin = dirname(cli.split(" ")[0]);
    out.push(resolve(bin, "..", "share", "kicad"), resolve(bin, "..", "SharedSupport"), resolve(bin, "..", "..", "SharedSupport"));
  }
  out.push("/usr/share/kicad", "/usr/local/share/kicad", "/app/share/kicad");
  return out.filter((d) => existsSync(d));
}

function expand(uri: string, vars: Record<string, string>): string {
  return uri.replace(/\$\{([A-Z0-9_]+)\}/g, (m, k: string) => process.env[k] ?? vars[k] ?? m);
}

/** nickname → library folder, from the project table first, then the user's global table (with nested tables). */
export function libraryMap(projectDirIn: string, cli: string | null): Map<string, string> {
  const projectDir = resolve(projectDirIn);
  const share = kicadShare(cli)[0] ?? "/usr/share/kicad";
  const vars: Record<string, string> = { KIPRJMOD: projectDir };
  for (const v of ["8", "9", "10", "11"]) { vars[`KICAD${v}_FOOTPRINT_DIR`] = join(share, "footprints"); vars[`KICAD${v}_TEMPLATE_DIR`] = join(share, "template"); vars[`KICAD${v}_3DMODEL_DIR`] = join(share, "3dmodels"); }
  const map = new Map<string, string>();
  const seen = new Set<string>();
  const read = (file: string, depth = 0) => {
    if (depth > 4 || seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    let root: SList;
    try { root = parseSexpr(readFileSync(file, "utf8"))[0] as SList; } catch { return; }
    for (const lib of children(root, "lib")) {
      const name = str(lib, "name") ?? "", type = str(lib, "type") ?? "", uri = expand(str(lib, "uri") ?? "", vars);
      if (type.toLowerCase() === "table") read(isAbsolute(uri) ? uri : join(dirname(file), uri), depth + 1);
      else if (name && !map.has(name)) map.set(name, isAbsolute(uri) ? uri : join(projectDir, uri));
    }
  };
  read(join(projectDir, "fp-lib-table"));
  const cfg = process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "kicad")
    : process.platform === "darwin" ? join(homedir(), "Library", "Preferences", "kicad") : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kicad");
  for (const v of ["10.0", "9.0", "11.0"]) read(join(cfg, v, "fp-lib-table"));
  read(join(share, "template", "fp-lib-table"));
  return map;
}

/** Pads of a .kicad_mod file, in footprint-local coordinates. */
export function readKicadMod(file: string): LibPad[] | null {
  if (!existsSync(file)) return null;
  try {
    const root = parseSexpr(readFileSync(file, "utf8"))[0] as SList;
    if (!isList(root) || (root[0] !== "footprint" && root[0] !== "module")) return null;
    return children(root, "pad").map((p) => {
      const at = child(p, "at"), size = child(p, "size");
      return { num: String(p[1] ?? ""), type: String(p[2] ?? ""), x: Number(at?.[1] ?? 0), y: Number(at?.[2] ?? 0), rot: Number(at?.[3] ?? 0), w: Number(size?.[1] ?? 0), h: Number(size?.[2] ?? size?.[1] ?? 0) };
    });
  } catch { return null; }
}

/** Resolve "Lib:Name", a path to a .kicad_mod, or a project-relative path. */
export function loadReference(ref: string, libs: Map<string, string>, projectDir: string): { pads: LibPad[]; source: string } | null {
  if (/\.kicad_mod$/i.test(ref)) {
    const f = isAbsolute(ref) ? ref : join(projectDir, ref);
    const pads = readKicadMod(f);
    return pads ? { pads, source: f } : null;
  }
  const [lib, name] = ref.split(":");
  const dir = libs.get(lib);
  if (!dir || !name) return null;
  const f = join(dir, `${name}.kicad_mod`);
  const pads = readKicadMod(f);
  return pads ? { pads, source: f } : null;
}

/** Board pads back in footprint-local coordinates (inverse of the placement transform). */
export function localPads(f: Footprint): { num: string; x: number; y: number }[] {
  const a = (f.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return f.pads.filter((p) => p.num).map((p) => {
    const dx = p.x - f.x, dy = p.y - f.y;
    return { num: p.num, x: c * dx - s * dy, y: s * dx + c * dy };
  });
}

export interface FootprintCompare {
  status: "match" | "numbering" | "geometry" | "unflipped" | "no-reference";
  detail: string;
  swaps?: string[]; // "board pad 1 sits where the reference has pad 10"
}

/** Compare a placed footprint with reference pads (front-side library geometry). */
export function compareWithReference(f: Footprint, ref: LibPad[], tol = 0.02): FootprintCompare {
  const board = localPads(f);
  const refNum = ref.filter((p) => p.num);
  if (!board.length || !refNum.length) return { status: "no-reference", detail: "no numbered pads to compare" };
  // Bottom-side parts are stored flipped: try both mirror axes and also "not flipped".
  const variants: { name: string; m: (x: number, y: number) => [number, number] }[] = f.side === "B"
    ? [{ name: "flip-y", m: (x, y) => [x, -y] }, { name: "flip-x", m: (x, y) => [-x, y] }, { name: "unflipped", m: (x, y) => [x, y] }]
    : [{ name: "front", m: (x, y) => [x, y] }];
  let best: { name: string; pos: number; numOk: number; swaps: string[] } | null = null;
  for (const v of variants) {
    const mapped = refNum.map((p) => { const [x, y] = v.m(p.x, p.y); return { num: p.num, x, y }; });
    let pos = 0, numOk = 0;
    const swaps: string[] = [];
    const used = new Set<number>();
    for (const b of board) {
      let bi = -1, bd = Infinity;
      mapped.forEach((m, i) => { if (used.has(i)) return; const d = Math.hypot(m.x - b.x, m.y - b.y); if (d < bd) { bd = d; bi = i; } });
      if (bi < 0 || bd > tol) continue;
      used.add(bi);
      pos++;
      if (mapped[bi].num === b.num) numOk++; else swaps.push(`pad ${b.num} sits where the reference has pad ${mapped[bi].num}`);
    }
    if (!best || pos > best.pos || (pos === best.pos && numOk > best.numOk)) best = { name: v.name, pos, numOk, swaps };
  }
  const b = best!;
  const n = Math.max(board.length, refNum.length);
  if (b.pos < Math.max(1, Math.floor(n * 0.8))) return { status: "geometry", detail: `pad positions differ from the reference (${b.pos} of ${n} pads coincide)` };
  if (b.numOk < b.pos) return { status: "numbering", detail: `same land pattern, different pad numbering (${b.pos - b.numOk} of ${b.pos} pads)`, swaps: b.swaps.slice(0, 20) };
  if (b.name === "unflipped") return { status: "unflipped", detail: "bottom-side copy that is not mirrored" };
  return { status: "match", detail: `matches the reference (${b.pos} pads)` };
}
