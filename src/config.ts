import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Config, UsageState } from "./interfaces/config.interface.js";
import { DEFAULT_CONFIG, DEFAULT_USAGE } from "./interfaces/config.interface.js";

export const CONFIG_DIR = path.join(homedir(), ".config", "cc-daily-usage");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const USAGE_FILE = path.join(CONFIG_DIR, "usage.json");
export const REPORT_HTML_FILE = path.join(CONFIG_DIR, "report.html");

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

// Transparent first-run seeding (decision 3): the tool must never crash on a clean machine. `init` is the
// real, user-facing way to author laboralDays — this is just the silent default so nothing else has to guard
// against a missing file.
export function loadConfig(): Config {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function loadUsage(): UsageState {
  ensureConfigDir();
  if (!existsSync(USAGE_FILE)) {
    saveUsage(DEFAULT_USAGE);
    return DEFAULT_USAGE;
  }
  return JSON.parse(readFileSync(USAGE_FILE, "utf8")) as UsageState;
}

export function saveUsage(usage: UsageState): void {
  ensureConfigDir();
  writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), { mode: 0o600 });
}
