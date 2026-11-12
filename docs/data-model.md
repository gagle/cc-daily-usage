# Data model

Types live in `src/interfaces/config.interface.ts` and
`src/interfaces/statusline.interface.ts`.

## On-disk layout

```
~/.config/cc-spend/
  accounts/<accountKey>/config.json      Config — written by init, calendar, hook (plan/cap sync)
  accounts/<accountKey>/usage.json       UsageState — written by every render that changes it
  accounts/<accountKey>/api-cache.json   ApiCache — written ONLY by the --refresh process
  accounts/<accountKey>/limits.json      { schemaVersion 1, samples: LimitSample[] } — render, on a % change
  accounts/<accountKey>/sessions-map.json { schemaVersion 1, sessions } — render, new session or hourly
  accounts/<accountKey>/feed.json        Feed for the /cost-tracker mod — written ONLY by the refresher
  accounts/<accountKey>/refresh.lock     present while a refresher runs (stale after 30 s)
  accounts/<accountKey>/*.corrupt-<ms>   copy of a corrupt file, kept before re-seeding
  profiles.json                          token-hash → Account, for CLAUDE_CODE_OAUTH_TOKEN users
  account-log.json                       { schemaVersion 1, switches: { t, key }[] } — render, on a login change
  previous-statusline.json               what install replaced; read by uninstall
  statusline.json                        { rows: PartId[][] } — written by `settings`, read by every render
~/.claude/statusline.mjs                 the managed shim (from assets/statusline.mjs)
~/.claude/settings.json                  statusLine { type, command, refreshInterval 30 }, hooks.UserPromptSubmit gate, hooks.PreModelSwitch cost, subagentStatusLine, promptCacheTtl
```

Before the rename to cc-spend the root was `~/.config/cc-daily-usage/`; `moveLegacyRootDir` moves it once.

All writes are atomic (temp + rename, mode `0o600`). Missing files are seeded,
corrupt ones quarantined then re-seeded — nothing on this path throws.

## File versions (`src/migrate.ts`)

Each file has its own `schemaVersion`, never tied to the npm or plugin version.
A missing version is 0 (the format before versioning).

