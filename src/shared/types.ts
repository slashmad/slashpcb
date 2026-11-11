// Types shared by main process, preload and renderer.

export type AgentKind = "claude" | "codex";

export interface FileNode {
  name: string;
  path: string; // relative to project root, "/" separated
  dir: boolean;
  children?: FileNode[];
  size?: number;
}

// ---------------------------------------------------------------- KiCad project

export interface KicadLock {
  file: string; // project-relative file that KiCad has open
  user?: string;
  host?: string;
}

export interface ProjectInfo {
  dir: string;
  name: string; // project stem, e.g. "StickHub"
  pro: string; // project-relative .kicad_pro
  sch: string | null; // root schematic
  pcb: string | null; // board
  otherProjects: string[]; // further .kicad_pro files in the same folder
  frozen: boolean;
  frozenReason?: string;
  writable: boolean;
  locks: KicadLock[]; // KiCad editors that have files of this project open
}

export interface KicadInfo {
  cli: string | null; // command used for kicad-cli ("" when not found)
  version: string | null;
  flatpak: boolean;
  gui: string | null; // launcher for the KiCad project manager
  error?: string;
}

// ---------------------------------------------------------------- board model (parsed .kicad_pcb)

/** Geometry in board millimetres, y down (KiCad coordinates). Flat point arrays [x0, y0, x1, y1, ...]. */
export interface Shape {
  kind: "line" | "poly" | "circle" | "text";
  layer: string;
  w: number; // stroke width (0 = filled only)
  fill?: boolean;
  pts?: number[]; // line: polyline, poly: closed outline
  cx?: number; cy?: number; r?: number; // circle
  text?: string; x?: number; y?: number; size?: number; angle?: number; mirror?: boolean; // text
}

export interface Pad {
  num: string;
  type: string; // smd, thru_hole, np_thru_hole, connect
  shape: string; // rect, roundrect, circle, oval, custom, trapezoid, chamfered_rect
  x: number; y: number; rot: number;
  w: number; h: number;
  layers: string[]; // expanded copper/tech layers
  net: string;
  drill?: number; // round drill diameter or the larger slot size
  drillMin?: number; // smaller slot size (= drill for round holes)
  polys?: number[][]; // absolute outlines (all shapes except circle; custom pads may have several)
  r?: number; // circle radius
  pinFunction?: string;
  maskMargin?: number; // pad-level solder_mask_margin (overrides footprint and board)
}

export interface Footprint {
  ref: string;
  value: string;
  lib: string; // lib:name
  side: "F" | "B";
  x: number; y: number; rot: number;
  fields: Record<string, string>;
  attrs: string[]; // smd, through_hole, dnp, exclude_from_bom, exclude_from_pos_files, board_only
  bbox: [number, number, number, number]; // absolute minX, minY, maxX, maxY
  pads: Pad[];
  graphics: Shape[]; // absolute
  uuid: string;
  path: string; // schematic path (links footprint to symbol)
  maskMargin?: number; // footprint-level solder_mask_margin
}

export interface Track { x1: number; y1: number; x2: number; y2: number; w: number; layer: string; net: string; pts?: number[] }
export interface Via { x: number; y: number; size: number; drill: number; layers: [string, string]; net: string; type?: string; tenting?: { front: string; back: string } }

export interface StackupLayer { name: string; type: string; thickness?: number; material?: string; color?: string; epsilonR?: number }
export interface Stackup { layers: StackupLayer[]; finish?: string; maskColorTop?: string; maskColorBottom?: string; silkColorTop?: string; silkColorBottom?: string; tentingDefault?: { front: string; back: string } }
export interface Zone {
  net: string;
  name?: string;
  layers: string[];
  outline: number[];
  fills: { layer: string; pts: number[] }[];
  keepout: boolean;
  priority?: number;
}

export interface LayerInfo { id: number; name: string; type: string; user?: string }

