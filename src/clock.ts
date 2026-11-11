/**
 * The two clocks (see adrs/2026-10-10-two-clock-day-model.md):
 * - Days are LOCAL: `usage.days` keys, laboral membership, "today", the calendar's today/past split.
 * - The budget period is the UTC calendar month: Anthropic's ledger (and its monthly_limit) resets there.
 * Every helper is pure and reads the process time zone through the Date local-time getters only.
 */

export interface YearMonth {
  readonly year: number;
  readonly month: number; // 1-12
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local calendar date "YYYY-MM-DD" of an instant. */
export function localDateKey(date: Date): string {
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function localYearMonth(date: Date): YearMonth {
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

/** The budget period an instant falls in: its UTC calendar month. */
export function utcPeriod(date: Date): YearMonth {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export function yearMonthKey(value: YearMonth): string {
  return `${String(value.year)}-${pad2(value.month)}`;
}

/** Negative when `a` is before `b`, 0 when equal, positive after. */
export function compareYearMonth(a: YearMonth, b: YearMonth): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month);
}

/** First local midnight strictly after `date`. The Date constructor resolves DST gaps (23h/25h days). */
export function nextLocalMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
}

/** First UTC month start strictly after `date` — the next ledger reset. */
export function nextUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday-to-Friday days of a month — the default laboral set `init` offers. */
export function weekdaysOf(year: number, month: number): ReadonlyArray<number> {
  const days: Array<number> = [];
  for (let day = 1; day <= daysInMonth(year, month); day++) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(day);
  }
  return days;
}

/** The month after `value`. */
export function nextYearMonth(value: YearMonth): YearMonth {
  return value.month === 12
    ? { year: value.year + 1, month: 1 }
    : { year: value.year, month: value.month + 1 };
}
