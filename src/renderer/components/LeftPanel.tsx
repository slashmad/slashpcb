import { useMemo, useState } from "react";
import type { CheckReport, CheckViolation, DesignSnapshot, FileDiff, FileNode, ProjectInfo } from "../../shared/types";
import { api, fmtTime } from "../api";
import { useT } from "../i18n";

export type LeftTab = "files" | "parts" | "nets" | "checks" | "diffs";

interface Props {
  info: ProjectInfo;
  tree: FileNode;
  design: DesignSnapshot;
  diffs: FileDiff[];
  tab: LeftTab;
  onTab(t: LeftTab): void;
  selectedRef: string | null;
  selectedNet: string | null;
  activeMarker: { kind: "erc" | "drc"; i: number } | null;
  onOpenFile(path: string): void;
  onPickRef(ref: string): void;
  onPickNet(net: string): void;
  onPickMarker(kind: "erc" | "drc", i: number, v: CheckViolation): void;
  onRunChecks(): void;
}

function FileTree({ node, onOpen, depth = 0 }: { node: FileNode; onOpen(p: string): void; depth?: number }) {
  const t = useT();
  const [open, setOpen] = useState(depth < 1);
  if (node.dir) {
    return (
      <div>
        {depth > 0 && (
          <div className="tree-row dir" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => setOpen(!open)}>
            <span className="caret">{open ? "▾" : "▸"}</span>{node.name}
          </div>
        )}
        {open && node.children?.map((c) => <FileTree key={c.path} node={c} onOpen={onOpen} depth={depth + 1} />)}
      </div>
    );
  }
  const kicad = /\.kicad_(pro|sch|pcb)$/i.test(node.name);
  return (
    <div className={`tree-row file ${kicad ? "kicad" : ""}`} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => onOpen(node.path)} title={node.path}>
      <span className={`fname ext-${node.name.split(".").pop()}`}>{node.name}</span>
      {node.size !== undefined && node.size > 1e6 && <span className="fsize">{(node.size / 1e6).toFixed(1)} MB</span>}
      {kicad && <button className="tiny" title={t("left.openInKicad")} onClick={(e) => { e.stopPropagation(); api.kicad.open(node.path); }}>↗</button>}
    </div>
  );
}

