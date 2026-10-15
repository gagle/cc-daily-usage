import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { freshUsage, upgradeUsage, USAGE_SCHEMA_VERSION } from "./calc.js";
import type {
  ApiCache,
  Config,
  LimitSample,
  SessionMapEntry,
  UsageState,
} from "./interfaces/config.interface.js";
import { DEFAULT_CONFIG } from "./interfaces/config.interface.js";
import { migrateRecord, type Migration, schemaVersionOf } from "./migrate.js";

/** Format steps per file (`vN → vN+1`); the current version is the list length. 0 → 1 only adds the
 * version. Never tie these to the npm or plugin version. */
function addVersionOnly(value: Record<string, unknown>): Record<string, unknown> {
  return value;
}
export const CONFIG_MIGRATIONS: ReadonlyArray<Migration> = [addVersionOnly];
export const API_CACHE_MIGRATIONS: ReadonlyArray<Migration> = [addVersionOnly];
export const LAYOUT_MIGRATIONS: ReadonlyArray<Migration> = [addVersionOnly];

export const NEWER_FILE_HINT =
  "A file was written by a newer cc-daily-usage. Run: npm i -g cc-daily-usage";

// Files of a format newer than this code: read what is safe, never rewrite (a downgrade guard).
const newerFiles = new Set<string>();

/** Files this process found written by a newer version (shown by the render and commands). */
export function listNewerFiles(): ReadonlyArray<string> {
  return [...newerFiles];
}

export function markNewerFile(file: string): void {
  newerFiles.add(file);
}

/** writeFileAtomic, except for a file a newer version wrote. */
export function writeVersionedFile(file: string, content: string): void {
  if (newerFiles.has(file)) return;
  writeFileAtomic(file, content);
}

/** Backups kept per file. */
const BACKUPS_KEPT = 3;

/** Copies `file` to `<file>.bak-<ISO>-<pid>` before a migration rewrites it; keeps the newest 3. The ISO
 * has `:` replaced so the name is valid on Windows. Best effort: a failed backup never blocks the load. */
export function backupFile(file: string, now: Date = new Date()): void {
  try {
    const stamp = now.toISOString().replaceAll(":", "-");
    copyFileSync(file, `${file}.bak-${stamp}-${String(process.pid)}`);
    const prefix = `${path.basename(file)}.bak-`;
    const backups = readdirSync(path.dirname(file))
      .filter((name) => name.startsWith(prefix))
      .sort();
    for (const name of backups.slice(0, -BACKUPS_KEPT)) {
      rmSync(path.join(path.dirname(file), name), { force: true });
    }
  } catch {
    // The migrated file is still written; only the safety copy is missing.
  }
}

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
  const migrated = migrateRecord(result.value, CONFIG_MIGRATIONS);
  if (migrated.kind === "future") markNewerFile(file);
  else if (migrated.kind === "migrated") {
    backupFile(file);
    writeFileAtomic(file, serialize(migrated.value));
  }
  // Merged under DEFAULT_CONFIG rather than returned raw: a hasSpendCap:false account's monthlyCap/
  // laboralDays are meaningless and may be absent from the file entirely — every caller still gets a
  // complete Config in memory. Never rewrites the file for a valid partial object — purely an in-memory fill.
  // A newer file is read as-is: unknown fields ride along, and saveConfig will not write it back.
  const { schemaVersion: _version, ...fields } =
    migrated.kind === "future" ? result.value : migrated.value;
  const merged = { ...structuredClone(DEFAULT_CONFIG), ...(fields as Partial<Config>) };
  return typeof merged.monthlyCap === "number" && Number.isFinite(merged.monthlyCap)
    ? merged
    : { ...merged, monthlyCap: DEFAULT_CONFIG.monthlyCap };
}

