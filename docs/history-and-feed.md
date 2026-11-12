# History and the feed

What the CLI keeps beyond today's budget, and `feed.json`, the file the
`/cost-tracker` mod reads. The CLI is the only writer; the mod only reads.

## Limit history (`src/limits-history.ts`)

The render appends the resolved 5h/7d reading to `limits.json` when either %
changes (`appendSample`; 29 days or 2,000 samples). A sample is a change point:
its % holds until the next sample. 29 days keep four finished weeks for the
typical peak; the count cap bounds the file the render reads.

`computeRunway(samples, window, usedPct, resetsAt, readingAt, now, workDay)`:

| Step    | Rule                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| stale   | reading older than 15 min → `stale`                                                                                                        |
| full    | `usedPct ≥ 100` → `at-risk`, `exhaustsAt = now`                                                                                            |
| anchor  | the sample in force 2 h before the reading, else the first one after; a reset or a missing % restarts                                      |
| guard   | under 15 min from anchor to the reading → `insufficient-data`                                                                              |
| rate    | `(usedPct − anchor %) / hours`, never negative                                                                                             |
| runway  | `exhaustsAt = reading + (100 − used) / rate`; null when the rate is 0. Measured to the reading, not now: the verdict holds between fetches |
| verdict | exhausts before reset → `at-risk`; rate ÷ (left ÷ hours to reset) ≤ 0.8 → `comfortable`; else `on-track` (also without a reset time)       |

Work days (7d window only): with `workDay` (`workDayOf(config)` in
`src/calc.ts`: the month's `laboralDays`, every day in a month with none, null
when no laboral day is set at all), the hours to exhaustion and to reset count
only work days (`addWorkHours`, `workHoursBetween`). The reading's own day always
counts: a reading proves use. A work day burns at the measured rate around the
clock. No exhaustion within 60 days → null.

Window instances: samples of one window share a reset time, rounded to the hour
(the API jitters it by seconds).

- `typicalPeak(samples, window, now)`: median of the top % of each finished
  instance (antiburn's "allowance": do you use your plan); null under two.
- `milestones(samples, window)`: crossings of 75 / 90 / 100 %. The first
  reading of an instance primes it (a threshold already passed is not news); a
  jump over several reports only the highest. No state is stored: a consumer
  (the mod's toasts) keeps which ones it showed.

`usdPerPercentWeek`: between samples where the 7d % rose at least one point,
Δ `apiEqTotal` ÷ (Δ% × `claudeCodeShare`). The share is Claude Code's part of
the week from the API's `seven_day_breakdown` (chat and Cowork use raise the %
but not our $); no share counts as 1, a share under 5% skips the rise. Median
over 14 days, at least 3 rises, else null. It counts only spend this
statusline saw, so use on other devices makes it read low. Only `feed.json`
carries it; the statusline does not show it.

Reset rule (both functions): a drop in % is a reset only when the window's
reset time moved forward by more than a minute (the API jitters it by a second)
or is unknown. A drop with the same reset time is a bad reading and is skipped.

## Session map (`src/sessions-map.ts`)

`recordSession` keeps per session the transcript path, first/last seen, cost and
lines changed in `sessions-map.json`, for 35 days. It returns a new map only for
a new session, a changed path, or an entry an hour old, so most renders do not
write. `recentSessionIds` feeds `feed.json.sessionIds`.

## `feed.json` (`src/feed.ts`)

Written by the detached refresher after each API call (`writeFeed` in
`src/refresh.ts`), never by the render, so it is as fresh as `api-cache.json`.
Accounts without an OAuth login get no refresher and so no feed.

| Field                     | Content                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`           | `FEED_SCHEMA_VERSION` (1). Add a field freely; remove or change one → bump                                                                                                                                                                                         |
| `writtenAt`, `accountKey` | ISO time, account folder                                                                                                                                                                                                                                           |
| `plan`                    | `{ organizationType, hasSpendCap }`                                                                                                                                                                                                                                |
| `sessionIds`              | sessions seen in the last 7 days, newest first (the mod finds its account by these)                                                                                                                                                                                |
| `limits`                  | `fiveHour`/`sevenDay`: `{ usedPct, resetsAt, ratePctPerHour, exhaustsAt, verdict, typicalPeakPct }` or null with no reading; `usdPerPercentWeek`; `claudeCodeShare` (0-1 or null); `milestones`: `[{ window, threshold, at, resetsAt }]` of the windows still open |
| `budget`                  | dollar-cap plans only: `{ todaySpent, todayMax, monthSpent, monthCap, paceLabel }`                                                                                                                                                                                 |
| `spend`                   | API-equivalent `today`, `week` (rolling 7 local days), `monthToDate` (local month), `last30Days`, `isFloor`                                                                                                                                                        |
| `advice`                  | coaching findings, ranked, each with `why` and `action` (absent in feeds written before 2026-10-18); empty until the coach runs                                                                                                                                    |
| `record`                  | `{ notice }`: the statusline note for a record that closed since the last `cc-spend record`, else null (`docs/record.md`); absent in feeds written before it                                                                                                       |

A window reading comes from the fresh API reading, else the newest sample (with
its own time, so an old one is `stale`).
