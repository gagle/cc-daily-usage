import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as StatuslineModule from "./statusline.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

const requestApiRefreshMock = vi.fn();
vi.mock("./refresh.js", () => ({
  requestApiRefresh: (...args: Array<unknown>) => requestApiRefreshMock(...args) as unknown,
}));

async function fresh(): Promise<typeof StatuslineModule> {
  vi.resetModules();
  return import("./statusline.js");
}

const NOW = new Date("2026-10-07T10:00:00.000Z"); // a Wednesday
const KEY = "dev_example_com";

function accountDir(): string {
  return path.join(fakeHome, ".config", "cc-daily-usage", "accounts", KEY);
}

function writeAccount(organizationType: string | undefined): void {
  writeFileSync(
    path.join(fakeHome, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "dev@example.com", organizationType } }),
  );
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(accountDir(), { recursive: true });
  writeFileSync(path.join(accountDir(), name), JSON.stringify(value));
}

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(accountDir(), name), "utf8")) as Record<string, unknown>;
}

const OCTOBER_WEEKDAYS = [
  1, 2, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30,
];

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-statusline-"));
  requestApiRefreshMock.mockReset();
  vi.stubEnv("TZ", "UTC");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("parsePayload", () => {
  it("objects pass through; garbage, arrays, null and empty become {}", async () => {
    const { parsePayload } = await fresh();
    expect(parsePayload('{"session_id":"s"}')).toEqual({ session_id: "s" });
    expect(parsePayload("")).toEqual({});
    expect(parsePayload("{oops")).toEqual({});
    expect(parsePayload("[1]")).toEqual({});
    expect(parsePayload("null")).toEqual({});
  });
});

describe("mergeRateLimitWindow", () => {
  it("absent window keeps the prior side", async () => {
    const { mergeRateLimitWindow } = await fresh();
    expect(mergeRateLimitWindow(undefined, 10, 99)).toEqual({ pct: 10, resetsAt: 99 });
    expect(mergeRateLimitWindow(undefined, undefined, undefined)).toEqual({
      pct: null,
      resetsAt: null,
    });
  });

  it("present window is authoritative; ≥100% without resets_at keeps the prior reset", async () => {
    const { mergeRateLimitWindow } = await fresh();
    expect(mergeRateLimitWindow({ used_percentage: 5, resets_at: 7 }, 1, 2)).toEqual({
      pct: 5,
      resetsAt: 7,
    });
    expect(mergeRateLimitWindow({ used_percentage: 100 }, 90, 2)).toEqual({
      pct: 100,
      resetsAt: 2,
    });
    expect(mergeRateLimitWindow({ used_percentage: 100 }, 90, undefined)).toEqual({
      pct: 100,
      resetsAt: null,
    });
    expect(mergeRateLimitWindow({ used_percentage: 40 }, 90, 2)).toEqual({
      pct: 40,
      resetsAt: null,
    });
    expect(mergeRateLimitWindow({}, 90, 2)).toEqual({ pct: null, resetsAt: null });
  });
});

