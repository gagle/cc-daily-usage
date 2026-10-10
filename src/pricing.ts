/** $ per million tokens. Cache writes are derived from `input` (see cacheWriteRate). */
export interface ModelRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

/**
 * Anthropic first-party list prices, $/MTok — snapshot 2026-10-06 from the claude-api skill's model table.
 * Unknown models stay unpriced (no $ shown) rather than guessed.
 * # ponytail: static snapshot; a price change needs a release. Upgrade path: honour Claude Code's
 * `modelPricing` setting, or fetch a pricing file. Haiku 5.5's >100K-prompt tier ($0.50/$2.50) is ignored.
 */
const RATES: Readonly<Record<string, ModelRates>> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/** Models whose fast mode is priced at 2× standard (Opus 5 / 5.5 / 4.8 per the claude-api skill). */
const FAST_MODE_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);

/** Canonical model key: lowercase, no `[1m]`-style suffix, no provider prefix (`us.anthropic.`,
 * `anthropic.`, `vendor/`), no Vertex `@date`, no trailing `-YYYYMMDD`. */
export function normalizeModelId(modelId: string): string {
  let key = modelId.trim().toLowerCase();
  key = key.replace(/\[[^\]]*\]$/, "");
  key = key.replace(/@.*$/, "");
  const slash = key.lastIndexOf("/");
  if (slash !== -1) key = key.slice(slash + 1);
  const claudeAt = key.indexOf("claude-");
  if (claudeAt > 0) key = key.slice(claudeAt);
  key = key.replace(/-\d{8}$/, "");
  return key;
}

/** null = unpriced model. `fast` doubles every rate on the models where fast mode exists. */
export function ratesFor(modelId: string, fast = false): ModelRates | null {
  const key = normalizeModelId(modelId);
  const rates = RATES[key];
  if (!rates) return null;
  if (!fast || !FAST_MODE_MODELS.has(key)) return rates;
  return { input: rates.input * 2, output: rates.output * 2, cacheRead: rates.cacheRead * 2 };
}

/** Cache write $/MTok: 1.25× input for the 5-minute TTL, 2× input for the 1-hour TTL. */
export function cacheWriteRate(rates: ModelRates, ttl: "5m" | "1h"): number {
  return rates.input * (ttl === "1h" ? 2 : 1.25);
}

export function tokensCost(tokens: number, ratePerMTok: number): number {
  return (tokens * ratePerMTok) / 1_000_000;
}
