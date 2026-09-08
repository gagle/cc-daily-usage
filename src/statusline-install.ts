import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  assetsDir,
  backupFile,
  type ConfirmFn,
  defaultConfirm,
  ensureClaudeDir,
  ensureSettingsStatusLine,
  hasMarker,
  MANAGED_MARKER_REGEX,
  readIfExists,
  SETTINGS_FILE,
  STATUSLINE_FILE,
} from "./statusline-shared.js";

export interface StatuslineInstallResult {
  readonly installed: boolean;
  readonly backupPath: string | null;
}

/**
 * The `statusline` operation (§9.1): idempotent full install — visible daily/monthly segments plus the
 * capture logic (§18), both embedded in the one shipped script. Marker present already → silent no-op/
 * upgrade, zero backups, zero prompts. Marker absent (no file, or a foreign/hand-written script) → confirm,
 * then back up ~/.claude/settings.json (only if it currently exists) before installing.
 */
export async function installStatusline(
  confirm: ConfirmFn = defaultConfirm,
): Promise<StatuslineInstallResult> {
  ensureClaudeDir();
  const existing = readIfExists(STATUSLINE_FILE);
  const shipped = readFileSync(path.join(assetsDir(), "statusline.sh"), "utf8");

  if (existing && hasMarker(existing, MANAGED_MARKER_REGEX)) {
    if (existing !== shipped) writeFileSync(STATUSLINE_FILE, shipped, { mode: 0o755 });
    ensureSettingsStatusLine();
    return { installed: true, backupPath: null };
  }

  const proceed = await confirm(
    existing
      ? `An existing ${STATUSLINE_FILE} will be replaced with cc-daily-usage's managed statusline.`
      : `Install cc-daily-usage's statusline to ${STATUSLINE_FILE}?`,
  );
  if (!proceed) return { installed: false, backupPath: null };

  const backupPath = backupFile(SETTINGS_FILE);
  writeFileSync(STATUSLINE_FILE, shipped, { mode: 0o755 });
  ensureSettingsStatusLine();
  return { installed: true, backupPath };
}
