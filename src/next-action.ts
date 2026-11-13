import type { HookPayload, StatuslineState } from "./interfaces/statusline.interface.js";

/**
 * The statusline's next action: one short line, the thing worth doing now, most urgent first. Uses only what
 * the render already has (cache forecast, context, runway, the top weekly finding). Pure and Node-free.
 */

/** Warn this long before the cache goes cold. */
export const COLD_SOON_S = 90;
/** Below this the $ is not worth an interruption. */
export const MIN_ACTION_USD = 0.05;
/** A cold re-write worth stopping for before the next prompt. */
export const COLD_ACTION_USD = 0.5;
/** Context past this is re-read every turn at a cost worth a /compact (the advisor's aim). */
export const DEEP_CONTEXT_TOKENS = 150_000;

/**
 * Claude Code's auto-compact trigger (v2.1.319): window − min(max output, 20k) − 13k, so 167k on a 200k
 * window and 967k on 1M. Its own "% until auto-compact" countdown starts 20k before that.
 * ponytail: assumes the default window; an `autoCompactWindow` / `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` the hook
 * payload does not carry compacts sooner (Claude Code's `used_percentage` ignores them too).
 */
export const autoCompactAt = (windowTokens: number): number => windowTokens - 20_000 - 13_000;
export const AUTO_COMPACT_SOON_TOKENS = 20_000;

const money = (usd: number): string => `$${usd.toFixed(2)}`;
const kTok = (tokens: number): string => `${String(Math.round(tokens / 1000))}k`;

export interface NextAction {
  readonly kind: "cold-soon" | "cold" | "auto-compact" | "deep" | "limits" | "habit";
  readonly text: string;
}

export function nextAction(payload: HookPayload, state: StatuslineState | null): NextAction | null {
  if (state === null) return null;
  const cache = state.cache;
  if (cache !== null) {
    const premium = cache.missPremiumUsd ?? 0;
    if (
      cache.warm &&
      cache.secondsUntilCold !== null &&
      cache.secondsUntilCold <= COLD_SOON_S &&
      premium >= MIN_ACTION_USD
    ) {
      return {
        kind: "cold-soon",
        text: `send now or /compact · cache cold in ${String(cache.secondsUntilCold)}s, then +${money(premium)}`,
      };
    }
    const cold = cache.nextColdUsd ?? 0;
    if (!cache.warm && cold >= COLD_ACTION_USD) {
      return {
        kind: "cold",
        text: "new task? /clear · same task? /compact first",
      };
    }
  }
  const tokens = payload.context_window?.total_input_tokens ?? 0;
  const windowTokens = payload.context_window?.context_window_size ?? 0;
  if (windowTokens > 0 && tokens > 0) {
    const at = autoCompactAt(windowTokens);
    if (tokens >= at - AUTO_COMPACT_SOON_TOKENS) {
      return {
        kind: "auto-compact",
        text: `/compact now, with a focus · auto-compact ${tokens >= at ? "next turn" : `in ${kTok(at - tokens)}`} (at ${kTok(at)})`,
      };
    }
  }
  if (tokens >= DEEP_CONTEXT_TOKENS && cache !== null && cache.nextWarmUsd >= MIN_ACTION_USD / 5) {
    return {
      kind: "deep",
      text: `/compact at the next break · ${kTok(tokens)} re-read each turn, ~${money(cache.nextWarmUsd)}`,
    };
  }
  const runway = state.runway;
  if (runway?.fiveHour?.verdict === "at-risk" || runway?.sevenDay?.verdict === "at-risk") {
    return {
      kind: "limits",
      text: "/model sonnet for routine steps · keep Opus for the hard ones",
    };
  }
  const coach = state.coach;
  if (coach) {
    const usd = coach.usd === null ? "" : ` · ~${money(coach.usd)}/${coach.window}`;
    return { kind: "habit", text: `${coach.action ?? coach.title}${usd}` };
  }
  return null;
}
