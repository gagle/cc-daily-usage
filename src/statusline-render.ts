import type { HookPayload, StatuslineState } from "./interfaces/statusline.interface.js";
import { DEFAULT_LAYOUT, type Layout, type PartId } from "./statusline-layout.js";

const RESET = "\x1b[0m";
const SEP = "\x1b[2;38;2;120;120;120m|\x1b[0m";

function rgb(color: string, text: string, bold = false): string {
  return `\x1b[${bold ? "1;" : ""}38;2;${color}m${text}${RESET}`;
}

/** colorForPct's 5-bucket thresholds (src/calc.ts), as ANSI rgb triplets. */
export function ccColor(fraction: number): string {
  if (fraction >= 1) return "248;105;107";
  if (fraction >= 0.75) return "244;164;96";
  if (fraction >= 0.5) return "255;235;132";
  if (fraction >= 0.25) return "161;215;106";
  return "99;190;123";
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** 20-cell context bar, cells colored by position on the full bar so low % stays green. */
function contextBar(pct: number): string {
  const filled = Math.min(Math.floor(pct / 5), 20);
  let bar = "";
  for (let i = 1; i <= 20; i++) {
    if (i > filled) {
      bar += "\x1b[38;2;60;60;60m█";
      continue;
    }
    const frac = Math.floor((i * 100) / 20);
    let r: number;
    let g: number;
    let b: number;
    if (frac <= 50) {
      const t = frac * 2;
      r = Math.floor((220 * t) / 100);
      g = 200;
      b = Math.floor(80 - (80 * t) / 100);
    } else {
      const t = (frac - 50) * 2;
      r = 220;
      g = Math.floor(200 - (160 * t) / 100);
      b = Math.floor((20 * t) / 100);
    }
    bar += `\x1b[38;2;${String(r)};${String(g)};${String(b)}m█`;
  }
  return bar + RESET;
}

function contextEmoji(pct: number): { emoji: string; color: string } {
  if (pct < 20) return { emoji: "🟢", color: "0;200;80" };
  if (pct < 70) return { emoji: "⚡", color: "220;200;0" };
  if (pct < 90) return { emoji: "🔥", color: "230;120;0" };
  return { emoji: "🚨", color: "220;40;20" };
}

function duration(totalMs: number): string {
  const totalSec = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return hours > 0
    ? `${String(hours)}h ${String(minutes)}m`
    : `${String(minutes)}m ${String(seconds)}s`;
}

function formatResetTime(epochSeconds: number, now: Date): string {
  const reset = new Date(epochSeconds * 1000);
  const time = reset.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (reset.toDateString() === now.toDateString()) return time;
  return `${reset.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function countdown(seconds: number): string {
  if (seconds >= 60) return `${String(Math.floor(seconds / 60))}m`;
  return `${String(seconds)}s`;
}

/** "1h 12m" / "8m" until an epoch-seconds instant. */
function timeUntil(epochSeconds: number, now: Date): string {
  const minutes = Math.max(1, Math.ceil((epochSeconds * 1000 - now.getTime()) / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
}

/** At the limit: when work can continue. Near it (≥ 90%): when the window frees up. */
function windowNotice(
  label: string,
  pct: number | null,
  resetsAt: number | null,
  now: Date,
): string {
  if (pct === null || pct < 90 || !resetsAt) return "";
  const when = `${formatResetTime(resetsAt, now)} (in ${timeUntil(resetsAt, now)})`;
  return pct >= 100
    ? rgb("220;40;20", `⛔ ${label} limit · continue at ${when}`, true)
    : rgb("244;164;96", `⚠ ${label} resets ${when}`);
}

function limitsPart(state: StatuslineState): string {
  const { fiveHourPct, sevenDayPct } = state.rateLimits;
  const parts: Array<string> = [];
  if (fiveHourPct !== null) parts.push(`${String(Math.round(fiveHourPct))}%/5h`);
  if (sevenDayPct !== null) parts.push(`${String(Math.round(sevenDayPct))}%/7d`);
  return rgb("100;180;255", `⏱ ${parts.length > 0 ? parts.join(" ") : "—/5h —/7d"}`);
}

function warningsPart(state: StatuslineState, now: Date): string {
  const { fiveHourPct, sevenDayPct, fiveHourResetsAt, sevenDayResetsAt } = state.rateLimits;
  return [
    windowNotice("5h", fiveHourPct, fiveHourResetsAt, now),
    windowNotice("weekly", sevenDayPct, sevenDayResetsAt, now),
  ]
    .filter((notice) => notice !== "")
    .join(` ${SEP} `);
}

function todayPart(state: StatuslineState): string {
  if (state.needsInit) return rgb("220;200;0", "⚠ run: cc-daily-usage init");
  const today = state.todayUsage ?? 0;
  if (state.budgetExhausted) return rgb("248;105;107", `${money(today)}/$0.00 (over)`);
  if (state.avgPerDay !== undefined && state.avgPerDay !== null) {
    const pct = state.todayUsedPct ?? 0;
    return rgb(
      ccColor(pct),
      `${money(today)}/${money(state.avgPerDay)} (${String(Math.round(pct * 100))}%)`,
    );
  }
  return state.todayUsage !== undefined ? rgb("180;180;180", money(today)) : "";
}

function monthPart(state: StatuslineState): string {
  if (state.needsInit || state.monthlyCap === undefined) return "";
  const pct = state.monthUsedPct ?? 0;
  return rgb(
    ccColor(pct),
    `${money(state.monthlySpent ?? 0)}/${money(state.monthlyCap)} (${String(Math.round(pct * 100))}%)`,
  );
}

function creditsPart(state: StatuslineState): string {
  const extra = state.extraUsage;
  if (!extra) return "";
  const pct = extra.utilizationPct / 100;
  return rgb(
    ccColor(pct),
    `🎫 ${money(extra.usedCredits)}/${money(extra.monthlyLimit)} (${String(Math.round(pct * 100))}%)`,
  );
}

const GREEN: readonly [number, number, number] = [99, 190, 123];
const YELLOW: readonly [number, number, number] = [255, 235, 132];
const ORANGE: readonly [number, number, number] = [244, 164, 96];

function mix(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number,
): string {
  const channel = (a: number, b: number): string => String(Math.round(a + (b - a) * t));
  return `${channel(from[0], to[0])};${channel(from[1], to[1])};${channel(from[2], to[2])}`;
}

/** Warm-cache color by how much of the TTL is left: green (fresh) → yellow (half) → orange (about to go
 * cold). Unknown expiry counts as fresh. */
export function warmColor(secondsUntilCold: number | null, ttlSeconds: number): string {
  const left =
    secondsUntilCold === null ? 1 : Math.min(1, Math.max(0, secondsUntilCold / ttlSeconds));
  return left >= 0.5 ? mix(YELLOW, GREEN, (left - 0.5) * 2) : mix(ORANGE, YELLOW, left * 2);
}

/**
 * The current row of the cost-by-context table: what one message costs now ($/msg, cache read) and what a
 * miss would cost (re-writing the whole context), plus the move that avoids paying it.
 *   🔥 cold in 4m · $0.10/msg · if cold +$2.40 · → /compact before a break
 *   ❄ cold · next msg ~$2.45 · → /clear (free)
 */
function cacheSegment(state: StatuslineState): string {
  const cache = state.cache;
  if (!cache) return "";
  const parts: Array<string> = [];
  if (cache.warm) {
    parts.push(
      cache.secondsUntilCold === null
        ? "🔥 warm"
        : `🔥 cold in ${countdown(cache.secondsUntilCold)}`,
    );
    parts.push(`${money(cache.nextWarmUsd)}/msg`);
    if (cache.missPremiumUsd !== null && cache.missPremiumUsd >= 0.01) {
      parts.push(`if cold +${money(cache.missPremiumUsd)}`);
    }
  } else {
    parts.push("❄ cold");
    parts.push(`next msg ~${money(cache.nextColdUsd ?? cache.nextWarmUsd)}`);
  }
  if (cache.hint === "break") parts.push("→ /compact before a break");
  else if (cache.hint === "clear") parts.push("→ /clear (free)");
  else if (cache.hint === "compact") parts.push("→ /compact");
  // Cold = the costly case, in the same red as "over budget"; warm fades as the expiry nears.
  const color = cache.warm ? warmColor(cache.secondsUntilCold, cache.ttlSeconds) : ccColor(1);
  return rgb(color, parts.join(" · "));
}

/**
 * The whole statusline as ANSI text: each row of `layout` is its parts joined by `|`, rows joined by
 * newlines (Claude Code shows each line as a row). Pure: every input comes from the hook payload, the
 * computed state and the branch — each part is guarded on its own data, so a missing field hides one part
 * (and a row with nothing to show is dropped) and never breaks the line.
 */
export function renderStatusline(
  payload: HookPayload,
  state: StatuslineState | null,
  branch: string,
  now: Date,
  layout: Layout = DEFAULT_LAYOUT,
): string {
  const pct = Math.trunc(payload.context_window?.used_percentage ?? 0) || 0;
  const { emoji, color } = contextEmoji(pct);
  const totalMs = payload.cost?.total_duration_ms;
  const effort = payload.effort?.level;
  // Pro/Max parts and budget parts never show together: the plan picks one family.
  const subscription = state !== null && !state.hasSpendCap;
  const budget = state !== null && state.hasSpendCap;

  const part = (id: PartId): string => {
    switch (id) {
      // No repo name: Claude Code already shows the project; the branch is the part that changes.
      case "branch":
        return branch ? rgb("0;200;200", `(🌿 ${branch})`, true) : "";
      case "context":
        return `${contextBar(pct)} ${emoji} ${rgb(color, `${String(pct)}%`)}`;
      case "cost":
        return rgb("220;200;0", money(payload.cost?.total_cost_usd ?? 0));
      case "duration":
        return totalMs === undefined ? "" : rgb("150;150;150", `⏲ ${duration(totalMs)}`);
      case "model":
        return rgb("200;0;200", `🤖 ${payload.model?.display_name ?? ""}`);
      case "effort":
        return effort ? rgb("150;150;250", `💪 ${effort}`) : "";
      case "cache":
        return state ? cacheSegment(state) : "";
      case "limits":
        return subscription ? limitsPart(state) : "";
      case "warnings":
        return subscription ? warningsPart(state, now) : "";
      case "credits":
        return subscription ? creditsPart(state) : "";
      case "today":
        return budget ? todayPart(state) : "";
      case "month":
        return budget ? monthPart(state) : "";
      case "spend":
        return state?.spendLimitPct == null
          ? ""
          : rgb(
              ccColor(state.spendLimitPct / 100),
              `💳 ${String(Math.round(state.spendLimitPct))}%`,
            );
    }
  };

  return layout
    .map((row) =>
      row
        .map(part)
        .filter((text) => text !== "")
        .join(` ${SEP} `),
    )
    .filter((row) => row !== "")
    .join("\n");
}
