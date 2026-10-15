import type { LimitSample } from "./interfaces/config.interface.js";

/** Samples older than this, or past this count, drop off limits.json. */
export const SAMPLE_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const SAMPLE_MAX_COUNT = 2000;

const HOUR_MS = 60 * 60 * 1000;
/** The burn rate looks back this far (antiburn: a short window follows the current pace). */
const RATE_WINDOW_MS = 2 * HOUR_MS;
/** Less history than this gives a rate that is mostly noise. */
const MIN_SPAN_MS = 15 * 60 * 1000;
/** A reading older than this no longer describes the account (other devices may have used it). */
export const STALE_READING_MS = 15 * 60 * 1000;
/** Pace at or under this share of the sustainable rate is comfortable; above 1 exhausts before reset. */
const COMFORTABLE_PACE = 0.8;
/** $ per 1% of the week: last 14 days, at least 3 measured rises (antiburn uses the same floor). */
const USD_PER_PCT_WINDOW_MS = 14 * 24 * HOUR_MS;
const USD_PER_PCT_MIN_SAMPLES = 3;

export type RunwayVerdict = "comfortable" | "on-track" | "at-risk" | "insufficient-data" | "stale";

export interface Runway {
  readonly usedPct: number;
  readonly resetsAt: number | null; // Unix epoch seconds
  readonly ratePctPerHour: number | null;
  readonly exhaustsAt: number | null; // Unix epoch seconds; null = not before the rate stops or unknown
  readonly verdict: RunwayVerdict;
}

type Window = "fiveHour" | "sevenDay";

function pctOf(sample: LimitSample, window: Window): number | null {
  return window === "fiveHour" ? sample.fiveHourPct : sample.sevenDayPct;
}

/**
 * Appends a reading when either % differs from the last sample, then drops samples past the age and count
 * caps. Returns the same array when nothing changed, so the caller can skip the write.
 */
export function appendSample(
  samples: ReadonlyArray<LimitSample>,
  next: LimitSample,
): ReadonlyArray<LimitSample> {
  const last = samples.at(-1);
  if (last?.fiveHourPct === next.fiveHourPct && last.sevenDayPct === next.sevenDayPct) {
    return samples;
  }
  const cutoff = next.t - SAMPLE_MAX_AGE_MS;
  return [...samples.filter((sample) => sample.t >= cutoff), next].slice(-SAMPLE_MAX_COUNT);
}

/**
 * Burn rate and runway of one window. Samples are change points, so a % holds from its sample to the next;
 * the rate runs from the reading in force 2 h ago (or the first one after the last reset, a drop in %) to
 * `usedPct` now. Guards: a reading older than STALE_READING_MS → `stale`; under 15 min of history →
 * `insufficient-data`. Verdict: exhausts before reset → `at-risk`; pace (rate ÷ the rate that lasts exactly
 * to reset) ≤ 0.8 → `comfortable`; else `on-track`.
 * # ponytail: one linear rate over 2 h, no work-day model; upgrade path: weight by laboralDays like antiburn.
 */
export function computeRunway(
  samples: ReadonlyArray<LimitSample>,
  window: Window,
  usedPct: number,
  resetsAt: number | null,
  readingAt: number,
  now: Date,
): Runway {
  const base = { usedPct, resetsAt, ratePctPerHour: null, exhaustsAt: null };
  const nowMs = now.getTime();
  if (nowMs - readingAt > STALE_READING_MS) return { ...base, verdict: "stale" };
  if (usedPct >= 100) return { ...base, exhaustsAt: Math.floor(nowMs / 1000), verdict: "at-risk" };

  let start = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = pctOf(samples[i - 1] as LimitSample, window);
    const current = pctOf(samples[i] as LimitSample, window);
    if (previous === null || current === null || current < previous) start = i;
  }
  const segment = samples.slice(start).filter((sample) => pctOf(sample, window) !== null);
  const windowStart = nowMs - RATE_WINDOW_MS;
  // Samples are in time order: the last one at or before the window start, else the first inside it.
  const inside = segment.findIndex((sample) => sample.t > windowStart);
  const anchor = inside === -1 ? segment.at(-1) : (segment[inside - 1] ?? segment[inside]);
  if (anchor === undefined || nowMs - anchor.t < MIN_SPAN_MS) {
    return { ...base, verdict: "insufficient-data" };
  }

  const hours = (nowMs - anchor.t) / HOUR_MS;
  const rate = Math.max(0, (usedPct - (pctOf(anchor, window) as number)) / hours);
  const left = Math.max(0, 100 - usedPct);
  const exhaustsAt = rate > 0 ? Math.round(nowMs / 1000 + (left / rate) * 3600) : null;
  if (resetsAt === null) return { ...base, ratePctPerHour: rate, exhaustsAt, verdict: "on-track" };
  if (exhaustsAt !== null && exhaustsAt < resetsAt) {
    return { ...base, ratePctPerHour: rate, exhaustsAt, verdict: "at-risk" };
  }
  const hoursToReset = Math.max(0, resetsAt * 1000 - nowMs) / HOUR_MS;
  const pace = rate / (left / Math.max(hoursToReset, 1 / 60)); // left > 0: 100% returned above
  return {
    ...base,
    ratePctPerHour: rate,
    exhaustsAt,
    verdict: pace <= COMFORTABLE_PACE ? "comfortable" : "on-track",
  };
}

/**
 * API-equivalent $ per 1% of the 7-day window: between readings where the 7d % rose at least one point,
 * Δ apiEqTotal ÷ Δ%. Median of the last 14 days; null under 3 measured rises. A drop (reset) restarts.
 * Counts only spend this statusline saw, so use from other devices makes it read low — label it an estimate.
 */
export function usdPerPercentWeek(samples: ReadonlyArray<LimitSample>, now: Date): number | null {
  const ratios: Array<number> = [];
  let from: { pct: number; usd: number } | null = null;
  for (const sample of samples) {
    const pct = sample.sevenDayPct;
    if (sample.t < now.getTime() - USD_PER_PCT_WINDOW_MS || pct === null) continue;
    if (from === null || pct < from.pct) {
      from = { pct, usd: sample.apiEqTotal };
      continue;
    }
    const rise = pct - from.pct;
    if (rise < 1) continue;
    const usd = sample.apiEqTotal - from.usd;
    if (usd >= 0) ratios.push(usd / rise);
    from = { pct, usd: sample.apiEqTotal };
  }
  if (ratios.length < USD_PER_PCT_MIN_SAMPLES) return null;
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 === 1
    ? (ratios[mid] as number)
    : ((ratios[mid - 1] as number) + (ratios[mid] as number)) / 2;
}
