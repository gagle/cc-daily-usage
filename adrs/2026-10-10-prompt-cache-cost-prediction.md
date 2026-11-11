# 2026-10-10 - Predict the next prompt's cost from the prompt cache

## Status

Accepted

## Context

The goal is predictable spend: know what the next prompt costs and when
waiting or switching makes it expensive. Prompt caching dominates input cost
on long sessions: a warm prefix is read at ~0.1× input (less on Opus 5.5 and
Fable 5.1); an expired or invalidated one is re-written at 1.25× (5 m TTL) or
2× (1 h TTL). Claude Code (v2.1.251+) reports the state in the statusline
payload's `prompt_cache` object. antiburn (`gll/antiburn`) detects the same
thing after the fact as "cache rehydration".

## Decision

- `src/pricing.ts`: dated list-price snapshot per model, multipliers 1.25×/2×,
  fast mode 2× where it exists; unknown models stay unpriced.
- `src/cache-forecast.ts`: next prompt warm vs cold cost, premium of letting
  it expire, countdown, cost already re-paid for misses, `→ /compact` and
  `→ handoff` hints with fixed thresholds (`# ponytail` in the file).
- Statusline `🧊`/`❄` segment; calendar header sums today's misses.

## Options considered

| Option                                      | Why not / why                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| Parse the transcript JSONL (antiburn's way) | slower on every render; Claude Code already summarizes it                  |
| Live pricing fetch                          | network on the render path; a snapshot with an unpriced fallback is honest |
| **Read `prompt_cache`**                     | free, exact token counts, includes Claude Code's own miss diagnosis        |

## Consequences

Older Claude Code versions (no `prompt_cache`) show no segment. Prices need a
release to change. The forecast is the input-side floor; output tokens are
unknown in advance.

## Verification

`src/cache-forecast.spec.ts`, `src/pricing.spec.ts`, manual plan section G.
