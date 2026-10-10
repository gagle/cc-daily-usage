import { accountKey, resolveActiveAccount } from "./account.js";
import { loadConfig, loadUsage, saveUsage } from "./config.js";
import { readStdin } from "./statusline.js";

/** Default: block a cold-cache prompt whose re-cache costs at least this much. */
export const DEFAULT_GATE_MIN_USD = 1;
/** A re-submit within this window after a block goes through (the user confirmed). */
const CONFIRM_WINDOW_MS = 2 * 60 * 1000;

interface PromptPayload {
  readonly session_id?: string;
  readonly prompt?: string;
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export type GateDecision =
  { readonly kind: "allow" } | { readonly kind: "block"; readonly reason: string };

/**
 * UserPromptSubmit gate: a prompt sent while the prompt cache is cold re-writes the whole conversation. A
 * blocked prompt is never sent, so blocking costs $0. Slash commands always pass (`/clear` is the free way
 * out). State comes from what the statusline last saved for this session — no network, no tokens.
 */
export async function decidePromptGate(
  payload: PromptPayload,
  now: Date = new Date(),
): Promise<GateDecision> {
  const sessionId = payload.session_id;
  if (!sessionId || (payload.prompt ?? "").trimStart().startsWith("/")) return { kind: "allow" };

  const key = accountKey(await resolveActiveAccount());
  const config = loadConfig(key);
  const minUsd = config.promptGateMinUsd ?? DEFAULT_GATE_MIN_USD;
  const usage = loadUsage(key, now);
  const session = usage.sessions[sessionId];
  const gate = session?.cacheGate;
  if (!session || !gate || minUsd <= 0 || gate.coldUsd === null) return { kind: "allow" };

  const cold = gate.expiresAt === null || gate.expiresAt <= now.getTime() / 1000;
  if (!cold || gate.coldUsd < minUsd) return { kind: "allow" };

  const armedAt = session.gateArmedAt;
  if (armedAt !== undefined && now.getTime() - armedAt <= CONFIRM_WINDOW_MS) {
    usage.sessions[sessionId] = { ...session, gateArmedAt: undefined };
    saveUsage(key, usage);
    return { kind: "allow" };
  }
  usage.sessions[sessionId] = { ...session, gateArmedAt: now.getTime() };
  saveUsage(key, usage);
  return {
    kind: "block",
    reason: [
      `❄ cc-daily-usage: the prompt cache is cold. This message re-sends the whole conversation:`,
      `   ~${money(gate.coldUsd)} instead of ~${money(gate.warmUsd)}.`,
      `   • Send it again within 2 min to go ahead.`,
      `   • Or /clear (free) and continue from a short summary. (/compact now would pay the re-send too.)`,
      `   Turn off: set "promptGateMinUsd": 0 in ~/.config/cc-daily-usage/accounts/${key}/config.json`,
    ].join("\n"),
  };
}

/** Hidden `--prompt-gate`: the hook entry point. Prints the block JSON, or nothing to allow. Never throws —
 * a broken gate must not stop the user from prompting. */
export async function runPromptGate(raw?: string): Promise<number> {
  try {
    const text = raw ?? (await readStdin());
    const parsed: unknown = JSON.parse(text);
    const payload = parsed !== null && typeof parsed === "object" ? (parsed as PromptPayload) : {};
    const decision = await decidePromptGate(payload);
    if (decision.kind === "block") {
      process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
    }
  } catch {
    // Allow.
  }
  return 0;
}
