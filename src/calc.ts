import type { ComputedUsage } from "./interfaces/calc.interface.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";

export function getLaboralDays(config: Config, year: number, month: number): ReadonlyArray<number> {
  return config.laboralDays[String(year)]?.[String(month)] ?? [];
}

export function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

// Scoped to isoDate's own calendar month: monthlySpent resets to 0 at each month boundary (see
// rolloverIfNeeded below), so summing across a month boundary would double-count/underflow.
function sumDaysBeforeInMonth(usage: UsageState, isoDate: string): number {
  const monthPrefix = isoDate.slice(0, 7); // "YYYY-MM"
  return Object.entries(usage.days)
    .filter(([day]) => day.startsWith(monthPrefix) && day < isoDate)
    .reduce((total, [, amount]) => total + amount, 0);
}

/** Days in `days` that are `>= fromDay` (inclusive) — Excel's COUNTIF(">="&DAY(TODAY())) port. */
function remainingLaboralDaysCount(days: ReadonlyArray<number>, fromDay: number): number {
  return days.filter((day) => day >= fromDay).length;
}

function computeAvgPerDay(config: Config, monthlySpent: number, remaining: number): number | null {
  if (remaining === 0) return null;
  return Math.max(0, Math.ceil(((config.monthlyCap - monthlySpent) / remaining) * 100) / 100);
}

/**
 * Walks every UTC calendar date from usage.lastUpdated's own day up to (not including) nowUtc's date,
 * freezing each day's final derived amount into usage.days — including lastUpdated's day itself, since that
 * day's spend is fully settled by the time nowUtc rolls onto a new date (its own capture already happened
 * before this call). Every day gets frozen, laboral or not — laboral-day membership only ever affects the
 * avgPerDay pace math (getLaboralDays/remainingLaboralDaysCount below), never which days get real spend
 * recorded. Also resets monthlySpent to 0 the moment the walk crosses into a new calendar month — Claude
 * Code's own usage windows reset monthly, so ours must too; the outgoing month's last day is frozen first
 * (using its pre-reset total), so nothing is lost. Also freezes today's avgPerDay/safeMonthTotal exactly
 * once per UTC day (decision 24) — the moment nowUtc's date differs from usage.frozenForDate, using
 * monthlySpent as it stands at that instant, before today's own spend accrues. Idempotent: calling it again
 * the same UTC day is a no-op beyond refreshing lastUpdated's timestamp.
 */
export function rolloverIfNeeded(usage: UsageState, config: Config, nowUtc: Date): UsageState {
  const lastDate = new Date(usage.lastUpdated);
  const today = utcDateString(nowUtc);

  if (utcDateString(lastDate) !== today) {
    let cursor = lastDate;
    while (utcDateString(cursor) < today) {
      const isoCursor = utcDateString(cursor);
      if (usage.days[isoCursor] === undefined) {
        usage.days[isoCursor] = Math.max(
          0,
          usage.monthlySpent - sumDaysBeforeInMonth(usage, isoCursor),
        );
      }
      const next = addUtcDays(cursor, 1);
      if (next.getUTCMonth() !== cursor.getUTCMonth()) {
        usage.monthlySpent = 0;
      }
      cursor = next;
    }
  }

  usage.lastUpdated = nowUtc.toISOString();

  if (usage.frozenForDate !== today) {
    const laboralDaysThisMonth = getLaboralDays(
      config,
      nowUtc.getUTCFullYear(),
      nowUtc.getUTCMonth() + 1,
    );
    const remaining = remainingLaboralDaysCount(laboralDaysThisMonth, nowUtc.getUTCDate());
    const avgPerDay = computeAvgPerDay(config, usage.monthlySpent, remaining);
    usage.frozenAvgPerDay = avgPerDay;
    usage.frozenSafeMonthTotal = avgPerDay === null ? null : avgPerDay + usage.monthlySpent;
    usage.frozenForDate = today;
  }

  return usage;
}

/**
 * Per-session capture (§18-19): the delta since this session id was last seen is folded into monthlySpent.
 * A currentCost lower than the prior lastSeenCost means the session reset (e.g. `/clear`), treated as a
 * fresh baseline rather than a negative delta. Concurrently-running sessions never corrupt each other's
 * totals because each session id has its own independent lastSeenCost.
 *
 * `accumulate` gates whether the delta is folded into monthlySpent at all: pass `false` while the
 * currently-resolved account is not a dollar-cap (enterprise) plan, so a mid-session pro/enterprise
 * switch never mis-attributes cost across plan types. The lastSeenCost baseline still advances every
 * call regardless, so a later switch back to enterprise only charges the cost accrued after the resume.
 */
