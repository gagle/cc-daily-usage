# 2026-10-10 - Manual test plan for the public release

## Status

Accepted

## Context

Before general availability every user-facing path must be tried the way a
product owner or a tester would, including attempts to break it. Most cases
also have an automated test; the "Auto" column names it so a regression shows
up in CI. "manual" means only a human run proves it (real terminal, real
Claude Code, real Anthropic account).

## Decision

Run this plan before every release that touches `src/`, `assets/` or `bin/`.
A case passes when every expected item holds. Log failures as issues with the
case ID.

## How to run it safely

```
export SANDBOX=$(mktemp -d)                          # never test against your real ~/.claude
mkdir -p $SANDBOX/.claude
echo '{"oauthAccount":{"emailAddress":"qa@example.com","organizationType":"claude_enterprise"}}' > $SANDBOX/.claude.json
alias ccdu='HOME=$SANDBOX node /path/to/cc-daily-usage/bin/cc-daily-usage.js'
payload() { printf '%s' "$1" | HOME=$SANDBOX node /path/to/cc-daily-usage/bin/cc-daily-usage.js --statusline-line; echo; }
```

- Plan type: change `organizationType` (`claude_pro`, `claude_max`,
  `claude_team`, `claude_enterprise`, `something_new`, or remove `oauthAccount`).
- Time zone: prefix with `TZ=Europe/Madrid`, `TZ=America/Los_Angeles`,
  `TZ=Pacific/Kiritimati`, `TZ=Pacific/Pago_Pago`, `TZ=Asia/Kolkata`.
- A past "last render": edit `lastUpdated` in
  `$SANDBOX/.config/cc-daily-usage/accounts/qa_example_com/usage.json`.
- Ledger / admin limit: write `api-cache.json` next to it (shape in
  `docs/data-model.md`) with a fresh `fetchedAt` so the refresher does not
  overwrite it.
- Real-account cases (marked **live**) use your real HOME after
  `cc-daily-usage statusline`.

## A. Install and first run

| ID  | Persona                  | Steps                                                                                    | Expected                                                                                         | Auto                             |
| --- | ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------- |
| A1  | new enterprise user      | `ccdu init`, answer Y, Y                                                                 | statusline installed, Mon–Fri saved for this + next month, calendar opens with today highlighted | `src/cli.spec.ts`                |
| A2  | new Pro user             | `organizationType: claude_pro`, `ccdu init`                                              | statusline installed, "No spend cap on this plan", no calendar                                   | `src/cli.spec.ts`                |
| A3  | no Claude login          | remove `oauthAccount`, `ccdu init`                                                       | "default (no OAuth account)", "Plan not detected yet", no crash                                  | `src/cli.spec.ts`                |
| A4  | user with own statusline | put a custom `~/.claude/statusline.mjs` + `statusLine` in settings, `ccdu statusline`, Y | both backed up; `previous-statusline.json` written; settings has `refreshInterval: 30`           | `src/statusline-install.spec.ts` |
| A5  | re-run                   | `ccdu statusline` twice                                                                  | second run: "already up to date", no new backup, no prompt                                       | `src/statusline-install.spec.ts` |
| A6  | declines statusline      | `ccdu init`, n                                                                           | capture-only line added; budget still captured                                                   | `src/cli.spec.ts`                |
| A7  | first render             | `payload '{"session_id":"x","cost":{"total_cost_usd":1}}'` on an empty sandbox           | line in < 0.2 s locally, `⚠ run: cc-daily-usage init`, `usage.json` has no `days`                | `e2e/cli.spec.ts`                |
| A8  | broken settings.json     | write `{oops` to `~/.claude/settings.json`, `ccdu statusline`                            | clear error, nothing half-written                                                                | manual                           |
| A9  | read-only home           | `chmod -w $SANDBOX/.config`, render                                                      | session part of the line still prints                                                            | `src/statusline.spec.ts`         |
| A10 | via `npx`                | `npx cc-daily-usage statusline`, then clear the npx cache                                | line shows `⚠ cc-daily-usage not found — reinstall it`, Claude Code keeps working                | manual                           |
| A11 | **live**                 | install on your machine, open Claude Code                                                | full line renders; `🌿 branch` correct in a worktree                                             | manual                           |

