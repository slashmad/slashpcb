import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useT } from "../i18n";

export function SourceDrawer({ path, errorLine, version, onClose }: { path: string; errorLine: number | null; version: number; onClose(): void }) {
  const t = useT();
  const [text, setText] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.project.readText(path).then((t: string) => { setText(t); setErr(null); }).catch((e: any) => setErr(e?.message ?? String(e)));
  }, [path, version]);
  useEffect(() => {
    if (errorLine && ref.current) ref.current.querySelector(`[data-line="${errorLine}"]`)?.scrollIntoView({ block: "center" });
  }, [text, errorLine]);
  const lines = text.split("\n");
  return (
    <div className="source-drawer">
      <div className="sd-head">
        <span className="fname">{path}</span>
        <span className="muted small">{t("src.readonly")}</span>
        <button onClick={() => api.project.reveal(path)}>{t("src.reveal")}</button>
        <button onClick={onClose}>{t("src.close")}</button>
      </div>
      {err ? <div className="err-msg">{err}</div> : (
        <div className="sd-code" ref={ref}>
          {lines.map((l, i) => (
            <div key={i} data-line={i + 1} className={`cl ${errorLine === i + 1 ? "errline" : ""}`}><span className="ln">{i + 1}</span><span className="lc">{l || " "}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}
