import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAUDE_DIR = path.join(homedir(), ".claude");
export const STATUSLINE_FILE = path.join(CLAUDE_DIR, "statusline.sh");
export const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");

export const MANAGED_MARKER_REGEX = /# cc-daily-usage:managed v\d+/;
export const CAPTURE_MARKER_REGEX = /# cc-daily-usage:capture v\d+/;

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
  if (existsSync(sameLevel)) return sameLevel;
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

/** Merges (never overwrites other keys) a `statusLine` block pointing at our managed script. */
export function ensureSettingsStatusLine(): void {
  ensureClaudeDir();
  const settings = readJsonFile(SETTINGS_FILE);
  settings.statusLine = { type: "command", command: STATUSLINE_FILE };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
