export interface Config {
  readonly monthlyCap: number;
  readonly laboralDays: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<number>>>>>;
  // outer key = year as string ("2026"), inner key = month 1-12 as string ("9"), value = day-of-month array
  // Both fields below are cached here — see runStatuslineHidden in cli.ts. undefined = not yet resolved.
  readonly planType?: string | null; // verbatim ~/.claude.json oauthAccount.organizationType; null = no OAuth account
  readonly promptGateMinUsd?: number; // block a cold-cache prompt costing at least this; 0 = off (default 1)
  readonly snoozed?: Readonly<Record<string, string>>; // coach rule id → ISO time its finding hides until
  readonly hasSpendCap?: boolean; // whether this tool's fabricated dollar monthlyCap budget runs. Independent
  // of seat-window rate_limits (Pro/Max/Team/Enterprise all have 5h/7d seats). organizationType wins when
  // known; rate_limits may demote an unrecognized org's true guess to false, never a known enterprise/team.
}

export interface SessionCost {
  lastSeenCost: number; // Claude Code's own cost.total_cost_usd, last time this session was seen
  lastSeenAt: string; // UTC ISO-8601 — drives the 2-day pruning in pruneStaleSessions
  cacheMissUsd?: number; // API-equivalent $ this session re-paid for prompt-cache misses (see cache-forecast.ts)
  cacheGate?: {
    // Last cache state the statusline saw — read by the UserPromptSubmit gate (prompt-gate.ts).
    readonly expiresAt: number | null; // epoch seconds; null = already cold / unknown
    readonly coldUsd: number | null; // re-cache cost if cold
    readonly warmUsd: number; // the same message with a warm cache
  };
  gateArmedAt?: number; // epoch ms the gate blocked a prompt; a re-submit soon after goes through
  missCounts?: Readonly<Record<string, number>>; // last-seen prompt_cache.miss_causes, for per-day deltas
  promptId?: string; // Claude Code's prompt_id of the prompt being processed
  promptStartCost?: number; // lastSeenCost before that prompt: its cost so far is lastSeenCost − this
  switchedAt?: number; // epoch ms this account took the session over after a `/login` (statusline ⇄ marker)
  switchCost?: number; // cost.total_cost_usd then; until it moves, the hook's rate_limits are the old login's
}

/** $ and count of prompt-cache misses one cause explains on one local day. */
export interface MissCauseDay {
  count: number;
  usd: number;
}

export interface ExtraUsageCacheEntry {
  readonly fetchedAt: number; // epoch ms
  readonly data: {
    readonly usedCredits: number;
    readonly monthlyLimit: number;
    readonly utilizationPct: number;
    readonly currency: string;
    readonly spendLimitReached: boolean;
    readonly disabledReason: string | null;
    readonly stale?: boolean;
  } | null;
}

export interface RateLimitsCache {
  readonly fiveHourPct: number | null;
  readonly sevenDayPct: number | null;
  readonly fiveHourResetsAt: number | null; // Unix epoch seconds
  readonly sevenDayResetsAt: number | null; // Unix epoch seconds
  readonly seenAt?: number; // epoch ms of the hook payload these came from — compared with ApiCache.fetchedAt
}

/** One rate-limit window as read from `/api/oauth/usage`. */
export interface ApiWindow {
  readonly pct: number; // 0-100
  readonly resetsAt: number | null; // Unix epoch seconds
  readonly usedDollars?: number | null; // dollar-metered windows only (null on Pro/Max as of 2026-10)
  readonly limitDollars?: number | null;
  readonly severity?: string | null; // the server's level from `limits[]`; "normal" when nothing to say
}

/** A model or product weekly window beside the main two (`seven_day_opus` → key "opus"). */
export interface ApiExtraWindow extends ApiWindow {
  readonly key: string;
}

/** Plan facts from `/api/oauth/profile`, refreshed at most daily by the refresher (`doctor` shows them). */
export interface ApiPlan {
  readonly fetchedAt: number; // epoch ms
  readonly rateLimitTier: string | null;
  readonly subscriptionStatus: string | null;
  readonly billingType: string | null;
  readonly trialEndsAt: string | null; // ISO
}

