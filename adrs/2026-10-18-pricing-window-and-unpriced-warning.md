# 2026-10-18 - Price models of the last 6 months; warn on an unpriced model

## Status

Accepted

## Context

`src/pricing.ts` priced only current models. Transcripts from the last 6
months still hold turns on models retired or superseded since (Opus 4.5 /
4.1 / 4, Sonnet 4.5 / 4), so their history was unpriced. Opus 4.6 fast mode
($30/$150, 6× standard, per Claude Code's own cost table) was priced at the
standard rate. Checked against the official pricing page on 2026-10-18:
Sonnet 5.5 reads at $0.10 (0.05×), and Haiku 5.5 has a long-prompt tier over
100K tokens. On an unpriced model the statusline hid the cache part with no
reason given.

## Decision

- `RATES` covers every model served in the last 6 months that the pricing
  page lists; older ids stay unpriced.
- Fast mode is a per-model multiplier (`FAST_MODE_MULTIPLIER`): 2× on Opus
  5.5 / 5 / 4.8, 6× on Opus 4.6.
- `ratesFor` takes the prompt size to select Haiku 5.5's long-prompt tier.
- The statusline `cache` part shows `⚠ <model id>: no price, $ not
estimated` when the model is unpriced, in place of nothing.

## Options considered

| Option                          | Why not / why                                                     |
| ------------------------------- | ----------------------------------------------------------------- |
| Price every model ever released | Rates for ids the pricing page no longer lists cannot be verified |
| Fall back to a default model    | A guessed $ looks exact; Claude Code does this, we do not         |
| Keep hiding the part silently   | The user cannot tell "no data" from "no price"                    |

## Consequences

A model older than the window, or newer than the snapshot, shows the warning
until `RATES` is updated. Sonnet 4 / 4.5 1M-context premium pricing (over
200K) and Opus 4.7 fast mode are not modelled: the current page gives no
rate for them.

## Verification

`src/pricing.spec.ts`, `src/cache-forecast.spec.ts`,
`src/statusline-render.spec.ts`; manual test plan G5 and G12.
