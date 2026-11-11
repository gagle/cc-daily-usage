import { afterEach, describe, expect, it, vi } from "vitest";

import type { LimitSample } from "./interfaces/config.interface.js";
import {
  addWorkHours,
  appendSample,
  computeRunway,
  milestones,
  SAMPLE_MAX_AGE_MS,
  SAMPLE_MAX_COUNT,
  typicalPeak,
  usdPerPercentWeek,
  workHoursBetween,
} from "./limits-history.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function sample(
  minutesAgo: number,
  fiveHourPct: number | null,
  sevenDayPct: number | null = 0,
  apiEqTotal = 0,
): LimitSample {
  return {
    t: NOW.getTime() - minutesAgo * MIN,
    fiveHourPct,
    sevenDayPct,
    fiveHourResetsAt: null,
    sevenDayResetsAt: null,
    apiEqTotal,
  };
}

/** A sample with both windows' reset times set (epoch s). */
function withResets(
  base: LimitSample,
  fiveHourResetsAt: number,
  sevenDayResetsAt: number,
): LimitSample {
  return { ...base, fiveHourResetsAt, sevenDayResetsAt };
}

const sec = (msFromNow: number): number => Math.round((NOW.getTime() + msFromNow) / 1000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("appendSample", () => {
  it("returns the same array when neither % changed", () => {
    const samples = [sample(10, 5, 1)];
    expect(appendSample(samples, sample(0, 5, 1))).toBe(samples);
  });

  it("appends a change and an empty history's first reading", () => {
    expect(appendSample([], sample(0, 5))).toEqual([sample(0, 5)]);
    expect(appendSample([sample(10, 5, 1)], sample(0, 5, 2))).toHaveLength(2);
  });

  it("drops samples past the age and count caps", () => {
    const old = { ...sample(0, 1), t: NOW.getTime() - SAMPLE_MAX_AGE_MS - 1 };
    expect(appendSample([old, sample(5, 2)], sample(0, 3))).toEqual([sample(5, 2), sample(0, 3)]);
    const many = Array.from({ length: SAMPLE_MAX_COUNT }, (_, i) =>
      sample(SAMPLE_MAX_COUNT - i, i),
    );
    const next = appendSample(many, sample(0, -1));
    expect(next).toHaveLength(SAMPLE_MAX_COUNT);
    expect(next.at(-1)).toEqual(sample(0, -1));
  });
});

describe("work-day time", () => {
  // Local times (any zone): Fri 2026-10-16 18:00 → Mon 2026-10-19 06:00. No DST change in those days.
  const at = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime();
  const weekdays = (date: Date): boolean => date.getDay() !== 0 && date.getDay() !== 6;

  it("clock time without a work-day test", () => {
    expect(workHoursBetween(at(16, 18), at(19, 6), null)).toBe(60);
    expect(workHoursBetween(at(19, 6), at(16, 18), null)).toBe(0);
    expect(addWorkHours(at(16, 18), 10, null)).toBe(at(17, 4));
  });

  it("skips days off; the first day always counts", () => {
    expect(workHoursBetween(at(16, 18), at(19, 6), weekdays)).toBe(12); // Fri 6 h + Mon 6 h
    expect(workHoursBetween(at(17, 12), at(18, 12), weekdays)).toBe(12); // a Saturday reading counts its day
    expect(addWorkHours(at(16, 18), 10, weekdays)).toBe(at(19, 4));
    expect(addWorkHours(at(16, 18), 2, weekdays)).toBe(at(16, 20));
  });

  it("no work day ahead: no exhaustion inside the horizon", () => {
    expect(addWorkHours(at(16, 18), 10, () => false)).toBeNull();
  });

  it("the 7-day runway burns only on work days", () => {
    const now = at(16, 18);
    const samples: Array<LimitSample> = [
      {
        t: now - 2 * HOUR,
        fiveHourPct: null,
        sevenDayPct: 60,
        fiveHourResetsAt: null,
        sevenDayResetsAt: null,
        apiEqTotal: 0,
      },
    ];
    const resets = Math.round(at(21, 0) / 1000);
    // 2 %/h, 36 % left → 18 work hours: Fri 6 h, then Mon 00:00 + 12 h
    const work = computeRunway(samples, "sevenDay", 64, resets, now, new Date(now), weekdays);
    expect(work.exhaustsAt).toBe(Math.round(at(19, 12) / 1000));
    expect(work.verdict).toBe("at-risk");
    const clock = computeRunway(samples, "sevenDay", 64, resets, now, new Date(now));
    expect(clock.exhaustsAt).toBe(Math.round(at(17, 12) / 1000));
  });
});

describe("computeRunway", () => {
  const now = NOW.getTime();

  it("is stale when the reading is old", () => {
    const runway = computeRunway([sample(60, 10)], "fiveHour", 20, sec(HOUR), now - 16 * MIN, NOW);
    expect(runway.verdict).toBe("stale");
    expect(runway.ratePctPerHour).toBeNull();
  });

  it("is at-risk at or past 100%", () => {
    expect(computeRunway([], "fiveHour", 100, sec(HOUR), now, NOW)).toMatchObject({
      verdict: "at-risk",
      exhaustsAt: sec(0),
    });
  });

  it("needs 15 minutes of history", () => {
    expect(computeRunway([], "fiveHour", 20, sec(HOUR), now, NOW).verdict).toBe(
      "insufficient-data",
    );
    expect(computeRunway([sample(10, 10)], "fiveHour", 20, sec(HOUR), now, NOW).verdict).toBe(
      "insufficient-data",
    );
  });

  it("measures from the reading in force 2 h ago", () => {
    const samples = [sample(300, 0), sample(180, 10), sample(60, 15)];
    const runway = computeRunway(samples, "fiveHour", 20, sec(HOUR), now, NOW);
    expect(runway.ratePctPerHour).toBeCloseTo(10 / 3);
    expect(runway.exhaustsAt).toBe(sec(24 * HOUR));
    expect(runway.verdict).toBe("comfortable");
  });

  it("restarts after a reset (a drop) or a gap with no reading", () => {
    const dropped = [sample(200, 90), sample(100, 2), sample(30, 4)];
    expect(computeRunway(dropped, "fiveHour", 12, sec(4 * HOUR), now, NOW).ratePctPerHour).toBe(6);
    const gap = [sample(200, 50), sample(150, null), sample(60, 10)];
    expect(computeRunway(gap, "fiveHour", 12, sec(4 * HOUR), now, NOW).ratePctPerHour).toBe(2);
  });

  it("skips a drop whose reset time stayed put; restarts when it moved", () => {
    const reset = sec(4 * HOUR);
    const jitter = [
      withResets(sample(100, 40), reset, reset),
      withResets(sample(90, 10), reset - 1, reset), // bad reading: resets_at only jittered
      withResets(sample(30, 46), reset, reset),
    ];
    expect(computeRunway(jitter, "fiveHour", 52, reset, now, NOW).ratePctPerHour).toBeCloseTo(
      12 / (100 / 60),
    );
    const moved = [
      withResets(sample(100, 90), sec(-HOUR), reset),
      withResets(sample(90, 2), reset, reset),
    ];
    expect(computeRunway(moved, "fiveHour", 14, reset, now, NOW).ratePctPerHour).toBeCloseTo(
      12 / 1.5,
    );
  });

  it("reads the 7-day side on its own", () => {
    const samples = [sample(120, 50, 10), sample(60, 60, 12)];
    expect(computeRunway(samples, "sevenDay", 14, sec(HOUR), now, NOW).ratePctPerHour).toBe(2);
  });

  it("is at-risk when it runs out before reset, on-track when tight, comfortable when slow", () => {
    const samples = [sample(60, 50)];
    expect(computeRunway(samples, "fiveHour", 70, sec(2 * HOUR), now, NOW)).toMatchObject({
      verdict: "at-risk",
      exhaustsAt: sec(1.5 * HOUR),
    });
    expect(computeRunway(samples, "fiveHour", 60, sec(3.5 * HOUR), now, NOW).verdict).toBe(
      "on-track",
    );
    expect(computeRunway(samples, "fiveHour", 52, sec(HOUR), now, NOW).verdict).toBe("comfortable");
  });

  it("measures to the reading, so time passing before the next fetch keeps the verdict", () => {
    const samples = [sample(60, 50)];
    const later = new Date(now + 10 * MIN); // still inside STALE_READING_MS
    expect(computeRunway(samples, "fiveHour", 70, sec(2 * HOUR), now, later)).toEqual(
      computeRunway(samples, "fiveHour", 70, sec(2 * HOUR), now, NOW),
    );
  });

  it("has no exhaust time while flat, and no pace without a reset time", () => {
    const flat = computeRunway([sample(60, 50)], "fiveHour", 50, sec(HOUR), now, NOW);
    expect(flat).toMatchObject({ ratePctPerHour: 0, exhaustsAt: null, verdict: "comfortable" });
    expect(computeRunway([sample(60, 50)], "fiveHour", 60, null, now, NOW).verdict).toBe(
      "on-track",
    );
  });

  it("treats a reset time already reached as one minute away", () => {
    expect(computeRunway([sample(60, 50)], "fiveHour", 52, sec(-MIN), now, NOW).verdict).toBe(
      "comfortable",
    );
  });

  it.each(["UTC", "Europe/Madrid", "America/Los_Angeles"])(
    "does not depend on the time zone across a DST change (%s)",
    (tz) => {
      vi.stubEnv("TZ", tz);
      const dstNow = new Date("2026-10-25T01:30:00.000Z"); // Europe/Madrid falls back at 01:00 UTC
      const samples = [{ ...sample(0, 10), t: dstNow.getTime() - 2 * HOUR }];
      const runway = computeRunway(samples, "fiveHour", 14, null, dstNow.getTime(), dstNow);
      expect(runway.ratePctPerHour).toBe(2);
    },
  );
});

describe("usdPerPercentWeek", () => {
  it("is null under three measured rises", () => {
    expect(usdPerPercentWeek([sample(30, 0, 1, 0), sample(20, 0, 2, 3)], NOW)).toBeNull();
  });

  it("takes the median of Δ$ ÷ Δ% over rises of at least one point", () => {
    const samples = [
      sample(60, 0, 10, 0),
      sample(55, 1, 10.5, 1), // rise under one point: wait
      sample(50, 2, 11, 2), // 2 / 1
      sample(40, 3, 13, 8), // 6 / 2
      sample(30, 4, 14, 12), // 4 / 1
    ];
    expect(usdPerPercentWeek(samples, NOW)).toBe(3);
    expect(usdPerPercentWeek([...samples, sample(20, 5, 15, 17)], NOW)).toBe(3.5);
  });

  it("restarts on a drop and skips old, unknown and negative readings", () => {
    const samples = [
      { ...sample(0, 0, 1, 0), t: NOW.getTime() - 15 * 24 * HOUR },
      sample(90, 0, null, 0),
      sample(80, 0, 50, 0),
      sample(70, 0, 2, 10), // reset: new start
      sample(60, 0, 3, 5), // $ went down (fresh file): skipped
      sample(50, 0, 4, 7),
      sample(40, 0, 5, 9),
      sample(30, 0, 6, 11),
    ];
    expect(usdPerPercentWeek(samples, NOW)).toBe(2);
  });

  it("ignores interleaved bad readings that drop without a reset", () => {
    const reset = sec(3 * 24 * HOUR);
    const samples = [
      [60, 25, 0],
      [59, 15, 0], // bad: same reset time, not a reset
      [58, 26, 2],
      [57, 15, 2],
      [50, 27, 4],
      [45, 15, 4],
      [40, 28, 6],
    ].map(([ago, pct, usd]) =>
      withResets(sample(ago as number, 0, pct as number, usd as number), reset, reset),
    );
    expect(usdPerPercentWeek(samples, NOW)).toBe(2);
  });

  it("divides by Claude Code's share of the week; skips a share too small to trust", () => {
    const withShare = (base: LimitSample, claudeCodeShare: number | null): LimitSample => ({
      ...base,
      claudeCodeShare,
    });
    const samples = [
      sample(60, 0, 10, 0),
      withShare(sample(50, 0, 11, 1), 0.5), // 1 point, $1, half of it Claude Code → $2 per CC point
      withShare(sample(40, 0, 12, 3), 0.5),
      withShare(sample(30, 0, 13, 5), null), // no share → whole point
      withShare(sample(20, 0, 14, 9), 0.01), // too small: skipped
    ];
    expect(usdPerPercentWeek(samples, NOW)).toBe(2);
  });
});

describe("typicalPeak and milestones", () => {
  const at = (minutesAgo: number, seven: number | null, resetsAt: number | null): LimitSample => ({
    ...sample(minutesAgo, null, seven),
    sevenDayResetsAt: resetsAt,
  });

  it("typical peak: median of finished windows (odd and even counts); null under two", () => {
    const week = (n: number): number => sec(-n * 7 * 24 * HOUR);
    const three = [at(30_000, 50, week(3)), at(20_000, 70, week(2)), at(10_000, 90, week(1))];
    expect(typicalPeak(three, "sevenDay", NOW)).toBe(70);
    expect(typicalPeak(three.slice(1), "sevenDay", NOW)).toBe(80);
    expect(typicalPeak(three.slice(2), "sevenDay", NOW)).toBeNull();
    // the API's reset time jitters by seconds: still one window
    expect(
      typicalPeak(
        [at(20_000, 70, week(2)), at(19_000, 75, week(2) + 1), ...three.slice(2)],
        "sevenDay",
        NOW,
      ),
    ).toBe(82.5);
    expect(typicalPeak([at(10, 50, null), at(5, null, week(1))], "sevenDay", NOW)).toBeNull();
  });

  it("milestones: primed on first sight, highest of a jump, once per window", () => {
    const open = sec(HOUR);
    const crossings = milestones(
      [at(60, 80, open), at(50, 85, open), at(40, 95, open), at(30, 101, open), at(20, 100, open)],
      "sevenDay",
    );
    expect(crossings.map((m) => m.threshold)).toEqual([90, 100]);
    expect(milestones([at(60, 10, open), at(50, 99, open)], "sevenDay")).toEqual([
      { threshold: 90, at: NOW.getTime() - 50 * MIN, resetsAt: open },
    ]);
    expect(milestones([at(60, 95, open)], "sevenDay")).toEqual([]);
  });
});
