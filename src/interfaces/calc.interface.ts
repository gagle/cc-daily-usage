export interface ComputedUsage {
  readonly monthlyCap: number;
  readonly monthlySpent: number; // live — changes every capture, within the same day too
  readonly leftThisMonth: number; // MAX(0, cap - monthlySpent) — live, same reason
  readonly avgPerDay: number | null; // derived — computeAvgPerDay, stable for the local day
  readonly safeMonthTotal: number | null; // derived — periodFrozen + avgPerDay
  readonly todayUsage: number; // monthlySpent - periodFrozen (+ an edge-day booking) — live
  readonly todayUsedPct: number | null; // todayUsage / avgPerDay — live numerator, per-day denominator
  readonly monthUsedPct: number; // monthlySpent / monthlyCap — live
  readonly paceLabel: string | null; // Coast…Burn from todayUsedPct; null when no pace
  readonly monthDay0AvgPerDay: number | null; // monthlyCap / laboral days this month, derived
  readonly realAvgPerDay: number | null; // monthlySpent / elapsed laboral days (day <= today)
}
