import { cacheWriteRate, fastModeBilled, ratesFor, tokensCost } from "./pricing.js";

/** The parts of Claude Code's statusline payload this module reads (v2.1.251+ for `prompt_cache`). */
export interface CachePayload {
  readonly model?: { readonly id?: string };
  readonly fast_mode?: boolean;
  readonly context_window?: {
    readonly total_input_tokens?: number;
    readonly used_percentage?: number | null;
    readonly current_usage?: {
      readonly cache_read_input_tokens?: number;
      readonly cache_creation_input_tokens?: number;
    } | null;
  };
  readonly prompt_cache?: {
    readonly warm?: boolean;
    readonly ttl?: string;
    readonly expires_at?: number | null;
    readonly miss_recache_tokens?: number;
    readonly requests?: number;
    readonly misses?: number; // excludes expected rebuilds (compaction, tool-result clearing)
    readonly recache_tokens_if_cold?: number | null;
    readonly hit_ratio?: number | null;
    readonly last_miss_at?: number | null; // epoch seconds (v2.1.260+ for the two cause fields)
    readonly last_miss_cause?: { readonly causes?: ReadonlyArray<string> } | null;
    readonly miss_causes?: Readonly<Record<string, number>>;
  };
}

export interface CacheForecast {
  readonly warm: boolean;
  readonly secondsUntilCold: number | null; // null when already cold or unknown
  readonly ttlSeconds: number; // 300 (5m) or 3600 (1h) — the countdown's full length
  readonly nextWarmUsd: number; // reading the cached prefix on the next prompt
  readonly nextColdUsd: number | null; // re-writing it if the cache has gone cold; null = unknown
  readonly missPremiumUsd: number | null; // cold − warm: what letting the cache expire costs
  readonly sessionMissUsd: number; // already re-paid this session for misses (write − read on miss tokens)
  readonly expiresAt: number | null; // epoch seconds the cache goes cold; null = unknown/cold
  readonly requests: number | null; // main-conversation API requests this session; null = not reported
  readonly misses: number | null; // of those, re-processed what the cache held (not expected rebuilds)
  readonly recentMiss: string | null; // causes of a miss in the last RECENT_MISS_S, e.g. "tools changed"
}

/** The statusline names a miss's cause for this long after it (the line re-renders about every 30 s). */
export const RECENT_MISS_S = 120;

/**
 * Predicts the input-side cost of the NEXT prompt from the cache state Claude Code reports. Output tokens
 * and the new prompt's own text are not known in advance, so this is the floor the history alone costs.
 * Returns null for an unpriced model or before Claude Code reports any cache data.
 */
export function forecastCache(payload: CachePayload, nowSec: number): CacheForecast | null {
  const cache = payload.prompt_cache;
  const modelId = payload.model?.id;
  if (!cache || !modelId) return null;
  const contextTokens = payload.context_window?.total_input_tokens ?? 0;
  const rates = ratesFor(
    modelId,
    payload.fast_mode === true && fastModeBilled(modelId),
    contextTokens,
  );
  if (!rates) return null;

  const ttl = cache.ttl === "1h" ? "1h" : "5m";
  const writeRate = cacheWriteRate(rates, ttl);
  const expiresAt = cache.expires_at ?? null;
  const warm = cache.warm === true && (expiresAt === null || expiresAt > nowSec);
  const recache = cache.recache_tokens_if_cold ?? null;

  // The cached prefix: what the last request read or wrote to the cache. Its fresh input_tokens were never
  // cached, so the next request writes them warm or cold alike. Older payloads: the whole context.
  const usage = payload.context_window?.current_usage;
  const cachedTokens = usage
    ? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    : contextTokens;
  const nextWarmUsd = tokensCost(cachedTokens, rates.cacheRead);
  // Cold, the prefix the warm request would read is written instead: (write − read) per re-cached token.
  // Re-cached tokens beyond the prefix are new content, written either way.
  const missPremiumUsd =
    recache === null
      ? null
      : tokensCost(Math.min(recache, cachedTokens), writeRate - rates.cacheRead);
  const nextColdUsd = missPremiumUsd === null ? null : nextWarmUsd + missPremiumUsd;
  const sessionMissUsd = tokensCost(cache.miss_recache_tokens ?? 0, writeRate - rates.cacheRead);
  const missAt = cache.last_miss_at ?? null;
  const causes = cache.last_miss_cause?.causes ?? [];
  const recentMiss =
    missAt !== null && nowSec - missAt <= RECENT_MISS_S && causes.length > 0
      ? causes.map((cause) => cause.replaceAll("_", " ")).join(", ")
      : null;

  return {
    warm,
    secondsUntilCold: warm && expiresAt !== null ? Math.max(0, expiresAt - nowSec) : null,
    ttlSeconds: ttl === "1h" ? 3600 : 300,
    expiresAt: warm ? expiresAt : null,
    nextWarmUsd,
    nextColdUsd,
    requests: cache.requests ?? null,
    misses: cache.misses ?? null,
    missPremiumUsd,
    sessionMissUsd,
    recentMiss,
  };
}
