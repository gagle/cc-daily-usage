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

const money = (usd: number): string => `$${usd.toFixed(2)}`;
const kTok = (tokens: number): string => `${String(Math.round(tokens / 1000))}k`;

export interface NextAction {
  readonly kind: "cold-soon" | "cold" | "deep" | "limits" | "habit";
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
