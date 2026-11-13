import type { ApiCache } from "./interfaces/config.interface.js";

/**
 * The newest Claude Code on npm, so the statusline can say an update is out. The refresher reads it (never a
 * render: network stays off the render path); the render compares it with the hook payload's `version`.
 */

const LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
/** Releases come about daily; a few hours late is fine. */
export const CLAUDE_CODE_LATEST_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const VERSION = /^\d+\.\d+\.\d+$/;

export type ClaudeCodeLatest = NonNullable<ApiCache["claudeCodeLatest"]>;

export function isLatestDue(cache: ApiCache | null, now: Date): boolean {
  const latest = cache?.claudeCodeLatest;
  return latest === undefined || now.getTime() - latest.fetchedAt >= CLAUDE_CODE_LATEST_TTL_MS;
}

/** npm's `latest` dist-tag, or null on any failure (network, HTTP error, bad JSON, odd version). */
export async function fetchClaudeCodeLatest(now: Date): Promise<ClaudeCodeLatest | null> {
  try {
    const response = await fetch(LATEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const { version } = (await response.json()) as { version?: unknown };
    return typeof version === "string" && VERSION.test(version)
      ? { version, fetchedAt: now.getTime() }
      : null;
  } catch {
    return null;
  }
}

/** Whether `latest` is a higher x.y.z than `installed`; false when either is not x.y.z (a pre-release, none). */
export function isNewer(latest: string | undefined, installed: string | undefined): boolean {
  if (!latest || !installed || !VERSION.test(latest) || !VERSION.test(installed)) return false;
  return rank(latest) > rank(installed);
}

/** x.y.z as one number; each part below 1e6 (Claude Code's patch is in the hundreds). */
const rank = (version: string): number =>
  version.split(".").reduce((sum, part) => sum * 1e6 + Number(part), 0);
