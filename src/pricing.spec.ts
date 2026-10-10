import { describe, expect, it } from "vitest";

import { cacheWriteRate, normalizeModelId, ratesFor, tokensCost } from "./pricing.js";

describe("pricing.ts", () => {
  it.each([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["Claude-Opus-5-5[1m]", "claude-opus-5-5"],
    ["us.anthropic.claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-opus-4-5@20251101", "claude-opus-4-5"],
  ])("normalizeModelId(%s) = %s", (raw, key) => {
    expect(normalizeModelId(raw)).toBe(key);
  });

  it("known models are priced, unknown ones are not", () => {
    expect(ratesFor("claude-opus-5-5")).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
    expect(ratesFor("claude-fable-5-1")?.cacheRead).toBe(0.25);
    expect(ratesFor("gpt-5")).toBeNull();
  });

  it("fast mode doubles rates only where fast mode exists", () => {
    expect(ratesFor("claude-opus-5-5", true)).toEqual({ input: 8, output: 40, cacheRead: 0.4 });
    expect(ratesFor("claude-sonnet-5-5", true)).toEqual({ input: 2, output: 10, cacheRead: 0.2 });
  });

  it("cache writes: 1.25× input for 5m, 2× for 1h", () => {
    const rates = { input: 4, output: 20, cacheRead: 0.2 };
    expect(cacheWriteRate(rates, "5m")).toBe(5);
    expect(cacheWriteRate(rates, "1h")).toBe(8);
  });

  it("tokensCost is per million", () => {
    expect(tokensCost(500_000, 4)).toBe(2);
  });
});
