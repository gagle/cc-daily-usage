import {
  compareYearMonth,
  localDateKey,
  localYearMonth,
  nextLocalMidnight,
  nextUtcMonthStart,
  utcPeriod,
  type YearMonth,
  yearMonthKey,
} from "./clock.js";
import type { ComputedUsage } from "./interfaces/calc.interface.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";

export const USAGE_SCHEMA_VERSION = 2;

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWO_DAYS_MS = 48 * ONE_HOUR_MS;
/** Local days of API-equivalent and miss-cause history kept: two months covers "month to date" and 30 d. */
export const DAY_HISTORY_DAYS = 62;

export function getLaboralDays(config: Config, year: number, month: number): ReadonlyArray<number> {
  return config.laboralDays[String(year)]?.[String(month)] ?? [];
}

/** True when `date`'s LOCAL day-of-month is listed in that local month's laboralDays. */
export function isLaboralDay(config: Config, date: Date): boolean {
  const { year, month } = localYearMonth(date);
  return getLaboralDays(config, year, month).includes(date.getDate());
}

export function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** A brand-new usage file. `lastUpdated = now` so the first rollover has nothing to walk. */
export function freshUsage(now: Date): UsageState {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    monthlySpent: 0,
    periodFrozen: 0,
    lastUpdated: now.toISOString(),
    days: {},
    sessions: {},
    apiEqDays: {},
    apiEqTotal: 0,
    missCauses: {},
  };
}

/**
 * Brings a parsed usage.json up to the current schema, in place. v1 files (UTC day keys, no periodFrozen)
 * keep their day keys as-is — at most one day of drift on old history, see the two-clock ADR — and
 * periodFrozen is derived the way v1 computed "days before today". A missing/garbled lastUpdated becomes
 * `now`, so a corrupt timestamp can never trigger a walk from 1970.
 */
export function upgradeUsage(usage: Partial<UsageState>, now: Date): UsageState {
  const parsed = new Date(usage.lastUpdated ?? Number.NaN);
  const valid = !Number.isNaN(parsed.getTime()) && parsed.getTime() <= now.getTime();
  const lastUpdated = valid ? parsed : now;
  usage.lastUpdated = lastUpdated.toISOString();
  const days = (usage.days ??= {});
  usage.sessions ??= {};
  usage.apiEqDays ??= {};
  usage.missCauses ??= {};
  if (typeof usage.apiEqTotal !== "number" || !Number.isFinite(usage.apiEqTotal)) {
    usage.apiEqTotal = 0;
  }
  if (typeof usage.monthlySpent !== "number" || !Number.isFinite(usage.monthlySpent)) {
    usage.monthlySpent = 0;
  }
  if (typeof usage.periodFrozen !== "number") {
    const prefix = yearMonthKey(utcPeriod(lastUpdated));
    const before = utcDateString(lastUpdated);
    usage.periodFrozen = Object.entries(days)
      .filter(([day]) => day.startsWith(prefix) && day < before)
      .reduce((total, [, amount]) => total + amount, 0);
  }
  usage.schemaVersion = USAGE_SCHEMA_VERSION;
  return usage as UsageState;
}

/** Laboral days of `period` that are still ahead of (or are) local today. Local today before the period
 * (UTC− zones in the hours after the UTC edge) → the whole month; after it (UTC+ zones in the hours
 * before the UTC edge) → none. */
function remainingLaboralDaysCount(config: Config, period: YearMonth, now: Date): number {
  const days = getLaboralDays(config, period.year, period.month);
  const relation = compareYearMonth(localYearMonth(now), period);
  if (relation < 0) return days.length;
  if (relation > 0) return 0;
  const today = now.getDate();
  return days.filter((day) => day >= today).length;
}

/** Laboral days of `period` already reached (day <= local today), mirror of the above. */
function elapsedLaboralDaysCount(config: Config, period: YearMonth, now: Date): number {
  const days = getLaboralDays(config, period.year, period.month);
  const relation = compareYearMonth(localYearMonth(now), period);
  if (relation < 0) return 0;
  if (relation > 0) return days.length;
  const today = now.getDate();
  return days.filter((day) => day <= today).length;
}

