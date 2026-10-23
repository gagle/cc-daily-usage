import { describe, expect, it } from "vitest";

import { type CachePayload, forecastCache } from "./cache-forecast.js";

const NOW = 1_800_000_000;

function payload(overrides: Partial<CachePayload> = {}): CachePayload {
  return {
    model: { id: "claude-opus-5-5" },
    context_window: { total_input_tokens: 100_000, used_percentage: 10 },
    prompt_cache: {
      warm: true,
      ttl: "1h",
      expires_at: NOW + 300,
      miss_recache_tokens: 50_000,
      recache_tokens_if_cold: 100_000,
    },
    ...overrides,
  };
}

describe("forecastCache", () => {
  it("null before cache data, without a model, or for an unpriced model", () => {
    expect(forecastCache({ model: { id: "claude-opus-5-5" } }, NOW)).toBeNull();
    expect(forecastCache({ prompt_cache: { warm: true } }, NOW)).toBeNull();
    expect(forecastCache(payload({ model: { id: "mystery" } }), NOW)).toBeNull();
  });

  it("warm cache: next prompt reads the prefix; letting it expire costs the 1h re-write", () => {
    const base = payload();
    const forecast = forecastCache(
      { ...base, prompt_cache: { ...base.prompt_cache, requests: 14, misses: 2 } },
      NOW,
    );
    expect(forecast).toEqual({
      warm: true,
      secondsUntilCold: 300,
      ttlSeconds: 3600,
      nextWarmUsd: 0.02, // 100k × $0.20/MTok
      nextColdUsd: 0.8, // 100k × $8/MTok (2 × $4)
      missPremiumUsd: 0.78,
      sessionMissUsd: (50_000 * (8 - 0.2)) / 1_000_000,
      expiresAt: NOW + 300,
      requests: 14,
      misses: 2,
      recentMiss: null,
    });
  });

  it("5m TTL, past expiry → cold even if the last payload said warm", () => {
    const forecast = forecastCache(
      payload({
        prompt_cache: {
          warm: true,
          ttl: "5m",
          expires_at: NOW - 1,
          recache_tokens_if_cold: 100_000,
        },
      }),
      NOW,
    );
    expect(forecast?.warm).toBe(false);
    expect(forecast?.secondsUntilCold).toBeNull();
    expect(forecast?.nextColdUsd).toBe(0.5); // 100k × $5
    expect(forecast?.sessionMissUsd).toBe(0);
  });

  it("unknown re-cache size (right after /compact) → no cold price", () => {
    const forecast = forecastCache(
      payload({ prompt_cache: { warm: true, recache_tokens_if_cold: null } }),
      NOW,
    );
    expect(forecast?.nextColdUsd).toBeNull();
    expect(forecast?.missPremiumUsd).toBeNull();
    expect(forecast?.secondsUntilCold).toBeNull();
  });

  it("a cold cache has no expiry", () => {
    const cold = forecastCache(
      payload({
        context_window: { total_input_tokens: 500_000, used_percentage: 50 },
        prompt_cache: { warm: false, ttl: "1h", recache_tokens_if_cold: 500_000 },
      }),
      NOW,
    );
    expect(cold?.expiresAt).toBeNull();
  });

  it("names the causes of a miss for two minutes after it", () => {
    const missed = (at: number, causes: Array<string> | undefined) =>
      forecastCache(
        payload({
          prompt_cache: {
            warm: true,
            last_miss_at: at,
            last_miss_cause: causes === undefined ? null : { causes },
          },
        }),
        NOW,
      )?.recentMiss;
    expect(missed(NOW - 30, ["tools_changed", "model_changed"])).toBe(
      "tools changed, model changed",
    );
    expect(missed(NOW - 121, ["tools_changed"])).toBeNull();
    expect(missed(NOW - 30, [])).toBeNull();
    expect(missed(NOW - 30, undefined)).toBeNull();
    expect(forecastCache(payload(), NOW)?.recentMiss).toBeNull();
  });

  it("missing context counts as 0 tokens; fast mode doubles", () => {
    const forecast = forecastCache(
      { model: { id: "claude-opus-5-5" }, fast_mode: true, prompt_cache: { warm: true } },
      NOW,
    );
    expect(forecast?.nextWarmUsd).toBe(0);
  });

  it("Haiku 5.5 over 100K context prices the next prompt at the long-prompt tier", () => {
    const forecast = forecastCache(payload({ model: { id: "claude-haiku-5-5" } }), NOW);
    expect(forecast?.nextWarmUsd).toBeCloseTo(0.001, 6); // 100k × $0.01 (prompt not over 100K)
    const long = forecastCache(
      payload({
        model: { id: "claude-haiku-5-5" },
        context_window: { total_input_tokens: 200_000, used_percentage: 20 },
      }),
      NOW,
    );
    expect(long?.nextWarmUsd).toBeCloseTo(0.01, 6); // 200k × $0.05
    expect(long?.missPremiumUsd).toBeCloseTo(0.095, 6); // 100k re-cache × ($1 write − $0.05 read)
    expect(long?.nextColdUsd).toBeCloseTo(0.105, 6); // warm read + premium
  });

  it("prices the cached prefix from current_usage; fresh input is written warm or cold alike", () => {
    // Opus 5.5, 1h TTL: read $0.20, write $8. 100k context = 90k read + 9k written + 1k fresh input.
    const forecast = forecastCache(
      payload({
        context_window: {
          total_input_tokens: 100_000,
          used_percentage: 10,
          current_usage: { cache_read_input_tokens: 90_000, cache_creation_input_tokens: 9_000 },
        },
        prompt_cache: {
          warm: true,
          ttl: "1h",
          expires_at: NOW + 300,
          recache_tokens_if_cold: 100_000,
        },
      }),
      NOW,
    );
    expect(forecast?.nextWarmUsd).toBeCloseTo(0.0198, 9); // 99k × $0.20
    expect(forecast?.missPremiumUsd).toBeCloseTo(0.7722, 9); // min(100k, 99k) × ($8 − $0.20)
    expect(forecast?.nextColdUsd).toBeCloseTo(0.792, 9); // 99k × $8
    const partial = forecastCache(
      payload({
        context_window: { total_input_tokens: 100_000, used_percentage: 10, current_usage: {} },
        prompt_cache: {
          warm: true,
          ttl: "5m",
          expires_at: NOW + 60,
          recache_tokens_if_cold: 40_000,
        },
      }),
      NOW,
    );
    expect(partial?.nextWarmUsd).toBe(0); // current_usage with no cache fields: nothing cached
    expect(partial?.missPremiumUsd).toBe(0);
  });

  it("fast_mode on a model whose fast mode was removed bills standard", () => {
    const base = payload({ model: { id: "claude-opus-4-7" } });
    const fast = forecastCache({ ...base, fast_mode: true }, NOW);
    expect(fast?.nextWarmUsd).toBe(forecastCache(base, NOW)?.nextWarmUsd);
  });
});
