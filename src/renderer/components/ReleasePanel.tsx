// Release tab: supplier profile, preflight gates, package export and earlier packages.
import { useEffect, useState } from "react";
import { api } from "../api";
import { useT } from "../i18n";

interface Gate { id: string; title: string; status: "pass" | "warn" | "fail"; detail: string; refs?: string[] }
interface Preflight { profile: string; ok: boolean; gates: Gate[]; assembled: number; ranAt: number }
interface Pkg { dir: string; name: string; profile: string; status: string; createdAt: string }
interface Caps { minTrack?: number; minGap?: number; minDrill?: number; minRing?: number; minViaDiameter?: number; minMaskWeb?: number; thicknesses?: number[]; tenting?: boolean; source?: string }
const CAP_FIELDS = ["minTrack", "minGap", "minDrill", "minRing", "minViaDiameter", "minMaskWeb"] as const;

const ICON = { pass: "✓", warn: "▲", fail: "✕" } as const;

export function ReleasePanel({ onPickRef, version }: { onPickRef(ref: string): void; version: number }) {
  const t = useT();
  const [profiles, setProfiles] = useState<{ id: string; name: string; note: string; caps: Caps }[]>([]);
  const [caps, setCaps] = useState<Record<string, Caps>>({});
  const [step, setStep] = useState(true);
  const [profile, setProfile] = useState(() => { try { return localStorage.getItem("release-profile") || "jlcpcb"; } catch { return "jlcpcb"; } });
  const [pf, setPf] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState<"check" | "export" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; dir?: string; error?: string } | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);

  useEffect(() => {
    api.release.profiles().then(setProfiles);
    api.info().then((i: any) => { setCaps(i.settings.supplierCaps ?? {}); setStep(i.settings.releaseStep !== false); });
  }, []);
  useEffect(() => { api.release.list().then(setPkgs); }, [version]);
  useEffect(() => {
    try { localStorage.setItem("release-profile", profile); } catch { /* none */ }
    api.release.preflight(profile, false).then(setPf);
  }, [profile, version]);

  const check = async () => { setBusy("check"); setPf(await api.release.preflight(profile, true)); setBusy(null); };
  const exportPkg = async (choose: boolean) => {
    setBusy("export"); setResult(null);
    const r = await api.release.export(profile, choose, { step });
    setBusy(null);
    if (!r) return;
    setResult(r.ok ? { ok: true, dir: r.result.dir } : { ok: false, error: r.error });
    if (r.ok) setPf(r.result.preflight);
    api.release.list().then(setPkgs);
  };
  const note = profiles.find((p) => p.id === profile)?.note;

  return (
    <div className="release">
      <div className="rel-head">
        <select value={profile} onChange={(e) => setProfile(e.target.value)}>
          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button disabled={!!busy} onClick={check}>{busy === "check" ? <span className="spinner" /> : null} {t("rel.check")}</button>
      </div>
      {note && <div className="muted small pad-x">{note}</div>}
      {pf && (
        <div className={`rel-verdict ${pf.ok ? "ok" : "bad"}`}>
          {pf.ok ? t("rel.ok", { n: pf.assembled }) : t("rel.blocked", { n: pf.gates.filter((g) => g.status === "fail").length })}
        </div>
      )}
      <div className="gates">
        {pf?.gates.map((g) => (
          <div key={g.id} className={`gate ${g.status}`}>
            <div className="gate-head"><span className={`gicon ${g.status}`}>{ICON[g.status]}</span><b>{g.title}</b></div>
            <div className="muted small">{g.detail}</div>
            {g.refs && g.refs.length > 0 && (
              <div className="gate-refs">
                {g.refs.slice(0, 40).map((r) => <button key={r} className="tiny" onClick={() => onPickRef(r)}>{r}</button>)}
                {g.refs.length > 40 && <span className="muted small">+{g.refs.length - 40}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
      <details className="limits-box">
        <summary className="pad-x small">{t("rel.limits")}</summary>
        <div className="muted small pad-x">{t("rel.limitsNote")}</div>
        <div className="limits">
          {CAP_FIELDS.map((k) => {
            const base = profiles.find((p) => p.id === profile)?.caps?.[k];
            const v = caps[profile]?.[k];
            return (
              <label key={k}>{k}
                <input type="number" step="0.005" min="0" placeholder={base !== undefined ? String(base) : "–"} value={v ?? ""}
                  onChange={(e) => setCaps({ ...caps, [profile]: { ...caps[profile], [k]: e.target.value === "" ? undefined : Number(e.target.value) } })} />
              </label>
            );
          })}
          <label>{t("rel.tenting")}
            <select value={caps[profile]?.tenting === undefined ? "" : caps[profile]!.tenting ? "yes" : "no"}
              onChange={(e) => setCaps({ ...caps, [profile]: { ...caps[profile], tenting: e.target.value === "" ? undefined : e.target.value === "yes" } })}>
              <option value="">{t("rel.unknown")}</option><option value="yes">{t("rel.yes")}</option><option value="no">{t("rel.no")}</option>
            </select>
          </label>
        </div>
        <div className="rel-actions"><button onClick={async () => { await api.setSettings({ supplierCaps: caps }); check(); }}>{t("rel.save")}</button></div>
      </details>
      <label className="check pad-x small"><input type="checkbox" checked={step} onChange={(e) => { setStep(e.target.checked); api.setSettings({ releaseStep: e.target.checked }); }} /> {t("rel.step")}</label>
      <div className="rel-actions">
        <button className="primary" disabled={!!busy} onClick={() => exportPkg(false)}>{busy === "export" ? <span className="spinner" /> : null} {t("rel.export")}</button>
        <button disabled={!!busy} onClick={() => exportPkg(true)}>{t("rel.exportTo")}</button>
      </div>
      <div className="muted small pad-x">{t("rel.note")}</div>
      {result && (result.ok
        ? <div className="rel-result ok">{t("rel.written")} <button className="link" onClick={() => api.release.reveal(result.dir!)}>{result.dir}</button></div>
        : <div className="err-msg">{result.error}</div>)}
      {pkgs.length > 0 && (
        <div className="pkgs">
          <h4>{t("rel.earlier")}</h4>
          {pkgs.map((p) => (
            <div key={p.dir} className="pkg" title={p.dir}>
              <span className={`badge ${/FAILED/.test(p.status) ? "bad" : "ok"}`}>{/FAILED/.test(p.status) ? t("rel.failed") : t("rel.passed")}</span>
              <span className="grow">{p.profile} · {new Date(p.createdAt).toLocaleString()}</span>
              <button className="tiny" onClick={() => api.release.reveal(p.dir)}>↗</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
