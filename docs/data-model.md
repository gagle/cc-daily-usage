# Data model

Types live in `src/interfaces/config.interface.ts` and
`src/interfaces/statusline.interface.ts`.

## On-disk layout

```
~/.config/cc-daily-usage/
  accounts/<accountKey>/config.json      Config — written by init, calendar, hook (plan/cap sync)
  accounts/<accountKey>/usage.json       UsageState — written by every render that changes it
  accounts/<accountKey>/api-cache.json   ApiCache — written ONLY by the --refresh process
  accounts/<accountKey>/refresh.lock     present while a refresher runs (stale after 30 s)
  accounts/<accountKey>/*.corrupt-<ms>   copy of a corrupt file, kept before re-seeding
  profiles.json                          token-hash → Account, for CLAUDE_CODE_OAUTH_TOKEN users
  previous-statusline.json               what install replaced; read by uninstall
  statusline.json                        { rows: PartId[][] } — written by `settings`, read by every render
~/.claude/statusline.mjs                 the managed shim (from assets/statusline.mjs)
~/.claude/settings.json                  statusLine { type, command, refreshInterval 30|1 }, hooks.UserPromptSubmit gate, hooks.PreModelSwitch cost, promptCacheTtl
```

All writes are atomic (temp + rename, mode `0o600`). Missing files are seeded,
corrupt ones quarantined then re-seeded — nothing on this path throws.

## `Config`

| Field              | Meaning                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `monthlyCap`       | $ cap for the period. Overwritten from Anthropic's `monthly_limit` when the ledger reports one (> 0). Default 200. |
| `laboralDays`      | `{ "2026": { "10": [1, 2, 5, …] } }` — year → month (1-12) → local days of month                                   |
| `planType`         | verbatim `organizationType`, `null` without OAuth                                                                  |
| `hasSpendCap`      | whether the dollar budget runs (see `docs/architecture.md`)                                                        |
| `promptGateMinUsd` | block a cold-cache prompt costing at least this; `0` = off; default 1                                              |

## `UsageState` (schema v2)

| Field             | Meaning                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `schemaVersion`   | `2`                                                                                  |
| `monthlySpent`    | spend in the current UTC period                                                      |
| `periodFrozen`    | part of `monthlySpent` frozen into past local days                                   |
| `lastUpdated`     | ISO instant; moves only when a boundary is crossed                                   |
| `days`            | local `YYYY-MM-DD` → frozen $                                                        |
| `sessions`        | session id → `{ lastSeenCost, lastSeenAt, cacheMissUsd?, cacheGate?, gateArmedAt? }` |
| `ledgerBaseline`  | ledger reading at this period's start                                                |
| `rateLimitsCache` | last hook `rate_limits` snapshot + `seenAt`                                          |
| `extraUsageCache` | v1 only; read once as a fallback until `api-cache.json` exists                       |

## `ApiCache`

`{ fetchedAt, extraUsage, fiveHour, sevenDay, stale? }`. `extraUsage` holds the
usage-credits ledger in dollars (`decimal_places` applied); windows are
`{ pct 0-100, resetsAt epoch s }`. A failed fetch keeps the previous reading
with `stale: true`. TTL 60 s (`API_CACHE_TTL_MS` in `src/anthropic-usage.ts`).

## `StatuslineState`

What `cc-daily-usage --statusline` prints and `renderStatusline` consumes:
budget fields (absent on Pro/Max), `capSource`, `extraUsage` (Pro/Max only),
resolved `rateLimits` with their `source`, `rateLimitsCache` (old shims),
`spendLimitPct`, `cache` (a `CacheForecast`), `hasSpendCap`, `planType`.

## Managed-file markers

| Marker                               | Meaning                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `// cc-daily-usage:managed v<8-hex>` | full managed shim; the hash covers the template **and** the stamped entry URL, so a moved package re-installs |
| `// cc-daily-usage:capture v1`       | capture-only line injected into a foreign script                                                              |

Never hand-edit `~/.claude/statusline.mjs`; edit `assets/statusline.mjs` and
re-run `cc-daily-usage statusline`.
