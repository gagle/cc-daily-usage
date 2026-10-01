# Use cases

The three CLI operations, the hidden statusline hook mode, calendar interaction,
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

## `cc-daily-usage calendar`

Launches the Ink TUI (`calendar-tui.ts`). Polls `config.json`/`usage.json`
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
rollover/ledger/capture (see `docs/calculations.md`), writes state back, and
prints one JSON line (`StatuslineJson`) to stdout for `statusline.mjs` to render.

## `assets/statusline.mjs` segment rendering

Segments render left to right, each guarded independently — a missing/undefined
field hides just that segment, never breaks the whole line:

1. Repo name + branch (git, if inside a repo).
2. Context-window usage bar (20-cell, colored by `%`) + emoji threshold.
3. Session cost (`$X.XX`).
4. Session timer (`⏲`), if `total_duration_ms` is present.
5. Lines added/removed (`+N`/`-N`), if present in the hook payload.
6. Model name + effort level.
7. `⏱` 5h/7d seat windows — **Pro/Max only** (`hasSpendCap === false`). Live
   or cached `%`, or placeholder `⏱ —/5h —/7d` before the first fetch. Hidden
   on enterprise dollar-budget accounts.
8. cc-daily-usage today segment — enterprise only. Laboral days:
   `$today/$avgPerDay (pct)`. Non-laboral: `$today` only. (day-1 max / real / pace
   labels live in `cc-daily-usage calendar`, not the CLI statusline.)
9. cc-daily-usage `$month/$monthlyCap` — enterprise only (`hasSpendCap !== false`).
10. `⚠ run: cc-daily-usage init` nudge instead of the `$` segments, the first
    time a dollar-cap account has no `laboralDays` configured yet.
11. `🎫` usage-credits — **Pro/Max only**. Hidden on enterprise so it does not
    duplicate the `$month` self-budget line.

All `$` segments use the same 5-bucket `ccColor()` thresholds — see
`docs/calculations.md`'s `colorForPct`.
