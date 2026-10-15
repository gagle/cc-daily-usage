# 2026-10-15 - Limit history, API-equivalent $ and the mod feed

## Status

Accepted

## Context

The CLI showed only what was spent. Users on Pro/Max could not see how fast a
limit window burns, what 1% of the week costs, or why the prompt cache missed.
The `/cost-tracker` mod (handoff 2) needs one file with all of it, written by
one writer. The render must stay network-free and cheap (`docs/performance.md`).

## Decision

- Limit readings go to `accounts/<key>/limits.json` (change points only, 8 days
  / 2,000 samples); runway and $ per 1% are pure functions in
  `src/limits-history.ts`.
- Every session cost delta is booked as API-equivalent $ per local day in
  `usage.apiEqDays`, for every plan, next to a monotone `apiEqTotal`.
- Cache-miss causes are booked per local day in `usage.missCauses`.
- Sessions are kept 35 days in `sessions-map.json` (transcript path, lines).
- `feed.json` is built by `buildFeed` and written only by the refresher.
- Growing stores are separate files, not `usage.json` fields, so the
  `usage.json` parse on every render stays small.
- New `usage.json` fields default in `upgradeUsage`; no schema bump.

## Options considered

| Option                                                 | Why not / why                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Samples and session map inside `usage.json` (schema 3) | `usage.json` is parsed and rewritten on the render; 2,000 samples would grow it ~150 KB             |
| Feed written by the render                             | Adds a write per render; refresher already runs once per API TTL                                    |
| Rate from the first and last sample in 2 h only        | Samples are change points; a flat hour has no sample, so the reading in force 2 h ago is the anchor |

## Consequences

- One more small file read on the render (`limits.json`), one more on new
  sessions (`sessions-map.json`). Measure with `scripts/bench.sh` (J1).
- Accounts without OAuth get no refresher, so no feed.
- API-equivalent $ counts only sessions that render this statusline.
- Follow-up: config versioning (CLI-6), transcript index (CLI-8), coach (CLI-9).

## Verification

`src/limits-history.spec.ts`, `src/feed.spec.ts`, `src/sessions-map.spec.ts`,
manual plan section L.