export function captureSessionCost(
  usage: UsageState,
  sessionId: string,
  currentCost: number,
  nowUtc: Date,
  accumulate: boolean,
): UsageState {
  const prior = usage.sessions[sessionId];
  const delta =
    prior && currentCost >= prior.lastSeenCost ? currentCost - prior.lastSeenCost : currentCost;
  if (accumulate) usage.monthlySpent += Math.max(0, delta);
  usage.sessions[sessionId] = { lastSeenCost: currentCost, lastSeenAt: nowUtc.toISOString() };
  pruneStaleSessions(usage, nowUtc);
  return usage;
}

/**
 * Maps a Claude Code `organizationType` (from ~/.claude.json's oauthAccount) to the dollar-cap
 * classification, available at session start before any `rate_limits` hook data exists. Unknown or
 * absent org types return undefined so the caller can fall back to the rate_limits-based guess/self-heal.
 */
export function classifyHasSpendCap(organizationType: string | null): boolean | undefined {
  if (organizationType === "claude_enterprise") return true;
  if (organizationType === "claude_pro") return false;
  return undefined;
}

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

/** Drops session entries untouched for 2+ UTC days — keeps usage.sessions from growing forever. */
export function pruneStaleSessions(usage: UsageState, nowUtc: Date): UsageState {
  const cutoffMs = nowUtc.getTime() - TWO_DAYS_MS;
  usage.sessions = Object.fromEntries(
    Object.entries(usage.sessions).filter(
      ([, session]) => new Date(session.lastSeenAt).getTime() >= cutoffMs,
    ),
  );
  return usage;
}

/**
 * Direct port of Panel B2/B3/B4/B5/C5, with one deliberate deviation from the xlsx's literal "live" formula
 * (decision 24): avgPerDay/safeMonthTotal are read straight off usage.frozenAvgPerDay/frozenSafeMonthTotal,
 * never recomputed here. Caller MUST run rolloverIfNeeded first — computeToday itself never mutates usage.
 */
export function computeToday(usage: UsageState, config: Config, nowUtc: Date): ComputedUsage {
  const today = utcDateString(nowUtc);

  const avgPerDay = usage.frozenAvgPerDay;
  const safeMonthTotal = usage.frozenSafeMonthTotal;
  const todayUsage = Math.max(0, usage.monthlySpent - sumDaysBeforeInMonth(usage, today));
  const todayUsedPct = avgPerDay === null || avgPerDay === 0 ? null : todayUsage / avgPerDay;

  return {
    monthlyCap: config.monthlyCap,
    monthlySpent: usage.monthlySpent,
    leftThisMonth: Math.max(0, config.monthlyCap - usage.monthlySpent),
    avgPerDay,
    safeMonthTotal,
    todayUsage,
    todayUsedPct,
    monthUsedPct: config.monthlyCap === 0 ? 0 : usage.monthlySpent / config.monthlyCap,
  };
}

/**
 * Anthropic's own cumulative `extra_usage.used_credits` (see anthropic-usage.ts) is more trustworthy than
 * our own session cost-delta summation — it's the server-side ledger, ours can drift. Called once per
 * `--statusline` invocation, after a fresh extraUsage fetch: if a snapshot from a PRIOR UTC day exists, the
 * delta between it and today's cumulative total is that prior day's true spend — overwrite
 * `usage.days[priorDate]` (and `monthlySpent`) with it when it disagrees with the self-tracked figure.
 * Purely additive: a no-op on the very first call (no prior snapshot yet) and never touches today's own
 * still-accruing figure. Mutates `usage` in place, matching rolloverIfNeeded/captureSessionCost.
 */
export function reconcileFromExtraUsageSnapshot(
  usage: UsageState,
  extraUsage: { usedCredits: number } | null,
  nowUtc: Date,
): UsageState {
  if (extraUsage === null) return usage;
  const today = utcDateString(nowUtc);
  const prior = usage.extraUsageSnapshot;

  if (prior && prior.date !== today) {
    const trueAmount = Math.max(0, extraUsage.usedCredits - prior.usedCredits);
    const selfTracked = usage.days[prior.date];
    if (selfTracked !== undefined && Math.abs(selfTracked - trueAmount) > 0.005) {
      usage.monthlySpent += trueAmount - selfTracked;
      usage.days[prior.date] = trueAmount;
    }
  }

  if (!prior || prior.date !== today) {
    usage.extraUsageSnapshot = { date: today, usedCredits: extraUsage.usedCredits };
  }

  return usage;
}

export function colorForPct(pct: number): string {
  if (pct >= 1) return "#F8696B";
  if (pct >= 0.75) return "#F4A460";
  if (pct >= 0.5) return "#FFEB84";
  if (pct >= 0.25) return "#A1D76A";
  return "#63BE7B";
}
