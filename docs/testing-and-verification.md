# Testing & verification

## Coverage policy

100% statements/branches/functions/lines over `src/**` (`vitest.config.ts`).
The IO-only shell of the calendar (`runCalendarTui`) is the one
`/* v8 ignore start */` block; everything it calls is covered through the
pure functions. Do not add v8-ignore comments to dodge a branch — restructure
or test it.

## Verification commands

```
pnpm lint && pnpm typecheck && pnpm format:check && pnpm docs:check && pnpm test && pnpm build && pnpm run test:e2e
```

`test:e2e` runs the built binary, so it comes after `build`. While iterating:
`pnpm vitest run src/<file>.spec.ts`.

## Test layout

- Pure modules (`calc`, `clock`, `pricing`, `cache-forecast`,
  `statusline-render`, `notice`) — plain input/output assertions.
  `src/calc.spec.ts` is the exemplar, including the time-zone matrix
  (`vi.stubEnv("TZ", …)`: UTC, Europe/Madrid, America/Los_Angeles; DST days in
  `src/clock.spec.ts`).
- File-backed modules (`config`, `account`, `refresh`, `statusline`,
  `calendar-tui`, `cli`, installers) — a temp HOME via a mocked
  `node:os` `homedir`; no real `~/.claude` is touched.
- `e2e/cli.spec.ts` — the built binary in a temp HOME: help/errors, a
  first-run render (fast, no history written), garbage stdin, calendar notice
  and non-TTY frame. No network: the refresher finds no token.

## Docs gate

`pnpm docs:check` (`scripts/doc-drift.mjs check`): every backticked repo path
in a doc resolves, no `:line` citations, every doc is mapped or exempt, every
source area is documented. `pnpm docs:drift` lists docs whose sources changed
in the current diff; the Stop hook `.claude/hooks/doc-drift-check.sh` runs it
once per session.

## CI

`.github/workflows/ci.yml` runs the same checks: `lint` (lint, typecheck,
format, docs), `build`, `test` (unit, 100% coverage), `e2e` (build, then the
built binary on Linux, macOS and Windows); `coverage` comments on PRs. The
build script is cross-platform (no `rm -rf`).
