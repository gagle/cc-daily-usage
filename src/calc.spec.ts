import { describe, expect, it } from "vitest";

import {
  captureSessionCost,
  classifyHasSpendCap,
  colorForPct,
  computeToday,
  getLaboralDays,
  pruneStaleSessions,
  reconcileFromExtraUsageSnapshot,
  reconcileLaboralDays,
  rolloverIfNeeded,
  utcDateString,
} from "./calc.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    monthlyCap: 650,
    laboralDays: { "2026": { "9": [1, 2, 3, 4, 7, 8, 9, 10] } },
    ...overrides,
  };
}

function makeUsage(overrides: Partial<UsageState> = {}): UsageState {
  return {
    monthlySpent: 0,
    lastUpdated: new Date(0).toISOString(),
    days: {},
    sessions: {},
    frozenForDate: null,
    frozenAvgPerDay: null,
    frozenSafeMonthTotal: null,
    ...overrides,
  };
}

describe("getLaboralDays", () => {
  it("returns the configured day list", () => {
    expect(getLaboralDays(makeConfig(), 2026, 9)).toEqual([1, 2, 3, 4, 7, 8, 9, 10]);
  });

  it("returns an empty array when the year/month is not configured", () => {
    expect(getLaboralDays(makeConfig(), 2027, 1)).toEqual([]);
    expect(getLaboralDays(makeConfig(), 2026, 10)).toEqual([]);
  });
});

describe("utcDateString", () => {
  it("formats a Date as YYYY-MM-DD in UTC", () => {
    expect(utcDateString(new Date("2026-09-04T23:55:00.000Z"))).toBe("2026-09-04");
  });
});

describe("rolloverIfNeeded", () => {
  it("is a no-op on the same UTC day beyond refreshing lastUpdated", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-01T00:00:00.000Z", monthlySpent: 10 });
    const now = new Date("2026-09-01T23:00:00.000Z");
    const result = rolloverIfNeeded(usage, makeConfig(), now);
    expect(result.days).toEqual({});
    expect(result.lastUpdated).toBe(now.toISOString());
  });

  it("freezes every missed laboral day in a multi-day gap, skipping non-laboral days", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-01T12:00:00.000Z", monthlySpent: 40 });
    const now = new Date("2026-09-05T00:00:00.000Z");
    const result = rolloverIfNeeded(usage, makeConfig(), now);
    // walk covers 09-01 (lastUpdated's own day) through 09-04; all laboral per fixture config. The $40 was
    // fully spent by 09-01 (nothing captured during the gap), so it's attributed there, not to 09-02.
    expect(result.days).toEqual({
      "2026-09-01": 40,
      "2026-09-02": 0,
      "2026-09-03": 0,
      "2026-09-04": 0,
    });
  });

  it("freezes lastUpdated's own day on the very next day's rollover — no gap needed", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-01T18:00:00.000Z", monthlySpent: 21.98 });
    const now = new Date("2026-09-02T09:00:00.000Z");
    const result = rolloverIfNeeded(usage, makeConfig(), now);
    expect(result.days).toEqual({ "2026-09-01": 21.98 });
  });

  it("skips a day already frozen in usage.days", () => {
    const usage = makeUsage({
      lastUpdated: "2026-09-01T12:00:00.000Z",
      monthlySpent: 40,
      days: { "2026-09-02": 15 },
    });
    const now = new Date("2026-09-03T00:00:00.000Z");
    const result = rolloverIfNeeded(usage, makeConfig(), now);
    expect(result.days["2026-09-02"]).toBe(15);
  });

  it("freezes avgPerDay/safeMonthTotal once per UTC day and never touches them again same day", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-01T00:00:00.000Z", monthlySpent: 50 });
    const config = makeConfig();
    const first = rolloverIfNeeded(usage, config, new Date("2026-09-01T01:00:00.000Z"));
    expect(first.frozenForDate).toBe("2026-09-01");
    expect(first.frozenAvgPerDay).not.toBeNull();
    first.monthlySpent = 999; // simulate intra-day captures changing monthlySpent
    const second = rolloverIfNeeded(first, config, new Date("2026-09-01T20:00:00.000Z"));
    expect(second.frozenAvgPerDay).toBe(first.frozenAvgPerDay);
    expect(second.frozenSafeMonthTotal).toBe(first.frozenSafeMonthTotal);
  });

  it("re-freezes on the next UTC day using monthlySpent as it stands at that moment", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-01T00:00:00.000Z", monthlySpent: 50 });
    const config = makeConfig();
    const day1 = rolloverIfNeeded(usage, config, new Date("2026-09-01T01:00:00.000Z"));
    const day1AvgPerDay = day1.frozenAvgPerDay; // rolloverIfNeeded mutates in place — snapshot before day 2
    day1.monthlySpent = 100;
    const day2 = rolloverIfNeeded(day1, config, new Date("2026-09-02T01:00:00.000Z"));
    expect(day2.frozenForDate).toBe("2026-09-02");
    expect(day2.frozenAvgPerDay).not.toBe(day1AvgPerDay);
  });

  it("freezes avgPerDay to null when no laboral days remain this month", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-10T00:00:00.000Z", monthlySpent: 50 });
    const result = rolloverIfNeeded(usage, makeConfig(), new Date("2026-09-11T00:00:00.000Z"));
    expect(result.frozenAvgPerDay).toBeNull();
    expect(result.frozenSafeMonthTotal).toBeNull();
  });
});