function Parts({ design, selectedRef, onPick }: { design: DesignSnapshot; selectedRef: string | null; onPick(r: string): void }) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const b = design.board;
    const bySch = new Map((design.schematic?.symbols ?? []).filter((s) => !s.power).map((s) => [s.ref, s]));
    const out: { ref: string; value: string; side: string; mpn: string; foot: string; dnp: boolean; onlySch?: boolean }[] = [];
    const mpn = (f: Record<string, string>) => f.MPN || f["Manufacturer Part Number"] || f.LCSC || f["LCSC Part #"] || "";
    for (const f of b?.footprints ?? []) {
      if (!f.ref || f.ref.startsWith("#")) continue;
      out.push({ ref: f.ref, value: f.value, side: f.side === "B" ? "B" : "F", mpn: mpn(f.fields), foot: f.lib.split(":").pop() ?? "", dnp: f.attrs.includes("dnp") });
      bySch.delete(f.ref);
    }
    for (const s of bySch.values()) out.push({ ref: s.ref, value: s.value, side: "", mpn: mpn(s.fields), foot: s.footprint.split(":").pop() ?? "", dnp: s.dnp, onlySch: true });
    return out.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  }, [design.board, design.schematic]);
  const f = filter.toLowerCase();
  const shown = rows.filter((r) => !f || `${r.ref} ${r.value} ${r.mpn} ${r.foot}`.toLowerCase().includes(f));
  return (
    <div className="list-tab">
      <div className="mt-tools"><input placeholder={t("left.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} /><span className="muted small">{shown.length}</span></div>
      <div className="list-body">
        {shown.slice(0, 3000).map((r) => (
          <div key={r.ref} className={`list-row ${selectedRef === r.ref ? "sel" : ""} ${r.dnp ? "dim" : ""}`} onClick={() => onPick(r.ref)} title={`${r.foot}${r.mpn ? ` · ${r.mpn}` : ""}`}>
            <span className="ref">{r.ref}</span>
            <span className="val">{r.value}</span>
            <span className="muted small grow">{r.mpn || r.foot}</span>
            {r.side && <span className={`side ${r.side}`}>{r.side}</span>}
            {r.onlySch && <span className="badge stale" title={t("left.onlySch")}>SCH</span>}
            {r.dnp && <span className="badge">DNP</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Nets({ design, selectedNet, onPick }: { design: DesignSnapshot; selectedNet: string | null; onPick(n: string): void }) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of design.board?.footprints ?? []) for (const p of f.pads) if (p.net) m.set(p.net, (m.get(p.net) ?? 0) + 1);
    return m;
  }, [design.board]);
  const f = filter.toLowerCase();
  const nets = (design.board?.nets ?? []).filter((n) => !f || n.toLowerCase().includes(f));
  if (!design.board) return <div className="muted pad">{t("board.none")}</div>;
  return (
    <div className="list-tab">
      <div className="mt-tools"><input placeholder={t("left.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} /><span className="muted small">{nets.length}</span></div>
      <div className="list-body">
        {nets.slice(0, 3000).map((n) => (
          <div key={n} className={`list-row ${selectedNet === n ? "sel" : ""}`} onClick={() => onPick(n)}>
            <span className="grow net-name">{n}</span><span className="muted small">{counts.get(n) ?? 0} {t("left.pads")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Report({ r, kind, active, onPick }: { r: CheckReport | null; kind: "erc" | "drc"; active: number | null; onPick(i: number, v: CheckViolation): void }) {
  const t = useT();
  const [showWarn, setShowWarn] = useState(true);
  if (!r) return <div className="muted pad">{kind.toUpperCase()}: {t("checks.notRun")}</div>;
  if (!r.ok) return <div className="err-msg">{kind.toUpperCase()}: {r.error}</div>;
  return (
    <div className="report">
      <div className="report-head">
        <b>{kind.toUpperCase()}</b>
        <span className={r.errors ? "bad" : "ok"}>{t("checks.errors", { n: r.errors })}</span>
        <span className={r.warnings ? "warn" : "muted"}>{t("checks.warnings", { n: r.warnings })}</span>
        {kind === "drc" && <span className="muted small">{t("checks.unconnected", { n: r.unconnected ?? 0 })} · {t("checks.parity", { n: r.parity ?? 0 })}</span>}
        <span className="grow" />
        <span className="muted small">{fmtTime(r.ranAt)} · {r.seconds.toFixed(1)} s</span>
        {r.warnings > 0 && <button className="tiny" onClick={() => setShowWarn(!showWarn)} title={t("checks.toggleWarn")}>{showWarn ? "⚠" : "⚠̶"}</button>}
      </div>
      {r.violations.length === 0 && <div className="ok pad small">✓ {t("checks.clean")}</div>}
      {r.violations.map((v, i) => (!showWarn && v.severity !== "error") ? null : (
        <div key={i} className={`viol ${v.severity} ${active === i ? "active" : ""}`} onClick={() => onPick(i, v)}>
          <div className="viol-head"><span className={`sev ${v.severity}`}>{v.severity === "error" ? "●" : "▲"}</span> {v.description} <span className="muted small">{v.source !== kind ? v.source : ""} {v.type}</span></div>
          {v.items.slice(0, 3).map((it, j) => <div key={j} className="viol-item muted small">{it.description}{it.x !== undefined ? ` @ ${it.x.toFixed(2)}, ${it.y!.toFixed(2)}` : ""}</div>)}
        </div>
      ))}
    </div>
  );
}

function Diffs({ diffs, onOpen }: { diffs: FileDiff[]; onOpen(p: string): void }) {
  const t = useT();
  if (!diffs.length) return <div className="muted pad">{t("left.noDiffs")}</div>;
  return (
    <div className="diffs">
      {[...diffs].reverse().map((d, i) => {
        const add = d.hunks.filter((h) => h.type === "add").reduce((n, h) => n + h.lines.length, 0);
        const del = d.hunks.filter((h) => h.type === "del").reduce((n, h) => n + h.lines.length, 0);
        return (
          <details key={`${d.path}-${d.ts}-${i}`} open={i < 2} className="diff">
            <summary><span className="fname" onClick={(e) => { e.preventDefault(); onOpen(d.path); }}>{d.path}</span> <span className="add">+{add}</span> <span className="del">−{del}</span> <span className="muted small">{fmtTime(d.ts)}</span></summary>
            <pre className="diff-body">
              {d.hunks.map((h, j) => h.lines.map((l, k) => (
                <div key={`${j}-${k}`} className={`dl ${h.type}`}><span className="ln">{h.type === "add" ? h.newStart + k : h.oldStart + k}</span>{h.type === "add" ? "+" : h.type === "del" ? "−" : " "} {l}</div>
              )))}
            </pre>
          </details>
        );
      })}
    </div>
  );
}

export function LeftPanel(p: Props) {
  const t = useT();
  const d = p.design;
  const errs = (d.erc?.errors ?? 0) + (d.drc?.errors ?? 0);
  const warns = (d.erc?.warnings ?? 0) + (d.drc?.warnings ?? 0);
  const tab = (k: LeftTab, label: string, badge?: React.ReactNode) => (
    <button className={p.tab === k ? "on" : ""} onClick={() => p.onTab(k)}>{label}{badge}</button>
  );
  return (
    <div className="left-panel">
      <div className="tabs">
        {tab("files", t("left.files"))}
        {tab("parts", t("left.parts"))}
        {tab("nets", t("left.nets"))}
        {tab("checks", t("left.checks"), errs ? <span className="count bad">{errs}</span> : warns ? <span className="count warn">{warns}</span> : null)}
        {tab("diffs", t("left.diffs"), p.diffs.length ? <span className="count">{p.diffs.length}</span> : null)}
      </div>
      <div className="tab-body">
        {p.tab === "files" && <FileTree node={p.tree} onOpen={p.onOpenFile} />}
        {p.tab === "parts" && <Parts design={d} selectedRef={p.selectedRef} onPick={p.onPickRef} />}
        {p.tab === "nets" && <Nets design={d} selectedNet={p.selectedNet} onPick={p.onPickNet} />}
        {p.tab === "checks" && (
          <div className="checks">
            <div className="checks-actions"><button onClick={p.onRunChecks}>{t("checks.run")}</button></div>
            <Report r={d.erc} kind="erc" active={p.activeMarker?.kind === "erc" ? p.activeMarker.i : null} onPick={(i, v) => p.onPickMarker("erc", i, v)} />
            <Report r={d.drc} kind="drc" active={p.activeMarker?.kind === "drc" ? p.activeMarker.i : null} onPick={(i, v) => p.onPickMarker("drc", i, v)} />
            {d.errors.length > 0 && <div className="err-msg">{d.errors.join("\n")}</div>}
          </div>
        )}
        {p.tab === "diffs" && <Diffs diffs={p.diffs} onOpen={p.onOpenFile} />}
      </div>
    </div>
  );
}
