# 2026-11-11 - Check prices against Claude Code's own cost-state

## Status

Accepted. Replaces the self-check in `adrs/2026-10-18-index-reprice-and-turn-metadata.md`.

## Context

Claude Code (2.1.319) writes a `cost-state` line when a run of a session
ends: `startTime`, `totalCostUSD` and per-model tokens and $ (`modelUsage`).
It is not in the public docs. On 104 Opus 5.5 and 47 Sonnet 5.5 runs of the
last 30 days, the same tokens at this tool's price table give Claude Code's $
exactly, when cache writes with no TTL split are billed at the 5m rate. Haiku
5.5 differs: its price goes by each request's prompt size.

Claude Code's totals are 1-12% above the transcripts' $ (one session 2×): its
runs count requests no transcript line records (for one session, 2.5M cache
write tokens). The old self-check compared the index with the statusline's
session cost at a 5% threshold, so that gap printed "differ by over 5%" on
correct prices.

## Decision

- The index keeps each run's `cost-state` per session (`ccRuns`, keyed by
  `startTime`, the larger reading wins). `PRICES_VERSION` `2026-11-11.1`
  rebuilds the index once, to read the lines already on disk.
- `selfCheck` prices each run's per-model tokens with the table and names a
  model whose gap is over 1% (on more than 5 cents), as a price change or fast
  mode. Haiku 5.5 is skipped.
- `report` says how much more Claude Code counted than the transcripts, for
  the sessions it counted whole (a run starts no later than the first turn,
  and the runs add up to at least the transcripts' $).

## Options considered

| Option                                  | Why not / why                                                     |
| --------------------------------------- | ----------------------------------------------------------------- |
| Keep the statusline session-cost check  | Its gap is mostly unrecorded requests, not prices: false warnings |
| Add the unrecorded $ to the index rows  | No model, day or component for it; the report states it apart     |
| Price unpriced models from `cost-state` | Per run, not per turn; the table stays the single price source    |

## Consequences

A price change shows within one finished run, per model, without the
statusline. Live sessions are not checked until their run ends. The
`cost-state` format can change without notice; a missing or changed line only
hides the check and the note.

## Verification

`src/report.spec.ts` (self-check, `claudeCodeTotals`, the note),
`src/transcript-index.spec.ts` (runs across passes), `src/transcript-parse.spec.ts`
(`parseCostState`); manual test P15.
