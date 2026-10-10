# Time model (two clocks)

ADR: `adrs/2026-10-10-two-clock-day-model.md`. Helpers: `src/clock.ts`.

| Concept                                                                             | Clock                              | Why                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| A "day" (`usage.days` keys, laboral membership, today, past/future in the calendar) | **local** time zone of the machine | the user works in local days                                     |
| The budget period (`monthlySpent`, `monthlyCap`, `ledgerBaseline`)                  | **UTC calendar month**             | Anthropic's usage-credits ledger and `monthly_limit` reset there |

## State

- `monthlySpent` — spend in the current UTC period.
- `periodFrozen` — the part of `monthlySpent` already frozen into past local days.
- pending = `monthlySpent − periodFrozen` — today's live spend in this period.
- `lastUpdated` — moves only when a boundary was crossed.

## Boundaries (`rolloverIfNeeded`)

All spend since the last freeze was captured at or before `lastUpdated`, so
only two boundaries can carry money, and the walk is O(1):

1. The first **local midnight** after `lastUpdated`: pending → `days[localDate(lastUpdated)]`, and into `periodFrozen`.
2. The latest **UTC month edge** after `lastUpdated`: pending that the midnight did not take → the local day containing the edge; then `monthlySpent = periodFrozen = 0`, `ledgerBaseline = last ledger reading`.

Same instant (a UTC machine): the midnight goes first, so the day belongs to
the old period. Days with no activity stay absent (`—` in the calendar).

## Edge hours per zone

| Zone                         | What happens around the month edge                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UTC                          | midnight = edge; clean split                                                                                                                                |
| UTC+ (Madrid, +1/+2)         | 00:00–02:00 local on day 1 is still the old period: today has no pace (no laboral day of the old period left) and shows `$today` only; spend books on day 1 |
| UTC− (Los Angeles, −7/−8)    | from 17:00 local on the last day the new period runs: the whole new month is ahead, the evening's spend counts against the new cap (as Anthropic counts it) |
| ±14h (Kiritimati, Pago Pago) | same rules; the edge window is longer                                                                                                                       |

DST days (23h/25h) are handled by `new Date(y, m, d + 1)` in
`nextLocalMidnight`.

## Laboral days relative to the period

`remainingLaboralDaysCount` / `elapsedLaboralDaysCount` in `src/calc.ts`
compare the local month with the period month: local before the period →
the whole month is ahead; local after → nothing is ahead.

## v1 data (UTC day keys)

`upgradeUsage` keeps old keys as they are (at most one day of drift on old
history), derives `periodFrozen` the way v1 computed "days before today", and
sets `schemaVersion: 2`. A missing, garbled or future `lastUpdated` becomes
now — a walk from 1970 can never happen.
