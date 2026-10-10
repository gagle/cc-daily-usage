import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyLedgerReading,
  captureSessionCost,
  classifyHasSpendCap,
  colorForPct,
  computeAvgPerDay,
  computeRealAvgPerDay,
  computeToday,
  freshUsage,
  getLaboralDays,
  isLaboralDay,
  paceLabel,
  pruneStaleSessions,
  rolloverIfNeeded,
  upgradeUsage,
  USAGE_SCHEMA_VERSION,
  utcDateString,
} from "./calc.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";

const OCTOBER = [1, 2, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30];

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    monthlyCap: 650,
    laboralDays: { "2026": { "9": [1, 2, 3, 4, 7, 8, 9, 10], "10": OCTOBER } },
    ...overrides,
  };
}

function makeUsage(overrides: Partial<UsageState> = {}): UsageState {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    monthlySpent: 0,
    periodFrozen: 0,
    lastUpdated: "2026-09-01T00:00:00.000Z",
    days: {},
    sessions: {},
    ...overrides,
  };
}

const at = (iso: string): Date => new Date(iso);

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("laboral days", () => {
  it("getLaboralDays reads one month, [] when absent", () => {
    expect(getLaboralDays(makeConfig(), 2026, 9)).toEqual([1, 2, 3, 4, 7, 8, 9, 10]);
    expect(getLaboralDays(makeConfig(), 2027, 1)).toEqual([]);
    expect(getLaboralDays(makeConfig(), 2026, 11)).toEqual([]);
  });

  it("isLaboralDay uses the LOCAL date", () => {
    vi.stubEnv("TZ", "Europe/Madrid");
    // 23:30Z Sep 30 is Oct 1 01:30 in Madrid — laboral there, though Sep 30 is not configured.
    expect(isLaboralDay(makeConfig(), at("2026-09-30T23:30:00.000Z"))).toBe(true);
    expect(isLaboralDay(makeConfig(), at("2026-10-03T12:00:00.000Z"))).toBe(false);
  });

  it("utcDateString is the UTC date", () => {
    expect(utcDateString(at("2026-09-30T23:30:00.000Z"))).toBe("2026-09-30");
  });
});

describe("freshUsage / upgradeUsage", () => {
  it("a fresh file starts at now, so the first rollover walks nothing", () => {
    const now = at("2026-10-10T08:00:00.000Z");
    const usage = freshUsage(now);
    expect(usage).toEqual({
      schemaVersion: USAGE_SCHEMA_VERSION,
      monthlySpent: 0,
      periodFrozen: 0,
      lastUpdated: now.toISOString(),
      days: {},
      sessions: {},
    });
    const started = performance.now();
    rolloverIfNeeded(usage, now, null);
    expect(performance.now() - started).toBeLessThan(5);
    expect(usage.days).toEqual({});
  });

  it("derives periodFrozen from v1 data (days before lastUpdated's UTC day, same UTC month)", () => {
    const usage = upgradeUsage(
      {
        monthlySpent: 40,
        lastUpdated: "2026-10-05T10:00:00.000Z",
        days: { "2026-09-30": 99, "2026-10-01": 10, "2026-10-02": 5, "2026-10-05": 3 },
        sessions: {},
      },
      at("2026-10-05T11:00:00.000Z"),
    );
    expect(usage.periodFrozen).toBe(15);
    expect(usage.schemaVersion).toBe(USAGE_SCHEMA_VERSION);
  });

  it("keeps an existing periodFrozen", () => {
    const usage = upgradeUsage(makeUsage({ periodFrozen: 7 }), at("2026-10-05T11:00:00.000Z"));
    expect(usage.periodFrozen).toBe(7);
  });

  it("repairs missing/garbled fields instead of walking from 1970", () => {
    const now = at("2026-10-05T11:00:00.000Z");
    const usage = upgradeUsage({ lastUpdated: "not a date", monthlySpent: Number.NaN }, now);
    expect(usage.lastUpdated).toBe(now.toISOString());
    expect(usage.days).toEqual({});
    expect(usage.sessions).toEqual({});
    expect(usage.monthlySpent).toBe(0);
    expect(usage.periodFrozen).toBe(0);
  });

  it("pulls a future lastUpdated (clock skew) back to now", () => {
    const now = at("2026-10-05T11:00:00.000Z");
    const usage = upgradeUsage(makeUsage({ lastUpdated: "2027-01-01T00:00:00.000Z" }), now);
    expect(usage.lastUpdated).toBe(now.toISOString());
  });

  it("treats a missing lastUpdated as now", () => {
    const now = at("2026-10-05T11:00:00.000Z");
    expect(upgradeUsage({ monthlySpent: 1, days: {}, sessions: {} }, now).lastUpdated).toBe(
      now.toISOString(),
    );
  });
});

