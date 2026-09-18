export interface ComputedUsage {
  readonly monthlyCap: number;
  readonly monthlySpent: number; // live — changes every capture, within the same day too
  readonly leftThisMonth: number; // MAX(0, cap - monthlySpent) — live, same reason
  readonly avgPerDay: number | null; // FROZEN for the day — usage.frozenAvgPerDay, verbatim
  readonly safeMonthTotal: number | null; // FROZEN for the day — usage.frozenSafeMonthTotal, verbatim
  readonly todayUsage: number; // monthlySpent - sum(days strictly before today) — live
  readonly todayUsedPct: number | null; // todayUsage / avgPerDay — live numerator, frozen denominator
  readonly monthUsedPct: number; // monthlySpent / monthlyCap — live
  readonly paceLabel: string | null; // Coast…Burn from todayUsedPct; null when no pace
  readonly monthDay0AvgPerDay: number | null; // first equal-split daily max this month
  readonly realAvgPerDay: number | null; // monthlySpent / elapsed laboral days (day <= today)
}

export interface StatuslineJson {
  readonly todayUsage: number;
  readonly avgPerDay: number | null;
  readonly todayUsedPct: number | null;
  readonly monthlySpent: number;
  readonly monthlyCap: number;
  readonly monthUsedPct: number;
}
