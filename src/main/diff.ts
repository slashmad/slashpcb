// Small line diff (Myers, O((N+M)D)) for showing what an agent changed in a file.
import type { FileDiff } from "../shared/types";

type Op = { type: "same" | "add" | "del"; line: string };

export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length, max = n + m;
  if (max > 40000) return [...a.map((line) => ({ type: "del" as const, line })), ...b.map((line) => ({ type: "add" as const, line }))];
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const idx = k + max;
      let x = k === -d || (k !== d && v[idx - 1] < v[idx + 1]) ? v[idx + 1] : v[idx - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[idx] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  // Backtrack.
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[k - 1 + max] < vv[k + 1 + max]) ? k + 1 : k - 1;
    const prevX = vv[prevK + max];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ type: "same", line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "add", line: b[y - 1] });
      else ops.push({ type: "del", line: a[x - 1] });
    }
    x = prevX; y = prevY;
  }
  return ops.reverse();
}

/** Group into hunks with `context` unchanged lines around each change. */
export function makeDiff(path: string, before: string, after: string, context = 3): FileDiff {
  const ops = diffLines(before.split("\n"), after.split("\n"));
  const hunks: FileDiff["hunks"] = [];
  let oldLine = 1, newLine = 1;
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, i) => {
    if (op.type !== "same") for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = 1;
  });
  let last: FileDiff["hunks"][number] | null = null;
  ops.forEach((op, i) => {
    if (keep[i]) {
      if (!last || last.type !== op.type) {
        last = { type: op.type, lines: [], oldStart: oldLine, newStart: newLine };
        hunks.push(last);
      }
      last.lines.push(op.line);
    } else {
      last = null; // gap between hunks
    }
    if (op.type !== "add") oldLine++;
    if (op.type !== "del") newLine++;
  });
  return { path, hunks, ts: Date.now() };
}
