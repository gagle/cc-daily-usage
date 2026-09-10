import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AnthropicUsageModule from "./anthropic-usage.js";
import type { UsageState } from "./interfaces/config.interface.js";

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

  describe("getCachedExtraUsage", () => {
    function makeUsage(): UsageState {
      return {
        monthlySpent: 0,
        lastUpdated: "2026-09-01T00:00:00.000Z",
        days: {},
        sessions: {},
        frozenForDate: null,
        frozenAvgPerDay: null,
        frozenSafeMonthTotal: null,
      };
    }

    it("fetches and caches when there's no prior cache entry", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              extra_usage: {
                is_enabled: true,
                used_credits: 100,
                monthly_limit: 1000,
                utilization: 10,
              },
            }),
        }),
      );
      const { getCachedExtraUsage } = await freshModule();
      const usage = makeUsage();
      const now = new Date("2026-09-10T00:00:00.000Z");
      const data = await getCachedExtraUsage(usage, "t", now);
      expect(data).toEqual({ usedCredits: 1, monthlyLimit: 10, utilizationPct: 10 });
      expect(usage.extraUsageCache).toEqual({ fetchedAt: now.getTime(), data });
    });

    it("serves the cached value without refetching within the TTL", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { getCachedExtraUsage } = await freshModule();
      const cached = { usedCredits: 5, monthlyLimit: 50, utilizationPct: 10 };
      const usage = makeUsage();
      usage.extraUsageCache = {
        fetchedAt: new Date("2026-09-10T00:00:00.000Z").getTime(),
        data: cached,
      };
      const data = await getCachedExtraUsage(usage, "t", new Date("2026-09-10T00:00:30.000Z"));
      expect(data).toEqual(cached);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refetches once the cache entry is older than the TTL", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              extra_usage: {
                is_enabled: true,
                used_credits: 200,
                monthly_limit: 1000,
                utilization: 20,
              },
            }),
        }),
      );
      const { getCachedExtraUsage } = await freshModule();
      const usage = makeUsage();
      usage.extraUsageCache = {
        fetchedAt: new Date("2026-09-10T00:00:00.000Z").getTime(),
        data: { usedCredits: 1, monthlyLimit: 10, utilizationPct: 10 },
      };
      const data = await getCachedExtraUsage(usage, "t", new Date("2026-09-10T00:02:00.000Z"));
      expect(data).toEqual({ usedCredits: 2, monthlyLimit: 10, utilizationPct: 20 });
    });
  });

  describe("fetchOauthProfile", () => {
    it("returns the parsed profile on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ account: { email_address: "a@b.com" } }),
        }),
      );
      const { fetchOauthProfile } = await freshModule();
      expect(await fetchOauthProfile("t")).toEqual({ account: { email_address: "a@b.com" } });
    });

    it("returns null on failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
      const { fetchOauthProfile } = await freshModule();
      expect(await fetchOauthProfile("t")).toBeNull();
    });
  });
});