/** accounts/<key>/api-cache.json — written ONLY by the detached `--refresh` process (atomic rename), read by
 * every render. Keeping it out of usage.json means a slow network can never block or clobber a render. */
export interface ApiCache {
  readonly fetchedAt: number; // epoch ms of the last attempt
  readonly extraUsage: ExtraUsageCacheEntry["data"]; // null = usage credits off / unknown
  readonly fiveHour: ApiWindow | null;
  readonly sevenDay: ApiWindow | null;
  readonly stale?: boolean; // last attempt failed; fields are the previous good reading
  readonly readAt?: number; // epoch ms of that good reading, set only when stale (else it is fetchedAt)
  readonly failures?: number; // consecutive failed attempts; each doubles the wait before the next
  readonly lastError?: string; // why the last attempt failed ("HTTP 429", "network", "no token"); set only when stale
  readonly retryAt?: number; // epoch ms from the server's Retry-After; no attempt before it (capped at 1 h)
  readonly extraWindows?: ReadonlyArray<ApiExtraWindow>;
  readonly claudeCodeShare?: number | null; // 0-1: Claude Code's part of the 7d window (`seven_day_breakdown`)
  readonly plan?: ApiPlan;
}

export interface UsageState {
  schemaVersion?: number; // 2 = local day keys + periodFrozen (see upgradeUsage in calc.ts)
  monthlySpent: number; // spend in the current budget period (UTC calendar month)
  periodFrozen: number; // part of monthlySpent already frozen into past local days
  lastUpdated: string; // UTC ISO-8601, e.g. "2026-09-04T23:55:00.000Z"
  days: Record<string, number>; // LOCAL date "YYYY-MM-DD" -> frozen $ amount
  sessions: Record<string, SessionCost>; // sessionId -> last-seen cost, per-session delta capture
  extraUsageCache?: ExtraUsageCacheEntry; // v1 only — superseded by api-cache.json, read once as a fallback
  rateLimitsCache?: RateLimitsCache; // last-seen Claude Code hook rate_limits, for the render(s) at session
  // start before Claude Code has attached a fresh one — see runStatuslineHidden in cli.ts
  ledgerBaseline?: number; // Anthropic ledger reading at this month's start; monthlySpent = used_credits - baseline
  sinceLedger?: { readAt: number; usd: number }; // session spend seen after the ledger reading taken at readAt
  apiEqDays: Record<string, number>; // LOCAL date -> API-equivalent $ of every session seen (any plan)
  apiEqTotal: number; // monotone sum of every API-equivalent delta — limit samples difference it
  missCauses: Record<string, Record<string, MissCauseDay>>; // LOCAL date -> cache-miss cause -> count/$
}

/** One rate-limit reading, appended to limits.json only when a % changes. */
export interface LimitSample {
  readonly t: number; // epoch ms
  readonly fiveHourPct: number | null;
  readonly sevenDayPct: number | null;
  readonly fiveHourResetsAt: number | null; // Unix epoch seconds
  readonly sevenDayResetsAt: number | null;
  readonly apiEqTotal: number; // UsageState.apiEqTotal at this reading
  readonly claudeCodeShare?: number | null; // ApiCache.claudeCodeShare at this reading
}

/** accounts/<key>/limits.json — written by the render when a limit % changes. */
export interface LimitsFile {
  readonly schemaVersion: number;
  readonly samples: ReadonlyArray<LimitSample>;
}

/** What the CLI knows about one session beyond the 2-day usage.sessions window. */
export interface SessionMapEntry {
  readonly transcriptPath: string | null;
  readonly firstSeenAt: string; // UTC ISO-8601
  readonly lastSeenAt: string; // UTC ISO-8601 — drives the 35-day prune
  readonly costUsd: number; // Claude Code's cost.total_cost_usd at lastSeenAt
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly name?: string | null; // Claude Code's session_name (`/rename` or the AI title)
  readonly claudeVersion?: string | null; // Claude Code's version as it rendered this session
}

/** accounts/<key>/sessions-map.json — written by the render on a new session, at most hourly after. */
export interface SessionsMapFile {
  readonly schemaVersion: number;
  readonly sessions: Readonly<Record<string, SessionMapEntry>>;
}

export const DEFAULT_CONFIG: Config = { monthlyCap: 200, laboralDays: {} };
