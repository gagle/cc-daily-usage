import { describe, expect, it } from "vitest";

import type { ComputedUsage } from "./interfaces/calc.interface.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";
import { escapeHtml, monthName, renderReport } from "./report.js";

function makeComputed(overrides: Partial<ComputedUsage> = {}): ComputedUsage {
  return {
    monthlyCap: 650,
    monthlySpent: 80.94,
    leftThisMonth: 569.06,
    avgPerDay: 33.48,
    safeMonthTotal: 114.42,
    todayUsage: 12.3,
    todayUsedPct: 0.367,
    monthUsedPct: 0.1245,
    remainingLaboralDays: 18,
    ...overrides,
  };
}

describe("monthName", () => {
  it("returns the named month for a valid 1-12 index", () => {
    expect(monthName(9)).toBe("September");
  });

  it("falls back to 'Unknown' for an out-of-range month", () => {
    expect(monthName(13)).toBe("Unknown");
  });
});

describe("escapeHtml", () => {
  it("escapes every special character", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("renderReport", () => {
  const config: Config = {
    monthlyCap: 650,
    laboralDays: { "2027": { "1": [4, 5] }, "2026": { "9": [1, 2, 3], "10": [] } },
  };
  const usage: UsageState = {
    monthlySpent: 80.94,
    lastUpdated: "2026-09-03T00:00:00.000Z",
    days: { "2026-09-01": 20 },
    sessions: {},
    frozenForDate: "2026-09-03",
    frozenAvgPerDay: 33.48,
    frozenSafeMonthTotal: 114.42,
  };

  it("renders the stat tiles, escapes text, and marks today's row", () => {
    const html = renderReport(config, usage, makeComputed(), new Date("2026-09-03T12:00:00.000Z"));
    expect(html).toContain("Claude usage — 2026-09-03");
    expect(html).toContain("$650.00");
    expect(html).toContain('class="today-row"');
    expect(html).toContain("$20.00");
    expect(html).toContain("2026");
  });

  it("skips a month with an empty laboral-day list", () => {
    const html = renderReport(config, usage, makeComputed(), new Date("2026-09-03T12:00:00.000Z"));
    expect(html).not.toContain("October 2026");
  });

  it("renders '—' for avg-from-day-1 and a colored today tile when todayUsedPct is null", () => {
    const bareConfig: Config = { monthlyCap: 200, laboralDays: {} };
    const bareUsage: UsageState = {
      monthlySpent: 0,
      lastUpdated: "2026-09-11T00:00:00.000Z",
      days: {},
      sessions: {},
      frozenForDate: "2026-09-11",
      frozenAvgPerDay: null,
      frozenSafeMonthTotal: null,
    };
    const html = renderReport(
      bareConfig,
      bareUsage,
      makeComputed({ avgPerDay: null, safeMonthTotal: null, todayUsedPct: null }),
      new Date("2026-09-11T00:00:00.000Z"),
    );
    expect(html).toContain("—");
  });

  it("blank amount cell for a laboral day with no recorded spend", () => {
    const html = renderReport(config, usage, makeComputed(), new Date("2026-09-03T12:00:00.000Z"));
    expect(html).toContain("<td>2</td><td></td>");
  });
});
