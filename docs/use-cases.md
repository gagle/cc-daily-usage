# Use cases

The three CLI operations, the hidden statusline hook mode, dashboard interaction,
and the statusline's segment-by-segment rendering.

## `cc-daily-usage init`

Opens the laboral-days/monthly-cap calendar picker:

1. `runInit()` starts a loopback-only HTTP server (`init-server.ts`).
2. Opens `assets/init-calendar.html` in the default browser.
3. User picks laboral days per month + a monthly `$` cap.
4. Browser POSTs an `InitPayload` back to the loopback server.
5. Server writes it into `config.json` and shuts down.

Security: loopback-only + Host-header allowlist + token auth + 256KB body cap —
see `docs/architecture.md` "Security model".

## `cc-daily-usage statusline`

Installs `assets/statusline.mjs` into `~/.claude/statusline.mjs` and points
`~/.claude/settings.json`'s `statusLine.command` at it. Idempotent: re-running
detects the `// cc-daily-usage:managed v<hash>` marker and silently no-ops or
upgrades instead of prompting or re-backing-up. See `docs/data-model.md` for the
marker format and the capture-only fallback path.

## `cc-daily-usage dashboard`

Launches the Ink TUI (`dashboard-tui.ts`). Polls `config.json`/`usage.json`
directly every 2000ms (independent of the hook path).

Keybindings:

| Key    | Action                                    |
| ------ | ----------------------------------------- |
| arrows | move cursor across the calendar grid      |
| `c`    | enter cap-edit mode (change `monthlyCap`) |
| `u`    | enter day-edit mode                       |
| `Tab`  | switch month                              |

**Day-edit mode validation:** drafted per-day amounts must sum exactly to the
month's remaining "pool" (`monthlyCap - sum of already-frozen days`) before the
edit is accepted — this keeps the calendar's day totals always consistent with
the cap, rather than allowing an edit that silently breaks the running total.

## Hidden `--statusline` mode

Not a documented CLI operation — invoked by the installed `assets/statusline.mjs`
on every Claude Code statusline render, via `spawnSync("cc-daily-usage --statusline")`.
Runs `runStatuslineHidden()` in `cli.ts`: resolves the active account, runs
rollover/capture/reconcile (see `docs/calculations.md`), writes state back, and
prints one JSON line (`StatuslineJson`) to stdout for `statusline.mjs` to render.

## `assets/statusline.mjs` segment rendering

Segments render left to right, each guarded independently — a missing/undefined
field hides just that segment, never breaks the whole line:

1. Repo name + branch (git, if inside a repo).
2. Context-window usage bar (20-cell, colored by `%`) + emoji threshold.
3. Session cost (`$X.XX`).
4. Lines added/removed (`+N`/`-N`), if present in the hook payload.
5. Model name + effort level.
6. `⏱` 5h/7d rate-limit windows (`used_percentage`), with a `⚠ resets <time>`
   nudge once a window hits 100% and Claude Code has attached a `resets_at`.
7. cc-daily-usage today/month `$` segments — **skipped entirely** when
   `avgPerDay`/`monthlyCap` are absent (no laboral days configured, or
   `hasSpendCap === false`).
8. `⚠ run: cc-daily-usage init` nudge instead of segment 7, the first time a
   dollar-cap account renders with no `laboralDays`/`monthlyCap` configured yet.
9. `🎫` extra-usage (usage credits) segment, independent of subscription type —
   can appear alongside the `⏱` segment on Pro/Max accounts too.

All `$` segments use the same 5-bucket `ccColor()` thresholds — see
`docs/calculations.md`'s `colorForPct`.
