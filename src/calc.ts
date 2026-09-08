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

function sumDaysBefore(usage: UsageState, isoDate: string): number {
  return Object.entries(usage.days)
    .filter(([day]) => day < isoDate)
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
 * Walks every UTC calendar date strictly after usage.lastUpdated up to (not including) nowUtc's date,
 * freezing each laboral day's final derived amount into usage.days. Also freezes today's avgPerDay/
 * safeMonthTotal exactly once per UTC day (decision 24) — the moment nowUtc's date differs from
 * usage.frozenForDate, using monthlySpent as it stands at that instant, before today's own spend accrues.
 * Idempotent: calling it again the same UTC day is a no-op beyond refreshing lastUpdated's timestamp.
 */
export function rolloverIfNeeded(usage: UsageState, config: Config, nowUtc: Date): UsageState {
  const lastDate = new Date(usage.lastUpdated);
  const today = utcDateString(nowUtc);

  if (utcDateString(lastDate) !== today) {
    let cursor = addUtcDays(lastDate, 1);
    while (utcDateString(cursor) < today) {
      const isoCursor = utcDateString(cursor);
      const laboralDays = getLaboralDays(config, cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
      if (laboralDays.includes(cursor.getUTCDate()) && usage.days[isoCursor] === undefined) {
        usage.days[isoCursor] = Math.max(0, usage.monthlySpent - sumDaysBefore(usage, isoCursor));
      }
      cursor = addUtcDays(cursor, 1);
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
 */
export function captureSessionCost(
  usage: UsageState,
  sessionId: string,
  currentCost: number,
  nowUtc: Date,
): UsageState {
  const prior = usage.sessions[sessionId];
  const delta =
    prior && currentCost >= prior.lastSeenCost ? currentCost - prior.lastSeenCost : currentCost;
  usage.monthlySpent += Math.max(0, delta);
  usage.sessions[sessionId] = { lastSeenCost: currentCost, lastSeenAt: nowUtc.toISOString() };
  pruneStaleSessions(usage, nowUtc);
  return usage;
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
  const laboralDaysThisMonth = getLaboralDays(
    config,
    nowUtc.getUTCFullYear(),
    nowUtc.getUTCMonth() + 1,
  );
  const remainingLaboralDays = remainingLaboralDaysCount(laboralDaysThisMonth, nowUtc.getUTCDate());

  const avgPerDay = usage.frozenAvgPerDay;
  const safeMonthTotal = usage.frozenSafeMonthTotal;
  const todayUsage = Math.max(0, usage.monthlySpent - sumDaysBefore(usage, today));
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
    remainingLaboralDays,
  };
}

export function colorForPct(pct: number): string {
  if (pct >= 1) return "#F8696B";
  if (pct >= 0.75) return "#F4A460";
  if (pct >= 0.5) return "#FFEB84";
  if (pct >= 0.25) return "#A1D76A";
  return "#63BE7B";
}

/** Report-only: the zero-spent theoretical avg, NOT the live/frozen avgPerDay above. */
export function theoreticalAvgFromDayOne(
  config: Config,
  year: number,
  month: number,
): number | null {
  const totalDays = getLaboralDays(config, year, month).length;
  if (totalDays === 0) return null;
  return Math.ceil((config.monthlyCap / totalDays) * 100) / 100;
}