describe("computeAvgPerDay", () => {
  it("day 1 splits the whole cap over every laboral day", () => {
    expect(computeAvgPerDay(makeConfig(), makeUsage(), at("2026-09-01T09:00:00.000Z"))).toBe(81.25);
  });

  it("re-splits what is left over the laboral days from today on", () => {
    // (650 - 35) / 6 laboral days from Sep 3 = 102.5
    const usage = makeUsage({ periodFrozen: 35, monthlySpent: 35 });
    expect(computeAvgPerDay(makeConfig(), usage, at("2026-09-03T12:00:00.000Z"))).toBe(102.5);
  });

  it("is not affected by today's own spend", () => {
    const usage = makeUsage({ monthlySpent: 500 });
    expect(computeAvgPerDay(makeConfig(), usage, at("2026-09-01T12:00:00.000Z"))).toBe(81.25);
  });

  it("follows a monthlyCap change at once (admin raised the limit mid-month)", () => {
    const usage = makeUsage({ periodFrozen: 35, monthlySpent: 40 });
    const now = at("2026-09-03T12:00:00.000Z");
    expect(computeAvgPerDay(makeConfig({ monthlyCap: 800 }), usage, now)).toBe(127.5);
  });

  it("0 when the cap was lowered below what is already spent", () => {
    const usage = makeUsage({ periodFrozen: 300, monthlySpent: 300 });
    expect(
      computeAvgPerDay(makeConfig({ monthlyCap: 200 }), usage, at("2026-09-03T12:00:00.000Z")),
    ).toBe(0);
  });

  it("removing a future laboral day re-splits the same remainder evenly over fewer days", () => {
    const now = at("2026-09-03T12:00:00.000Z");
    const usage = makeUsage({ periodFrozen: 35, monthlySpent: 35 });
    const holiday = makeConfig({ laboralDays: { "2026": { "9": [1, 2, 3, 4, 7, 9, 10] } } });
    expect(computeAvgPerDay(holiday, usage, now)).toBe(123); // 615 / 5
  });

  it("removing today drops it from the count; the remainder moves to the next days", () => {
    const now = at("2026-09-03T12:00:00.000Z");
    const usage = makeUsage({ periodFrozen: 35, monthlySpent: 35 });
    const offToday = makeConfig({ laboralDays: { "2026": { "9": [1, 2, 4, 7, 8, 9, 10] } } });
    expect(computeAvgPerDay(offToday, usage, now)).toBe(123);
    expect(isLaboralDay(offToday, now)).toBe(false);
  });

  it("null when no laboral day remains in the period", () => {
    expect(computeAvgPerDay(makeConfig(), makeUsage(), at("2026-09-20T12:00:00.000Z"))).toBeNull();
    expect(
      computeAvgPerDay(
        makeConfig({ laboralDays: {} }),
        makeUsage(),
        at("2026-09-01T00:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("UTC+ zone before the UTC edge: local day is already next month → none remain in this period", () => {
    vi.stubEnv("TZ", "Europe/Madrid");
    expect(computeAvgPerDay(makeConfig(), makeUsage(), at("2026-09-30T23:00:00.000Z"))).toBeNull();
  });

  it("UTC− zone after the UTC edge: still last month locally → the whole new period is ahead", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    // Oct 1 01:00Z = Sep 30 18:00 PDT, period October: 650 / 22 laboral days.
    expect(computeAvgPerDay(makeConfig(), makeUsage(), at("2026-10-01T01:00:00.000Z"))).toBe(29.55);
  });
});

describe("computeRealAvgPerDay", () => {
  it("null before the first laboral day of the period", () => {
    const config = makeConfig({ laboralDays: { "2026": { "9": [7, 8] } } });
    expect(computeRealAvgPerDay(config, 10, at("2026-09-03T12:00:00.000Z"))).toBeNull();
  });

  it("monthlySpent ÷ laboral days reached, rounded to the cent", () => {
    expect(computeRealAvgPerDay(makeConfig(), 100, at("2026-09-03T12:00:00.000Z"))).toBe(33.33);
  });

  it("local month before the period → none reached; after → all reached", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(computeRealAvgPerDay(makeConfig(), 10, at("2026-10-01T01:00:00.000Z"))).toBeNull();
    vi.stubEnv("TZ", "Europe/Madrid");
    expect(computeRealAvgPerDay(makeConfig(), 80, at("2026-09-30T23:00:00.000Z"))).toBe(10);
  });
});

describe("rolloverIfNeeded", () => {
  it("same local day: no-op, lastUpdated untouched (lets saveUsage skip the write)", () => {
    const usage = makeUsage({ monthlySpent: 12, lastUpdated: "2026-09-03T08:00:00.000Z" });
    rolloverIfNeeded(usage, at("2026-09-03T20:00:00.000Z"), null);
    expect(usage.days).toEqual({});
    expect(usage.lastUpdated).toBe("2026-09-03T08:00:00.000Z");
  });

  it("local midnight freezes the pending spend into lastUpdated's day", () => {
    const usage = makeUsage({
      monthlySpent: 30,
      periodFrozen: 10,
      lastUpdated: "2026-09-03T20:00:00.000Z",
    });
    const now = at("2026-09-04T07:00:00.000Z");
    rolloverIfNeeded(usage, now, null);
    expect(usage.days).toEqual({ "2026-09-03": 20 });
    expect(usage.periodFrozen).toBe(30);
    expect(usage.lastUpdated).toBe(now.toISOString());
  });

  it("a multi-day gap books everything on the last active day and leaves the gap absent", () => {
    const usage = makeUsage({ monthlySpent: 8, lastUpdated: "2026-09-03T20:00:00.000Z" });
    rolloverIfNeeded(usage, at("2026-09-09T07:00:00.000Z"), null);
    expect(usage.days).toEqual({ "2026-09-03": 8 });
  });

  it("adds to a day that already holds an edge booking", () => {
    const usage = makeUsage({
      monthlySpent: 5,
      lastUpdated: "2026-10-01T10:00:00.000Z",
      days: { "2026-10-01": 2 },
    });
    rolloverIfNeeded(usage, at("2026-10-02T08:00:00.000Z"), null);
    expect(usage.days["2026-10-01"]).toBe(7);
  });

  it("UTC machine: midnight and edge coincide — the day freezes into the old period, then reset", () => {
    const usage = makeUsage({
      monthlySpent: 90,
      periodFrozen: 60,
      lastUpdated: "2026-09-30T18:00:00.000Z",
    });
    rolloverIfNeeded(usage, at("2026-10-01T06:00:00.000Z"), 123);
    expect(usage.days).toEqual({ "2026-09-30": 30 });
    expect(usage.monthlySpent).toBe(0);
    expect(usage.periodFrozen).toBe(0);
    expect(usage.ledgerBaseline).toBe(123);
  });

  it("no ledger reading at the edge → baseline 0", () => {
    const usage = makeUsage({ lastUpdated: "2026-09-30T18:00:00.000Z" });
    rolloverIfNeeded(usage, at("2026-10-01T06:00:00.000Z"), null);
    expect(usage.ledgerBaseline).toBe(0);
  });

  it("Madrid: local midnight comes 2h before the UTC edge", () => {
    vi.stubEnv("TZ", "Europe/Madrid");
    // Sep 30 21:00 local: 50 spent this period, 40 frozen.
    const usage = makeUsage({
      monthlySpent: 50,
      periodFrozen: 40,
      lastUpdated: "2026-09-30T19:00:00.000Z",
    });
    // 01:00 local Oct 1 (still September in UTC): Sep 30 freezes, period continues.
    rolloverIfNeeded(usage, at("2026-09-30T23:00:00.000Z"), null);
    expect(usage.days).toEqual({ "2026-09-30": 10 });
    expect(usage.periodFrozen).toBe(50);
    // 3 more dollars spent 01:00-02:00 local, still billed to September by Anthropic.
    usage.monthlySpent = 53;
    rolloverIfNeeded(usage, at("2026-10-01T01:00:00.000Z"), 400);
    expect(usage.days).toEqual({ "2026-09-30": 10, "2026-10-01": 3 });
    expect(usage.monthlySpent).toBe(0);
    expect(usage.periodFrozen).toBe(0);
    // Today (Oct 1 local) still shows those 3 dollars plus new-period spend.
    usage.monthlySpent = 4;
    expect(computeToday(usage, makeConfig(), at("2026-10-01T08:00:00.000Z")).todayUsage).toBe(7);
  });

  it("Los Angeles: the UTC edge comes at 17:00 local, the evening counts against the new period", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const usage = makeUsage({
      monthlySpent: 60,
      periodFrozen: 50,
      lastUpdated: "2026-09-30T20:00:00.000Z",
    });
    // 17:30 local Sep 30 = Oct 1 00:30Z: the edge books Sep's pending 10 on Sep 30, then resets.
    rolloverIfNeeded(usage, at("2026-10-01T00:30:00.000Z"), 400);
    expect(usage.days).toEqual({ "2026-09-30": 10 });
    expect(usage.monthlySpent).toBe(0);
    // Evening spend in the October period.
    usage.monthlySpent = 6;
    rolloverIfNeeded(usage, at("2026-10-01T08:00:00.000Z"), 406); // Oct 1 01:00 local
    expect(usage.days).toEqual({ "2026-09-30": 16 });
    expect(usage.periodFrozen).toBe(6); // the evening is October's money
  });

  it("long gap across several months: one booking, one reset", () => {
    const usage = makeUsage({ monthlySpent: 9, lastUpdated: "2026-07-15T10:00:00.000Z" });
    rolloverIfNeeded(usage, at("2026-10-10T10:00:00.000Z"), 5);
    expect(usage.days).toEqual({ "2026-07-15": 9 });
    expect(usage.monthlySpent).toBe(0);
    expect(usage.ledgerBaseline).toBe(5);
  });

  it("edge with nothing pending books nothing", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const usage = makeUsage({
      monthlySpent: 50,
      periodFrozen: 50,
      lastUpdated: "2026-09-30T20:00:00.000Z",
    });
    rolloverIfNeeded(usage, at("2026-10-01T00:30:00.000Z"), null);
    expect(usage.days).toEqual({});
  });
});

