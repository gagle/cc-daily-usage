import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compareYearMonth,
  daysInMonth,
  localDateKey,
  localYearMonth,
  nextLocalMidnight,
  nextUtcMonthStart,
  nextYearMonth,
  utcPeriod,
  weekdaysOf,
  yearMonthKey,
} from "./clock.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clock.ts", () => {
  it("localDateKey follows the process time zone, utcPeriod does not", () => {
    const instant = new Date("2026-09-30T22:30:00.000Z");
    vi.stubEnv("TZ", "Europe/Madrid");
    expect(localDateKey(instant)).toBe("2026-10-01");
    expect(localYearMonth(instant)).toEqual({ year: 2026, month: 10 });
    expect(utcPeriod(instant)).toEqual({ year: 2026, month: 9 });
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(localDateKey(instant)).toBe("2026-09-30");
  });

  it("yearMonthKey pads, compareYearMonth orders across years", () => {
    expect(yearMonthKey({ year: 2026, month: 3 })).toBe("2026-03");
    expect(compareYearMonth({ year: 2026, month: 12 }, { year: 2027, month: 1 })).toBeLessThan(0);
    expect(compareYearMonth({ year: 2027, month: 1 }, { year: 2027, month: 1 })).toBe(0);
    expect(compareYearMonth({ year: 2027, month: 2 }, { year: 2027, month: 1 })).toBeGreaterThan(0);
  });

  it("nextLocalMidnight handles 25h and 23h DST days", () => {
    vi.stubEnv("TZ", "Europe/Madrid");
    const fallBack = nextLocalMidnight(new Date("2026-10-25T10:00:00.000Z"));
    expect(fallBack.toISOString()).toBe("2026-10-25T23:00:00.000Z"); // Oct 26 00:00 CET (+1)
    const spring = nextLocalMidnight(new Date("2026-03-29T10:00:00.000Z"));
    expect(spring.toISOString()).toBe("2026-03-29T22:00:00.000Z"); // Mar 30 00:00 CEST (+2)
  });

  it("nextUtcMonthStart rolls over December", () => {
    expect(nextUtcMonthStart(new Date("2026-12-31T23:59:59.000Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("daysInMonth knows leap years", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 10)).toBe(31);
  });

  it("weekdaysOf lists Monday-Friday", () => {
    expect(weekdaysOf(2026, 2)).toEqual([
      2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27,
    ]);
  });

  it("nextYearMonth wraps December", () => {
    expect(nextYearMonth({ year: 2026, month: 12 })).toEqual({ year: 2027, month: 1 });
    expect(nextYearMonth({ year: 2026, month: 5 })).toEqual({ year: 2026, month: 6 });
  });
});
