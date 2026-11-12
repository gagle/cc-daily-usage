import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as StoreModule from "./record-store.js";
import { emptyRollup, type Rollup, rowKey } from "./transcript-parse.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

function fresh(): Promise<typeof StoreModule> {
  return import("./record-store.js");
}

const NOW = new Date("2026-11-12T12:00:00.000Z");

function accountPath(...parts: Array<string>): string {
  const file = path.join(fakeHome, ".config", "cc-spend", "accounts", "acct", ...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value));
}

function row(fields: Partial<Rollup>): Rollup {
  return { ...emptyRollup(), ...fields };
}

function session(lastAt: string, turnMs = 0): Record<string, unknown> {
  return {
    firstAt: lastAt,
    lastAt,
    project: "/work/app",
    branch: "main",
    models: ["claude-opus-5-5"],
    turns: 1,
    usd: 1,
    unpricedTurns: 0,
    subagentUsd: 0,
    turnMs,
  };
}

/** An index for acct: two days in range, one before; a subagent row, a fast row, an unpriced turn. */
function writeIndex(): void {
  const key = (day: string, scope = "main", speed: "standard" | "fast" = "standard"): string =>
    rowKey({ day, project: "/work/app", model: "claude-opus-5-5", scope, speed });
  writeJson(accountPath("index", "2026-11.json"), {
    schemaVersion: 1,
    rows: {
      [key("2026-11-04")]: row({ turns: 1, usdInput: 999 }),
      [key("2026-11-05")]: row({
        turns: 4,
        input: 100,
        cacheRead: 800,
        cacheWrite: 100,
        growth: 1_000_000,
        usdInput: 10,
        usdCacheRead: 20,
        usdCarry: 20,
        usdRewrite: 5,
      }),
      [key("2026-11-06", "subagent:Explore")]: row({ turns: 2, usdOutput: 5, unpricedTurns: 1 }),
      [key("2026-11-06", "main", "fast")]: row({ turns: 1, usdOutput: 10 }),
    },
  });
  writeJson(accountPath("index", "sessions.json"), {
    schemaVersion: 1,
    sessions: {
      a: session("2026-11-05T10:00:00.000Z", 3_600_000),
      b: { ...session("2026-11-06T10:00:00.000Z"), turnMs: undefined },
      old: session("2026-11-01T10:00:00.000Z", 99),
    },
  });
  writeJson(accountPath("index", "habits.json"), {
    schemaVersion: 1,
    days: {
      "2026-11-04": { prompt: 50 },
      "2026-11-05": { prompt: 3, clear: 1 },
      "2026-11-06": { prompt: 2 },
    },
  });
  writeJson(accountPath("usage.json"), {
    schemaVersion: 2,
    monthlySpent: 0,
    periodFrozen: 0,
    lastUpdated: NOW.toISOString(),
    days: {},
    sessions: {},
    apiEqDays: {},
    apiEqTotal: 0,
    missCauses: {
      "2026-11-05": { "likely server side": { count: 2, usd: 4 } },
      "2026-10-01": { "likely server side": { count: 9, usd: 90 } },
    },
  });
  writeJson(accountPath("limits.json"), {
    schemaVersion: 1,
    samples: [
      { t: Date.UTC(2026, 10, 4, 23), fiveHourPct: 99, sevenDayPct: 99, apiEqTotal: 0 },
      { t: Date.UTC(2026, 10, 5, 1), fiveHourPct: 30, sevenDayPct: null, apiEqTotal: 0 },
      { t: Date.UTC(2026, 10, 6, 23), fiveHourPct: 10, sevenDayPct: 40, apiEqTotal: 0 },
      { t: Date.UTC(2026, 10, 7, 0), fiveHourPct: 99, sevenDayPct: 99, apiEqTotal: 0 },
    ],
  });
}

