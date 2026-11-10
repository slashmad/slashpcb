// Folds normalised AgentEvents into a transcript the panel can render.
import type { AgentEvent, AgentKind, McpActivity, PermissionDecision, UsageSnapshot } from "../shared/types";

export type Item =
  | { kind: "user"; id: string; text: string; ts: number }
  | { kind: "assistant"; id: string; text: string; ts: number; streaming: boolean }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; status: "running" | "done" | "error"; output?: string; ts: number }
  | { kind: "permission"; id: string; tool: string; input: unknown; description?: string; canAlways: boolean; decision?: PermissionDecision }
  | { kind: "error"; id: string; text: string }
  | { kind: "activity"; id: string; a: McpActivity }
  | { kind: "turn"; id: string; durationMs?: number; tokensIn?: number; tokensOut?: number; error?: string };

export interface AgentState {
  kind: AgentKind;
  items: Item[];
  status: "starting" | "idle" | "busy" | "stopped" | "error" | "off";
  sessionId?: string;
  model?: string;
  usage: Partial<Record<AgentKind, UsageSnapshot>>;
}

export const initialAgent = (kind: AgentKind): AgentState => ({ kind, items: [], status: "off", usage: {} });

let seq = 0;
const uid = (p: string) => `${p}${Date.now()}-${seq++}`;

function upsert(items: Item[], id: string, make: () => Item, patch: (it: any) => Item): Item[] {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return [...items, make()];
  const copy = items.slice();
  copy[i] = patch(copy[i]);
  return copy;
}

export function reduce(s: AgentState, kind: AgentKind, ev: AgentEvent): AgentState {
  if (ev.type === "usage") return { ...s, usage: { ...s.usage, [ev.usage.agent]: ev.usage } };
  if (kind !== s.kind && ev.type !== "history-reset") return s;
  switch (ev.type) {
    case "history-reset":
      return { ...s, kind, items: [], sessionId: undefined, status: "starting" };
    case "status":
      return { ...s, status: ev.state, items: s.items.map((it) => (it.kind === "assistant" && ev.state !== "busy" ? { ...it, streaming: false } : it)) };
    case "session":
      return { ...s, sessionId: ev.sessionId, model: ev.model ?? s.model };
    case "user":
      return { ...s, items: [...s.items, { kind: "user", id: ev.id, text: ev.text, ts: ev.ts }] };
    case "text-delta":
      return { ...s, items: upsert(s.items, ev.id, () => ({ kind: "assistant", id: ev.id, text: ev.text, ts: Date.now(), streaming: true }), (it) => ({ ...it, text: it.text + ev.text })) };
    case "text":
      return { ...s, items: upsert(s.items, ev.id, () => ({ kind: "assistant", id: ev.id, text: ev.text, ts: ev.ts, streaming: false }), (it) => ({ ...it, text: ev.text, streaming: false })) };
    case "thinking":
      return { ...s, items: upsert(s.items, "th-" + ev.id, () => ({ kind: "thinking", id: "th-" + ev.id, text: ev.text }), (it) => ({ ...it, text: it.text + ev.text })) };
    case "tool":
      return {
        ...s,
        items: upsert(s.items, ev.id, () => ({ kind: "tool", id: ev.id, name: ev.name || "verktyg", input: ev.input, status: ev.status, output: ev.output, ts: ev.ts }),
          (it) => ({ ...it, name: ev.name || it.name, input: ev.input ?? it.input, status: ev.status, output: ev.output ?? it.output })),
      };
    case "permission":
      return { ...s, items: [...s.items, { kind: "permission", id: ev.requestId, tool: ev.tool, input: ev.input, description: ev.description, canAlways: ev.canAlways }] };
    case "permission-resolved":
      return { ...s, items: s.items.map((it) => (it.kind === "permission" && it.id === ev.requestId ? { ...it, decision: ev.decision } : it)) };
    case "turn-complete":
      return {
        ...s,
        items: [...s.items.map((it) => (it.kind === "assistant" ? { ...it, streaming: false } : it)),
          { kind: "turn", id: uid("t"), durationMs: ev.durationMs, tokensIn: ev.usage ? ev.usage.inputTokens + (ev.usage.cacheReadTokens ?? 0) + (ev.usage.cacheWriteTokens ?? 0) : undefined, tokensOut: ev.usage?.outputTokens, error: ev.error }],
      };
    case "error":
      return { ...s, items: [...s.items, { kind: "error", id: uid("e"), text: ev.message }] };
  }
  return s;
}

export function addActivity(s: AgentState, a: McpActivity): AgentState {
  return { ...s, items: [...s.items, { kind: "activity", id: uid("a"), a }] };
}
