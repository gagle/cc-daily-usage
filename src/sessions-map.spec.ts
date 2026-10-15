import { describe, expect, it } from "vitest";

import type { SessionMapEntry } from "./interfaces/config.interface.js";
import { recentSessionIds, recordSession, SESSION_MAP_DAYS } from "./sessions-map.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const seen = { transcriptPath: "/t.jsonl", costUsd: 1, linesAdded: 2, linesRemoved: 0 };

function entry(lastSeenMsAgo: number): SessionMapEntry {
  const at = new Date(NOW.getTime() - lastSeenMsAgo).toISOString();
  return { ...seen, firstSeenAt: at, lastSeenAt: at };
}

describe("recordSession", () => {
  it("adds a new session with its first-seen time", () => {
    expect(recordSession({}, "a", seen, NOW)).toEqual({
      a: { ...seen, firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString() },
    });
  });

  it("returns the same map inside the hour with the same path", () => {
    const sessions = { a: entry(30 * 60 * 1000) };
    expect(recordSession(sessions, "a", { ...seen, costUsd: 5 }, NOW)).toBe(sessions);
  });

  it("refreshes an hour-old entry, keeps firstSeenAt, and prunes old sessions", () => {
    const sessions = { a: entry(60 * 60 * 1000), old: entry(SESSION_MAP_DAYS * DAY + 1) };
    const next = recordSession(sessions, "a", { ...seen, costUsd: 5 }, NOW);
    expect(Object.keys(next)).toEqual(["a"]);
    expect(next.a).toMatchObject({ costUsd: 5, firstSeenAt: sessions.a.firstSeenAt });
  });
});

describe("recentSessionIds", () => {
  it("lists sessions seen inside the window, newest first", () => {
    const sessions = { a: entry(2 * DAY), b: entry(DAY), c: entry(8 * DAY) };
    expect(recentSessionIds(sessions, 7, NOW)).toEqual(["b", "a"]);
  });
});
