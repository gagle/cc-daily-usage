# 2026-10-10 - Local days, UTC budget period

## Status

Accepted

## Context

v1 used UTC for everything. A user in Madrid saw "today" change at 02:00 and
late-night work booked on the wrong day; in Los Angeles at 17:00. Laboral days
are a local concept (the user's work week), but Anthropic's usage-credits
ledger and the org's `monthly_limit` reset on the UTC month (assumption noted
as `# ponytail` in `src/calc.ts`). The user asked for both to work now, so no
migration is needed later.

v1 also seeded `usage.json` with `lastUpdated` = 1970: the first render on a
new install walked every day since then (20,736 entries, ~37 s, O(n²)).

## Decision

- Two clocks (`src/clock.ts`): a day is a local date; the budget period is the
  UTC month. `usage.periodFrozen` tracks what of `monthlySpent` is already frozen
  into past days, so today's spend is `monthlySpent − periodFrozen`.
- Rollover handles exactly two boundaries in O(1): the first local midnight
  and the latest UTC edge after `lastUpdated` (`docs/time-model.md`).
- Days without activity stay absent instead of fake `$0.00`.
- `schemaVersion: 2`; `upgradeUsage` reads v1 files without rewriting history
  (keys stay, at most one day of drift on old data); a fresh file starts at now.

## Options considered

| Option                 | Why not / why                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Keep UTC               | wrong "today" for most users                                                                                       |
| Everything local       | the cap would reset at local midnight while Anthropic's does not — the edge hours would double-count or lose spend |
| Configurable time zone | more code and combinations; the machine's zone is what the user lives in                                           |
| **Two clocks**         | correct for both the user's days and the ledger's month                                                            |

## Consequences

- In UTC+ zones the first hours of day 1 still belong to the old period: no
  pace is shown, only `$today`. In UTC− zones the new period starts in the
  evening of the last day. Both mirror how Anthropic counts.
- A machine time-zone change mid-month moves future day keys; history stays.

## Verification

`src/calc.spec.ts` (Madrid and Los Angeles edges, gaps, v1 upgrade, fresh
install), `src/clock.spec.ts` (DST), `e2e/cli.spec.ts` (first render),
manual plan section B.
