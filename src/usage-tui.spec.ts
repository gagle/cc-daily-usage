import type * as Ink from "ink";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const loadUsageMock = vi.fn();

vi.mock("./config.js", () => ({
  loadConfig: () => loadConfigMock(),
  loadUsage: () => loadUsageMock(),
}));

const exitMock = vi.fn();
vi.mock("ink", async (importOriginal) => {
  const actual = await importOriginal<typeof Ink>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

// Frozen "now" (day 5) plus laboral days spanning the whole month, so remainingLaboralDays > 0
// regardless of which day of September the test suite happens to run — deterministic, not lucky.
const NOW = new Date("2026-09-05T12:00:00.000Z");
const BASE_CONFIG = {
  monthlyCap: 200,
  laboralDays: { "2026": { "9": Array.from({ length: 30 }, (_, index) => index + 1) } },
};
const BASE_USAGE = {
  monthlySpent: 78.4,
  lastUpdated: NOW.toISOString(),
  days: {},
  sessions: {},
  frozenForDate: null,
  frozenAvgPerDay: null,
  frozenSafeMonthTotal: null,
};

const ESC = String.fromCharCode(27);
const ESCAPE_FLUSH_MS = 25; // ink's own pending-escape flush timer is 20ms

describe("usage-tui", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // rolloverIfNeeded mutates the usage object it's given (frozenForDate/frozenAvgPerDay), exactly like
    // a real usage.json read never would across calls — return a fresh clone every time to match that.
    loadConfigMock.mockImplementation(() => structuredClone(BASE_CONFIG));
    loadUsageMock.mockImplementation(() => structuredClone(BASE_USAGE));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("computeSnapshot reads config/usage and rolls over into a ComputedUsage snapshot", async () => {
    const { computeSnapshot } = await import("./usage-tui.js");
    const snapshot = computeSnapshot();
    expect(snapshot.monthlyCap).toBe(200);
    expect(snapshot.monthlySpent).toBe(78.4);
    expect(snapshot.avgPerDay).not.toBeNull();
  });

  it("renders the today row when laboral days are configured for the current month", async () => {
    const { render } = await import("ink-testing-library");
    const { UsageDashboard } = await import("./usage-tui.js");
    const instance = render(React.createElement(UsageDashboard));
    expect(instance.lastFrame()).toContain("Today:");
    expect(instance.lastFrame()).toContain("This month:");
    instance.unmount();
  });

  it("omits the today row when laboral days aren't configured for the current month (null avg)", async () => {
    loadConfigMock.mockImplementation(() => ({ monthlyCap: 200, laboralDays: {} }));
    const { render } = await import("ink-testing-library");
    const { UsageDashboard } = await import("./usage-tui.js");
    const instance = render(React.createElement(UsageDashboard));
    expect(instance.lastFrame()).not.toContain("Today:");
    expect(instance.lastFrame()).toContain("This month:");
    instance.unmount();
  });

  it("ignores keys other than 'q'/escape", async () => {
    const { render } = await import("ink-testing-library");
    const { UsageDashboard } = await import("./usage-tui.js");
    const instance = render(React.createElement(UsageDashboard));
    instance.stdin.write("x");
    expect(exitMock).not.toHaveBeenCalled();
    instance.unmount();
  });

  it("exits on 'q'", async () => {
    const { render } = await import("ink-testing-library");
    const { UsageDashboard } = await import("./usage-tui.js");
    const instance = render(React.createElement(UsageDashboard));
    instance.stdin.write("q");
    expect(exitMock).toHaveBeenCalled();
    instance.unmount();
  });

  it("exits on escape", async () => {
    const { render } = await import("ink-testing-library");
    const { UsageDashboard } = await import("./usage-tui.js");
    const instance = render(React.createElement(UsageDashboard));
    instance.stdin.write(ESC);
    await vi.advanceTimersByTimeAsync(ESCAPE_FLUSH_MS);
    expect(exitMock).toHaveBeenCalled();
    instance.unmount();
  });

  it("refreshes the snapshot on the polling interval and clears it on unmount", async () => {
    const { render } = await import("ink-testing-library");
    const { UsageDashboard } = await import("./usage-tui.js");
    const instance = render(React.createElement(UsageDashboard));
    const callsAtMount = loadUsageMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    // The setInterval callback re-ran computeSnapshot (a second loadUsage() read) — proves the poll fired
    // and its cleanup is wired, without depending on React/Ink's own render-flush timing under fake timers.
    expect(loadUsageMock.mock.calls.length).toBeGreaterThan(callsAtMount);
    instance.unmount();
    const callsAtUnmount = loadUsageMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(loadUsageMock.mock.calls.length).toBe(callsAtUnmount);
  });
});
