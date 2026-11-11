# 2026-10-10 - User-set statusline layout and model-switch cost hook

## Status

Accepted

## Context

- The statusline was one fixed line. Claude Code cuts a line that does not
  fit with `…`, and the tail (cache hints, limits) was lost. Wrapping by width
  failed: the `COLUMNS` value that `docs/claude-code-upstream/statusline.md`
  says Claude Code sets did not reach the render here (still one line, still `…`).
- `last miss: <cause>` on the cache part was noise: `messages_rewritten` is not
  documented, and the `$` figures already say what a miss costs.
- A `/model` switch re-sends the whole conversation uncached
  (`docs/claude-code-upstream/prompt-caching.md`). Claude Code's
  `PreModelSwitch` hook input carries `estimated_cache_write_usd`.

## Decision

- Parts and their order come from `~/.config/cc-daily-usage/statusline.json`
  (`src/statusline-layout.ts`); the default is every part on one line. Each
  layout row is one statusline line. `cc-daily-usage settings` edits it in a
  numbered grid (`src/settings-tui.ts`).
- No width-based wrapping; no miss cause on the line.
- The warm-cache premium reads `if cold +$X` (a forecast, not a past miss),
  and its hint is the built-in `→ /compact before a break` instead of
  `/handoff`, which is not a Claude Code command.
- A `PreModelSwitch` hook (`--model-switch`, `src/model-switch.ts`) asks before
  a switch that drops a warm cache and costs at least `promptGateMinUsd`, and
  otherwise shows the cost. It uses Claude Code's estimate, not our prices.

## Options considered

| Option                            | Why not / why                                                      |
| --------------------------------- | ------------------------------------------------------------------ |
| Wrap by `COLUMNS`                 | did not work in practice; removed                                  |
| Fixed two lines (cache on line 2) | one layout does not fit every user                                 |
| Switch cost as a statusline part  | the target model is unknown until `/model` runs                    |
| `PreModelSwitch` hook             | exact target and Claude Code's own estimate, shown when it matters |

## Consequences

- Every render reads one more small file (missing or corrupt → default).
- A user can hide parts by leaving them out of the grid.
- The hook timeout blocks a switch, so the hook never throws and exits 0.

## Verification

`src/statusline-layout.spec.ts`, `src/settings-tui.spec.ts`,
`src/model-switch.spec.ts`, `src/statusline-render.spec.ts`; manual test plan
G9-G11 and K1-K6.
