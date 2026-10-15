# History and the feed

What the CLI keeps beyond today's budget, and `feed.json`, the file the
`/cost-tracker` mod reads. The CLI is the only writer; the mod only reads.

## Limit history (`src/limits-history.ts`)

The render appends the resolved 5h/7d reading to `limits.json` when either %
changes (`appendSample`; 8 days or 2,000 samples). A sample is a change point:
its % holds until the next sample.

`computeRunway(samples, window, usedPct, resetsAt, readingAt, now)`:

| Step    | Rule                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| stale   | reading older than 15 min → `stale`                                                                                                  |
| full    | `usedPct ≥ 100` → `at-risk`, `exhaustsAt = now`                                                                                      |
| anchor  | the sample in force 2 h ago, else the first one after; a drop in % (reset) or a missing % restarts                                   |
| guard   | under 15 min from anchor to now → `insufficient-data`                                                                                |
| rate    | `(usedPct − anchor %) / hours`, never negative                                                                                       |
| runway  | `exhaustsAt = now + (100 − used) / rate`; null when the rate is 0                                                                    |
| verdict | exhausts before reset → `at-risk`; rate ÷ (left ÷ hours to reset) ≤ 0.8 → `comfortable`; else `on-track` (also without a reset time) |

`usdPerPercentWeek`: between samples where the 7d % rose at least one point,
Δ `apiEqTotal` ÷ Δ%. Median over 14 days, at least 3 rises, else null. It counts
only spend this statusline saw, so use on other devices makes it read low.

## Session map (`src/sessions-map.ts`)

`recordSession` keeps per session the transcript path, first/last seen, cost and
lines changed in `sessions-map.json`, for 35 days. It returns a new map only for
a new session, a changed path, or an entry an hour old, so most renders do not
write. `recentSessionIds` feeds `feed.json.sessionIds`.

## `feed.json` (`src/feed.ts`)

Written by the detached refresher after each API call (`writeFeed` in
`src/refresh.ts`), never by the render, so it is as fresh as `api-cache.json`.
Accounts without an OAuth login get no refresher and so no feed.

| Field                     | Content                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`           | `FEED_SCHEMA_VERSION` (1). Add a field freely; remove or change one → bump                                                       |
| `writtenAt`, `accountKey` | ISO time, account folder                                                                                                         |
| `plan`                    | `{ organizationType, hasSpendCap }`                                                                                              |
| `sessionIds`              | sessions seen in the last 7 days, newest first (the mod finds its account by these)                                              |
| `limits`                  | `fiveHour`/`sevenDay`: `{ usedPct, resetsAt, ratePctPerHour, exhaustsAt, verdict }` or null with no reading; `usdPerPercentWeek` |
| `budget`                  | dollar-cap plans only: `{ todaySpent, todayMax, monthSpent, monthCap, paceLabel }`                                               |
| `spend`                   | API-equivalent `today`, `week` (rolling 7 local days), `monthToDate` (local month), `last30Days`, `isFloor`                      |
| `advice`                  | coaching findings, ranked; empty until the coach runs                                                                            |

A window reading comes from the fresh API reading, else the newest sample (with
its own time, so an old one is `stale`).
