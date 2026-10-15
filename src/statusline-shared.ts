import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_DIR = path.join(homedir(), ".claude");
export const STATUSLINE_FILE = path.join(CLAUDE_DIR, "statusline.mjs");
export const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");

// Captures the version so installStatusline can tell "same version, no-op" apart from "different
// version, upgrade" — see computeShippedVersion/stampVersion/extractVersion below. `//`, not `#`: the
// managed file is JS (ESM), where `#` is only valid on a line-1 shebang.
export const MANAGED_MARKER_REGEX = /\/\/ cc-daily-usage:managed v([0-9a-f]{8})/;
export const CAPTURE_MARKER_REGEX = /\/\/ cc-daily-usage:capture v\d+/;

const VERSION_PLACEHOLDER = "__CC_DAILY_USAGE_VERSION__";

/**
 * The shipped script's "version" is a short hash of its own template — computed from the raw template
 * (placeholder still in place, before stamping), so it's stable and reproducible for a given file content
 * without the chicken-and-egg of a marker hashing itself. Changes the instant the script's content changes,
 * whether that's a new release or a local dev edit — no manual version bump, no build step, no reliance on
 * npm/tar file mtimes.
 */
export function computeShippedVersion(template: string): string {
  return createHash("sha256").update(template).digest("hex").slice(0, 8);
}

export function stampVersion(template: string, version: string): string {
  return template.replaceAll(VERSION_PLACEHOLDER, version);
}

export function extractVersion(content: string): string | null {
  return MANAGED_MARKER_REGEX.exec(content)?.[1] ?? null;
}

export type ConfirmFn = (question: string) => Promise<boolean>;

