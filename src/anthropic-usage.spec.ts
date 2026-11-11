import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AnthropicUsageModule from "./anthropic-usage.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return {
    ...actual,
    homedir: () => fakeHome,
    userInfo: () => ({ ...actual.userInfo(), username: "gabi" }),
  };
});

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("no keychain in tests — falls through to the plaintext file");
  }),
}));

async function freshModule(): Promise<typeof AnthropicUsageModule> {
  vi.resetModules();
  return import("./anthropic-usage.js");
}

describe("anthropic-usage.ts", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-anthropic-test-"));
    mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.unstubAllGlobals();
  });

  describe("resolveOAuthAccessToken", () => {
    it("prefers the CLAUDE_CODE_OAUTH_TOKEN env override over any file", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token";
      const { resolveOAuthAccessToken } = await freshModule();
      expect(resolveOAuthAccessToken()).toEqual({ token: "env-token", expiresAt: null });
    });

    it("returns null when no env override and no credentials file exists", async () => {
      const { resolveOAuthAccessToken } = await freshModule();
      expect(resolveOAuthAccessToken()).toBeNull();
    });

    it("reads the plaintext credentials file when the keychain is unavailable", async () => {
      writeFileSync(
        path.join(fakeHome, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: { accessToken: "file-token", expiresAt: Date.now() + 100_000 },
        }),
      );
      const { resolveOAuthAccessToken } = await freshModule();
      expect(resolveOAuthAccessToken()).toEqual({
        token: "file-token",
        expiresAt: expect.any(Number) as number,
      });
    });

    it("defaults expiresAt to null when the credentials file omits it", async () => {
      writeFileSync(
        path.join(fakeHome, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } }),
      );
      const { resolveOAuthAccessToken } = await freshModule();
      expect(resolveOAuthAccessToken()).toEqual({ token: "file-token", expiresAt: null });
    });

    it("returns null when the credentials file has no accessToken", async () => {
      writeFileSync(
        path.join(fakeHome, ".claude", ".credentials.json"),
        JSON.stringify({ claudeAiOauth: {} }),
      );
      const { resolveOAuthAccessToken } = await freshModule();
      expect(resolveOAuthAccessToken()).toBeNull();
    });

    it("skips the Keychain lookup entirely on non-macOS platforms", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        writeFileSync(
          path.join(fakeHome, ".claude", ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: { accessToken: "file-token", expiresAt: Date.now() + 100_000 },
          }),
        );
        const { resolveOAuthAccessToken } = await freshModule();
        expect(resolveOAuthAccessToken()?.token).toBe("file-token");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("on macOS reads the Keychain first, and falls back to the file when it fails", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });
      const { execFileSync } = await import("node:child_process");
      const keychain = vi.mocked(execFileSync);
      try {
        writeFileSync(
          path.join(fakeHome, ".claude", ".credentials.json"),
          JSON.stringify({ claudeAiOauth: { accessToken: "file-token" } }),
        );
        keychain.mockReturnValueOnce(
          JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }),
        );
        const { resolveOAuthAccessToken } = await freshModule();
        expect(resolveOAuthAccessToken()?.token).toBe("keychain-token");
        expect(keychain.mock.lastCall?.slice(0, 2)).toEqual([
          "security",
          ["find-generic-password", "-a", "gabi", "-w", "-s", "Claude Code-credentials"],
        ]);
        expect(resolveOAuthAccessToken()?.token).toBe("file-token");
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
      }
    });

    it("treats an expired token as unavailable", async () => {
      writeFileSync(
        path.join(fakeHome, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: { accessToken: "stale-token", expiresAt: Date.now() - 1000 },
        }),
      );
      const { resolveOAuthAccessToken } = await freshModule();
      expect(resolveOAuthAccessToken()).toBeNull();
    });

    it("never throws on invalid JSON in the credentials file", async () => {
      writeFileSync(path.join(fakeHome, ".claude", ".credentials.json"), "{ not json");
      const { resolveOAuthAccessToken } = await freshModule();
      expect(resolveOAuthAccessToken()).toBeNull();
    });
  });

  describe("fetchExtraUsage", () => {
    it("returns the mapped extra usage when is_enabled and both amounts are present", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              extra_usage: {
                is_enabled: true,
                used_credits: 16294,
                monthly_limit: 65000,
                utilization: 25,
              },
            }),
        }),
      );
      const { fetchExtraUsage } = await freshModule();
      expect(await fetchExtraUsage("t")).toEqual({
        usedCredits: 162.94,
        monthlyLimit: 650,
        utilizationPct: 25,
        currency: "USD",
        spendLimitReached: false,
        disabledReason: null,
      });
    });

    it("returns null when extra usage isn't enabled", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ extra_usage: { is_enabled: false } }),
        }),
      );
      const { fetchExtraUsage } = await freshModule();
      expect(await fetchExtraUsage("t")).toBeNull();
    });

    it("returns null on a non-2xx response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
      const { fetchExtraUsage } = await freshModule();
      expect(await fetchExtraUsage("t")).toBeNull();
    });

    it("defaults utilizationPct to 0 when the response omits it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              extra_usage: { is_enabled: true, used_credits: 100, monthly_limit: 1000 },
            }),
        }),
      );
      const { fetchExtraUsage } = await freshModule();
      expect(await fetchExtraUsage("t")).toEqual({
        usedCredits: 1,
        monthlyLimit: 10,
        utilizationPct: 0,
        currency: "USD",
        spendLimitReached: false,
        disabledReason: null,
      });
    });

    it("returns null when enabled but the amounts aren't numbers", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ extra_usage: { is_enabled: true, used_credits: null } }),
        }),
      );
      const { fetchExtraUsage } = await freshModule();
      expect(await fetchExtraUsage("t")).toBeNull();
    });

    it("returns null when fetch itself rejects (offline)", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      const { fetchExtraUsage } = await freshModule();
      expect(await fetchExtraUsage("t")).toBeNull();
    });
  });

  describe("fetchUsage", () => {
    it("parses seat windows (ISO resets → epoch seconds) next to extra_usage", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              five_hour: {
                utilization: 42,
                resets_at: "2026-10-10T15:00:00Z",
                used_dollars: 1.2,
                limit_dollars: 5,
              },
              seven_day: { utilization: 7, resets_at: null },
              seven_day_opus: { utilization: 30, resets_at: null },
              seven_day_cowork: null,
              seven_day_breakdown: {
                rows: [
                  { key: "claude_code", percent: 80 },
                  { key: "chat", percent: 20 },
                ],
              },
              limits: [
                { kind: "session", severity: "warning" },
                { kind: "weekly_all", severity: 3 },
              ],
              extra_usage: { is_enabled: false },
            }),
        }),
      );
      const { fetchUsage } = await freshModule();
      const window = { usedDollars: null, limitDollars: null, severity: null };
      expect(await fetchUsage("t")).toEqual({
        extraUsage: null,
        fiveHour: {
          pct: 42,
          resetsAt: Date.parse("2026-10-10T15:00:00Z") / 1000,
          usedDollars: 1.2,
          limitDollars: 5,
          severity: "warning",
        },
        sevenDay: { ...window, pct: 7, resetsAt: null },
        extraWindows: [{ ...window, key: "opus", pct: 30, resetsAt: null }],
        claudeCodeShare: 0.8,
        resets: [],
      });
    });

    it("windows without utilization or with a bad date degrade per field", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({ five_hour: { utilization: 5, resets_at: "nope" }, seven_day: {} }),
        }),
      );
      const { fetchUsage } = await freshModule();
      expect(await fetchUsage("t")).toEqual({
        extraUsage: null,
        fiveHour: { pct: 5, resetsAt: null, usedDollars: null, limitDollars: null, severity: null },
        sevenDay: null,
        extraWindows: [],
        claudeCodeShare: null,
        resets: [],
      });
    });

    it("reads unused, unpaused reset grants only when the account is eligible", async () => {
      const grants = [
        { resets_left: 1, ends_at: "2026-11-17T07:59:00+00:00", paused: false },
        { resets_left: 2, ends_at: null },
        { resets_left: 1, ends_at: "nope" },
        { resets_left: 0, ends_at: null },
        { resets_left: 1, paused: true },
        { ends_at: null },
      ];
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ cedar_ember: { eligible: true, grants } }),
      });
      vi.stubGlobal("fetch", fetch);
      const { fetchUsage } = await freshModule();
      expect((await fetchUsage("t"))?.resets).toEqual([
        { left: 1, endsAt: Date.parse("2026-11-17T07:59:00Z") },
        { left: 2, endsAt: null },
        { left: 1, endsAt: null },
      ]);
      expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/oauth/usage?cedar_ember=1");
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({
        headers: { "User-Agent": expect.stringMatching(/^claude-cli\//) as unknown },
      });
      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ cedar_ember: { eligible: false, grants } }),
      });
      expect((await fetchUsage("t"))?.resets).toEqual([]);
      fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ cedar_ember: { eligible: true, grants: null } }),
      });
      expect((await fetchUsage("t"))?.resets).toEqual([]);
    });

    it("fetchPlan maps the profile's organization; null without one", async () => {
      const fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            organization: {
              rate_limit_tier: "default_claude_ai",
              subscription_status: "active",
              billing_type: "stripe_subscription",
            },
          }),
      });
      vi.stubGlobal("fetch", fetch);
      const { fetchPlan } = await freshModule();
      const now = new Date("2026-10-10T10:00:00.000Z");
      expect(await fetchPlan("t", now)).toEqual({
        fetchedAt: now.getTime(),
        rateLimitTier: "default_claude_ai",
        subscriptionStatus: "active",
        billingType: "stripe_subscription",
        trialEndsAt: null,
      });
      fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ organization: {} }) });
      expect(await fetchPlan("t", now)).toMatchObject({ rateLimitTier: null, billingType: null });
      fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
      expect(await fetchPlan("t", now)).toBeNull();
    });

    it("null on failure or a non-object body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
      const { fetchUsage } = await freshModule();
      expect(await fetchUsage("t")).toBeNull();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(3) }),
      );
      expect(await fetchUsage("t")).toBeNull();
    });

    it("fetchUsageOutcome says why a fetch failed", async () => {
      const { fetchUsageOutcome } = await freshModule();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 429,
          headers: new Headers({ "retry-after": "30" }),
        }),
      );
      expect(await fetchUsageOutcome("t")).toEqual({
        failure: { error: "HTTP 429", retryAfter: "30" },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers() }),
      );
      expect(await fetchUsageOutcome("t")).toEqual({
        failure: { error: "HTTP 401", retryAfter: null },
      });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
      expect(await fetchUsageOutcome("t")).toEqual({
        failure: { error: "network", retryAfter: null },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(null) }),
      );
      expect(await fetchUsageOutcome("t")).toEqual({
        failure: { error: "bad response", retryAfter: null },
      });
    });
  });

  describe("nextApiCache / isApiCacheFresh", () => {
    const now = new Date("2026-10-10T10:00:00.000Z");
    const reading = {
      extraUsage: null,
      fiveHour: { pct: 1, resetsAt: null },
      sevenDay: null,
    };

    const failure = (error: string, retryAfter: string | null = null) => ({
      failure: { error, retryAfter },
    });

    it("a good fetch replaces the cache", async () => {
      const { nextApiCache } = await freshModule();
      expect(nextApiCache(null, { usage: reading }, now)).toEqual({
        fetchedAt: now.getTime(),
        ...reading,
      });
    });

    it("a failed fetch keeps the last good reading, marked stale", async () => {
      const { nextApiCache } = await freshModule();
      const previous = { fetchedAt: 1, ...reading };
      const failed = nextApiCache(previous, failure("HTTP 500"), now);
      expect(failed).toEqual({
        fetchedAt: now.getTime(),
        ...reading,
        stale: true,
        readAt: 1,
        failures: 1,
        lastError: "HTTP 500",
      });
      // The reading time survives further failures; a stale cache without one stays without one.
      expect(nextApiCache(failed, failure("network"), now)).toMatchObject({
        readAt: 1,
        failures: 2,
        lastError: "network",
      });
      expect(nextApiCache({ ...previous, stale: true }, failure("x"), now)).not.toHaveProperty(
        "readAt",
      );
      expect(nextApiCache(null, failure("no token"), now)).toEqual({
        fetchedAt: now.getTime(),
        extraUsage: null,
        fiveHour: null,
        sevenDay: null,
        stale: true,
        failures: 1,
        lastError: "no token",
      });
    });

    it("Retry-After in seconds or as a date sets retryAt, capped at 1 h", async () => {
      const { nextApiCache } = await freshModule();
      const t = now.getTime();
      const retryAt = (header: string | null) =>
        nextApiCache(null, failure("HTTP 429", header), now).retryAt;
      expect(retryAt("120")).toBe(t + 120_000);
      expect(retryAt(new Date(t + 300_000).toUTCString())).toBe(t + 300_000);
      expect(retryAt("86400")).toBe(t + 3_600_000);
      expect(retryAt("soon")).toBeUndefined();
      expect(retryAt(" ")).toBeUndefined();
      expect(retryAt(null)).toBeUndefined();
      // A later failure without the header drops the old retryAt.
      const first = nextApiCache(null, failure("HTTP 429", "120"), now);
      expect(nextApiCache(first, failure("network"), now).retryAt).toBeUndefined();
    });

    it("a good fetch clears the failures and keeps the plan", async () => {
      const { nextApiCache } = await freshModule();
      const plan = {
        fetchedAt: 1,
        rateLimitTier: "t",
        subscriptionStatus: "active",
        billingType: null,
        trialEndsAt: null,
      };
      const previous = { fetchedAt: 1, ...reading, stale: true, failures: 3, plan };
      expect(nextApiCache(previous, { usage: reading }, now)).toEqual({
        fetchedAt: now.getTime(),
        ...reading,
        plan,
      });
    });

    it("fresh for 60s, doubling per failure up to 16 min", async () => {
      const { isApiCacheFresh } = await freshModule();
      const cache = { fetchedAt: now.getTime() - 59_000, ...reading };
      expect(isApiCacheFresh(cache, now)).toBe(true);
      expect(isApiCacheFresh({ ...cache, fetchedAt: now.getTime() - 60_000 }, now)).toBe(false);
      expect(isApiCacheFresh(null, now)).toBe(false);
      const ago = (ms: number, failures: number) =>
        isApiCacheFresh({ ...cache, fetchedAt: now.getTime() - ms, failures }, now);
      expect(ago(119_000, 1)).toBe(true);
      expect(ago(120_000, 1)).toBe(false);
      expect(ago(959_000, 9)).toBe(true);
      expect(ago(960_000, 9)).toBe(false);
    });

    it("no attempt before retryAt, even after the backoff", async () => {
      const { isApiCacheFresh } = await freshModule();
      const cache = { fetchedAt: now.getTime() - 120_000, ...reading, failures: 1 };
      expect(isApiCacheFresh(cache, now)).toBe(false);
      expect(isApiCacheFresh({ ...cache, retryAt: now.getTime() + 1 }, now)).toBe(true);
      expect(isApiCacheFresh({ ...cache, retryAt: now.getTime() }, now)).toBe(false);
    });
  });
});
