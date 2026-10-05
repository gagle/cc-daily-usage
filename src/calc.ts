import type { ComputedUsage } from "./interfaces/calc.interface.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";

export function getLaboralDays(config: Config, year: number, month: number): ReadonlyArray<number> {
  return config.laboralDays[String(year)]?.[String(month)] ?? [];
}

/** True when `date`'s UTC day-of-month is listed in that month's laboralDays. */
export function isLaboralDay(config: Config, date: Date): boolean {
  const days = getLaboralDays(config, date.getUTCFullYear(), date.getUTCMonth() + 1);
  return days.includes(date.getUTCDate());
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

/** Laboral days in `days` with `day <= throughDay` (inclusive) — elapsed work days so far this month. */
function elapsedLaboralDaysCount(days: ReadonlyArray<number>, throughDay: number): number {
  return days.filter((day) => day <= throughDay).length;
}

/**
 * Actual $/laboral-day so far: monthlySpent ÷ count of laboral days with day ≤ today.
 * Distinct from computeAvgPerDay (remaining budget ÷ remaining laboral days).
 */
export function computeRealAvgPerDay(
  config: Config,
  monthlySpent: number,
  nowUtc: Date,
): number | null {
  const laboralDays = getLaboralDays(config, nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() + 1);
  const elapsed = elapsedLaboralDaysCount(laboralDays, nowUtc.getUTCDate());
  if (elapsed === 0) return null;
  return Math.round((monthlySpent / elapsed) * 100) / 100;
}

/** Ceil-to-cent share of `cap - spent` over `remaining` laboral days; null when none remain. */
function splitCap(cap: number, spent: number, remaining: number): number | null {
  if (remaining === 0) return null;
  return Math.max(0, Math.ceil(((cap - spent) / remaining) * 100) / 100);
}

/**
 * Today's max: (monthlyCap - sum of days before today) ÷ laboral days from today onward. Derived, never
 * stored: both inputs are fixed for the whole UTC day (today's own spend is excluded), so it is stable
 * through the day, follows a monthlyCap change at once, and a weekend's spend lowers the next laboral day.
 * 0 means the budget is exhausted; null means no laboral day remains.
 */
export function computeAvgPerDay(config: Config, usage: UsageState, nowUtc: Date): number | null {
  const laboralDays = getLaboralDays(config, nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() + 1);
  const remaining = remainingLaboralDaysCount(laboralDays, nowUtc.getUTCDate());
  return splitCap(config.monthlyCap, sumDaysBeforeInMonth(usage, utcDateString(nowUtc)), remaining);
}

/**
 * Walks every UTC calendar date from usage.lastUpdated's own day up to (not including) nowUtc's date,
 * freezing each day's final derived amount into usage.days — including lastUpdated's day itself, since that
 * day's spend is fully settled by the time nowUtc rolls onto a new date (its own capture already happened
 * before this call). Every day gets frozen, laboral or not — laboral-day membership only ever affects the
 * avgPerDay pace math (getLaboralDays/remainingLaboralDaysCount above), never which days get real spend
 * recorded. Also resets monthlySpent to 0 the moment the walk crosses into a new calendar month — Claude
 * Code's own usage windows reset monthly, so ours must too; the outgoing month's last day is frozen first
 * (using its pre-reset total), so nothing is lost. At that crossing ledgerBaseline takes the last ledger
 * reading, so a ledger that did not reset still yields this month's spend (see applyLedgerReading).
 * Idempotent: calling it again the same UTC day is a no-op beyond refreshing lastUpdated's timestamp.
 */
export function rolloverIfNeeded(usage: UsageState, nowUtc: Date): UsageState {
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
        usage.ledgerBaseline = usage.extraUsageCache?.data?.usedCredits ?? 0;
      }
      cursor = next;
    }
  }

  usage.lastUpdated = nowUtc.toISOString();
  return usage;
}

/**
 * Folds Anthropic's cumulative `extra_usage.used_credits` into monthlySpent. A reading below
 * ledgerBaseline means the ledger reset (new billing month), so the baseline drops to 0.
 * # ponytail: assumes the ledger resets on the UTC calendar month; if its cycle differs the budget month is
 * wrong — fix by moving the month edge to the observed reset date.
 */
