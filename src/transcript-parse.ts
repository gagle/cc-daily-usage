import { localDateKey } from "./clock.js";
import {
  cacheWriteRate,
  normalizeModelId,
  ratesFor,
  tokensCost,
  WEB_SEARCH_USD,
} from "./pricing.js";

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
  readonly webSearch: number; // server-side web searches
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

/** A context compaction (`compact_boundary` system line). */
export interface Compaction {
  readonly sessionId: string;
  readonly timestamp: string; // ISO
  readonly trigger: string; // auto | manual
  readonly preTokens: number;
  readonly postTokens: number;
}

export function parseCompaction(line: string): Compaction | null {
  if (!line.includes('"compact_boundary"')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry.type !== "system" || entry.subtype !== "compact_boundary") return null;
  const meta = entry.compactMetadata as Record<string, unknown> | undefined;
  return {
    sessionId: str(entry.sessionId, "unknown"),
    timestamp: str(entry.timestamp, ""),
    trigger: str(meta?.trigger, "auto"),
    preTokens: num(meta?.preTokens),
    postTokens: num(meta?.postTokens),
  };
}

/** Tokens the model saw on a turn: fresh input + cache read + cache write. */
export function contextTokens(turn: Turn): number {
  return turn.input + turn.cacheRead + turn.cacheWrite5m + turn.cacheWrite1h;
}

/**
 * Where a turn's $ went (antiburn's efficiency split). Carry = cache-read $ (re-reading context). Fresh input
 * (input + cache write) that grows the context past the previous turn of the same thread is new work, the
 * rest is a rewrite (context sent again, e.g. after a cold cache). Output is new work.
 */
export interface TurnSplit {
  readonly growth: number; // context tokens added since the previous turn of the thread
  readonly rewriteTokens: number;
  readonly newWorkUsd: number;
  readonly carryUsd: number;
  readonly rewriteUsd: number;
}

export function splitTurn(turn: Turn, cost: TurnCost, previousContext: number): TurnSplit {
  const context = contextTokens(turn);
  const growth = Math.max(0, context - previousContext);
  const fresh = turn.input + turn.cacheWrite5m + turn.cacheWrite1h;
  const rewriteTokens = Math.max(0, fresh - growth);
  const freshUsd = cost.input + cost.cacheWrite;
  const rewriteUsd = fresh === 0 ? 0 : freshUsd * (rewriteTokens / fresh);
  return {
    growth,
    rewriteTokens,
    newWorkUsd: cost.output + freshUsd - rewriteUsd,
    carryUsd: cost.cacheRead,
    rewriteUsd,
  };
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
    webSearch: turn.webSearches * WEB_SEARCH_USD,
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
  // Efficiency split (splitTurn), only on turns whose thread's previous context is known; 0 in rows indexed
  // before 2026-10-18.
  growth: number; // context growth + output tokens: what "$ per MTok of new work" divides by
  freshSplit: number; // input + cache-write tokens on split turns
  rewriteTokens: number;
  usdNewWork: number;
  usdCarry: number;
  usdRewrite: number;
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
    growth: 0,
    freshSplit: 0,
    rewriteTokens: 0,
    usdNewWork: 0,
    usdCarry: 0,
    usdRewrite: 0,
  };
}

export function rollupUsd(rollup: Rollup): number {
  return (
    rollup.usdInput +
    rollup.usdOutput +
    rollup.usdCacheRead +
    rollup.usdCacheWrite +
    rollup.webSearches * WEB_SEARCH_USD
  );
}

/** Adds `turn` (priced as `cost`) into `rollup` in place. `previousContext` is the context of the thread's
 * previous turn (0 for its first); null when unknown, which skips the efficiency split. */
export function addTurn(
  rollup: Rollup,
  turn: Turn,
  cost: TurnCost | null,
  previousContext: number | null = null,
): void {
  const context = contextTokens(turn);
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
  if (previousContext !== null) {
    const split = splitTurn(turn, cost, previousContext);
    rollup.growth += split.growth + turn.output;
    rollup.freshSplit += turn.input + turn.cacheWrite5m + turn.cacheWrite1h;
    rollup.rewriteTokens += split.rewriteTokens;
    rollup.usdNewWork += split.newWorkUsd;
    rollup.usdCarry += split.carryUsd;
    rollup.usdRewrite += split.rewriteUsd;
  }
}

/** Claude Code's tool-name prefix for an MCP server: `plugin:figma:figma` → `plugin_figma_figma`. */
export function mcpServerKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** MCP servers whose instructions Claude Code put into context (`mcp_instructions_delta` attachment), with an
 * estimated token count (4 characters per token). */
export interface McpLoad {
  readonly sessionId: string;
  readonly servers: Readonly<Record<string, number>>;
}

export function parseMcpLoad(line: string): McpLoad | null {
  if (!line.includes('"mcp_instructions_delta"')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const attachment = entry.attachment as Record<string, unknown> | undefined;
  if (entry.type !== "attachment" || attachment?.type !== "mcp_instructions_delta") return null;
  const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
  const names = list(attachment.addedNames);
  const blocks = list(attachment.addedBlocks);
  const servers: Record<string, number> = {};
  names.forEach((name, i) => {
    if (typeof name !== "string") return;
    const block = blocks[i];
    servers[mcpServerKey(name)] = Math.ceil((typeof block === "string" ? block.length : 0) / 4);
  });
  return { sessionId: str(entry.sessionId, "unknown"), servers };
}

/** MCP servers an assistant line calls (`mcp__<server>__<tool>` tool uses). Every copy of a repeated line
 * is read: each carries a different content block. */
export function mcpServersUsed(line: string): { sessionId: string; servers: Array<string> } | null {
  if (!line.includes('"mcp__')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const content = (entry.message as Record<string, unknown> | undefined)?.content;
  if (entry.type !== "assistant" || !Array.isArray(content)) return null;
  const servers = new Set<string>();
  for (const block of content as ReadonlyArray<Record<string, unknown> | null>) {
    const name = block?.type === "tool_use" ? block.name : null;
    const match = typeof name === "string" ? /^mcp__(.+?)__/.exec(name) : null;
    if (match) servers.add(match[1] as string);
  }
  return servers.size === 0
    ? null
    : { sessionId: str(entry.sessionId, "unknown"), servers: [...servers] };
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
