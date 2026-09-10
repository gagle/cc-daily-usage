import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AccountModule from "./account.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

const fetchOauthProfileMock = vi.fn();
vi.mock("./anthropic-usage.js", () => ({
  fetchOauthProfile: (token: string) => fetchOauthProfileMock(token) as unknown,
}));

async function freshAccountModule(): Promise<typeof AccountModule> {
  vi.resetModules();
  return import("./account.js");
}

describe("account.ts", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-account-test-"));
    fetchOauthProfileMock.mockReset();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  describe("resolveActiveAccount", () => {
    it("returns null when ~/.claude.json doesn't exist", async () => {
      const { resolveActiveAccount } = await freshAccountModule();
      expect(await resolveActiveAccount()).toBeNull();
    });

    it("returns null when ~/.claude.json has no oauthAccount", async () => {
      writeFileSync(path.join(fakeHome, ".claude.json"), JSON.stringify({ userID: "x" }));
      const { resolveActiveAccount } = await freshAccountModule();
      expect(await resolveActiveAccount()).toBeNull();
    });

    it("reads the global oauthAccount when no env token override is set", async () => {
      writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({
          oauthAccount: {
            emailAddress: "gabriel@example.com",
            accountUuid: "uuid-1",
            organizationType: "claude_pro",
          },
        }),
      );
      const { resolveActiveAccount } = await freshAccountModule();
      expect(await resolveActiveAccount()).toEqual({
        email: "gabriel@example.com",
        accountUuid: "uuid-1",
        organizationType: "claude_pro",
      });
      expect(fetchOauthProfileMock).not.toHaveBeenCalled();
    });

    it("resolves identity from the per-session token via /api/oauth/profile when the env override is set", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "session-token";
      writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: "global@example.com" } }),
      );
      fetchOauthProfileMock.mockResolvedValue({
        account: { email_address: "override@example.com" },
        organization: { uuid: "uuid-2", organization_type: "claude_enterprise" },
      });
      const { resolveActiveAccount } = await freshAccountModule();
      expect(await resolveActiveAccount()).toEqual({
        email: "override@example.com",
        accountUuid: "uuid-2",
        organizationType: "claude_enterprise",
      });
      expect(fetchOauthProfileMock).toHaveBeenCalledWith("session-token");
    });

    it("falls back to the global file when the env override's profile fetch fails", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "session-token";
      writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: "global@example.com" } }),
      );
      fetchOauthProfileMock.mockResolvedValue(null);
      const { resolveActiveAccount } = await freshAccountModule();
      expect(await resolveActiveAccount()).toEqual({
        email: "global@example.com",
        accountUuid: null,
        organizationType: null,
      });
    });

    it("never throws on invalid JSON", async () => {
      writeFileSync(path.join(fakeHome, ".claude.json"), "{ not json");
      const { resolveActiveAccount } = await freshAccountModule();
      expect(await resolveActiveAccount()).toBeNull();
    });

    it("nulls out a missing emailAddress on the global oauthAccount", async () => {
      writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({ oauthAccount: { accountUuid: "uuid-1", organizationType: "claude_pro" } }),
      );
      const { resolveActiveAccount } = await freshAccountModule();
      expect(await resolveActiveAccount()).toEqual({
        email: null,
        accountUuid: "uuid-1",
        organizationType: "claude_pro",
      });
    });

    it("nulls out missing fields on the per-session profile response", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "session-token";
      fetchOauthProfileMock.mockResolvedValue({});
      const { resolveActiveAccount } = await freshAccountModule();
      expect(await resolveActiveAccount()).toEqual({
        email: null,
        accountUuid: null,
        organizationType: null,
      });
    });
  });

  describe("resolveActiveAccountSync", () => {
    it("reads the global oauthAccount without touching the env override", async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "session-token";
      writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({ oauthAccount: { emailAddress: "global@example.com" } }),
      );
      const { resolveActiveAccountSync } = await freshAccountModule();
      expect(resolveActiveAccountSync()?.email).toBe("global@example.com");
      expect(fetchOauthProfileMock).not.toHaveBeenCalled();
    });
  });

  describe("readOverageCreditGrantCache", () => {
    it("returns null when there's no accountUuid or no ~/.claude.json", async () => {
      const { readOverageCreditGrantCache } = await freshAccountModule();
      expect(readOverageCreditGrantCache(null)).toBeNull();
      expect(readOverageCreditGrantCache("uuid-1")).toBeNull();
    });

    it("returns null when the cache has no entry for this org", async () => {
      writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({ overageCreditGrantCache: { "other-uuid": { info: { eligible: true } } } }),
      );
      const { readOverageCreditGrantCache } = await freshAccountModule();
      expect(readOverageCreditGrantCache("uuid-1")).toBeNull();
    });

    it("never throws on invalid JSON", async () => {
      writeFileSync(path.join(fakeHome, ".claude.json"), "{ not json");
      const { readOverageCreditGrantCache } = await freshAccountModule();
      expect(readOverageCreditGrantCache("uuid-1")).toBeNull();
    });

    it("returns the cached info for this org's uuid", async () => {
      const info = {
        available: true,
        eligible: true,
        granted: false,
        amount_minor_units: 2000,
        currency: "USD",
      };
      writeFileSync(
        path.join(fakeHome, ".claude.json"),
        JSON.stringify({ overageCreditGrantCache: { "uuid-1": { info, timestamp: Date.now() } } }),
      );
      const { readOverageCreditGrantCache } = await freshAccountModule();
      expect(readOverageCreditGrantCache("uuid-1")).toEqual(info);
    });
  });

  describe("accountKey", () => {
    it("returns 'default' for a null account or one with no email", async () => {
      const { accountKey } = await freshAccountModule();
      expect(accountKey(null)).toBe("default");
      expect(accountKey({ email: null, accountUuid: "u", organizationType: null })).toBe("default");
    });

    it("sanitizes an email into a filesystem-safe lowercase key", async () => {
      const { accountKey } = await freshAccountModule();
      expect(
        accountKey({
          email: "Gabriel.Llamas+cc@Example.com",
          accountUuid: null,
          organizationType: null,
        }),
      ).toBe("gabriel_llamas_cc_example_com");
    });
  });
});
