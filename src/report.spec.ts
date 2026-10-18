import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ReportModule from "./report.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

function fresh(): Promise<typeof ReportModule> {
  return import("./report.js");
}

const NOW = new Date("2026-10-07T12:00:00.000Z");

function line(id: string, fields: Record<string, unknown> = {}, model = "claude-opus-5-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    requestId: id,
    sessionId: "s1",
    timestamp: "2026-10-07T10:00:00.000Z",
    cwd: "/work/app",
    message: {
      id,
      model,
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        output_tokens_details: { thinking_tokens: 50_000 },
        server_tool_use: { web_search_requests: 1 },
      },
    },
    ...fields,
  })}\n`;
}

function sessionsMap(sessions: Record<string, number>): void {
  const dir = path.join(fakeHome, ".config", "cc-daily-usage", "accounts", "acct");
  mkdirSync(dir, { recursive: true });
  const at = NOW.toISOString();
  writeFileSync(
    path.join(dir, "sessions-map.json"),
    JSON.stringify({
      schemaVersion: 1,
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([id, costUsd]) => [
          id,
          {
            transcriptPath: null,
            firstSeenAt: at,
            lastSeenAt: at,
            costUsd,
            linesAdded: 0,
            linesRemoved: 0,
          },
        ]),
      ),
    }),
  );
}

async function indexFixtures(): Promise<void> {
  const dir = path.join(fakeHome, ".claude", "projects", "-work-app");
  const agents = path.join(dir, "s1", "subagents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(dir, "s1.jsonl"),
    line("a") +
      line("b", { timestamp: "2026-09-20T10:00:00.000Z" }) +
      line("c", { cwd: "/work/lib" }, "claude-sonnet-5-5"),
  );
  writeFileSync(path.join(agents, "agent-x.jsonl"), line("d"));
  writeFileSync(path.join(agents, "agent-x.meta.json"), JSON.stringify({ agentType: "Explore" }));
  writeFileSync(path.join(dir, "s9.jsonl"), line("e", { sessionId: "s9" }, "claude-future-9"));
  const { runIndexPass } = await import("./transcript-index.js");
  runIndexPass({ now: NOW });
}

beforeEach(() => {
  vi.resetModules();
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccdu-report-"));
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("ranges", () => {
  it("resolves every period to local days and the months it touches", async () => {
    const { resolveRange, monthsOf } = await fresh();
    expect(resolveRange("today", NOW)).toEqual({
      label: "today",
      from: "2026-10-07",
      to: "2026-10-07",
    });
    expect(resolveRange("week", NOW)).toMatchObject({ from: "2026-10-01", to: "2026-10-07" });
    expect(resolveRange("30d", NOW)).toMatchObject({ from: "2026-09-08" });
    expect(resolveRange("month", NOW)).toMatchObject({ label: "2026-10", from: "2026-10-01" });
    expect(resolveRange("2026-02", NOW)).toEqual({
      label: "2026-02",
      from: "2026-02-01",
      to: "2026-02-31",
    });
    expect(resolveRange("2026-13", NOW)).toBeNull();
    expect(resolveRange("soon", NOW)).toBeNull();
    expect(monthsOf({ label: "", from: "2025-11-20", to: "2026-02-01" })).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("uses the local day in other zones", async () => {
    vi.stubEnv("TZ", "Pacific/Auckland");
    const { resolveRange } = await fresh();
    expect(resolveRange("today", NOW)?.from).toBe("2026-10-08");
  });
});

describe("efficiency note", () => {
  it("shares of new work, carry and rewrite, and $ per MTok with its band; none without split rows", async () => {
    const { formatReport } = await fresh();
    const { emptyRollup } = await import("./transcript-parse.js");
    const total = {
      ...emptyRollup(),
      usdInput: 1,
      usdNewWork: 5,
      usdCarry: 4,
      usdRewrite: 1,
      growth: 100_000,
    };
    const base = {
      owner: "acct",
      range: { label: "x", from: "2026-10-01", to: "2026-10-07" },
      by: "model" as const,
      rows: [{ label: "m", rollup: total }],
      total,
      subagentUsd: 0,
      unattributedUsd: 0,
      gaps: [],
      activity: { turnMs: 0, thinkingMs: 0, hookRuns: 0, entrypoints: {} },
    };
    expect(formatReport(base)).toContain(
      "Efficiency: new work 50% · carry 40% · rewrite 10% · $100/MTok of new work (high)",
    );
    const noGrowth = { ...total, growth: 0 };
    expect(formatReport({ ...base, total: noGrowth })).toMatch(/rewrite 10%$/m);
    expect(
      formatReport({ ...base, total: { ...total, usdNewWork: 0, usdCarry: 0, usdRewrite: 0 } }),
    ).not.toContain("Efficiency");
  });
});

describe("dayBreakdown", () => {
  it("one day's $ with top sessions, models and projects; empty for a day with nothing", async () => {
    sessionsMap({ s1: 1 });
    await indexFixtures();
    const { dayBreakdown } = await fresh();
    const day = dayBreakdown("acct", "2026-10-07");
    expect(day.usd).toBeGreaterThan(0);
    expect(day.models.map(([model]) => model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(day.projects.map(([project]) => project)).toEqual(["app", "lib"]);
    expect(day.sessions.map(([label]) => label)).toEqual(["s1 app"]);
    expect(dayBreakdown("acct", "2026-01-01")).toEqual({
      day: "2026-01-01",
      usd: 0,
      sessions: [],
      models: [],
      projects: [],
    });
    expect(dayBreakdown("unattributed", "2026-10-07").sessions.length).toBeGreaterThanOrEqual(0);
  });
});

describe("--by session extras", () => {
  it("$ per 100 changed lines; a session no account map knows", async () => {
    sessionsMap({ s1: 1 });
    await indexFixtures();
    const file = path.join(
      fakeHome,
      ".config",
      "cc-daily-usage",
      "accounts",
      "acct",
      "sessions-map.json",
    );
    const map = JSON.parse(readFileSync(file, "utf8")) as {
      sessions: Record<string, { linesAdded: number }>;
    };
    (map.sessions.s1 as { linesAdded: number }).linesAdded = 200;
    writeFileSync(file, JSON.stringify(map));
    const { buildReport, formatReport, resolveRange } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    const report = buildReport("acct", week, "session");
    const usd = report.rows[0]?.rollup.usdInput ?? 0;
    expect(report.rows[0]?.usdPer100Lines).toBeCloseTo(usd / 2);
    expect(formatReport(report)).toContain(`$${(usd / 2).toFixed(2)}`);
    const unclaimed = buildReport("unattributed", week, "session");
    expect(unclaimed.rows.every((row) => row.usdPer100Lines === null)).toBe(true);
  });
});

describe("parseReportArgs", () => {
  it("defaults, flags and errors", async () => {
    const { parseReportArgs } = await fresh();
    expect(parseReportArgs([])).toEqual({
      period: "week",
      by: "model",
      json: false,
      account: null,
      chart: false,
      session: null,
    });
    expect(parseReportArgs(["2026-09", "--by", "day", "--json", "--account", "k"])).toEqual({
      period: "2026-09",
      by: "day",
      json: true,
      account: "k",
      chart: false,
      session: null,
    });
    expect(parseReportArgs(["--chart", "--session", "ab12"])).toMatchObject({
      chart: true,
      session: "ab12",
    });
    expect(parseReportArgs(["--session"])).toContain("--session needs a session id");
    expect(parseReportArgs(["--by", "colour"])).toContain("--by needs one of");
    expect(parseReportArgs(["--by"])).toContain("--by needs one of");
    expect(parseReportArgs(["--account"])).toBe("--account needs an account key");
    expect(parseReportArgs(["--nope"])).toBe("Unknown report argument: --nope");
  });
});

describe("buildReport / formatReport", () => {
  it("groups by each dimension, ranks by $, notes subagents, unattributed and unpriced", async () => {
    sessionsMap({ s1: 3 * 6 });
    await indexFixtures();
    const { buildReport, formatReport, resolveRange } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");

    const byModel = buildReport("acct", week, "model");
    expect(byModel.rows.map((row) => row.label)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(byModel.subagentUsd).toBeCloseTo(6.01); // + one web search
    expect(byModel.unattributedUsd).toBeCloseTo(0.01); // unpriced model: only its web search has a price
    const text = formatReport(byModel);
    expect(text).toContain("API-equivalent estimate");
    expect(text).toMatch(/Subagents \$6\.01 \(4\d%\)/);
    expect(text).toContain("thinking $");

    expect(buildReport("acct", week, "project").rows.map((row) => row.label)).toEqual([
      "app",
      "lib",
    ]);
    expect(buildReport("acct", week, "subagent").rows.map((row) => row.label)).toEqual([
      "main",
      "Explore",
    ]);
    expect(buildReport("acct", week, "day").rows.map((row) => row.label)).toEqual(["2026-10-07"]);
    expect(buildReport("acct", week, "component").rows.map((row) => row.label)).toEqual([
      "input",
      "output",
      "cache read",
      "cache write",
    ]);
    expect(buildReport("acct", week, "session").rows[0]?.label).toBe("s1 app");

    // --by session: share of the week from $ per 1%, $ per 100 changed lines from the statusline map
    const sessions = buildReport("acct", week, "session", 2);
    expect(sessions.rows[0]?.weekPct).toBeCloseTo((sessions.rows[0]?.rollup.usdInput ?? 0) / 2);
    expect(sessions.rows[0]?.usdPer100Lines).toBeNull(); // no lines changed
    const sessionText = formatReport(sessions);
    expect(sessionText).toMatch(/% of week +\$\/100 lines/);
    expect(sessionText).toMatch(/s1 app +— +— +— +— +\$\d+\.\d\d +≈\d+\.\d% +—/);
    expect(buildReport("acct", week, "session", 0).rows[0]?.weekPct).toBeNull();
    expect(buildReport("acct", week, "session").rows[0]?.weekPct).toBeNull();
    expect(formatReport(buildReport("acct", week, "session"))).toMatch(/s1 app .* — +—$/m);

    // --chart: one stacked bar per row scaled to the largest, a legend, days in time order
    const chart = formatReport(byModel, { chart: true, color: false });
    expect(chart).toMatch(/claude-opus-5-5 .* [iorws]{30}$/m);
    expect(chart).toMatch(/claude-sonnet-5-5 .* [iorws]{1,29}$/m);
    expect(chart).toContain(
      "chart: i input · o output · r cache read · w cache write · s web search",
    );
    expect(formatReport(byModel, { chart: true, color: true })).toContain("\x1b[38;2;");
    const twoDays = {
      ...byModel,
      by: "day" as const,
      rows: [
        { label: "2026-10-07", rollup: byModel.total },
        {
          label: "2026-10-06",
          rollup: {
            ...byModel.total,
            usdInput: 0,
            usdOutput: 0,
            usdCacheRead: 0,
            usdCacheWrite: 0,
            webSearches: 0,
          },
        },
      ],
    };
    const days = formatReport(twoDays, { chart: true, color: false }).split("\n");
    expect(days[1]).toMatch(/^2026-10-06 .*\$0\.00$/); // a $0 day has no bar
    expect(days[2]).toMatch(/^2026-10-07 /);
    expect(formatReport({ ...byModel, rows: [] }, { chart: true, color: false })).toMatch(
      /^No usage/,
    );
    expect(byModel.activity).toEqual({ turnMs: 0, thinkingMs: 0, hookRuns: 0, entrypoints: {} });
    expect(text).not.toContain("Turn time");
    const busy = formatReport({
      ...byModel,
      activity: {
        turnMs: 11_520_000,
        thinkingMs: 30_000,
        hookRuns: 12,
        entrypoints: { cli: 3, "sdk-ts": 5 },
      },
    });
    expect(busy).toContain(
      "Turn time 3h12m (thinking <1m) · 12 hook runs · started from sdk-ts 5, cli 3",
    );
    expect(
      formatReport({
        ...byModel,
        activity: { turnMs: 0, thinkingMs: 2_400_000, hookRuns: 0, entrypoints: {} },
      }),
    ).toContain("Turn time <1m (thinking 40m)");

    const month = resolveRange("30d", NOW);
    if (!month) throw new Error("range");
    expect(buildReport("acct", month, "day").rows).toHaveLength(2);

    const stray = buildReport("unattributed", week, "model");
    expect(stray.rows[0]?.rollup.unpricedTurns).toBe(1);
    expect(stray.gaps).toEqual([]);
    expect(formatReport(stray)).toContain("totals are a floor");
  });

  it("a session row uses Claude Code's session name; activity counts sessions in range", async () => {
    sessionsMap({ s1: 1 });
    const mapFile = path.join(
      fakeHome,
      ".config",
      "cc-daily-usage",
      "accounts",
      "acct",
      "sessions-map.json",
    );
    const map = JSON.parse(readFileSync(mapFile, "utf8")) as {
      sessions: Record<string, Record<string, unknown>>;
    };
    map.sessions.s1 = { ...map.sessions.s1, name: "fix login" };
    writeFileSync(mapFile, JSON.stringify(map));
    const dir = path.join(fakeHome, ".claude", "projects", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "s1.jsonl"),
      line("a", { entrypoint: "cli", thinkingDurationMs: 60_000 }) +
        `${JSON.stringify({ type: "system", subtype: "turn_duration", sessionId: "s1", durationMs: 120_000 })}\n`,
    );
    const { runIndexPass } = await import("./transcript-index.js");
    runIndexPass({ now: NOW });
    const { buildReport, resolveRange } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    const report = buildReport("acct", week, "session");
    expect(report.rows[0]?.label).toBe("s1 fix login");
    expect(report.activity).toEqual({
      turnMs: 120_000,
      thinkingMs: 60_000,
      hookRuns: 0,
      entrypoints: { cli: 1 },
    });
  });

  it("activityOf counts a session from an older index as zero time", async () => {
    const { activityOf } = await fresh();
    const legacy = {
      firstAt: "",
      lastAt: "",
      project: "",
      branch: "",
      models: [],
      turns: 1,
      usd: 0,
      unpricedTurns: 0,
      subagentUsd: 0,
    };
    expect(activityOf([legacy])).toEqual({
      turnMs: 0,
      thinkingMs: 0,
      hookRuns: 0,
      entrypoints: {},
    });
  });

  it("flags a price gap over 5% and names its models; sessions out of range are ignored", async () => {
    sessionsMap({ s1: 1 });
    await indexFixtures();
    const { buildReport, formatReport, resolveRange, selfCheck } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    const report = buildReport("acct", week, "model");
    expect(report.gaps).toEqual([
      "price table may be stale for claude-opus-5-5",
      "price table may be stale for claude-sonnet-5-5",
    ]);
    expect(formatReport(report)).toContain("price table may be stale");
    const session = {
      firstAt: "",
      lastAt: "2026-01-01T00:00:00.000Z",
      project: "",
      branch: "",
      models: ["m"],
      turns: 1,
      usd: 9,
      unpricedTurns: 0,
      subagentUsd: 0,
    };
    const seen = {
      transcriptPath: null,
      firstSeenAt: "",
      lastSeenAt: "",
      costUsd: 1,
      linesAdded: 0,
      linesRemoved: 0,
    };
    expect(selfCheck({ old: session }, { old: seen }, week)).toEqual([]);
    expect(
      selfCheck(
        { x: { ...session, lastAt: NOW.toISOString(), unpricedTurns: 1 } },
        { x: seen },
        week,
      ),
    ).toEqual([]);
    expect(
      selfCheck({ y: { ...session, lastAt: NOW.toISOString(), usd: 1.004 } }, { y: seen }, week),
    ).toEqual([]);
  });

  it("an account sees the unattributed $ as a note; an empty range says so", async () => {
    const dir = path.join(fakeHome, ".claude", "projects", "-p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "s5.jsonl"), line("z", { sessionId: "s5" }));
    const { runIndexPass } = await import("./transcript-index.js");
    runIndexPass({ now: NOW });
    const { buildReport, formatReport, resolveRange, hasUnpricedTurns } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    const report = buildReport("acct", week, "model");
    expect(report.unattributedUsd).toBeCloseTo(6.01);
    expect(formatReport(report)).toMatch(/^No usage in last 7 days\./);
    const withRows = { ...report, rows: [{ label: "x", rollup: report.total }] };
    expect(formatReport(withRows)).toContain("$6.01 more in sessions no account claimed");
    expect(hasUnpricedTurns("acct", NOW)).toBe(false);
    expect(formatReport({ ...withRows, unattributedUsd: 0 })).toContain("Subagents $0.00 (0%)");
  });

  it("hasUnpricedTurns sees an unpriced model in the last 30 days", async () => {
    sessionsMap({ s9: 0 });
    await indexFixtures();
    const { hasUnpricedTurns } = await fresh();
    expect(hasUnpricedTurns("acct", NOW)).toBe(true);
  });

  it("a row with no project path shows (unknown)", async () => {
    sessionsMap({ s1: 0 });
    const dir = path.join(fakeHome, ".claude", "projects", "-p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "s1.jsonl"),
      line("q", { cwd: "" }) +
        line("r", {}, "claude-opus-5-5").replace('"usage":{', '"usage":{"speed":"fast",'),
    );
    const { runIndexPass } = await import("./transcript-index.js");
    runIndexPass({ now: NOW });
    const { buildReport, resolveRange } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    expect(
      buildReport("acct", week, "project")
        .rows.map((row) => row.label)
        .sort(),
    ).toEqual(["(unknown)", "app"]);
    expect(buildReport("acct", week, "model").rows.map((row) => row.label)).toContain(
      "claude-opus-5-5 (fast)",
    );
  });
});
