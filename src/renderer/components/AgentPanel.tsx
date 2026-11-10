import { useEffect, useRef, useState } from "react";
import type { AgentKind, Annotation, SessionSummary, UsageSnapshot } from "../../shared/types";
import type { AgentState, Item } from "../agentStore";
import { api, fmtReset, fmtTime, fmtTokens } from "../api";
import { AnnotationsPanel } from "./AnnotationsPanel";
import { Markdown } from "./Markdown";
import { useT } from "../i18n";

interface Props {
  state: AgentState;
  binaries: Record<AgentKind, { path: string; version: string } | null>;
  selectionChip: string | null;
  onClearChip(): void;
  projectOpen: boolean;
  onSwitch(kind: AgentKind, resumeId?: string): void;
  annotations: Annotation[];
  activeAnnotation: string | null;
  onActivateAnnotation(id: string | null): void;
}

function UsageBlock({ u, kind }: { u?: UsageSnapshot; kind: AgentKind }) {
  const t = useT();
  if (!u) return <div className="usage muted">{t("agent.noUsage")}</div>;
  const ctxPct = u.contextUsed && u.contextWindow ? Math.min(100, (u.contextUsed / u.contextWindow) * 100) : null;
  return (
    <div className="usage">
      {u.windows.map((w) => (
        <div className="bar-row" key={w.label} title={w.status ?? ""}>
          <span className="bar-label">{w.label}</span>
          <div className="bar"><div className={`fill ${w.usedPercent >= 90 ? "hot" : w.usedPercent >= 70 ? "warm" : ""}`} style={{ width: `${Math.min(100, w.usedPercent)}%` }} /></div>
          <span className="bar-val">{w.usedPercent.toFixed(0)} %</span>
          <span className="bar-reset">{fmtReset(w.resetsAt, t)}</span>
        </div>
      ))}
      {ctxPct !== null && (
        <div className="bar-row" title={t("agent.contextTitle")}>
          <span className="bar-label">{t("agent.context")}</span>
          <div className="bar"><div className={`fill ctx ${ctxPct > 80 ? "warm" : ""}`} style={{ width: `${ctxPct}%` }} /></div>
          <span className="bar-val">{fmtTokens(u.contextUsed)}</span>
          <span className="bar-reset">/ {fmtTokens(u.contextWindow)}</span>
        </div>
      )}
      {u.sessionTokens && (
        <div className="tok-row">
          {t("agent.sessionTokens", { i: fmtTokens(u.sessionTokens.input), o: fmtTokens(u.sessionTokens.output), c: fmtTokens(u.sessionTokens.cached) })}
          {u.plan ? ` · ${kind === "codex" ? "ChatGPT" : "Claude"} ${u.plan}` : ""}
        </div>
      )}
      {u.note && <div className="usage-note">{u.note}</div>}
    </div>
  );
}

