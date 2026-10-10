import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { freshUsage, upgradeUsage } from "./calc.js";
import type { ApiCache, Config, UsageState } from "./interfaces/config.interface.js";
import { DEFAULT_CONFIG } from "./interfaces/config.interface.js";

export const CONFIG_ROOT_DIR = path.join(homedir(), ".config", "cc-daily-usage");
export const ACCOUNTS_DIR = path.join(CONFIG_ROOT_DIR, "accounts");

// Pre-multi-account layout — only read for the one-time migration below.
const LEGACY_CONFIG_FILE = path.join(CONFIG_ROOT_DIR, "config.json");
const LEGACY_USAGE_FILE = path.join(CONFIG_ROOT_DIR, "usage.json");

export function accountDir(accountKey: string): string {
  return path.join(ACCOUNTS_DIR, accountKey);
}

function configFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "config.json");
}

function usageFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "usage.json");
}

export function apiCacheFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "api-cache.json");
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

/** Write-to-temp + rename: a crash or a concurrent reader never sees a half-written file (rename is atomic on
 * one filesystem). The pid suffix keeps two concurrent writers from sharing a temp file.
 * # ponytail: concurrent read-modify-write can still lose one render's update (last writer wins); the next
 * render re-captures it from the session baseline or the ledger. Upgrade path: a lockfile around load→save. */
export function writeFileAtomic(file: string, content: string): void {
  const temp = `${file}.${String(process.pid)}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
}

type ReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "ok"; readonly value: Record<string, unknown>; readonly raw: string };

/** Empty or unparseable account JSON must not crash the statusline hook. A non-object JSON value
 * (array/null/number) is also treated as corrupt. */
function readObjectFile(file: string): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { kind: "missing" };
  }
  try {
    if (raw.trim() === "") return { kind: "corrupt" };
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "corrupt" };
    }
    return { kind: "ok", value: parsed as Record<string, unknown>, raw };
  } catch {
    return { kind: "corrupt" };
  }
}

/** Keeps a copy of a corrupt file before it is re-seeded, so history is recoverable by hand. */
function quarantine(file: string): void {
  try {
    copyFileSync(file, `${file}.corrupt-${String(Date.now())}`);
  } catch {
    // Best effort — never block the re-seed.
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Transparent first-run seeding: the tool must never crash on a clean machine. `init` is the real,
// user-facing way to author laboralDays — this is just the silent default so nothing else has to guard
// against a missing file.
export function loadConfig(accountKey: string): Config {
  migrateLegacyFilesIfNeeded();
  const file = configFile(accountKey);
  const result = readObjectFile(file);
  if (result.kind !== "ok") {
    if (result.kind === "corrupt") quarantine(file);
    const config = structuredClone(DEFAULT_CONFIG);
    saveConfig(accountKey, config);
    return config;
  }
  // Merged under DEFAULT_CONFIG rather than returned raw: a hasSpendCap:false account's monthlyCap/
  // laboralDays are meaningless and may be absent from the file entirely — every caller still gets a
  // complete Config in memory. Never rewrites the file for a valid partial object — purely an in-memory fill.
  const merged = { ...structuredClone(DEFAULT_CONFIG), ...(result.value as Partial<Config>) };
  return typeof merged.monthlyCap === "number" && Number.isFinite(merged.monthlyCap)
    ? merged
    : { ...merged, monthlyCap: DEFAULT_CONFIG.monthlyCap };
}

export function saveConfig(accountKey: string, config: Config): void {
  writeFileAtomic(configFile(accountKey), serialize(config));
}

// Raw text of the last usage.json read per account, so saveUsage can skip a write that changes nothing —
// most renders inside one session only move lastUpdated by a few seconds, but many renders change nothing.
const lastUsageRaw = new Map<string, string>();

export function loadUsage(accountKey: string, now: Date = new Date()): UsageState {
  migrateLegacyFilesIfNeeded();
  const file = usageFile(accountKey);
  const result = readObjectFile(file);
  if (result.kind !== "ok") {
    if (result.kind === "corrupt") quarantine(file);
    const usage = freshUsage(now);
    saveUsage(accountKey, usage);
    return usage;
  }
  lastUsageRaw.set(accountKey, result.raw);
  return upgradeUsage(result.value, now);
}

export function saveUsage(accountKey: string, usage: UsageState): void {
  const content = serialize(usage);
  if (lastUsageRaw.get(accountKey) === content) return;
  writeFileAtomic(usageFile(accountKey), content);
  lastUsageRaw.set(accountKey, content);
}

/** null when the refresher has never written one (or it is unreadable — the next refresh rewrites it). */
export function loadApiCache(accountKey: string): ApiCache | null {
  const result = readObjectFile(apiCacheFile(accountKey));
  if (result.kind !== "ok" || typeof result.value.fetchedAt !== "number") return null;
  return result.value as unknown as ApiCache;
}

export function saveApiCache(accountKey: string, cache: ApiCache): void {
  writeFileAtomic(apiCacheFile(accountKey), serialize(cache));
}
