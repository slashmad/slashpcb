// KiCad design tools exposed to agents through the MCP hub. Phase 1: read-only plus renders.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BoardModel, Footprint, HighlightRequest, SchSymbol, SnapshotRequest } from "../shared/types";
import { Annotations } from "./annotations";
import type { KicadBridge } from "./kicad/bridge";
import { summarizeReport } from "./kicad/checks";
import { compareWithFolder, compareWithGit, diffText } from "./kicad/compare";
import { setFields } from "./kicad/edit";
import { PROFILES } from "./kicad/release";
import { listPackages, preflightText, releaseRoot, runPreflight, runRelease } from "./releases";
import { runCli } from "./kicad/cli";
import type { McpHub, ToolResult } from "./mcpHub";
import { resolveProject, type KicadProject } from "./project";

export interface ToolContext {
  project(): KicadProject | null;
  annotations(): Annotations | null;
  snapshot(req: Omit<SnapshotRequest, "reqId">): Promise<string>; // data URL (PNG)
  highlight(req: HighlightRequest): void;
  bridge(): KicadBridge | null; // null when the live link is off
  appVersion: string;
  showCompare(d: unknown): void;
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

  // ---------------------------------------------------------------- live link (KiCad IPC API)
  const live = async () => {
    const p = need();
    const br = ctx.bridge();
    if (!br) throw new Error("The KiCad live link is off. Ask the user to turn it on (top bar: KiCad live).");
    const st = await br.request("status");
    if (!st.connected) throw new Error(`KiCad is not reachable through its IPC API (${st.error ?? "not running"}). Ask the user to open the board in KiCad's PCB editor with the API server enabled.`);
    const pcb = p.info.pcb;
    if (!pcb || !(st.boards ?? []).some((b: string) => b.split(/[\\/]/).pop() === pcb)) throw new Error(`KiCad's PCB editor does not have ${pcb ?? "this project's board"} open (open: ${(st.boards ?? []).join(", ") || "none"}).`);
    return { p, br, pcb };
  };
  const notFrozen = (p: KicadProject) => { if (p.info.frozen) throw new Error(`The project is frozen (${p.info.frozenReason}). Propose a new derivative instead.`); };

