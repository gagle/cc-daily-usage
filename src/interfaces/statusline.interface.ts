import type { CacheForecast, CachePayload } from "../cache-forecast.js";
import type { Runway } from "../limits-history.js";
import type { ExtraUsageCacheEntry, RateLimitsCache } from "./config.interface.js";

/** The subset of Claude Code's statusline stdin JSON that cc-daily-usage reads. */
export interface HookPayload extends CachePayload {
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly workspace?: {
    readonly current_dir?: string;
    readonly project_dir?: string;
    readonly repo?: { readonly name?: string };
  };
  readonly cwd?: string;
  readonly model?: { readonly id?: string; readonly display_name?: string };
  readonly effort?: { readonly level?: string };
  readonly cost?: {
    readonly total_cost_usd?: number;
    readonly total_duration_ms?: number;
    readonly total_lines_added?: number;
    readonly total_lines_removed?: number;
  };
  readonly context_window?: {
    readonly total_input_tokens?: number;
    readonly used_percentage?: number | null;
  };
  readonly rate_limits?: {
    readonly five_hour?: { readonly used_percentage?: number; readonly resets_at?: number };
    readonly seven_day?: { readonly used_percentage?: number; readonly resets_at?: number };
    readonly spend_limit?: { readonly used_percentage?: number; readonly resets_at?: number };
  };
}

export interface ResolvedRateLimits {
  readonly fiveHourPct: number | null;
  readonly sevenDayPct: number | null;
  readonly fiveHourResetsAt: number | null; // Unix epoch seconds
  readonly sevenDayResetsAt: number | null;
  readonly source: "hook" | "api" | "cache" | "none";
}

/** One line of `cc-daily-usage --statusline` output — also the input of renderStatusline. */
export interface StatuslineState {
  // Dollar self-budget (enterprise/team/unknown) — absent on Pro/Max.
  readonly todayUsage?: number;
  readonly avgPerDay?: number | null;
  readonly todayUsedPct?: number | null;
  readonly budgetExhausted?: boolean;
  readonly monthlySpent?: number;
  readonly monthlyCap?: number;
  readonly monthUsedPct?: number;
  readonly needsInit?: boolean;
  readonly capSource?: "anthropic" | "local";
  // Pro/Max only.
  readonly extraUsage: ExtraUsageCacheEntry["data"];
  readonly rateLimits: ResolvedRateLimits;
  readonly rateLimitsCache: RateLimitsCache | null; // kept for shims installed before v0.2
  readonly spendLimitPct: number | null; // Claude apps gateway spend limit, 0-100+
  readonly cache: CacheForecast | null;
  readonly runway?: { readonly fiveHour: Runway | null; readonly sevenDay: Runway | null };
  readonly coach?: {
    readonly title: string;
    readonly usd: number | null;
    readonly window: string;
  } | null;
  readonly hasSpendCap: boolean;
  readonly planType: string | null;
}