| File                                            | Version                    | Migration                                                                                        |
| ----------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `config.json`                                   | 1 (`CONFIG_MIGRATIONS`)    | on load: backup, then rewrite with the version; unknown fields kept                              |
| `usage.json`                                    | 2 (`USAGE_SCHEMA_VERSION`) | `upgradeUsage` on load; backup when below 2                                                      |
| `api-cache.json`                                | 1 (`API_CACHE_MIGRATIONS`) | none: a cache; the next refresh writes the version                                               |
| `statusline.json`                               | 2 (`LAYOUT_MIGRATIONS`)    | in memory on render (2 adds `resets` to the first row's end); the next `settings` save writes it |
| `limits.json`, `sessions-map.json`, `feed.json` | 1                          | new files, versioned from the start                                                              |
| `account-log.json`                              | 1                          | new file, versioned from the start                                                               |

- Backup: `<file>.bak-<ISO with - for :>-<pid>` next to the file; the newest 3
  are kept (`backupFile`).
- Downgrade guard: a file with a higher version than the code knows is read
  for what is safe (or not at all: `api-cache.json`, history files) and never
  written back (`writeVersionedFile`). The render prefixes the line with
  `⚠ update cc-spend`; a command prints `NEWER_FILE_HINT` to stderr.

## `Config`

| Field              | Meaning                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `monthlyCap`       | $ cap for the period. Overwritten from Anthropic's `monthly_limit` when the ledger reports one (> 0). Default 200. |
| `laboralDays`      | `{ "2026": { "10": [1, 2, 5, …] } }` — year → month (1-12) → local days of month                                   |
| `planType`         | verbatim `organizationType`, `null` without OAuth                                                                  |
| `hasSpendCap`      | whether the dollar budget runs (see `docs/architecture.md`)                                                        |
| `snoozed`          | coach rule id → ISO time its finding hides until (`insights --snooze`)                                             |
| `promptGateMinUsd` | block a cold-cache prompt costing at least this; `0` = off; default 1                                              |

## `UsageState` (schema v2)

| Field             | Meaning                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`   | `2`                                                                                                                                                      |
| `monthlySpent`    | spend in the current UTC period                                                                                                                          |
| `periodFrozen`    | part of `monthlySpent` frozen into past local days                                                                                                       |
| `lastUpdated`     | ISO instant; moves only when a boundary is crossed                                                                                                       |
| `days`            | local `YYYY-MM-DD` → frozen $                                                                                                                            |
| `sessions`        | session id → `{ lastSeenCost, lastSeenAt, cacheMissUsd?, cacheGate?, gateArmedAt?, missCounts?, promptId?, promptStartCost?, switchedAt?, switchCost? }` |
| `ledgerBaseline`  | ledger reading at this period's start                                                                                                                    |
| `sinceLedger`     | `{ readAt, usd }`: known sessions' growth since the ledger reading taken at `readAt`                                                                     |
| `rateLimitsCache` | last hook `rate_limits` snapshot + `seenAt`                                                                                                              |
| `extraUsageCache` | v1 only; read once as a fallback until `api-cache.json` exists                                                                                           |
| `apiEqDays`       | local `YYYY-MM-DD` → API-equivalent $ of every session seen, any plan; 62 days kept                                                                      |
| `apiEqTotal`      | monotone sum of the same deltas; limit samples difference it                                                                                             |
| `missCauses`      | local `YYYY-MM-DD` → cache-miss cause → `{ count, usd }`; 62 days kept                                                                                   |

Fields added without a schema bump get their defaults in `upgradeUsage`.

`switchedAt` (epoch ms) and `switchCost` mark a session this account took over
after a `/login` (see "Account switch" in `docs/architecture.md`).
`switchCost` is removed when the session's cost moves.

`account-log.json` is global, not per account: the login is one per machine.
It keeps 35 days of switches plus the newest older one.

## `limits.json`, `sessions-map.json`, `feed.json`

- `LimitSample`: `{ t epoch ms, fiveHourPct, sevenDayPct, fiveHourResetsAt, sevenDayResetsAt, apiEqTotal, claudeCodeShare? }`,
  appended only when a % changes; 29 days or 2,000 samples. Sorted by `t` on
  load (two racing renders can save them out of order).
- `SessionMapEntry`: `{ transcriptPath, firstSeenAt, lastSeenAt, costUsd, linesAdded, linesRemoved, name?, claudeVersion? }`;
  35 days by `lastSeenAt`. `name` is Claude Code's `session_name`; a changed
  name is written at once.
- A history file that is missing, garbled or of a newer version reads as empty.
- Transcript index files (`docs/transcript-index.md`) add fields without a
  version bump: rollups `growth`, `freshSplit`, `rewriteTokens`, `usdNewWork`,
  `usdCarry`, `usdRewrite` (missing → 0 on load); `offsets.json` per file
  `context`; `sessions.json` per session `mcpLoaded`, `mcpUsed`,
  `attributedUsd`, `apiErrors`, `ccRuns` (`{ <startTime>: { usd, models } }`,
  Claude Code's own cost per run) (missing → none). `index/prices.json` holds the
  `PRICES_VERSION` the index was priced at; `index/backup-prices-<version>/`
  is the copy taken before a re-price.
- `Feed`: the shared contract with the `/cost-tracker` mod, see `docs/history-and-feed.md`.

## `ApiCache`

`{ fetchedAt, extraUsage, fiveHour, sevenDay, stale?, readAt?, failures?, lastError?, retryAt?, extraWindows?, claudeCodeShare?, plan?, resets? }`.
`extraUsage` holds the usage-credits ledger in dollars (`decimal_places`
applied); windows are `{ pct 0-100, resetsAt epoch s, usedDollars?, limitDollars?, severity? }`
(`severity` from the response's `limits[]`: `session` → 5h, `weekly_all` →
7d). `extraWindows` are the other `seven_day_<key>` windows with a reading
(`{ key, ...window }`). `claudeCodeShare` (0-1) is Claude Code's row of
`seven_day_breakdown`. `resets` are the limit-reset grants with a reset
left and not paused (`{ left, endsAt epoch ms | null }`), read from the
undocumented `cedar_ember` block that the fetch asks for with
`?cedar_ember=1`; empty when the account is not eligible. `plan` is `{ fetchedAt, rateLimitTier, subscriptionStatus, billingType, trialEndsAt }`
from `/api/oauth/profile`, re-read daily. A failed fetch keeps the previous
reading with `stale: true`, its time in `readAt` (so the runway survives the
failure), counts `failures`, and keeps why in `lastError` (`HTTP 429`,
`network`, `bad response`, `no token`; `doctor` shows it); a good one clears
them. TTL 60 s (`API_CACHE_TTL_MS` in `src/anthropic-usage.ts`), doubled per
failure up to 16 min; a `Retry-After` (seconds or date) sets `retryAt`, capped
at 1 h, and no fetch starts before it. `/api/oauth/usage` is undocumented: every field is read as
optional (shape observed 2026-10-15).

## `StatuslineState`

What `cc-spend --statusline` prints and `renderStatusline` consumes:
budget fields (absent on Pro/Max; `ledgerAgeMs` is the last good ledger
reading's age while the refresher fails, else null), `capSource`, `extraUsage` (Pro/Max only),
resolved `rateLimits` with their `source` and `readingAt`, `runway` per window,
`coach` (top finding except R8: `{ id, title, action, usd, window }`), `rateLimitsCache` (old shims),
`spendLimitPct`, `spendLimitUsd` (`{ used, limit, period }` or null),
`apiDetail` (fresh API windows with dollars, severity and extra windows; null
when stale), `cache` (a `CacheForecast`), `hasSpendCap`, `planType`.

## Managed-file markers

| Marker                         | Meaning                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `// cc-spend:managed v<8-hex>` | full managed shim; the hash covers the template **and** the stamped entry URL, so a moved package re-installs |
| `// cc-spend:capture v1`       | capture-only line injected into a foreign script                                                              |

Never hand-edit `~/.claude/statusline.mjs`; edit `assets/statusline.mjs` and
re-run `cc-spend statusline`.