/**
 * Actual $/laboral-day so far: monthlySpent ÷ laboral days reached in the current budget period.
 * Distinct from computeAvgPerDay (remaining budget ÷ remaining laboral days).
 */
export function computeRealAvgPerDay(
  config: Config,
  monthlySpent: number,
  now: Date,
): number | null {
  const elapsed = elapsedLaboralDaysCount(config, utcPeriod(now), now);
  if (elapsed === 0) return null;
  return Math.round((monthlySpent / elapsed) * 100) / 100;
}

/** Ceil-to-cent share of `cap - spent` over `remaining` laboral days; null when none remain. */
function splitCap(cap: number, spent: number, remaining: number): number | null {
  if (remaining === 0) return null;
  return Math.max(0, Math.ceil(((cap - spent) / remaining) * 100) / 100);
}

/**
 * Today's max: (monthlyCap - spend frozen before today in this period) ÷ laboral days from today onward.
 * Derived, never stored: both inputs are fixed for the whole local day (today's own spend is excluded), so it
 * is stable through the day, follows a monthlyCap change at once, and an off-day's spend lowers the next
 * laboral day. Removing a laboral day re-splits the same remainder over fewer days. 0 = budget exhausted;
 * null = no laboral day remains in this period.
 */
export function computeAvgPerDay(config: Config, usage: UsageState, now: Date): number | null {
  const remaining = remainingLaboralDaysCount(config, utcPeriod(now), now);
  return splitCap(config.monthlyCap, usage.periodFrozen, remaining);
}

/** Spend captured since the last freeze — the live "today" portion of this period. */
function pendingSpend(usage: UsageState): number {
  return Math.max(0, usage.monthlySpent - usage.periodFrozen);
}

function addToDay(usage: UsageState, day: string, amount: number): void {
  usage.days[day] = (usage.days[day] ?? 0) + amount;
}

/**
 * Settles every boundary between usage.lastUpdated and now. O(1): all spend since the last freeze was
 * captured at or before lastUpdated, so only the FIRST local midnight and the LATEST UTC month edge can
 * carry money; the days in between got no captures and stay absent ("—" in the calendar, not a fake $0).
 * - Local midnight: pending spend freezes into lastUpdated's local day and counts as frozen in the period.
 * - UTC month edge (ledger reset): pending spend that the midnight did not take is booked on the local day
 *   containing the edge, then monthlySpent/periodFrozen reset and ledgerBaseline takes the last ledger
 *   reading (so a ledger that did not reset still yields this period's spend — see applyLedgerReading).
 * When both fall on the same instant (a UTC machine) the day freezes first, so it belongs to the old period.
 * Idempotent within a local day.
 */
export function rolloverIfNeeded(
  usage: UsageState,
  now: Date,
  lastLedgerReading: number | null,
): UsageState {
  const last = new Date(usage.lastUpdated);
  const midnight = nextLocalMidnight(last);
  const edge = nextUtcMonthStart(last);

  const crossedMidnight = midnight.getTime() <= now.getTime();
  const crossedEdge = edge.getTime() <= now.getTime();
  if (crossedMidnight && midnight.getTime() <= edge.getTime()) {
    const pending = pendingSpend(usage);
    addToDay(usage, localDateKey(last), pending);
    usage.periodFrozen += pending;
  }
  if (crossedEdge) {
    const pending = pendingSpend(usage);
    if (pending > 0) addToDay(usage, localDateKey(new Date(edge.getTime() - 1)), pending);
    usage.monthlySpent = 0;
    usage.periodFrozen = 0;
    usage.ledgerBaseline = lastLedgerReading ?? 0;
    // A midnight after the edge (UTC− zones) has nothing left to freeze: pending is now 0.
  }

  // Only a crossed boundary moves lastUpdated: within one local day and period every later call computes the
  // same result from the older value, and leaving it alone lets saveUsage skip no-op writes.
  if (crossedMidnight || crossedEdge) usage.lastUpdated = now.toISOString();
  return usage;
}

