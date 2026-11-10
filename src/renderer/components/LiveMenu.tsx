// Top-bar control for the live link to a running KiCad (IPC API through kicad-python).
import { useEffect, useState } from "react";
import type { LiveStatus, Settings } from "../../shared/types";
import { api } from "../api";
import { useT } from "../i18n";

export function LiveMenu({ settings, onSettings }: { settings: Settings; onSettings(s: Settings): void }) {
  const t = useT();
  const [st, setSt] = useState<LiveStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.live.status().then(setSt);
    const offs = [api.live.onStatus(setSt), api.live.onLog((l: string) => setLog((x) => [...x.slice(-40), l]))];
    return () => offs.forEach((o) => o());
  }, []);

  const state = !settings.liveLink ? "off" : !st?.python ? "setup" : st.connected ? (st.matches ? "on" : "other") : "wait";
  const label: Record<string, string> = { off: t("live.off"), setup: t("live.setup"), on: t("live.on"), other: t("live.other"), wait: t("live.wait") };

  return (
    <span className="menu-wrap">
      <button className={`live-pill ${state}`} onClick={() => setOpen(!open)} title={st?.error ?? ""}>
        <span className="dot" />{t("live.title")}{state !== "off" ? ` · ${label[state]}` : ""}
      </button>
      {open && (
        <div className="menu live-menu" onMouseLeave={() => !busy && setOpen(false)}>
          <div className="menu-note">{t("live.explain")}</div>
          <label className="menu-item check">
            <input type="checkbox" checked={settings.liveLink} onChange={async (e) => { await api.live.enable(e.target.checked); onSettings({ ...settings, liveLink: e.target.checked }); }} /> {t("live.enable")}
          </label>
          <label className="menu-item check">
            <input type="checkbox" checked={settings.syncSelection} onChange={async (e) => onSettings(await api.setSettings({ syncSelection: e.target.checked }))} /> {t("live.sync")}
          </label>
          {settings.liveLink && st && (
            <div className="menu-note">
              {st.connected ? t("live.connected", { v: st.version ?? "", b: (st.boards ?? []).join(", ") || "–" }) : st.error ?? t("live.notRunning")}
              {st.python && <div className="small">Python: {st.python}</div>}
            </div>
          )}
          {settings.liveLink && !st?.python && (
            <div className="menu-item">
              <button className="primary" disabled={busy} onClick={async () => {
                setBusy(true); setLog([]);
                const r = await api.live.setup();
                setBusy(false);
                if (!r.ok) setLog((x) => [...x, r.error]);
                api.live.status().then(setSt);
              }}>{busy ? t("live.installing") : t("live.install")}</button>
              <div className="menu-note">{t("live.installNote")}</div>
            </div>
          )}
          {log.length > 0 && <pre className="live-log">{log.join("\n")}</pre>}
        </div>
      )}
    </span>
  );
}
