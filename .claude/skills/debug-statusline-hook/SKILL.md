---
name: debug-statusline-hook
description: Use when a statusline render looks wrong (missing segment, stale number, wrong color) — traces the hook path from Claude Code's stdin JSON through runStatuslineHidden to calc.ts using docs/architecture.md's data-flow diagram.
---

# Debug a bad statusline render

Full data flow: `docs/architecture.md`'s "Statusline hook" diagram.

## Steps

1. Identify which segment is wrong (bar, cost, rate-limit window,
   cc-daily-usage $ segment, extra-usage segment) — `docs/use-cases.md`'s
   numbered segment list has the guard condition for each. A missing
   segment is almost always its guard condition evaluating false, not a
   crash.
2. Reproduce the hook payload: `cc-daily-usage --statusline` reads real
   account state, so check
   `~/.config/cc-daily-usage/accounts/<accountKey>/{config,usage}.json`
   first — a wrong `accountKey()` resolution (see `docs/architecture.md`'s
   "Multi-account model") is a common root cause of "stale" numbers.
3. Trace the compute chain: `resolveActiveAccount()` (`account.ts`) →
   `rolloverIfNeeded()` → `captureSessionCost()` →
   `reconcileFromExtraUsageSnapshot()` (all in `calc.ts`, see
   `docs/calculations.md` for exact formulas) → written back to
   `usage.json` → printed as one JSON line.
4. If the number looks "frozen"/stale mid-day, check whether it's
   `avgPerDay`/`safeMonthTotal` — those are deliberately frozen once per
   UTC day, not live (`docs/architecture.md`'s "Why these decisions").
   That's expected behavior, not a bug.
5. If color looks wrong, check `colorForPct` in `calc.ts` against
   `ccColor()` in `assets/statusline.mjs` — they must be identical; drift
   between them is a real bug (`docs/calculations.md` flags this).
6. Once fixed, run the scoped spec, then the full sequence in
   `docs/testing-and-verification.md`.
