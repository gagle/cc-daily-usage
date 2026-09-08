export interface Config {
  readonly monthlyCap: number;
  readonly laboralDays: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<number>>>>>;
  // outer key = year as string ("2026"), inner key = month 1-12 as string ("9"), value = day-of-month array
}

export interface SessionCost {
  lastSeenCost: number; // Claude Code's own cost.total_cost_usd, last time this session was seen
  lastSeenAt: string; // UTC ISO-8601 — drives the 2-day pruning in pruneStaleSessions
}

export interface UsageState {
  monthlySpent: number;
  lastUpdated: string; // UTC ISO-8601, e.g. "2026-09-04T23:55:00.000Z"
  days: Record<string, number>; // ISO date "YYYY-MM-DD" -> frozen $ amount
  sessions: Record<string, SessionCost>; // sessionId -> last-seen cost, per-session delta capture
  frozenForDate: string | null; // ISO date the two fields below were frozen for
  frozenAvgPerDay: number | null; // avgPerDay as computed once at the start of frozenForDate; never live
  frozenSafeMonthTotal: number | null; // safeMonthTotal as computed at the same moment; never live
}

export const DEFAULT_CONFIG: Config = { monthlyCap: 200, laboralDays: {} };

export const DEFAULT_USAGE: UsageState = {
  monthlySpent: 0,
  lastUpdated: new Date(0).toISOString(),
  days: {},
  sessions: {},
  frozenForDate: null,
  frozenAvgPerDay: null,
  frozenSafeMonthTotal: null,
};