## B. Dates and time zones

| ID  | Persona                                             | Steps                                                   | Expected                                                                                                | Auto                |
| --- | --------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------- |
| B1  | installs on day 1                                   | set system date or `lastUpdated` to the 1st; render     | max per day = cap ÷ all laboral days                                                                    | `src/calc.spec.ts`  |
| B2  | installs on the last day                            | last laboral day of the month                           | max = whole remainder; next day starts the new month clean                                              | `src/calc.spec.ts`  |
| B3  | installs mid-month with spend already on the ledger | `api-cache.json` with `usedCredits: 212`                | month shows 212 at once; today's max = (cap − 0 frozen) ÷ remaining; history is not invented            | `src/calc.spec.ts`  |
| B4  | installs on a weekend                               | Saturday                                                | `$today (off day)`; Monday's max includes weekend spend                                                 | `src/calc.spec.ts`  |
| B5  | Madrid, 01:00 on day 1                              | `TZ=Europe/Madrid`, `lastUpdated` 21:00Z the day before | day 1 shows `$today` only (old period); after 02:00 the new month's pace starts; nothing double-counted | `src/calc.spec.ts`  |
| B6  | Los Angeles, 17:30 on the last day                  | `TZ=America/Los_Angeles`                                | evening spend counts against the new month; the last day's cell holds both parts                        | `src/calc.spec.ts`  |
| B7  | ±14 h zones                                         | Kiritimati / Pago Pago around the edge                  | same rules, longer window, no negative or NaN                                                           | manual              |
| B8  | India +5:30                                         | `TZ=Asia/Kolkata` across local midnight                 | day changes at local midnight                                                                           | manual              |
| B9  | DST fall back / spring forward                      | Madrid, Oct 25 and Mar 29                               | one freeze per local day, no duplicate day                                                              | `src/clock.spec.ts` |
| B10 | Feb 29 / Dec 31 → Jan 1                             | leap year and year end                                  | year switches; Jan laboral offered by `init` in December                                                | `src/cli.spec.ts`   |
| B11 | laptop closed a week                                | `lastUpdated` 7 days back                               | all spend on the last active day; the gap shows `—`; render stays fast                                  | `src/calc.spec.ts`  |
| B12 | closed across two month edges                       | `lastUpdated` 2 months back                             | one booking, one reset, baseline from the ledger                                                        | `src/calc.spec.ts`  |
| B13 | clock set to the future then back                   | `lastUpdated` in the future                             | treated as now, no crash                                                                                | `src/calc.spec.ts`  |
| B14 | v1 data from before this release                    | old `usage.json` (no `periodFrozen`)                    | loads; month total unchanged; `schemaVersion: 2` after a render                                         | `src/calc.spec.ts`  |

## C. Calendar UI (Team/Enterprise)

| ID  | Persona      | Steps                                                | Expected                                                                                           | Auto                                          |
| --- | ------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| C1  | tester       | `ccdu calendar`                                      | first frame instantly (< 0.2 s); today bold+underlined with `today` and `•$live`; past days dim    | `src/calendar-tui.spec.ts`, `e2e/cli.spec.ts` |
| C2  | tester       | arrows over month/year edges, Tab/Shift-Tab, `[` `]` | cursor wraps correctly; Feb 30 never selected                                                      | `src/calendar-tui.spec.ts`                    |
| C3  | tester       | Space on a past day                                  | "locked" notice; config unchanged                                                                  | `src/calendar-tui.spec.ts`                    |
| C4  | tester       | resize the terminal                                  | redraws, no garbage                                                                                | manual                                        |
| C5  | tester       | `ccdu calendar < /dev/null` / piped                  | prints one frame, exits 0                                                                          | `e2e/cli.spec.ts`                             |
| C6  | tester       | `NO_COLOR=1 ccdu calendar`                           | no ANSI colours                                                                                    | manual                                        |
| C7  | tester       | Ctrl+C, q, Esc                                       | exits, terminal restored (cursor visible, main screen)                                             | manual                                        |
| C8  | tester       | keep it open while a Claude session spends           | numbers update within ~2 s                                                                         | manual                                        |
| C9  | Pro user     | `ccdu calendar`                                      | boxed notice with plan name, ⏱/🎫/🧊 explanation; Ink-free, instant                                | `src/cli.spec.ts`, `e2e/cli.spec.ts`          |
| C10 | unknown plan | `something_new` before any render                    | "Plan not detected yet" notice                                                                     | `src/cli.spec.ts`                             |
| C11 | tester       | narrow terminal (e.g. 60 columns) with Claude Code   | default layout: the line ends in `…`; after splitting it with `ccdu settings`, every line complete | manual                                        |

