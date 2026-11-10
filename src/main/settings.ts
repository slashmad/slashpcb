import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Settings } from "../shared/types";

const SETTINGS_VERSION = 1;

const defaults: Settings = {
  settingsVersion: SETTINGS_VERSION,
  language: "en",
  theme: "dark",
  displayBackend: "auto",
  recentProjects: [],
  lastAgent: "claude",
  checkTimeoutSec: 300,
  autoChecks: true,
  auto3d: false,
  onlineParts: false,
  liveLink: false,
  syncSelection: true,
};

let cache: Settings | null = null;

function file(): string {
  return join(app.getPath("userData"), "settings.json");
}

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    cache = { ...defaults, ...JSON.parse(readFileSync(file(), "utf8")) };
  } catch {
    cache = { ...defaults };
  }
  return cache!;
}

export function setSettings(patch: Partial<Settings>): Settings {
  cache = { ...getSettings(), ...patch };
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("could not save settings", e);
  }
  return cache;
}

export function rememberProject(path: string): void {
  const s = getSettings();
  setSettings({ recentProjects: [path, ...s.recentProjects.filter((d) => d !== path)].slice(0, 12) });
}
