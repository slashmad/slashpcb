import { EventEmitter } from "node:events";
import type { AgentEvent, AgentKind, PermissionDecision, SessionSummary } from "../../shared/types";

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentStartOptions {
  cwd: string;
  resumeId?: string;
  mcp: McpLaunch;
  /** Extra MCP servers and instructions appended to the system prompt. */
  extraMcp?: Record<string, McpLaunch>;
  extraInstructions?: string;
  model?: string;
  binary: string;
}

/** Emits "event" with AgentEvent. */
export abstract class AgentSession extends EventEmitter {
  abstract readonly kind: AgentKind;
  sessionId: string | null = null;
  busy = false;

  protected emitEvent(ev: AgentEvent): void {
    this.emit("event", ev);
  }

  abstract start(opts: AgentStartOptions): Promise<void>;
  abstract send(text: string): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract answerPermission(requestId: string, decision: PermissionDecision): void;
  abstract stop(): void;
}

export interface AgentHistoryProvider {
  listSessions(cwd: string): Promise<SessionSummary[]>;
}