  hub.register("kicad_live_status", {
    description: "Whether SlashPCB's live link reaches a running KiCad, which boards are open there, and whether it is this project's board.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const p = need();
      const br = ctx.bridge();
      if (!br) return text("Live link is off (the user can turn it on in the top bar).");
      const st = await br.request("status").catch((e: any) => ({ connected: false, error: e.message }));
      const match = (st.boards ?? []).some((b: string) => b.split(/[\\/]/).pop() === p.info.pcb);
      return text(st.connected ? `Connected to KiCad ${st.version ?? ""}. Open boards: ${(st.boards ?? []).join(", ") || "none"}. This project's board ${match ? "IS" : "is NOT"} open.` : `Not connected: ${st.error ?? "KiCad not running"}`);
    },
  });

  hub.register("kicad_select", {
    description: "Select footprints in the user's open KiCad PCB editor (and in SlashPCB), e.g. to show what you mean.",
    inputSchema: { type: "object", properties: { refs: { type: "array", items: { type: "string" } } }, required: ["refs"] },
    async run(a) {
      const { br, pcb } = await live();
      const r = await br.request("select", { refs: a.refs ?? [], board: pcb });
      ctx.highlight({ refs: a.refs ?? [], focus: true, view: "board" });
      return text(`Selected ${r.selected} footprint(s) in KiCad.`);
    },
  });

  hub.register("kicad_move", {
    description: "Move and/or rotate footprints in the user's open KiCad PCB editor as ONE undoable step (Ctrl+Z in KiCad). Absolute x/y in mm (board coordinates, y down) or relative dx/dy; rot in degrees. Not saved: the user reviews and saves in KiCad. Tracks are not rerouted; check with the user afterwards.",
    inputSchema: { type: "object", properties: {
      moves: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, x: { type: "number" }, y: { type: "number" }, dx: { type: "number" }, dy: { type: "number" }, rot: { type: "number" } }, required: ["ref"] } },
      message: { type: "string", description: "Undo-history label" },
    }, required: ["moves"] },
    async run(a) {
      const { p, br, pcb } = await live();
      notFrozen(p);
      const r = await br.request("move", { moves: a.moves, message: a.message ? `SlashPCB: ${a.message}` : undefined, board: pcb });
      ctx.highlight({ refs: (a.moves ?? []).map((m: any) => m.ref), focus: false, view: "board" });
      return text(`Moved in KiCad (unsaved, undo with Ctrl+Z there): ${r.moved.map((m: any) => `${m.ref} → (${m.x}, ${m.y})${m.rot != null ? ` ${m.rot}°` : ""}`).join("; ")}. SlashPCB's views update when the user saves.`);
    },
    summarize: (a) => `Move ${(a.moves ?? []).map((m: any) => m.ref).join(", ")}`,
  });

  hub.register("kicad_set_value", {
    description: "Set Value, Datasheet or Description of footprints in the user's open KiCad PCB editor (one undoable step, not saved). For MPN/LCSC and other fields use set_fields.",
    inputSchema: { type: "object", properties: { refs: { type: "array", items: { type: "string" } }, field: { type: "string", enum: ["Value", "Datasheet", "Description"] }, value: { type: "string" } }, required: ["refs", "field", "value"] },
    async run(a) {
      const { p, br, pcb } = await live();
      notFrozen(p);
      const r = await br.request("set_field", { refs: a.refs, field: a.field, value: a.value, board: pcb });
      return text(`Changed ${a.field} on ${r.changed} footprint(s) in KiCad (unsaved). Remember the schematic: use set_fields for the symbols too.`);
    },
  });

  hub.register("kicad_refill_zones", {
    description: "Refill all copper zones in the user's open KiCad PCB editor (not saved).",
    inputSchema: { type: "object", properties: {} },
    async run() { const { p, br, pcb } = await live(); notFrozen(p); await br.request("refill_zones", { board: pcb }, 120000); return text("Zones refilled in KiCad (unsaved)."); },
  });

  hub.register("kicad_save", {
    description: "Save the board in the user's open KiCad PCB editor. Only when the user asked to save.",
    inputSchema: { type: "object", properties: {} },
    async run() { const { p, br, pcb } = await live(); notFrozen(p); await br.request("save", { board: pcb }); return text("Saved in KiCad. Checks run again automatically."); },
  });

  // ---------------------------------------------------------------- file edits (schematic fields)
  hub.register("set_fields", {
    description: "Set fields (MPN, LCSC, Manufacturer, Value, Datasheet or any custom field) on schematic symbols by reference, written into the .kicad_sch files with a minimal edit; also_board=true writes the same fields on the board footprints. Refused for frozen projects and for files KiCad has open (ask the user to close them or use kicad_set_value for the open board). Symbols in sheets used several times share the field.",
    inputSchema: { type: "object", properties: {
      refs: { type: "array", items: { type: "string" } },
      fields: { type: "object", additionalProperties: { type: "string" }, description: "e.g. {\"MPN\": \"GRM155R71C104KA88D\", \"LCSC\": \"C1525\"}" },
      also_board: { type: "boolean" },
    }, required: ["refs", "fields"] },
    async run(a) {
      const p = need();
      notFrozen(p);
      const refs: string[] = (a.refs ?? []).map(String);
      const fields: Record<string, string> = a.fields ?? {};
      const names = Object.keys(fields);
      if (!refs.length || !names.length) return text("Give refs and fields.", true);
      if (names.includes("Reference")) return text("Renaming references is not supported here; use KiCad's annotation.", true);
      const sch = p.design.schematic, board = p.design.board;
      const lockedFiles = new Set(p.readInfo().locks.map((l) => l.file));
      const out: string[] = [];
      const missing = new Set(refs);
      if (sch) {
        const byFile = new Map<string, { uuid: string; field: string; value: string }[]>();
        const pos = new Map<string, [number, number]>();
        const seen = new Set<string>();
        for (const s of sch.symbols) {
          if (!refs.includes(s.ref) || seen.has(`${s.file}|${s.uuid}`)) continue;
          seen.add(`${s.file}|${s.uuid}`);
          missing.delete(s.ref);
          pos.set(s.uuid, [Math.round(s.x * 100) / 100, Math.round((s.bbox[3] + 2.54) * 100) / 100]);
          for (const f of names) byFile.set(s.file, [...(byFile.get(s.file) ?? []), { uuid: s.uuid, field: f, value: String(fields[f]) }]);
        }
        for (const [file, edits] of byFile) {
          if (lockedFiles.has(file.split("/").pop()!)) { out.push(`SKIPPED ${file}: open in KiCad's schematic editor`); continue; }
          const r = setFields(p.abs(file), "sch", edits, (u) => pos.get(u) ?? [0, 0]);
          out.push(`${file}: ${r.changed} changed, ${r.inserted} added${r.missing.length ? `, ${r.missing.length} not found` : ""}`);
        }
      }
      if (a.also_board && board && p.info.pcb) {
        if (lockedFiles.has(p.info.pcb)) out.push(`SKIPPED ${p.info.pcb}: open in KiCad's PCB editor (use kicad_set_value for Value, or ask the user to close it)`);
        else {
          const edits = board.footprints.filter((f) => refs.includes(f.ref)).flatMap((f) => { missing.delete(f.ref); return names.map((n) => ({ uuid: f.uuid, field: n, value: String(fields[n]) })); });
          const r = setFields(p.abs(p.info.pcb), "pcb", edits);
          out.push(`${p.info.pcb}: ${r.changed} changed, ${r.inserted} added${r.missing.length ? `, ${r.missing.length} not found` : ""}`);
        }
      }
      if (missing.size) out.push(`Not found: ${[...missing].join(", ")}`);
      const d = await p.request("agent", { checks: true });
      out.push(summarizeReport(d.erc, 5), summarizeReport(d.drc, 5));
      return text(out.join("\n"));
    },
    summarize: (a) => `Fields on ${(a.refs ?? []).join(", ")}`,
  });

  // ---------------------------------------------------------------- release packages
  hub.register("release_preflight", {
    description: `Check whether the board is ready for a fabrication/assembly package for a supplier profile (${PROFILES.map((x) => x.id).join(", ")}): ERC/DRC, unrouted, schematic parity, parts inside the outline, paste on THT pads, unique references, part numbers, bottom-side assembly. Runs fresh checks. Read-only.`,
    inputSchema: { type: "object", properties: { profile: { type: "string", enum: PROFILES.map((x) => x.id) } } },
    async run(a) {
      const p = need();
      const pf = await runPreflight(p, a.profile ?? "jlcpcb", true);
      return text(preflightText(pf), !pf.ok);
    },
    summarize: (a, r) => `Preflight ${a.profile ?? "jlcpcb"}${r.isError ? ": blocked" : ": ok"}`,
  });

  hub.register("export_release", {
    description: "Write a fabrication/assembly package for a supplier profile: Gerber + Excellon zip, BOM and CPL in the supplier's columns, KiCad position file, MANIFEST.json with SHA-256 hashes and README.txt. Goes to <project>/fab/<name> (frozen projects: SlashPCB's own data folder). The package is never a release by itself; a failed preflight is written into it as PREFLIGHT_FAILED_DO_NOT_ORDER. Only when the user asked for a package.",
    inputSchema: { type: "object", properties: { profile: { type: "string", enum: PROFILES.map((x) => x.id) } }, required: ["profile"] },
    async run(a) {
      const p = need();
      const r = await runRelease(p, a.profile, ctx.appVersion);
      return text([`Package written in ${r.seconds.toFixed(1)} s: ${r.dir}`, ...r.files.map((f) => `  ${f.slice(r.dir.length + 1)}`), "", preflightText(r.preflight)].join("\n"), !r.preflight.ok);
    },
    summarize: (a) => `Package ${a.profile}`,
  });

  hub.register("list_releases", {
    description: "Packages made earlier for this project (folder, profile, status, time).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const p = need();
      const l = listPackages(p);
      return text(l.length ? l.map((x) => `${x.createdAt}  ${x.profile}  ${x.status}  ${x.dir}`).join("\n") : `No packages yet (they go to ${releaseRoot(p)}).`);
    },
  });

  // ---------------------------------------------------------------- revision comparison
  hub.register("compare_revision", {
    description: "Compare the open design with another revision: a KiCad project folder or file (e.g. the previous revision folder next to this one), or a Git revision of this project's repository (default HEAD). Lists added/removed/moved/rotated/flipped parts, value, footprint and field changes, pad-net changes, nets added/removed, and board/track/via totals. Read-only: the other revision is only parsed. The result is also shown in the user's board view.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Other revision: folder, .kicad_pro, .kicad_pcb or .kicad_sch (absolute or relative to this project's folder)" },
      git_rev: { type: "string", description: "Instead of path: a Git revision such as HEAD or HEAD~3" },
      max: { type: "integer", minimum: 5, maximum: 500 },
    } },
    async run(a) {
      const p = need();
      let d;
      if (a.git_rev || !a.path) {
        if (!p.info.pcb) return text("No board in this project.", true);
        d = await compareWithGit(p.dir, p.info.pcb, p.design, String(a.git_rev ?? "HEAD"));
      } else {
        const target = isAbsolute(String(a.path)) ? String(a.path) : join(p.dir, String(a.path));
        const r = resolveProject(target);
        if (!r) return text(`No KiCad project at ${target}.`, true);
        d = compareWithFolder(r.dir, r.pro.replace(/\.kicad_pro$/i, ""), p.design);
      }
      ctx.showCompare(d);
      return text(diffText(d, a.max ?? 40));
    },
    summarize: (a) => `Compare ${a.git_rev ?? a.path ?? "HEAD"}`,
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
