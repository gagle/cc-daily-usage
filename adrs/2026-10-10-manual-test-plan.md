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
alias ccs='HOME=$SANDBOX node /path/to/cc-spend/bin/cc-spend.js'
payload() { printf '%s' "$1" | HOME=$SANDBOX node /path/to/cc-spend/bin/cc-spend.js --statusline-line; echo; }
```

- Plan type: change `organizationType` (`claude_pro`, `claude_max`,
  `claude_team`, `claude_enterprise`, `something_new`, or remove `oauthAccount`).
- Time zone: prefix with `TZ=Europe/Madrid`, `TZ=America/Los_Angeles`,
  `TZ=Pacific/Kiritimati`, `TZ=Pacific/Pago_Pago`, `TZ=Asia/Kolkata`.
- A past "last render": edit `lastUpdated` in
  `$SANDBOX/.config/cc-spend/accounts/qa_example_com/usage.json`.
- Ledger / admin limit: write `api-cache.json` next to it (shape in
  `docs/data-model.md`) with a fresh `fetchedAt` so the refresher does not
  overwrite it.
- Real-account cases (marked **live**) use your real HOME after
  `cc-spend statusline`.

## A. Install and first run

| ID  | Persona                  | Steps                                                                                   | Expected                                                                                         | Auto                             |
| --- | ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------- |
| A1  | new enterprise user      | `ccs init`, answer Y, Y                                                                 | statusline installed, Mon–Fri saved for this + next month, calendar opens with today highlighted | `src/cli.spec.ts`                |
| A2  | new Pro user             | `organizationType: claude_pro`, `ccs init`                                              | statusline installed, "No spend cap on this plan", no calendar                                   | `src/cli.spec.ts`                |
| A3  | no Claude login          | remove `oauthAccount`, `ccs init`                                                       | "default (no OAuth account)", "Plan not detected yet", no crash                                  | `src/cli.spec.ts`                |
| A4  | user with own statusline | put a custom `~/.claude/statusline.mjs` + `statusLine` in settings, `ccs statusline`, Y | both backed up; `previous-statusline.json` written; settings has `refreshInterval: 30`           | `src/statusline-install.spec.ts` |
| A5  | re-run                   | `ccs statusline` twice                                                                  | second run: "already up to date", no new backup, no prompt                                       | `src/statusline-install.spec.ts` |
| A6  | declines statusline      | `ccs init`, n                                                                           | capture-only line added; budget still captured                                                   | `src/cli.spec.ts`                |
| A7  | first render             | `payload '{"session_id":"x","cost":{"total_cost_usd":1}}'` on an empty sandbox          | line in < 0.2 s locally, `⚠ run: cc-spend init`, `usage.json` has no `days`                      | `e2e/cli.spec.ts`                |
| A8  | broken settings.json     | write `{oops` to `~/.claude/settings.json`, `ccs statusline`                            | clear error, nothing half-written                                                                | manual                           |
| A9  | read-only home           | `chmod -w $SANDBOX/.config`, render                                                     | session part of the line still prints                                                            | `src/statusline.spec.ts`         |
| A10 | via `npx`                | `npx cc-spend statusline`, then clear the npx cache                                     | line shows `⚠ cc-spend not found — reinstall it`, Claude Code keeps working                      | manual                           |
| A11 | **live**                 | install on your machine, open Claude Code                                               | full line renders; `🌿 branch` correct in a worktree                                             | manual                           |

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

| ID  | Persona      | Steps                                                | Expected                                                                                          | Auto                                          |
| --- | ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| C1  | tester       | `ccs calendar`                                       | first frame instantly (< 0.2 s); today bold+underlined with `today` and `•$live`; past days dim   | `src/calendar-tui.spec.ts`, `e2e/cli.spec.ts` |
| C2  | tester       | arrows over month/year edges, Tab/Shift-Tab, `[` `]` | cursor wraps correctly; Feb 30 never selected                                                     | `src/calendar-tui.spec.ts`                    |
| C3  | tester       | Space on a past day                                  | "locked" notice; config unchanged                                                                 | `src/calendar-tui.spec.ts`                    |
| C4  | tester       | resize the terminal                                  | redraws, no garbage                                                                               | manual                                        |
| C5  | tester       | `ccs calendar < /dev/null` / piped                   | prints one frame, exits 0                                                                         | `e2e/cli.spec.ts`                             |
| C6  | tester       | `NO_COLOR=1 ccs calendar`                            | no ANSI colours                                                                                   | manual                                        |
| C7  | tester       | Ctrl+C, q, Esc                                       | exits, terminal restored (cursor visible, main screen)                                            | manual                                        |
| C8  | tester       | keep it open while a Claude session spends           | numbers update within ~2 s                                                                        | manual                                        |
| C9  | Pro user     | `ccs calendar`                                       | boxed notice with plan name, ⏱/🎫/🧊 explanation; Ink-free, instant                               | `src/cli.spec.ts`, `e2e/cli.spec.ts`          |
| C10 | unknown plan | `something_new` before any render                    | "Plan not detected yet" notice                                                                    | `src/cli.spec.ts`                             |
| C11 | tester       | narrow terminal (e.g. 60 columns) with Claude Code   | default layout: the line ends in `…`; after splitting it with `ccs settings`, every line complete | manual                                        |

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
| E11 | enterprise, refresher keeps failing   | block api.anthropic.com, keep working     | `$month` keeps rising with this machine's sessions and shows `Nm old`; next good reading takes over  | `src/statusline.spec.ts`        |
| E12 | server sends 429 + Retry-After        | `ccs doctor` after the 429                | `last fetch failed (HTTP 429); last good reading …`; no fetch before `retryAt` (≤ 1 h)               | `src/anthropic-usage.spec.ts`   |

## F. Sessions and accounts

| ID  | Persona                      | Steps                                                                               | Expected                                                                                               | Auto                                                      |
| --- | ---------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| F1  | two sessions at once         | two Claude Code windows spending                                                    | both counted once each                                                                                 | `src/calc.spec.ts`                                        |
| F2  | `/clear`                     | cost drops to 0                                                                     | no negative delta; next spend counted                                                                  | `src/calc.spec.ts`                                        |
| F3  | resume an old session        | `claude --resume` after > 2 days                                                    | ledger users: no double count; no-ledger users: may count again (known, see ponytail)                  | manual                                                    |
| F4  | account switch               | `/login` to another account                                                         | next render uses the other `accounts/<key>/`; the session's cost before the switch is not booked to it | `src/statusline.spec.ts`                                  |
| F5  | per-terminal token           | `CLAUDE_CODE_OAUTH_TOKEN=…`                                                         | resolved once via profile, cached; no per-render network                                               | `src/account.spec.ts`                                     |
| F6  | Pro → enterprise mid-session | change `organizationType`                                                           | dollar budget appears; Pro spend never booked                                                          | `src/statusline.spec.ts`                                  |
| F7  | `/login` in another terminal | two sessions; `/login` to the other account in one, then send a prompt in the other | the other line starts with `⇄ <email>` for 10 min; its 5h/7d stay until its first response             | `src/statusline.spec.ts`, `src/statusline-render.spec.ts` |
| F8  | report after a switch        | F7, then `ccs report today --by session --account <key>` for each account           | the session is in both reports, each with only the turns of its own login                              | `src/transcript-index.spec.ts`                            |

## G. Prompt-cache predictor

| ID  | Persona                                                                   | Steps                                                                | Expected                                                                                                                                      | Auto                                                                              |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| G1  | **live** heavy user                                                       | long session, look at `🧊`                                           | countdown matches `/usage` "Prompt cache (main)"; `next ~$` small while warm                                                                  | manual                                                                            |
| G2  | **live**                                                                  | wait past the TTL, send a prompt                                     | segment turns `❄ cold`; the turn's cost delta ≈ the shown cold cost (±10 %)                                                                   | manual                                                                            |
| G3  | 5m vs 1h TTL                                                              | payload `ttl` 5m / 1h                                                | write rate 1.25× / 2× input                                                                                                                   | `src/cache-forecast.spec.ts`                                                      |
| G4  | after `/compact`                                                          | `recache_tokens_if_cold: null`                                       | no cold price, no crash                                                                                                                       | `src/cache-forecast.spec.ts`                                                      |
| G5  | unknown model                                                             | `model.id` not in the table                                          | cache part reads `⚠ <id>: no price, $ not estimated`                                                                                          | `src/statusline-render.spec.ts`                                                   |
| G6  | old Claude Code                                                           | no `prompt_cache`                                                    | no segment                                                                                                                                    | `src/cache-forecast.spec.ts`                                                      |
| G7  | big context                                                               | `used_percentage ≥ 60`                                               | no `→` hint on the line                                                                                                                       | `src/statusline-render.spec.ts`                                                   |
| G8  | warm, costly to lose; then cold                                           | if-cold extra ≥ $1; cold ≥ $1                                        | `if cold +$…` while warm, `next req ~$…` once cold; no `→` hint                                                                               | `src/statusline-render.spec.ts`                                                   |
| G9  | `/model` switch while warm, context ≥ $1                                  | **live**                                                             | Claude Code asks to confirm, reason names the target model, tokens and `~$`                                                                   | `src/model-switch.spec.ts`                                                        |
| G10 | `/model` switch while cold or cheap                                       | **live**                                                             | switch applies; a `cc-spend: switching to … ~$` message shows                                                                                 | `src/model-switch.spec.ts`                                                        |
| G11 | a cache miss of any cause                                                 | payload `last_miss_cause`                                            | no `last miss` text on the line                                                                                                               | `src/statusline-render.spec.ts`                                                   |
| G12 | Sonnet 5.5; Haiku 5.5 at 200k context; Opus 4.6 fast; Opus 4.5 transcript | `model.id`, `fast_mode`                                              | Sonnet 5.5 read $0.10/MTok; Haiku 5.5 over 100K at $0.05 read, $0.50 input; Opus 4.6 fast 6×; Opus 4.5 turns priced                           | `src/pricing.spec.ts`, `src/cache-forecast.spec.ts`                               |
| G13 | **live**, warm cache                                                      | compare the line with `/usage` and the next request's `usage`        | `$/req` = (cache read + cache write tokens) × read rate; `if cold +$` = that prefix × (write − read rate)                                     | `src/cache-forecast.spec.ts`                                                      |
| G14 | fast mode on Opus 4.7; a US-only (`inference_geo: "us"`) session          | `/fast`, `insights`                                                  | statusline prices Opus 4.7 at standard; that session's $ is 1.1× list; coach R2 shows the surcharge only                                      | `src/cache-forecast.spec.ts`, `src/transcript-parse.spec.ts`, `src/rules.spec.ts` |
| G15 | **live**, index built at older prices                                     | run `cc-spend report`                                                | `index/last-pass.json` has `repriced`; `index/backup-prices-<old>/` exists; Sonnet 5.5 cache-read $ halves; sessions without transcripts stay | `src/transcript-index.spec.ts`                                                    |
| G16 | **live**, a prompt with tool steps                                        | watch the cost and duration parts                                    | `$X · prompt $Y` grows during the prompt and restarts on the next; `⏲ … · api …`                                                              | `src/statusline.spec.ts`, `src/statusline-render.spec.ts`                         |
| G17 | session with skills, MCP calls, a 429                                     | `report week`                                                        | "Attributed by Claude Code: skill … mcp …" and "API errors N: 429 …" notes; cache part shows `N/M req missed` after a miss                    | `src/report.spec.ts`, `src/statusline-render.spec.ts`                             |
| G18 | **live** Pro/Max, hit a usage limit with auto-continue on                 | wait for the reset                                                   | Claude Code's continue prompt is not blocked by the gate; the task resumes                                                                    | `src/prompt-gate.spec.ts`                                                         |
| G19 | **live**, cold cache over `promptGateMinUsd`                              | run a background Bash command, wait past the cache TTL until it ends | its `<task-notification>` is not blocked; Claude reacts to the result                                                                         | `src/prompt-gate.spec.ts`                                                         |

## H. CLI input robustness (try to break it)

| ID  | Steps                                                                                       | Expected                                                        | Auto                                        |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| H1  | `ccs`, `ccs -h`, `ccs calendar --help`, `ccs --help init`                                   | help, exit 0                                                    | `src/cli.spec.ts`, `e2e/cli.spec.ts`        |
| H2  | `ccs bogus`, `ccs init extra`, `ccs calendar ""`                                            | "Unknown argument: …", exit 1                                   | `src/cli.spec.ts`, `e2e/cli.spec.ts`        |
| H3  | `--statusline-line` with empty, garbage, `null`, `[1]` stdin; then a 10 MB payload (manual) | a line every time                                               | `src/statusline.spec.ts`, `e2e/cli.spec.ts` |
| H4  | `--refresh` without a key                                                                   | clear error                                                     | `src/cli.spec.ts`                           |
| H5  | corrupt `config.json` / `usage.json` / `api-cache.json`                                     | re-seeded; corrupt copy kept as `.corrupt-<ms>`                 | `src/config.spec.ts`                        |
| H6  | `monthlyCap: "lots"`                                                                        | default cap used                                                | `src/config.spec.ts`                        |
| H7  | cap edit with `..`, empty, letters, `99999999`                                              | invalid rejected with a notice; letters ignored; large accepted | `src/calendar-tui.spec.ts`                  |
| H8  | Ctrl+C during `init` prompts                                                                | exits, no half-written file                                     | manual                                      |
| H9  | stale `refresh.lock` left behind                                                            | refresher runs again after 30 s                                 | `src/refresh.spec.ts`                       |
| H10 | Windows: paths with spaces / drive letters                                                  | shim imports via `file://` URL; renders                         | manual                                      |

## I. Upgrade and uninstall

| ID  | Steps                                        | Expected                                                       | Auto                             |
| --- | -------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| I1  | upgrade the package, re-run `ccs statusline` | "Updated statusline: vA → vB"                                  | `src/statusline-install.spec.ts` |
| I2  | upgrade without re-running                   | old shim keeps working (`--statusline` JSON kept)              | `src/statusline.spec.ts`         |
| I3  | move the package (new path)                  | next `ccs statusline` rewrites the shim (hash covers the path) | `src/statusline-install.spec.ts` |
| I4  | `ccs uninstall` after A4                     | foreign script and old `statusLine` restored; data kept        | `src/statusline-install.spec.ts` |
| I5  | `ccs uninstall` with nothing installed       | "Nothing to remove"                                            | `src/cli.spec.ts`                |

## J. Performance

| ID  | Steps                                                                      | Expected                         | Auto                           |
| --- | -------------------------------------------------------------------------- | -------------------------------- | ------------------------------ |
| J1  | `scripts/bench.sh 21 sh -c "node ~/.claude/statusline.mjs < payload.json"` | median within ~2× of `node -e 0` | manual (`docs/performance.md`) |
| J2  | `scripts/bench.sh 21 sh -c "ccs calendar < /dev/null"`                     | same bound                       | manual                         |
| J3  | fresh sandbox first render                                                 | < 1.5 s on CI, ≪ 0.2 s locally   | `e2e/cli.spec.ts`              |

## K. Statusline layout (`ccs settings`)

| ID  | Steps                                                           | Expected                                                                                  | Auto                                             |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| K1  | no `statusline.json`, any session                               | first line every part; second line `»` tip then `⚠` limit warnings, each when it has data | `src/statusline-render.spec.ts`                  |
| K2  | `ccs settings`, put 7 on row 2, clear it on row 1, Enter        | "Saved statusline layout"; next render has the cache part on line 2                       | `src/settings-tui.spec.ts`, manual               |
| K3  | type `1` then `2`; type `5` then `3`; type `0`; place 5 twice   | cell shows 12; then 3; preview shows the error; Enter does not save                       | `src/settings-tui.spec.ts`                       |
| K4  | Esc / q / Ctrl+C                                                | "Not saved."; terminal restored                                                           | `src/settings-tui.spec.ts`, manual               |
| K5  | `ccs settings < /dev/null`                                      | prints one frame, exits 0                                                                 | manual                                           |
| K6  | corrupt or hand-edited `statusline.json` (unknown ids, repeats) | statusline still renders; bad ids dropped, nothing usable → default                       | `src/statusline-layout.spec.ts`                  |
| K7  | scroll the mouse wheel / trackpad in `ccs settings`             | the cursor does not move; after exit, the terminal scrolls normally                       | `src/calendar-tui.spec.ts` (`parseKeys`), manual |

## L. History and feed (CLI-1..5)

| ID  | Steps                                                                                      | Expected                                                                                                                     | Auto                                                                                    |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| L1  | Max account; work 20+ min in one session                                                   | `limits.json` gains a sample per % change; `⚠ 5h runs out ~HH:MM` only when the rate empties the window before reset         | `src/limits-history.spec.ts`, `src/statusline.spec.ts`                                  |
| L2  | after 3+ one-point rises of the 7d %                                                       | `⏱ …` has no `1%/7d≈$X`; `feed.json` `limits.usdPerPercentWeek` is set                                                       | `src/limits-history.spec.ts`                                                            |
| L3  | add or remove an MCP server mid-session, send a prompt                                     | `miss: tools changed` (or the cause) on the cache part for about two minutes, then gone; `usage.missCauses[today]` counts it | `src/cache-forecast.spec.ts`, `src/statusline-render.spec.ts`, `src/statusline.spec.ts` |
| L4  | `node bin/cc-spend.js --refresh <key>` with a logged-in account                            | `accounts/<key>/feed.json` has `schemaVersion: 1`, current `sessionIds`, limits with verdicts, `spend`                       | `src/refresh.spec.ts`, `src/feed.spec.ts`                                               |
| L5  | Pro/Max: a day of work                                                                     | `usage.apiEqDays[today]` grows by the session cost deltas; `monthlySpent` stays 0                                            | `src/calc.spec.ts`                                                                      |
| L6  | Max, `⚠ 5h out ~` shown; type a prompt and let a long turn run (a fetch may fail with 429) | the `⚠ … out ~` notice stays and its time does not jump; it hides only 15 min after the last good reading                    | `src/limits-history.spec.ts`, `src/statusline.spec.ts`, manual                          |

## M. File versions and downgrade guard (CLI-6)

| ID  | Steps                                                                   | Expected                                                                                       | Auto                                                              |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| M1  | config.json without `schemaVersion`, run any render                     | file gains `"schemaVersion": 1`, other fields equal; one `config.json.bak-*` next to it        | `src/config.spec.ts`                                              |
| M2  | set `"schemaVersion": 99` in config.json, render and run `ccs settings` | line starts `⚠ update cc-spend`; the command prints the npm hint; the file is byte-equal after | `src/config.spec.ts`, `src/statusline.spec.ts`, `src/cli.spec.ts` |
| M3  | migrate 5 times (delete the version each time)                          | only the newest 3 backups stay                                                                 | `src/config.spec.ts`                                              |

## N. Doctor, transcript index and report (CLI-7 part, CLI-8)

| ID  | Steps                                              | Expected                                                                                           | Auto                           |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------ |
| N1  | `ccs doctor` on a working install                  | every line `✔` (a `⚠` for `claude` when not on PATH); exit 0                                       | `src/doctor.spec.ts`           |
| N2  | set a config `schemaVersion` to 99, `ccs doctor`   | `✖ account …: config.json v99 is from a newer cc-spend`; exit 1                                    | `src/doctor.spec.ts`           |
| N3  | `ccs report` after a day of work                   | table by model; footer "API-equivalent estimate", subagent share                                   | `src/report.spec.ts`           |
| N4  | run `ccs report` twice                             | second run reads 0 new bytes; same numbers                                                         | `src/transcript-index.spec.ts` |
| N5  | `ccs report week --by subagent --json`             | JSON with one row per agent type plus `main`                                                       | `src/report.spec.ts`           |
| N6  | a session started with `claude -p` (no statusline) | its $ shows as "more in sessions no account claimed"; `ccs report --account unattributed` lists it | `src/report.spec.ts`           |
| N7  | `ccs report 2026-13`, `ccs report --by colour`     | clear error, exit 1                                                                                | `src/cli.spec.ts`              |

## O. Coach (CLI-9)

| ID  | Steps                                               | Expected                                                                            | Auto                                             |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| O1  | a week with Opus subagents, `ccs insights`          | `R1 Subagents on a premium model ~$…/week` with `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` | `src/rules.spec.ts`                              |
| O2  | `ccs insights --snooze R1 7d`, then `ccs insights`  | R1 last, marked snoozed; the `»` coach line shows the next finding                  | `src/insights.spec.ts`, `src/statusline.spec.ts` |
| O3  | no `statusline.json`, after a refresh with findings | second line `» <tip> ~$X/week`                                                      | `src/statusline-render.spec.ts`                  |
| O4  | a quiet week                                        | `Nothing to change this week.`; no `»` coach line                                   | `src/insights.spec.ts`                           |
| O5  | 5h window at risk                                   | R8 first, no $                                                                      | `src/rules.spec.ts`                              |

## P. Review fixes and new usage data (2026-10-15)

| ID  | Steps                                                                                                | Expected                                                                                                                                                   | Auto                                                           |
| --- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| P1  | Pro/Max, a window at risk and the other near its limit                                               | one segment: `⚠ 5h out ~5:22pm (1h13m) · 7d resets Tue 7pm (5d3h)`                                                                                         | `src/statusline-render.spec.ts`                                |
| P2  | a window at 100%                                                                                     | `⛔ 5h full → 5:22pm (1h13m)`, red                                                                                                                         | `src/statusline-render.spec.ts`                                |
| P3  | warm cache with under a minute left                                                                  | `🔥 cold in <1m`; `settings.json` unchanged by renders                                                                                                     | `src/statusline.spec.ts`                                       |
| P4  | `refreshInterval: 1` in settings, `ccs doctor`, then `ccs statusline`                                | doctor warns; after `statusline` it is 30                                                                                                                  | `src/doctor.spec.ts`, `src/statusline-shared.spec.ts`          |
| P5  | kill `ccs statusline` while it writes settings (or inspect the code path)                            | `settings.json` is either old or new, never empty; file mode kept                                                                                          | `src/statusline-shared.spec.ts`                                |
| P6  | block api.anthropic.com, keep a session running for 5 min                                            | ⏱ keeps the session's own reading; refresher retries at 2, 4, 8 min (`api-cache.json` `failures`)                                                          | `src/anthropic-usage.spec.ts`, `src/statusline.spec.ts`        |
| P7  | Max account with Opus weekly window                                                                  | `⏱ … NN%/7d-opus`                                                                                                                                          | `src/statusline-render.spec.ts`                                |
| P8  | `ccs doctor` after a refresh                                                                         | `✔ plan <key>: tier …, subscription active, last session on Claude Code 2.1.x`                                                                             | `src/doctor.spec.ts`                                           |
| P9  | start a subagent in Claude Code                                                                      | agent panel row `Explore · … · 🤖 Sonnet 5.5 high · 41k (4%)`; Opus drawn orange                                                                           | `src/subagent-line.spec.ts`                                    |
| P10 | `/rename fix login`, then `ccs report week --by session`                                             | row `<id> fix login`                                                                                                                                       | `src/report.spec.ts`                                           |
| P11 | `ccs report` after a day of work                                                                     | footer `Turn time …h…m (thinking …) · N hook runs · started from cli N`                                                                                    | `src/report.spec.ts`, `src/transcript-index.spec.ts`           |
| P12 | behind a Claude apps gateway, Claude Code 2.1.284+                                                   | `💳 63% $62.80/$100.00/mo`                                                                                                                                 | `src/statusline-render.spec.ts`                                |
| P13 | use claude.ai chat as well as Claude Code for a week                                                 | `feed.json` `limits.claudeCodeShare` < 1; `usdPerPercentWeek` higher than without the share                                                                | `src/limits-history.spec.ts`                                   |
| P14 | Pro/Max account with a limit reset left (`/usage` offers it)                                         | `↺ 1 reset · by <date>` at the end of the first row; gone after the reset is used or on a Team plan                                                        | `src/statusline-render.spec.ts`, `src/anthropic-usage.spec.ts` |
| P15 | finish a few Claude Code sessions, then `ccs report week`                                            | `Claude Code counted $… for N of these sessions: $… (…%) more than the transcripts show…`; no `Claude Code prices …` line while the price table is current | `src/report.spec.ts`                                           |
| P16 | machine set up before the rename (`~/.config/cc-daily-usage/`, old shim), then `cc-spend statusline` | `~/.config/cc-spend/` holds the old accounts; no "replace" prompt; hooks and `subagentStatusLine` run `bin/cc-spend.js`                                    | `src/config.spec.ts`                                           |

## Q. Live meters, burn-up and CLI gaps (2026-10-18)

| ID  | Steps                                                                 | Expected                                                                                                                                                                                                     | Auto                                                       |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Q1  | two Claude Code sessions working; `ccs live` in a third terminal      | both sessions listed newest first with $ bars; ↑↓ moves the selection; the selected one shows facts, sparkline and bar blocks (where it went, models, work), cache and context bars; `q` restores the screen | `src/live-render.spec.ts`, `src/live-tui.spec.ts`, manual  |
| Q2  | in one session start a subagent (Task / Explore)                      | `agents` row with its type and $; session $ includes it                                                                                                                                                      | `src/session-model.spec.ts`, `src/live-tui.spec.ts`        |
| Q3  | leave a session idle past its TTL (5 min)                             | CACHE turns `cold · next prompt re-writes ~$X`; the session shows `idle Nm`                                                                                                                                  | `src/live-render.spec.ts`                                  |
| Q4  | `ccs live` at 50 columns, then resize to 120                          | narrow: 8-cell bars, no sparkline, short title; wide: 24-cell bars and a 30-minute sparkline on resize                                                                                                       | `src/live-render.spec.ts`, manual                          |
| Q5  | Team/Enterprise account: `ccs live`                                   | BUDGET today and month bars with pace instead of LIMITS                                                                                                                                                      | `src/live-render.spec.ts`                                  |
| Q6  | fresh HOME, no feed.json: `ccs live --once`                           | frame prints; footer `no feed.json yet: run cc-spend init`; no files written beside the feed rebuild                                                                                                         | `src/live-render.spec.ts`                                  |
| Q7  | compare `ccs live` session $ with the statusline cost of that session | within a few percent; a larger gap points at the price table (`report` self-check)                                                                                                                           | manual                                                     |
| Q8  | `ccs report week --by day --chart`, then `--by model --chart`         | a stacked bar per row scaled to the largest; days in time order; legend line                                                                                                                                 | `src/report.spec.ts`                                       |
| Q9  | `ccs report --session <first 8 chars of an id from --by session>`     | header with project, branch, turns, $, time span; $/slot and total sparklines; events row with `!`/`C`/`S`; summary rows                                                                                     | `src/session-report.spec.ts`                               |
| Q10 | `ccs report --session a` (matches several) / `--session zzz`          | error listing the matches / `No transcript for session zzz`, exit 1                                                                                                                                          | `src/session-report.spec.ts`, `src/cli.spec.ts`            |
| Q11 | `ccs report week --by session` on a Max account with $ per 1% known   | columns `% of week` and `$/100 lines`; component columns `—`                                                                                                                                                 | `src/report.spec.ts`                                       |
| Q12 | `ccs report` after a day of work started after this release           | `Efficiency: new work …% · carry …% · rewrite …% · $N/MTok of new work (band)`                                                                                                                               | `src/report.spec.ts`, `src/transcript-index.spec.ts`       |
| Q13 | a week with an MCP server loaded and never called; `ccs insights`     | `R7 Unused MCP servers` with server, tokens, sessions and `/mcp` fix (when ≥ $0.50)                                                                                                                          | `src/rules.spec.ts`, `src/transcript-index.spec.ts`        |
| Q14 | large CLAUDE.md (≥ 10k tokens) in a busy project; `ccs insights`      | `R12 Large instruction files` naming the largest files (when ≥ $0.50)                                                                                                                                        | `src/rules.spec.ts`, `src/insights.spec.ts`                |
| Q15 | Team calendar: `d` on a worked day, arrows, `Esc`                     | detail box with top sessions, models, projects follows the cursor; `Esc` closes it, a second `Esc` quits                                                                                                     | `src/calendar-tui.spec.ts`                                 |
| Q16 | laboral days Mon–Fri set; Friday evening 7d runway                    | `live` 7d `out in …` skips the weekend vs a month with no laboral days                                                                                                                                       | `src/limits-history.spec.ts`, `src/calc.spec.ts`           |
| Q17 | 5h window passes 75 % then 90 % while watched                         | `live` LIMITS shows `crossed 90% Nm ago`; `feed.json` `limits.milestones` has the 90 crossing only                                                                                                           | `src/limits-history.spec.ts`, `src/feed.spec.ts`           |
| Q18 | `ccs doctor` before and after `ccs report`                            | `⚠ index: no pass yet` → `✔ index: last pass … up to date`                                                                                                                                                   | `src/doctor.spec.ts`                                       |
| Q19 | `ccs insights --rules`                                                | all 12 rules, each with checks / why / $ / fix; `●` on the ones `ccs insights` lists                                                                                                                         | `src/insights.spec.ts`, `src/cli.spec.ts`                  |
| Q20 | `ccs insights` with two findings, one of them R8                      | a blank line between findings; each has a `why:` line; R8 shows no amount; footer points to `--rules`                                                                                                        | `src/insights.spec.ts`                                     |
| Q21 | README "What `insights` checks" vs `ccs insights --rules`             | same 12 rules, same why and fix texts                                                                                                                                                                        | manual                                                     |
| Q22 | `ccs live` in a 40-row terminal, then 80 rows                         | 40: no blank lines (or a cut with "… a taller terminal shows the rest"), never scrolls; 80: blank lines between blocks                                                                                       | `src/live-render.spec.ts`, manual                          |
| Q23 | `ccs live` at 100 columns                                             | one bar per component, model, agent and work type, aligned in one column with $ and % right of it                                                                                                            | `src/live-render.spec.ts`, manual                          |
| Q24 | `ccs live` on a long session (context over 150k)                      | advisor view by default: scorecard rows with aim and ✔/~/✖; "do now" names the context with the per-turn price and the price after `/compact`                                                                | `src/advisor.spec.ts`, `src/live-render.spec.ts`           |
| Q25 | in `live` press Tab twice                                             | details view (where it went, models, agents, work), then advisor again; the title names the other view                                                                                                       | `src/live-tui.spec.ts`, manual                             |
| Q26 | leave a session idle 4 min with `live` open                           | at ≤ 90 s left a "cache goes cold" tip with cold vs warm price; after expiry a "cache is cold" tip with `/clear` / `/compact`                                                                                | `src/advisor.spec.ts`, manual                              |
| Q27 | a session with two breaks over 5 min (5m TTL)                         | "breaks" tip with the re-write $; suggests `"promptCacheTtl": "1h"` only when the extra on writes is lower                                                                                                   | `src/advisor.spec.ts`                                      |
| Q28 | follow a tip (e.g. `/compact`), watch `live`                          | the matching score moves toward its aim within a few turns; the tip drops                                                                                                                                    | manual                                                     |
| Q29 | let the cache reach under 90 s left in a session with a big context   | second line: `» send now or /compact · cache cold in …s, then +$…` in orange; gone after the next prompt                                                                                                     | `src/next-action.spec.ts`, manual                          |
| Q30 | after the cache went cold                                             | `» new task? /clear · same task? /compact first`; the cache part keeps the price                                                                                                                             | `src/next-action.spec.ts`, `src/statusline-render.spec.ts` |
| Q31 | a session past 150k context, cache warm                               | `» /compact at the next break · NNNk re-read each turn, ~$…`; after `/compact` it changes                                                                                                                    | `src/next-action.spec.ts`, manual                          |
| Q32 | limits at risk and nothing urgent in the cache                        | `» /model sonnet for routine steps …`, never "Running out early" (the ⚠ part shows the time)                                                                                                                 | `src/next-action.spec.ts`, `src/statusline.spec.ts`        |
| Q33 | quiet session, a weekly finding (e.g. R2)                             | `» /fast off · ~$X/week`                                                                                                                                                                                     | `src/next-action.spec.ts`                                  |

## R. Record (2026-11-12)

| ID  | Steps                                                                   | Expected                                                                                                                                         | Auto                                                           |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| R1  | upgrade, open Claude Code, wait for one refresh; `ccs record`           | `RECORD #1` from today, day 1/7, `Too early` line, dim values; baseline column filled when the 7 days before had use                             | `src/record-store.spec.ts`, `src/refresh.spec.ts`              |
| R2  | fresh HOME with no transcripts; refresh, then `ccs record`              | `No baseline yet` line; only the now column                                                                                                      | `src/record.spec.ts`                                           |
| R3  | day 3 or later of a record                                              | verdict `N of 5 habits better than baseline`; ✔ / ✖ / ≈ per habit; FOCUS with `better ✔` / `worse ✖` / `same ≈`; MOVED rules                     | `src/record.spec.ts`                                           |
| R4  | let a record end (or set the clock a week ahead), open Claude Code      | statusline `» record #1 done: N/5 habits better · cc-spend record` until `ccs record`; then `RECORD #1 CLOSED` block first, gone on the next run | `src/record.spec.ts`, `src/statusline.spec.ts`, manual         |
| R5  | `ccs record --all` after two records                                    | rows `b`, `1`, `2 … now`; trend sparklines; `Next record: 7 days`                                                                                | `src/record.spec.ts`                                           |
| R6  | `ccs record --days 14`, then let the record end                         | `The next record lasts 14 days.`; the next record runs 14 days, the live one keeps 7                                                             | `src/record-store.spec.ts`, `src/cli.spec.ts`                  |
| R7  | type prompts, `/clear`, `/compact`, stop a reply with Esc; `ccs record` | VOLUME `commands` line counts each; `prompts` per day                                                                                            | `src/transcript-parse.spec.ts`, `src/transcript-index.spec.ts` |
| R8  | `ccs record --json`                                                     | `baseline`, `closed`, `current` with `values` per habit                                                                                          | `src/record.spec.ts`                                           |
| R9  | `ccs record` with `NO_COLOR=1` or piped                                 | no ANSI codes                                                                                                                                    | `src/record.spec.ts`                                           |

## Consequences

The plan is a release gate. A new feature adds rows here in the same change;
a fixed bug adds the row that would have caught it.
