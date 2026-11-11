// Revision comparison in the Changes tab: pick another revision (folder or Git), read the differences,
// click a reference to select it. The board view draws the same differences as an overlay.
import { useState } from "react";
import { api } from "../api";
import { useT } from "../i18n";

interface Totals { size: [number, number]; copper: number; footprints: number; tracks: number; vias: number; trackLengthMm: number; zones: number }
export interface RevisionDiff {
  other: string; label: string; ranAt: number;
  rules?: { kind: string; what: string; from?: string; to?: string }[];
  board: null | {
    added: string[]; removed: { ref: string; x: number; y: number; bbox: [number, number, number, number] }[];
    moved: { ref: string; dx: number; dy: number; from: [number, number]; to: [number, number] }[];
    rotated: { ref: string; from: number; to: number }[]; flipped: string[];
    value: { ref: string; from: string; to: string }[]; footprint: { ref: string; from: string; to: string }[];
    fields: { ref: string; field: string; from: string; to: string }[]; padNets: { ref: string; pad: string; from: string; to: string }[];
    netsAdded: string[]; netsRemoved: string[];
    before: Totals;
    after: Totals;
  };
  schematic: null | { added: string[]; removed: string[]; value: { ref: string; from: string; to: string }[]; footprint: { ref: string; from: string; to: string }[]; fields: { ref: string; field: string; from: string; to: string }[]; sheets: [number, number] };
}

function Section({ title, n, children, open = false }: { title: string; n: number; children: React.ReactNode; open?: boolean }) {
  if (!n) return null;
  return <details className="cmp-sec" open={open}><summary>{title} <span className="muted">({n})</span></summary>{children}</details>;
}

