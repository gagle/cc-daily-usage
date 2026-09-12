---
name: add-calc-formula
description: Use when adding or changing a formula in src/calc.ts (rollover, avgPerDay, today/month totals, reconciliation, color thresholds, session pruning) — keeps the pure-math layer, its 100%-coverage spec, and docs/calculations.md from drifting apart.
---

# Add or change a calc.ts formula

`calc.ts` is pure math that mutates its `UsageState` argument in place — see
`docs/architecture.md`'s "Why these decisions" for why. Every formula here
also has a duplicate: `colorForPct` is re-implemented as `ccColor()` in
`assets/statusline.mjs` (which can't import from `calc.ts`, it runs
standalone).

## Steps

1. Read `docs/calculations.md` first — it has every current formula
   verbatim. Confirm the change doesn't silently break an assumption another
   function relies on (e.g. `computeToday` depends on `avgPerDay` being
   frozen, not live).
2. Change `calc.ts`. Keep the in-place-mutation style — don't switch a
   function to return-only.
3. Update `calc.spec.ts` in the same change. Coverage thresholds are 100%
   (`vitest.config.ts`) — a new branch without a matching assertion fails
   `pnpm test`.
4. Update `docs/calculations.md`'s matching section to the new formula,
   verbatim.
5. If the change touches `colorForPct`, also update `ccColor()` in
   `assets/statusline.mjs` — they must stay identical.
6. Run `pnpm vitest run src/calc.spec.ts`, then the full verification
   sequence from `docs/testing-and-verification.md` before calling it done.
