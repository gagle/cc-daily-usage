import type { LimitSample } from "./interfaces/config.interface.js";

/** Samples older than this, or past this count, drop off limits.json. 29 days keeps four finished weeks for
 * the typical peak; the count cap bounds the file the render reads. */
export const SAMPLE_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;
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
/** The API's resets_at moves by a second between readings of the same window; a real reset moves it hours. */
const RESET_JITTER_S = 60;

export type RunwayVerdict = "comfortable" | "on-track" | "at-risk" | "insufficient-data" | "stale";

export interface Runway {
  readonly usedPct: number;
  readonly resetsAt: number | null; // Unix epoch seconds
  readonly ratePctPerHour: number | null;
  readonly exhaustsAt: number | null; // Unix epoch seconds; null = not before the rate stops or unknown
  readonly verdict: RunwayVerdict;
}

type Window = "fiveHour" | "sevenDay";

/** Whether a local day counts as work time for the 7-day runway; null = every day (clock time). */
export type WorkDay = ((date: Date) => boolean) | null;

/** Runway math looks no further ahead than this. */
const HORIZON_MS = 60 * 24 * HOUR_MS;

const localMidnightAfter = (ms: number): number => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
};

/** Hours from `fromMs` to `toMs` on work days. The day of `fromMs` always counts: a reading then proves use. */
export function workHoursBetween(fromMs: number, toMs: number, workDay: WorkDay): number {
  if (workDay === null) return Math.max(0, toMs - fromMs) / HOUR_MS;
  let hours = 0;
  let cursor = fromMs;
  let first = true;
  while (cursor < toMs) {
    const end = Math.min(localMidnightAfter(cursor), toMs);
    if (first || workDay(new Date(cursor))) hours += (end - cursor) / HOUR_MS;
    cursor = end;
    first = false;
  }
  return hours;
}

/** The instant `hours` of work time after `fromMs` (same rule as workHoursBetween); null past 60 days. */
export function addWorkHours(fromMs: number, hours: number, workDay: WorkDay): number | null {
  if (workDay === null) return fromMs + hours * HOUR_MS;
  let left = hours * HOUR_MS;
  let cursor = fromMs;
  let first = true;
  while (cursor - fromMs < HORIZON_MS) {
    const end = localMidnightAfter(cursor);
    if (first || workDay(new Date(cursor))) {
      if (cursor + left <= end) return cursor + left;
      left -= end - cursor;
    }
    cursor = end;
    first = false;
  }
  return null;
}

function pctOf(sample: LimitSample, window: Window): number | null {
  return window === "fiveHour" ? sample.fiveHourPct : sample.sevenDayPct;
}

function resetsAtOf(sample: LimitSample, window: Window): number | null {
  return window === "fiveHour" ? sample.fiveHourResetsAt : sample.sevenDayResetsAt;
}

/**
 * Drops readings whose % falls while the window's reset time stays put: that is not a reset but a bad
 * reading (two writers with different readings interleaved once and read as resets and 10-point rises).
 * A drop with an unknown reset time on either side is trusted as a reset.
 */
