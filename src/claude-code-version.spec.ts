import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_CODE_LATEST_TTL_MS,
  fetchClaudeCodeLatest,
  isLatestDue,
  isNewer,
} from "./claude-code-version.js";
import type { ApiCache } from "./interfaces/config.interface.js";

const NOW = new Date("2026-11-13T10:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isNewer", () => {
  it("compares x.y.z numerically; anything else is never newer", () => {
    expect(isNewer("2.1.320", "2.1.319")).toBe(true);
    expect(isNewer("2.10.0", "2.9.9")).toBe(true);
    expect(isNewer("3.0.0", "2.99.99")).toBe(true);
    expect(isNewer("2.1.319", "2.1.319")).toBe(false);
    expect(isNewer("2.1.318", "2.1.319")).toBe(false);
    expect(isNewer("2.1.320-beta.1", "2.1.319")).toBe(false);
    expect(isNewer("2.1.320", "dev")).toBe(false);
    expect(isNewer(undefined, "2.1.319")).toBe(false);
    expect(isNewer("2.1.320", undefined)).toBe(false);
  });
});

describe("isLatestDue", () => {
  it("due without a reading or once it is 6 h old", () => {
    const cache = (fetchedAt?: number): ApiCache => ({
      fetchedAt: 0,
      extraUsage: null,
      fiveHour: null,
      sevenDay: null,
      ...(fetchedAt === undefined ? {} : { claudeCodeLatest: { version: "2.1.1", fetchedAt } }),
    });
    expect(isLatestDue(null, NOW)).toBe(true);
    expect(isLatestDue(cache(), NOW)).toBe(true);
    expect(isLatestDue(cache(NOW.getTime() - 1000), NOW)).toBe(false);
    expect(isLatestDue(cache(NOW.getTime() - CLAUDE_CODE_LATEST_TTL_MS), NOW)).toBe(true);
  });
});

describe("fetchClaudeCodeLatest", () => {
  const respond = (init: { ok?: boolean; json?: unknown; throws?: boolean }) => {
    const fetchMock = vi.fn((_url: string) =>
      init.throws === true
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ ok: init.ok ?? true, json: () => Promise.resolve(init.json) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("reads npm's latest dist-tag", async () => {
    const fetchMock = respond({ json: { version: "2.1.320" } });
    expect(await fetchClaudeCodeLatest(NOW)).toEqual({
      version: "2.1.320",
      fetchedAt: NOW.getTime(),
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
    );
  });

  it("null on HTTP error, odd body or network failure", async () => {
    respond({ ok: false });
    expect(await fetchClaudeCodeLatest(NOW)).toBeNull();
    respond({ json: { version: 7 } });
    expect(await fetchClaudeCodeLatest(NOW)).toBeNull();
    respond({ json: { version: "latest" } });
    expect(await fetchClaudeCodeLatest(NOW)).toBeNull();
    respond({ throws: true });
    expect(await fetchClaudeCodeLatest(NOW)).toBeNull();
  });
});
