import { computeToday, rolloverIfNeeded } from "./calc.js";
import { localDateKey } from "./clock.js";
import type {
  ApiCache,
  Config,
  LimitSample,
  SessionMapEntry,
  UsageState,
} from "./interfaces/config.interface.js";
import { computeRunway, type RunwayVerdict, usdPerPercentWeek } from "./limits-history.js";
import { recentSessionIds } from "./sessions-map.js";

/** accounts/<key>/feed.json format. Add a field freely; remove or change one → bump (the mod refuses it). */
export const FEED_SCHEMA_VERSION = 1;

export interface FeedWindow {
  readonly usedPct: number;
  readonly resetsAt: string | null; // ISO
  readonly ratePctPerHour: number | null;
  readonly exhaustsAt: string | null; // ISO
  readonly verdict: RunwayVerdict;
}

/** One coaching finding (shared contract with the /cost-tracker mod). */
export interface Finding {
  readonly id: string;
  readonly title: string;
  readonly usd: number | null;
  readonly window: "week" | "month";
  readonly evidence: string;
  readonly fix: {
    readonly kind: "setting" | "env" | "command" | "habit";
    readonly key?: string;
    readonly value?: string;
    readonly text: string;
  };
  readonly snoozedUntil: string | null;
}

export interface Feed {
  readonly schemaVersion: number;
  readonly writtenAt: string;
  readonly accountKey: string;
  readonly plan: { readonly organizationType: string | null; readonly hasSpendCap: boolean };
  readonly sessionIds: ReadonlyArray<string>;
  readonly limits: {
    readonly fiveHour: FeedWindow | null; // null = no reading yet
    readonly sevenDay: FeedWindow | null;
    readonly usdPerPercentWeek: number | null;
    readonly claudeCodeShare: number | null; // 0-1 of this week's use; null when the API gave none
  };
  readonly budget?: {
    readonly todaySpent: number;
    readonly todayMax: number | null; // null = no laboral day left this period
    readonly monthSpent: number;
    readonly monthCap: number;
    readonly paceLabel: string | null;
  };
  readonly spend: {
    readonly today: number;
    readonly week: number; // rolling 7 local days, today included
    readonly monthToDate: number; // local calendar month
    readonly last30Days: number;
    readonly isFloor: boolean; // true when an unpriced model was seen
  };
  readonly advice: ReadonlyArray<Finding>;
}

export interface FeedInput {
  readonly accountKey: string;
  readonly config: Config;
  readonly usage: UsageState; // a fresh load; rollover runs on it in memory
  readonly samples: ReadonlyArray<LimitSample>;
  readonly api: ApiCache | null;
  readonly sessions: Readonly<Record<string, SessionMapEntry>>;
  readonly advice?: ReadonlyArray<Finding>;
  readonly isFloor?: boolean;
}

const iso = (epochSeconds: number | null): string | null =>
  epochSeconds === null ? null : new Date(epochSeconds * 1000).toISOString();

/** Σ API-equivalent $ over the `days` local days ending today. */
function lastDays(apiEqDays: Readonly<Record<string, number>>, days: number, now: Date): number {
  let total = 0;
  for (let back = 0; back < days; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    total += apiEqDays[localDateKey(day)] ?? 0;
  }
  return total;
}

/**
 * The window reading for the feed: the refresher's API reading when it has one and is not stale, else the
 * newest limits.json sample (with its own time, so an old one reads `stale`).
 */
function feedWindow(
  input: FeedInput,
  window: "fiveHour" | "sevenDay",
  now: Date,
): FeedWindow | null {
  const fromApi = input.api?.stale === true ? null : input.api?.[window];
  const last = input.samples.at(-1);
  const lastPct = window === "fiveHour" ? last?.fiveHourPct : last?.sevenDayPct;
  let reading: { pct: number; resetsAt: number | null; at: number } | null = null;
  if (fromApi && input.api) {
    reading = { pct: fromApi.pct, resetsAt: fromApi.resetsAt, at: input.api.fetchedAt };
  } else if (last && lastPct != null) {
    const resetsAt = window === "fiveHour" ? last.fiveHourResetsAt : last.sevenDayResetsAt;
    reading = { pct: lastPct, resetsAt, at: last.t };
  }
  if (reading === null) return null;
  const runway = computeRunway(
    input.samples,
    window,
    reading.pct,
    reading.resetsAt,
    reading.at,
    now,
  );
  return {
    usedPct: reading.pct,
    resetsAt: iso(reading.resetsAt),
    ratePctPerHour: runway.ratePctPerHour,
    exhaustsAt: iso(runway.exhaustsAt),
    verdict: runway.verdict,
  };
}

/** Everything the /cost-tracker mod reads, from the files the CLI already keeps. Pure apart from the
 * in-memory rollover of `input.usage`. */
export function buildFeed(input: FeedInput, now: Date): Feed {
  const { config, usage } = input;
  const hasSpendCap = config.hasSpendCap === true;
  let budget: Feed["budget"];
  if (hasSpendCap) {
    rolloverIfNeeded(usage, now, input.api?.extraUsage?.usedCredits ?? null);
    const today = computeToday(usage, config, now);
    budget = {
      todaySpent: today.todayUsage,
      todayMax: today.avgPerDay,
      monthSpent: today.monthlySpent,
      monthCap: today.monthlyCap,
      paceLabel: today.paceLabel,
    };
  }
  const monthPrefix = localDateKey(now).slice(0, 7);
  return {
    schemaVersion: FEED_SCHEMA_VERSION,
    writtenAt: now.toISOString(),
    accountKey: input.accountKey,
    plan: { organizationType: config.planType ?? null, hasSpendCap },
    sessionIds: recentSessionIds(input.sessions, 7, now),
    limits: {
      fiveHour: feedWindow(input, "fiveHour", now),
      sevenDay: feedWindow(input, "sevenDay", now),
      usdPerPercentWeek: usdPerPercentWeek(input.samples, now),
      claudeCodeShare: input.api?.claudeCodeShare ?? null,
    },
    ...(budget ? { budget } : {}),
    spend: {
      today: usage.apiEqDays[localDateKey(now)] ?? 0,
      week: lastDays(usage.apiEqDays, 7, now),
      monthToDate: Object.entries(usage.apiEqDays)
        .filter(([day]) => day.startsWith(monthPrefix))
        .reduce((total, [, usd]) => total + usd, 0),
      last30Days: lastDays(usage.apiEqDays, 30, now),
      isFloor: input.isFloor ?? false,
    },
    advice: input.advice ?? [],
  };
}
