import { describe, expect, it } from "vitest";

import {
  applyLedgerReading,
  captureSessionCost,
  classifyHasSpendCap,
  colorForPct,
  computeAvgPerDay,
  computeRealAvgPerDay,
  computeToday,
  getLaboralDays,
  isLaboralDay,
  paceLabel,
  pruneStaleSessions,
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

describe("isLaboralDay", () => {
  it("is true when the UTC day-of-month is in laboralDays", () => {
    expect(isLaboralDay(makeConfig(), new Date("2026-09-03T12:00:00.000Z"))).toBe(true);
  });

  it("is false on a non-laboral UTC day", () => {
    expect(isLaboralDay(makeConfig(), new Date("2026-09-05T12:00:00.000Z"))).toBe(false);
  });
});

describe("computeAvgPerDay", () => {
  it("splits the cap evenly over all laboral days on day 1", () => {
    expect(computeAvgPerDay(makeConfig(), makeUsage(), new Date("2026-09-01T00:00:00.000Z"))).toBe(
      81.25,
    );
  });

  it("re-splits the remaining budget over the laboral days from today onward", () => {
    const usage = makeUsage({ days: { "2026-09-01": 20, "2026-09-02": 15 } });
    // (650 - 35) / 6 laboral days from day 3 = 102.5
    expect(computeAvgPerDay(makeConfig(), usage, new Date("2026-09-03T12:00:00.000Z"))).toBe(102.5);
  });

  it("is not affected by today's own spend", () => {
    const usage = makeUsage({ monthlySpent: 500 });
    expect(computeAvgPerDay(makeConfig(), usage, new Date("2026-09-01T12:00:00.000Z"))).toBe(81.25);
  });

  it("follows a monthlyCap change at once", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    expect(computeAvgPerDay(makeConfig({ monthlyCap: 800 }), makeUsage(), now)).toBe(100);
  });

  it("lets weekend spend lower the next laboral day's max", () => {
    const usage = makeUsage({ days: { "2026-09-04": 0, "2026-09-05": 100 } });
    // Mon 7 Sep: (650 - 100) / 4 laboral days from 7 = 137.5
    expect(computeAvgPerDay(makeConfig(), usage, new Date("2026-09-07T00:00:00.000Z"))).toBe(137.5);
  });

  it("ignores days of other months", () => {
    const usage = makeUsage({ days: { "2026-08-31": 500 } });
    expect(computeAvgPerDay(makeConfig(), usage, new Date("2026-09-01T00:00:00.000Z"))).toBe(81.25);
  });

  it("returns 0 once the budget is spent", () => {
    const usage = makeUsage({ days: { "2026-09-01": 700 } });
    expect(computeAvgPerDay(makeConfig(), usage, new Date("2026-09-02T00:00:00.000Z"))).toBe(0);
  });

  it("returns null when no laboral day remains", () => {
    expect(
      computeAvgPerDay(makeConfig(), makeUsage(), new Date("2026-09-11T00:00:00.000Z")),
    ).toBeNull();
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
    const result = rolloverIfNeeded(usage, now);
    expect(result.days).toEqual({});
    expect(result.lastUpdated).toBe(now.toISOString());
  });

  it("freezes every missed day in a multi-day gap, laboral or not", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-01T12:00:00.000Z", monthlySpent: 40 });
    const now = new Date("2026-09-05T00:00:00.000Z");
    const result = rolloverIfNeeded(usage, now);
    // walk covers 09-01 (lastUpdated's own day) through 09-04. The $40 was fully spent by 09-01 (nothing
    // captured during the gap), so it's attributed there, not to 09-02.
    expect(result.days).toEqual({
      "2026-09-01": 40,
      "2026-09-02": 0,
      "2026-09-03": 0,
      "2026-09-04": 0,
    });
  });

  it("freezes a non-laboral day with its own real spend, without promoting it to laboral", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-06T00:00:00.000Z", monthlySpent: 12.5 });
    const now = new Date("2026-09-07T00:00:00.000Z");
    const result = rolloverIfNeeded(usage, now);
    expect(result.days).toEqual({ "2026-09-06": 12.5 });
  });

  it("resets monthlySpent to 0 the moment the walk crosses a calendar-month boundary", () => {
    const usage = makeUsage({ lastUpdated: "2026-08-30T00:00:00.000Z", monthlySpent: 100 });
    const now = new Date("2026-09-02T00:00:00.000Z");
    const result = rolloverIfNeeded(usage, now);
    // 08-30 and 08-31 still belong to August — frozen from the pre-reset $100 total (nothing else recorded
    // that month), then the reset fires crossing into September, so 09-01 starts fresh at $0.
    expect(result.days).toEqual({
      "2026-08-30": 100,
      "2026-08-31": 0,
      "2026-09-01": 0,
    });
    expect(result.monthlySpent).toBe(0);
    expect(result.ledgerBaseline).toBe(0);
  });

  it("takes the last ledger reading as the new baseline at a month boundary", () => {
    const usage = makeUsage({
      lastUpdated: "2026-09-30T20:00:00.000Z",
      monthlySpent: 777,
      extraUsageCache: {
        fetchedAt: 0,
        data: {
          usedCredits: 777.04,
          monthlyLimit: 800,
          utilizationPct: 97,
          currency: "USD",
          spendLimitReached: false,
          disabledReason: null,
        },
      },
    });
    const result = rolloverIfNeeded(usage, new Date("2026-10-01T00:00:00.000Z"));
    expect(result.ledgerBaseline).toBe(777.04);
    expect(result.monthlySpent).toBe(0);
  });

  it("keeps accumulating within the same month without resetting", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-01T00:00:00.000Z", monthlySpent: 40 });
    const now = new Date("2026-09-03T00:00:00.000Z");
    const result = rolloverIfNeeded(usage, now);
    expect(result.monthlySpent).toBe(40);
    expect(result.ledgerBaseline).toBeUndefined();
  });

  it("freezes lastUpdated's own day on the very next day's rollover — no gap needed", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-01T18:00:00.000Z", monthlySpent: 21.98 });
    const now = new Date("2026-09-02T09:00:00.000Z");
    const result = rolloverIfNeeded(usage, now);
    expect(result.days).toEqual({ "2026-09-01": 21.98 });
  });

  it("skips a day already frozen in usage.days", () => {
    const usage = makeUsage({
      lastUpdated: "2026-09-01T12:00:00.000Z",
      monthlySpent: 40,
      days: { "2026-09-02": 15 },
    });
    const now = new Date("2026-09-03T00:00:00.000Z");
    const result = rolloverIfNeeded(usage, now);
    expect(result.days["2026-09-02"]).toBe(15);
  });
});