export interface BoardModel {
  file: string;
  version: number;
  generator: string;
  title?: string;
  rev?: string;
  date?: string;
  thickness?: number;
  stackup?: Stackup;
  mask?: { padToMask: number; minWidth: number; bridgesInFootprints: boolean }; // board setup
  layers: LayerInfo[];
  copper: string[]; // copper layer names top to bottom
  bbox: [number, number, number, number];
  footprints: Footprint[];
  tracks: Track[];
  vias: Via[];
  zones: Zone[];
  graphics: Shape[]; // board-level graphics (Edge.Cuts, silkscreen, user layers, copper drawings)
  nets: string[];
  stats: { footprints: number; pads: number; tracks: number; vias: number; zones: number; nets: number; trackLengthMm: number };
  parseMs: number;
}

// ---------------------------------------------------------------- schematic model (parsed .kicad_sch tree)

export interface SchPin { num: string; name: string; x: number; y: number }

export interface SchSymbol {
  uuid: string;
  file: string; // project-relative .kicad_sch that holds this symbol
  ref: string;
  value: string;
  footprint: string;
  libId: string;
  sheet: string; // sheet path ("/" root, "/Power/" ...)
  sheetName: string;
  x: number; y: number; rot: number; mirror?: "x" | "y";
  unit: number;
  fields: Record<string, string>;
  dnp: boolean;
  inBom: boolean;
  onBoard: boolean;
  bbox: [number, number, number, number]; // sheet mm
  pins: SchPin[];
  power: boolean;
}

export interface SchSheet {
  path: string; // "/" or "/Name/…/"
  name: string;
  file: string; // project-relative .kicad_sch
  paper: string;
  w: number; h: number; // page mm
  svg: string | null; // exported SVG (absolute, inside the app's state folder)
  page?: string;
  parent?: string; // parent sheet path
  box?: [number, number, number, number]; // sheet symbol on the parent page (mm)
}

export interface SchLabel { text: string; kind: "label" | "global" | "hier" | "power"; sheet: string; x: number; y: number }

export interface SchematicModel {
  root: string;
  sheets: SchSheet[];
  symbols: SchSymbol[];
  labels: SchLabel[];
  parseMs: number;
}

// ---------------------------------------------------------------- checks

export interface CheckItem { description: string; x?: number; y?: number; uuid?: string; ref?: string; sheet?: string }
export interface CheckViolation {
  source: "erc" | "drc" | "unconnected" | "parity" | "rules";
  type: string;
  severity: "error" | "warning" | "exclusion" | string;
  description: string;
  items: CheckItem[];
  sheet?: string;
}
export interface CheckReport {
  kind: "erc" | "drc" | "rules";
  ok: boolean; // ran without tool failure
  ranAt: number;
  seconds: number;
  errors: number;
  warnings: number;
  violations: CheckViolation[];
  unconnected?: number;
  parity?: number;
  error?: string; // tool failure
}

/** Status of the background pipeline (parse → schematic SVG → checks → 3D). */
export interface PipelineState {
  running: boolean;
  stage?: string;
  queued?: boolean;
  n: number;
  lastSeconds?: number;
  error?: string;
}

export interface DesignSnapshot {
  n: number;
  board: BoardModel | null;
  schematic: SchematicModel | null;
  erc: CheckReport | null;
  drc: CheckReport | null;
  rules: CheckReport | null; // design invariants (slashpcb.rules.json)
  rulesFile: string | null;
  glb: string | null; // absolute path of the 3D model export
  errors: string[]; // parse/export failures
}

