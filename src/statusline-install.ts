import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONFIG_ROOT_DIR, writeFileAtomic } from "./config.js";
import {
  assetsDir,
  backupFile,
  computeShippedVersion,
  type ConfirmFn,
  defaultConfirm,
  ensureClaudeDir,
  ensureManagedHooks,
  ensureSettingsStatusLine,
  extractVersion,
  hasMarker,
  MANAGED_MARKER_REGEX,
  readIfExists,
  readJsonFile,
  SETTINGS_FILE,
  stampVersion,
  STATUSLINE_FILE,
  writeSettings,
} from "./statusline-shared.js";

export interface StatuslineInstallResult {
  readonly installed: boolean;
  readonly backupPath: string | null;
  readonly fromVersion: string | null; // null = no prior managed install
  readonly toVersion: string | null; // null = declined
}

const ENTRY_PLACEHOLDER = "__CC_DAILY_USAGE_ENTRY__";

/** The package's own bin — what our hooks (prompt gate, model switch) run. */
export function binPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cc-daily-usage.js");
}

/** A copy run through `npx` / `pnpm dlx` lives in a cache that is cleared later: a shim and hooks pointing
 * there break when it goes. */
export function isEphemeralInstall(file: string = binPath()): boolean {
  return /[\\/](_npx|dlx)[\\/]/.test(file);
}

/** What the user had before the first managed install — read back by uninstallStatusline. */
const PREVIOUS_FILE = path.join(CONFIG_ROOT_DIR, "previous-statusline.json");

interface PreviousStatusline {
  readonly statusLine: unknown; // settings.json `statusLine` value before install; null = none
  readonly scriptBackup: string | null; // copy of a foreign ~/.claude/statusline.mjs we replaced
}

/** file:// URL of this package's statusline module — what the shim imports. Absolute, so the shim works
 * from any cwd; `pathToFileURL` keeps Windows drive letters valid for `import()`. */
export function statuslineEntryUrl(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return pathToFileURL(path.join(here, "statusline.js")).href;
}

/** The template stamped with the entry URL, then with its own content-hash version — the hash covers the
 * entry, so moving the package (new path) also counts as a version change and rewrites the shim. */
export function shippedStatusline(
  template: string,
  entryUrl: string,
): {
  readonly content: string;
  readonly version: string;
} {
  const withEntry = template.replaceAll(ENTRY_PLACEHOLDER, entryUrl);
  const version = computeShippedVersion(withEntry);
  return { content: stampVersion(withEntry, version), version };
}

/**
 * The `statusline` operation: idempotent full install. Marker present already → silent no-op/upgrade
 * (keyed on the content-hash version), zero backups, zero prompts. Marker absent (no file, or a foreign
 * script) → confirm, back up settings.json and the foreign script, remember the previous statusLine for
 * `uninstall`, then install.
 */
export async function installStatusline(
  confirm: ConfirmFn = defaultConfirm,
): Promise<StatuslineInstallResult> {
  ensureClaudeDir();
  const existing = readIfExists(STATUSLINE_FILE);
  const template = readFileSync(path.join(assetsDir(), "statusline.mjs"), "utf8");
  const shipped = shippedStatusline(template, statuslineEntryUrl());

  if (existing && hasMarker(existing, MANAGED_MARKER_REGEX)) {
    const installedVersion = extractVersion(existing);
    if (installedVersion !== shipped.version) writeFileAtomic(STATUSLINE_FILE, shipped.content);
    ensureSettingsStatusLine();
    ensureManagedHooks(binPath());
    return {
      installed: true,
      backupPath: null,
      fromVersion: installedVersion,
      toVersion: shipped.version,
    };
  }

  const proceed = await confirm(
    existing
      ? `An existing ${STATUSLINE_FILE} will be replaced with cc-daily-usage's managed statusline.`
      : `Install cc-daily-usage's statusline to ${STATUSLINE_FILE}?`,
  );
  if (!proceed) return { installed: false, backupPath: null, fromVersion: null, toVersion: null };

  const previous: PreviousStatusline = {
    statusLine: readJsonFile(SETTINGS_FILE).statusLine ?? null,
    scriptBackup: existing ? backupFile(STATUSLINE_FILE) : null,
  };
  if (!existsSync(PREVIOUS_FILE)) writeFileAtomic(PREVIOUS_FILE, JSON.stringify(previous, null, 2));
  const backupPath = backupFile(SETTINGS_FILE);
  writeFileAtomic(STATUSLINE_FILE, shipped.content);
  ensureSettingsStatusLine();
  ensureManagedHooks(binPath());
  return { installed: true, backupPath, fromVersion: null, toVersion: shipped.version };
}

export interface UninstallResult {
  readonly removed: boolean;
  readonly restoredFrom: string | null; // the previous script backup, when one was put back
}

/** Removes the managed shim and puts back what was there before the first install (statusLine value and,
 * when we replaced one, the foreign script). Leaves accounts/ data alone. No-op when nothing is managed. */
export function uninstallStatusline(): UninstallResult {
  const existing = readIfExists(STATUSLINE_FILE);
  if (!existing || !hasMarker(existing, MANAGED_MARKER_REGEX)) {
    return { removed: false, restoredFrom: null };
  }
  let previous: PreviousStatusline = { statusLine: null, scriptBackup: null };
  try {
    previous = JSON.parse(readFileSync(PREVIOUS_FILE, "utf8")) as PreviousStatusline;
  } catch {
    // No record (installed by a version before uninstall existed) — just drop our statusLine.
  }

  const settings = readJsonFile(SETTINGS_FILE);
  if (previous.statusLine === null) delete settings.statusLine;
  else settings.statusLine = previous.statusLine;
  writeSettings(settings);
  ensureManagedHooks(null);

  const backup = previous.scriptBackup;
  if (backup && existsSync(backup)) writeFileAtomic(STATUSLINE_FILE, readFileSync(backup, "utf8"));
  else rmSync(STATUSLINE_FILE, { force: true });
  rmSync(PREVIOUS_FILE, { force: true });
  return { removed: true, restoredFrom: backup && existsSync(backup) ? backup : null };
}
