import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/** `<package>/assets`: this compiled file sits in `<package>/dist/`, in the repo and in the published
 * package alike (it publishes from the root: `files` is dist + bin + assets). */
export function assetsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
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
 * is throttled by its own TTL, so this costs no tokens; it is what turns a stale ⏱ fresh without a message.
 * Claude Code also re-runs the line itself when a cache `expires_at` or a limit `resets_at` passes. */
export const STATUSLINE_REFRESH_SECONDS = 30;
/** The live 1 s value older versions switched to near a cache expiry; `statusline` puts it back to 30. */
const LEGACY_FAST_REFRESH_SECONDS = 1;

/** Writes ~/.claude/settings.json through a temp file + rename, keeping the file's mode. Claude Code kills a
 * statusline or hook run when a newer one starts, so a plain write could leave the user's settings empty. */
export function writeSettings(settings: Record<string, unknown>): void {
  ensureClaudeDir();
  const temp = `${SETTINGS_FILE}.${String(process.pid)}.tmp`;
  const mode = existsSync(SETTINGS_FILE) ? statSync(SETTINGS_FILE).mode & 0o777 : 0o644;
  writeFileSync(temp, JSON.stringify(settings, null, 2), { mode });
  renameSync(temp, SETTINGS_FILE);
}

/** Merges (never overwrites other keys) a `statusLine` block pointing at our managed script. An explicit
 * `node` prefix, not a bare path relying on a shebang + exec bit: Windows resolves neither. `node` itself
 * is guaranteed on PATH — it's what runs Claude Code / cc-daily-usage in the first place. A user-set
 * refreshInterval/padding on our own block is kept (the legacy live 1 s value goes back to 30). Skips the
 * write when nothing changes. */
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
    refreshInterval:
      ours.refreshInterval === undefined || ours.refreshInterval === LEGACY_FAST_REFRESH_SECONDS
        ? STATUSLINE_REFRESH_SECONDS
        : ours.refreshInterval,
  };
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  settings.statusLine = next;
  writeSettings(settings);
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

/** The hidden flag our `subagentStatusLine` command runs (agent-panel rows with model, effort, context). */
export const SUBAGENT_LINE_FLAG = "--subagent-statusline";

/** Adds (or re-points) our hooks (prompt gate, model-switch cost) and our `subagentStatusLine` in
 * settings.json, keeping every other hook and a user's own subagent line. `null` removes ours. Skips the
 * write when nothing changes. */
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
  const subagent = settings.subagentStatusLine as { command?: unknown } | undefined;
  const subagentIsOurs =
    typeof subagent?.command === "string" && subagent.command.includes(SUBAGENT_LINE_FLAG);
  if (binPath !== null && (subagent === undefined || subagentIsOurs)) {
    nextSettings.subagentStatusLine = {
      type: "command",
      command: hookCommand(binPath, SUBAGENT_LINE_FLAG),
    };
  } else if (binPath === null && subagentIsOurs) {
    delete nextSettings.subagentStatusLine;
  }
  if (JSON.stringify(nextSettings) === JSON.stringify(settings)) return;
  writeSettings(nextSettings);
}

/** `promptCacheTtl` from ~/.claude/settings.json (Claude Code v2.1.242+), undefined when unset. */
export function promptCacheTtl(): string | undefined {
  const value = readJsonFile(SETTINGS_FILE).promptCacheTtl;
  return typeof value === "string" ? value : undefined;
}

export function setPromptCacheTtl(ttl: "5m" | "1h"): void {
  writeSettings({ ...readJsonFile(SETTINGS_FILE), promptCacheTtl: ttl });
}