function AccountBar({ kind, installed }: { kind: AgentKind; installed: boolean }) {
  const t = useT();
  const [st, setSt] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [code, setCode] = useState("");
  useEffect(() => {
    let alive = true;
    setSt(null);
    setLines([]);
    if (installed) api.agent.auth(kind).then((s: any) => alive && setSt(s));
    const offs = [
      api.agent.onLoginOutput((k: AgentKind, l: string) => { if (k === kind) setLines((x) => [...x.slice(-6), l]); }),
      api.agent.onAuthChanged((k: AgentKind, s: any) => { if (k === kind) setSt(s); }),
    ];
    return () => { alive = false; offs.forEach((o) => o()); };
  }, [kind, installed]);
  const name = kind === "claude" ? "Claude" : "ChatGPT";
  if (!installed) {
    return <div className="account warn">{t(kind === "claude" ? "auth.installClaude" : "auth.installCodex")}</div>;
  }
  const login = async () => { setBusy(true); setLines([]); await api.agent.login(kind); setBusy(false); };
  return (
    <div className={`account ${st?.loggedIn ? (st.apiBilling ? "warn" : "ok") : st ? "bad" : ""}`}>
      {!st ? <span className="muted">{t("auth.checking")}</span>
        : st.loggedIn ? <span>{t("auth.loggedIn", { name, plan: st.plan ? ` ${String(st.plan).toUpperCase()}` : "" })}{st.apiBilling ? ` · ${t("auth.apiBilling")}` : ""}</span>
        : <span>{t("auth.notLoggedIn", { name })}</span>}
      {st && (!st.loggedIn || st.apiBilling) && <button className="primary" disabled={busy} onClick={login}>{busy ? t("auth.waiting") : t("auth.login", { name })}</button>}
      {busy && lines.length > 0 && (
        <div className="login-out">
          {lines.map((l, i) => <div key={i}>{l}</div>)}
          {kind === "claude" && (
            <div className="login-code">
              <input placeholder={t("auth.code")} value={code} onChange={(e) => setCode(e.target.value)} />
              <button onClick={() => { api.agent.loginInput(code); setCode(""); }}>{t("auth.sendCode")}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function toolLabel(name: string, input: any): string {
  if (!input) return name;
  const short = (s: string) => (s.length > 70 ? "…" + s.slice(-68) : s);
  if (input.file_path) return `${name} ${short(String(input.file_path))}`;
  if (input.command) return `${name}: ${short(String(input.command))}`;
  if (input.pattern) return `${name} ${input.pattern}`;
  if (Array.isArray(input)) return `${name} ${input.join(", ")}`;
  return name.replace(/^mcp__slashpcb__/, "PCB · ").replace(/^slashpcb\./, "PCB · ");
}

function ItemView({ it }: { it: Item }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  switch (it.kind) {
    case "user":
      return <div className="msg user"><div className="bubble">{it.text}</div></div>;
    case "assistant":
      return <div className={`msg assistant ${it.streaming ? "streaming" : ""}`}><Markdown text={it.text} /></div>;
    case "thinking":
      return <div className="thinking" onClick={() => setOpen(!open)}>{open ? it.text : t("agent.thinking")}</div>;
    case "tool":
      return (
        <div className={`tool ${it.status}`}>
          <div className="tool-head" onClick={() => setOpen(!open)}>
            <span className="dot" />{toolLabel(it.name, it.input)}
          </div>
          {open && (
            <div className="tool-body">
              {it.input !== undefined && <pre>{JSON.stringify(it.input, null, 1)?.slice(0, 4000)}</pre>}
              {it.output && <pre className="out">{it.output}</pre>}
            </div>
          )}
        </div>
      );
    case "permission":
      return (
        <div className={`perm ${it.decision ? "done" : ""}`}>
          <div className="perm-title">{t("agent.wantsToUse")} <b>{it.tool}</b>{it.description ? ` – ${it.description}` : ""}</div>
          <pre className="perm-input">{typeof it.input === "string" ? it.input : JSON.stringify(it.input, null, 1)?.slice(0, 3000)}</pre>
          {it.decision ? (
            <div className="perm-decision">{it.decision === "deny" ? t("agent.denied") : it.decision === "allow-always" ? t("agent.allowedSession") : t("agent.allowed")}</div>
          ) : (
            <div className="perm-actions">
              <button className="primary" onClick={() => api.agent.permission(it.id, "allow")}>{t("agent.allow")}</button>
              {it.canAlways && <button onClick={() => api.agent.permission(it.id, "allow-always")}>{t("agent.allowAlways")}</button>}
              <button className="danger" onClick={() => api.agent.permission(it.id, "deny")}>{t("agent.deny")}</button>
            </div>
          )}
        </div>
      );
    case "error":
      return <div className="err-msg">{it.text}</div>;
    case "activity":
      return <div className={`activity ${it.a.ok ? "" : "bad"}`}>⚙ {it.a.tool}: {it.a.summary}</div>;
    case "turn":
      return (
        <div className="turn-sep">
          {it.error ? <span className="bad">{it.error}</span> : null}
          {it.durationMs !== undefined && <span>{(it.durationMs / 1000).toFixed(1)} s</span>}
          {it.tokensIn !== undefined && <span>in {fmtTokens(it.tokensIn)} · out {fmtTokens(it.tokensOut)}</span>}
        </div>
      );
  }
}

export function AgentPanel({ state, binaries, selectionChip, onClearChip, projectOpen, onSwitch, annotations, activeAnnotation, onActivateAnnotation }: Props) {
  const t = useT();
  const [text, setText] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items]);

  const busy = state.status === "busy" || state.status === "starting";
  const bin = binaries[state.kind];

  const submit = async () => {
    if (!text.trim() || sending) return;
    const full = selectionChip ? `${text.trim()}\n\n[${t("agent.selectedInView")}: ${selectionChip}]` : text.trim();
    setText("");
    setSending(true);
    try { await api.agent.send(full); onClearChip(); } catch (e: any) { alert(e?.message ?? String(e)); }
    setSending(false);
  };

  const openSessions = async () => {
    if (sessions) { setSessions(null); return; }
    setSessions(await api.agent.sessions(state.kind));
  };

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <div className="seg">
          {(["claude", "codex"] as AgentKind[]).map((k) => (
            <button key={k} className={state.kind === k ? "on" : ""} disabled={!projectOpen} onClick={() => onSwitch(k)} title={binaries[k] ? `${binaries[k]!.version}\n${binaries[k]!.path}` : t("agent.notFound")}>
              {k === "claude" ? "Claude" : "ChatGPT"}{!binaries[k] && " ⚠"}
            </button>
          ))}
        </div>
        <div className="agent-actions">
          <button onClick={openSessions} disabled={!projectOpen} title={t("agent.historyTitle")}>{t("agent.history")}</button>
          <button onClick={() => onSwitch(state.kind)} disabled={!projectOpen} title={t("agent.newTitle")}>{t("agent.new")}</button>
        </div>
        {sessions && (
          <div className="sessions-menu" onMouseLeave={() => setSessions(null)}>
            {sessions.length === 0 && <div className="muted pad">{t("agent.noSessions")}</div>}
            {sessions.map((s) => (
              <div key={s.id} className="session-row" onClick={() => { setSessions(null); onSwitch(state.kind, s.id); }}>
                <div className="s-title">{s.title}</div>
                <div className="s-date">{new Date(s.updatedAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <AccountBar kind={state.kind} installed={!!binaries[state.kind]} />
      <UsageBlock u={state.usage[state.kind]} kind={state.kind} />
      <div className="transcript" ref={scroller} onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}>
        {state.items.length === 0 && (
          <div className="empty-chat">
            <p><b>{state.kind === "claude" ? "Claude" : "ChatGPT (Codex)"}</b> {t("agent.intro1", { v: bin ? ` (${bin.version})` : "" })}</p>
            <p>{t("agent.intro2")}</p>
            <p className="muted">{t("agent.intro3")}</p>
          </div>
        )}
        {state.items.map((it) => <ItemView key={it.id} it={it} />)}
        {busy && <div className="working"><span className="spinner" /> {state.status === "starting" ? t("agent.startingShort") : t("agent.working")}</div>}
      </div>
      <AnnotationsPanel
        items={annotations}
        activeId={activeAnnotation}
        onActivate={onActivateAnnotation}
        busy={busy || !projectOpen}
        onSend={async (t) => { try { await api.agent.send(t); } catch (e: any) { alert(e?.message ?? String(e)); } }}
      />
      {selectionChip && (
        <div className="chip">{t("agent.selected")}: {selectionChip} <button onClick={onClearChip}>×</button></div>
      )}
      <div className="composer">
        <textarea
          value={text}
          placeholder={projectOpen ? t("agent.placeholder", { agent: state.kind === "claude" ? "Claude" : "ChatGPT" }) : t("agent.openProjectFirst")}
          disabled={!projectOpen}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        <div className="composer-actions">
          <span className="muted small">{state.model ?? ""} {state.status !== "off" ? `· ${state.status}` : ""}</span>
          {busy ? <button className="danger" onClick={() => api.agent.interrupt()}>{t("agent.stop")}</button> : <button className="primary" disabled={!text.trim() || !projectOpen} onClick={submit}>{t("agent.send")}</button>}
        </div>
      </div>
    </div>
  );
}

export { fmtTime };