describe("applyLedgerReading", () => {
  it("monthlySpent = used - baseline", () => {
    const usage = makeUsage({ ledgerBaseline: 100 });
    applyLedgerReading(usage, 130, at("2026-09-05T10:00:00.000Z"));
    expect(usage.monthlySpent).toBe(30);
  });

  it("a reading under the baseline means the ledger reset — baseline drops to 0", () => {
    const usage = makeUsage({ ledgerBaseline: 100 });
    applyLedgerReading(usage, 4, at("2026-09-05T10:00:00.000Z"));
    expect(usage.ledgerBaseline).toBe(0);
    expect(usage.monthlySpent).toBe(4);
  });

  it("no baseline yet → the whole reading (fresh install mid-month with existing spend)", () => {
    const usage = makeUsage();
    applyLedgerReading(usage, 212.5, at("2026-09-15T10:00:00.000Z"));
    expect(usage.monthlySpent).toBe(212.5);
    expect(usage.ledgerBaseline).toBe(0);
  });

  it("scales over-counted frozen days of this period down to the ledger", () => {
    const usage = makeUsage({
      periodFrozen: 40,
      days: { "2026-08-31": 50, "2026-09-01": 30, "2026-09-02": 10, "2026-09-03": 1 },
    });
    applyLedgerReading(usage, 20, at("2026-09-03T10:00:00.000Z"));
    expect(usage.days).toEqual({
      "2026-08-31": 50,
      "2026-09-01": 15,
      "2026-09-02": 5,
      "2026-09-03": 1,
    });
    expect(usage.periodFrozen).toBe(20);
  });

  it("leaves days alone when the ledger covers them", () => {
    const usage = makeUsage({ periodFrozen: 10, days: { "2026-09-01": 10 } });
    applyLedgerReading(usage, 25, at("2026-09-03T10:00:00.000Z"));
    expect(usage.days).toEqual({ "2026-09-01": 10 });
  });
});

