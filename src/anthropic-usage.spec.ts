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
              five_hour: { utilization: 42, resets_at: "2026-10-10T15:00:00Z" },
              seven_day: { utilization: 7, resets_at: null },
              extra_usage: { is_enabled: false },
            }),
        }),
      );
      const { fetchUsage } = await freshModule();
      expect(await fetchUsage("t")).toEqual({
        extraUsage: null,
        fiveHour: { pct: 42, resetsAt: Date.parse("2026-10-10T15:00:00Z") / 1000 },
        sevenDay: { pct: 7, resetsAt: null },
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
        fiveHour: { pct: 5, resetsAt: null },
        sevenDay: null,
      });
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
  });

  describe("nextApiCache / isApiCacheFresh", () => {
    const now = new Date("2026-10-10T10:00:00.000Z");
    const reading = {
      extraUsage: null,
      fiveHour: { pct: 1, resetsAt: null },
      sevenDay: null,
    };

    it("a good fetch replaces the cache", async () => {
      const { nextApiCache } = await freshModule();
      expect(nextApiCache(null, reading, now)).toEqual({ fetchedAt: now.getTime(), ...reading });
    });

    it("a failed fetch keeps the last good reading, marked stale", async () => {
      const { nextApiCache } = await freshModule();
      const previous = { fetchedAt: 1, ...reading };
      expect(nextApiCache(previous, null, now)).toEqual({
        fetchedAt: now.getTime(),
        ...reading,
        stale: true,
      });
      expect(nextApiCache(null, null, now)).toEqual({
        fetchedAt: now.getTime(),
        extraUsage: null,
        fiveHour: null,
        sevenDay: null,
        stale: true,
      });
    });

    it("fresh for 60s", async () => {
      const { isApiCacheFresh } = await freshModule();
      const cache = { fetchedAt: now.getTime() - 59_000, ...reading };
      expect(isApiCacheFresh(cache, now)).toBe(true);
      expect(isApiCacheFresh({ ...cache, fetchedAt: now.getTime() - 60_000 }, now)).toBe(false);
      expect(isApiCacheFresh(null, now)).toBe(false);
    });
  });
});
