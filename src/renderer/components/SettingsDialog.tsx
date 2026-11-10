import { useState } from "react";
import type { Settings } from "../../shared/types";
import { api } from "../api";
import { useT } from "../i18n";

type Page = "general" | "kicad" | "agents";

function Choice<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className="choice">
      {options.map(([v, l]) => <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export function SettingsDialog({ settings, info, onClose, onSaved }: { settings: Settings; info: any; onClose(): void; onSaved(s: Settings): void }) {
  const t = useT();
  const [s, setS] = useState<Settings>(settings);
  const [page, setPage] = useState<Page>("general");
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v === "" ? undefined : v });
  const save = async () => { onSaved(await api.setSettings(s)); onClose(); };
  const check = (k: keyof Settings, label: string, disabled = false) => (
    <label className={`check ${disabled ? "dim" : ""}`}><input type="checkbox" disabled={disabled} checked={!!s[k]} onChange={(e) => set(k, e.target.checked as any)} /> {label}</label>
  );

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-nav">
          <h3>{t("set.title")}</h3>
          {(["general", "kicad", "agents"] as Page[]).map((p) => (
            <button key={p} className={page === p ? "on" : ""} onClick={() => setPage(p)}>{t(`set.${p}`)}</button>
          ))}
        </div>
        <div className="settings-body">
          {page === "general" && (
            <>
              <h4>{t("set.general")}</h4>
              <div className="row"><span>{t("set.language")}</span><Choice value={s.language ?? "en"} options={[["en", "English"], ["sv", "Svenska"]]} onChange={(v) => set("language", v)} /></div>
              <div className="row"><span>{t("set.theme")}</span><Choice value={s.theme} options={[["dark", t("set.dark")], ["light", t("set.light")]]} onChange={(v) => set("theme", v)} /></div>
              {info.platform === "linux" && (
                <div className="row"><span>{t("set.display")} – {info.displayBackend}</span>
                  <Choice value={s.displayBackend} options={[["auto", t("set.auto")], ["wayland", "Wayland"], ["x11", "X11"]]} onChange={(v) => set("displayBackend", v)} />
                </div>
              )}
            </>
          )}

          {page === "kicad" && (
            <>
              <h4>KiCad</h4>
              <label>kicad-cli <span className="muted small">{t("set.foundBinary")}: {info.kicad?.version ? `${info.kicad.version} · ${info.kicad.cli}` : t("set.none.found")}</span>
                <input placeholder={info.kicad?.cli ?? "kicad-cli"} value={s.kicadCliPath ?? ""} onChange={(e) => set("kicadCliPath", e.target.value)} />
              </label>
              {check("autoChecks", t("set.autoChecks"))}
              {check("auto3d", t("set.auto3d"))}
              <label>{t("set.timeout")} <input type="number" min={30} value={s.checkTimeoutSec} onChange={(e) => set("checkTimeoutSec", Number(e.target.value))} /></label>
              <p className="muted small">{t("set.shadowNote")}</p>
              <h4>{t("set.online")}</h4>
              {check("onlineParts", t("set.onlineParts"), true)}
              <p className="muted small">{t("set.onlineNote")}</p>
            </>
          )}

          {page === "agents" && (
            <>
              <h4>Claude Code</h4>
              <label>{t("set.binary")} <span className="muted small">{t("set.foundBinary")}: {info.claude?.version ?? t("set.none.found")}</span>
                <input placeholder={info.claude?.path ?? "claude"} value={s.claudePath ?? ""} onChange={(e) => set("claudePath", e.target.value)} />
              </label>
              <label>{t("set.model")} <input placeholder="default (opus, sonnet, haiku …)" value={s.claudeModel ?? ""} onChange={(e) => set("claudeModel", e.target.value)} /></label>
              <h4>ChatGPT (Codex)</h4>
              <label>{t("set.binary")} <span className="muted small">{t("set.foundBinary")}: {info.codex?.version ?? t("set.none.found")}</span>
                <input placeholder={info.codex?.path ?? "codex"} value={s.codexPath ?? ""} onChange={(e) => set("codexPath", e.target.value)} />
              </label>
              <label>{t("set.model")} <input placeholder="default from ~/.codex/config.toml" value={s.codexModel ?? ""} onChange={(e) => set("codexModel", e.target.value)} /></label>
              <div className="modal-row">
                <button onClick={async () => { const ok = await api.project.installMcp(); alert(ok ? t("set.vscodeDone") : t("set.vscodeFrozen")); }}>{t("set.vscode")}</button>
              </div>
            </>
          )}
          <div className="modal-actions">
            <button onClick={onClose}>{t("set.cancel")}</button>
            <button className="primary" onClick={save}>{t("set.save")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
