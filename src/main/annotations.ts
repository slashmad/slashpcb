// Markers placed by the user on the board or schematic, each carrying a task for the agent.
// Stored per project in the app state folder (annotations.json) so they survive restarts and are shared
// with any agent session (via the list_annotations / resolve_annotation MCP tools).
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeAnnotation } from "../shared/annotationText";
import type { Annotation } from "../shared/types";

export class Annotations extends EventEmitter {
  private items: Annotation[] = [];
  private file: string;

  constructor(stateDir: string) {
    super();
    this.file = join(stateDir, "annotations.json");
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(j)) this.items = j;
    } catch { /* none yet */ }
  }

  list(): Annotation[] { return this.items.slice(); }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.items, null, 1));
    this.emit("changed", this.list());
  }

  add(a: Omit<Annotation, "id" | "n" | "status" | "createdAt" | "updatedAt">): Annotation {
    const n = this.items.reduce((m, x) => Math.max(m, x.n), 0) + 1;
    const now = Date.now();
    const item: Annotation = { ...a, id: `m${now.toString(36)}${n}`, n, status: "open", createdAt: now, updatedAt: now };
    this.items.push(item);
    this.save();
    return item;
  }

  update(id: string, patch: Partial<Pick<Annotation, "text" | "status" | "agentNote">>): Annotation | null {
    const a = this.items.find((x) => x.id === id || String(x.n) === String(id).replace(/^#/, ""));
    if (!a) return null;
    Object.assign(a, patch, { updatedAt: Date.now() });
    this.save();
    return a;
  }

  remove(id: string): void {
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
  }

  clearDone(): void {
    this.items = this.items.filter((x) => x.status !== "done");
    this.save();
  }

  static describe(a: Annotation): string { return describeAnnotation(a); }
}
