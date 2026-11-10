// Minimal, fast S-expression reader for KiCad files (.kicad_pcb, .kicad_sch, .kicad_sym, .kicad_dru).
// Produces nested arrays: a list is SNode[]; atoms are strings (quoted strings keep no quotes) or
// numbers when the token is numeric and was not quoted. Read-only: the app never rewrites KiCad
// files through this module.

export type SAtom = string | number;
export type SNode = SAtom | SNode[];
export type SList = SNode[];

export function parseSexpr(src: string): SList {
  const root: SList = [];
  const stack: SList[] = [root];
  let cur = root;
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 40 /* ( */) {
      const l: SList = [];
      cur.push(l);
      stack.push(l);
      cur = l;
      i++;
    } else if (c === 41 /* ) */) {
      stack.pop();
      cur = stack[stack.length - 1] ?? root;
      i++;
    } else if (c === 34 /* " */) {
      let j = i + 1;
      let s = "";
      let start = j;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d === 92 /* \ */) {
          s += src.slice(start, j);
          const e = src[j + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          j += 2;
          start = j;
        } else if (d === 34) break;
        else j++;
      }
      s += src.slice(start, j);
      cur.push(s);
      i = j + 1;
    } else if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
    } else {
      let j = i;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d === 40 || d === 41 || d === 32 || d === 9 || d === 10 || d === 13) break;
        j++;
      }
      const tok = src.slice(i, j);
      const num = Number(tok);
      cur.push(tok !== "" && !Number.isNaN(num) && /^[-+.\d]/.test(tok) ? num : tok);
      i = j;
    }
  }
  return root;
}

/** Head symbol of a list node, e.g. "footprint" for (footprint ...). */
export function head(n: SNode): string | undefined {
  return Array.isArray(n) && typeof n[0] === "string" ? n[0] : undefined;
}

export function isList(n: SNode | undefined): n is SList {
  return Array.isArray(n);
}

/** First child list with the given head. */
export function child(l: SList | undefined, name: string): SList | undefined {
  if (!l) return undefined;
  for (let i = 1; i < l.length; i++) {
    const c = l[i];
    if (Array.isArray(c) && c[0] === name) return c;
  }
  return undefined;
}

/** All child lists with the given head. */
export function children(l: SList | undefined, name: string): SList[] {
  const out: SList[] = [];
  if (!l) return out;
  for (let i = 1; i < l.length; i++) {
    const c = l[i];
    if (Array.isArray(c) && c[0] === name) out.push(c);
  }
  return out;
}

/** Value at position `idx` (1 = first argument) of the child `name`. */
export function val(l: SList | undefined, name: string, idx = 1): SAtom | undefined {
  const c = child(l, name);
  const v = c?.[idx];
  return Array.isArray(v) ? undefined : v;
}

export function str(l: SList | undefined, name: string, idx = 1): string | undefined {
  const v = val(l, name, idx);
  return v === undefined ? undefined : String(v);
}

export function num(l: SList | undefined, name: string, idx = 1): number | undefined {
  const v = val(l, name, idx);
  return typeof v === "number" ? v : v === undefined ? undefined : Number(v);
}

/** (at x y [rot]) → [x, y, rot]. */
export function at(l: SList | undefined, name = "at"): [number, number, number] {
  const c = child(l, name);
  if (!c) return [0, 0, 0];
  return [Number(c[1] ?? 0), Number(c[2] ?? 0), Number(c[3] ?? 0)];
}

/** (pts (xy x y) (xy x y) ... (arc ...)) → flat [x0, y0, x1, y1, ...]. Arcs inside pts are approximated. */
export function pts(l: SList | undefined): number[] {
  const p = child(l, "pts");
  const out: number[] = [];
  if (!p) return out;
  for (let i = 1; i < p.length; i++) {
    const c = p[i];
    if (!Array.isArray(c)) continue;
    if (c[0] === "xy") out.push(Number(c[1]), Number(c[2]));
    else if (c[0] === "arc") {
      const s = child(c, "start"), m = child(c, "mid"), e = child(c, "end");
      if (s && m && e) out.push(...arcPoints([Number(s[1]), Number(s[2])], [Number(m[1]), Number(m[2])], [Number(e[1]), Number(e[2])]));
    }
  }
  return out;
}

/** Polyline through an arc given start, mid and end points (inclusive), flat array. */
export function arcPoints(s: [number, number], m: [number, number], e: [number, number], maxSeg = 0.25): number[] {
  const ax = s[0], ay = s[1], bx = m[0], by = m[1], cx = e[0], cy = e[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [ax, ay, cx, cy];
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const am = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  // Choose the sweep direction that passes through the mid point.
  const norm = (a: number) => { while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; return a; };
  let sweep = norm(a1 - a0);
  if (norm(am - a0) > sweep) sweep -= 2 * Math.PI;
  const steps = Math.max(4, Math.min(96, Math.ceil(Math.abs(sweep) * r / maxSeg)));
  const out: number[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = a0 + (sweep * k) / steps;
    out.push(ux + r * Math.cos(a), uy + r * Math.sin(a));
  }
  return out;
}
