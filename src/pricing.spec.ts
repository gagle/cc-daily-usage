import { describe, expect, it } from "vitest";

import {
  cacheWriteRate,
  fastModeBilled,
  normalizeModelId,
  ratesFor,
  tokenizerRatio,
  tokensCost,
} from "./pricing.js";

describe("pricing.ts", () => {
  it.each([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["Claude-Opus-5-5[1m]", "claude-opus-5-5"],
    ["us.anthropic.claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["anthropic/claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-opus-4-5@20251101", "claude-opus-4-5"],
    ["anthropic/claude-opus-4.8", "claude-opus-4-8"],
    ["claude-fable-5.2[1m]", "claude-fable-5-2"],
  ])("normalizeModelId(%s) = %s", (raw, key) => {
    expect(normalizeModelId(raw)).toBe(key);
  });

  it("known models are priced, unknown ones are not", () => {
    expect(ratesFor("claude-opus-5-5")).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
    expect(ratesFor("claude-fable-5-1")?.cacheRead).toBe(0.25);
    expect(ratesFor("claude-fable-5-2")).toEqual({ input: 8, output: 40, cacheRead: 0.2 });
    expect(ratesFor("claude-fable-5-2", true)).toEqual({ input: 16, output: 80, cacheRead: 0.4 });
    expect(ratesFor("gpt-5")).toBeNull();
  });

  it("cache reads are 0.05× input on Sonnet 5.5, 0.1× on Sonnet 5", () => {
    expect(ratesFor("claude-sonnet-5-5")?.cacheRead).toBe(0.1);
    expect(ratesFor("claude-sonnet-5")?.cacheRead).toBe(0.2);
  });

  it("Haiku 5.5 switches to the long-prompt tier above 100K prompt tokens; other models do not", () => {
    expect(ratesFor("claude-haiku-5-5", false, 100_000)).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
    });
    expect(ratesFor("claude-haiku-5-5", false, 100_001)).toEqual({
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
    });
    expect(ratesFor("claude-opus-5-5", false, 900_000)).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
    });
  });

  it("models served in the last 6 months are priced, dated ids included", () => {
    expect(ratesFor("claude-opus-4-1-20250805")).toEqual({ input: 15, output: 75, cacheRead: 1.5 });
    expect(ratesFor("claude-opus-4-20250514")?.input).toBe(15);
    expect(ratesFor("claude-opus-4-5-20251101")?.input).toBe(5);
    expect(ratesFor("claude-sonnet-4-5-20250929")?.cacheRead).toBe(0.3);
    expect(ratesFor("claude-sonnet-4-20250514")?.output).toBe(15);
  });

  it("Opus 4.6 / 4.7 fast mode was 6× standard; today only 5.5 / 5 / 4.8 bill fast", () => {
    expect(ratesFor("claude-opus-4-6", true)).toEqual({ input: 30, output: 150, cacheRead: 3 });
    expect(ratesFor("claude-opus-4-7", true)).toEqual({ input: 30, output: 150, cacheRead: 3 });
    expect(fastModeBilled("claude-opus-5-5")).toBe(true);
    expect(fastModeBilled("claude-opus-4-8")).toBe(true);
    expect(fastModeBilled("claude-opus-4-7")).toBe(false);
    expect(fastModeBilled("claude-opus-4-6")).toBe(false);
    expect(fastModeBilled("claude-sonnet-5-5")).toBe(false);
  });

  it("US-only inference is 1.1×, stacked on fast mode and the Haiku 5.5 long-prompt tier", () => {
    const close = (
      rates: ReturnType<typeof ratesFor>,
      input: number,
      output: number,
      read: number,
    ): void => {
      expect(rates?.input).toBeCloseTo(input, 9);
      expect(rates?.output).toBeCloseTo(output, 9);
      expect(rates?.cacheRead).toBeCloseTo(read, 9);
    };
    close(ratesFor("claude-opus-5-5", false, 0, true), 4.4, 22, 0.22);
    close(ratesFor("claude-opus-5-5", true, 0, true), 8.8, 44, 0.44);
    close(ratesFor("claude-haiku-5-5", false, 200_000, true), 0.55, 2.75, 0.055);
  });

  it("fast mode doubles rates only where fast mode exists", () => {
    expect(ratesFor("claude-opus-5-5", true)).toEqual({ input: 8, output: 40, cacheRead: 0.4 });
    expect(ratesFor("claude-sonnet-5-5", true)).toEqual({ input: 2, output: 10, cacheRead: 0.1 });
  });

  it("cache writes: 1.25× input for 5m, 2× for 1h", () => {
    const rates = { input: 4, output: 20, cacheRead: 0.2 };
    expect(cacheWriteRate(rates, "5m")).toBe(5);
    expect(cacheWriteRate(rates, "1h")).toBe(8);
  });

  it("tokenizerRatio: ~1.3× from the old tokenizer (Claude 4.6 and earlier) to the new one, 1 within one", () => {
    expect(tokenizerRatio("claude-sonnet-4-6", "claude-sonnet-5-5")).toBe(1.3);
    expect(tokenizerRatio("claude-opus-5-5", "claude-opus-4-6")).toBeCloseTo(1 / 1.3, 12);
    expect(tokenizerRatio("claude-opus-4-8", "claude-opus-5-5")).toBe(1);
    expect(tokenizerRatio("claude-haiku-4-5", "claude-opus-4-5")).toBe(1);
    expect(tokenizerRatio("claude-haiku-4-5", "claude-haiku-5-5")).toBe(1.3);
    expect(tokenizerRatio("claude-opus-4-7", "claude-fable-5-1")).toBe(1);
  });

  it("tokensCost is per million", () => {
    expect(tokensCost(500_000, 4)).toBe(2);
  });
});
