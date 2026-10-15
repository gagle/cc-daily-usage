# Use cases

Operations, the calendar, and the statusline segments. The manual test plan
that exercises all of this: `adrs/2026-10-10-manual-test-plan.md`.

## `cc-daily-usage init` (first run)

1. Prints the resolved account.
2. Asks to install the statusline (Y → full shim + prompt gate hook, n → capture-only line).
3. Offers `"promptCacheTtl": "1h"` when unset (see `docs/prompt-cache.md`).
4. Pro/Max: stops ("nothing else to configure").
5. Plan unknown: says to start one Claude Code session first.
6. Team/Enterprise (or unknown): if this or next month has no laboral days,
   offers Monday–Friday for both.
7. Team/Enterprise on a TTY: opens the calendar to adjust holidays and the cap.

## `cc-daily-usage statusline`

Installs or upgrades `~/.claude/statusline.mjs` and merges `statusLine` into
`~/.claude/settings.json` with `refreshInterval: 30` (a user-set value on our
own block is kept; the 1 s value older versions switched to goes back to 30).
Also installs both managed hooks and a `subagentStatusLine` (agent-panel rows:
`Explore · find endpoints · 🤖 Sonnet 5.5 high · 41k (4%)`, a premium model
drawn orange; a user's own `subagentStatusLine` is kept). Every
`settings.json` write goes through a temp file and a rename. Idempotent; a
foreign script is backed up first.

## `cc-daily-usage uninstall`

Removes the shim, puts back the previous `statusLine` value and the replaced
script, and leaves `accounts/` data alone.

## `cc-daily-usage settings`

A grid editor for the statusline layout (`src/settings-tui.ts`). It lists the
parts numbered 1-13 (`PARTS` in `src/statusline-layout.ts`) and shows a dashed
grid: 4 rows (statusline lines) × 13 columns. Only arrows/Tab move (mouse
reporting is on while it is open, so the wheel does nothing); digits type a
part number into the cell (`1` then `2` → 12; a digit that would make no part
starts over); Backspace deletes a digit; `x`/Space clears the cell, `c` the
grid, `r` restores the default. A preview shows the result, or the first
error (bad number, part placed twice, empty grid). Enter saves a valid grid to
`~/.config/cc-daily-usage/statusline.json` and exits; Esc/`q`/Ctrl+C exit
without saving. A part in no cell is hidden. The next render uses the file;
nothing to reinstall. Not a TTY → prints one frame.

## `cc-daily-usage calendar`

Pro/Max/unknown plan: a boxed notice (plan name, what the statusline shows
instead), exit 0, the UI never loads. Team/Enterprise: the terminal calendar.
Non-TTY: one frame on stdout, then exit.

| Key                    | Action                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| arrows                 | move one day / one week                                                     |
| `Tab` / `Shift-Tab`    | next / previous month (wraps)                                               |
| `[` `]` / `Shift-←/→`  | previous / next year with data                                              |
| `Space` / `Enter`      | toggle laboral on today or a future day; past days are locked               |
| `u`                    | redistribute $ across the past days of the month (today and later are live) |
| `c`                    | edit the local cap; refused with a note when Anthropic owns the cap         |
| `q` / `Esc` / `Ctrl+C` | quit                                                                        |

Day cells: today is bold, underlined, cyan, labelled `today` with a `•` live
amount; past days are dim; laboral green, off gray; the cursor is inverse.
Day-edit rule: the edited past days must sum to what they summed to before —
redistribution never changes the month total.

Header: today vs today's max with pace label (off day → `$today (off day)`),
month vs cap with `cap: Anthropic` or `cap: local`, Day-1 max, real average,
"no laboral days left", and "Cache re-paid today".

## `cc-daily-usage doctor`

One line per check (`src/doctor.ts`), `✔` ok, `⚠` warn, `✖` fail; exit 1 when
any check fails. Checks: Node ≥ 24, package version, `claude --version` (a
warn when missing), the shim's version vs the shipped one, `settings.json`
`statusLine` (a warn for the old 1 s `refreshInterval`), both managed hooks,
the subagent line, then per account each file's `schemaVersion` (garbled or
newer files fail), a dead `refresh.lock`, the age of the last usage reading
and `feed.json`, and the plan (tier, subscription status, trial end; a warn
when the subscription is not active) with the Claude Code version of the
newest session.

## `cc-daily-usage report`

API-equivalent $ from local transcripts; see `docs/transcript-index.md`.

## `cc-daily-usage insights`

Ranked findings with $ and the exact fix; see `docs/coach.md`.

## Hidden modes

| Mode                | Used by                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `--statusline-line` | the current shim (prints the ANSI line)                           |
| `--statusline`      | shims from older versions and the capture-only line (prints JSON) |
| `--refresh <key>`   | the detached refresher (usage API, one index pass, `feed.json`)   |
| `--prompt-gate`     | the `UserPromptSubmit` hook (cold-cache prompt gate)              |
| `--model-switch`    | the `PreModelSwitch` hook (model-switch cost)                     |

## Statusline parts (default order)

Each is guarded on its own data; a missing field hides one part, and a line
with nothing to show is dropped. `renderStatusline` places the parts by the
layout from `statusline.json` (`loadLayout`, see `cc-daily-usage settings`);
the default is every part but the coach tip and the limit warnings on one
line, in this order, and those two on a second line (`DEFAULT_LAYOUT`).
Claude Code cuts a line that does not fit with `…`; more lines is the fix.

1. `(🌿 branch)` when in a git repo (no repo name — Claude Code already shows the project).
2. Context bar (20 cells) + emoji + `%`.
3. Session cost `$X.XX`.
4. `⏲` session duration.
5. `🤖` model.
6. `💪` effort.
7. `🔥`/`❄` prompt-cache forecast, color fading with the TTL (see `docs/prompt-cache.md`).
8. Pro/Max: `⏱ 5h/7d` (hook, else the newer of cache and API; a stale API
   reading only when there is no hook snapshot; placeholder `—/5h —/7d`).
   A dollar-metered window adds `($used/$limit)`; Opus and Sonnet weekly
   windows add `NN%/7d-opus`, `NN%/7d-sonnet` when the API sends them.
9. Pro/Max: both windows behind one icon, e.g.
   `⚠ 5h out ~5:22pm (1h13m) · 7d resets Tue 7pm (5d3h)`. Per window:
   `resets` at ≥ 90% (or when the API's `limits[]` severity is not "normal"),
   `full → <when>` at the limit (icon `⛔`, red), `out ~<when>` under that when
   the burn rate empties it before reset. `<when>` is a time today, weekday +
   time within a week, else a date.
10. Pro/Max: `🎫` usage credits.
11. Budget plans: `⚠ run: cc-daily-usage init` before any laboral day exists;
    else `$today/$max (pct)` on laboral days (`(over)` when the max is 0),
    `$today` on off days.
12. Budget plans: `$month/$cap (pct)`.
13. `💳 pct` — Claude apps gateway spend limit, when present; `💳 63% $62.80/$100/mo`
    once Claude Code (v2.1.284+) sends the dollar amounts and period.
14. `» <tip> ~$X/week` — the top coach finding (`docs/coach.md`), on its own
    line by default.
