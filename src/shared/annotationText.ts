import type { Annotation } from "./types";

/** One marker as text for the agent (chat message and the list_annotations tool share this). */
export function describeAnnotation(a: Annotation): string {
  const where = a.view === "board"
    ? `board${a.layer ? ` (${a.layer})` : ""} at (${a.x.toFixed(2)}, ${a.y.toFixed(2)}) mm`
    : `schematic sheet ${a.sheet ?? "/"} at (${a.x.toFixed(2)}, ${a.y.toFixed(2)}) mm`;
  const near = [a.ref && `near ${a.ref}`, a.net && `net ${a.net}`].filter(Boolean).join(", ");
  return `#${a.n} [${a.status === "done" ? "done" : "open"}] ${where}${near ? `, ${near}` : ""}.` +
    `\n   Task: ${a.text?.trim() || "(no text)"}` + (a.agentNote ? `\n   Agent note: ${a.agentNote}` : "");
}

/** Short one-line label for lists. */
export function shortFace(a: Annotation): string {
  const what = a.ref ?? a.net ?? `${a.x.toFixed(1)}, ${a.y.toFixed(1)}`;
  return `${a.view === "board" ? "PCB" : "SCH"} · ${what}${a.net && a.ref ? ` · ${a.net}` : ""}`;
}
