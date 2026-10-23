import type { SessionMapEntry } from "./interfaces/config.interface.js";

const HOUR_MS = 60 * 60 * 1000;
/** Kept past usage.sessions' 2 days: the transcript index attributes sessions to accounts with it. */
export const SESSION_MAP_DAYS = 35;

export interface SessionSighting {
  readonly transcriptPath: string | null;
  readonly costUsd: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly name: string | null;
  readonly claudeVersion: string | null;
}

/**
 * Records one render's view of a session. A new session, a changed transcript path, name, cost or lines, or
 * an entry last touched an hour ago gives a new map (entries past SESSION_MAP_DAYS drop then); otherwise the
 * same object comes back, so the render skips the write. The cost stays current: the report checks the index
 * against it (selfCheck).
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
    (prior.name ?? null) !== seen.name ||
    prior.costUsd !== seen.costUsd ||
    prior.linesAdded !== seen.linesAdded ||
    prior.linesRemoved !== seen.linesRemoved ||
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
