---
name: debug-statusline-hook
description: Use when a statusline render looks wrong (missing segment, stale number, wrong color, slow) — traces the render from Claude Code's stdin JSON through the shim, src/statusline.ts and calc.ts to src/statusline-render.ts.
---

# Debug a bad statusline render

Data flow: `docs/architecture.md` ("Statusline render"). Segment guards:
`docs/use-cases.md` ("Statusline segments").

## Steps

1. Name the wrong segment. A missing segment is almost always its guard
   (its own data absent), not a crash.
2. Reproduce without Claude Code, in a sandbox HOME:
   `printf '%s' '<payload json>' | HOME=$SANDBOX node bin/cc-spend.js --statusline-line`
   and `--statusline` for the computed state as JSON. Setup recipe:
   `adrs/2026-10-10-manual-test-plan.md` ("How to run it safely").
3. Check the account's files in
   `~/.config/cc-spend/accounts/<accountKey>/`: `config.json`,
   `usage.json`, `api-cache.json` (`docs/data-model.md`). A wrong
   `accountKey()` is a common cause of "stale" numbers.
4. Stale ⏱/🎫/cap: look at `api-cache.json` `fetchedAt`/`stale` and whether a
   `refresh.lock` is stuck (`src/refresh.ts`). Then `resolveRateLimits` in
   `src/statusline.ts` decides hook vs cache vs API.
5. Wrong $ math: `docs/calculations.md` and `docs/time-model.md` (local days,
   UTC period). Re-run with `TZ=…` to rule out a month-edge hour.
6. Wrong 🧊 number: `docs/prompt-cache.md`; the model may be unpriced in
   `src/pricing.ts`.
7. Slow: `scripts/bench.sh` against `docs/performance.md`; nothing on the
   render path may touch the network or spawn a process other than the
   detached refresher.
8. Fix with a failing spec first, then the full sequence in
   `docs/testing-and-verification.md`.
