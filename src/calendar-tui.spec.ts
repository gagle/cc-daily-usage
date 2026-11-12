/* eslint-disable no-control-regex -- these tests assert on ANSI escape sequences */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CalendarModule from "./calendar-tui.js";
import type { CalendarEffects, CalendarModel, CalendarSnapshot, Key } from "./calendar-tui.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

vi.mock("./refresh.js", () => ({ requestApiRefresh: vi.fn() }));

async function fresh(): Promise<typeof CalendarModule> {
  vi.resetModules();
  return import("./calendar-tui.js");
}

const plain = (lines: ReadonlyArray<string>): string =>
  lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

const NOW = new Date("2026-10-07T10:00:00.000Z"); // Wednesday
const ACCOUNT = {
  email: "dev@example.com",
  accountUuid: "uuid-1",
  organizationType: "claude_enterprise",
};
const KEY = "dev_example_com";
const WEEKDAYS = [1, 2, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30];

function accountDir(): string {
  return path.join(fakeHome, ".config", "cc-spend", "accounts", KEY);
}

function seed(config: Partial<Config>, usage: Partial<UsageState> = {}, api?: unknown): void {
  mkdirSync(accountDir(), { recursive: true });
  writeFileSync(
    path.join(accountDir(), "config.json"),
    JSON.stringify({
      monthlyCap: 400,
      laboralDays: { "2026": { "10": WEEKDAYS } },
      hasSpendCap: true,
      ...config,
    }),
  );
  writeFileSync(
    path.join(accountDir(), "usage.json"),
    JSON.stringify({
      schemaVersion: 2,
      monthlySpent: 30,
      periodFrozen: 25,
      lastUpdated: NOW.toISOString(),
      days: { "2026-10-01": 10, "2026-10-02": 15, "2026-09-30": 4 },
      sessions: {
        s1: { lastSeenCost: 1, lastSeenAt: NOW.toISOString(), cacheMissUsd: 0.5 },
        s2: { lastSeenCost: 1, lastSeenAt: NOW.toISOString() },
      },
      ...usage,
    }),
  );
  if (api !== undefined)
    writeFileSync(path.join(accountDir(), "api-cache.json"), JSON.stringify(api));
}

const LEDGER = {
  fetchedAt: NOW.getTime(),
  extraUsage: {
    usedCredits: 30,
    monthlyLimit: 500,
    utilizationPct: 6,
    currency: "USD",
    spendLimitReached: false,
    disabledReason: null,
  },
  fiveHour: null,
  sevenDay: null,
};

interface Harness {
  readonly mod: typeof CalendarModule;
  readonly effects: CalendarEffects & {
    readonly saved: { config: Array<Config>; usage: Array<UsageState> };
  };
  model: CalendarModel;
  press(...keys: Array<Key | string>): CalendarModel | null;
}

