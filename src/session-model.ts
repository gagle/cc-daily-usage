import { cacheWriteRate, ratesFor, tokensCost } from "./pricing.js";
import {
  type Compaction,
  contextTokens,
  priceTurn,
  splitTurn,
  type Turn,
} from "./transcript-parse.js";

/**
 * One session built turn by turn from its transcript lines (main thread + subagents): where the $ went, how it
 * grew over time, and the cache state after the last main turn. Pure and Node-free: `live`, `report --session`
 * and the /cost-tracker mod share it.
 */

/** A cache re-written after it went cold shows only when the context was at least this big. */
export const COLD_MIN_CONTEXT = 20_000;
const FIVE_MIN_TTL = 300;
const ONE_HOUR_TTL = 3600;

export type MarkKind = "compact" | "subagent" | "cold";

export interface Mark {
  readonly ms: number;
  readonly kind: MarkKind;
}

export interface Point {
  readonly ms: number;
  readonly usd: number; // $ of that one turn
}

export interface Components {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearch: number;
}

export interface Efficiency {
  newWorkUsd: number;
  carryUsd: number;
  rewriteUsd: number;
  growthTokens: number; // context growth + output: what "cost per MTok" divides by
}

interface ThreadState {
  context: number;
}

export interface SessionModel {
  readonly sessionId: string;
  project: string;
  branch: string;
  firstMs: number;
  lastMs: number;
  turns: number;
  unpricedTurns: number;
  readonly usd: Components;
  readonly tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  readonly efficiency: Efficiency;
  readonly byModel: Record<string, number>;
  readonly byScope: Record<string, number>; // main | subagent:<type>
  readonly points: Array<Point>;
  readonly marks: Array<Mark>;
  coldUsd: number; // cache writes of turns that re-wrote a cold cache
  lastMain: {
    readonly ms: number;
    readonly model: string;
    readonly fast: boolean;
    readonly usOnly: boolean;
    readonly context: number;
    readonly cached: number; // cache read + cache write: the prefix the next request reads or re-writes
    readonly tail: number; // the last request's uncached input + output: the next request writes it
  } | null;
  ttlSeconds: number; // TTL of the last cache write on the main thread
  readonly seen: Set<string>; // turn keys: Claude Code repeats a line per content block
  readonly threads: Map<string, ThreadState>;
}

export function newSession(sessionId: string): SessionModel {
  return {
    sessionId,
    project: "",
    branch: "",
    firstMs: Number.POSITIVE_INFINITY,
    lastMs: 0,
    turns: 0,
    unpricedTurns: 0,
    usd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearch: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    efficiency: { newWorkUsd: 0, carryUsd: 0, rewriteUsd: 0, growthTokens: 0 },
    byModel: {},
    byScope: {},
    points: [],
    marks: [],
    coldUsd: 0,
    lastMain: null,
    ttlSeconds: FIVE_MIN_TTL,
    seen: new Set(),
    threads: new Map(),
  };
}

export function sessionUsd(session: SessionModel): number {
  const { input, output, cacheRead, cacheWrite, webSearch } = session.usd;
  return input + output + cacheRead + cacheWrite + webSearch;
}

/**
 * Adds one turn. `thread` names the transcript file it came from (main or one subagent); `scope` is `main` or
 * `subagent:<type>`. A repeated turn key is ignored (returns false).
 */
export function addSessionTurn(
  session: SessionModel,
  turn: Turn,
  scope: string,
  thread: string,
): boolean {
  if (session.seen.has(turn.key)) return false;
  session.seen.add(turn.key);
  const ms = Date.parse(turn.timestamp);
  if (Number.isNaN(ms)) return false;
  session.turns += 1;
  session.firstMs = Math.min(session.firstMs, ms);
  session.lastMs = Math.max(session.lastMs, ms);
  if (turn.cwd !== "") session.project = turn.cwd;
  if (turn.branch !== "") session.branch = turn.branch;

  let state = session.threads.get(thread);
  if (state === undefined) {
    state = { context: 0 };
    session.threads.set(thread, state);
    if (scope !== "main") session.marks.push({ ms, kind: "subagent" });
  }
  const previous = state.context;
  const context = contextTokens(turn);
  state.context = context;

  session.tokens.input += turn.input;
  session.tokens.output += turn.output;
  session.tokens.cacheRead += turn.cacheRead;
  session.tokens.cacheWrite += turn.cacheWrite5m + turn.cacheWrite1h;

  const cost = priceTurn(turn);
  if (scope === "main") {
    if (turn.cacheWrite1h > 0) session.ttlSeconds = ONE_HOUR_TTL;
    else if (turn.cacheWrite5m > 0) session.ttlSeconds = FIVE_MIN_TTL;
    if (session.lastMain === null || ms >= session.lastMain.ms) {
      const lastRequest = turn.requests?.at(-1) ?? turn;
      session.lastMain = {
        ms,
        model: turn.model,
        fast: turn.fast,
        usOnly: turn.usOnly,
        context,
        cached: context - lastRequest.input, // the last request's cache read + write
        tail: lastRequest.input + lastRequest.output,
      };
    }
  }
  if (cost === null) {
    session.unpricedTurns += 1;
    return true;
  }
  const usd = cost.input + cost.output + cost.cacheRead + cost.cacheWrite + cost.webSearch;
  session.usd.input += cost.input;
  session.usd.output += cost.output;
  session.usd.cacheRead += cost.cacheRead;
  session.usd.cacheWrite += cost.cacheWrite;
  session.usd.webSearch += cost.webSearch;
  session.byModel[turn.model] = (session.byModel[turn.model] ?? 0) + usd;
  session.byScope[scope] = (session.byScope[scope] ?? 0) + usd;
  session.points.push({ ms, usd });

  const split = splitTurn(turn, cost, previous);
  session.efficiency.newWorkUsd += split.newWorkUsd;
  session.efficiency.carryUsd += split.carryUsd;
  session.efficiency.rewriteUsd += split.rewriteUsd;
  session.efficiency.growthTokens += split.growth + turn.output;

  // A cold cache: a big context came back mostly as a write, not a read.
  const written = turn.cacheWrite5m + turn.cacheWrite1h;
  if (
    previous >= COLD_MIN_CONTEXT &&
    turn.cacheRead < previous * 0.5 &&
    written >= previous * 0.5
  ) {
    session.marks.push({ ms, kind: "cold" });
    session.coldUsd += cost.cacheWrite;
  }
  return true;
}