/**
 * Folds Anthropic's cumulative `extra_usage.used_credits` into monthlySpent. A reading below
 * ledgerBaseline means the ledger reset (new billing month), so the baseline drops to 0.
 * # ponytail: assumes the ledger resets on the UTC calendar month; if its cycle differs the budget month is
 * wrong — fix by moving the period edge to the observed reset date.
 */
export function applyLedgerReading(usage: UsageState, usedCredits: number, now: Date): UsageState {
  const baseline = usedCredits < (usage.ledgerBaseline ?? 0) ? 0 : (usage.ledgerBaseline ?? 0);
  usage.ledgerBaseline = baseline;
  usage.monthlySpent = usedCredits - baseline;

  // The ledger is the truth: frozen days summing above it were over-counted (phantom session spend), and
  // would pin todayUsage at 0 until the ledger caught up. Scale them down proportionally to fit.
  // # ponytail: proportional split is a guess at which days were inflated, and only this period's local
  // month is rescaled (an edge day in the neighbour month keeps its amount); exact fix needs a per-day ledger.
  if (usage.periodFrozen > usage.monthlySpent) {
    const factor = usage.monthlySpent / usage.periodFrozen; // periodFrozen > monthlySpent ≥ 0
    const prefix = yearMonthKey(utcPeriod(now));
    const today = localDateKey(now);
    for (const [day, amount] of Object.entries(usage.days)) {
      if (day.startsWith(prefix) && day < today) usage.days[day] = amount * factor;
    }
    usage.periodFrozen = usage.monthlySpent;
  }
  return usage;
}

/**
 * Session spend seen after the ledger reading taken at `readAt`, so the month total moves between readings
 * (and while the refresher fails). A new reading restarts the sum at 0: the ledger now holds that spend.
 * Only a known session growing counts — a new or reset session's full cost is the phantom-spend case the
 * ledger exists to avoid. Returns the sum to add to the reading.
 * # ponytail: spend between the reading and the session's next render counts twice for one reading; fix
 * with per-session cost at readAt.
 */
export function addSinceLedger(
  usage: UsageState,
  readAt: number,
  sessionId: string,
  currentCost: number,
): number {
  if (usage.sinceLedger?.readAt !== readAt) usage.sinceLedger = { readAt, usd: 0 };
  const prior = usage.sessions[sessionId];
  if (prior && currentCost > prior.lastSeenCost) {
    usage.sinceLedger.usd += currentCost - prior.lastSeenCost;
  }
  return usage.sinceLedger.usd;
}

/**
 * Per-session capture: the delta since this session id was last seen is folded into monthlySpent.
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
  now: Date,
  accumulate: boolean,
): UsageState {
  const prior = usage.sessions[sessionId];
  const delta =
    prior && currentCost >= prior.lastSeenCost ? currentCost - prior.lastSeenCost : currentCost;
  if (accumulate) usage.monthlySpent += Math.max(0, delta);
  if (delta > 0) addApiEquivalent(usage, delta, now);
  // lastSeenAt only feeds the 2-day prune, so an unchanged cost refreshes it at most hourly (fewer writes).
  const touchDue = !prior || now.getTime() - new Date(prior.lastSeenAt).getTime() >= ONE_HOUR_MS;
  if (!prior || prior.lastSeenCost !== currentCost || touchDue) {
    usage.sessions[sessionId] = {
      ...prior,
      lastSeenCost: currentCost,
      lastSeenAt: now.toISOString(),
    };
  }
  pruneStaleSessions(usage, now);
  return usage;
}

/** `record` without the local day keys older than DAY_HISTORY_DAYS before `now`'s local day. */
function dropOldDays<T>(record: Record<string, T>, now: Date): Record<string, T> {
  const cutoff = localDateKey(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - DAY_HISTORY_DAYS),
  );
  return Object.fromEntries(Object.entries(record).filter(([day]) => day >= cutoff));
}