describe("resolveRateLimits", () => {
  const nowSec = NOW.getTime() / 1000;
  const cache = {
    fiveHourPct: 10,
    sevenDayPct: 20,
    fiveHourResetsAt: nowSec + 100,
    sevenDayResetsAt: nowSec - 1, // already reset
    seenAt: NOW.getTime() - 120_000,
  };
  const api = {
    fetchedAt: NOW.getTime() - 30_000,
    extraUsage: null,
    fiveHour: { pct: 33, resetsAt: nowSec + 500 },
    sevenDay: null,
  };

  it("hook data wins and drops a window whose reset passed", async () => {
    const { resolveRateLimits } = await fresh();
    expect(resolveRateLimits(true, cache, api, NOW)).toEqual({
      fiveHourPct: 10,
      sevenDayPct: null,
      fiveHourResetsAt: nowSec + 100,
      sevenDayResetsAt: null,
      source: "hook",
    });
  });

  it("a stale API reading never beats a hook snapshot, but stands in when there is none", async () => {
    const { resolveRateLimits } = await fresh();
    const stale = { ...api, fetchedAt: NOW.getTime(), stale: true };
    expect(resolveRateLimits(false, cache, stale, NOW)).toMatchObject({ source: "cache" });
    expect(resolveRateLimits(false, undefined, stale, NOW)).toMatchObject({
      fiveHourPct: 33,
      source: "api",
    });
  });

  it("without hook data the newer of cache and API wins (fresh at session start)", async () => {
    const { resolveRateLimits } = await fresh();
    expect(resolveRateLimits(false, cache, api, NOW)).toMatchObject({
      fiveHourPct: 33,
      source: "api",
    });
    expect(resolveRateLimits(false, undefined, api, NOW)).toMatchObject({
      fiveHourPct: 33,
      source: "api",
    });
    const older = { ...api, fetchedAt: cache.seenAt - 1 };
    expect(resolveRateLimits(false, cache, older, NOW)).toMatchObject({
      fiveHourPct: 10,
      source: "cache",
    });
    const legacyCache = { ...cache, seenAt: undefined };
    expect(resolveRateLimits(false, legacyCache, api, NOW).source).toBe("api");
  });

  it("an API reading without windows, an expired API window, or nothing at all", async () => {
    const { resolveRateLimits } = await fresh();
    const empty = { ...api, fiveHour: null };
    expect(resolveRateLimits(false, undefined, empty, NOW).source).toBe("none");
    const expired = {
      ...api,
      fiveHour: { pct: 99, resetsAt: nowSec - 5 },
      sevenDay: { pct: 1, resetsAt: null },
    };
    expect(resolveRateLimits(false, undefined, expired, NOW)).toEqual({
      fiveHourPct: null,
      sevenDayPct: 1,
      fiveHourResetsAt: null,
      sevenDayResetsAt: null,
      source: "api",
    });
    expect(resolveRateLimits(false, undefined, null, NOW).source).toBe("none");
    const sevenOnly = { ...api, fiveHour: null, sevenDay: { pct: 4, resetsAt: null } };
    expect(resolveRateLimits(false, undefined, sevenOnly, NOW)).toMatchObject({
      fiveHourPct: null,
      sevenDayPct: 4,
    });
  });
});