export function saveConfig(accountKey: string, config: Config): void {
  writeVersionedFile(
    configFile(accountKey),
    serialize({ ...config, schemaVersion: CONFIG_MIGRATIONS.length }),
  );
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
  const version = schemaVersionOf(result.value);
  if (version > USAGE_SCHEMA_VERSION) markNewerFile(file);
  else if (version < USAGE_SCHEMA_VERSION) backupFile(file, now);
  return upgradeUsage(result.value, now);
}

export function saveUsage(accountKey: string, usage: UsageState): void {
  const content = serialize(usage);
  if (lastUsageRaw.get(accountKey) === content) return;
  writeVersionedFile(usageFile(accountKey), content);
  lastUsageRaw.set(accountKey, content);
}

/** null when the refresher has never written one (or it is unreadable — the next refresh rewrites it). */
export function loadApiCache(accountKey: string): ApiCache | null {
  const file = apiCacheFile(accountKey);
  const result = readObjectFile(file);
  if (result.kind !== "ok") return null;
  // A cache: a legacy one is read as-is and the next refresh writes the current version.
  const migrated = migrateRecord(result.value, API_CACHE_MIGRATIONS);
  if (migrated.kind === "future") {
    markNewerFile(file);
    return null;
  }
  const { schemaVersion: _version, ...cache } = migrated.value;
  return typeof cache.fetchedAt === "number" ? (cache as unknown as ApiCache) : null;
}

export function saveApiCache(accountKey: string, cache: ApiCache): void {
  writeVersionedFile(
    apiCacheFile(accountKey),
    serialize({ ...cache, schemaVersion: API_CACHE_MIGRATIONS.length }),
  );
}

/** Format version of limits.json and sessions-map.json (new files, versioned from the start). */
export const HISTORY_SCHEMA_VERSION = 1;

/** The `key` object of a versioned history file; empty when missing or unreadable. A newer version is
 * read as empty and marked, so the save below leaves it alone. */
function loadHistoryRecord(file: string, key: string): unknown {
  const result = readObjectFile(file);
  if (result.kind !== "ok") return undefined;
  if (schemaVersionOf(result.value) > HISTORY_SCHEMA_VERSION) {
    markNewerFile(file);
    return undefined;
  }
  return result.value[key];
}

export function limitsFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "limits.json");
}

export function loadLimitSamples(accountKey: string): ReadonlyArray<LimitSample> {
  const samples = loadHistoryRecord(limitsFile(accountKey), "samples");
  // Two renders racing on load → append → save can leave samples out of time order; every reader assumes it.
  return Array.isArray(samples) ? (samples as Array<LimitSample>).sort((a, b) => a.t - b.t) : [];
}

export function saveLimitSamples(accountKey: string, samples: ReadonlyArray<LimitSample>): void {
  writeVersionedFile(
    limitsFile(accountKey),
    JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, samples }),
  );
}

export function sessionsMapFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "sessions-map.json");
}

export function loadSessionsMap(accountKey: string): Record<string, SessionMapEntry> {
  const sessions = loadHistoryRecord(sessionsMapFile(accountKey), "sessions");
  return sessions !== null && typeof sessions === "object" && !Array.isArray(sessions)
    ? (sessions as Record<string, SessionMapEntry>)
    : {};
}

export function saveSessionsMap(
  accountKey: string,
  sessions: Readonly<Record<string, SessionMapEntry>>,
): void {
  writeVersionedFile(
    sessionsMapFile(accountKey),
    JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, sessions }),
  );
}

export function feedFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "feed.json");
}

/** feed.json's `advice`, for the statusline's coach part; empty when missing, unreadable or newer. */
export function loadFeedAdvice(accountKey: string): ReadonlyArray<Record<string, unknown>> {
  const advice = loadHistoryRecord(feedFile(accountKey), "advice");
  return Array.isArray(advice) ? (advice as ReadonlyArray<Record<string, unknown>>) : [];
}

/** feed.json — written only off the render path (refresher, report, insights). */
export function saveFeed(accountKey: string, feed: unknown): void {
  writeFileAtomic(feedFile(accountKey), serialize(feed));
}
