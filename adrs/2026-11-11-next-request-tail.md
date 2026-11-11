# 2026-11-11 - The next request also writes the last reply

## Status

Accepted. Changes the `$/req` formula of `adrs/2026-10-18-exact-cost-formulas.md`.

## Context

The forecast priced the next request as a read of the last cached prefix
only. On 2,569 consecutive warm request pairs from local transcripts, the next
request read exactly that prefix in 97% of cases and wrote at least the last
request's fresh input + output in 99.8%. Without that write the forecast was a
median 84% of the real input-side cost. Separately, 232 multi-request
responses carried a top-level TTL split that covers only the first request,
so their token totals were short (their $ was right: priced per request).

## Decision

- `forecastCache` and `cacheState`: next warm = cached prefix × read rate +
  (last fresh input + output) × write rate; next cold = the same with the
  prefix at the write rate. Haiku 5.5's tier goes by context + that tail.
  `cacheState` also applies the last turn's US-only multiplier.
- `parseTurn`: a response with several requests totals its requests; writes a
  TTL split does not cover count at the 5m rate, as Claude Code bills them.

## Options considered

| Option                                | Why not / why                                        |
| ------------------------------------- | ---------------------------------------------------- |
| Estimate the new prompt from its text | ~4 chars per token is a guess; the floor stays exact |
| Typical tool-result size per session  | Varies by an order of magnitude between tool calls   |

## Consequences

`$/req`, `if cold`, the prompt gate's warm and cold $ and the advisor's
re-read $ rise by the tail's write (median 94% of the real cost now, a floor
in all but 3 of 2,569 cases). The statusline payload has no geo field, so its
forecast stays at global prices.

## Verification

`src/cache-forecast.spec.ts`, `src/session-model.spec.ts`,
`src/transcript-parse.spec.ts` (token totals).
