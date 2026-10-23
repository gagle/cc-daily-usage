# 2026-10-18 - Cost formulas checked against the official pricing docs

## Status

Accepted

## Context

A line-by-line check of every $ formula against the pricing, prompt-caching
and fast-mode pages (current, and the fast-mode page as archived on
2026-04-28) found these gaps:

- The cache forecast priced the uncached fresh input as a cache read. It also
  subtracted a read of tokens that a cold request does not re-write.
- `$/msg` is the cost of one API request. One prompt makes one request per
  tool step.
- Opus 4.7 fast mode was billed at $30/$150 (6×) and was missing. A
  `fast_mode` flag on Opus 4.6 / 4.7 now bills at standard prices.
- Transcripts carry `usage.inference_geo`. "us" is 1.1× on every token price.
- The coach charged fast mode at 2× for every model. It also repriced
  old-tokenizer usage (Claude 4.6 and earlier) on a newer model with the same
  token count. The pricing page says the newer tokenizer makes "approximately
  30% more" tokens for the same text.

## Decision

- Forecast: the cached prefix is `cache_read + cache_creation` from
  `context_window.current_usage`. The premium is `min(recache, cached) ×
(write − read)`.
- The statusline label is `$/req` and `next req ~$`.
- `FAST_MODE_MULTIPLIER` gains Opus 4.7 (6×). The forecast applies fast
  pricing only when `fastModeBilled` is true.
- `priceTurn` applies 1.1× when `inference_geo` is "us".
- The coach reprices each $ component by its rate ratio, times
  `tokenizerRatio` (1.3 across tokenizers). R2 is actual minus standard.
- A turn with `usage.iterations` is priced per request, and its context is
  the last request's prompt. In 200 recent transcripts, 3,005 turns had more
  than one request (the top-level counts equal their sum).

## Options considered

| Option                                   | Why not / why                                           |
| ---------------------------------------- | ------------------------------------------------------- |
| Keep `$/msg`                             | A prompt with tool steps costs many times the shown $   |
| Ignore the tokenizer change in the coach | It claimed savings for Opus 4.6 → 5.5, which costs more |
| Model the tokenizer per content type     | The docs give one approximate figure only               |

## Consequences

Every rate is checked mechanically against the official table (20 rows × 5
columns, no mismatch). The coach's cross-tokenizer $ is an estimate. The live
forecast has no geo field and stays at global prices. Contracted rates
(`modelPricing`) are not read.

## Verification

`src/pricing.spec.ts`, `src/cache-forecast.spec.ts`,
`src/transcript-parse.spec.ts`, `src/rules.spec.ts`,
`src/statusline-render.spec.ts`; manual test plan G13 and G14.
