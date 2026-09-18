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
Also returns `paceLabel` (see below) and `monthDay0AvgPerDay` when stored for this month.
Laboral days show `$today/$avg (pct)`; non-laboral days show `$today` only
(see `isLaboralDay` / cli.ts); `monthlySpent` still includes off-day spend.

## `paceLabel`

```
null            -> null
pct <= 0.25     -> "Coast"
pct <= 0.50     -> "Ahead"
pct <= 0.75     -> "Steady"
pct <= 1.00     -> "On pace"
pct <= 1.50     -> "Hot"
pct <= 2.00     -> "Over"
pct >  2.00     -> "Burn"
```

Compares `todayUsage` to **today’s** `frozenAvgPerDay` (not the month day-0 max).

## Month day-0 max

Equal-split plan for the month:

```
monthDay0AvgPerDay = computeAvgPerDay(config, spent=0, laboralDays.length)
                   = monthlyCap / laboralDaysInMonth   (ceil to cent)
```

Stored once per `monthDay0ForMonth` (`YYYY-MM`). **Not** copied from
`frozenAvgPerDay` (that is remaining pace and shrinks after spend). A mid-month
backfill that left `day0 === frozenAvgPerDay` while `monthlySpent > 1` is healed
back to the equal-split. Cleared when `rolloverIfNeeded` crosses a month boundary.

## `computeRealAvgPerDay`

```
elapsedLaboral = count of laboral days with day <= today (UTC)
elapsed === 0 -> null
otherwise     -> round_cent(monthlySpent / elapsedLaboral)
```

Actual burn per work day so far. Off-day spend is in `monthlySpent` but does **not**
grow the divisor — so weekend burn raises real avg. Distinct from `frozenAvgPerDay`
(remaining budget ÷ remaining laboral days).

Non-laboral spend and theoretic max: raising `monthlySpent` on a Sunday immediately
lowers `frozenAvgPerDay` via `refreshFrozenPaceIfNonLaboral` (and Monday’s day-start
freeze), because the numerator `monthlyCap − monthlySpent` shrinks while the remaining
laboral divisor ignores the Sunday itself.

## `refreshFrozenPaceIfNonLaboral`

On a non-laboral UTC day, after session cost has been captured into `monthlySpent`,
recompute the frozen pace so weekend/off-day burn immediately reduces the
theoretical daily budget for remaining laboral days:

```
remaining = count of laboral days in this month with day >= today
frozenAvgPerDay = computeAvgPerDay(config, monthlySpent, remaining)
frozenSafeMonthTotal = avgPerDay === null ? null : avgPerDay + monthlySpent
```

No-op when today is laboral (day-start freeze stays stable) or `frozenForDate`
is not today.

## `captureSessionCost`

Per-session delta capture, keyed by Claude Code's own session id:

- `currentCost < lastSeenCost` is treated as a **fresh baseline**, not a negative
  delta — this happens when Claude Code itself resets a session's reported cost
  (e.g. a new session reusing an id, or a mid-session model/account switch).
- The `accumulate` flag gates whether the delta actually folds into
  `monthlySpent`. Enterprise with a live Anthropic **usage-credits** ledger sets
  `accumulate: false` and instead assigns `monthlySpent = usedCredits` (see
  `cli.ts`) — a new session id reporting a full `cost.total_cost_usd` must not
  invent phantom today-spend on top of the ledger. When credits are unavailable,
  session deltas still accumulate for dollar-cap accounts.

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