## D. Laboral days and redistribution

| ID  | Persona                    | Steps                                       | Expected                                                                                                           | Auto                       |
| --- | -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| D1  | takes a holiday next week  | unmark a future laboral day                 | today's max unchanged today (stable through the day); from tomorrow the remainder splits evenly over one day fewer | `src/calc.spec.ts`         |
| D2  | takes today off            | unmark today                                | today shows `$today (off day)`; tomorrow absorbs today's share                                                     | `src/calc.spec.ts`         |
| D3  | removes all remaining days | unmark every day left                       | "No laboral days left this month" in the header                                                                    | `src/calendar-tui.spec.ts` |
| D4  | works a Saturday           | mark Saturday                               | Saturday gets a share; others slightly lower                                                                       | `src/calc.spec.ts`         |
| D5  | corrects history           | `u`, move to past days, retype amounts, `S` | saved only when the sum equals the original; month total and today's max unchanged                                 | `src/calendar-tui.spec.ts` |
| D6  | tries to edit today        | `u`, type on today                          | "only past days are editable"                                                                                      | `src/calendar-tui.spec.ts` |
| D7  | future month               | Tab to next month, `u`                      | "Nothing to edit"                                                                                                  | `src/calendar-tui.spec.ts` |
| D8  | sets next month early      | toggle days in next month                   | saved; used from the 1st                                                                                           | `src/calendar-tui.spec.ts` |

## E. Limits, admin changes and the ledger

| ID  | Persona                               | Steps                                     | Expected                                                                                             | Auto                            |
| --- | ------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| E1  | admin raises the limit mid-month      | `api-cache.json` `monthlyLimit` 440 → 800 | within one TTL: cap 800 in statusline and calendar (`cap: Anthropic`); today's max re-splits at once | `src/statusline.spec.ts`        |
| E2  | admin lowers it below spend           | `monthlyLimit` below `usedCredits`        | `(over)` in red; max $0.00                                                                           | `src/calc.spec.ts`              |
| E3  | admin removes the per-user limit      | `monthlyLimit: 0` / extra usage off       | local cap used, `cap: local`; `c` works again                                                        | `src/statusline.spec.ts`        |
| E4  | ledger resets                         | `usedCredits` below the baseline          | month restarts from the new reading                                                                  | `src/calc.spec.ts`              |
| E5  | phantom session spend                 | session cost far above the ledger         | frozen days scale down to the ledger                                                                 | `src/calc.spec.ts`              |
| E6  | `c` while Anthropic owns the cap      | press `c`                                 | notice: an admin changes it                                                                          | `src/calendar-tui.spec.ts`      |
| E7  | **live** Pro user opens a new session | close Claude Code, wait, open             | ⏱ updates without sending a message (≤ 30 s)                                                         | manual                          |
| E8  | offline                               | disconnect, render                        | last reading stays (marked stale in `api-cache.json`), no delay                                      | `src/refresh.spec.ts`           |
| E9  | expired token / 401 / 429             | revoke or wait                            | same as E8; no render slowdown                                                                       | `src/anthropic-usage.spec.ts`   |
| E10 | Claude apps gateway                   | payload with `rate_limits.spend_limit`    | `💳 pct` segment                                                                                     | `src/statusline-render.spec.ts` |