describe("captureSessionCost", () => {
  it("captures the full cost as the delta for a brand-new session", () => {
    const usage = makeUsage();
    const now = new Date("2026-09-01T00:00:00.000Z");
    captureSessionCost(usage, "session-a", 5, now, true);
    expect(usage.monthlySpent).toBe(5);
    expect(usage.sessions["session-a"]).toEqual({ lastSeenCost: 5, lastSeenAt: now.toISOString() });
  });

  it("captures only the incremental delta for a rising known session", () => {
    const usage = makeUsage({
      sessions: { "session-a": { lastSeenCost: 5, lastSeenAt: "2026-09-01T00:00:00.000Z" } },
    });
    captureSessionCost(usage, "session-a", 8, new Date("2026-09-01T01:00:00.000Z"), true);
    expect(usage.monthlySpent).toBe(3);
  });

  it("treats a lower cost than last-seen as a fresh baseline, not a negative delta", () => {
    const usage = makeUsage({
      sessions: { "session-a": { lastSeenCost: 10, lastSeenAt: "2026-09-01T00:00:00.000Z" } },
    });
    captureSessionCost(usage, "session-a", 2, new Date("2026-09-01T01:00:00.000Z"), true);
    expect(usage.monthlySpent).toBe(2);
  });

  it("keeps two concurrent sessions independent", () => {
    const usage = makeUsage();
    const now = new Date("2026-09-01T00:00:00.000Z");
    captureSessionCost(usage, "session-a", 5, now, true);
    captureSessionCost(usage, "session-b", 1, now, true);
    captureSessionCost(usage, "session-a", 6, now, true);
    expect(usage.monthlySpent).toBe(5 + 1 + 1);
  });

  it("advances lastSeenCost but skips accumulation when accumulate is false", () => {
    const usage = makeUsage();
    const now = new Date("2026-09-01T00:00:00.000Z");
    captureSessionCost(usage, "session-a", 5, now, false);
    expect(usage.monthlySpent).toBe(0);
    expect(usage.sessions["session-a"]).toEqual({ lastSeenCost: 5, lastSeenAt: now.toISOString() });
  });

  it("charges only the post-resume delta after a non-accumulating span", () => {
    const usage = makeUsage();
    const t1 = new Date("2026-09-01T00:00:00.000Z");
    const t2 = new Date("2026-09-01T01:00:00.000Z");
    captureSessionCost(usage, "session-a", 5, t1, false); // pro-classified span: not charged
    captureSessionCost(usage, "session-a", 9, t2, true); // back to enterprise: only the +4 delta
    expect(usage.monthlySpent).toBe(4);
  });
});

