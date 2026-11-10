// KiCad design tools exposed to agents through the MCP hub. Phase 1: read-only plus renders.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardModel, Footprint, HighlightRequest, SchSymbol, SnapshotRequest } from "../shared/types";
import { Annotations } from "./annotations";
import { summarizeReport } from "./kicad/checks";
import { runCli } from "./kicad/cli";
import type { McpHub, ToolResult } from "./mcpHub";
import type { KicadProject } from "./project";

export interface ToolContext {
  project(): KicadProject | null;
  annotations(): Annotations | null;
  snapshot(req: Omit<SnapshotRequest, "reqId">): Promise<string>; // data URL (PNG)
  highlight(req: HighlightRequest): void;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });
const mm = (v: number) => v.toFixed(3).replace(/\.?0+$/, "");

/** Escapes a user filter into a case-insensitive regex; "*" and "?" are wildcards. */
function matcher(filter?: string): (s: string) => boolean {
  if (!filter) return () => true;
  const re = new RegExp(filter.split(/\s+/).filter(Boolean).map((f) => f.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")).join("|"), "i");
  return (s) => re.test(s);
}

function fpLine(f: Footprint): string {
  const pick = (k: string[]) => k.map((x) => f.fields[x]).find(Boolean);
  const mpn = pick(["MPN", "Manufacturer Part Number", "MFR PN", "PartNumber"]);
  const lcsc = pick(["LCSC", "LCSC Part #", "LCSC Part", "JLCPCB Part #"]);
  const flags = f.attrs.filter((a) => /dnp|exclude/.test(a));
  return `${f.ref}\t${f.value}\t${f.lib}\t${f.side === "B" ? "bottom" : "top"}\t(${mm(f.x)}, ${mm(f.y)}) ${mm(f.rot)}°` +
    `${mpn ? `\tMPN ${mpn}` : ""}${lcsc ? `\tLCSC ${lcsc}` : ""}${flags.length ? `\t[${flags.join(",")}]` : ""}`;
}

function netSummary(b: BoardModel, name: string): string {
  const pads: string[] = [];
  for (const f of b.footprints) for (const p of f.pads) if (p.net === name) pads.push(`${f.ref}.${p.num}${p.pinFunction ? `(${p.pinFunction})` : ""}`);
  const perLayer = new Map<string, number>();
  let widths = new Set<number>();
  for (const t of b.tracks) {
    if (t.net !== name) continue;
    let len = 0;
    if (t.pts) for (let k = 2; k < t.pts.length; k += 2) len += Math.hypot(t.pts[k] - t.pts[k - 2], t.pts[k + 1] - t.pts[k - 1]);
    else len = Math.hypot(t.x2 - t.x1, t.y2 - t.y1);
    perLayer.set(t.layer, (perLayer.get(t.layer) ?? 0) + len);
    widths.add(t.w);
  }
  const vias = b.vias.filter((v) => v.net === name);
  const zones = b.zones.filter((z) => z.net === name && !z.keepout);
  const total = [...perLayer.values()].reduce((a, c) => a + c, 0);
  return [
    `Net ${name}: ${pads.length} pad(s), ${vias.length} via(s), tracks ${total.toFixed(2)} mm` +
      (perLayer.size ? ` (${[...perLayer].map(([l, v]) => `${l} ${v.toFixed(2)}`).join(", ")})` : "") +
      (widths.size ? `, widths ${[...widths].sort().map(mm).join("/")} mm` : ""),
    zones.length ? `Zones: ${zones.map((z) => `${z.name ?? "zone"} on ${z.layers.join("+")}${z.fills.length ? "" : " (unfilled)"}`).join("; ")}` : "Zones: none",
    `Pads: ${pads.join(" ") || "(none)"}`,
  ].join("\n");
}

function symbolLine(s: SchSymbol): string {
  return `${s.ref}\t${s.value}\t${s.libId}\tsheet ${s.sheet}\tfootprint ${s.footprint || "(none)"}${s.dnp ? "\tDNP" : ""}${!s.inBom ? "\tnot in BOM" : ""}${!s.onBoard ? "\tnot on board" : ""}`;
}

export function designSummary(p: KicadProject): string {
  const i = p.info, d = p.design, b = d.board, s = d.schematic;
  const lines = [`Project ${i.name} in ${i.dir}`];
  lines.push(i.frozen ? `FROZEN: ${i.frozenReason ?? "release"} — do not edit; propose a new derivative.` : "Editable (not frozen).");
  if (i.locks.length) lines.push(`KiCad has open: ${i.locks.map((l) => l.file).join(", ")} — do not edit those files while open.`);
  if (i.otherProjects.length) lines.push(`Other projects in this folder: ${i.otherProjects.join(", ")}`);
  if (s) {
    const real = s.symbols.filter((x) => !x.power);
    lines.push(`Schematic ${s.root}: ${s.sheets.length} sheet(s) [${s.sheets.map((x) => x.path).join(", ")}], ${real.length} symbols, ${s.labels.length} labels.`);
  } else lines.push("No schematic.");
  if (b) {
    const w = b.bbox[2] - b.bbox[0], h = b.bbox[3] - b.bbox[1];
    lines.push(`Board ${b.file.split(/[\\/]/).pop()}: ${mm(w)} × ${mm(h)} mm, ${b.copper.length} copper layers (${b.copper.join(", ")})${b.thickness ? `, thickness ${b.thickness} mm` : ""}, KiCad format ${b.version}.`);
    lines.push(`Board contents: ${b.stats.footprints} footprints (${b.footprints.filter((f) => f.side === "B").length} bottom), ${b.stats.pads} pads, ${b.stats.tracks} tracks (${b.stats.trackLengthMm} mm), ${b.stats.vias} vias, ${b.stats.zones} zones, ${b.stats.nets} nets.`);
    if (b.title || b.rev) lines.push(`Title block: ${b.title ?? ""}${b.rev ? ` rev ${b.rev}` : ""}${b.date ? ` (${b.date})` : ""}`);
  } else lines.push("No board.");
  lines.push(summarizeReport(d.erc, 10));
  lines.push(summarizeReport(d.drc, 10));
  if (d.errors.length) lines.push(`Pipeline problems: ${d.errors.join("; ")}`);
  if (p.state.running) lines.push(`Background run in progress (${p.state.stage}).`);
  return lines.join("\n");
}

export function registerTools(hub: McpHub, ctx: ToolContext): void {
  const need = () => {
    const p = ctx.project();
    if (!p) throw new Error("No KiCad project is open in SlashPCB.");
    return p;
  };
  const board = () => { const b = need().design.board; if (!b) throw new Error("This project has no board (.kicad_pcb)."); return b; };

  hub.register("get_design", {
    description: "Summary of the open KiCad project: frozen/lock status, sheets, board size and layers, counts, and the latest ERC/DRC results.",
    inputSchema: { type: "object", properties: {} },
    async run() { return text(designSummary(need())); },
  });

  hub.register("list_components", {
    description: "Footprints on the board (or schematic symbols when there is no board): reference, value, footprint, side, position/rotation (mm/deg), MPN/LCSC. Filter by text matching ref/value/footprint/fields; '*' wildcards allowed.",
    inputSchema: { type: "object", properties: {
      filter: { type: "string", description: "e.g. 'U*', '100n', 'TPS63900', 'C1 C2'" },
      side: { type: "string", enum: ["top", "bottom", "all"] },
      limit: { type: "integer", minimum: 1, maximum: 2000 },
    } },
    async run(a) {
      const p = need();
      const m = matcher(a.filter);
      const limit = a.limit ?? 300;
      const b = p.design.board;
      if (b) {
        const list = b.footprints.filter((f) => (a.side === "top" ? f.side === "F" : a.side === "bottom" ? f.side === "B" : true) &&
          m([f.ref, f.value, f.lib, ...Object.values(f.fields)].join(" ")))
          .sort((x, y) => x.ref.localeCompare(y.ref, undefined, { numeric: true }));
        return text(`${list.length} footprint(s)${list.length > limit ? `, first ${limit}` : ""}. Columns: ref, value, footprint, side, position rotation, MPN, LCSC, flags\n` + list.slice(0, limit).map(fpLine).join("\n"));
      }
      const s = p.design.schematic;
      if (!s) return text("No board or schematic.", true);
      const list = s.symbols.filter((x) => !x.power && m([x.ref, x.value, x.libId, ...Object.values(x.fields)].join(" ")));
      return text(`${list.length} symbol(s)\n` + list.slice(0, limit).map(symbolLine).join("\n"));
    },
    summarize: (a) => `Components ${a.filter ?? ""}`.trim(),
  });

  hub.register("get_component", {
    description: "Everything about one reference designator: schematic symbol (sheet, fields, pins) and footprint (position, side, fields, pads with nets and pad shapes).",
    inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    async run(a) {
      const p = need();
      const ref = String(a.ref);
      const out: string[] = [];
      const syms = p.design.schematic?.symbols.filter((s) => s.ref === ref) ?? [];
      for (const s of syms) {
        out.push(`Symbol ${s.ref} (unit ${s.unit}) ${s.libId} on sheet ${s.sheet} at (${mm(s.x)}, ${mm(s.y)}) rot ${s.rot}${s.mirror ? ` mirror ${s.mirror}` : ""}`);
        out.push(`  fields: ${Object.entries(s.fields).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ")}`);
        out.push(`  pins: ${s.pins.map((x) => `${x.num}${x.name && x.name !== "~" ? `(${x.name})` : ""}`).join(" ")}`);
      }
      const f = p.design.board?.footprints.find((x) => x.ref === ref);
      if (f) {
        out.push(`Footprint ${fpLine(f)}`);
        out.push(`  fields: ${Object.entries(f.fields).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ")}`);
        out.push(`  attributes: ${f.attrs.join(", ") || "none"}; bbox (${f.bbox.map(mm).join(", ")})`);
        for (const pd of f.pads) out.push(`  pad ${pd.num}: ${pd.net || "(no net)"} — ${pd.type} ${pd.shape} ${mm(pd.w)}×${mm(pd.h)}${pd.drill ? ` drill ${mm(pd.drill)}` : ""} at (${mm(pd.x)}, ${mm(pd.y)}) on ${pd.layers.filter((l) => l.endsWith(".Cu")).join("+")}`);
      }
      return out.length ? text(out.join("\n")) : text(`No component ${ref}.`, true);
    },
    summarize: (a) => `Component ${a.ref}`,
  });

  hub.register("list_nets", {
    description: "Nets on the board with pad, via and track counts. Filter with text or wildcards (e.g. 'GND', 'USB*', '*VBUS*').",
    inputSchema: { type: "object", properties: { filter: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 5000 } } },
    async run(a) {
      const b = board();
      const m = matcher(a.filter);
      const pads = new Map<string, number>(), tracks = new Map<string, number>(), vias = new Map<string, number>();
      for (const f of b.footprints) for (const p of f.pads) if (p.net) pads.set(p.net, (pads.get(p.net) ?? 0) + 1);
      for (const t of b.tracks) tracks.set(t.net, (tracks.get(t.net) ?? 0) + 1);
      for (const v of b.vias) vias.set(v.net, (vias.get(v.net) ?? 0) + 1);
      const list = b.nets.filter(m);
      const limit = a.limit ?? 400;
      return text(`${list.length} net(s)\n` + list.slice(0, limit).map((n) => `${n}\tpads ${pads.get(n) ?? 0}\ttracks ${tracks.get(n) ?? 0}\tvias ${vias.get(n) ?? 0}`).join("\n"));
    },
  });

  hub.register("get_net", {
    description: "What one net connects: pads (ref.pin), track length per layer and widths, vias, zones; plus schematic labels with that name.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run(a) {
      const p = need();
      const b = p.design.board;
      const name = String(a.name);
      const out: string[] = [];
      if (b) {
        const exact = b.nets.find((n) => n === name) ?? b.nets.find((n) => n.toLowerCase() === name.toLowerCase()) ?? b.nets.find((n) => n.replace(/^\//, "") === name.replace(/^\//, ""));
        if (exact) out.push(netSummary(b, exact));
        else out.push(`No board net named ${name}. Similar: ${b.nets.filter((n) => n.toLowerCase().includes(name.toLowerCase())).slice(0, 20).join(", ") || "none"}`);
      }
      const labels = p.design.schematic?.labels.filter((l) => l.text === name.replace(/^.*\//, "")) ?? [];
      if (labels.length) out.push(`Schematic labels: ${labels.map((l) => `${l.kind} on ${l.sheet} at (${mm(l.x)}, ${mm(l.y)})`).join("; ")}`);
      return text(out.join("\n") || "Nothing found.");
    },
    summarize: (a) => `Net ${a.name}`,
  });

  hub.register("run_checks", {
    description: "Run ERC and/or DRC now (kicad-cli, with schematic parity) and return the violations with positions and references. Checks also run automatically after saves.",
    inputSchema: { type: "object", properties: { which: { type: "string", enum: ["both", "erc", "drc"] }, max: { type: "integer", minimum: 1, maximum: 500 } } },
    async run(a) {
      const p = need();
      const d = await p.request("agent", { checks: true });
      const which = a.which ?? "both";
      const parts: string[] = [];
      if (which !== "drc") parts.push(summarizeReport(d.erc, a.max ?? 60));
      if (which !== "erc") parts.push(summarizeReport(d.drc, a.max ?? 60));
      if (d.errors.length) parts.push(`Pipeline problems: ${d.errors.join("; ")}`);
      const bad = [d.erc, d.drc].some((r) => r && (!r.ok || r.errors > 0));
      return text(parts.join("\n\n"), bad);
    },
    summarize: (_a, r) => (r.isError ? "Checks: errors" : "Checks OK"),
  });

  hub.register("render_view", {
    description: "Render a PNG. view=board: 2D board with chosen layers, optional highlighted refs/nets and zoom to refs (the user's own view is not changed). view=schematic: one sheet (path like '/' or '/Power/' or its name), optionally zoomed to refs. view=3d: raytraced 3D render by KiCad from top/bottom/iso. Images cost context: request them when they add information.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["board", "schematic", "3d"] },
        layers: { type: "array", items: { type: "string" }, description: "board: e.g. ['F.Cu','F.SilkS','Edge.Cuts']; default = user's visible layers" },
        side: { type: "string", enum: ["top", "bottom", "iso"], description: "board: which side is in front (bottom mirrors the view); 3d: camera" },
        highlight_refs: { type: "array", items: { type: "string" } },
        highlight_nets: { type: "array", items: { type: "string" } },
        focus_refs: { type: "array", items: { type: "string" }, description: "zoom to these parts" },
        sheet: { type: "string" },
        width: { type: "integer", minimum: 200, maximum: 2000 },
        height: { type: "integer", minimum: 200, maximum: 2000 },
      },
      required: ["view"],
    },
    async run(a) {
      const p = need();
      const width = a.width ?? 1100, height = a.height ?? 750;
      if (a.view === "3d") {
        if (!p.info.pcb) return text("No board.", true);
        const dir = join(p.outDir, "renders");
        mkdirSync(dir, { recursive: true });
        const out = join(dir, `render-${Date.now()}.png`);
        const args = ["pcb", "render", "-o", out, "--width", String(width), "--height", String(height), "--background", "opaque", "--quality", "basic"];
        if (a.side === "bottom") args.push("--side", "bottom");
        else if (a.side === "iso") args.push("--side", "top", "--rotate", "-45,0,45", "--perspective");
        args.push(p.info.pcb);
        const r = await runCli(args, p.shadowDir, 300000);
        if (!existsSync(out)) return text(`3D render failed: ${(r.stderr || r.stdout).trim().slice(-500)}`, true);
        return { content: [{ type: "image", data: readFileSync(out).toString("base64"), mimeType: "image/png" }, { type: "text", text: `3D render (${a.side ?? "top"}), ${r.seconds.toFixed(1)} s` }] };
      }
      const url = await ctx.snapshot({
        view: a.view === "schematic" ? "schematic" : "board", width, height, layers: a.layers, side: a.side === "bottom" ? "bottom" : "top",
        highlightRefs: a.highlight_refs, highlightNets: a.highlight_nets, focusRefs: a.focus_refs, sheet: a.sheet,
      });
      const data = url.replace(/^data:image\/png;base64,/, "");
      return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: `View: ${a.view}${a.sheet ? ` ${a.sheet}` : ""}` }] };
    },
    summarize: (a) => `Image ${a.view}${a.sheet ? ` ${a.sheet}` : ""}`,
  });

  hub.register("highlight", {
    description: "Highlight parts and/or nets in the user's live view while you explain. focus=true also zooms their view to them.",
    inputSchema: { type: "object", properties: {
      refs: { type: "array", items: { type: "string" } }, nets: { type: "array", items: { type: "string" } },
      message: { type: "string" }, focus: { type: "boolean" }, view: { type: "string", enum: ["board", "schematic", "3d"] },
    } },
    async run(a) {
      // Accept common variants agents guess ("parts", a JSON string instead of an array).
      const list = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : typeof v === "string" ? (v.trim().startsWith("[") ? (() => { try { return JSON.parse(v).map(String); } catch { return [v]; } })() : v.split(/[\s,]+/).filter(Boolean)) : [];
      const refs = list(a.refs ?? a.parts ?? a.components), nets = list(a.nets);
      ctx.highlight({ refs, nets, message: a.message, focus: a.focus, view: a.view });
      return text(`Highlighted ${refs.length} part(s) and ${nets.length} net(s) for the user.`);
    },
  });

  hub.register("list_annotations", {
    description: "Markers the user placed on the board or schematic (numbered pins), each with a task, nearest reference and net. Work through open ones and call resolve_annotation when done.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "done", "all"] } } },
    async run(a) {
      need();
      const list = (ctx.annotations()?.list() ?? []).filter((x) => (a.status ?? "open") === "all" || x.status === (a.status ?? "open"));
      if (!list.length) return text("No markers with that status.");
      return text(list.map((x) => Annotations.describe(x)).join("\n"));
    },
    summarize: (_a, r) => r.content[0]?.type === "text" ? `${(r.content[0].text.match(/^#/gm) ?? []).length} marker(s)` : "",
  });

  hub.register("resolve_annotation", {
    description: "Mark one of the user's markers as done, with a short note on what you found or changed. Use the number (e.g. 3 or #3) or id.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, note: { type: "string" } }, required: ["id", "note"] },
    async run(a) {
      need();
      const r = ctx.annotations()?.update(String(a.id), { status: "done", agentNote: a.note });
      return r ? text(`Marker #${r.n} marked as done.`) : text(`No marker ${a.id} found.`, true);
    },
    summarize: (a) => `Marker ${a.id} done`,
  });
}
