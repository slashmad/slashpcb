// Checks › Rules (design invariants) and Checks › Polarity (pin-1 review).
import { useEffect, useState } from "react";
import { api } from "../api";
import { useT } from "../i18n";

interface RuleRow { id: string; kind: string; text: string; note?: string; severity?: string }
interface Violation { type: string; severity: string; description: string; items: { description: string; ref?: string }[] }

const KINDS: { kind: string; fields: string[] }[] = [
  { kind: "pin_net", fields: ["pins", "net"] },
  { kind: "pin_unconnected", fields: ["pins"] },
  { kind: "footprint", fields: ["refs", "footprint"] },
  { kind: "land_pattern", fields: ["refs", "reference"] },
  { kind: "layer_nets", fields: ["layer", "nets"] },
  { kind: "locked", fields: ["refs"] },
  { kind: "part_present", fields: ["refs"] },
  { kind: "rules_floor", fields: [] },
];
const PLACEHOLDER: Record<string, string> = { reference: "Lib:Name  or  path/to/part.kicad_mod", pins: "D0?.1  or  J3.1", net: "COL*  or  !GND", refs: "U1  or  SW*", footprint: "MyLib:TI_DCK0005A*", layer: "In2.Cu", nets: "GND" };

export function RulesPanel({ version, selectedRef, onPickRef }: { version: number; selectedRef: string | null; onPickRef(r: string): void }) {
  const t = useT();
  const [data, setData] = useState<{ file: string | null; writePath: string; rules: RuleRow[]; report: { errors: number; warnings: number; violations: Violation[] } | null } | null>(null);
  const [kind, setKind] = useState("pin_net");
  const [form, setForm] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.rules.list().then(setData);
  useEffect(() => { load(); }, [version]);
  const add = async (r: Record<string, unknown>) => {
    setErr(null);
    const res = await api.rules.add(r);
    if (res && !res.ok) setErr(res.error);
    setForm({});
    load();
  };
  const fields = KINDS.find((k) => k.kind === kind)?.fields ?? [];
  const vio = (id: string) => data?.report?.violations.filter((v) => v.type.startsWith(`${id}:`)) ?? [];
  return (
    <div className="rules">
      <div className="muted small pad-x">{t("rules.explain")}</div>
      {data && <div className="muted small pad-x" title={data.file ?? data.writePath}>{t("rules.file")}: {(data.file ?? data.writePath).split(/[\\/]/).slice(-2).join("/")}</div>}
      {data?.report && <div className={`rel-verdict ${data.report.errors ? "bad" : "ok"}`}>{data.report.errors ? t("rules.violated", { n: data.report.errors }) : t("rules.hold", { n: data.rules.length })}</div>}
      <div className="gates">
        {data?.rules.map((r) => {
          const v = vio(r.id);
          return (
            <div key={r.id} className={`gate ${v.length ? (r.severity === "warning" ? "warn" : "fail") : "pass"}`}>
              <div className="gate-head"><span className={`gicon ${v.length ? (r.severity === "warning" ? "warn" : "fail") : "pass"}`}>{v.length ? "✕" : "✓"}</span><b>{r.id}</b> <span className="small">{r.text}</span>
                <span className="grow" /><button className="tiny" title={t("rules.remove")} onClick={async () => { await api.rules.remove(r.id); load(); }}>×</button></div>
              {r.note && <div className="muted small">{r.note}</div>}
              {v.flatMap((x) => x.items).slice(0, 30).map((i, k) => (
                <div key={k} className="small viol-item">{i.ref ? <button className="tiny" onClick={() => onPickRef(i.ref!)}>{i.ref}</button> : null} {i.description}</div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="rule-form">
        <div className="row-flex">
          <select value={kind} onChange={(e) => { setKind(e.target.value); setForm({}); }}>
            {KINDS.map((k) => <option key={k.kind} value={k.kind}>{t(`rules.kind.${k.kind}`)}</option>)}
          </select>
        </div>
        {fields.map((f) => <input key={f} placeholder={`${f}: ${PLACEHOLDER[f] ?? ""}`} value={form[f] ?? ""} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />)}
        <input placeholder={t("rules.note")} value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        <div className="row-flex">
          <button className="primary" disabled={fields.some((f) => !form[f])} onClick={() => add({ kind, ...form })}>{t("rules.add")}</button>
          {selectedRef && <button onClick={() => add({ kind: "locked", refs: selectedRef, note: t("rules.lockedNote") })}>{t("rules.lockSel", { r: selectedRef })}</button>}
        </div>
        {err && <div className="err-msg">{err}</div>}
      </div>
    </div>
  );
}

interface PolEntry { ref: string; value: string; lib: string; side: "F" | "B"; rot: number; kind: string; pins: { num: string; name: string; net: string }[]; issues: { level: string; text: string }[]; fingerprint: string; verified?: string }

export function PolarityPanel({ version, selectedRef, onPickRef }: { version: number; selectedRef: string | null; onPickRef(r: string): void }) {
  const t = useT();
  const [list, setList] = useState<PolEntry[]>([]);
  const [open, setOpen] = useState(true);
  useEffect(() => { api.polarity.list().then(setList); }, [version]);
  const shown = list.filter((e) => !open || !e.verified || e.issues.some((i) => i.level === "error"));
  const verified = list.filter((e) => e.verified).length;
  const errors = list.reduce((n, e) => n + e.issues.filter((i) => i.level === "error").length, 0);
  return (
    <div className="polarity">
      <div className="muted small pad-x">{t("pol.explain")}</div>
      <div className={`rel-verdict ${errors ? "bad" : verified === list.length ? "ok" : ""}`}>{t("pol.summary", { v: verified, n: list.length, e: errors })}</div>
      <label className="check pad-x small"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> {t("pol.onlyOpen")}</label>
      <div className="list-body">
        {shown.map((e) => (
          <div key={e.ref} className={`pol-row ${e.ref === selectedRef ? "sel" : ""}`}>
            <div className="pol-head">
              <input type="checkbox" title={t("pol.verify")} checked={!!e.verified} onChange={async (ev) => setList(await api.polarity.verify(e.ref, ev.target.checked ? e.fingerprint : null))} />
              <button className="tiny ref-btn" onClick={() => onPickRef(e.ref)}>{e.ref}</button>
              <span className="small">{e.value}</span>
              <span className="grow" />
              <span className="muted small">{t(`pol.kind.${e.kind}`)} · {e.side === "B" ? t("board.bottom") : t("board.top")} · {e.rot}°</span>
            </div>
            <div className="pol-pins small">{e.pins.slice(0, 16).map((p) => <span key={p.num} className={p.num === "1" || p.num === "A1" ? "pin1" : ""}>{p.num}{p.name ? `(${p.name})` : ""}={p.net ? p.net.replace(/^\//, "") : "–"}</span>)}{e.pins.length > 16 ? " …" : ""}</div>
            {e.issues.map((i, k) => <div key={k} className={`small ${i.level === "error" ? "bad" : i.level === "warning" ? "warn" : "muted"}`}>{i.text}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}

interface Analysis {
  metrics: { layers: { layer: string; tracks: number; lengthMm: number }[]; segments: number; arcs: number; shortSegments: number; offAngle: number; directionChanges: number; vias: number; groundVias: number; signalVias: number;
    viasPerNet: { net: string; vias: number }[]; detour: { net: string; ratio: number; lengthMm: number; directMm: number }[]; diffPairs: { p: string; n: string; lenP: number; lenN: number; delta: number }[]; islands: { layer: string; net: string; pieces: number }[]; totalLengthMm: number };
  viaPaste: { ref: string; pad: string; padNet: string; viaNet: string; kind: string; gap: number; sameNet: boolean; tented: boolean; side: string }[];
  decoupling: { ic: string; pin: string; net: string; cap: string | null; distanceMm: number | null }[];
  testPads: { ref: string; net: string; paste: boolean; clearanceMm: number; blocker?: string }[];
  duplicateUuids: number;
  mask: { minWeb: number; thresholdSource: string; openVias: number; viasOpenAssumed: boolean; bridgesInFootprints: boolean;
    webs: { a: string; b: string; refs: string[]; netA: string; netB: string; web: number; kind: string; sameNet: boolean; allowed: boolean; via: boolean }[];
    narrowest?: { a: string; b: string; web: number }; maskDefined: { ref: string; pads: number; margin: number }[] } | null;
}

export function LayoutPanel({ version, onPickRef, onPickNet }: { version: number; onPickRef(r: string): void; onPickNet(n: string): void }) {
  const t = useT();
  const [a, setA] = useState<Analysis | null>(null);
  useEffect(() => { let prof: string | undefined; try { prof = localStorage.getItem("release-profile") || undefined; } catch { /* none */ } api.analysis.get(prof).then(setA); }, [version]);
  if (!a) return <div className="muted pad">{t("board.none")}</div>;
  const m = a.metrics;
  const ref = (r: string) => <button key={r} className="tiny ref-btn" onClick={() => onPickRef(r)}>{r}</button>;
  const net = (n: string) => <button key={n} className="tiny ref-btn" onClick={() => onPickNet(n)}>{n.replace(/^\//, "")}</button>;
  const hard = a.viaPaste.filter((v) => v.kind !== "ring-near");
  const far = a.decoupling.filter((d) => d.distanceMm === null || d.distanceMm > 5);
  return (
    <div className="layout-panel">
      <div className="muted small pad-x">{t("lay.explain")}</div>
      <details className="cmp-sec pad-x" open><summary>{t("lay.metrics")}</summary>
        <div className="small">{t("lay.total", { l: m.totalLengthMm, s: m.segments, a: m.arcs, v: m.vias, g: m.groundVias })}</div>
        <div className="small muted">{m.layers.map((l) => `${l.layer} ${l.lengthMm} mm`).join(" · ")}</div>
        <div className="small">{t("lay.style", { s: m.shortSegments, o: m.offAngle, d: m.directionChanges })}</div>
        {m.viasPerNet.length > 0 && <div className="small">{t("lay.viasPerNet")}: <span className="refs-inline">{m.viasPerNet.slice(0, 8).map((v) => <span key={v.net}>{net(v.net)} {v.vias}</span>)}</span></div>}
        {m.detour.length > 0 && <div className="small">{t("lay.detour")}: <span className="refs-inline">{m.detour.slice(0, 6).map((d) => <span key={d.net}>{net(d.net)} ×{d.ratio}</span>)}</span></div>}
        {m.diffPairs.map((d) => <div key={d.p} className={`small ${d.delta > 0.5 ? "warn" : ""}`}>{t("lay.pair")} {net(d.p)}/{net(d.n)}: {d.lenP} / {d.lenN} mm, Δ {d.delta}</div>)}
        {m.islands.length > 0 && <div className="small warn">{t("lay.islands")}: {m.islands.map((i) => `${i.net} ${i.layer} ×${i.pieces}`).join(", ")}</div>}
      </details>
      <details className="cmp-sec pad-x" open><summary>{t("lay.viaPaste", { n: hard.length, m: a.viaPaste.length - hard.length })}</summary>
        {a.viaPaste.slice(0, 60).map((v, i) => <div key={i} className={`small ${v.kind === "ring-near" ? "muted" : v.sameNet ? "warn" : "bad"}`}>{ref(v.ref)} {t("board.pad")} {v.pad} · {v.kind} · {v.gap} mm · {v.sameNet ? t("lay.same") : t("lay.other")} · {v.tented ? t("lay.tented") : t("lay.open")}</div>)}
      </details>
      {a.mask && (() => {
        const mk = a.mask;
        const risky = mk.webs.filter((w) => !w.sameNet && !w.allowed);
        return (
          <details className="cmp-sec pad-x" open={risky.length > 0 || mk.maskDefined.length > 0}><summary>{t("lay.mask", { n: risky.length, w: mk.minWeb })}</summary>
            <div className="small muted">{t("lay.maskSrc", { s: mk.thresholdSource, v: mk.openVias })}{mk.viasOpenAssumed ? ` · ${t("lay.maskViasOpen")}` : ""}</div>
            {mk.narrowest && <div className="small">{t("lay.maskNarrowest", { w: mk.narrowest.web })}: {mk.narrowest.a} / {mk.narrowest.b}</div>}
            {mk.webs.filter((w) => !w.sameNet).slice(0, 40).map((w, i) => <div key={i} className={`small ${w.allowed ? "muted" : w.kind === "merged" ? "bad" : "warn"}`}>{w.refs.map(ref)} {w.a} / {w.b} · {w.web} mm · {w.kind}{w.allowed ? ` · ${t("lay.maskAllowed")}` : ""}</div>)}
            {mk.maskDefined.length > 0 && <div className="small warn">{t("lay.maskDefined")}: <span className="refs-inline">{mk.maskDefined.map((m) => <span key={m.ref}>{ref(m.ref)} {m.margin} mm</span>)}</span></div>}
          </details>
        );
      })()}
      <details className="cmp-sec pad-x"><summary>{t("lay.decoupling", { n: far.length })}</summary>
        {a.decoupling.slice(0, 40).map((d, i) => <div key={i} className={`small ${d.distanceMm === null || d.distanceMm > 5 ? "warn" : "muted"}`}>{ref(d.ic)}.{d.pin} {d.net}: {d.cap ? <>{ref(d.cap)} {d.distanceMm} mm</> : t("lay.noCap")}</div>)}
      </details>
      {a.testPads.length > 0 && (
        <details className="cmp-sec pad-x"><summary>{t("lay.testPads", { n: a.testPads.length, p: a.testPads.filter((x) => x.paste).length, b: a.testPads.filter((x) => x.clearanceMm < 0).length })}</summary>
          {a.testPads.slice(0, 20).map((x) => <div key={x.ref} className={`small ${x.clearanceMm < 0 || x.paste ? "bad" : "muted"}`}>{ref(x.ref)} {x.net}: {x.clearanceMm} mm{x.blocker ? ` (${x.blocker})` : ""}{x.paste ? " · paste" : ""}</div>)}
        </details>
      )}
      <div className={`small pad-x ${a.duplicateUuids ? "bad" : "ok"}`}>{t("lay.uuids", { n: a.duplicateUuids })}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Parts › sourcing note editor

export interface PartNote { lifecycle?: string; consigned?: boolean; alternates?: string[]; leadTimeDays?: number; note?: string; quote?: { unitPrice?: number; currency: string; qty?: number; supplier?: string; date?: string }; updatedAt?: string }
export interface PartLine { key: string; value: string; lib: string; mpn: string; manufacturer: string; lcsc: string; refs: string[]; qty: number; placed: number; note?: PartNote }

export function PartNoteEditor({ line, onSaved }: { line: PartLine; onSaved(lines: PartLine[]): void }) {
  const t = useT();
  const n = line.note ?? {};
  const [lifecycle, setLifecycle] = useState(n.lifecycle ?? "");
  const [consigned, setConsigned] = useState(!!n.consigned);
  const [alts, setAlts] = useState((n.alternates ?? []).join(", "));
  const [lead, setLead] = useState(n.leadTimeDays !== undefined ? String(n.leadTimeDays) : "");
  const [note, setNote] = useState(n.note ?? "");
  const [price, setPrice] = useState(n.quote?.unitPrice !== undefined ? String(n.quote.unitPrice) : "");
  const [cur, setCur] = useState(n.quote?.currency ?? "");
  const [qty, setQty] = useState(n.quote?.qty ? String(n.quote.qty) : "");
  const [supplier, setSupplier] = useState(n.quote?.supplier ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!!line.note);
  const save = async (clear = false) => {
    setErr(null);
    const body = clear ? null : { lifecycle, consigned, alternates: alts, leadTimeDays: lead, note, quote: price ? { unitPrice: price, currency: cur, qty, supplier } : undefined };
    const r = await api.parts.set(line.key, body);
    if (!r.ok) { setErr(r.error); return; }
    const l = await api.parts.list();
    onSaved(l?.lines ?? []);
  };
  return (
    <details className="note-editor" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="small pad-x">{t("parts.notes")} · {line.mpn || line.value} ×{line.qty}</summary>
      <div className="muted small pad-x">{line.refs.join(", ")}{line.manufacturer ? ` · ${line.manufacturer}` : ""}</div>
      <div className="note-grid pad-x">
        <label>{t("parts.lifecycle")}
          <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>
            <option value="">–</option>
            {["active", "nrnd", "eol", "obsolete", "unknown"].map((v) => <option key={v} value={v}>{t(`parts.lc.${v}`)}</option>)}
          </select>
        </label>
        <label>{t("parts.lead")}<input type="number" min="0" value={lead} onChange={(e) => setLead(e.target.value)} /></label>
        <label className="check wide"><input type="checkbox" checked={consigned} onChange={(e) => setConsigned(e.target.checked)} /> {t("parts.consigned")}</label>
        <label className="wide">{t("parts.alternates")}<input value={alts} placeholder="MPN, MPN" onChange={(e) => setAlts(e.target.value)} /></label>
        <label>{t("parts.price")}<input type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label>{t("parts.currency")}<input value={cur} maxLength={3} placeholder="EUR" onChange={(e) => setCur(e.target.value.toUpperCase())} /></label>
        <label>{t("parts.qty")}<input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label>{t("parts.supplier")}<input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></label>
        <label className="wide">{t("parts.note")}<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {err && <div className="small bad pad-x">{err}</div>}
      <div className="rel-actions">
        <button onClick={() => save(false)}>{t("parts.save")}</button>
        {line.note && <button onClick={() => save(true)}>{t("parts.clear")}</button>}
        {n.updatedAt && <span className="muted small">{n.updatedAt.slice(0, 16).replace("T", " ")}</span>}
      </div>
      <div className="muted small pad-x">{t("parts.offline")}</div>
    </details>
  );
}