export function applyLedgerReading(
  usage: UsageState,
  usedCredits: number,
  nowUtc: Date,
): UsageState {
  const baseline = usedCredits < (usage.ledgerBaseline ?? 0) ? 0 : (usage.ledgerBaseline ?? 0);
  usage.ledgerBaseline = baseline;
  usage.monthlySpent = usedCredits - baseline;

  // The ledger is the truth: frozen days summing above it were over-counted (phantom session spend), and
  // would pin todayUsage at 0 until the ledger caught up. Scale them down proportionally to fit.
  // # ponytail: proportional split is a guess at which days were inflated; exact fix needs a per-day ledger reading.
  const today = utcDateString(nowUtc);
  const frozenSum = sumDaysBeforeInMonth(usage, today);
  if (frozenSum > usage.monthlySpent) {
    const factor = usage.monthlySpent / frozenSum;
    const monthPrefix = today.slice(0, 7);
    usage.days = Object.fromEntries(
      Object.entries(usage.days).map(([day, amount]) => [
        day,
        day.startsWith(monthPrefix) && day < today ? amount * factor : amount,
      ]),
    );
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
 * Maps a Claude Code `organizationType` (from ~/.claude.json's oauthAccount) to whether this tool's
 * fabricated dollar monthlyCap / laboralDays budget should run. Independent of seat-window `rate_limits`
 * (Pro/Max/Team/Enterprise all have 5h/7d seat allowances per Claude Code docs). Unknown or absent org
 * types return undefined so the caller can fall back to a rate_limits-based guess.
 */
export function classifyHasSpendCap(organizationType: string | null): boolean | undefined {
  if (organizationType === "claude_enterprise" || organizationType === "claude_team") return true;
  if (organizationType === "claude_pro" || organizationType === "claude_max") return false;
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
 * Motivational / warning label for todayUsage / today's max (computeAvgPerDay).
 * Coast ≤25% · Ahead ≤50% · Steady ≤75% · On pace ≤100% · Hot ≤150% · Over ≤200% · Burn >200%.
 */
export function paceLabel(todayUsedPct: number | null): string | null {
  if (todayUsedPct === null) return null;
  if (todayUsedPct <= 0.25) return "Coast";
  if (todayUsedPct <= 0.5) return "Ahead";
  if (todayUsedPct <= 0.75) return "Steady";
  if (todayUsedPct <= 1) return "On pace";
  if (todayUsedPct <= 1.5) return "Hot";
  if (todayUsedPct <= 2) return "Over";
  return "Burn";
}

/** Direct port of Panel B2/B3/B4/B5/C5. Caller MUST run rolloverIfNeeded first — never mutates usage. */
export function computeToday(usage: UsageState, config: Config, nowUtc: Date): ComputedUsage {
  const today = utcDateString(nowUtc);
  const daysBefore = sumDaysBeforeInMonth(usage, today);

  const avgPerDay = computeAvgPerDay(config, usage, nowUtc);
  const safeMonthTotal = avgPerDay === null ? null : daysBefore + avgPerDay;
  const todayUsage = Math.max(0, usage.monthlySpent - daysBefore);
  const todayUsedPct = avgPerDay === null || avgPerDay === 0 ? null : todayUsage / avgPerDay;
  const laboralDays = getLaboralDays(config, nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() + 1);

  return {
    monthlyCap: config.monthlyCap,
    monthlySpent: usage.monthlySpent,
    leftThisMonth: Math.max(0, config.monthlyCap - usage.monthlySpent),
    avgPerDay,
    safeMonthTotal,
    todayUsage,
    todayUsedPct,
    monthUsedPct: config.monthlyCap === 0 ? 0 : usage.monthlySpent / config.monthlyCap,
    paceLabel: paceLabel(todayUsedPct),
    monthDay0AvgPerDay: splitCap(config.monthlyCap, 0, laboralDays.length),
    realAvgPerDay: computeRealAvgPerDay(config, usage.monthlySpent, nowUtc),
  };
}

export function colorForPct(pct: number): string {
  if (pct >= 1) return "#F8696B";
  if (pct >= 0.75) return "#F4A460";
  if (pct >= 0.5) return "#FFEB84";
  if (pct >= 0.25) return "#A1D76A";
  return "#63BE7B";
}
