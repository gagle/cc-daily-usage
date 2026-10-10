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
    const forecast = forecastCache(payload(), NOW);
    expect(forecast).toEqual({
      warm: true,
      secondsUntilCold: 300,
      ttlSeconds: 3600,
      nextWarmUsd: 0.02, // 100k × $0.20/MTok
      nextColdUsd: 0.8, // 100k × $8/MTok (2 × $4)
      missPremiumUsd: 0.78,
      sessionMissUsd: (50_000 * (8 - 0.2)) / 1_000_000,
      expiresAt: NOW + 300,
      hint: null,
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

  it("hints: compact before a break while warm and going cold costs ≥ $1; /clear once cold; compact at ≥ 60%", () => {
    const warmBig = forecastCache(
      payload({
        context_window: { total_input_tokens: 500_000, used_percentage: 50 },
        prompt_cache: {
          warm: true,
          ttl: "5m",
          expires_at: NOW + 60,
          recache_tokens_if_cold: 500_000,
        },
      }),
      NOW,
    );
    expect(warmBig?.hint).toBe("break");
    const cold = forecastCache(
      payload({
        context_window: { total_input_tokens: 500_000, used_percentage: 50 },
        prompt_cache: { warm: false, ttl: "1h", recache_tokens_if_cold: 500_000 },
      }),
      NOW,
    );
    expect(cold?.hint).toBe("clear");
    expect(cold?.expiresAt).toBeNull();
    const big = forecastCache(
      payload({ context_window: { total_input_tokens: 600_000, used_percentage: 60 } }),
      NOW,
    );
    expect(big?.hint).toBe("compact");
  });

  it("missing context counts as 0 tokens; fast mode doubles", () => {
    const forecast = forecastCache(
      { model: { id: "claude-opus-5-5" }, fast_mode: true, prompt_cache: { warm: true } },
      NOW,
    );
    expect(forecast?.nextWarmUsd).toBe(0);
    expect(forecast?.hint).toBeNull();
  });
});
