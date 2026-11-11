import { describe, expect, it } from "vitest";

import type { SessionMapEntry } from "./interfaces/config.interface.js";
import { recentSessionIds, recordSession, SESSION_MAP_DAYS } from "./sessions-map.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const seen = {
  transcriptPath: "/t.jsonl",
  costUsd: 1,
  linesAdded: 2,
  linesRemoved: 0,
  name: null,
  claudeVersion: "2.1.293",
};

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

  it("returns the same map inside the hour when nothing changed", () => {
    const sessions = { a: entry(30 * 60 * 1000) };
    expect(recordSession(sessions, "a", seen, NOW)).toBe(sessions);
    const legacy = { a: { ...entry(30 * 60 * 1000), name: undefined } }; // written before names
    expect(recordSession(legacy, "a", seen, NOW)).toBe(legacy);
  });

  it("a new cost or line count is written at once", () => {
    const sessions = { a: entry(30 * 60 * 1000) };
    expect(recordSession(sessions, "a", { ...seen, costUsd: 5 }, NOW).a?.costUsd).toBe(5);
    expect(recordSession(sessions, "a", { ...seen, linesAdded: 3 }, NOW).a?.linesAdded).toBe(3);
    expect(recordSession(sessions, "a", { ...seen, linesRemoved: 1 }, NOW).a?.linesRemoved).toBe(1);
  });

  it("a new session name is written at once", () => {
    const sessions = { a: entry(30 * 60 * 1000) };
    expect(recordSession(sessions, "a", { ...seen, name: "fix login" }, NOW).a?.name).toBe(
      "fix login",
    );
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
