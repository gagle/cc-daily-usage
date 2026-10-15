# Calculations

Every formula in `src/calc.ts`. Functions mutate the `UsageState` they get.
Day vs period clocks: `docs/time-model.md`.

## `rolloverIfNeeded(usage, now, lastLedgerReading)`

```
pending = max(0, monthlySpent - periodFrozen)
midnight = first local midnight after lastUpdated
edge     = first UTC month start after lastUpdated
if midnight <= now and midnight <= edge:
    days[localDate(lastUpdated)] += pending ; periodFrozen += pending
if edge <= now:
    if pending > 0: days[localDate(edge - 1ms)] += pending
    monthlySpent = 0 ; periodFrozen = 0 ; ledgerBaseline = lastLedgerReading ?? 0
if either boundary crossed: lastUpdated = now
```

## `computeAvgPerDay` (today's max)

```
period    = UTC month of now
remaining = laboral days of period with day >= local today
            (local month before period → all; after → none)
max       = remaining == 0 ? null : max(0, ceil_cent((monthlyCap - periodFrozen) / remaining))
```

`0` = budget exhausted (`(over)` in red). `null` = no laboral day left in the
period. Today's own spend is excluded, so the max is stable through the day.
Removing a laboral day re-splits the same remainder evenly over the days left;
a cap change applies at once.

## `computeToday`

```
todayUsage   = days[localToday] ?? 0  +  pending      (edge-day booking + live)
todayUsedPct = max in {null, 0} ? null : todayUsage / max
safeMonthTotal = max == null ? null : periodFrozen + max
monthUsedPct = monthlyCap == 0 ? 0 : monthlySpent / monthlyCap
leftThisMonth = max(0, monthlyCap - monthlySpent)
monthDay0AvgPerDay = ceil_cent(monthlyCap / laboral days of period)   ("Day-1 max")
realAvgPerDay = round_cent(monthlySpent / laboral days reached)      (null when 0)
```

## `paceLabel`

```
null → null · ≤0.25 Coast · ≤0.50 Ahead · ≤0.75 Steady · ≤1.00 On pace
≤1.50 Hot · ≤2.00 Over · >2.00 Burn
```

## `captureSessionCost`

- delta = `currentCost - lastSeenCost`; a lower cost is a reset (`/clear`) and counts in full.
- `accumulate` (dollar-cap plan and no ledger) gates whether the delta joins `monthlySpent`; the baseline always advances.
- `lastSeenAt` refreshes when the cost changed or at most hourly (fewer writes); `cacheMissUsd` is kept.
- every positive delta also goes to `addApiEquivalent`, whatever the plan.

## `addApiEquivalent`, `addMissCauses`

- `apiEqDays[localToday] += delta`, `apiEqTotal += delta`. API-equivalent, not a bill: on Pro/Max it is
  what the same tokens cost on the API. Only sessions that render this statusline count.
- `addMissCauses(prior, current, missUsdDelta)`: new count per cause = current − prior (all of current
  when any count went down, a reset). `missUsdDelta` splits over the new counts; $ with no new count
  goes to `unknown`. The caller stores the returned counts as the session's `missCounts`.
- Both keep `DAY_HISTORY_DAYS` (62) local days; older keys drop when a new day key starts.

## `applyLedgerReading`

```
baseline = usedCredits < ledgerBaseline ? 0 : ledgerBaseline   (reset detected)
monthlySpent = usedCredits - baseline
if periodFrozen > monthlySpent:                                 (phantom session spend)
    scale this period's past local days by monthlySpent / periodFrozen
    periodFrozen = monthlySpent
```

`# ponytail` notes in `src/calc.ts`: the ledger is assumed to reset on the UTC
month; the proportional rescale is a guess at which days were inflated.

## `upgradeUsage`

v1 → v2: keeps day keys, derives `periodFrozen` = v1 "days before
lastUpdated's UTC day in its UTC month", repairs missing fields, clamps
`lastUpdated` to now. `apiEqDays`, `apiEqTotal`, `missCauses` default to
empty/0 without a schema bump. `freshUsage(now)` seeds new files.

## `classifyHasSpendCap`, `pruneStaleSessions`, `colorForPct`

- enterprise/team → `true`, pro/max → `false`, else `undefined`.
- sessions untouched for 2 days are dropped (object kept when nothing changes).
- color buckets: `<0.25` green · `<0.5` yellow-green · `<0.75` yellow · `<1` orange · `≥1` red. `ccColor()` in `src/statusline-render.ts` holds the same buckets as ANSI triplets.