describe("classifyHasSpendCap", () => {
  it("classifies claude_enterprise as a dollar cap", () => {
    expect(classifyHasSpendCap("claude_enterprise")).toBe(true);
  });

  it("classifies claude_pro as a window cap (no dollar tracking)", () => {
    expect(classifyHasSpendCap("claude_pro")).toBe(false);
  });

  it("leaves unknown or null org types unresolved", () => {
    expect(classifyHasSpendCap("claude_max")).toBeUndefined();
    expect(classifyHasSpendCap(null)).toBeUndefined();
  });
});

describe("pruneStaleSessions", () => {
  it("drops sessions untouched for 2+ UTC days and keeps recent ones", () => {
    const usage = makeUsage({
      sessions: {
        stale: { lastSeenCost: 1, lastSeenAt: "2026-09-01T00:00:00.000Z" },
        fresh: { lastSeenCost: 2, lastSeenAt: "2026-09-03T23:00:00.000Z" },
      },
    });
    pruneStaleSessions(usage, new Date("2026-09-04T00:00:00.000Z"));
    expect(usage.sessions).toEqual({
      fresh: { lastSeenCost: 2, lastSeenAt: "2026-09-03T23:00:00.000Z" },
    });
  });
});

describe("computeToday", () => {
  it("computes live figures alongside the frozen avg/safe-total", () => {
    const config = makeConfig();
    const usage = makeUsage({
      monthlySpent: 80.94,
      days: { "2026-09-01": 20, "2026-09-02": 15 },
      frozenForDate: "2026-09-03",
      frozenAvgPerDay: 33.48,
      frozenSafeMonthTotal: 114.42,
    });
    const result = computeToday(usage, config, new Date("2026-09-03T12:00:00.000Z"));
    expect(result.avgPerDay).toBe(33.48);
    expect(result.safeMonthTotal).toBe(114.42);
    expect(result.todayUsage).toBeCloseTo(80.94 - 35, 5);
    expect(result.todayUsedPct).toBeCloseTo(result.todayUsage / 33.48, 5);
    expect(result.monthUsedPct).toBeCloseTo(80.94 / 650, 5);
    expect(result.leftThisMonth).toBeCloseTo(650 - 80.94, 5);
  });

  it("returns a null todayUsedPct when avgPerDay is null", () => {
    const usage = makeUsage({
      frozenForDate: "2026-09-11",
      frozenAvgPerDay: null,
      frozenSafeMonthTotal: null,
    });
    const result = computeToday(usage, makeConfig(), new Date("2026-09-11T00:00:00.000Z"));
    expect(result.todayUsedPct).toBeNull();
  });

  it("returns a null todayUsedPct when the frozen avgPerDay is zero", () => {
    const usage = makeUsage({
      frozenForDate: "2026-09-01",
      frozenAvgPerDay: 0,
      frozenSafeMonthTotal: 0,
    });
    const result = computeToday(usage, makeConfig(), new Date("2026-09-01T00:00:00.000Z"));
    expect(result.todayUsedPct).toBeNull();
  });

  it("treats a zero monthlyCap as 0% used, not a division-by-zero NaN", () => {
    const usage = makeUsage();
    const result = computeToday(
      usage,
      makeConfig({ monthlyCap: 0 }),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(result.monthUsedPct).toBe(0);
  });
});

describe("colorForPct", () => {
  it.each([
    [1, "#F8696B"],
    [0.9, "#F4A460"],
    [0.6, "#FFEB84"],
    [0.3, "#A1D76A"],
    [0, "#63BE7B"],
  ])("maps %f to %s", (pct, color) => {
    expect(colorForPct(pct)).toBe(color);
  });
});

describe("reconcileFromExtraUsageSnapshot", () => {
  it("is a no-op when extraUsage is null", () => {
    const usage = makeUsage({ extraUsageSnapshot: { date: "2026-09-09", usedCredits: 100 } });
    const before = structuredClone(usage);
    reconcileFromExtraUsageSnapshot(usage, null, new Date("2026-09-10T00:00:00.000Z"));
    expect(usage).toEqual(before);
  });

  it("just records the first snapshot when there's no prior one yet", () => {
    const usage = makeUsage();
    reconcileFromExtraUsageSnapshot(
      usage,
      { usedCredits: 162.94 },
      new Date("2026-09-10T00:00:00.000Z"),
    );
    expect(usage.extraUsageSnapshot).toEqual({ date: "2026-09-10", usedCredits: 162.94 });
  });

  it("corrects a prior day's frozen amount from the delta when it disagrees with the self-tracked figure", () => {
    const usage = makeUsage({
      monthlySpent: 100,
      days: { "2026-09-09": 30 }, // self-tracked
      extraUsageSnapshot: { date: "2026-09-09", usedCredits: 133 }, // cumulative as of day 9
    });
    // Cumulative as of day 10: true day-9 spend was 133 -> 138 = $5, not the self-tracked $30
    reconcileFromExtraUsageSnapshot(
      usage,
      { usedCredits: 138 },
      new Date("2026-09-10T00:00:00.000Z"),
    );
    expect(usage.days["2026-09-09"]).toBe(5);
    expect(usage.monthlySpent).toBe(75); // 100 - 30 + 5
    expect(usage.extraUsageSnapshot).toEqual({ date: "2026-09-10", usedCredits: 138 });
  });

  it("leaves an already-agreeing day untouched", () => {
    const usage = makeUsage({
      monthlySpent: 100,
      days: { "2026-09-09": 30 },
      extraUsageSnapshot: { date: "2026-09-09", usedCredits: 133 },
    });
    reconcileFromExtraUsageSnapshot(
      usage,
      { usedCredits: 163 }, // delta is exactly 30, matches self-tracked
      new Date("2026-09-10T00:00:00.000Z"),
    );
    expect(usage.days["2026-09-09"]).toBe(30);
    expect(usage.monthlySpent).toBe(100);
  });

  it("does nothing to the prior day when it was never frozen locally", () => {
    const usage = makeUsage({
      extraUsageSnapshot: { date: "2026-09-09", usedCredits: 133 },
    });
    reconcileFromExtraUsageSnapshot(
      usage,
      { usedCredits: 138 },
      new Date("2026-09-10T00:00:00.000Z"),
    );
    expect(usage.days["2026-09-09"]).toBeUndefined();
  });

  it("doesn't reconcile again within the same UTC day as the snapshot", () => {
    const usage = makeUsage({
      days: { "2026-09-10": 30 },
      extraUsageSnapshot: { date: "2026-09-10", usedCredits: 133 },
    });
    reconcileFromExtraUsageSnapshot(
      usage,
      { usedCredits: 140 },
      new Date("2026-09-10T12:00:00.000Z"),
    );
    expect(usage.days["2026-09-10"]).toBe(30);
    expect(usage.extraUsageSnapshot).toEqual({ date: "2026-09-10", usedCredits: 133 });
  });
});

describe("reconcileLaboralDays", () => {
  it("returns the same config reference when every spent day is already laboral", () => {
    const config = makeConfig();
    const usage = makeUsage({ days: { "2026-09-01": 20 } });
    expect(reconcileLaboralDays(config, usage)).toBe(config);
  });

  it("adds a weekend (or any non-configured) day that has recorded spend", () => {
    const config = makeConfig(); // 2026-09-06 (a Sunday) isn't in the fixture's laboral days
    const usage = makeUsage({ days: { "2026-09-06": 12.5 } });
    const result = reconcileLaboralDays(config, usage);
    expect(result).not.toBe(config);
    expect(result.laboralDays["2026"]?.["9"]).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
  });

  it("merges into an existing month array without duplicating an already-present day", () => {
    const config = makeConfig();
    const usage = makeUsage({ days: { "2026-09-01": 20, "2026-09-06": 12.5 } });
    const result = reconcileLaboralDays(config, usage);
    expect(result.laboralDays["2026"]?.["9"]).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
  });

  it("leaves other months/years untouched and adds a new month key when needed", () => {
    const config = makeConfig({
      laboralDays: { "2026": { "9": [1] }, "2027": { "1": [5] } },
    });
    const usage = makeUsage({ days: { "2026-10-15": 3 } });
    const result = reconcileLaboralDays(config, usage);
    expect(result.laboralDays["2026"]?.["9"]).toEqual([1]);
    expect(result.laboralDays["2027"]).toEqual({ "1": [5] });
    expect(result.laboralDays["2026"]?.["10"]).toEqual([15]);
  });
});
