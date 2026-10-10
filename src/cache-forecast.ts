import { cacheWriteRate, ratesFor, tokensCost } from "./pricing.js";

/** The parts of Claude Code's statusline payload this module reads (v2.1.251+ for `prompt_cache`). */
export interface CachePayload {
  readonly model?: { readonly id?: string };
  readonly fast_mode?: boolean;
  readonly context_window?: {
    readonly total_input_tokens?: number;
    readonly used_percentage?: number | null;
  };
  readonly prompt_cache?: {
    readonly warm?: boolean;
    readonly ttl?: string;
    readonly expires_at?: number | null;
    readonly miss_recache_tokens?: number;
    readonly recache_tokens_if_cold?: number | null;
    readonly hit_ratio?: number | null;
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
  // break: warm but going cold would be costly — /compact before a break, while reading it is cheap.
  // clear: already cold and costly — /clear is the only free move. compact: context is large.
  readonly hint: "break" | "clear" | "compact" | null;
}

/** A miss (re-cache) at least this expensive is worth avoiding: hand off while warm, /clear once cold. */
export const COSTLY_MISS_USD = 1;
/** Context share past which every prompt re-reads a lot — /compact at a natural break. */
const COMPACT_CONTEXT_PCT = 60;

/**
 * Predicts the input-side cost of the NEXT prompt from the cache state Claude Code reports. Output tokens
 * and the new prompt's own text are not known in advance, so this is the floor the history alone costs.
 * Returns null for an unpriced model or before Claude Code reports any cache data.
 * # ponytail: break/compact hints are fixed thresholds, not a model of the user's next task; upgrade path:
 * compare against the measured cost of a fresh session's first turn.
 */
export function forecastCache(payload: CachePayload, nowSec: number): CacheForecast | null {
  const cache = payload.prompt_cache;
  const modelId = payload.model?.id;
  if (!cache || !modelId) return null;
  const rates = ratesFor(modelId, payload.fast_mode === true);
  if (!rates) return null;

  const ttl = cache.ttl === "1h" ? "1h" : "5m";
  const writeRate = cacheWriteRate(rates, ttl);
  const contextTokens = payload.context_window?.total_input_tokens ?? 0;
  const expiresAt = cache.expires_at ?? null;
  const warm = cache.warm === true && (expiresAt === null || expiresAt > nowSec);
  const recache = cache.recache_tokens_if_cold ?? null;

  const nextWarmUsd = tokensCost(contextTokens, rates.cacheRead);
  const nextColdUsd = recache === null ? null : tokensCost(recache, writeRate);
  const missPremiumUsd = nextColdUsd === null ? null : Math.max(0, nextColdUsd - nextWarmUsd);
  const sessionMissUsd = tokensCost(cache.miss_recache_tokens ?? 0, writeRate - rates.cacheRead);

  const usedPct = payload.context_window?.used_percentage ?? 0;
  let hint: CacheForecast["hint"] = null;
  if (warm && missPremiumUsd !== null && missPremiumUsd >= COSTLY_MISS_USD) hint = "break";
  else if (!warm && nextColdUsd !== null && nextColdUsd >= COSTLY_MISS_USD) hint = "clear";
  else if (usedPct >= COMPACT_CONTEXT_PCT) hint = "compact";

  return {
    warm,
    secondsUntilCold: warm && expiresAt !== null ? Math.max(0, expiresAt - nowSec) : null,
    ttlSeconds: ttl === "1h" ? 3600 : 300,
    expiresAt: warm ? expiresAt : null,
    nextWarmUsd,
    nextColdUsd,
    missPremiumUsd,
    sessionMissUsd,
    hint,
  };
}
