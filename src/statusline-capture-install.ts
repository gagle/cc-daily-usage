import { writeFileSync } from "node:fs";

import {
  backupFile,
  CAPTURE_MARKER_REGEX,
  type ConfirmFn,
  defaultConfirm,
  ensureClaudeDir,
  hasMarker,
  MANAGED_MARKER_REGEX,
  readIfExists,
  STATUSLINE_FILE,
} from "./statusline-shared.js";

const CAPTURE_MARKER = "# cc-daily-usage:capture v1";
const CAPTURE_LINE = `echo "$input" | cc-daily-usage --statusline >/dev/null 2>&1`;

function injectCaptureLine(existingScript: string): string {
  const lines = existingScript.split("\n");
  const insertAt = lines[0]?.startsWith("#!") ? 1 : 0;
  lines.splice(insertAt, 0, CAPTURE_MARKER, CAPTURE_LINE);
  return lines.join("\n");
}

function minimalScriptWithCapture(): string {
  return [
    "#!/usr/bin/env bash",
    "input=$(cat)",
    CAPTURE_MARKER,
    CAPTURE_LINE,
    'echo "$input"',
    "",
  ].join("\n");
}

export interface CaptureInstallResult {
  readonly installed: boolean;
  readonly backupPath: string | null;
}

/**
 * The declined-fallback path from §7.6/decision 22: injects only the one-line usage-capture call into
 * whatever ~/.claude/statusline.sh already exists (or a minimal passthrough script if none does), so
 * `usage.json.monthlySpent` keeps accumulating even without the visible daily/monthly segments. Never
 * touches settings.json — this path adds no segment for it to point at.
 */
export async function installCaptureOnly(
  confirm: ConfirmFn = defaultConfirm,
): Promise<CaptureInstallResult> {
  ensureClaudeDir();
  const existing = readIfExists(STATUSLINE_FILE);

  if (
    existing &&
    (hasMarker(existing, CAPTURE_MARKER_REGEX) || hasMarker(existing, MANAGED_MARKER_REGEX))
  ) {
    // Already captures (either standalone, or as part of a full managed install) — silent no-op.
    return { installed: true, backupPath: null };
  }

  const proceed = await confirm(
    existing
      ? `Inject usage capture into the existing ${STATUSLINE_FILE}?`
      : `Create ${STATUSLINE_FILE} with usage capture only?`,
  );
  if (!proceed) return { installed: false, backupPath: null };

  const backupPath = backupFile(STATUSLINE_FILE);
  const content = existing ? injectCaptureLine(existing) : minimalScriptWithCapture();
  writeFileSync(STATUSLINE_FILE, content, { mode: 0o755 });
  return { installed: true, backupPath };
}
