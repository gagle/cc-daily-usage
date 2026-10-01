export interface Config {
  readonly monthlyCap: number;
  readonly laboralDays: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<number>>>>>;
  // outer key = year as string ("2026"), inner key = month 1-12 as string ("9"), value = day-of-month array
  // Both fields below are cached here — see runStatuslineHidden in cli.ts. undefined = not yet resolved.
  readonly planType?: string | null; // verbatim ~/.claude.json oauthAccount.organizationType; null = no OAuth account
  readonly hasSpendCap?: boolean; // whether this tool's fabricated dollar monthlyCap budget runs. Independent
  // of seat-window rate_limits (Pro/Max/Team/Enterprise all have 5h/7d seats). organizationType wins when
  // known; rate_limits may demote an unrecognized org's true guess to false, never a known enterprise/team.
}

export interface SessionCost {
  lastSeenCost: number; // Claude Code's own cost.total_cost_usd, last time this session was seen
  lastSeenAt: string; // UTC ISO-8601 — drives the 2-day pruning in pruneStaleSessions
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
}

export interface UsageState {
  monthlySpent: number;
  lastUpdated: string; // UTC ISO-8601, e.g. "2026-09-04T23:55:00.000Z"
  days: Record<string, number>; // ISO date "YYYY-MM-DD" -> frozen $ amount
  sessions: Record<string, SessionCost>; // sessionId -> last-seen cost, per-session delta capture
  extraUsageCache?: ExtraUsageCacheEntry; // short-TTL cache around the live /api/oauth/usage fetch
  rateLimitsCache?: RateLimitsCache; // last-seen Claude Code hook rate_limits, for the render(s) at session
  // start before Claude Code has attached a fresh one — see runStatuslineHidden in cli.ts
  ledgerBaseline?: number; // Anthropic ledger reading at this month's start; monthlySpent = used_credits - baseline
}

export const DEFAULT_CONFIG: Config = { monthlyCap: 200, laboralDays: {} };

export const DEFAULT_USAGE: UsageState = {
  monthlySpent: 0,
  lastUpdated: new Date(0).toISOString(),
  days: {},
  sessions: {},
};
