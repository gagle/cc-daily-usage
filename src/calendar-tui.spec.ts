import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account, OverageCreditGrantInfo } from "./account.js";
import type * as CalendarModule from "./calendar-tui.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";

const loadConfigMock = vi.fn();
const loadUsageMock = vi.fn();
const saveConfigMock = vi.fn();
const saveUsageMock = vi.fn();

vi.mock("./config.js", () => ({
  loadConfig: (k: unknown) => loadConfigMock(k) as unknown,
  loadUsage: (k: unknown) => loadUsageMock(k) as unknown,
  saveConfig: (k: unknown, c: unknown) => saveConfigMock(k, c),
  saveUsage: (k: unknown, u: unknown) => saveUsageMock(k, u),
}));

const resolveActiveAccountSyncMock = vi.fn((): Account | null => null);
const readOverageCreditGrantCacheMock = vi.fn(
  (_accountUuid: string | null): OverageCreditGrantInfo | null => null,
);
vi.mock("./account.js", () => ({
  resolveActiveAccountSync: () => resolveActiveAccountSyncMock() as unknown,
  accountKey: () => "default",
  readOverageCreditGrantCache: (u: string | null) => readOverageCreditGrantCacheMock(u) as unknown,
}));

/** Backs loadConfig/saveConfig with a real in-memory store (like config.json on disk) so a toggle's
 * saveConfig is visible to the very next loadConfig — matching real runtime behavior, where saveConfig
 * writes synchronously before the following read. */
let configStore: Config;
let usageStore: UsageState;

const ESC = "\x1b";
const KEY = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  left: `${ESC}[D`,
  right: `${ESC}[C`,
  tab: "\t",
  shiftTab: `${ESC}[Z`,
  enter: "\r",
  escape: ESC,
  space: " ",
  backspace: "\x7f",
  ctrlC: "\x03",
};

/** ink's useInput state updates are batched and only committed on the next microtask — flush that between
 * writes whenever a following assertion or write depends on the updated state (confirmed empirically: a
 * single `await Promise.resolve()` is enough for ink-testing-library's synchronous stdin.write). A lone ESC
 * byte is additionally held back by ink itself for 20ms in case it's the start of a longer escape sequence
 * (e.g. an arrow key) — advance the fake clock past that before flushing microtasks again. */
async function flush(): Promise<void> {
  await Promise.resolve();
  vi.advanceTimersByTime(25);
  await Promise.resolve();
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { monthlyCap: 650, laboralDays: { "2026": { "9": [1, 2, 3, 4] } }, ...overrides };
}

function makeUsage(overrides: Partial<UsageState> = {}): UsageState {
  return {
    monthlySpent: 80.94,
    lastUpdated: "2026-09-03T00:00:00.000Z",
    days: { "2026-09-01": 20, "2026-09-02": 15 },
    sessions: {},
    ...overrides,
  };
}

async function freshCalendar(): Promise<typeof CalendarModule> {
  vi.resetModules();
  return import("./calendar-tui.js");
}