export function addSessionCompaction(session: SessionModel, compaction: Compaction): void {
  const ms = Date.parse(compaction.timestamp);
  if (Number.isNaN(ms)) return;
  session.marks.push({ ms, kind: "compact" });
}

/** $ per bucket: `count` equal buckets over [fromMs, toMs). Points outside are dropped. */
export function buckets(
  points: ReadonlyArray<Point>,
  fromMs: number,
  toMs: number,
  count: number,
): ReadonlyArray<number> {
  const out = Array.from({ length: count }, () => 0);
  const span = (toMs - fromMs) / count;
  if (span <= 0) return out;
  for (const point of points) {
    if (point.ms < fromMs || point.ms >= toMs) continue;
    const i = Math.floor((point.ms - fromMs) / span);
    out[i] = (out[i] as number) + point.usd;
  }
  return out;
}

/** Bucket index of each mark, same grid as `buckets`; marks outside are dropped. */
export function markBuckets(
  marks: ReadonlyArray<Mark>,
  fromMs: number,
  toMs: number,
  count: number,
): ReadonlyArray<ReadonlySet<MarkKind>> {
  const out = Array.from({ length: count }, () => new Set<MarkKind>());
  const span = (toMs - fromMs) / count;
  if (span <= 0) return out;
  for (const mark of marks) {
    if (mark.ms < fromMs || mark.ms >= toMs) continue;
    (out[Math.floor((mark.ms - fromMs) / span)] as Set<MarkKind>).add(mark.kind);
  }
  return out;
}

/** $ per minute over the last `windowMs` (default 10 minutes). */
export function usdPerMinute(
  session: SessionModel,
  nowMs: number,
  windowMs = 10 * 60 * 1000,
): number {
  const from = nowMs - windowMs;
  const usd = session.points.reduce(
    (sum, point) => (point.ms >= from && point.ms <= nowMs ? sum + point.usd : sum),
    0,
  );
  return usd / (windowMs / 60_000);
}

export interface CacheState {
  readonly warm: boolean;
  readonly secondsLeft: number; // 0 when cold
  readonly ttlSeconds: number;
  readonly context: number;
  readonly nextWarmUsd: number; // reading the cached prefix, writing the last reply
  readonly nextColdUsd: number; // writing both
}

/**
 * Estimate from the transcript alone: the cache stays warm for one TTL after the last main turn; the next
 * prompt re-reads (warm) or re-writes (cold) that turn's cached prefix, and writes the last request's
 * uncached input and reply either way. Null before a priced main turn.
 */
export function cacheState(session: SessionModel, nowMs: number): CacheState | null {
  const last = session.lastMain;
  if (last === null) return null;
  const rates = ratesFor(last.model, last.fast, last.context + last.tail, last.usOnly);
  if (rates === null) return null;
  const ttl = session.ttlSeconds;
  const writeRate = cacheWriteRate(rates, ttl === ONE_HOUR_TTL ? "1h" : "5m");
  const tailUsd = tokensCost(last.tail, writeRate);
  const secondsLeft = Math.max(0, Math.round((last.ms + ttl * 1000 - nowMs) / 1000));
  return {
    warm: secondsLeft > 0,
    secondsLeft,
    ttlSeconds: ttl,
    context: last.context,
    nextWarmUsd: tokensCost(last.cached, rates.cacheRead) + tailUsd,
    nextColdUsd: tokensCost(last.cached, writeRate) + tailUsd,
  };
}

/** $ per million tokens of new work: total $ ÷ (context growth + output). Null with no growth. */
export function costPerMTok(session: SessionModel): number | null {
  const tokens = session.efficiency.growthTokens;
  return tokens === 0 ? null : (sessionUsd(session) / tokens) * 1_000_000;
}

/** Efficiency bands for $ per MTok of new work (antiburn's Claude edges; a heuristic, not a rule). */
export const MTOK_GOOD = 33;
export const MTOK_BAD = 80;

export function mtokBand(perMTok: number): "good" | "fair" | "high" {
  if (perMTok < MTOK_GOOD) return "good";
  return perMTok > MTOK_BAD ? "high" : "fair";
}

/** The `n` largest entries, largest first. */
export function topEntries(
  record: Readonly<Record<string, number>>,
  n: number,
): ReadonlyArray<readonly [string, number]> {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}
