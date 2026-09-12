# docs

Check this folder before reading source — it is kept current and cheaper to
read than re-deriving behavior from `src/`. `cc-daily-usage` is a CLI +
statusline + Ink dashboard that tracks Claude Code spend/usage.

## [architecture.md](./architecture.md)

Module map (`account.ts` → `anthropic-usage.ts` → `calc.ts` → `config.ts` →
`cli.ts` → `dashboard-tui.ts`, plus the statusline installer and `init-server.ts`),
the statusline-hook and `init`/`statusline` data-flow diagrams, the multi-account
model (`accountKey()`, per-account directories, legacy migration), the
`hasSpendCap` branch that gates all dollar-cap math, and the loopback-server
security model. Keywords: module map, data flow, multi-account, organizationType,
hasSpendCap, loopback server.

## [calculations.md](./calculations.md)

Every formula in `calc.ts`, verbatim, one heading per function:
`rolloverIfNeeded`, `computeAvgPerDay`, `computeToday`, `captureSessionCost`,
`reconcileFromExtraUsageSnapshot`, `colorForPct`, `pruneStaleSessions`. Includes
the deliberate "frozen not live" avgPerDay deviation. Keywords: math, formula,
monthlyCap, monthlySpent, rollover, avgPerDay, session cost delta, reconcile.

## [data-model.md](./data-model.md)

Field-by-field reference for `Config`, `UsageState`, `SessionCost`,
`ExtraUsageSnapshot`, `ExtraUsageCacheEntry`, `RateLimitsCache`; the on-disk
`~/.config/cc-daily-usage/accounts/<key>/{config,usage}.json` layout; and the
statusline installer's managed-file markers. Keywords: interface, schema,
UsageState, Config, on-disk layout, managed marker, statusline.mjs.

## [use-cases.md](./use-cases.md)

What each CLI operation does end-to-end (`init`, `statusline`, `dashboard`, the
hidden `--statusline` hook mode), dashboard keybindings and the day-edit "pool
must balance" validation, and `assets/statusline.mjs`'s segment-by-segment
rendering with every guard that hides a segment. Keywords: CLI, init, dashboard,
keybindings, statusline segments, hook mode.

## [testing-and-verification.md](./testing-and-verification.md)

100% coverage policy, the `/* v8 ignore */` convention, the exact verification
command sequence, the exemplar test file, and how CI mirrors it. Keywords:
coverage, vitest, verification, CI, lint, typecheck, build.
