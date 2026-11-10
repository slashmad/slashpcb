import type { SlashPcbApi } from "../preload/index";

declare global {
  interface Window { slashpcb: SlashPcbApi }
}

export const api = window.slashpcb;

export function fmtTokens(n?: number): string {
  if (n === undefined || n === null) return "–";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
  return String(n);
}

export function fmtReset(unixSec: number | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!unixSec) return "";
  const ms = unixSec * 1000 - Date.now();
  if (ms <= 0) return t("time.now");
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  if (h >= 48) return t("time.inD", { d: Math.round(h / 24) });
  return h ? t("time.inHM", { h, m }) : t("time.inM", { m });
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