function withoutFalseDrops(
  samples: ReadonlyArray<LimitSample>,
  window: Window,
): Array<LimitSample> {
  const kept: Array<LimitSample> = [];
  let last: LimitSample | null = null;
  for (const sample of samples) {
    const pct = pctOf(sample, window);
    if (pct !== null && last !== null) {
      const from = resetsAtOf(last, window);
      const to = resetsAtOf(sample, window);
      const moved = from === null || to === null || to - from > RESET_JITTER_S;
      if (pct < (pctOf(last, window) as number) && !moved) continue;
    }
    kept.push(sample);
    if (pct !== null) last = sample;
  }
  return kept;
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
 * the rate runs from the reading in force 2 h before `readingAt` (or the first one after the last reset, a
 * drop in %) to `usedPct` at `readingAt` — not to now: between fetches the % is unchanged, and dividing by a
 * growing span would decay the rate and flip `at-risk` off while the user works. Guards: a reading older than STALE_READING_MS → `stale`; under 15 min of history →
 * `insufficient-data`. Verdict: exhausts before reset → `at-risk`; pace (rate ÷ the rate that lasts exactly
 * to reset) ≤ 0.8 → `comfortable`; else `on-track`. With `workDay` (the 7-day window and a work-day calendar),
 * the remaining % burns only on work days: exhaustion and the time left to reset skip the days off.
 * # ponytail: one linear rate over 2 h; a work day burns at that rate around the clock.
 */
export function computeRunway(
  samples: ReadonlyArray<LimitSample>,
  window: Window,
  usedPct: number,
  resetsAt: number | null,
  readingAt: number,
  now: Date,
  workDay: WorkDay = null,
): Runway {
  const base = { usedPct, resetsAt, ratePctPerHour: null, exhaustsAt: null };
  const nowMs = now.getTime();
  if (nowMs - readingAt > STALE_READING_MS) return { ...base, verdict: "stale" };
  if (usedPct >= 100) return { ...base, exhaustsAt: Math.floor(nowMs / 1000), verdict: "at-risk" };

  const trusted = withoutFalseDrops(samples, window);
  let start = 0;
  for (let i = 1; i < trusted.length; i++) {
    const previous = pctOf(trusted[i - 1] as LimitSample, window);
    const current = pctOf(trusted[i] as LimitSample, window);
    if (previous === null || current === null || current < previous) start = i;
  }
  const segment = trusted.slice(start).filter((sample) => pctOf(sample, window) !== null);
  const windowStart = readingAt - RATE_WINDOW_MS;
  // Samples are in time order: the last one at or before the window start, else the first inside it.
  const inside = segment.findIndex((sample) => sample.t > windowStart);
  const anchor = inside === -1 ? segment.at(-1) : (segment[inside - 1] ?? segment[inside]);
  if (anchor === undefined || readingAt - anchor.t < MIN_SPAN_MS) {
    return { ...base, verdict: "insufficient-data" };
  }

  const hours = (readingAt - anchor.t) / HOUR_MS;
  const rate = Math.max(0, (usedPct - (pctOf(anchor, window) as number)) / hours);
  const left = Math.max(0, 100 - usedPct);
  const outMs = rate > 0 ? addWorkHours(readingAt, left / rate, workDay) : null;
  const exhaustsAt = outMs === null ? null : Math.round(outMs / 1000);
  if (resetsAt === null) return { ...base, ratePctPerHour: rate, exhaustsAt, verdict: "on-track" };
  if (exhaustsAt !== null && exhaustsAt < resetsAt) {
    return { ...base, ratePctPerHour: rate, exhaustsAt, verdict: "at-risk" };
  }
  const hoursToReset = workHoursBetween(readingAt, resetsAt * 1000, workDay);
  const pace = rate / (left / Math.max(hoursToReset, 1 / 60)); // left > 0: 100% returned above
  return {
    ...base,
    ratePctPerHour: rate,
    exhaustsAt,
    verdict: pace <= COMFORTABLE_PACE ? "comfortable" : "on-track",
  };
}

/** A window instance: its samples share a reset time (to the hour; the API's resets_at jitters by seconds). */
function instances(
  samples: ReadonlyArray<LimitSample>,
  window: Window,
): Map<number, Array<LimitSample>> {
  const byReset = new Map<number, Array<LimitSample>>();
  for (const sample of withoutFalseDrops(samples, window)) {
    const resetsAt = resetsAtOf(sample, window);
    if (resetsAt === null || pctOf(sample, window) === null) continue;
    const key = Math.round(resetsAt / 3600);
    byReset.set(key, [...(byReset.get(key) ?? []), sample]);
  }
  return byReset;
}

/** Fewer finished windows than this give no typical peak. */
const TYPICAL_PEAK_MIN_WINDOWS = 2;

/** Median of the highest % each finished window reached (antiburn's "allowance": do you use your plan?). */
export function typicalPeak(
  samples: ReadonlyArray<LimitSample>,
  window: Window,
  now: Date,
): number | null {
  const peaks: Array<number> = [];
  for (const [hour, group] of instances(samples, window)) {
    if (hour * 3600 * 1000 > now.getTime()) continue; // still open
    peaks.push(Math.max(...group.map((sample) => pctOf(sample, window) as number)));
  }
  if (peaks.length < TYPICAL_PEAK_MIN_WINDOWS) return null;
  peaks.sort((a, b) => a - b);
  const mid = Math.floor(peaks.length / 2);
  return peaks.length % 2 === 1
    ? (peaks[mid] as number)
    : ((peaks[mid - 1] as number) + (peaks[mid] as number)) / 2;
}

export const MILESTONES: ReadonlyArray<number> = [75, 90, 100];

export interface Milestone {
  readonly threshold: number;
  readonly at: number; // epoch ms of the reading that crossed it
  readonly resetsAt: number; // epoch s: the window instance
}

/**
 * Crossings of 75/90/100 % seen happen: the first reading of a window instance primes it (a threshold
 * already passed then is history, not news), and a jump over several reports only the highest. Derived
 * from the samples, so no state: the /cost-tracker mod keeps which ones it toasted.
 */
export function milestones(samples: ReadonlyArray<LimitSample>, window: Window): Array<Milestone> {
  const out: Array<Milestone> = [];
  for (const group of instances(samples, window).values()) {
    let previous = pctOf(group[0] as LimitSample, window) as number;
    for (const sample of group.slice(1)) {
      const pct = pctOf(sample, window) as number;
      const crossed = MILESTONES.filter((threshold) => previous < threshold && pct >= threshold);
      if (crossed.length > 0) {
        out.push({
          threshold: Math.max(...crossed),
          at: sample.t,
          resetsAt: resetsAtOf(sample, window) as number,
        });
      }
      previous = Math.max(previous, pct);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Under this Claude Code share the ratio is mostly noise (a tiny share would inflate it without bound). */
const MIN_CLAUDE_CODE_SHARE = 0.05;

/**
 * API-equivalent $ per 1% of the 7-day window: between readings where the 7d % rose at least one point,
 * Δ apiEqTotal ÷ (Δ% × Claude Code's share of the week, when the API gave one: chat and Cowork use also
 * raise the % but not our $). Median of the last 14 days; null under 3 measured rises. A reset restarts; a drop
 * without one is a bad reading and is skipped.
 * Counts only spend this statusline saw, so use from other devices makes it read low — label it an estimate.
 */
export function usdPerPercentWeek(samples: ReadonlyArray<LimitSample>, now: Date): number | null {
  const ratios: Array<number> = [];
  let from: { pct: number; usd: number } | null = null;
  const recent = samples.filter((sample) => sample.t >= now.getTime() - USD_PER_PCT_WINDOW_MS);
  for (const sample of withoutFalseDrops(recent, "sevenDay")) {
    const pct = sample.sevenDayPct;
    if (pct === null) continue;
    if (from === null || pct < from.pct) {
      from = { pct, usd: sample.apiEqTotal };
      continue;
    }
    const rise = pct - from.pct;
    if (rise < 1) continue;
    const usd = sample.apiEqTotal - from.usd;
    const share = sample.claudeCodeShare ?? 1;
    if (usd >= 0 && share >= MIN_CLAUDE_CODE_SHARE) ratios.push(usd / (rise * share));
    from = { pct, usd: sample.apiEqTotal };
  }
  if (ratios.length < USD_PER_PCT_MIN_SAMPLES) return null;
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 === 1
    ? (ratios[mid] as number)
    : ((ratios[mid - 1] as number) + (ratios[mid] as number)) / 2;
}