describe("captureSessionCost", () => {
  const now = at("2026-09-03T10:00:00.000Z");

  it("first sight counts the whole cost; later calls count the delta", () => {
    const usage = makeUsage();
    captureSessionCost(usage, "a", 2, now, true);
    captureSessionCost(usage, "a", 3.5, at("2026-09-03T10:01:00.000Z"), true);
    expect(usage.monthlySpent).toBe(3.5);
  });

  it("a lower cost is a reset (/clear), not a negative delta", () => {
    const usage = makeUsage({
      monthlySpent: 5,
      sessions: { a: { lastSeenCost: 5, lastSeenAt: now.toISOString() } },
    });
    captureSessionCost(usage, "a", 1, now, true);
    expect(usage.monthlySpent).toBe(6);
  });

  it("accumulate=false still advances the baseline", () => {
    const usage = makeUsage();
    captureSessionCost(usage, "a", 2, now, false);
    expect(usage.monthlySpent).toBe(0);
    expect(usage.sessions.a?.lastSeenCost).toBe(2);
  });

  it("an unchanged cost touches lastSeenAt at most hourly, and keeps cacheMissUsd", () => {
    const usage = makeUsage({
      sessions: { a: { lastSeenCost: 2, lastSeenAt: now.toISOString(), cacheMissUsd: 0.4 } },
    });
    captureSessionCost(usage, "a", 2, at("2026-09-03T10:30:00.000Z"), true);
    expect(usage.sessions.a?.lastSeenAt).toBe(now.toISOString());
    captureSessionCost(usage, "a", 2, at("2026-09-03T11:00:00.000Z"), true);
    expect(usage.sessions.a).toEqual({
      lastSeenCost: 2,
      lastSeenAt: "2026-09-03T11:00:00.000Z",
      cacheMissUsd: 0.4,
    });
  });
});

