import { afterEach, describe, expect, it, vi } from "vitest";

import { freshUsage } from "./calc.js";
import { buildFeed, type FeedInput } from "./feed.js";
import type { LimitSample } from "./interfaces/config.interface.js";

const NOW = new Date("2026-10-07T12:00:00.000Z"); // a Wednesday
const nowSec = NOW.getTime() / 1000;

function input(overrides: Partial<FeedInput> = {}): FeedInput {
  return {
    accountKey: "acct",
    config: { monthlyCap: 100, laboralDays: {}, hasSpendCap: false, planType: "claude_max" },
    usage: freshUsage(NOW),
    samples: [],
    api: null,
    sessions: {},
    ...overrides,
  };
}

function sample(minutesAgo: number, five: number | null, seven: number | null): LimitSample {
  return {
    t: NOW.getTime() - minutesAgo * 60_000,
    fiveHourPct: five,
    sevenDayPct: seven,
    fiveHourResetsAt: nowSec + 3600,
    sevenDayResetsAt: null,
    apiEqTotal: 0,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildFeed", () => {
  it("Pro/Max: plan, sessions, no budget, empty advice, null windows without a reading", () => {
    const at = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    const entry = { transcriptPath: null, costUsd: 0, linesAdded: 0, linesRemoved: 0 };
    const feed = buildFeed(
      input({
        sessions: {
          a: { ...entry, firstSeenAt: at(1), lastSeenAt: at(1) },
          b: { ...entry, firstSeenAt: at(200), lastSeenAt: at(200) },
        },
      }),
      NOW,
    );
    expect(feed).toMatchObject({
      schemaVersion: 1,
      writtenAt: NOW.toISOString(),
      accountKey: "acct",
      plan: { organizationType: "claude_max", hasSpendCap: false },
      sessionIds: ["a"],
      limits: { fiveHour: null, sevenDay: null, usdPerPercentWeek: null, claudeCodeShare: null },
      advice: [],
    });
    expect(feed.budget).toBeUndefined();
    expect(feed.spend.isFloor).toBe(false);
  });

  it("uses a fresh API reading for the windows", () => {
    const feed = buildFeed(
      input({
        samples: [sample(60, 10, 5)],
        api: {
          fetchedAt: NOW.getTime(),
          extraUsage: null,
          fiveHour: { pct: 30, resetsAt: nowSec + 600 },
          sevenDay: null,
        },
      }),
      NOW,
    );
    expect(feed.limits.fiveHour).toEqual({
      usedPct: 30,
      resetsAt: new Date((nowSec + 600) * 1000).toISOString(),
      ratePctPerHour: 20,
      exhaustsAt: new Date((nowSec + 3.5 * 3600) * 1000).toISOString(),
      verdict: "comfortable",
    });
    // No API 7d window → the last sample's, an hour old.
    expect(feed.limits.sevenDay).toMatchObject({ usedPct: 5, resetsAt: null, verdict: "stale" });
  });

  it("falls back to the newest sample when the API reading is stale", () => {
    const api = {
      fetchedAt: NOW.getTime(),
      stale: true,
      extraUsage: null,
      fiveHour: { pct: 99, resetsAt: null },
      sevenDay: null,
    };
    const feed = buildFeed(input({ api, samples: [sample(30, 10, null)] }), NOW);
    expect(feed.limits.fiveHour).toMatchObject({ usedPct: 10, verdict: "stale" });
    expect(feed.limits.sevenDay).toBeNull();
  });

  it("dollar-cap plans get today's budget after an in-memory rollover", () => {
    const usage = { ...freshUsage(NOW), monthlySpent: 12, periodFrozen: 2 };
    const feed = buildFeed(
      input({
        config: {
          monthlyCap: 100,
          laboralDays: { "2026": { "10": [7, 8] } },
          hasSpendCap: true,
          planType: "claude_enterprise",
        },
        usage,
        api: {
          fetchedAt: NOW.getTime(),
          extraUsage: null,
          fiveHour: null,
          sevenDay: null,
        },
      }),
      NOW,
    );
    expect(feed.budget).toEqual({
      todaySpent: 10,
      todayMax: 49,
      monthSpent: 12,
      monthCap: 100,
      paceLabel: "Coast",
    });
  });

  it("passes advice and the floor flag through", () => {
    const finding = {
      id: "R1",
      title: "t",
      usd: 1,
      window: "week",
      evidence: "e",
      fix: { kind: "habit", text: "x" },
      snoozedUntil: null,
    } as const;
    const feed = buildFeed(input({ advice: [finding], isFloor: true }), NOW);
    expect(feed.advice).toEqual([finding]);
    expect(feed.spend.isFloor).toBe(true);
  });

  it.each(["UTC", "Europe/Madrid", "America/Los_Angeles"])(
    "sums API-equivalent $ over local days (%s)",
    (tz) => {
      vi.stubEnv("TZ", tz);
      const usage = freshUsage(NOW);
      usage.apiEqDays = {
        "2026-10-07": 1, // today
        "2026-10-01": 2, // 6 days back: in the week and the month
        "2026-09-30": 4, // 7 days back: out of the week, in 30 days
        "2026-09-07": 8, // 30 days back: out of everything
      };
      expect(buildFeed(input({ usage }), NOW).spend).toEqual({
        today: 1,
        week: 3,
        monthToDate: 3,
        last30Days: 7,
        isFloor: false,
      });
    },
  );
});