describe("buildStatuslineState", () => {
  it("enterprise first run: needs init, local cap, spend captured, refresher requested", async () => {
    writeAccount("claude_enterprise");
    const { buildStatuslineState } = await fresh();
    const state = await buildStatuslineState(
      { session_id: "s1", cost: { total_cost_usd: 2.5 } },
      NOW,
    );
    expect(state).toMatchObject({
      todayUsage: 2.5,
      monthlySpent: 2.5,
      monthlyCap: 200,
      needsInit: true,
      capSource: "local",
      hasSpendCap: true,
      planType: "claude_enterprise",
      extraUsage: null,
      cache: null,
      spendLimitPct: null,
    });
    expect(requestApiRefreshMock).toHaveBeenCalledWith(KEY, NOW);
    const usage = readJson("usage.json");
    expect(usage.lastUpdated).toBe(NOW.toISOString()); // fresh file starts now, no 1970 walk
    expect(usage.days).toEqual({});
  });

  it("laboral day with the ledger: Anthropic's limit becomes the cap, pace fields ship", async () => {
    writeAccount("claude_enterprise");
    writeJson("config.json", {
      monthlyCap: 100,
      laboralDays: { "2026": { "10": OCTOBER_WEEKDAYS } },
    });
    writeJson("api-cache.json", {
      fetchedAt: NOW.getTime(),
      extraUsage: {
        usedCredits: 44,
        monthlyLimit: 440,
        utilizationPct: 10,
        currency: "USD",
        spendLimitReached: false,
        disabledReason: null,
      },
      fiveHour: null,
      sevenDay: null,
    });
    const { buildStatuslineState } = await fresh();
    const state = await buildStatuslineState(
      { session_id: "s1", cost: { total_cost_usd: 9 } },
      NOW,
    );
    expect(state).toMatchObject({
      monthlySpent: 44, // ledger, not the session's 9
      monthlyCap: 440,
      capSource: "anthropic",
      avgPerDay: 24.45, // ceil-cent of 440 / 18 laboral days from Oct 7
      budgetExhausted: false,
      needsInit: false,
      extraUsage: null, // enterprise hides 🎫
    });
    expect(readJson("config.json").monthlyCap).toBe(440);
    await buildStatuslineState({ session_id: "s1", cost: { total_cost_usd: 9 } }, NOW); // already in sync
  });

  it("between ledger readings a known session's growth moves the total; a failed fetch shows its age", async () => {
    writeAccount("claude_enterprise");
    writeJson("config.json", {
      monthlyCap: 100,
      laboralDays: { "2026": { "10": OCTOBER_WEEKDAYS } },
    });
    const readAt = NOW.getTime() - 27 * 60_000;
    const ledger = {
      usedCredits: 44,
      monthlyLimit: 440,
      utilizationPct: 10,
      currency: "USD",
      spendLimitReached: false,
      disabledReason: null,
    };
    writeJson("api-cache.json", {
      fetchedAt: NOW.getTime(),
      extraUsage: ledger,
      fiveHour: null,
      sevenDay: null,
      stale: true,
      readAt,
      failures: 4,
    });
    const { buildStatuslineState } = await fresh();
    const render = (cost: number) =>
      buildStatuslineState({ session_id: "s1", cost: { total_cost_usd: cost } }, NOW);
    expect(await render(9)).toMatchObject({ monthlySpent: 44, ledgerAgeMs: 27 * 60_000 });
    expect(await render(12)).toMatchObject({ monthlySpent: 47 });
    expect(readJson("usage.json").sinceLedger).toEqual({ readAt, usd: 3 });
    // A good reading takes the session spend over: the estimate restarts.
    writeJson("api-cache.json", {
      fetchedAt: NOW.getTime(),
      extraUsage: { ...ledger, usedCredits: 47 },
      fiveHour: null,
      sevenDay: null,
    });
    expect(await render(12)).toMatchObject({ monthlySpent: 47, ledgerAgeMs: null });
  });

  it("a disabled/zero org limit keeps the local cap", async () => {
    writeAccount("claude_team");
    writeJson("config.json", {
      monthlyCap: 100,
      laboralDays: {},
      hasSpendCap: true,
      planType: "claude_team",
    });
    writeJson("api-cache.json", {
      fetchedAt: NOW.getTime(),
      extraUsage: {
        usedCredits: 1,
        monthlyLimit: 0,
        utilizationPct: 0,
        currency: "USD",
        spendLimitReached: false,
        disabledReason: null,
      },
      fiveHour: null,
      sevenDay: null,
    });
    const { buildStatuslineState } = await fresh();
    const state = await buildStatuslineState({}, NOW);
    expect(state).toMatchObject({ monthlyCap: 100, capSource: "local", monthlySpent: 1 });
  });

  it("the v1 cache inside usage.json still feeds the ledger before the first refresh", async () => {
    writeAccount("claude_enterprise");
    writeJson("usage.json", {
      monthlySpent: 0,
      lastUpdated: NOW.toISOString(),
      days: {},
      sessions: {},
      extraUsageCache: {
        fetchedAt: 1,
        data: {
          usedCredits: 7,
          monthlyLimit: 70,
          utilizationPct: 10,
          currency: "USD",
          spendLimitReached: false,
          disabledReason: null,
        },
      },
    });
    const { buildStatuslineState } = await fresh();
    expect(await buildStatuslineState({}, NOW)).toMatchObject({ monthlySpent: 7, monthlyCap: 70 });
  });

  it("Pro: no $ budget, credits and API seat windows ship", async () => {
    writeAccount("claude_pro");
    writeJson("api-cache.json", {
      fetchedAt: NOW.getTime(),
      extraUsage: {
        usedCredits: 2,
        monthlyLimit: 20,
        utilizationPct: 10,
        currency: "USD",
        spendLimitReached: false,
        disabledReason: null,
      },
      fiveHour: { pct: 12, resetsAt: null },
      sevenDay: null,
    });
    const { buildStatuslineState } = await fresh();
    const state = await buildStatuslineState({ session_id: "s", cost: { total_cost_usd: 3 } }, NOW);
    expect(state.monthlyCap).toBeUndefined();
    expect(state.todayUsage).toBeUndefined();
    expect(state.hasSpendCap).toBe(false);
    expect(state.extraUsage?.usedCredits).toBe(2);
    expect(state.rateLimits).toMatchObject({ fiveHourPct: 12, source: "api" });
    expect(readJson("usage.json").monthlySpent).toBe(0); // never accumulates
  });

  it("hook rate_limits are cached with seenAt, and an unchanged snapshot is not rewritten", async () => {
    writeAccount("claude_max");
    const { buildStatuslineState } = await fresh();
    const payload = {
      rate_limits: {
        five_hour: { used_percentage: 40, resets_at: 1 },
        seven_day: { used_percentage: 5 },
        spend_limit: { used_percentage: 61 },
      },
    };
    const state = await buildStatuslineState(payload, NOW);
    expect(state.spendLimitPct).toBe(61);
    expect(state.spendLimitUsd).toBeNull();
    const withUsd = await buildStatuslineState(
      { rate_limits: { spend_limit: { used_percentage: 61, used_usd: 6.1, limit_usd: 10 } } },
      NOW,
    );
    expect(withUsd.spendLimitUsd).toEqual({ used: 6.1, limit: 10, period: null });
    const withPeriod = await buildStatuslineState(
      {
        rate_limits: {
          spend_limit: { used_percentage: 61, used_usd: 6.1, limit_usd: 10, period: "weekly" },
        },
      },
      NOW,
    );
    expect(withPeriod.spendLimitUsd?.period).toBe("weekly");
    expect(state.rateLimitsCache).toMatchObject({
      fiveHourPct: 40,
      sevenDayPct: 5,
      seenAt: NOW.getTime(),
    });
    const later = new Date(NOW.getTime() + 60_000);
    const again = await buildStatuslineState(payload, later);
    expect(again.rateLimitsCache?.seenAt).toBe(NOW.getTime());
    const moved = await buildStatuslineState(
      { rate_limits: { five_hour: { used_percentage: 41, resets_at: 1 } } },
      later,
    );
    expect(moved.rateLimitsCache).toMatchObject({
      fiveHourPct: 41,
      sevenDayPct: 5,
      seenAt: later.getTime(),
    });
  });

  it("unknown org: rate_limits demote the guess to no-cap; without them it stays a cap", async () => {
    writeAccount("something_new");
    const { buildStatuslineState } = await fresh();
    expect((await buildStatuslineState({}, NOW)).hasSpendCap).toBe(true);
    expect((await buildStatuslineState({ rate_limits: {} }, NOW)).hasSpendCap).toBe(false);
    expect((await buildStatuslineState({}, NOW)).hasSpendCap).toBe(false); // stays demoted
  });

  it("a known org re-derives on mismatch and refreshes planType", async () => {
    writeAccount("claude_enterprise");
    writeJson("config.json", {
      monthlyCap: 1,
      laboralDays: {},
      hasSpendCap: false,
      planType: "claude_pro",
    });
    const { buildStatuslineState } = await fresh();
    expect(await buildStatuslineState({}, NOW)).toMatchObject({
      hasSpendCap: true,
      planType: "claude_enterprise",
    });
    writeJson("config.json", {
      monthlyCap: 1,
      laboralDays: {},
      hasSpendCap: true,
      planType: "old",
    });
    expect((await buildStatuslineState({}, NOW)).planType).toBe("claude_enterprise");
  });

  it("no OAuth login: account 'default', planType null, and no refresher", async () => {
    const { buildStatuslineState } = await fresh();
    const state = await buildStatuslineState({ cost: { total_cost_usd: Number.NaN } }, NOW);
    expect(state.planType).toBeNull();
    expect(requestApiRefreshMock).not.toHaveBeenCalled();
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await buildStatuslineState({}, NOW);
    expect(requestApiRefreshMock).toHaveBeenCalledWith("default", NOW);
  });

  it("never writes settings.json on render", async () => {
    writeAccount("claude_pro");
    const settingsFile = path.join(fakeHome, ".claude", "settings.json");
    mkdirSync(path.dirname(settingsFile), { recursive: true });
    const command = `node ${JSON.stringify(path.join(fakeHome, ".claude", "statusline.mjs"))}`;
    const before = JSON.stringify({
      statusLine: { type: "command", command, refreshInterval: 30 },
    });
    writeFileSync(settingsFile, before);
    const { buildStatuslineState } = await fresh();
    const nowSec = NOW.getTime() / 1000;
    await buildStatuslineState(
      {
        session_id: "s1",
        model: { id: "claude-opus-5-5" },
        prompt_cache: {
          warm: true,
          ttl: "5m",
          expires_at: nowSec + 45,
          recache_tokens_if_cold: 1000,
        },
      },
      NOW,
    );
    expect(readFileSync(settingsFile, "utf8")).toBe(before);
  });

  it("stores the session's cache-miss cost when the forecast changes", async () => {
    writeAccount("claude_enterprise");
    const { buildStatuslineState } = await fresh();
    const payload = {
      session_id: "s1",
      model: { id: "claude-opus-5-5" },
      prompt_cache: { warm: true, ttl: "5m", miss_recache_tokens: 1_000_000 },
    };
    const state = await buildStatuslineState(payload, NOW);
    expect(state.cache?.sessionMissUsd).toBe(4.8);
    const sessions = readJson("usage.json").sessions as Record<string, { cacheMissUsd?: number }>;
    expect(sessions.s1?.cacheMissUsd).toBe(4.8);
    expect((sessions.s1 as { cacheGate?: unknown }).cacheGate).toEqual({
      expiresAt: null,
      coldUsd: null,
      warmUsd: 0,
    });
    await buildStatuslineState(payload, NOW); // same value → unchanged
  });
});

