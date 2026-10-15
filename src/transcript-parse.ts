import { localDateKey } from "./clock.js";
import { cacheWriteRate, normalizeModelId, ratesFor, tokensCost } from "./pricing.js";

/** One billed model response from a transcript line (Claude Code `~/.claude/projects/**.jsonl`). */
export interface Turn {
  readonly key: string; // requestId + message id: Claude Code repeats the line once per content block
  readonly sessionId: string;
  readonly timestamp: string; // ISO
  readonly model: string; // normalized id
  readonly cwd: string;
  readonly branch: string;
  readonly fast: boolean;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly thinking: number; // part of output
  readonly webSearches: number;
  readonly webFetches: number;
  readonly effort: string | null;
  readonly thinkingMs: number; // time spent thinking (`thinkingDurationMs`, on the first copy of the line)
  readonly entrypoint: string | null; // cli, sdk-ts, … (how the session was started)
}

/** Time and hook facts from Claude Code's own system lines (no tokens, never priced). */
export interface Activity {
  readonly sessionId: string;
  readonly turnMs: number; // `turn_duration`: wall time of one user turn
  readonly hookRuns: number; // `stop_hook_summary`: hooks run at the end of a turn
}

/** $ of one turn by component; null for a model with no price. */
export interface TurnCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const str = (value: unknown, fallback: string): string =>
  typeof value === "string" && value !== "" ? value : fallback;

/** A usage-bearing assistant line → Turn; anything else (user lines, metadata, garbage) → null. */
export function parseTurn(line: string): Turn | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const entry = parsed as Record<string, unknown>;
  const message = entry.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (entry.type !== "assistant" || !usage || typeof message?.model !== "string") return null;
  if (message.model === "<synthetic>") return null;
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  const write5m = num(creation?.ephemeral_5m_input_tokens);
  const write1h = num(creation?.ephemeral_1h_input_tokens);
  // Older lines have only the total; it was the 5-minute TTL then.
  const writeTotal = num(usage.cache_creation_input_tokens);
  const details = usage.output_tokens_details as Record<string, unknown> | undefined;
  const server = usage.server_tool_use as Record<string, unknown> | undefined;
  return {
    key: `${str(entry.requestId, "")}|${str(message.id, str(entry.uuid, ""))}`,
    sessionId: str(entry.sessionId, "unknown"),
    timestamp: str(entry.timestamp, ""),
    model: normalizeModelId(message.model),
    cwd: str(entry.cwd, ""),
    branch: str(entry.gitBranch, ""),
    fast: usage.speed === "fast",
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: creation ? write5m : writeTotal,
    cacheWrite1h: creation ? write1h : 0,
    thinking: num(details?.thinking_tokens),
    webSearches: num(server?.web_search_requests),
    webFetches: num(server?.web_fetch_requests),
    effort: typeof entry.effort === "string" ? entry.effort : null,
    thinkingMs: num(entry.thinkingDurationMs),
    entrypoint: typeof entry.entrypoint === "string" ? entry.entrypoint : null,
  };
}

/** A `turn_duration` or `stop_hook_summary` system line → Activity; anything else → null. The substring test
 * keeps the second JSON.parse off the common lines. */
export function parseActivity(line: string): Activity | null {
  if (!line.includes('"turn_duration"') && !line.includes('"stop_hook_summary"')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.type !== "system") return null;
  const sessionId = str(entry.sessionId, "unknown");
  if (entry.subtype === "turn_duration") {
    return { sessionId, turnMs: num(entry.durationMs), hookRuns: 0 };
  }
  if (entry.subtype === "stop_hook_summary") {
    return { sessionId, turnMs: 0, hookRuns: num(entry.hookCount) };
  }
  return null;
}

export function priceTurn(turn: Turn): TurnCost | null {
  const rates = ratesFor(turn.model, turn.fast);
  if (!rates) return null;
  return {
    input: tokensCost(turn.input, rates.input),
    output: tokensCost(turn.output, rates.output),
    cacheRead: tokensCost(turn.cacheRead, rates.cacheRead),
    cacheWrite:
      tokensCost(turn.cacheWrite5m, cacheWriteRate(rates, "5m")) +
      tokensCost(turn.cacheWrite1h, cacheWriteRate(rates, "1h")),
  };
}