## F. Sessions and accounts

| ID  | Persona                      | Steps                            | Expected                                                                              | Auto                     |
| --- | ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- | ------------------------ |
| F1  | two sessions at once         | two Claude Code windows spending | both counted once each                                                                | `src/calc.spec.ts`       |
| F2  | `/clear`                     | cost drops to 0                  | no negative delta; next spend counted                                                 | `src/calc.spec.ts`       |
| F3  | resume an old session        | `claude --resume` after > 2 days | ledger users: no double count; no-ledger users: may count again (known, see ponytail) | manual                   |
| F4  | account switch               | `/login` to another account      | next render uses the other `accounts/<key>/`                                          | `src/statusline.spec.ts` |
| F5  | per-terminal token           | `CLAUDE_CODE_OAUTH_TOKEN=…`      | resolved once via profile, cached; no per-render network                              | `src/account.spec.ts`    |
| F6  | Pro → enterprise mid-session | change `organizationType`        | dollar budget appears; Pro spend never booked                                         | `src/statusline.spec.ts` |

## G. Prompt-cache predictor

| ID  | Persona                                  | Steps                            | Expected                                                                     | Auto                            |
| --- | ---------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| G1  | **live** heavy user                      | long session, look at `🧊`       | countdown matches `/usage` "Prompt cache (main)"; `next ~$` small while warm | manual                          |
| G2  | **live**                                 | wait past the TTL, send a prompt | segment turns `❄ cold`; the turn's cost delta ≈ the shown cold cost (±10 %)  | manual                          |
| G3  | 5m vs 1h TTL                             | payload `ttl` 5m / 1h            | write rate 1.25× / 2× input                                                  | `src/cache-forecast.spec.ts`    |
| G4  | after `/compact`                         | `recache_tokens_if_cold: null`   | no cold price, no crash                                                      | `src/cache-forecast.spec.ts`    |
| G5  | unknown model                            | `model.id` not in the table      | no `🧊` segment                                                              | `src/cache-forecast.spec.ts`    |
| G6  | old Claude Code                          | no `prompt_cache`                | no segment                                                                   | `src/cache-forecast.spec.ts`    |
| G7  | big context                              | `used_percentage ≥ 60`           | no `→` hint on the line                                                      | `src/statusline-render.spec.ts` |
| G8  | warm, costly to lose; then cold          | if-cold extra ≥ $1; cold ≥ $1    | `if cold +$…` while warm, `next msg ~$…` once cold; no `→` hint              | `src/statusline-render.spec.ts` |
| G9  | `/model` switch while warm, context ≥ $1 | **live**                         | Claude Code asks to confirm, reason names the target model, tokens and `~$`  | `src/model-switch.spec.ts`      |
| G10 | `/model` switch while cold or cheap      | **live**                         | switch applies; a `cc-daily-usage: switching to … ~$` message shows          | `src/model-switch.spec.ts`      |
| G11 | a cache miss of any cause                | payload `last_miss_cause`        | no `last miss` text on the line                                              | `src/statusline-render.spec.ts` |

## H. CLI input robustness (try to break it)

| ID  | Steps                                                                                       | Expected                                                        | Auto                                        |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| H1  | `ccdu`, `ccdu -h`, `ccdu calendar --help`, `ccdu --help init`                               | help, exit 0                                                    | `src/cli.spec.ts`, `e2e/cli.spec.ts`        |
| H2  | `ccdu bogus`, `ccdu init extra`, `ccdu calendar ""`                                         | "Unknown argument: …", exit 1                                   | `src/cli.spec.ts`, `e2e/cli.spec.ts`        |
| H3  | `--statusline-line` with empty, garbage, `null`, `[1]` stdin; then a 10 MB payload (manual) | a line every time                                               | `src/statusline.spec.ts`, `e2e/cli.spec.ts` |
| H4  | `--refresh` without a key                                                                   | clear error                                                     | `src/cli.spec.ts`                           |
| H5  | corrupt `config.json` / `usage.json` / `api-cache.json`                                     | re-seeded; corrupt copy kept as `.corrupt-<ms>`                 | `src/config.spec.ts`                        |
| H6  | `monthlyCap: "lots"`                                                                        | default cap used                                                | `src/config.spec.ts`                        |
| H7  | cap edit with `..`, empty, letters, `99999999`                                              | invalid rejected with a notice; letters ignored; large accepted | `src/calendar-tui.spec.ts`                  |
| H8  | Ctrl+C during `init` prompts                                                                | exits, no half-written file                                     | manual                                      |
| H9  | stale `refresh.lock` left behind                                                            | refresher runs again after 30 s                                 | `src/refresh.spec.ts`                       |
| H10 | Windows: paths with spaces / drive letters                                                  | shim imports via `file://` URL; renders                         | manual                                      |