describe("history tracking", () => {
  it("books cache-miss causes per day", async () => {
    writeAccount("claude_max");
    const { buildStatuslineState } = await fresh();
    const nowSec = NOW.getTime() / 1000;
    const payload = {
      session_id: "s1",
      model: { id: "claude-opus-5-5" },
      prompt_cache: {
        warm: true,
        ttl: "5m",
        miss_recache_tokens: 1_000_000,
        miss_causes: { tools_changed: 2 },
        last_miss_cause: { causes: ["tools_changed"] },
        last_miss_at: nowSec - 60,
      },
    };
    await buildStatuslineState(payload, NOW);
    expect(readJson("usage.json").missCauses).toEqual({
      "2026-10-07": { tools_changed: { count: 2, usd: 4.8 } },
    });
    // Older Claude Code (no miss_causes) after a /clear: $ only, counted as unknown.
    const { miss_causes: _, ...olderCache } = payload.prompt_cache;
    await buildStatuslineState(
      { ...payload, prompt_cache: { ...olderCache, miss_recache_tokens: 500_000 } },
      NOW,
    );
    const day = (readJson("usage.json").missCauses as Record<string, Record<string, unknown>>)[
      "2026-10-07"
    ];
    expect(day?.unknown).toEqual({ count: 0, usd: 2.4 });
  });

  it("samples the API reading on change and reports burn rate and runway", async () => {
    writeAccount("claude_max");
    const { buildStatuslineState } = await fresh();
    const nowSec = NOW.getTime() / 1000;
    const apiAt = (at: Date, five: number, stale: { readAt?: number } | null = null): void => {
      writeJson("api-cache.json", {
        fetchedAt: at.getTime(),
        extraUsage: null,
        fiveHour: { pct: five, resetsAt: nowSec + 3 * 3600 },
        sevenDay: { pct: 10, resetsAt: nowSec + 86_400 },
        ...(stale ? { stale: true, ...stale } : {}),
      });
    };
    // An idle session's old hook reading never becomes a sample.
    const idleHook = { session_id: "s", rate_limits: { five_hour: { used_percentage: 5 } } };
    apiAt(NOW, 40);
    const first = await buildStatuslineState(idleHook, NOW);
    expect(first.runway?.fiveHour?.verdict).toBe("insufficient-data");
    const later = new Date(NOW.getTime() + 30 * 60_000);
    apiAt(later, 60);
    const second = await buildStatuslineState(idleHook, later);
    expect(second.runway?.fiveHour).toMatchObject({ ratePctPerHour: 40, verdict: "at-risk" });
    expect(second.runway?.sevenDay?.verdict).toBe("comfortable");
    await buildStatuslineState(idleHook, later); // same reading: no new sample
    apiAt(NOW, 99); // older than the last sample: ignored
    await buildStatuslineState(idleHook, later);
    const samples = readJson("limits.json").samples as Array<{ fiveHourPct: number }>;
    expect(samples.map((sample) => sample.fiveHourPct)).toEqual([40, 60]);
    // A failed fetch mid-turn keeps the last good reading at its own time: the runway stays.
    const retry = new Date(later.getTime() + 2 * 60_000);
    apiAt(retry, 60, { readAt: later.getTime() });
    expect((await buildStatuslineState(idleHook, retry)).runway?.fiveHour).toMatchObject({
      ratePctPerHour: 40,
      verdict: "at-risk",
    });
    apiAt(later, 70, {}); // stale with no known reading time (an older cache): no runway, no sample
    expect((await buildStatuslineState(idleHook, later)).runway).toEqual({
      fiveHour: null,
      sevenDay: null,
    });
  });

  it("only the windows the API reports get a runway", async () => {
    writeAccount("claude_max");
    writeJson("api-cache.json", {
      fetchedAt: NOW.getTime(),
      extraUsage: null,
      fiveHour: null,
      sevenDay: { pct: 3, resetsAt: null },
    });
    const { buildStatuslineState } = await fresh();
    const state = await buildStatuslineState({ session_id: "s" }, NOW);
    expect(state.runway?.fiveHour).toBeNull();
    expect(state.runway?.sevenDay?.verdict).toBe("insufficient-data");
    writeJson("api-cache.json", {
      fetchedAt: NOW.getTime(),
      extraUsage: null,
      fiveHour: null,
      sevenDay: null,
    });
    expect((await buildStatuslineState({ session_id: "s" }, NOW)).runway?.sevenDay).toBeNull();
  });

  it("keeps the session map: transcript path, cost and lines, rewritten at most hourly", async () => {
    writeAccount("claude_max");
    const { buildStatuslineState } = await fresh();
    const payload = {
      session_id: "s",
      transcript_path: "/t/s.jsonl",
      cost: { total_cost_usd: 2, total_lines_added: 10, total_lines_removed: 3 },
    };
    await buildStatuslineState(payload, NOW);
    expect(readJson("sessions-map.json")).toEqual({
      schemaVersion: 1,
      sessions: {
        s: {
          transcriptPath: "/t/s.jsonl",
          costUsd: 2,
          linesAdded: 10,
          linesRemoved: 3,
          name: null,
          claudeVersion: null,
          firstSeenAt: NOW.toISOString(),
          lastSeenAt: NOW.toISOString(),
        },
      },
    });
    await buildStatuslineState({ ...payload, session_name: "fix login", version: "2.1.293" }, NOW);
    expect(
      (readJson("sessions-map.json").sessions as Record<string, { name: unknown }>).s,
    ).toMatchObject({ name: "fix login", claudeVersion: "2.1.293" });
    await buildStatuslineState({ session_id: "s", cost: { total_cost_usd: 3 } }, NOW);
    const entry = (
      readJson("sessions-map.json").sessions as Record<string, { transcriptPath: unknown }>
    ).s;
    expect(entry?.transcriptPath).toBeNull(); // a changed path rewrites at once
  });
});

