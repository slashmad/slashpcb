// Minimal, safe markdown: fenced code, inline code, bold/italic, headings, lists, links (as text).
import { Fragment, type ReactNode } from "react";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("`")) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("[")) out.push(<span key={k} className="md-link">{t.slice(1, t.indexOf("]"))}</span>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0, b = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={b++} className="md-code" data-lang={lang}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const L = ordered ? "ol" : "ul";
      blocks.push(<L key={b++}>{items.map((t, j) => <li key={j}>{inline(t, `${b}-${j}`)}</li>)}</L>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { blocks.push(<div key={b++} className={`md-h md-h${h[1].length}`}>{inline(h[2], `h${b}`)}</div>); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={b++}>{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, `p${b}-${j}`)}</Fragment>)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
