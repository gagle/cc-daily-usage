# Calculations

Every formula in `src/calc.ts`, verbatim. `calc.ts` mutates its `UsageState`
argument in place — functions here never return a new state object, they modify
the one passed in. Read this instead of re-deriving formulas from source.

## `rolloverIfNeeded`

Walks UTC days from `usage.lastUpdated` to now, one day at a time:

- Freezes each completed day into `usage.days[iso] = max(0, monthlySpent - sumOfDaysBeforeInMonth)`.
- Resets `monthlySpent = 0` when a month boundary is crossed, and sets
  `ledgerBaseline` to the last ledger reading still in `extraUsageCache` (0 when none).

It does not store any daily max. That number is derived (next section).

## `computeAvgPerDay`

```
daysBefore = sum of usage.days in today's month with date < today
remaining  = laboral days in this month with day >= today
remaining === 0 -> null
otherwise       -> max(0, ceil(((monthlyCap - daysBefore) / remaining) * 100) / 100)
```

Rounds up to the nearest cent. Derived on every render, never frozen: both inputs
are fixed for the whole UTC day (today's own spend is not in `daysBefore`), so the
value is stable through the day. It follows a `monthlyCap` change at once, and a
weekend's spend (frozen into `days`) lowers the next laboral day's max.
`0` means the budget is spent (`budgetExhausted` in the statusline JSON).

## `computeToday`

```
todayUsage     = max(0, monthlySpent - sumOfDaysBeforeInMonth(today))
safeMonthTotal = avgPerDay === null ? null : daysBefore + avgPerDay
todayUsedPct   = avgPerDay in {null, 0} ? null : todayUsage / avgPerDay
monthUsedPct   = monthlyCap === 0 ? 0 : monthlySpent / monthlyCap
```

Also returns `paceLabel` (see below) and `monthDay0AvgPerDay`.
Laboral days show `$today/$avg (pct)`; `avgPerDay === 0` shows `$today/$0.00 (over)` in red;
non-laboral days show `$today` only (see `isLaboralDay` / cli.ts); `monthlySpent`
still includes off-day spend.

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

Compares `todayUsage` to **today’s** `avgPerDay` (not the month day-1 max).

## Month day-1 max

Equal-split plan for the month, derived live (a cap change re-bases it at once):

```
monthDay0AvgPerDay = monthlyCap / laboralDays.length   (ceil to cent; null with no laboral days)
```

The field name keeps the old `Day0` spelling; the TUI labels it "Day-1 max".

## `computeRealAvgPerDay`

```
elapsedLaboral = count of laboral days with day <= today (UTC)
elapsed === 0 -> null
otherwise     -> round_cent(monthlySpent / elapsedLaboral)
```

Actual burn per work day so far. Off-day spend is in `monthlySpent` but does **not**
grow the divisor, so weekend burn raises real avg. Distinct from `computeAvgPerDay`
(remaining budget ÷ remaining laboral days).

## `captureSessionCost`

Per-session delta capture, keyed by Claude Code's own session id:

- `currentCost < lastSeenCost` is treated as a **fresh baseline**, not a negative
  delta — this happens when Claude Code itself resets a session's reported cost
  (e.g. a new session reusing an id, or a mid-session model/account switch).
- The `accumulate` flag gates whether the delta actually folds into
  `monthlySpent`. Enterprise with a live Anthropic **usage-credits** ledger sets
  `accumulate: false` and instead calls `applyLedgerReading` (see
  `cli.ts`) — a new session id reporting a full `cost.total_cost_usd` must not
  invent phantom today-spend on top of the ledger. When credits are unavailable,
  session deltas still accumulate for dollar-cap accounts.

## `applyLedgerReading`

Folds Anthropic's cumulative `extra_usage.used_credits` (fetched via
`/api/oauth/usage`, see `anthropic-usage.ts`) into `monthlySpent`:

```
baseline     = usedCredits < ledgerBaseline ? 0 : ledgerBaseline
monthlySpent = usedCredits - baseline
```

A reading below the baseline means the ledger reset, so the baseline drops to 0.
Assumes the ledger resets on the UTC calendar month. If its cycle differs the budget
month is wrong (`# ponytail` note in `calc.ts`).

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
