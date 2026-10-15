import type { SessionMapEntry } from "./interfaces/config.interface.js";

const HOUR_MS = 60 * 60 * 1000;
/** Kept past usage.sessions' 2 days: the transcript index attributes sessions to accounts with it. */
export const SESSION_MAP_DAYS = 35;

export interface SessionSighting {
  readonly transcriptPath: string | null;
  readonly costUsd: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
}

/**
 * Records one render's view of a session. A new session, a changed transcript path, or an entry last
 * touched an hour ago gives a new map (entries past SESSION_MAP_DAYS drop then); otherwise the same object
 * comes back, so the render skips the write.
 * # ponytail: cost and lines lag up to an hour; fine for $ per 100 lines, upgrade by writing on change.
 */
export function recordSession(
  sessions: Readonly<Record<string, SessionMapEntry>>,
  sessionId: string,
  seen: SessionSighting,
  now: Date,
): Readonly<Record<string, SessionMapEntry>> {
  const prior = sessions[sessionId];
  const due =
    !prior ||
    prior.transcriptPath !== seen.transcriptPath ||
    now.getTime() - new Date(prior.lastSeenAt).getTime() >= HOUR_MS;
  if (!due) return sessions;
  const cutoff = now.getTime() - SESSION_MAP_DAYS * 24 * HOUR_MS;
  const kept = Object.entries(sessions).filter(
    ([, entry]) => new Date(entry.lastSeenAt).getTime() >= cutoff,
  );
  return {
    ...Object.fromEntries(kept),
    [sessionId]: {
      ...seen,
      firstSeenAt: prior?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
    },
  };
}

/** Sessions seen in the last `days` days, newest first. */
export function recentSessionIds(
  sessions: Readonly<Record<string, SessionMapEntry>>,
  days: number,
  now: Date,
): ReadonlyArray<string> {
  const cutoff = now.getTime() - days * 24 * HOUR_MS;
  return Object.entries(sessions)
    .filter(([, entry]) => new Date(entry.lastSeenAt).getTime() >= cutoff)
    .sort(([, a], [, b]) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .map(([id]) => id);
}