export function ComparePanel({ diff, onDiff, onPickRef }: { diff: RevisionDiff | null; onDiff(d: RevisionDiff | null): void; onPickRef(ref: string): void }) {
  const t = useT();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setErr(null);
    const r = await fn();
    setBusy(false);
    if (!r) return;
    if (r.ok) onDiff(r.diff); else setErr(r.error);
  };
  const ref = (r: string) => <button key={r} className="tiny ref-btn" onClick={() => onPickRef(r)}>{r}</button>;
  const b = diff?.board, s = diff?.schematic;
  const delta = (a: number, c: number, unit = "") => a === c ? `${c}${unit}` : `${a} → ${c}${unit}`;
  return (
    <div className="compare">
      <div className="cmp-actions">
        <button disabled={busy} onClick={() => run(() => api.compare.folder())}>{t("cmp.folder")}</button>
        <button disabled={busy} onClick={() => run(() => api.compare.git())}>{t("cmp.git")}</button>
        {diff && <button className="link" onClick={() => onDiff(null)}>{t("cmp.clear")}</button>}
      </div>
      {err && <div className="err-msg">{err}</div>}
      {diff && (
        <div className="cmp-body">
          <div className="cmp-title">{diff.label} → {t("cmp.current")}</div>
          {b && (
            <div className="cmp-totals muted small">
              {b.before.size.join("×")} → {b.after.size.join("×")} mm · Cu {delta(b.before.copper, b.after.copper)} · {t("stat.parts")} {delta(b.before.footprints, b.after.footprints)} · {t("cmp.tracks")} {delta(b.before.tracks, b.after.tracks)} ({delta(b.before.trackLengthMm, b.after.trackLengthMm, " mm")}) · vias {delta(b.before.vias, b.after.vias)}
            </div>
          )}
          {b && (
            <>
              <Section title={t("cmp.added")} n={b.added.length} open><div className="refs">{b.added.map(ref)}</div></Section>
              <Section title={t("cmp.removed")} n={b.removed.length} open><div className="refs">{b.removed.map((r) => ref(r.ref))}</div></Section>
              <Section title={t("cmp.moved")} n={b.moved.length} open>{b.moved.map((m) => <div key={m.ref} className="cmp-row">{ref(m.ref)} <span className="muted small">Δ {m.dx >= 0 ? "+" : ""}{m.dx}, {m.dy >= 0 ? "+" : ""}{m.dy} mm</span></div>)}</Section>
              <Section title={t("cmp.rotated")} n={b.rotated.length}>{b.rotated.map((c) => <div key={c.ref} className="cmp-row">{ref(c.ref)} <span className="muted small">{c.from}° → {c.to}°</span></div>)}</Section>
              <Section title={t("cmp.flipped")} n={b.flipped.length}><div className="refs">{b.flipped.map(ref)}</div></Section>
              <Section title={t("cmp.value")} n={b.value.length} open>{b.value.map((c) => <div key={c.ref} className="cmp-row">{ref(c.ref)} <span className="small">{c.from} → <b>{c.to}</b></span></div>)}</Section>
              <Section title={t("cmp.footprint")} n={b.footprint.length}>{b.footprint.map((c) => <div key={c.ref} className="cmp-row">{ref(c.ref)} <span className="small">{c.from} → <b>{c.to}</b></span></div>)}</Section>
              <Section title={t("cmp.padNets")} n={b.padNets.length}>{b.padNets.slice(0, 500).map((c, i) => <div key={i} className="cmp-row">{ref(c.ref)} <span className="small">{t("board.pad")} {c.pad}: {c.from || "–"} → <b>{c.to || "–"}</b></span></div>)}</Section>
              <Section title={t("cmp.fields")} n={b.fields.length}>{b.fields.slice(0, 500).map((c, i) => <div key={i} className="cmp-row">{ref(c.ref)} <span className="small">{c.field}: “{c.from}” → <b>“{c.to}”</b></span></div>)}</Section>
              <Section title={t("cmp.nets")} n={b.netsAdded.length + b.netsRemoved.length}>
                {b.netsAdded.map((n) => <div key={"a" + n} className="cmp-row small add">+ {n}</div>)}
                {b.netsRemoved.map((n) => <div key={"r" + n} className="cmp-row small del">− {n}</div>)}
              </Section>
            </>
          )}
          {diff.rules && diff.rules.length > 0 && (
            <Section title={t("cmp.rules")} n={diff.rules.length} open>
              {diff.rules.map((c, i) => <div key={i} className={`cmp-row small ${/relaxed|ignored|exclusion\+|custom/.test(c.kind) ? "del" : ""}`}>{c.kind} {c.what}{c.from !== undefined || c.to !== undefined ? `: ${c.from ?? ""} → ${c.to ?? ""}` : ""}</div>)}
            </Section>
          )}
          {s && (s.added.length + s.removed.length + s.value.length + s.footprint.length + s.fields.length > 0) && (
            <>
              <div className="cmp-title small">{t("cmp.schematic")}</div>
              <Section title={t("cmp.added")} n={s.added.length}><div className="refs">{s.added.map(ref)}</div></Section>
              <Section title={t("cmp.removed")} n={s.removed.length}><div className="refs">{s.removed.map(ref)}</div></Section>
              <Section title={t("cmp.value")} n={s.value.length}>{s.value.map((c) => <div key={c.ref} className="cmp-row">{ref(c.ref)} <span className="small">{c.from} → <b>{c.to}</b></span></div>)}</Section>
              <Section title={t("cmp.footprint")} n={s.footprint.length}>{s.footprint.map((c) => <div key={c.ref} className="cmp-row">{ref(c.ref)} <span className="small">{c.from} → <b>{c.to}</b></span></div>)}</Section>
              <Section title={t("cmp.fields")} n={s.fields.length}>{s.fields.slice(0, 500).map((c, i) => <div key={i} className="cmp-row">{ref(c.ref)} <span className="small">{c.field}: “{c.from}” → <b>“{c.to}”</b></span></div>)}</Section>
            </>
          )}
          {b && !b.added.length && !b.removed.length && !b.moved.length && !b.rotated.length && !b.value.length && !b.footprint.length && !b.fields.length && !b.padNets.length && <div className="ok pad small">✓ {t("cmp.same")}</div>}
        </div>
      )}
    </div>
  );
}
