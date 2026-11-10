// The user's numbered markers with a task each; sent to the agent as one work list.
import { useEffect, useRef, useState } from "react";
import { describeAnnotation, shortFace } from "../../shared/annotationText";
import type { Annotation } from "../../shared/types";
import { api } from "../api";
import { useT } from "../i18n";

function TaskText({ a, focus }: { a: Annotation; focus: boolean }) {
  const tr = useT();
  const [t, setT] = useState(a.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setT(a.text); }, [a.text]);
  useEffect(() => { if (focus) ref.current?.focus(); }, [focus]);
  return (
    <textarea
      ref={ref}
      className="ann-text"
      rows={2}
      placeholder={tr("ann.placeholder")}
      value={t}
      onChange={(e) => setT(e.target.value)}
      onBlur={() => { if (t !== a.text) api.annotations.update(a.id, { text: t }); }}
    />
  );
}

export function AnnotationsPanel({ items, activeId, onActivate, busy, onSend }: {
  items: Annotation[];
  activeId: string | null;
  onActivate(id: string | null): void;
  busy: boolean;
  onSend(text: string): void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const openOnes = items.filter((a) => a.status === "open");
  if (!items.length) return null;

  const send = () => {
    const withText = openOnes.filter((a) => a.text.trim());
    if (!withText.length) { alert(t("ann.needText")); return; }
    onSend(
      `Work through my markers on the board/schematic (numbered pins, also visible in render_view images):\n\n` +
      withText.map(describeAnnotation).join("\n") +
      `\n\nDo the tasks one at a time. Check your findings with the slashpcb tools, and call resolve_annotation with a short note for each marker that is done.`,
    );
  };

  return (
    <div className="ann-panel">
      <div className="ann-head" onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"} {t("ann.title")}</span>
        <span className="muted small">{t("ann.counts", { o: openOnes.length, d: items.length - openOnes.length })}</span>
      </div>
      {open && (
        <>
          <div className="ann-list">
            {items.map((a) => (
              <div key={a.id} className={`ann ${a.status} ${a.id === activeId ? "active" : ""}`} onClick={() => onActivate(a.id)}>
                <div className="ann-row">
                  <span className={`pin-badge ${a.status}`}>{a.n}</span>
                  <span className="ann-where" title={describeAnnotation(a)}>{shortFace(a)}</span>
                  <button className="tiny" title={a.status === "done" ? t("ann.reopen") : t("ann.markDone")} onClick={(e) => { e.stopPropagation(); api.annotations.update(a.id, { status: a.status === "done" ? "open" : "done" }); }}>{a.status === "done" ? "↺" : "✓"}</button>
                  <button className="tiny" title={t("ann.remove")} onClick={(e) => { e.stopPropagation(); api.annotations.remove(a.id); if (a.id === activeId) onActivate(null); }}>×</button>
                </div>
                <TaskText a={a} focus={a.id === activeId && !a.text} />
                {a.agentNote && <div className="ann-note">{t("ann.agentNote")}: {a.agentNote}</div>}
              </div>
            ))}
          </div>
          <div className="ann-actions">
            <button className="primary" disabled={busy || !openOnes.length} onClick={send}>{t("ann.send")}</button>
            {items.length > openOnes.length && <button onClick={() => api.annotations.clearDone()}>{t("ann.clearDone")}</button>}
          </div>
        </>
      )}
    </div>
  );
}