describe("coach tip", () => {
  it("the first non-snoozed finding of feed.json, or null", async () => {
    writeAccount("claude_max");
    const { buildStatuslineState } = await fresh();
    expect((await buildStatuslineState({ session_id: "s" }, NOW)).coach).toBeNull();
    writeJson("feed.json", {
      schemaVersion: 1,
      advice: [
        {
          id: "R2",
          title: "Fast mode",
          usd: 3,
          window: "week",
          snoozedUntil: "2026-12-01T00:00:00Z",
        },
        { id: "R8", title: "Running out early", usd: null, snoozedUntil: null },
      ],
    });
    expect((await buildStatuslineState({ session_id: "s" }, NOW)).coach).toEqual({
      title: "Running out early",
      usd: null,
      window: "week",
    });
    writeJson("feed.json", {
      schemaVersion: 1,
      advice: [{ id: "R1", title: "T", usd: 1, window: "month" }],
    });
    expect((await buildStatuslineState({ session_id: "s" }, NOW)).coach).toEqual({
      title: "T",
      usd: 1,
      window: "month",
    });
  });
});

describe("runners", () => {
  let written: Array<string>;

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  });

  it("--statusline prints one JSON line", async () => {
    writeAccount("claude_pro");
    const { runStatuslineJson } = await fresh();
    expect(await runStatuslineJson("{}")).toBe(0);
    expect(JSON.parse(written.join(""))).toMatchObject({ hasSpendCap: false });
  });

  it("--statusline-line reads stdin and prints the rendered line", async () => {
    writeAccount("claude_pro");
    const stdin = Readable.from([
      Buffer.from('{"model":{"display_name":"Opus"},"cwd":"/nowhere"}'),
    ]);
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    const { runStatuslineLine } = await fresh();
    expect(await runStatuslineLine()).toBe(0);
    expect(written.join("")).toContain("🤖 Opus");
    expect(written.join("")).toContain("⏱");
  });

  it("a broken budget pipeline still prints the session part", async () => {
    writeFileSync(path.join(fakeHome, ".config"), "not a directory");
    const { runStatuslineLine } = await fresh();
    await runStatuslineLine(
      '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"/nowhere"}}',
    );
    expect(written.join("")).toContain("🤖 Opus");
    expect(written.join("")).not.toContain("⏱");
    await runStatuslineLine("{}");
  });

  it("a file from a newer version puts an update marker first", async () => {
    writeAccount("claude_pro");
    writeJson("config.json", { schemaVersion: 99, monthlyCap: 1, laboralDays: {} });
    const { runStatuslineLine } = await fresh();
    await runStatuslineLine('{"model":{"display_name":"Opus"}}');
    expect(written.join("")).toMatch(/^⚠ update cc-daily-usage \| /);
  });

  it("readStdin with no explicit raw for the JSON runner", async () => {
    writeAccount("claude_pro");
    const stdin = Readable.from([]);
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    const { runStatuslineJson } = await fresh();
    await runStatuslineJson();
    expect(written.join("")).toContain("hasSpendCap");
  });
});