/** Rollup totals for one day × project × model × scope × speed. */
export interface Rollup {
  turns: number;
  unpricedTurns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  webSearches: number;
  webFetches: number;
  usdInput: number;
  usdOutput: number;
  usdCacheRead: number;
  usdCacheWrite: number;
  usdThinking: number; // share of usdOutput spent on thinking tokens (estimate)
  usdThinkingHigh: number; // the part of usdThinking on turns at xhigh/max/ultra effort
  maxContext: number; // largest input + cache read + cache write of one turn
  deepContextReadUsd: number; // cache-read $ for the context above DEEP_CONTEXT_TOKENS, on turns past it
}

/** Effort levels whose thinking the coach (rule R3) counts as optional. */
export const HIGH_EFFORT: ReadonlySet<string> = new Set(["xhigh", "max", "ultra"]);

/** Context past this is "deep": every turn re-reads a lot (coach rule R5). */
export const DEEP_CONTEXT_TOKENS = 200_000;

export function emptyRollup(): Rollup {
  return {
    turns: 0,
    unpricedTurns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    thinking: 0,
    webSearches: 0,
    webFetches: 0,
    usdInput: 0,
    usdOutput: 0,
    usdCacheRead: 0,
    usdCacheWrite: 0,
    usdThinking: 0,
    usdThinkingHigh: 0,
    maxContext: 0,
    deepContextReadUsd: 0,
  };
}

export function rollupUsd(rollup: Rollup): number {
  return rollup.usdInput + rollup.usdOutput + rollup.usdCacheRead + rollup.usdCacheWrite;
}

/** Adds `turn` (priced as `cost`) into `rollup` in place. */
export function addTurn(rollup: Rollup, turn: Turn, cost: TurnCost | null): void {
  const context = turn.input + turn.cacheRead + turn.cacheWrite5m + turn.cacheWrite1h;
  rollup.turns += 1;
  rollup.input += turn.input;
  rollup.output += turn.output;
  rollup.cacheRead += turn.cacheRead;
  rollup.cacheWrite += turn.cacheWrite5m + turn.cacheWrite1h;
  rollup.thinking += turn.thinking;
  rollup.webSearches += turn.webSearches;
  rollup.webFetches += turn.webFetches;
  rollup.maxContext = Math.max(rollup.maxContext, context);
  if (cost === null) {
    rollup.unpricedTurns += 1;
    return;
  }
  rollup.usdInput += cost.input;
  rollup.usdOutput += cost.output;
  rollup.usdCacheRead += cost.cacheRead;
  rollup.usdCacheWrite += cost.cacheWrite;
  if (turn.output > 0) {
    const thinking = cost.output * (turn.thinking / turn.output);
    rollup.usdThinking += thinking;
    if (turn.effort !== null && HIGH_EFFORT.has(turn.effort)) rollup.usdThinkingHigh += thinking;
  }
  if (context > DEEP_CONTEXT_TOKENS) {
    rollup.deepContextReadUsd += cost.cacheRead * ((context - DEEP_CONTEXT_TOKENS) / context);
  }
}

/** Sums `from` into `into` in place (maxContext takes the larger). */
export function mergeRollup(into: Rollup, from: Rollup): void {
  for (const field of Object.keys(into) as Array<keyof Rollup>) {
    into[field] =
      field === "maxContext" ? Math.max(into[field], from[field]) : into[field] + from[field];
  }
}

/** Rollup row key and its parts. Scope is `main` or `subagent:<type>`. */
export interface RowKey {
  readonly day: string; // local YYYY-MM-DD
  readonly project: string;
  readonly model: string;
  readonly scope: string;
  readonly speed: "standard" | "fast";
}

const SEP = "\t";

export function rowKey(key: RowKey): string {
  return [key.day, key.project, key.model, key.scope, key.speed].join(SEP);
}

export function parseRowKey(value: string): RowKey {
  const [day = "", project = "", model = "", scope = "", speed = ""] = value.split(SEP);
  return { day, project, model, scope, speed: speed === "fast" ? "fast" : "standard" };
}

/** Row key of a turn: its LOCAL day; a turn with no valid time has no day and is skipped (null). */
export function turnRowKey(turn: Turn, scope: string): RowKey | null {
  const time = new Date(turn.timestamp);
  if (Number.isNaN(time.getTime())) return null;
  return {
    day: localDateKey(time),
    project: turn.cwd,
    model: turn.model,
    scope,
    speed: turn.fast ? "fast" : "standard",
  };
}
