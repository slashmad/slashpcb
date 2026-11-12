// The subscription-only boundary, enforced in the main process before a session starts and before
// each turn. An agent may run only when its CLI reports a subscription login: Claude Code with a
// claude.ai account, Codex with a ChatGPT account. API billing, a missing login and an unreadable
// status are refused. Credentials are never read; only the CLI's own status output is used.
import type { AuthStatus } from "./auth";

export type AgentKindName = "claude" | "codex";

const SUBSCRIPTION_METHOD: Record<AgentKindName, RegExp> = { claude: /^claude\.ai$/i, codex: /^chatgpt$/i };

export function subscriptionVerdict(kind: AgentKindName, s: AuthStatus | null | undefined): { ok: true } | { ok: false; error: string } {
  const name = kind === "claude" ? "Claude Code" : "Codex";
  if (!s || s.error) return { ok: false, error: `${name}'s login status could not be read${s?.error ? ` (${s.error})` : ""}. SlashPCB only starts agents on a confirmed subscription login; check the login under the agent panel's account menu.` };
  if (!s.loggedIn) return { ok: false, error: `${name} is not logged in. Log in with your ${kind === "claude" ? "Claude" : "ChatGPT"} subscription (account menu in the agent panel).` };
  if (s.apiBilling || !s.method || !SUBSCRIPTION_METHOD[kind].test(s.method)) {
    return { ok: false, error: `${name} is logged in with ${s.method ?? "an unknown method"}, which would bill an API account. SlashPCB never uses API billing: log in with your ${kind === "claude" ? "Claude" : "ChatGPT"} subscription instead.` };
  }
  return { ok: true };
}