describe("pure helpers", () => {
  it("daysInMonth returns the correct count, including leap February", async () => {
    const { daysInMonth } = await freshCalendar();
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it("mondayFirstWeekday maps Sunday to 6 and Monday to 0", async () => {
    const { mondayFirstWeekday } = await freshCalendar();
    expect(mondayFirstWeekday(2026, 9, 1)).toBe(1); // 2026-09-01 is a Tuesday
    expect(mondayFirstWeekday(2026, 9, 6)).toBe(6); // Sunday
    expect(mondayFirstWeekday(2026, 9, 7)).toBe(0); // Monday
  });

  it("monthsToShow unions config months, usage-day months, and always the current month, sorted", async () => {
    const { monthsToShow } = await freshCalendar();
    const config = makeConfig({ laboralDays: { "2026": { "9": [1] }, "2027": { "1": [5] } } });
    const usage = makeUsage({ days: { "2026-10-15": 3 } });
    const now = new Date("2026-09-03T00:00:00.000Z");
    expect(monthsToShow(config, usage, now)).toEqual([
      { year: 2026, month: 9 },
      { year: 2026, month: 10 },
      { year: 2027, month: 1 },
    ]);
  });

  it("monthsToShow dedupes when the current month already has configured laboral days", async () => {
    const { monthsToShow } = await freshCalendar();
    const config = makeConfig();
    const usage = makeUsage({ days: {} });
    const now = new Date("2026-09-03T00:00:00.000Z");
    expect(monthsToShow(config, usage, now)).toEqual([{ year: 2026, month: 9 }]);
  });

  it("yearsAvailable unions config years, usage-day years, and the current year", async () => {
    const { yearsAvailable } = await freshCalendar();
    const now = new Date("2026-09-15T00:00:00.000Z");
    const config = makeConfig({ laboralDays: { "2025": { "1": [1] }, "2026": { "9": [1] } } });
    const usage = makeUsage({ days: { "2027-03-01": 10 } });
    expect(yearsAvailable(config, usage, now)).toEqual([2025, 2026, 2027]);
  });

  it("moveCursor crosses month and year boundaries by whole UTC days", async () => {
    const { moveCursor } = await freshCalendar();
    expect(moveCursor({ year: 2026, month: 9, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 8,
      day: 31,
    });
    expect(moveCursor({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(moveCursor({ year: 2026, month: 9, day: 3 }, -7)).toEqual({
      year: 2026,
      month: 8,
      day: 27,
    });
  });
});

describe("computeSnapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not persist when every spent day is already laboral", async () => {
    loadConfigMock.mockReturnValue(makeConfig());
    loadUsageMock.mockReturnValue(makeUsage());
    const { computeSnapshot } = await freshCalendar();
    const snapshot = computeSnapshot();
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(snapshot.computed.monthlySpent).toBe(80.94);
  });

  it("never promotes a spent non-laboral day into config.laboralDays", async () => {
    loadConfigMock.mockReturnValue(makeConfig({ laboralDays: { "2026": { "9": [1] } } }));
    loadUsageMock.mockReturnValue(makeUsage({ days: { "2026-09-01": 20, "2026-09-06": 12.5 } }));
    const { computeSnapshot } = await freshCalendar();
    const snapshot = computeSnapshot();
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(snapshot.config.laboralDays["2026"]?.["9"]).toEqual([1]);
  });

  it("threads the resolved account into the returned snapshot and reads that account's own config/usage", async () => {
    resolveActiveAccountSyncMock.mockReturnValue({
      email: "a@b.com",
      accountUuid: "uuid-1",
      organizationType: "claude_pro",
    });
    loadConfigMock.mockReturnValue(makeConfig());
    loadUsageMock.mockReturnValue(makeUsage());
    const { computeSnapshot } = await freshCalendar();
    const snapshot = computeSnapshot();
    expect(snapshot.account?.email).toBe("a@b.com");
    expect(loadConfigMock).toHaveBeenCalledWith("default");
    expect(loadUsageMock).toHaveBeenCalledWith("default");
  });
});

describe("CalendarApp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    configStore = makeConfig();
    usageStore = makeUsage();
    loadConfigMock.mockImplementation(() => configStore);
    loadUsageMock.mockImplementation(() => usageStore);
    saveConfigMock.mockImplementation((_k: string, c: Config) => {
      configStore = c;
    });
    resolveActiveAccountSyncMock.mockReturnValue(null);
    readOverageCreditGrantCacheMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the stats header and calendar grid with a laboral month", async () => {
    const { CalendarApp } = await freshCalendar();
    const { lastFrame } = render(React.createElement(CalendarApp));
    const frame = lastFrame();
    expect(frame).not.toContain("cc-daily-usage calendar");
    expect(frame).toContain("Year 2026");
    expect(frame).toContain("September");
    expect(frame).toContain("Today:");
    expect(frame).toContain("This month:");
    expect(frame).toContain("September 2026");
    expect(frame).not.toContain("No laboral days configured");
    // Fixture marks the 3rd laboral — hint states what Enter will do.
    expect(frame).toContain("Day 3 · laboral · Enter/Space: unmark laboral");
    expect(frame).toContain("u edit $");
    expect(frame).toMatch(/·\s+(Coast|Ahead|Steady|On pace|Hot|Over|Burn)/);
    expect(frame).toContain("Day-1 max:");
    expect(frame).toContain("(650 / 4)");
    expect(frame).toContain("Real avg:");
  });

  it("still shows Day-1 max when the budget is exhausted (avg 0, no today pace pair)", async () => {
    usageStore = makeUsage({ monthlySpent: 700, days: { "2026-09-01": 700 } });
    const { CalendarApp } = await freshCalendar();
    const { lastFrame } = render(React.createElement(CalendarApp));
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Today:"); // no pace pair without avg
    expect(frame).toContain("Day-1 max:"); // equal-split plan still available
  });

  it("shows the warning banner when the current month has zero laboral days", async () => {
    configStore = makeConfig({ laboralDays: {} });
    usageStore = makeUsage({ days: {} });
    const { CalendarApp } = await freshCalendar();
    const { lastFrame } = render(React.createElement(CalendarApp));
    expect(lastFrame()).toContain("No laboral days configured for September 2026");
  });

  it("shows the credit-grant banner when eligible and not yet granted", async () => {
    resolveActiveAccountSyncMock.mockReturnValue({
      email: "a@b.com",
      accountUuid: "uuid-1",
      organizationType: "claude_pro",
    });
    readOverageCreditGrantCacheMock.mockReturnValue({
      available: true,
      eligible: true,
      granted: false,
      amount_minor_units: 2000,
      currency: "USD",
    });
    const { CalendarApp } = await freshCalendar();
    const { lastFrame } = render(React.createElement(CalendarApp));
    expect(lastFrame()).toContain("$20.00 credit grant available");
  });

  it("hides the credit-grant banner once already granted", async () => {
    resolveActiveAccountSyncMock.mockReturnValue({
      email: "a@b.com",
      accountUuid: "uuid-1",
      organizationType: "claude_pro",
    });
    readOverageCreditGrantCacheMock.mockReturnValue({
      available: true,
      eligible: true,
      granted: true,
      amount_minor_units: 2000,
      currency: "USD",
    });
    const { CalendarApp } = await freshCalendar();
    const { lastFrame } = render(React.createElement(CalendarApp));
    expect(lastFrame()).not.toContain("credit grant available");
  });

  it("shows today usage-only (no /$avg) on a non-laboral day", async () => {
    // 3 Sep 2026 is the fixed system time; omit it from laboral days.
    configStore = makeConfig({ laboralDays: { "2026": { "9": [1, 2, 4] } } });
    const { CalendarApp } = await freshCalendar();
    const { lastFrame } = render(React.createElement(CalendarApp));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Today:");
    expect(frame).toContain("$45.94"); // todayUsage from fixture monthlySpent - days before
    expect(frame).not.toMatch(/Today:\s+\$[\d.]+ \/ \$/);
  });

  it("quits on q", async () => {
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    expect(lastFrame()).toContain("Year 2026");
    stdin.write("q");
    await flush();
    expect(lastFrame()?.trim()).toBe("");
  });

  it("quits on Esc", async () => {
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    stdin.write(KEY.escape);
    await flush();
    expect(lastFrame()?.trim()).toBe("");
  });

  it("quits on Ctrl+C instead of entering cap-edit mode", async () => {
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    stdin.write(KEY.ctrlC);
    await flush();
    expect(lastFrame()?.trim()).toBe("");
  });

  it("moves the cursor with arrow keys and crosses into the previous month on up from day 1", async () => {
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    stdin.write(KEY.left); // day 3 -> day 2
    await flush();
    stdin.write(KEY.left); // day 2 -> day 1
    await flush();
    stdin.write(KEY.up); // crosses into August
    await flush();
    expect(lastFrame()).toContain("August 2026");
    stdin.write(KEY.down); // back toward September
    await flush();
    expect(lastFrame()).toBeDefined();
  });

  it("toggles the cursor day off when it's already laboral, then back on", async () => {
    // Cursor starts on today (the 3rd, per the fixed system time), which the fixture config marks laboral.
    const { CalendarApp } = await freshCalendar();
    const { stdin } = render(React.createElement(CalendarApp));
    stdin.write(KEY.space);
    await flush();
    expect(saveConfigMock).toHaveBeenLastCalledWith(
      "default",
      expect.objectContaining({ laboralDays: { "2026": { "9": [1, 2, 4] } } }),
    );
    stdin.write(KEY.enter);
    await flush();
    expect(saveConfigMock).toHaveBeenLastCalledWith(
      "default",
      expect.objectContaining({ laboralDays: { "2026": { "9": [1, 2, 3, 4] } } }),
    );
  });

  it("toggles a non-laboral (e.g. weekend) cursor day on", async () => {
    configStore = makeConfig({ laboralDays: { "2026": {} } });
    usageStore = makeUsage({ days: {} }); // no recorded spend, so mount doesn't auto-reconcile any day
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    expect(lastFrame()).toContain("Day 3 · off · Enter/Space: mark as laboral");
    stdin.write(KEY.space);
    await flush();
    expect(saveConfigMock).toHaveBeenLastCalledWith(
      "default",
      expect.objectContaining({ laboralDays: { "2026": { "9": [3] } } }),
    );
  });

  it("switches the active month with Tab and Shift+Tab within the year", async () => {
    configStore = makeConfig({ laboralDays: { "2026": { "9": [1, 2, 3, 4], "10": [1] } } });
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    stdin.write(KEY.tab);
    await flush();
    expect(lastFrame()).toContain("October 2026");
    stdin.write(KEY.shiftTab);
    await flush();
    expect(lastFrame()).toContain("September 2026");
    stdin.write(KEY.shiftTab); // August within the same year
    await flush();
    expect(lastFrame()).toContain("August 2026");
  });

  it("switches year with ] and [", async () => {
    configStore = makeConfig({
      laboralDays: { "2026": { "9": [1, 2, 3] }, "2027": { "9": [1] } },
    });
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    stdin.write("]");
    await flush();
    expect(lastFrame()).toContain("Year 2027");
    expect(lastFrame()).toContain("September 2027");
    stdin.write("[");
    await flush();
    expect(lastFrame()).toContain("Year 2026");
  });

  it("wraps months Jan↔Dec with Tab and uses [ when the cursored year is outside yearsAvailable", async () => {
    // Only 2026 is known; arrow across into 2027 so years.indexOf(cursor.year) === -1, then [.
    configStore = makeConfig({ laboralDays: { "2026": { "9": [1, 2, 3] } } });
    usageStore = makeUsage({ days: {} });
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    // September -> ... Tab to December
    for (let i = 0; i < 3; i++) {
      stdin.write(KEY.tab);
      await flush();
    }
    expect(lastFrame()).toContain("December 2026");
    stdin.write(KEY.tab); // wrap to January 2026
    await flush();
    expect(lastFrame()).toContain("January 2026");
    stdin.write(KEY.shiftTab); // wrap back to December
    await flush();
    expect(lastFrame()).toContain("December 2026");
    // Move into January 2027 via right from Dec 31
    for (let day = 3; day < 31; day++) {
      stdin.write(KEY.right);
    }
    await flush();
    stdin.write(KEY.right); // Dec 31 -> Jan 1 2027
    await flush();
    expect(lastFrame()).toContain("January 2027");
    stdin.write("["); // year not in yearsAvailable → c.year + direction
    await flush();
    expect(lastFrame()).toContain("Year 2026");
  });

  it("labels the cap as from Anthropic and blocks cap edit when the ledger supplies it", async () => {
    configStore = makeConfig({ hasSpendCap: true });
    usageStore = makeUsage({
      extraUsageCache: {
        fetchedAt: 0,
        data: {
          usedCredits: 80.94,
          monthlyLimit: 650,
          utilizationPct: 12,
          currency: "USD",
          spendLimitReached: false,
          disabledReason: null,
        },
      },
    });
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    expect(lastFrame()).toContain("cap from Anthropic");
    stdin.write("c");
    await flush();
    expect(lastFrame()).not.toContain("Monthly cap:");
  });

  it("enters cap-edit mode with 'c', accepts digits/backspace, and saves a valid cap on Enter", async () => {
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    stdin.write("c");
    await flush();
    expect(lastFrame()).toContain("Monthly cap: $650");
    stdin.write(KEY.backspace);
    await flush();
    expect(lastFrame()).toContain("Monthly cap: $65");
    stdin.write("9");
    await flush();
    expect(lastFrame()).toContain("Monthly cap: $659");
    stdin.write("x"); // non-digit, ignored
    await flush();
    expect(lastFrame()).toContain("Monthly cap: $659");
    stdin.write(KEY.enter);
    await flush();
    expect(saveConfigMock).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ monthlyCap: 659 }),
    );
    expect(lastFrame()).not.toContain("Monthly cap:");
  });

  it("cancels cap-edit mode on Esc without saving", async () => {
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    stdin.write("c");
    await flush();
    stdin.write(KEY.escape);
    await flush();
    expect(lastFrame()).not.toContain("Monthly cap:");
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("discards an invalid cap entry (bare '.') on Enter without saving", async () => {
    const { CalendarApp } = await freshCalendar();
    const { stdin } = render(React.createElement(CalendarApp));
    stdin.write("c");
    await flush();
    stdin.write(KEY.backspace);
    await flush();
    stdin.write(KEY.backspace);
    await flush();
    stdin.write(KEY.backspace); // "650" -> ""
    await flush();
    stdin.write("."); // "." -> Number(".") is NaN, not finite
    await flush();
    stdin.write(KEY.enter);
    await flush();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("clears the poll interval on unmount", async () => {
    const { CalendarApp } = await freshCalendar();
    const { unmount } = render(React.createElement(CalendarApp));
    unmount();
    vi.advanceTimersByTime(10_000);
    expect(loadConfigMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("hides monthlyCap/laboralDays UI and disables their keys once the account has no spend cap", async () => {
    configStore = makeConfig({ hasSpendCap: false, planType: "claude_pro" });
    const { CalendarApp } = await freshCalendar();
    const { stdin, lastFrame } = render(React.createElement(CalendarApp));
    const frame = lastFrame();
    expect(frame).not.toContain("This month:");
    expect(frame).not.toContain("September 2026");
    expect(frame).toContain("No spend cap on this plan (claude_pro)");
    expect(frame).not.toContain("c cap");

    stdin.write("c");
    await flush();
    expect(lastFrame()).not.toContain("Monthly cap:");

    stdin.write(KEY.space);
    await flush();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("falls back to a generic plan label when hasSpendCap is false but planType wasn't resolved", async () => {
    configStore = makeConfig({ hasSpendCap: false });
    const { CalendarApp } = await freshCalendar();
    const { lastFrame } = render(React.createElement(CalendarApp));
    expect(lastFrame()).toContain("No spend cap on this plan (subscription)");
  });

  it("refreshes the snapshot on the poll interval", async () => {
    const { CalendarApp } = await freshCalendar();
    render(React.createElement(CalendarApp));
    const callsBefore = loadConfigMock.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(loadConfigMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  describe("day-edit mode (u / S)", () => {
    it("enters day-edit mode with the draft pre-seeded to the current month's pool", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      // day 3 (today, fixed system time) has no usage.days entry yet — seeded from the live todayUsage
      // (monthlySpent 80.94 minus days 1+2's 20+15 = 45.94), so the draft already sums to the pool.
      expect(lastFrame()).toContain("Redistributing September 2026 pool $80.94");
      expect(lastFrame()).toContain("Allocated $80.94 of $80.94");
      expect(lastFrame()).toContain("Editing day 3 $ (month pool $80.94)");
      expect(lastFrame()).toContain("start clean next laboral day");
      expect(lastFrame()).toContain("$_"); // auto $ prefix on the cursor cell
    });

    it("typing digits then Enter commits the value into the draft for the cursored day", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write("5");
      stdin.write("0");
      await flush();
      expect(lastFrame()).toContain("$50_");
      stdin.write(KEY.enter);
      await flush();
      expect(lastFrame()).toContain("$_");
      expect(lastFrame()).toContain("Allocated $85.00 of $80.94"); // 20 + 15 + 50
    });

    it("arrow-key navigation auto-commits the in-progress buffer before moving", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write("5");
      await flush();
      stdin.write(KEY.left); // day 3 -> day 2, committing $5 to day 3 first
      await flush();
      expect(lastFrame()).toContain("Editing day 2 $");
      expect(lastFrame()).toContain("Allocated $40.00 of $80.94"); // 20 + 15 + 5
    });

    it("right/up/down all move the cursor while in edit mode", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write(KEY.right); // day 3 -> day 4
      await flush();
      expect(lastFrame()).toContain("Editing day 4 $");
      stdin.write(KEY.down); // day 4 -> day 11
      await flush();
      expect(lastFrame()).toContain("Editing day 11 $");
      stdin.write(KEY.up); // day 11 -> day 4
      await flush();
      expect(lastFrame()).toContain("Editing day 4 $");
    });

    it("keeps edit-mode arrows inside the edited month at the boundary", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write(KEY.left); // day 3 -> 2
      await flush();
      stdin.write(KEY.left); // day 2 -> 1
      await flush();
      stdin.write(KEY.left); // would leave September — clamp stays on day 1
      await flush();
      expect(lastFrame()).toContain("Editing day 1 $");
      expect(lastFrame()).toContain("September 2026");
    });

    it("ignores an unhandled key while in edit mode", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write("x");
      await flush();
      expect(lastFrame()).toContain("Editing day 3 $");
      expect(lastFrame()).toContain("Allocated $80.94 of $80.94");
    });

    it("backspace edits the in-progress buffer", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write("5");
      stdin.write("9");
      await flush();
      stdin.write(KEY.backspace);
      await flush();
      expect(lastFrame()).toContain("$5_");
    });

    it("S with a mismatched sum shows a warning and does not save", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write("1");
      stdin.write("0");
      await flush();
      stdin.write("S");
      await flush();
      expect(saveUsageMock).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("not saved");
      expect(lastFrame()).toContain("Redistributing September 2026"); // stays in edit mode
    });

    it("S with a matching sum saves and exits edit mode", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write("S");
      await flush();
      expect(saveUsageMock).toHaveBeenCalledWith(
        "default",
        expect.objectContaining({
          days: { "2026-09-01": 20, "2026-09-02": 15, "2026-09-03": 45.94 },
        }),
      );
      expect(lastFrame()).not.toContain("Redistributing September 2026");
    });

    it("Esc cancels day-edit mode without saving", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write("9");
      await flush();
      stdin.write(KEY.escape);
      await flush();
      expect(saveUsageMock).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain("Redistributing September 2026");
    });

    it("silently drops a non-numeric buffer instead of corrupting the draft", async () => {
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write(".");
      await flush();
      stdin.write(KEY.enter);
      await flush();
      // "." alone parses to NaN — dropped, draft stays at its original seeded total.
      expect(lastFrame()).toContain("Allocated $80.94 of $80.94");
    });

    it("only clears the saved month's own days, leaving other months' recorded spend untouched", async () => {
      usageStore = makeUsage({
        days: { "2026-08-10": 99, "2026-09-01": 20, "2026-09-02": 15 },
      });
      const { CalendarApp } = await freshCalendar();
      const { stdin } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      stdin.write("S");
      await flush();
      expect(saveUsageMock).toHaveBeenCalledWith(
        "default",
        expect.objectContaining({
          days: { "2026-08-10": 99, "2026-09-01": 20, "2026-09-02": 15, "2026-09-03": 45.94 },
        }),
      );
    });

    it("uses the sum of existing days (not monthlySpent) as the pool for a past, non-current month", async () => {
      usageStore = makeUsage({
        days: { "2026-08-15": 30, "2026-08-20": 10, "2026-09-01": 20, "2026-09-02": 15 },
      });
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write(KEY.shiftTab); // September -> August within the year
      await flush();
      stdin.write("u");
      await flush();
      expect(lastFrame()).toContain("Redistributing August 2026");
      expect(lastFrame()).toContain("Allocated $40.00 of $40.00");
    });

    it("does nothing when hasSpendCap is false — no dollar tracking to edit", async () => {
      configStore = makeConfig({ hasSpendCap: false });
      const { CalendarApp } = await freshCalendar();
      const { stdin, lastFrame } = render(React.createElement(CalendarApp));
      stdin.write("u");
      await flush();
      expect(lastFrame()).not.toContain("Editing");
    });
  });
});
