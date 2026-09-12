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

const CAPTURE_MARKER = "// cc-daily-usage:capture v1";
// Dynamic import, not a static one: this line gets spliced into an arbitrary foreign script (see
// injectCaptureLine below) whose own imports we can't know or control — self-contained, assumes only that
// an `input` variable holding the raw stdin is already in scope (the same assumption the old bash version
// made about `input=$(cat)`, which every cc-daily-usage-aware statusline script follows).
const CAPTURE_LINE =
  '(await import("node:child_process")).spawnSync("cc-daily-usage --statusline", { input, shell: true, stdio: ["pipe", "ignore", "ignore"] });';

function injectCaptureLine(existingScript: string): string {
  const lines = existingScript.split("\n");
  const insertAt = lines[0]?.startsWith("#!") ? 1 : 0;
  lines.splice(insertAt, 0, CAPTURE_MARKER, CAPTURE_LINE);
  return lines.join("\n");
}

function minimalScriptWithCapture(): string {
  return [
    "#!/usr/bin/env node",
    CAPTURE_MARKER,
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    'const input = Buffer.concat(chunks).toString("utf8");',
    CAPTURE_LINE,
    "process.stdout.write(input);",
    "",
  ].join("\n");
}

export interface CaptureInstallResult {
  readonly installed: boolean;
  readonly backupPath: string | null;
}

/**
 * The declined-fallback path from §7.6/decision 22: injects only the one-line usage-capture call into
 * whatever ~/.claude/statusline.mjs already exists (or a minimal passthrough script if none does), so
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
