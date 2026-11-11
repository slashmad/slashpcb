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
  { kind: "layer_nets", fields: ["layer", "nets"] },
  { kind: "locked", fields: ["refs"] },
  { kind: "part_present", fields: ["refs"] },
  { kind: "rules_floor", fields: [] },
];
const PLACEHOLDER: Record<string, string> = { pins: "D0?.1  or  J3.1", net: "COL*  or  !GND", refs: "U1  or  SW*", footprint: "MyLib:TI_DCK0005A*", layer: "In2.Cu", nets: "GND" };

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
