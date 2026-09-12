# Calculations

Every formula in `src/calc.ts`, verbatim. `calc.ts` mutates its `UsageState`
argument in place — functions here never return a new state object, they modify
the one passed in. Read this instead of re-deriving formulas from source.

## `rolloverIfNeeded`

Walks UTC days from `usage.lastUpdated` to now, one day at a time:

- Freezes each completed day into `usage.days[iso] = max(0, monthlySpent - sumOfDaysBeforeInMonth)`.
- Resets `monthlySpent = 0` when a month boundary is crossed.
- Freezes `frozenAvgPerDay` / `frozenSafeMonthTotal` once per UTC day (see
  `computeAvgPerDay` below) — these are **frozen at the start of the day, not
  live** the rest of the day. This is a deliberate deviation: it keeps the
  statusline's "$/day budget" number stable through a single day even as
  `monthlySpent` changes, instead of jittering on every render.

## `computeAvgPerDay`

```
remaining = days left in month (including today)
remaining === 0 -> null
otherwise -> max(0, ceil(((monthlyCap - monthlySpent) / remaining) * 100) / 100)
```

Rounds up to the nearest cent so the suggested daily budget never under-shoots
the cap.

## `computeToday`

```
todayUsage    = max(0, monthlySpent - sumOfDaysBeforeInMonth(today))
todayUsedPct  = avgPerDay in {null, 0} ? null : todayUsage / avgPerDay
monthUsedPct  = monthlyCap === 0 ? 0 : monthlySpent / monthlyCap
```

`avgPerDay` and the two "safe" totals used here come from the **frozen** values
set once per day by `rolloverIfNeeded`, not recomputed live — see the note above.

## `captureSessionCost`

Per-session delta capture, keyed by Claude Code's own session id:

- `currentCost < lastSeenCost` is treated as a **fresh baseline**, not a negative
  delta — this happens when Claude Code itself resets a session's reported cost
  (e.g. a new session reusing an id, or a mid-session model/account switch).
- The `accumulate` flag gates whether the delta actually folds into
  `monthlySpent`. This exists for the Pro/Enterprise mid-session account-switch
  case: a session's cost is tracked, but only accumulated into the spend total
  once the account is confirmed to have a spend cap (`hasSpendCap === true`).

## `reconcileFromExtraUsageSnapshot`

Corrects a previously-frozen day using Anthropic's own cumulative
`extra_usage.used_credits` ledger (fetched via `/api/oauth/usage`, see
`anthropic-usage.ts`). Only applies the correction when the self-tracked figure
disagrees with Anthropic's ledger by more than $0.005 — small floating-point
drift is left alone rather than triggering a correction every call.

## `colorForPct`

5-bucket color thresholds used for both the today and month usage bars:

| `pct`         | Bucket       |
| ------------- | ------------ |
| `< 0.25`      | green (safe) |
| `0.25 – 0.49` | yellow-green |
| `0.5 – 0.74`  | yellow       |
| `0.75 – 0.99` | orange       |
| `>= 1`        | red (over)   |

This exact table is duplicated as `ccColor()` in `assets/statusline.mjs` (the
installed script can't import from `calc.ts` — it runs standalone). If you change
one, change the other.

## `pruneStaleSessions`

Drops any entry from `usage.sessions` whose `lastSeenAt` is more than 2 days old
— keeps the per-session delta-capture map from growing unbounded across long-lived
account histories.

## See also

- `docs/data-model.md` for the exact shape of `UsageState`/`Config` these functions
  read and mutate.
- `docs/architecture.md` for the `hasSpendCap` gate that decides whether any of
  this runs at all for a given account.
