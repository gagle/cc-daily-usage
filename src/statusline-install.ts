import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  assetsDir,
  backupFile,
  computeShippedVersion,
  type ConfirmFn,
  defaultConfirm,
  ensureClaudeDir,
  ensureSettingsStatusLine,
  extractVersion,
  hasMarker,
  MANAGED_MARKER_REGEX,
  readIfExists,
  SETTINGS_FILE,
  stampVersion,
  STATUSLINE_FILE,
} from "./statusline-shared.js";

export interface StatuslineInstallResult {
  readonly installed: boolean;
  readonly backupPath: string | null;
  readonly fromVersion: string | null; // null = no prior managed install
  readonly toVersion: string | null; // null = declined
}

/**
 * The `statusline` operation (§9.1): idempotent full install — visible daily/monthly segments plus the
 * capture logic (§18), both embedded in the one shipped script. Marker present already → silent no-op/
 * upgrade (keyed on the content-hash version, not a full-body diff — see statusline-shared.ts), zero
 * backups, zero prompts. Marker absent (no file, or a foreign/hand-written script) → confirm, then back up
 * ~/.claude/settings.json (only if it currently exists) before installing.
 */
export async function installStatusline(
  confirm: ConfirmFn = defaultConfirm,
): Promise<StatuslineInstallResult> {
  ensureClaudeDir();
  const existing = readIfExists(STATUSLINE_FILE);
  const template = readFileSync(path.join(assetsDir(), "statusline.mjs"), "utf8");
  const shippedVersion = computeShippedVersion(template);
  const shipped = stampVersion(template, shippedVersion);

  if (existing && hasMarker(existing, MANAGED_MARKER_REGEX)) {
    const installedVersion = extractVersion(existing);
    if (installedVersion !== shippedVersion) writeFileSync(STATUSLINE_FILE, shipped);
    ensureSettingsStatusLine();
    return {
      installed: true,
      backupPath: null,
      fromVersion: installedVersion,
      toVersion: shippedVersion,
    };
  }

  const proceed = await confirm(
    existing
      ? `An existing ${STATUSLINE_FILE} will be replaced with cc-daily-usage's managed statusline.`
      : `Install cc-daily-usage's statusline to ${STATUSLINE_FILE}?`,
  );
  if (!proceed) return { installed: false, backupPath: null, fromVersion: null, toVersion: null };

  const backupPath = backupFile(SETTINGS_FILE);
  writeFileSync(STATUSLINE_FILE, shipped);
  ensureSettingsStatusLine();
  return { installed: true, backupPath, fromVersion: null, toVersion: shippedVersion };
}
