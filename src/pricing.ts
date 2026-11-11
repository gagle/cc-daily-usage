/** $ per million tokens. Cache writes are derived from `input` (see cacheWriteRate). */
export interface ModelRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

/**
 * Anthropic first-party list prices, $/MTok — snapshot 2026-11-11 of platform.claude.com/docs/en/about-claude/pricing.
 * Unknown models stay unpriced (no $ shown) rather than guessed.
 * # ponytail: static snapshot; a price change needs a release. Upgrade path: honour Claude Code's
 * `modelPricing` setting, or fetch a pricing file.
 */
/** Date of the price snapshot below, plus `.N` when the index must be rebuilt for another reason (`.1`: read
 * Claude Code's `cost-state` lines). A change makes the transcript index re-build its rows (see runIndexPass). */
export const PRICES_VERSION = "2026-11-11.1";

const RATES: Readonly<Record<string, ModelRates>> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-mythos-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  // Models served at some point in the last 6 months (model-deprecations page): transcripts still hold them.
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3 },
};

/** Haiku 5.5 bills a request whose prompt (input + cache reads + cache writes) is over 100K tokens at these. */
const LONG_PROMPT_TOKENS = 100_000;
const LONG_PROMPT_RATES: Readonly<Record<string, ModelRates>> = {
  "claude-haiku-5-5": { input: 0.5, output: 2.5, cacheRead: 0.05 },
};

/** Fast-mode price ÷ standard price per model, as billed when `usage.speed` is "fast" (pricing page; Opus 4.6 /
 * 4.7 at $30/$150 from the fast-mode page as archived 2026-04-28, before their fast mode was removed). */
const FAST_MODE_MULTIPLIER: Readonly<Record<string, number>> = {
  "claude-fable-5-2": 2,
  "claude-mythos-5-2": 2,
  "claude-opus-5-5": 2,
  "claude-opus-5": 2,
  "claude-opus-4-8": 2,
  "claude-opus-4-7": 6,
  "claude-opus-4-6": 6,
};

/** Fast mode removed: a `speed: "fast"` request now runs and bills at standard speed. */
const FAST_MODE_REMOVED = new Set(["claude-opus-4-7", "claude-opus-4-6"]);

/** `inference_geo: "us"` multiplies every token price (Claude 4.6 and later; earlier models reject the field). */
const US_ONLY_MULTIPLIER = 1.1;

/** Whether the model's price depends on each request's prompt size (Haiku 5.5): a sum of tokens over many
 * requests cannot be re-priced. */
export function hasPromptTiers(modelId: string): boolean {
  return normalizeModelId(modelId) in LONG_PROMPT_RATES;
}

/** Whether a fast-mode request on this model is billed at the fast price today. */
export function fastModeBilled(modelId: string): boolean {
  const key = normalizeModelId(modelId);
  return key in FAST_MODE_MULTIPLIER && !FAST_MODE_REMOVED.has(key);
}

/** Canonical model key: lowercase, no `[1m]`-style suffix, no provider prefix (`us.anthropic.`,
 * `anthropic.`, `vendor/`), no Vertex `@date`, no trailing `-YYYYMMDD`, a version dot as a dash. */
export function normalizeModelId(modelId: string): string {
  let key = modelId.trim().toLowerCase();
  key = key.replace(/\[[^\]]*\]$/, "");
  key = key.replace(/@.*$/, "");
  const slash = key.lastIndexOf("/");
  if (slash !== -1) key = key.slice(slash + 1);
  const claudeAt = key.indexOf("claude-");
  if (claudeAt > 0) key = key.slice(claudeAt);
  key = key.replace(/-\d{8}$/, "");
  key = key.replace(/(\d)\.(\d)/g, "$1-$2"); // gateway spelling `claude-opus-4.8`
  return key;
}

/**
 * null = unpriced model. `fast` (the request ran at fast speed) applies the model's fast-mode multiplier;
 * `promptTokens` (the request's whole prompt) selects a long-prompt tier where one exists; `usOnly`
 * (`inference_geo: "us"`) applies 1.1×. The multipliers stack, as the pricing page states.
 */
export function ratesFor(
  modelId: string,
  fast = false,
  promptTokens = 0,
  usOnly = false,
): ModelRates | null {
  const key = normalizeModelId(modelId);
  const rates =
    (promptTokens > LONG_PROMPT_TOKENS ? LONG_PROMPT_RATES[key] : undefined) ?? RATES[key];
  if (!rates) return null;
  const multiplier =
    (fast ? (FAST_MODE_MULTIPLIER[key] ?? 1) : 1) * (usOnly ? US_ONLY_MULTIPLIER : 1);
  if (multiplier === 1) return rates;
  return {
    input: rates.input * multiplier,
    output: rates.output * multiplier,
    cacheRead: rates.cacheRead * multiplier,
  };
}

/** Claude 4.7 and later (Haiku 5.5 included) use a newer tokenizer: the same text is ~30% more tokens. */
const NEW_TOKENIZER = /^claude-(opus-4-[78]|opus-5|sonnet-5|haiku-5|fable|mythos)/;
const NEW_TOKENIZER_GROWTH = 1.3;

/**
 * Tokens the same text takes on `to` per token on `from`. The pricing page says "approximately 30% more"
 * and that the exact increase depends on the content, so a cross-tokenizer $ is an estimate.
 */
export function tokenizerRatio(from: string, to: string): number {
  const fromNew = NEW_TOKENIZER.test(normalizeModelId(from));
  const toNew = NEW_TOKENIZER.test(normalizeModelId(to));
  if (fromNew === toNew) return 1;
  return toNew ? NEW_TOKENIZER_GROWTH : 1 / NEW_TOKENIZER_GROWTH;
}

/** Cache write $/MTok: 1.25× input for the 5-minute TTL, 2× input for the 1-hour TTL. */
export function cacheWriteRate(rates: ModelRates, ttl: "5m" | "1h"): number {
  return rates.input * (ttl === "1h" ? 2 : 1.25);
}

/** $ per server-side web search: $10 per 1,000 (claude-api skill, 2026-10-18). Web fetch has no fee of its own
 * there, so fetches stay a count. */
export const WEB_SEARCH_USD = 0.01;

export function tokensCost(tokens: number, ratePerMTok: number): number {
  return (tokens * ratePerMTok) / 1_000_000;
}