## I. Upgrade and uninstall

| ID  | Steps                                         | Expected                                                        | Auto                             |
| --- | --------------------------------------------- | --------------------------------------------------------------- | -------------------------------- |
| I1  | upgrade the package, re-run `ccdu statusline` | "Updated statusline: vA → vB"                                   | `src/statusline-install.spec.ts` |
| I2  | upgrade without re-running                    | old shim keeps working (`--statusline` JSON kept)               | `src/statusline.spec.ts`         |
| I3  | move the package (new path)                   | next `ccdu statusline` rewrites the shim (hash covers the path) | `src/statusline-install.spec.ts` |
| I4  | `ccdu uninstall` after A4                     | foreign script and old `statusLine` restored; data kept         | `src/statusline-install.spec.ts` |
| I5  | `ccdu uninstall` with nothing installed       | "Nothing to remove"                                             | `src/cli.spec.ts`                |

## J. Performance

| ID  | Steps                                                                      | Expected                         | Auto                           |
| --- | -------------------------------------------------------------------------- | -------------------------------- | ------------------------------ |
| J1  | `scripts/bench.sh 21 sh -c "node ~/.claude/statusline.mjs < payload.json"` | median within ~2× of `node -e 0` | manual (`docs/performance.md`) |
| J2  | `scripts/bench.sh 21 sh -c "ccdu calendar < /dev/null"`                    | same bound                       | manual                         |
| J3  | fresh sandbox first render                                                 | < 1.5 s on CI, ≪ 0.2 s locally   | `e2e/cli.spec.ts`              |

## K. Statusline layout (`ccdu settings`)

| ID  | Steps                                                           | Expected                                                               | Auto                                             |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| K1  | no `statusline.json`, any session                               | first line every part; `💡` tip on a second line when a finding exists | `src/statusline-render.spec.ts`                  |
| K2  | `ccdu settings`, put 7 on row 2, clear it on row 1, Enter       | "Saved statusline layout"; next render has the cache part on line 2    | `src/settings-tui.spec.ts`, manual               |
| K3  | type `1` then `2`; type `5` then `3`; type `0`; place 5 twice   | cell shows 12; then 3; preview shows the error; Enter does not save    | `src/settings-tui.spec.ts`                       |
| K4  | Esc / q / Ctrl+C                                                | "Not saved."; terminal restored                                        | `src/settings-tui.spec.ts`, manual               |
| K5  | `ccdu settings < /dev/null`                                     | prints one frame, exits 0                                              | manual                                           |
| K6  | corrupt or hand-edited `statusline.json` (unknown ids, repeats) | statusline still renders; bad ids dropped, nothing usable → default    | `src/statusline-layout.spec.ts`                  |
| K7  | scroll the mouse wheel / trackpad in `ccdu settings`            | the cursor does not move; after exit, the terminal scrolls normally    | `src/calendar-tui.spec.ts` (`parseKeys`), manual |

## L. History and feed (CLI-1..5)