beforeEach(() => {
  vi.resetModules();
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccs-record-"));
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("records.json", () => {
  it("round trip; missing, garbled and newer files read empty; a newer one is never overwritten", async () => {
    const { loadRecords, saveRecords, recordsFile } = await fresh();
    const { emptyRecords } = await import("./record.js");
    const { listNewerFiles } = await import("./config.js");
    expect(loadRecords("acct")).toEqual(emptyRecords());
    accountPath("x");
    saveRecords("acct", { ...emptyRecords(), days: 14 });
    expect(loadRecords("acct").days).toBe(14);
    expect(JSON.parse(readFileSync(recordsFile("acct"), "utf8"))).toMatchObject({
      schemaVersion: 1,
    });
    writeFileSync(recordsFile("acct"), "{nope");
    expect(loadRecords("acct")).toEqual(emptyRecords());
    const newer = JSON.stringify({ schemaVersion: 2, records: { days: 3 } });
    writeFileSync(recordsFile("acct"), newer);
    expect(loadRecords("acct")).toEqual(emptyRecords());
    expect(listNewerFiles()).toContain(recordsFile("acct"));
    saveRecords("acct", emptyRecords());
    expect(readFileSync(recordsFile("acct"), "utf8")).toBe(newer);
  });
});

describe("snapshotFor", () => {
  it("sums the range's rows, sessions, habits, rules and limit peaks", async () => {
    writeIndex();
    const { snapshotFor } = await fresh();
    const snapshot = snapshotFor("acct", "2026-11-05", "2026-11-06", 2, NOW);
    expect(snapshot).toMatchObject({
      from: "2026-11-05",
      to: "2026-11-06",
      days: 2,
      usd: 45,
      isFloor: true,
      input: 100,
      cacheRead: 800,
      cacheWrite: 100,
      growth: 1_000_000,
      usdCarry: 20,
      usdRewrite: 5,
      subagentUsd: 5,
      turns: 7,
      sessions: 2,
      activeMs: 3_600_000,
      habits: { prompt: 5, clear: 1, interrupt: 0, model: 0, compact: 0, autoCompact: 0 },
      models: { "claude-opus-5-5": 45 },
      peak5h: 30,
      peak7d: 40,
    });
    expect(snapshot.rules.R2).toBeGreaterThan(0); // fast mode surcharge
    expect(snapshot.rules.R4).toBe(4); // cache misses of the range's days only
  });

  it("an empty range: zeros, no habits, no peaks", async () => {
    const { snapshotFor } = await fresh();
    expect(snapshotFor("acct", "2026-10-01", "2026-10-07", 7, NOW)).toMatchObject({
      usd: 0,
      turns: 0,
      habits: null,
      rules: {},
      peak5h: null,
      peak7d: null,
      isFloor: false,
    });
  });
});

describe("advanceRecord and recordFeed", () => {
  it("starts record #1 with a baseline, saves only on a change, closes it a week later", async () => {
    writeIndex();
    const { advanceRecord, loadRecords, recordFeed, recordsFile } = await fresh();
    const started = advanceRecord("acct", new Date("2026-11-12T08:00:00.000Z"));
    expect(started.baseline).toMatchObject({ from: "2026-11-05", to: "2026-11-11", usd: 45 });
    expect(started.current).toMatchObject({ n: 1, from: "2026-11-12", focus: "R2" });
    expect(loadRecords("acct")).toEqual(started);
    writeFileSync(
      recordsFile("acct"),
      JSON.stringify({ schemaVersion: 1, records: started }) + " ",
    );
    advanceRecord("acct", NOW);
    expect(readFileSync(recordsFile("acct"), "utf8").endsWith(" ")).toBe(true); // unchanged: not rewritten
    expect(recordFeed("acct")).toEqual({ notice: null });
    // A record with turns closes the day after its end.
    const key = rowKey({
      day: "2026-11-13",
      project: "/w",
      model: "claude-opus-5-5",
      scope: "main",
      speed: "standard",
    });
    const month = JSON.parse(readFileSync(accountPath("index", "2026-11.json"), "utf8")) as {
      rows: Record<string, Rollup>;
    };
    month.rows[key] = row({ turns: 1, usdInput: 1 });
    writeJson(accountPath("index", "2026-11.json"), month);
    const closed = advanceRecord("acct", new Date("2026-11-19T08:00:00.000Z"));
    expect(closed.unseen).toBe(1);
    expect(closed.current).toMatchObject({ n: 2, from: "2026-11-19" });
    expect(recordFeed("acct").notice).toMatch(/^record #1 done/);
  });
});

describe("parseRecordArgs", () => {
  it("--all, --json, --days N; errors", async () => {
    const { parseRecordArgs } = await fresh();
    expect(parseRecordArgs([])).toEqual({ all: false, json: false, days: null });
    expect(parseRecordArgs(["--all", "--json", "--days", "14"])).toEqual({
      all: true,
      json: true,
      days: 14,
    });
    expect(parseRecordArgs(["--days"])).toContain("--days needs");
    expect(parseRecordArgs(["--days", "0"])).toContain("--days needs");
    expect(parseRecordArgs(["--days", "91"])).toContain("--days needs");
    expect(parseRecordArgs(["--days", "2.5"])).toContain("--days needs");
    expect(parseRecordArgs(["--x"])).toBe("Unknown record argument: --x");
  });
});

describe("recordView", () => {
  it("the live snapshot so far and the closed record to show; marks it seen", async () => {
    writeIndex();
    const { recordView } = await fresh();
    const { emptyRecords } = await import("./record.js");
    expect(recordView("acct", emptyRecords(), NOW).view).toMatchObject({
      live: null,
      closedNow: null,
    });
    const current = { n: 2, from: "2026-11-05", to: "2026-11-11", focus: null, focusShare: null };
    const one = { ...current, n: 1 };
    const { view, seen } = recordView(
      "acct",
      { ...emptyRecords(), current, closed: [one], unseen: 1 },
      new Date("2026-11-06T12:00:00.000Z"),
    );
    expect(view.live).toMatchObject({ from: "2026-11-05", to: "2026-11-06", days: 2, usd: 45 });
    expect(view.closedNow).toBe(one);
    expect(seen.unseen).toBeNull();
    expect(recordView("acct", { ...emptyRecords(), unseen: 7 }, NOW).view.closedNow).toBeNull();
  });
});
