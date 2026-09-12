import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Account, OverageCreditGrantInfo } from "./account.js";
import type * as DashboardModule from "./dashboard-tui.js";
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
    frozenForDate: "2026-09-03",
    frozenAvgPerDay: 33.48,
    frozenSafeMonthTotal: 114.42,
    ...overrides,
  };
}

async function freshDashboard(): Promise<typeof DashboardModule> {
  vi.resetModules();
  return import("./dashboard-tui.js");
}

describe("pure helpers", () => {
  it("daysInMonth returns the correct count, including leap February", async () => {
    const { daysInMonth } = await freshDashboard();
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it("mondayFirstWeekday maps Sunday to 6 and Monday to 0", async () => {
    const { mondayFirstWeekday } = await freshDashboard();
    expect(mondayFirstWeekday(2026, 9, 1)).toBe(1); // 2026-09-01 is a Tuesday
    expect(mondayFirstWeekday(2026, 9, 6)).toBe(6); // Sunday
    expect(mondayFirstWeekday(2026, 9, 7)).toBe(0); // Monday
  });

  it("monthsToShow unions config months, usage-day months, and always the current month, sorted", async () => {
    const { monthsToShow } = await freshDashboard();
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
    const { monthsToShow } = await freshDashboard();
    const config = makeConfig();
    const usage = makeUsage({ days: {} });
    const now = new Date("2026-09-03T00:00:00.000Z");
    expect(monthsToShow(config, usage, now)).toEqual([{ year: 2026, month: 9 }]);
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
    const { computeSnapshot } = await freshDashboard();
    const snapshot = computeSnapshot();
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(snapshot.computed.monthlySpent).toBe(80.94);
  });

  it("never promotes a spent non-laboral day into config.laboralDays", async () => {
    loadConfigMock.mockReturnValue(makeConfig({ laboralDays: { "2026": { "9": [1] } } }));
    loadUsageMock.mockReturnValue(makeUsage({ days: { "2026-09-01": 20, "2026-09-06": 12.5 } }));
    const { computeSnapshot } = await freshDashboard();
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
    const { computeSnapshot } = await freshDashboard();
    const snapshot = computeSnapshot();
    expect(snapshot.account?.email).toBe("a@b.com");
    expect(loadConfigMock).toHaveBeenCalledWith("default");
    expect(loadUsageMock).toHaveBeenCalledWith("default");
  });
});

describe("DashboardApp", () => {
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

  it("renders the stats header, calendar grid, and footer bar with a laboral month", async () => {
    const { DashboardApp } = await freshDashboard();
    const { lastFrame } = render(React.createElement(DashboardApp));
    const frame = lastFrame();
    expect(frame).toContain("cc-daily-usage dashboard");
    expect(frame).toContain("Today:");
    expect(frame).toContain("This month:");
    expect(frame).toContain("September 2026");
    expect(frame).not.toContain("No laboral days configured");
  });

  it("shows the warning banner when the current month has zero laboral days", async () => {
    configStore = makeConfig({ laboralDays: {} });
    usageStore = makeUsage({ days: {} });
    const { DashboardApp } = await freshDashboard();
    const { lastFrame } = render(React.createElement(DashboardApp));
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
    const { DashboardApp } = await freshDashboard();
    const { lastFrame } = render(React.createElement(DashboardApp));
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
    const { DashboardApp } = await freshDashboard();
    const { lastFrame } = render(React.createElement(DashboardApp));
    expect(lastFrame()).not.toContain("credit grant available");
  });

  it("falls back to the 'This month' line only when avgPerDay is null (no today segment)", async () => {
    usageStore = makeUsage({ frozenAvgPerDay: null, frozenSafeMonthTotal: null });
    const { DashboardApp } = await freshDashboard();
    const { lastFrame } = render(React.createElement(DashboardApp));
    expect(lastFrame()).not.toContain("Today:");
  });

  it("quits on q", async () => {
    const { DashboardApp } = await freshDashboard();
    const { stdin, lastFrame } = render(React.createElement(DashboardApp));
    expect(lastFrame()).toContain("cc-daily-usage dashboard");
    stdin.write("q");
    await flush();
    expect(lastFrame()?.trim()).toBe("");
  });

  it("quits on Esc", async () => {
    const { DashboardApp } = await freshDashboard();
    const { stdin, lastFrame } = render(React.createElement(DashboardApp));
    stdin.write(KEY.escape);
    await flush();
    expect(lastFrame()?.trim()).toBe("");
  });

  it("moves the cursor with arrow keys, clamping at the month boundaries", async () => {
    const { DashboardApp } = await freshDashboard();
    const { stdin, lastFrame } = render(React.createElement(DashboardApp));
    stdin.write(KEY.left); // day 3 -> day 2
    await flush();
    stdin.write(KEY.up); // clamps to day 1
    await flush();
    stdin.write(KEY.up); // stays at day 1 (already clamped)
    await flush();
    stdin.write(KEY.down); // day 1 -> day 8
    await flush();
    stdin.write(KEY.right); // day 8 -> day 9
    await flush();
    expect(lastFrame()).toBeDefined();
  });

  it("toggles the cursor day off when it's already laboral, then back on", async () => {
    // Cursor starts on today (the 3rd, per the fixed system time), which the fixture config marks laboral.
    const { DashboardApp } = await freshDashboard();
    const { stdin } = render(React.createElement(DashboardApp));
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
    const { DashboardApp } = await freshDashboard();
    const { stdin } = render(React.createElement(DashboardApp));
    stdin.write(KEY.space);
    await flush();
    expect(saveConfigMock).toHaveBeenLastCalledWith(
      "default",
      expect.objectContaining({ laboralDays: { "2026": { "9": [3] } } }),
    );
  });

  it("switches the active month with Tab and Shift+Tab, wrapping around", async () => {
    configStore = makeConfig({ laboralDays: { "2026": { "9": [1, 2, 3, 4], "10": [1] } } });
    const { DashboardApp } = await freshDashboard();
    const { stdin, lastFrame } = render(React.createElement(DashboardApp));
    stdin.write(KEY.tab);
    await flush();
    expect(lastFrame()).toContain("October 2026");
    stdin.write(KEY.shiftTab);
    await flush();
    expect(lastFrame()).toContain("September 2026");
    stdin.write(KEY.shiftTab); // wraps back around to October
    await flush();
    expect(lastFrame()).toContain("October 2026");
  });

  it("enters cap-edit mode with 'c', accepts digits/backspace, and saves a valid cap on Enter", async () => {
    const { DashboardApp } = await freshDashboard();
    const { stdin, lastFrame } = render(React.createElement(DashboardApp));
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
    const { DashboardApp } = await freshDashboard();
    const { stdin, lastFrame } = render(React.createElement(DashboardApp));
    stdin.write("c");
    await flush();
    stdin.write(KEY.escape);
    await flush();
    expect(lastFrame()).not.toContain("Monthly cap:");
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("discards an invalid cap entry (bare '.') on Enter without saving", async () => {
    const { DashboardApp } = await freshDashboard();
    const { stdin } = render(React.createElement(DashboardApp));
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
    const { DashboardApp } = await freshDashboard();
    const { unmount } = render(React.createElement(DashboardApp));
    unmount();
    vi.advanceTimersByTime(10_000);
    expect(loadConfigMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("hides monthlyCap/laboralDays UI and disables their keys once the account has no spend cap", async () => {
    configStore = makeConfig({ hasSpendCap: false, planType: "claude_pro" });
    const { DashboardApp } = await freshDashboard();
    const { stdin, lastFrame } = render(React.createElement(DashboardApp));
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
    const { DashboardApp } = await freshDashboard();
    const { lastFrame } = render(React.createElement(DashboardApp));
    expect(lastFrame()).toContain("No spend cap on this plan (subscription)");
  });

  it("refreshes the snapshot on the poll interval", async () => {
    const { DashboardApp } = await freshDashboard();
    render(React.createElement(DashboardApp));
    const callsBefore = loadConfigMock.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(loadConfigMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  describe("day-edit mode (u / S)", () => {
    it("enters day-edit mode with the draft pre-seeded to the current month's pool", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      // day 3 (today, fixed system time) has no usage.days entry yet — seeded from the live todayUsage
      // (monthlySpent 80.94 minus days 1+2's 20+15 = 45.94), so the draft already sums to the pool.
      expect(lastFrame()).toContain("Editing September 2026 day 3");
      expect(lastFrame()).toContain("allocated $80.94 of $80.94");
    });

    it("typing digits then Enter commits the value into the draft for the cursored day", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      stdin.write("5");
      stdin.write("0");
      await flush();
      expect(lastFrame()).toContain("day 3: $50_");
      stdin.write(KEY.enter);
      await flush();
      expect(lastFrame()).toContain("day 3: $_");
      expect(lastFrame()).toContain("allocated $85.00 of $80.94"); // 20 + 15 + 50
    });

    it("arrow-key navigation auto-commits the in-progress buffer before moving", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      stdin.write("5");
      await flush();
      stdin.write(KEY.left); // day 3 -> day 2, committing $5 to day 3 first
      await flush();
      expect(lastFrame()).toContain("Editing September 2026 day 2");
      expect(lastFrame()).toContain("allocated $40.00 of $80.94"); // 20 + 15 + 5
    });

    it("right/up/down all move the cursor while in edit mode", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      stdin.write(KEY.right); // day 3 -> day 4
      await flush();
      expect(lastFrame()).toContain("Editing September 2026 day 4");
      stdin.write(KEY.down); // day 4 -> day 11
      await flush();
      expect(lastFrame()).toContain("Editing September 2026 day 11");
      stdin.write(KEY.up); // day 11 -> day 4
      await flush();
      expect(lastFrame()).toContain("Editing September 2026 day 4");
    });

    it("ignores an unhandled key while in edit mode", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      stdin.write("x");
      await flush();
      expect(lastFrame()).toContain("Editing September 2026 day 3");
      expect(lastFrame()).toContain("allocated $80.94 of $80.94");
    });

    it("backspace edits the in-progress buffer", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      stdin.write("5");
      stdin.write("9");
      await flush();
      stdin.write(KEY.backspace);
      await flush();
      expect(lastFrame()).toContain("day 3: $5_");
    });

    it("S with a mismatched sum shows a warning and does not save", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      stdin.write("1");
      stdin.write("0");
      await flush();
      stdin.write("S");
      await flush();
      expect(saveUsageMock).not.toHaveBeenCalled();
      expect(lastFrame()).toContain("not saved");
      expect(lastFrame()).toContain("Editing September 2026"); // stays in edit mode
    });

    it("S with a matching sum saves and exits edit mode", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
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
      expect(lastFrame()).not.toContain("Editing September 2026");
    });

    it("Esc cancels day-edit mode without saving", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      stdin.write("9");
      await flush();
      stdin.write(KEY.escape);
      await flush();
      expect(saveUsageMock).not.toHaveBeenCalled();
      expect(lastFrame()).not.toContain("Editing September 2026");
    });

    it("silently drops a non-numeric buffer instead of corrupting the draft", async () => {
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      stdin.write(".");
      await flush();
      stdin.write(KEY.enter);
      await flush();
      // "." alone parses to NaN — dropped, draft stays at its original seeded total.
      expect(lastFrame()).toContain("allocated $80.94 of $80.94");
    });

    it("only clears the saved month's own days, leaving other months' recorded spend untouched", async () => {
      usageStore = makeUsage({
        days: { "2026-08-10": 99, "2026-09-01": 20, "2026-09-02": 15 },
      });
      const { DashboardApp } = await freshDashboard();
      const { stdin } = render(React.createElement(DashboardApp));
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
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write(KEY.tab); // September -> August (the only other month shown)
      await flush();
      stdin.write("u");
      await flush();
      expect(lastFrame()).toContain("Editing August 2026");
      expect(lastFrame()).toContain("allocated $40.00 of $40.00");
    });

    it("does nothing when hasSpendCap is false — no dollar tracking to edit", async () => {
      configStore = makeConfig({ hasSpendCap: false });
      const { DashboardApp } = await freshDashboard();
      const { stdin, lastFrame } = render(React.createElement(DashboardApp));
      stdin.write("u");
      await flush();
      expect(lastFrame()).not.toContain("Editing");
    });
  });
});
