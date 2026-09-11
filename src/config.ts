import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Config, UsageState } from "./interfaces/config.interface.js";
import { DEFAULT_CONFIG, DEFAULT_USAGE } from "./interfaces/config.interface.js";

export const CONFIG_ROOT_DIR = path.join(homedir(), ".config", "cc-daily-usage");
export const ACCOUNTS_DIR = path.join(CONFIG_ROOT_DIR, "accounts");

// Pre-multi-account layout — only read for the one-time migration below.
const LEGACY_CONFIG_FILE = path.join(CONFIG_ROOT_DIR, "config.json");
const LEGACY_USAGE_FILE = path.join(CONFIG_ROOT_DIR, "usage.json");

function accountDir(accountKey: string): string {
  return path.join(ACCOUNTS_DIR, accountKey);
}

function configFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "config.json");
}

function usageFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "usage.json");
}

function ensureAccountDir(accountKey: string): void {
  mkdirSync(accountDir(accountKey), { recursive: true });
}

// Deliberately NOT the resolved caller's accountKey: whichever account happens to be logged in the first
// time the upgraded code runs is not necessarily who accumulated the legacy history (e.g. the user switched
// accounts between upgrading and next running the tool) — guessing wrong would silently misattribute one
// account's spend to another's bucket. A fixed, never-guessed bucket is the only safe default; the user (or
// a one-off script) can move it into the right accounts/<key>/ by hand once they know which account it was.
const LEGACY_MIGRATION_KEY = "legacy";

/** One-time migration: pre-multi-account users have a single global config.json/usage.json — move them into
 * accounts/legacy/ instead of discarding history. Runs at most once ever: no-ops as soon as accounts/
 * exists, even if the legacy files somehow linger alongside it. */
function migrateLegacyFilesIfNeeded(): void {
  if (existsSync(ACCOUNTS_DIR)) return;
  if (!existsSync(LEGACY_CONFIG_FILE) && !existsSync(LEGACY_USAGE_FILE)) return;
  ensureAccountDir(LEGACY_MIGRATION_KEY);
  if (existsSync(LEGACY_CONFIG_FILE)) {
    renameSync(LEGACY_CONFIG_FILE, configFile(LEGACY_MIGRATION_KEY));
  }
  if (existsSync(LEGACY_USAGE_FILE)) {
    renameSync(LEGACY_USAGE_FILE, usageFile(LEGACY_MIGRATION_KEY));
  }
}

// Transparent first-run seeding (decision 3): the tool must never crash on a clean machine. `init` is the
// real, user-facing way to author laboralDays — this is just the silent default so nothing else has to guard
// against a missing file.
export function loadConfig(accountKey: string): Config {
  migrateLegacyFilesIfNeeded();
  ensureAccountDir(accountKey);
  const file = configFile(accountKey);
  if (!existsSync(file)) {
    saveConfig(accountKey, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  // Merged under DEFAULT_CONFIG rather than returned raw: a hasSpendCap:false account's monthlyCap/
  // laboralDays are meaningless and may be absent from the file entirely (see cli.ts's hasSpendCap gate) —
  // every caller still gets a complete Config in memory, so an unguarded read (e.g. dashboard-tui.ts's
  // rolloverIfNeeded call) fills in the empty default instead of crashing on undefined. Never rewrites the
  // file — purely an in-memory fill.
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export function saveConfig(accountKey: string, config: Config): void {
  ensureAccountDir(accountKey);
  writeFileSync(configFile(accountKey), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function loadUsage(accountKey: string): UsageState {
  migrateLegacyFilesIfNeeded();
  ensureAccountDir(accountKey);
  const file = usageFile(accountKey);
  if (!existsSync(file)) {
    saveUsage(accountKey, DEFAULT_USAGE);
    return DEFAULT_USAGE;
  }
  return JSON.parse(readFileSync(file, "utf8")) as UsageState;
}

export function saveUsage(accountKey: string, usage: UsageState): void {
  ensureAccountDir(accountKey);
  writeFileSync(usageFile(accountKey), JSON.stringify(usage, null, 2), { mode: 0o600 });
}
