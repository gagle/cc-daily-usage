# Data model

Field-by-field reference for every persisted type, plus the on-disk layout and
the statusline installer's managed-file markers.

## `Config` (`src/interfaces/config.interface.ts`)

```ts
interface Config {
  monthlyCap: number;
  laboralDays: Record<year, Record<month, number[]>>; // year "2026", month 1-12 as string, value = day-of-month array
  planType?: string | null; // verbatim ~/.claude.json oauthAccount.organizationType; null = no OAuth account
  hasSpendCap?: boolean; // see docs/architecture.md "hasSpendCap branching"
}
```

`DEFAULT_CONFIG = { monthlyCap: 200, laboralDays: {} }`.

## `UsageState`

```ts
interface UsageState {
  monthlySpent: number;
  lastUpdated: string; // UTC ISO-8601
  days: Record<isoDate, number>; // frozen $ amount per completed day
  sessions: Record<sessionId, SessionCost>;
  frozenForDate: string | null; // ISO date the two fields below were frozen for
  frozenAvgPerDay: number | null; // avgPerDay computed once at the start of frozenForDate
  frozenSafeMonthTotal: number | null; // safeMonthTotal computed at the same moment
  extraUsageCache?: ExtraUsageCacheEntry; // short-TTL cache around the live /api/oauth/usage fetch
  extraUsageSnapshot?: ExtraUsageSnapshot; // last cumulative reading, for day-over-day reconciliation
  rateLimitsCache?: RateLimitsCache; // last-seen Claude Code hook rate_limits
  monthDay0AvgPerDay?: number | null; // first equal-split daily max this calendar month
  monthDay0ForMonth?: string | null; // "YYYY-MM" the day-0 max belongs to
}
```

`DEFAULT_USAGE`: `monthlySpent: 0`, `lastUpdated: epoch 0`, everything else empty/null.

**`frozenAvgPerDay`/`frozenSafeMonthTotal` are never live** — see
`docs/calculations.md`'s note on `rolloverIfNeeded`.

## `SessionCost`

```ts
interface SessionCost {
  lastSeenCost: number; // Claude Code's own cost.total_cost_usd, last time this session was seen
  lastSeenAt: string; // UTC ISO-8601 — drives the 2-day pruning in pruneStaleSessions
}
```

## `ExtraUsageSnapshot`

```ts
interface ExtraUsageSnapshot {
  date: string; // ISO date this snapshot was captured on
  usedCredits: number; // cumulative $ (extra_usage.used_credits) at capture time
}
```

## `ExtraUsageCacheEntry`

```ts
interface ExtraUsageCacheEntry {
  fetchedAt: number; // epoch ms
  data: { usedCredits: number; monthlyLimit: number; utilizationPct: number } | null;
}
```

60-second TTL cache around the live `/api/oauth/usage` fetch (`getCachedExtraUsage`
in `anthropic-usage.ts`) — avoids hitting Anthropic's API on every statusline render.

## `RateLimitsCache`

```ts
interface RateLimitsCache {
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  fiveHourResetsAt: number | null; // Unix epoch seconds
  sevenDayResetsAt: number | null; // Unix epoch seconds
}
```

Last-seen Claude Code hook `rate_limits`, used as a fallback for the render(s) at
session start before Claude Code has attached a fresh one.

## On-disk layout

```
~/.config/cc-daily-usage/accounts/<accountKey>/config.json  (mode 0o600)
~/.config/cc-daily-usage/accounts/<accountKey>/usage.json   (mode 0o600)
```

`<accountKey>` = sanitized OAuth email, or `"default"` with no OAuth account, or
`"legacy"` for the one-time migration of pre-multi-account state. See
`docs/architecture.md` "Multi-account model".

## Statusline managed-file markers

`~/.claude/statusline.mjs` (the installed copy of `assets/statusline.mjs`) carries
one of two markers, checked by the installer to decide whether to no-op, upgrade,
or fall back:

| Marker                                    | Meaning                                                                                                    | Written by                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `// cc-daily-usage:managed v<8-hex-hash>` | Full install; hash is a content-hash version of the shipped template                                       | `statusline-install.ts`         |
| `// cc-daily-usage:capture v1`            | Capture-only fallback (session-cost capture injected into an existing script, no full statusline takeover) | `statusline-capture-install.ts` |

Never hand-edit `~/.claude/statusline.mjs` — it is silently overwritten on the
next managed install. Edit `assets/statusline.mjs` (the template) instead.