| ID  | Steps                                                                 | Expected                                                                                                             | Auto                                                   |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| L1  | Max account; work 20+ min in one session                              | `limits.json` gains a sample per % change; `⚠ 5h runs out ~HH:MM` only when the rate empties the window before reset | `src/limits-history.spec.ts`, `src/statusline.spec.ts` |
| L2  | after 3+ one-point rises of the 7d %                                  | `⏱ … · 1%/7d≈$X` appears                                                                                             | `src/limits-history.spec.ts`                           |
| L3  | add or remove an MCP server mid-session, send a prompt                | no cause text on the line; `usage.missCauses[today]` counts it                                                       | `src/statusline.spec.ts`                               |
| L4  | `node bin/cc-daily-usage.js --refresh <key>` with a logged-in account | `accounts/<key>/feed.json` has `schemaVersion: 1`, current `sessionIds`, limits with verdicts, `spend`               | `src/refresh.spec.ts`, `src/feed.spec.ts`              |
| L5  | Pro/Max: a day of work                                                | `usage.apiEqDays[today]` grows by the session cost deltas; `monthlySpent` stays 0                                    | `src/calc.spec.ts`                                     |

## M. File versions and downgrade guard (CLI-6)

| ID  | Steps                                                                    | Expected                                                                                             | Auto                                                              |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| M1  | config.json without `schemaVersion`, run any render                      | file gains `"schemaVersion": 1`, other fields equal; one `config.json.bak-*` next to it              | `src/config.spec.ts`                                              |
| M2  | set `"schemaVersion": 99` in config.json, render and run `ccdu settings` | line starts `⚠ update cc-daily-usage`; the command prints the npm hint; the file is byte-equal after | `src/config.spec.ts`, `src/statusline.spec.ts`, `src/cli.spec.ts` |
| M3  | migrate 5 times (delete the version each time)                           | only the newest 3 backups stay                                                                       | `src/config.spec.ts`                                              |

## N. Doctor, transcript index and report (CLI-7 part, CLI-8)

| ID  | Steps                                              | Expected                                                                                            | Auto                           |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------ |
| N1  | `ccdu doctor` on a working install                 | every line `✔` (a `⚠` for `claude` when not on PATH); exit 0                                        | `src/doctor.spec.ts`           |
| N2  | set a config `schemaVersion` to 99, `ccdu doctor`  | `✖ account …: config.json v99 is from a newer cc-daily-usage`; exit 1                               | `src/doctor.spec.ts`           |
| N3  | `ccdu report` after a day of work                  | table by model; footer "API-equivalent estimate", subagent share                                    | `src/report.spec.ts`           |
| N4  | run `ccdu report` twice                            | second run reads 0 new bytes; same numbers                                                          | `src/transcript-index.spec.ts` |
| N5  | `ccdu report week --by subagent --json`            | JSON with one row per agent type plus `main`                                                        | `src/report.spec.ts`           |
| N6  | a session started with `claude -p` (no statusline) | its $ shows as "more in sessions no account claimed"; `ccdu report --account unattributed` lists it | `src/report.spec.ts`           |
| N7  | `ccdu report 2026-13`, `ccdu report --by colour`   | clear error, exit 1                                                                                 | `src/cli.spec.ts`              |

## O. Coach (CLI-9)

| ID  | Steps                                                | Expected                                                                            | Auto                                             |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| O1  | a week with Opus subagents, `ccdu insights`          | `R1 Subagents on a premium model ~$…/week` with `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` | `src/rules.spec.ts`                              |
| O2  | `ccdu insights --snooze R1 7d`, then `ccdu insights` | R1 last, marked snoozed; the 💡 line shows the next finding                         | `src/insights.spec.ts`, `src/statusline.spec.ts` |
| O3  | no `statusline.json`, after a refresh with findings  | second line `💡 <tip> ~$X/week`                                                     | `src/statusline-render.spec.ts`                  |
| O4  | a quiet week                                         | `Nothing to change this week.`; no 💡 line                                          | `src/insights.spec.ts`                           |
| O5  | 5h window at risk                                    | R8 first, no $                                                                      | `src/rules.spec.ts`                              |

## Consequences

The plan is a release gate. A new feature adds rows here in the same change;
a fixed bug adds the row that would have caught it.