describe("pruneStaleSessions", () => {
  it("drops sessions idle for 2+ days and keeps the object when nothing changes", () => {
    const usage = makeUsage({
      sessions: {
        old: { lastSeenCost: 1, lastSeenAt: "2026-09-01T00:00:00.000Z" },
        bad: { lastSeenCost: 1, lastSeenAt: "garbage" },
        fresh: { lastSeenCost: 1, lastSeenAt: "2026-09-03T00:00:00.000Z" },
      },
    });
    pruneStaleSessions(usage, at("2026-09-03T10:00:00.000Z"));
    expect(Object.keys(usage.sessions)).toEqual(["fresh"]);
    const sessions = usage.sessions;
    pruneStaleSessions(usage, at("2026-09-03T10:00:00.000Z"));
    expect(usage.sessions).toBe(sessions);
  });
});

describe("classifyHasSpendCap", () => {
  it.each([
    ["claude_enterprise", true],
    ["claude_team", true],
    ["claude_pro", false],
    ["claude_max", false],
    ["something_new", undefined],
    [null, undefined],
  ])("%s → %s", (org, expected) => {
    expect(classifyHasSpendCap(org)).toBe(expected);
  });
});

describe("paceLabel", () => {
  it.each([
    [null, null],
    [0.2, "Coast"],
    [0.5, "Ahead"],
    [0.7, "Steady"],
    [1, "On pace"],
    [1.4, "Hot"],
    [2, "Over"],
    [2.5, "Burn"],
  ])("%s → %s", (pct, label) => {
    expect(paceLabel(pct)).toBe(label);
  });
});

describe("computeToday", () => {
  it("live today = pending spend; pace against today's max", () => {
    const usage = makeUsage({ monthlySpent: 75, periodFrozen: 35 });
    const computed = computeToday(usage, makeConfig(), at("2026-09-03T12:00:00.000Z"));
    expect(computed).toEqual({
      monthlyCap: 650,
      monthlySpent: 75,
      leftThisMonth: 575,
      avgPerDay: 102.5,
      safeMonthTotal: 137.5,
      todayUsage: 40,
      todayUsedPct: 40 / 102.5,
      monthUsedPct: 75 / 650,
      paceLabel: "Ahead",
      monthDay0AvgPerDay: 81.25,
      realAvgPerDay: 25,
    });
  });

  it("no pace when no day remains or the budget is spent; cap 0 → 0%", () => {
    const after = computeToday(makeUsage(), makeConfig(), at("2026-09-20T12:00:00.000Z"));
    expect(after.avgPerDay).toBeNull();
    expect(after.safeMonthTotal).toBeNull();
    expect(after.todayUsedPct).toBeNull();
    const zero = computeToday(
      makeUsage({ periodFrozen: 10, monthlySpent: 10 }),
      makeConfig({ monthlyCap: 0 }),
      at("2026-09-03T12:00:00.000Z"),
    );
    expect(zero.avgPerDay).toBe(0);
    expect(zero.todayUsedPct).toBeNull();
    expect(zero.monthUsedPct).toBe(0);
    expect(zero.leftThisMonth).toBe(0);
  });

  it("never reports negative pending spend", () => {
    const computed = computeToday(
      makeUsage({ monthlySpent: 5, periodFrozen: 9 }),
      makeConfig(),
      at("2026-09-03T12:00:00.000Z"),
    );
    expect(computed.todayUsage).toBe(0);
  });
});

describe("colorForPct", () => {
  it.each([
    [0, "#63BE7B"],
    [0.3, "#A1D76A"],
    [0.6, "#FFEB84"],
    [0.8, "#F4A460"],
    [1.2, "#F8696B"],
  ])("%s → %s", (pct, color) => {
    expect(colorForPct(pct)).toBe(color);
  });
});
