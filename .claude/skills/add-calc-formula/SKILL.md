---
name: add-calc-formula
description: Use when adding or changing a formula in src/calc.ts or src/clock.ts (rollover, max per day, today/month totals, ledger, pace, pruning) — keeps the pure math, its 100%-coverage spec with the time-zone matrix, and docs/calculations.md + docs/time-model.md in step.
---

# Add or change a calc.ts formula

`src/calc.ts` is pure math that mutates the `UsageState` it gets. Days are
local, the budget period is the UTC month (`docs/time-model.md`).

## Steps

1. Read `docs/calculations.md` and `docs/time-model.md` first. Check the
   invariant `todayUsage = days[today] + (monthlySpent − periodFrozen)` still
   holds after your change.
2. Change `src/calc.ts` (date helpers belong in `src/clock.ts`). Keep the
   in-place style; keep rollover O(1).
3. Update `src/calc.spec.ts` in the same change, including a case under
   `vi.stubEnv("TZ", "Europe/Madrid")` and `"America/Los_Angeles"` when the
   change touches days or the month edge.
4. Update the matching section of `docs/calculations.md`
   (and `docs/time-model.md` for boundary rules).
5. A color change also updates `ccColor()` in `src/statusline-render.ts`.
6. `pnpm vitest run src/calc.spec.ts src/clock.spec.ts`, then the full
   sequence in `docs/testing-and-verification.md`.