describe("applyLedgerReading", () => {
  it("sets monthlySpent to the reading when there is no baseline", () => {
    const usage = makeUsage();
    applyLedgerReading(usage, 120.5, new Date("2026-09-15T00:00:00.000Z"));
    expect(usage.monthlySpent).toBe(120.5);
    expect(usage.ledgerBaseline).toBe(0);
  });

  it("subtracts the baseline when the ledger did not reset", () => {
    const usage = makeUsage({ ledgerBaseline: 777 });
    applyLedgerReading(usage, 780, new Date("2026-09-15T00:00:00.000Z"));
    expect(usage.monthlySpent).toBe(3);
    expect(usage.ledgerBaseline).toBe(777);
  });

  it("drops the baseline when the reading falls below it (ledger reset)", () => {
    const usage = makeUsage({ ledgerBaseline: 777 });
    applyLedgerReading(usage, 5, new Date("2026-09-15T00:00:00.000Z"));
    expect(usage.monthlySpent).toBe(5);
    expect(usage.ledgerBaseline).toBe(0);
  });

  it("scales this month's frozen days down when the ledger is below their sum, leaving other months", () => {
    const now = new Date("2026-09-03T10:00:00.000Z");
    const usage = makeUsage({
      days: { "2026-08-31": 500, "2026-09-01": 40, "2026-09-02": 60 },
    });
    applyLedgerReading(usage, 50, now);
    expect(usage.days["2026-09-01"]).toBeCloseTo(20);
    expect(usage.days["2026-09-02"]).toBeCloseTo(30);
    expect(usage.days["2026-08-31"]).toBe(500);
    expect(computeToday(usage, makeConfig(), now).todayUsage).toBeCloseTo(0);
    applyLedgerReading(usage, 55, now);
    expect(computeToday(usage, makeConfig(), now).todayUsage).toBeCloseTo(5);
  });

  it("keeps frozen days when the ledger is at or above their sum", () => {
    const usage = makeUsage({ days: { "2026-09-01": 40 } });
    applyLedgerReading(usage, 50, new Date("2026-09-03T10:00:00.000Z"));
    expect(usage.days).toEqual({ "2026-09-01": 40 });
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
  it("classifies claude_enterprise and claude_team as dollar-budget accounts", () => {
    expect(classifyHasSpendCap("claude_enterprise")).toBe(true);
    expect(classifyHasSpendCap("claude_team")).toBe(true);
  });

  it("classifies claude_pro and claude_max as no dollar self-budget", () => {
    expect(classifyHasSpendCap("claude_pro")).toBe(false);
    expect(classifyHasSpendCap("claude_max")).toBe(false);
  });

  it("leaves unknown or null org types unresolved", () => {
    expect(classifyHasSpendCap("something_else")).toBeUndefined();
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
  it("computes live figures alongside the derived avg/safe-total", () => {
    const config = makeConfig();
    const usage = makeUsage({
      monthlySpent: 80.94,
      days: { "2026-09-01": 20, "2026-09-02": 15 },
    });
    const result = computeToday(usage, config, new Date("2026-09-03T12:00:00.000Z"));
    expect(result.avgPerDay).toBe(102.5);
    expect(result.safeMonthTotal).toBe(137.5); // 35 before today + 102.5
    expect(result.todayUsage).toBeCloseTo(80.94 - 35, 5);
    expect(result.todayUsedPct).toBeCloseTo(result.todayUsage / 102.5, 5);
    expect(result.monthUsedPct).toBeCloseTo(80.94 / 650, 5);
    expect(result.leftThisMonth).toBeCloseTo(650 - 80.94, 5);
    expect(result.paceLabel).toBe(paceLabel(result.todayUsedPct));
  });

  it("returns a null todayUsedPct when avgPerDay is null", () => {
    const result = computeToday(makeUsage(), makeConfig(), new Date("2026-09-11T00:00:00.000Z"));
    expect(result.avgPerDay).toBeNull();
    expect(result.safeMonthTotal).toBeNull();
    expect(result.todayUsedPct).toBeNull();
    expect(result.paceLabel).toBeNull();
  });

  it("returns a null todayUsedPct when the budget is exhausted (avgPerDay 0)", () => {
    const usage = makeUsage({ monthlySpent: 700, days: { "2026-09-01": 700 } });
    const result = computeToday(usage, makeConfig(), new Date("2026-09-02T00:00:00.000Z"));
    expect(result.avgPerDay).toBe(0);
    expect(result.todayUsedPct).toBeNull();
    expect(result.paceLabel).toBeNull();
  });

  it("derives monthDay0AvgPerDay as cap / laboral days, null without laboral days", () => {
    const usage = makeUsage();
    expect(
      computeToday(usage, makeConfig(), new Date("2026-09-03T00:00:00.000Z")).monthDay0AvgPerDay,
    ).toBe(81.25);
    expect(
      computeToday(usage, makeConfig(), new Date("2026-10-01T00:00:00.000Z")).monthDay0AvgPerDay,
    ).toBeNull();
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

describe("paceLabel", () => {
  it("maps each band and null", () => {
    expect(paceLabel(null)).toBeNull();
    expect(paceLabel(0)).toBe("Coast");
    expect(paceLabel(0.25)).toBe("Coast");
    expect(paceLabel(0.26)).toBe("Ahead");
    expect(paceLabel(0.5)).toBe("Ahead");
    expect(paceLabel(0.51)).toBe("Steady");
    expect(paceLabel(0.75)).toBe("Steady");
    expect(paceLabel(0.76)).toBe("On pace");
    expect(paceLabel(1)).toBe("On pace");
    expect(paceLabel(1.01)).toBe("Hot");
    expect(paceLabel(1.5)).toBe("Hot");
    expect(paceLabel(1.51)).toBe("Over");
    expect(paceLabel(2)).toBe("Over");
    expect(paceLabel(2.01)).toBe("Burn");
  });
});

describe("computeRealAvgPerDay", () => {
  it("divides monthlySpent by elapsed laboral days through today", () => {
    // laboral: 1,2,3,4,7,8,9,10 — through day 3 → 3 days; 90/3 = 30
    expect(computeRealAvgPerDay(makeConfig(), 90, new Date("2026-09-03T12:00:00.000Z"))).toBe(30);
  });

  it("returns null when no laboral day has elapsed yet", () => {
    expect(
      computeRealAvgPerDay(
        makeConfig({ laboralDays: { "2026": { "9": [10, 11] } } }),
        50,
        new Date("2026-09-03T12:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("counts only laboral days <= today (weekend spend raises avg without growing divisor)", () => {
    // through Sunday 6 Sep: laboral <=6 are 1,2,3,4 → 4 days; 100/4 = 25
    expect(computeRealAvgPerDay(makeConfig(), 100, new Date("2026-09-06T12:00:00.000Z"))).toBe(25);
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