/** Same Y/n readline shape as agent-console-affected.mjs's confirmRun: empty/y/yes = proceed. */
export async function defaultConfirm(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (Y/n) `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// Layout-tolerant: in the local dev/test tree, this compiled file sits at <root>/dist/<file>.js and
// assets/ lives one level up at <root>/assets/. Once published via prepare-dist, dist/ is flattened
// into the package root, so the same file sits at <published-root>/<file>.js with assets/ copied as a
// same-level sibling instead. Try the flattened layout first, fall back to the un-flattened one.
export function assetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sameLevel = path.join(here, "assets");
  // Require the template file, not just the directory — an empty sibling (e.g. a parallel test's
  // brief mkdir) must not steal resolution away from ../assets.
  if (existsSync(path.join(sameLevel, "statusline.mjs"))) return sameLevel;
  return path.join(here, "..", "assets");
}

export function readIfExists(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

export function hasMarker(content: string, marker: RegExp): boolean {
  return marker.test(content);
}

// ~/.claude is normally created by Claude Code itself on first run, but nothing here should assume that —
// every write in this module goes through this first.
export function ensureClaudeDir(): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });
}

/** Backs up `filePath` to `${filePath}.bak_<Date.now()>`; no-op (returns null) if the source doesn't exist. */
export function backupFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const backupPath = `${filePath}.bak_${String(Date.now())}`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

export function readJsonFile(filePath: string): Record<string, unknown> {
  const raw = readIfExists(filePath);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** Re-run interval while a session is idle. Each run is local-only (see statusline.ts) and the usage API
 * is throttled by its own TTL, so this costs no tokens; it is what turns a stale ⏱ fresh without a message. */
export const STATUSLINE_REFRESH_SECONDS = 30;
/** While the prompt cache has under a minute left, re-render every second so the countdown is live. */
export const STATUSLINE_FAST_REFRESH_SECONDS = 1;
export const FAST_REFRESH_BELOW_SECONDS = 60;

/**
 * Switches our statusLine.refreshInterval between the idle and the fast value. Writes only on a change (at
 * most twice per cache cycle) and only when the interval is one of ours — a user-chosen value is left alone.
 * # ponytail: relies on Claude Code re-reading settings.json live; read-modify-write could race a manual edit
 * of settings.json in the same millisecond. Upgrade path: a native dynamic-interval API if Claude Code adds one.
 */
export function syncRefreshInterval(seconds: number): void {
  const settings = readJsonFile(SETTINGS_FILE);
  const statusLine = settings.statusLine as Record<string, unknown> | undefined;
  if (statusLine?.command !== `node ${JSON.stringify(STATUSLINE_FILE)}`) return;
  const current = statusLine.refreshInterval;
  if (current === seconds) return;
  if (current !== STATUSLINE_REFRESH_SECONDS && current !== STATUSLINE_FAST_REFRESH_SECONDS) return;
  settings.statusLine = { ...statusLine, refreshInterval: seconds };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/** Merges (never overwrites other keys) a `statusLine` block pointing at our managed script. An explicit
 * `node` prefix, not a bare path relying on a shebang + exec bit: Windows resolves neither. `node` itself
 * is guaranteed on PATH — it's what runs Claude Code / cc-daily-usage in the first place. A user-set
 * refreshInterval/padding on our own block is kept. Skips the write when nothing changes. */
export function ensureSettingsStatusLine(): void {
  ensureClaudeDir();
  const settings = readJsonFile(SETTINGS_FILE);
  const command = `node ${JSON.stringify(STATUSLINE_FILE)}`;
  const current = settings.statusLine as Record<string, unknown> | undefined;
  const ours = current?.command === command ? current : {};
  const next = {
    ...ours,
    type: "command",
    command,
    refreshInterval: ours.refreshInterval ?? STATUSLINE_REFRESH_SECONDS,
  };
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  settings.statusLine = next;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/** Our hooks: the Claude Code event, and the hidden flag that runs it (also how we recognise our own entry). */
export const MANAGED_HOOKS = [
  { event: "UserPromptSubmit", flag: "--prompt-gate" },
  { event: "PreModelSwitch", flag: "--model-switch" },
] as const;

/** The command one of our hooks runs; recognised (and replaced/removed) by its flag. */
export function hookCommand(binPath: string, flag: string): string {
  return `node ${JSON.stringify(binPath)} ${flag}`;
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks?: ReadonlyArray<{ readonly type?: string; readonly command?: string }>;
}

function isOurs(group: HookGroup, flag: string): boolean {
  return (group.hooks ?? []).some((hook) => hook.command?.includes(flag) === true);
}

/** Adds (or re-points) our hooks (prompt gate, model-switch cost) in settings.json, keeping every other
 * hook. `null` removes them. Skips the write when nothing changes. */
export function ensureManagedHooks(binPath: string | null): void {
  ensureClaudeDir();
  const settings = readJsonFile(SETTINGS_FILE);
  const hooks = new Map(
    Object.entries((settings.hooks as Record<string, Array<HookGroup>> | undefined) ?? {}),
  );
  for (const { event, flag } of MANAGED_HOOKS) {
    const others = (hooks.get(event) ?? []).filter((group) => !isOurs(group, flag));
    const next =
      binPath === null
        ? others
        : [
            ...others,
            { hooks: [{ type: "command", command: hookCommand(binPath, flag), timeout: 10 }] },
          ];
    if (next.length > 0) hooks.set(event, next);
    else hooks.delete(event);
  }
  const nextSettings: Record<string, unknown> = { ...settings, hooks: Object.fromEntries(hooks) };
  if (hooks.size === 0) delete nextSettings.hooks;
  if (JSON.stringify(nextSettings) === JSON.stringify(settings)) return;
  writeFileSync(SETTINGS_FILE, JSON.stringify(nextSettings, null, 2));
}

/** `promptCacheTtl` from ~/.claude/settings.json (Claude Code v2.1.242+), undefined when unset. */
export function promptCacheTtl(): string | undefined {
  const value = readJsonFile(SETTINGS_FILE).promptCacheTtl;
  return typeof value === "string" ? value : undefined;
}

export function setPromptCacheTtl(ttl: "5m" | "1h"): void {
  ensureClaudeDir();
  const settings = readJsonFile(SETTINGS_FILE);
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...settings, promptCacheTtl: ttl }, null, 2));
}
