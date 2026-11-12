import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as UsageModule from "./anthropic-usage.js";
import type * as RefreshModule from "./refresh.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

const unref = vi.fn();
const spawnMock = vi.fn(() => ({ unref }));
vi.mock("node:child_process", () => ({
  spawn: (...args: Array<unknown>) => spawnMock(...(args as [])),
}));

const fetchUsageMock = vi.fn();
const fetchPlanMock = vi.fn().mockResolvedValue(null);
const tokenMock = vi.fn();
vi.mock("./anthropic-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof UsageModule>();
  return {
    ...actual,
    fetchUsageOutcome: (token: string) => fetchUsageMock(token) as unknown,
    fetchPlan: (token: string, now: Date) => fetchPlanMock(token, now) as unknown,
    resolveOAuthAccessToken: () => tokenMock() as unknown,
  };
});

async function fresh(): Promise<typeof RefreshModule> {
  vi.resetModules();
  return import("./refresh.js");
}

function accountDir(): string {
  return path.join(fakeHome, ".config", "cc-spend", "accounts", "acct");
}

const NOW = new Date("2026-10-10T10:00:00.000Z");

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "cc-spend-refresh-"));
  mkdirSync(accountDir(), { recursive: true });
  spawnMock.mockClear();
  unref.mockClear();
  spawnMock.mockImplementation(() => ({ unref }));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("requestApiRefresh", () => {
  it("spawns one detached refresher when the cache is missing, then holds the lock", async () => {
    const { requestApiRefresh } = await fresh();
    expect(requestApiRefresh("acct", NOW)).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/bin[\\/]cc-spend\.js$/), "--refresh", "acct"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(unref).toHaveBeenCalled();
    expect(requestApiRefresh("acct", NOW)).toBe(false); // lock held
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the cache is fresh", async () => {
    writeFileSync(
      path.join(accountDir(), "api-cache.json"),
      JSON.stringify({
        fetchedAt: NOW.getTime() - 1000,
        extraUsage: null,
        fiveHour: null,
        sevenDay: null,
      }),
    );
    const { requestApiRefresh } = await fresh();
    expect(requestApiRefresh("acct", NOW)).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("takes over a stale lock left by a dead refresher", async () => {
    const lock = path.join(accountDir(), "refresh.lock");
    writeFileSync(lock, "");
    const old = new Date(NOW.getTime() - 60_000);
    utimesSync(lock, old, old);
    const { requestApiRefresh } = await fresh();
    expect(requestApiRefresh("acct", NOW)).toBe(true);
  });

  it("gives up quietly when the lock cannot be created at all", async () => {
    rmSync(accountDir(), { recursive: true });
    const { requestApiRefresh } = await fresh();
    expect(requestApiRefresh("acct", NOW)).toBe(false);
  });

  it("releases the lock when spawn throws", async () => {
    spawnMock.mockImplementation(() => {
      throw new Error("EAGAIN");
    });
    const { requestApiRefresh } = await fresh();
    expect(requestApiRefresh("acct", NOW)).toBe(false);
    expect(existsSync(path.join(accountDir(), "refresh.lock"))).toBe(false);
  });

  it("a throwing fetch keeps the old files and still removes the lock", async () => {
    tokenMock.mockReturnValue({ token: "tok", expiresAt: null });
    fetchUsageMock.mockRejectedValue(new Error("boom"));
    writeFileSync(path.join(accountDir(), "refresh.lock"), "");
    const { runRefresh } = await fresh();
    expect(await runRefresh("acct", NOW)).toBe(0);
    expect(existsSync(path.join(accountDir(), "api-cache.json"))).toBe(false);
    expect(existsSync(path.join(accountDir(), "refresh.lock"))).toBe(false);
  });
});

describe("runRefresh", () => {
  it("fetches with the resolved token, writes api-cache.json, removes the lock", async () => {
    tokenMock.mockReturnValue({ token: "tok", expiresAt: null });
    fetchUsageMock.mockResolvedValue({
      usage: { extraUsage: null, fiveHour: { pct: 3, resetsAt: 1 }, sevenDay: null },
    });
    writeFileSync(path.join(accountDir(), "refresh.lock"), "");
    const { runRefresh } = await fresh();
    const { loadApiCache } = await import("./config.js");
    expect(await runRefresh("acct", NOW)).toBe(0);
    expect(fetchUsageMock).toHaveBeenCalledWith("tok");
    expect(loadApiCache("acct")).toEqual({
      fetchedAt: NOW.getTime(),
      extraUsage: null,
      fiveHour: { pct: 3, resetsAt: 1 },
      sevenDay: null,
    });
    expect(existsSync(path.join(accountDir(), "refresh.lock"))).toBe(false);
    const feed = JSON.parse(readFileSync(path.join(accountDir(), "feed.json"), "utf8")) as {
      schemaVersion: number;
      limits: { fiveHour: { usedPct: number } | null };
    };
    expect(feed.schemaVersion).toBe(1);
    expect(feed.limits.fiveHour?.usedPct).toBe(3);
    // The index is complete (nothing behind): record #1 starts by itself.
    expect(existsSync(path.join(accountDir(), "records.json"))).toBe(true);
    expect(feed).toMatchObject({ record: { notice: null } });
  });

  it("no record starts while another index pass holds the lock", async () => {
    tokenMock.mockReturnValue(null);
    const lock = path.join(fakeHome, ".config", "cc-spend", "index", "index.lock");
    mkdirSync(path.dirname(lock), { recursive: true });
    writeFileSync(lock, "1");
    const { runRefresh } = await fresh();
    expect(await runRefresh("acct", NOW)).toBe(0);
    expect(existsSync(path.join(accountDir(), "records.json"))).toBe(false);
  });

  it("reads the plan once a day, only after a good usage fetch", async () => {
    tokenMock.mockReturnValue({ token: "tok", expiresAt: null });
    fetchUsageMock.mockResolvedValue({
      usage: { extraUsage: null, fiveHour: null, sevenDay: null },
    });
    const plan = {
      fetchedAt: NOW.getTime(),
      rateLimitTier: "t",
      subscriptionStatus: "active",
      billingType: null,
      trialEndsAt: null,
    };
    fetchPlanMock.mockClear().mockResolvedValueOnce(plan).mockResolvedValueOnce(null);
    const { runRefresh } = await fresh();
    const { loadApiCache } = await import("./config.js");
    await runRefresh("acct", NOW);
    expect(loadApiCache("acct")?.plan).toEqual(plan);
    await runRefresh("acct", new Date(NOW.getTime() + 60_000)); // not due
    expect(fetchPlanMock).toHaveBeenCalledTimes(1);
    const tomorrow = new Date(NOW.getTime() + 24 * 3600 * 1000);
    await runRefresh("acct", tomorrow); // due; a failed profile read keeps yesterday's plan
    expect(fetchPlanMock).toHaveBeenCalledTimes(2);
    expect(loadApiCache("acct")?.plan).toEqual(plan);
    fetchUsageMock.mockResolvedValue({ failure: { error: "HTTP 429", retryAfter: null } });
    await runRefresh("acct", new Date(tomorrow.getTime() + 24 * 3600 * 1000));
    expect(fetchPlanMock).toHaveBeenCalledTimes(2); // usage failed: no profile call
  });

  it("no token → a stale entry without any network call (default now)", async () => {
    tokenMock.mockReturnValue(null);
    fetchUsageMock.mockClear();
    const { runRefresh } = await fresh();
    const { loadApiCache } = await import("./config.js");
    await runRefresh("acct");
    expect(fetchUsageMock).not.toHaveBeenCalled();
    expect(loadApiCache("acct")).toMatchObject({ stale: true, lastError: "no token" });
  });
});
