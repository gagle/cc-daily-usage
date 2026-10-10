import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
const tokenMock = vi.fn();
vi.mock("./anthropic-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof UsageModule>();
  return {
    ...actual,
    fetchUsage: (token: string) => fetchUsageMock(token) as unknown,
    resolveOAuthAccessToken: () => tokenMock() as unknown,
  };
});

async function fresh(): Promise<typeof RefreshModule> {
  vi.resetModules();
  return import("./refresh.js");
}

function accountDir(): string {
  return path.join(fakeHome, ".config", "cc-daily-usage", "accounts", "acct");
}

const NOW = new Date("2026-10-10T10:00:00.000Z");

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-refresh-"));
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
      [expect.stringMatching(/bin[\\/]cc-daily-usage\.js$/), "--refresh", "acct"],
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
});

describe("runRefresh", () => {
  it("fetches with the resolved token, writes api-cache.json, removes the lock", async () => {
    tokenMock.mockReturnValue({ token: "tok", expiresAt: null });
    fetchUsageMock.mockResolvedValue({
      extraUsage: null,
      fiveHour: { pct: 3, resetsAt: 1 },
      sevenDay: null,
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
  });

  it("no token → a stale entry without any network call (default now)", async () => {
    tokenMock.mockReturnValue(null);
    fetchUsageMock.mockClear();
    const { runRefresh } = await fresh();
    const { loadApiCache } = await import("./config.js");
    await runRefresh("acct");
    expect(fetchUsageMock).not.toHaveBeenCalled();
    expect(loadApiCache("acct")?.stale).toBe(true);
  });
});