/**
 * Books a session cost delta as API-equivalent $ on the local day, for every plan. Unlike monthlySpent this
 * is not a bill: on Pro/Max it is what the same tokens would cost on the API. Only sessions that render this
 * statusline are seen. Old days drop when a new day key starts, so the prune runs once a day.
 * # ponytail: a session pruned after 2 idle days and then resumed counts its whole cost again; fix by
 * taking the baseline from sessions-map.json.
 */
export function addApiEquivalent(usage: UsageState, delta: number, now: Date): UsageState {
  const day = localDateKey(now);
  if (usage.apiEqDays[day] === undefined) usage.apiEqDays = dropOldDays(usage.apiEqDays, now);
  usage.apiEqDays[day] = (usage.apiEqDays[day] ?? 0) + delta;
  usage.apiEqTotal += delta;
  return usage;
}

/**
 * Folds one session's cumulative `prompt_cache.miss_causes` counts into today's per-cause totals. The $ of
 * the new misses (`missUsdDelta`, from the session's cacheMissUsd) splits over the causes by their new
 * counts; $ with no counted cause goes to `unknown`. Counts lower than last seen mean a reset (`/clear`):
 * the new counts are all new. Returns the counts to store as the session's next baseline.
 */
export function addMissCauses(
  usage: UsageState,
  prior: Readonly<Record<string, number>> | undefined,
  current: Readonly<Record<string, number>>,
  missUsdDelta: number,
  now: Date,
): Readonly<Record<string, number>> {
  const reset = Object.entries(prior ?? {}).some(([cause, n]) => (current[cause] ?? 0) < n);
  const added: Array<[string, number]> = [];
  for (const [cause, n] of Object.entries(current)) {
    const delta = n - (reset ? 0 : (prior?.[cause] ?? 0));
    if (delta > 0) added.push([cause, delta]);
  }
  const usd = Math.max(0, missUsdDelta);
  if (added.length === 0 && usd === 0) return current;
  const day = localDateKey(now);
  if (usage.missCauses[day] === undefined) usage.missCauses = dropOldDays(usage.missCauses, now);
  const today = (usage.missCauses[day] ??= {});
  const total = added.reduce((sum, [, n]) => sum + n, 0);
  for (const [cause, n] of added) {
    const entry = (today[cause] ??= { count: 0, usd: 0 });
    entry.count += n;
    entry.usd += (usd * n) / total;
  }
  if (added.length === 0) {
    const entry = (today["unknown"] ??= { count: 0, usd: 0 });
    entry.usd += usd;
  }
  return current;
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

/** Drops session entries untouched for 2+ days — keeps usage.sessions from growing forever. */
export function pruneStaleSessions(usage: UsageState, now: Date): UsageState {
  const cutoffMs = now.getTime() - TWO_DAYS_MS;
  const entries = Object.entries(usage.sessions);
  const kept = entries.filter(([, session]) => new Date(session.lastSeenAt).getTime() >= cutoffMs);
  if (kept.length !== entries.length) usage.sessions = Object.fromEntries(kept);
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

/** Caller MUST run rolloverIfNeeded first — never mutates usage. */
export function computeToday(usage: UsageState, config: Config, now: Date): ComputedUsage {
  const period = utcPeriod(now);
  const avgPerDay = computeAvgPerDay(config, usage, now);
  const safeMonthTotal = avgPerDay === null ? null : usage.periodFrozen + avgPerDay;
  // An edge-day booking from the previous period (UTC+ zones, first hours of the local month) is still
  // today's spend, so it shows here; the period's own pending part is what moves monthlySpent.
  const todayUsage = (usage.days[localDateKey(now)] ?? 0) + pendingSpend(usage);
  const todayUsedPct = avgPerDay === null || avgPerDay === 0 ? null : todayUsage / avgPerDay;
  const laboralDays = getLaboralDays(config, period.year, period.month);

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
    realAvgPerDay: computeRealAvgPerDay(config, usage.monthlySpent, now),
  };
}

export function colorForPct(pct: number): string {
  if (pct >= 1) return "#F8696B";
  if (pct >= 0.75) return "#F4A460";
  if (pct >= 0.5) return "#FFEB84";
  if (pct >= 0.25) return "#A1D76A";
  return "#63BE7B";
}
