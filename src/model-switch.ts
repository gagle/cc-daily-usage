import { accountKey, resolveActiveAccount } from "./account.js";
import { loadConfig } from "./config.js";
import { DEFAULT_GATE_MIN_USD } from "./prompt-gate.js";
import { readStdin } from "./statusline.js";

/** The PreModelSwitch fields this hook reads (Claude Code v2.1.251+). */
interface ModelSwitchPayload {
  readonly to_model?: string;
  readonly context_tokens?: number;
  readonly prompt_cache_warm?: boolean;
  readonly estimated_cache_write_usd?: number;
}

/** What the hook prints: ask for confirmation, or only show the cost. */
export type ModelSwitchOutput =
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: "PreModelSwitch";
        readonly permissionDecision: "ask";
        readonly permissionDecisionReason: string;
      };
    }
  | { readonly systemMessage: string };

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Each model has its own prompt cache, so a switch re-sends the whole conversation uncached. Claude Code
 * prices that re-send (`estimated_cache_write_usd`); this only decides what to do with the figure: a switch
 * that throws away a warm cache and costs at least `minUsd` asks first, any other priced switch only shows
 * the cost. Nothing to price (no estimate, under a cent) → null, Claude Code's own flow.
 */
export function decideModelSwitch(
  payload: ModelSwitchPayload,
  minUsd: number,
): ModelSwitchOutput | null {
  const usd = payload.estimated_cache_write_usd;
  if (typeof usd !== "number" || usd < 0.01) return null;
  const tokens = Math.round((payload.context_tokens ?? 0) / 1000);
  const cost = `re-sends ${String(tokens)}k tokens uncached: ~${money(usd)}`;
  const target = payload.to_model ?? "the new model";
  if (payload.prompt_cache_warm === true && minUsd > 0 && usd >= minUsd) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreModelSwitch",
        permissionDecision: "ask",
        permissionDecisionReason: `Switching to ${target} ${cost}, and the current warm cache is lost. Continue?`,
      },
    };
  }
  return { systemMessage: `cc-daily-usage: switching to ${target} ${cost}.` };
}

/** Hidden `--model-switch`: the PreModelSwitch hook entry point. Never throws and always exits 0 — a broken
 * hook must not block a switch (a timed-out PreModelSwitch hook blocks it). */
export async function runModelSwitch(raw?: string): Promise<number> {
  try {
    const text = raw ?? (await readStdin());
    const parsed: unknown = JSON.parse(text);
    const payload =
      parsed !== null && typeof parsed === "object" ? (parsed as ModelSwitchPayload) : {};
    const config = loadConfig(accountKey(await resolveActiveAccount()));
    const output = decideModelSwitch(payload, config.promptGateMinUsd ?? DEFAULT_GATE_MIN_USD);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // Allow: Claude Code's own flow.
  }
  return 0;
}