async function harness(): Promise<Harness> {
  const mod = await fresh();
  const config = await import("./config.js");
  const saved = { config: [] as Array<Config>, usage: [] as Array<UsageState> };
  const effects = {
    saved,
    saveConfig: (value: Config): void => {
      saved.config.push(value);
      config.saveConfig(KEY, value);
    },
    saveUsage: (value: UsageState): void => {
      saved.usage.push(value);
      config.saveUsage(KEY, value);
    },
    snapshot: (): CalendarSnapshot => mod.computeSnapshot(ACCOUNT, NOW),
    dayBreakdown: (day: string) =>
      day.endsWith("-01")
        ? { day, usd: 0, sessions: [], models: [], projects: [] }
        : {
            day,
            usd: 12.5,
            sessions: [["s1 fix", 10]] as const,
            models: [["claude-opus-5-5", 12.5]] as const,
            projects: [] as const,
          },
  };
  const h: Harness = {
    mod,
    effects,
    model: mod.initialModel(effects.snapshot()),
    press(...keys) {
      let result: CalendarModel | null = h.model;
      for (const key of keys) {
        const parsed = typeof key === "string" ? mod.parseKeys(key) : [key];
        for (const k of parsed) {
          if (result === null) return null;
          result = mod.reduceKey(result, k, effects);
        }
      }
      if (result !== null) h.model = result;
      return result;
    },
  };
  return h;
}

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "cc-spend-calendar-"));
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("pure helpers", () => {
  it("mondayFirstWeekday, moveCursor across months, yearsAvailable", async () => {
    const mod = await fresh();
    expect(mod.mondayFirstWeekday(2026, 10, 5)).toBe(0); // Monday
    expect(mod.mondayFirstWeekday(2026, 10, 4)).toBe(6); // Sunday
    expect(mod.moveCursor({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(mod.daysInMonth(2026, 2)).toBe(28);
    const usage = { days: { "2024-05-01": 1, bad: 2 } } as unknown as UsageState;
    expect(mod.yearsAvailable({ monthlyCap: 1, laboralDays: { "2028": {} } }, usage, NOW)).toEqual([
      2024, 2026, 2028,
    ]);
  });

  it("parseKeys understands arrows, shift-arrows, tab, enter, backspace, esc and chars", async () => {
    const { parseKeys } = await fresh();
    expect(
      parseKeys("\x1b[A\x1b[B\x1b[C\x1b[D\x1bOA\x1bOB\x1bOC\x1bOD").map((k) => k.kind),
    ).toEqual(["up", "down", "right", "left", "up", "down", "right", "left"]);
    expect(parseKeys("\x1b[1;2C\x1b[1;2D\x1b[Z\t\r\n\x7f\b\x03").map((k) => k.kind)).toEqual([
      "shift-right",
      "shift-left",
      "shift-tab",
      "tab",
      "enter",
      "enter",
      "backspace",
      "backspace",
      "ctrl-c",
    ]);
    expect(parseKeys("\x1b")).toEqual([{ kind: "escape" }]);
    expect(parseKeys("\x1b[3~q")).toEqual([{ kind: "char", char: "q" }]); // unknown sequence dropped
    expect(parseKeys("\x01")).toEqual([]); // other control bytes ignored
    // Mouse wheel / clicks (SGR and legacy) are dropped, never read as arrows or chars.
    expect(parseKeys("\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<0;3;4mq")).toEqual([
      { kind: "char", char: "q" },
    ]);
    expect(parseKeys("\x1b[M`!!x")).toEqual([{ kind: "char", char: "x" }]);
  });
});

describe("computeSnapshot", () => {
  it("local cap without a ledger", async () => {
    seed({});
    const { computeSnapshot } = await fresh();
    const snap = computeSnapshot(ACCOUNT, NOW);
    expect(snap.capFromAnthropic).toBe(false);
    expect(snap.computed.monthlyCap).toBe(400);
    expect(snap.computed.todayUsage).toBe(5);
  });

  it("the ledger's limit replaces the cap in memory (admin change shows without a session)", async () => {
    seed({}, {}, LEDGER);
    const { computeSnapshot } = await fresh();
    const snap = computeSnapshot(ACCOUNT, NOW);
    expect(snap.capFromAnthropic).toBe(true);
    expect(snap.config.monthlyCap).toBe(500);
    seed({}, {}, { ...LEDGER, extraUsage: { ...LEDGER.extraUsage, monthlyLimit: 0 } });
    expect(computeSnapshot(ACCOUNT, NOW).capFromAnthropic).toBe(false);
  });

  it("defaults to the current time", async () => {
    seed({});
    const { computeSnapshot } = await fresh();
    expect(computeSnapshot(ACCOUNT).now).toBeInstanceOf(Date);
  });
});

describe("reduceKey", () => {
  it("q / Esc / Ctrl+C exit", async () => {
    seed({});
    const h = await harness();
    expect(h.press("q")).toBeNull();
    expect(h.press({ kind: "escape" })).toBeNull();
    expect(h.press({ kind: "ctrl-c" })).toBeNull();
  });

  it("arrows move, Tab/Shift-Tab change month (wrapping), [ ] and shift-arrows change year", async () => {
    seed({});
    const h = await harness();
    h.press("\x1b[C", "\x1b[B", "\x1b[D", "\x1b[A");
    expect(h.model.cursor).toEqual({ year: 2026, month: 10, day: 7 });
    h.press("\t", "\t", "\t");
    expect(h.model.cursor).toEqual({ year: 2026, month: 1, day: 7 });
    h.press("\x1b[Z");
    expect(h.model.cursor.month).toBe(12);
    h.press("]");
    expect(h.model.cursor.year).toBe(2027); // only one year has data → plain step
    h.press({ kind: "shift-left" }, { kind: "shift-right" }, "[");
    expect(h.model.cursor.year).toBe(2026);
    h.press("x"); // unbound key: nothing but clears a notice
    expect(h.model.notice).toBeNull();
  });

  it("year switching cycles through years that have data", async () => {
    seed({ laboralDays: { "2026": { "10": WEEKDAYS }, "2024": { "2": [29] } } });
    const h = await harness();
    h.press("[");
    expect(h.model.cursor).toEqual({ year: 2024, month: 10, day: 7 });
    h.press("[");
    expect(h.model.cursor.year).toBe(2026);
  });

  it("Space toggles a future day; a past day is locked", async () => {
    seed({});
    const h = await harness();
    h.press("\x1b[C", " "); // Oct 8 → off
    expect(h.effects.saved.config.at(-1)?.laboralDays["2026"]?.["10"]).not.toContain(8);
    h.press("\r"); // back on, sorted
    expect(h.effects.saved.config.at(-1)?.laboralDays["2026"]?.["10"]).toEqual(WEEKDAYS);
    h.press("\x1b[D", "\x1b[D", " "); // Oct 6, past
    expect(h.model.notice).toContain("locked");
    h.press("\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", " "); // Nov 3 — month with no config yet
    expect(h.effects.saved.config.at(-1)?.laboralDays["2026"]?.["11"]).toEqual([3]);
  });

  it("toggling keeps the local cap on disk even when Anthropic's cap is shown", async () => {
    seed({}, {}, LEDGER);
    const h = await harness();
    h.press("\x1b[C", " ");
    expect(h.effects.saved.config.at(-1)?.monthlyCap).toBe(400);
  });

  it("c edits the local cap; invalid input is rejected; Esc cancels", async () => {
    seed({});
    const h = await harness();
    h.press("c");
    expect(h.model.capEdit).toBe("400");
    h.press("\x7f", "\x7f", "\x7f", "5", "0", "0", "x", "\r");
    expect(h.effects.saved.config.at(-1)?.monthlyCap).toBe(500);
    expect(h.model.notice).toBe("Cap saved.");
    h.press("c", "\x7f", "\x7f", "\x7f", "\r");
    expect(h.model.notice).toContain("not changed");
    h.press("c", ".", ".", "\r");
    expect(h.model.notice).toContain("not changed");
    h.press("c", { kind: "escape" });
    expect(h.model.capEdit).toBeNull();
  });

  it("c explains that Anthropic owns the cap", async () => {
    seed({}, {}, LEDGER);
    const h = await harness();
    h.press("c");
    expect(h.model.capEdit).toBeNull();
    expect(h.model.notice).toContain("admin");
  });

  it("u redistributes past days; the sum must match; today/future are live", async () => {
    seed({});
    const h = await harness();
    h.press("u");
    expect(h.model.dayEdit?.draft).toEqual({ "2026-10-01": 10, "2026-10-02": 15 });
    h.press("5"); // cursor on today
    expect(h.model.dayEdit?.warning).toContain("only past days");
    // go to Oct 1 (Thu), type 20 → sum 35 ≠ 25
    h.press("\x1b[A"); // up leaves the month → cursor stays
    expect(h.model.cursor.day).toBe(7);
    h.press(...("\x1b[D".repeat(6).match(/\x1b\[D/g) ?? []), "2", "0", "\r");
    expect(h.model.cursor.day).toBe(1);
    h.press("S");
    expect(h.model.dayEdit?.warning).toContain("needs to equal $25.00");
    // fix Oct 2 to 5: type, then arrow auto-commits
    h.press("\x1b[C", "9", "\x7f", "5", "\x1b[D");
    expect(h.model.cursor).toMatchObject({ month: 10, day: 1 });
    h.press("S");
    expect(h.model.dayEdit).toBeNull();
    expect(h.model.notice).toBe("Saved.");
    expect(h.effects.saved.usage.at(-1)?.days).toEqual({
      "2026-09-30": 4,
      "2026-10-01": 20,
      "2026-10-02": 5,
    });
  });

  it("u: invalid buffer is dropped, Esc cancels, other keys are ignored", async () => {
    seed({});
    const h = await harness();
    h.press("u", ...("\x1b[D".repeat(6).match(/\x1b\[D/g) ?? []), ".", ".", "\r");
    expect(h.model.dayEdit?.draft["2026-10-01"]).toBe(10);
    h.press("1", ...("\x1b[C".repeat(6).match(/\x1b\[C/g) ?? []), "2", "\r"); // live day: refused
    h.press("z", "\t");
    expect(h.model.dayEdit).not.toBeNull();
    h.press({ kind: "escape" });
    expect(h.model.dayEdit).toBeNull();
  });

  it("u on a future month has nothing to edit; a past month is fully editable", async () => {
    seed({});
    const h = await harness();
    h.press("\t", "u");
    expect(h.model.notice).toContain("Nothing to edit");
    h.press("\x1b[Z", "\x1b[Z", "u");
    expect(h.model.dayEdit?.draft).toEqual({ "2026-09-30": 4 });
    expect(h.mod.poolForMonth(h.model, { year: 2026, month: 9 })).toBe(4);
  });
});

describe("day detail", () => {
  it("d opens the cursor day's breakdown, follows the cursor, Esc or d closes it", async () => {
    const h = await harness();
    h.press("d");
    const text = plain(h.mod.renderCalendar(h.model, { color: false }));
    expect(text).toMatch(/2026-10-\d\d · \$12\.50 API-equivalent, from transcripts/);
    expect(text).toContain("  sessions  s1 fix $10.00");
    expect(text).toContain("  models    opus-5-5 $12.50");
    expect(text).toContain("  projects  —");
    expect(text).toContain("d day detail");
    h.press("\x1b[D");
    expect(h.model.detail?.day).not.toBeUndefined();
    h.model = { ...h.model, cursor: { ...h.model.cursor, day: 2 } };
    h.press("\x1b[D");
    expect(plain(h.mod.renderCalendar(h.model, { color: false }))).toContain(
      "no transcript spend indexed",
    );
    expect(h.press("\x1b")?.detail).toBeNull(); // Esc closes the detail, not the calendar
    h.press("d");
    expect(h.press("d")?.detail).toBeNull();
    h.press("\x1b[C");
    expect(h.model.detail).toBeNull();
  });
});

describe("renderCalendar", () => {
  it("stats, today marker, past/laboral styling, hints and footer", async () => {
    seed({});
    const h = await harness();
    const text = plain(h.mod.renderCalendar(h.model, { color: false }));
    expect(text).toContain("Year 2026");
    expect(text).toContain("Today:      $5.00 / $20.84  (24%)  ·  Coast");
    expect(text).toContain("This month: $30.00 / $400.00  (8%)  cap: local");
    expect(text).toContain("Day-1 max:  $18.19  (400 / 22)");
    expect(text).toContain("Real avg:");
    expect(text).toContain("Cache re-paid today: ~$0.50");
    expect(text).toContain(" 7 today");
    expect(text).toContain("•$5.00");
    expect(text).toContain("Day 7 · laboral");
    expect(text).toContain("q quit");
    const colored = h.mod.renderCalendar(h.model, { color: true }).join("\n");
    expect(colored).toContain("\x1b[1;4;36;7m"); // today + cursor
    expect(colored).toContain("\x1b[2;32m"); // a past laboral day is dimmed
  });

  it("off day, past-day hint, off-day hint, banners and edit states", async () => {
    seed({ laboralDays: { "2026": { "10": [1, 2] } } }, { sessions: {} });
    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({
        overageCreditGrantCache: {
          "uuid-1": {
            info: {
              available: true,
              eligible: true,
              granted: false,
              amount_minor_units: 2500,
              currency: "USD",
            },
          },
        },
      }),
    );
    const h = await harness();
    let text = plain(h.mod.renderCalendar(h.model, { color: false }));
    expect(text).toContain("Today:      $5.00  (off day)");
    expect(text).toContain("No laboral days left this month");
    expect(text).toContain("$25.00 credit grant available");
    expect(text).toContain("Day 7 · off");
    h.press("\x1b[D");
    text = plain(h.mod.renderCalendar(h.model, { color: false }));
    expect(text).toContain("Day 6 · past · locked");
    h.press("c");
    expect(plain(h.mod.renderCalendar(h.model, { color: false }))).toContain("Monthly cap: $400_");
    h.press({ kind: "escape" }, "u", "1");
    text = plain(h.mod.renderCalendar(h.model, { color: false }));
    expect(text).toContain("Redistributing October 2026 past days: allocated $26.00 of $25.00");
    expect(text).toContain("$1_");
    expect(text).toContain("Editing day 6 $");
    h.press("S");
    text = plain(h.mod.renderCalendar(h.model, { color: false }));
    expect(text).toContain("needs to equal");
    h.press("\x1b[C");
    expect(plain(h.mod.renderCalendar(h.model, { color: false }))).toContain("Day 7 is live");
  });

  it("Anthropic cap label, a notice line, and no OAuth account", async () => {
    seed({}, {}, LEDGER);
    const h = await harness();
    h.press("c");
    const text = plain(h.mod.renderCalendar(h.model, { color: false }));
    expect(text).toContain("cap: Anthropic");
    expect(text).toContain("an admin changes it there");
    const snap = h.mod.computeSnapshot(null, NOW);
    expect(plain(h.mod.renderCalendar(h.mod.initialModel(snap), { color: false }))).toContain(
      "Year 2026",
    );
  });

  it("Madrid, 01:00 on Oct 1: laboral locally, but the budget period is still September", async () => {
    vi.stubEnv("TZ", "Europe/Madrid");
    seed({});
    const { computeSnapshot, initialModel, renderCalendar } = await fresh();
    const snap = computeSnapshot(ACCOUNT, new Date("2026-09-30T23:00:00.000Z"));
    const text = plain(renderCalendar(initialModel(snap), { color: false }));
    expect(text).toMatch(/Today: {6}\$\d+\.\d{2}\n/); // no pace, not "off day"
    expect(text).toContain("October 2026");
  });

  it("over-budget laboral day and a month with no laboral days", async () => {
    seed({ monthlyCap: 10 }, { periodFrozen: 25 });
    const h = await harness();
    expect(plain(h.mod.renderCalendar(h.model, { color: false }))).toContain("/ $0.00  (over)");
    seed({ laboralDays: {} });
    const empty = await harness();
    const text = plain(empty.mod.renderCalendar(empty.model, { color: false }));
    expect(text).toContain("No laboral days configured for October 2026");
    expect(text).not.toContain("Day-1 max");
  });
});