/** Normalised agent events (Claude stream-json and Codex app-server map onto these). */
export type AgentEvent =
  | { type: "status"; state: "starting" | "idle" | "busy" | "stopped" | "error"; detail?: string }
  | { type: "session"; sessionId: string; model?: string; title?: string }
  | { type: "user"; id: string; text: string; ts: number }
  | { type: "text-delta"; id: string; text: string }
  | { type: "text"; id: string; text: string; ts: number }
  | { type: "thinking"; id: string; text: string }
  | { type: "tool"; id: string; name: string; input: unknown; status: "running" | "done" | "error"; output?: string; ts: number }
  | { type: "permission"; requestId: string; tool: string; input: unknown; description?: string; canAlways: boolean }
  | { type: "permission-resolved"; requestId: string; decision: PermissionDecision }
  | { type: "turn-complete"; durationMs?: number; usage?: TurnUsage; error?: string }
  | { type: "usage"; usage: UsageSnapshot }
  | { type: "error"; message: string }
  | { type: "history-reset" };

export type PermissionDecision = "allow" | "allow-always" | "deny";

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costEstimateUsd?: number;
}

export interface UsageWindow {
  label: string; // "5 h", "7 dagar"
  usedPercent: number; // 0..100
  resetsAt?: number; // unix seconds
  status?: string;
}

export interface UsageSnapshot {
  agent: AgentKind;
  plan?: string;
  windows: UsageWindow[];
  contextUsed?: number;
  contextWindow?: number;
  sessionTokens?: { input: number; output: number; cached: number };
  note?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  agent: AgentKind;
}

/** A numbered marker the user placed on the board or schematic, carrying a task for the agent. */
export interface Annotation {
  id: string;
  n: number;
  view: "board" | "schematic";
  sheet?: string; // schematic sheet path
  x: number; y: number; // mm in board or sheet coordinates
  layer?: string; // board layer that was active
  ref?: string; // nearest footprint/symbol
  net?: string; // net under the point (board)
  text: string;
  status: "open" | "done";
  agentNote?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  settingsVersion?: number;
  language: "en" | "sv";
  theme: "dark" | "light";
  displayBackend: "auto" | "wayland" | "x11";
  kicadCliPath?: string;
  claudePath?: string;
  codexPath?: string;
  claudeModel?: string;
  codexModel?: string;
  recentProjects: string[];
  lastAgent: AgentKind;
  checkTimeoutSec: number;
  autoChecks: boolean; // run ERC/DRC after every save
  auto3d: boolean; // export the 3D model after every save (otherwise when the 3D tab opens)
  onlineParts: boolean; // opt-in for part/stock lookups (not implemented yet)
  liveLink: boolean; // connect to a running KiCad through its IPC API (kicad-python)
  syncSelection: boolean; // mirror selection between KiCad's PCB editor and SlashPCB
  bridgePython?: string; // Python with kicad-python (default: repo .venv or <userData>/bridge-venv)
  supplierCaps?: Record<string, { minTrack?: number; minGap?: number; minDrill?: number; minRing?: number; minViaDiameter?: number; minMaskWeb?: number; thicknesses?: number[]; tenting?: boolean; source?: string }>;
  releaseStep?: boolean; // include a PCBA STEP in release packages
}

export interface LiveStatus { enabled: boolean; running: boolean; connected: boolean; version?: string | null; boards?: string[]; error?: string; python?: string | null; matches?: boolean }

export interface McpActivity {
  tool: string;
  args: unknown;
  ok: boolean;
  summary: string;
  ts: number;
}

export interface FileDiff {
  path: string;
  hunks: { type: "same" | "add" | "del"; lines: string[]; oldStart: number; newStart: number }[];
  ts: number;
}

export type ViewKind = "board" | "schematic" | "3d";

export interface SnapshotRequest {
  reqId: string;
  view: "board" | "schematic";
  width: number;
  height: number;
  layers?: string[]; // board: visible layers (default: the user's current set)
  side?: "top" | "bottom";
  highlightRefs?: string[];
  highlightNets?: string[];
  focusRefs?: string[]; // zoom to these
  sheet?: string; // schematic sheet path or name
  region?: [number, number, number, number]; // mm window
}

export interface HighlightRequest {
  refs?: string[];
  nets?: string[];
  message?: string;
  focus?: boolean;
  view?: ViewKind;
}
