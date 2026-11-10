// Login status and login for the user's own agent CLIs. The CLIs keep their own credentials;
// this module only reads "logged in / plan / billing method" and never touches tokens. E-mail
// addresses and organisation ids from the CLIs are dropped, not stored or logged.
import { shell } from "electron";
import { spawn, execFile } from "node:child_process";
import { agentEnv, spawnSpec } from "./binaries";
import { CodexRpc } from "./codex";

export interface AuthStatus {
  loggedIn: boolean;
  method?: string; // "claude.ai", "console", "chatgpt", "apiKey" …
  plan?: string; // "pro", "max", "plus", …
  /** True when the CLI would bill an API account instead of the user's subscription. */
  apiBilling?: boolean;
  error?: string;
}

export function claudeAuthStatus(bin: string): Promise<AuthStatus> {
  const s = spawnSpec(bin, ["auth", "status", "--json"]);
  return new Promise((resolve) => {
    execFile(s.command, s.args, { timeout: 20000, env: agentEnv(s.env), windowsHide: true }, (err, stdout) => {
      try {
        const j = JSON.parse(String(stdout));
        const method = j.authMethod as string | undefined;
        resolve({ loggedIn: !!j.loggedIn, method, plan: j.subscriptionType ?? j.planTier, apiBilling: !!j.loggedIn && method !== "claude.ai" });
      } catch {
        resolve({ loggedIn: false, error: err ? String(err.message).slice(0, 300) : "could not read the login status" });
      }
    });
  });
}

/**
 * `claude auth login --claudeai` (subscription, never Console/API). The CLI opens the browser
 * itself; any URL it prints is opened as well, and output lines are passed to the UI in case
 * it asks for a pasted code (see writeInput).
 */
let claudeLoginProc: ReturnType<typeof spawn> | null = null;
export function claudeLogin(bin: string, onLine: (line: string) => void): Promise<AuthStatus> {
  claudeLoginProc?.kill();
  const s = spawnSpec(bin, ["auth", "login", "--claudeai"]);
  return new Promise((resolve) => {
    const p = spawn(s.command, s.args, { env: agentEnv(s.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    claudeLoginProc = p;
    const opened = new Set<string>();
    const handle = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        onLine(line.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"));
        const url = line.match(/https:\/\/\S+/)?.[0];
        if (url && !opened.has(url) && /claude\.ai|anthropic\.com/.test(url)) { opened.add(url); shell.openExternal(url); }
      }
    };
    p.stdout.on("data", handle);
    p.stderr.on("data", handle);
    const timer = setTimeout(() => p.kill(), 10 * 60 * 1000);
    p.on("exit", async () => {
      clearTimeout(timer);
      claudeLoginProc = null;
      resolve(await claudeAuthStatus(bin));
    });
  });
}

export function writeLoginInput(text: string): void {
  claudeLoginProc?.stdin?.write(text.trim() + "\n");
}

export async function codexAuthStatus(bin: string, cwd: string): Promise<AuthStatus> {
  const rpc = new CodexRpc(bin, cwd);
  try {
    await rpc.init();
    const r = await rpc.request("account/read", {});
    const a = r?.account;
    return { loggedIn: !!a, method: a?.type, plan: a?.planType, apiBilling: a?.type === "apiKey" };
  } catch (e: any) {
    return { loggedIn: false, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    rpc.kill();
  }
}

/** ChatGPT login through Codex's app-server: open the auth URL and wait for completion. */
export async function codexLogin(bin: string, cwd: string, onLine: (line: string) => void): Promise<AuthStatus> {
  const rpc = new CodexRpc(bin, cwd);
  try {
    await rpc.init();
    const done = new Promise<{ success: boolean; error?: string }>((resolve) => {
      const t = setTimeout(() => resolve({ success: false, error: "timed out after 10 minutes" }), 10 * 60 * 1000);
      rpc.onNotification = (m, p) => {
        if (m === "account/login/completed" || m === "loginChatGptComplete") { clearTimeout(t); resolve({ success: !!p?.success, error: p?.error ?? undefined }); }
      };
    });
    const r = await rpc.request("account/login/start", { type: "chatgpt" });
    if (r?.authUrl) {
      onLine("Opening the ChatGPT login page in your browser…");
      shell.openExternal(r.authUrl);
    }
    const res = await done;
    if (!res.success) onLine(`Login failed: ${res.error ?? "unknown error"}`);
  } catch (e: any) {
    onLine(`Login failed: ${e?.message ?? e}`);
  } finally {
    rpc.kill();
  }
  return codexAuthStatus(bin, cwd);
}
