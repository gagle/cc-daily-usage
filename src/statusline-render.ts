import type { ApiWindow } from "./interfaces/config.interface.js";
import type { HookPayload, StatuslineState } from "./interfaces/statusline.interface.js";
import type { Runway } from "./limits-history.js";
import { gradientRgb } from "./meter.js";
import { type NextAction, nextAction } from "./next-action.js";
import { ratesFor } from "./pricing.js";
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
    bar +=
      i > filled
        ? "\x1b[38;2;60;60;60m█"
        : `\x1b[38;2;${gradientRgb(Math.floor((i * 100) / 20))}m█`;
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

/** Short local time: `5:22pm` / `7pm` on 12-hour locales, `17:22` on 24-hour ones. */
function shortTime(date: Date): string {
  const hour12 = new Intl.DateTimeFormat([], { hour: "numeric" }).resolvedOptions().hour12 === true;
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (!hour12) return `${String(date.getHours()).padStart(2, "0")}:${minutes}`;
  const hour = String(date.getHours() % 12 || 12);
  return `${minutes === "00" ? hour : `${hour}:${minutes}`}${date.getHours() < 12 ? "am" : "pm"}`;
}

/** `5:22pm` today, `Tue 5:22pm` within a week, `Oct 20` after that. */
function shortWhen(epochSeconds: number, now: Date): string {
  const at = new Date(epochSeconds * 1000);
  if (at.toDateString() === now.toDateString()) return shortTime(at);
  if (at.getTime() - now.getTime() < 6 * 24 * 3600 * 1000) {
    return `${at.toLocaleDateString([], { weekday: "short" })} ${shortTime(at)}`;
  }
  return at.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The prompt cache countdown. The line re-renders every 30 s, so under a minute is just `<1m`. */
function countdown(seconds: number): string {
  return seconds >= 60 ? `${String(Math.floor(seconds / 60))}m` : "<1m";
}

/** "1h12m" / "8m" / "5d3h" until an epoch-seconds instant. */
function timeUntil(epochSeconds: number, now: Date): string {
  const minutes = Math.max(1, Math.ceil((epochSeconds * 1000 - now.getTime()) / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${String(hours)}h` : `${String(hours)}h${String(rest)}m`;
  return `${String(Math.floor(hours / 24))}d${String(hours % 24)}h`;
}

interface Notice {
  readonly blocked: boolean; // at the limit: nothing runs until the reset
  readonly text: string;
}

/** The server flags a window (its `limits[]` severity is set and not "normal"). */
function flagged(window: ApiWindow | null | undefined): boolean {
  return typeof window?.severity === "string" && window.severity !== "normal";
}

/** At the limit: when work can continue (`5h full → 5:22pm (1h13m)`). Near it (≥ 90%, or flagged by the
 * server): when it resets. */
function windowNotice(
  label: string,
  pct: number | null,
  resetsAt: number | null,
  now: Date,
  serverFlag = false,
): Notice | null {
  if (pct === null || (pct < 90 && !serverFlag) || !resetsAt) return null;
  const when = `${shortWhen(resetsAt, now)} (${timeUntil(resetsAt, now)})`;
  return pct >= 100
    ? { blocked: true, text: `${label} full → ${when}` }
    : { blocked: false, text: `${label} resets ${when}` };
}

/** Below the 90% notice: a window whose burn rate empties it before reset (`5h out ~5:22pm (1h13m)`). */
function runwayNotice(label: string, runway: Runway | null | undefined, now: Date): Notice | null {
  if (runway?.verdict !== "at-risk" || runway.exhaustsAt === null) return null;
  const when = `${shortWhen(runway.exhaustsAt, now)} (${timeUntil(runway.exhaustsAt, now)})`;
  return { blocked: false, text: `${label} out ~${when}` };
}

/** Model weekly windows worth a slot; the API also sends internal ones (cowork, oauth_apps, codenames). */
const SHOWN_EXTRA_WINDOWS = new Set(["opus", "sonnet"]);

/** `35%/5h`, plus `($1.20/$5)` on a dollar-metered window. */
function windowReading(pct: number, label: string, window: ApiWindow | null | undefined): string {
  const dollars =
    typeof window?.usedDollars === "number" && typeof window.limitDollars === "number"
      ? ` (${money(window.usedDollars)}/${money(window.limitDollars)})`
      : "";
  return `${String(Math.round(pct))}%/${label}${dollars}`;
}

const PERIOD_SUFFIX: Readonly<Record<string, string>> = {
  daily: "/day",
  weekly: "/wk",
  monthly: "/mo",
};

/** `💳 63%`, or `💳 63% $62.80/$100/mo` once the gateway sent the dollar amounts. */
function spendText(pct: number, state: StatuslineState): string {
  const usd = state.spendLimitUsd;
  const dollars = usd
    ? ` ${money(usd.used)}/${money(usd.limit)}${usd.period ? (PERIOD_SUFFIX[usd.period] ?? "") : ""}`
    : "";
  return `💳 ${String(Math.round(pct))}%${dollars}`;
}

function limitsPart(state: StatuslineState): string {
  const { fiveHourPct, sevenDayPct } = state.rateLimits;
  const detail = state.apiDetail;
  const parts: Array<string> = [];
  if (fiveHourPct !== null) parts.push(windowReading(fiveHourPct, "5h", detail?.fiveHour));
  if (sevenDayPct !== null) parts.push(windowReading(sevenDayPct, "7d", detail?.sevenDay));
  for (const window of detail?.extraWindows ?? []) {
    if (SHOWN_EXTRA_WINDOWS.has(window.key)) {
      parts.push(windowReading(window.pct, `7d-${window.key}`, window));
    }
  }
  return rgb("100;180;255", `⏱ ${parts.length > 0 ? parts.join(" ") : "—/5h —/7d"}`);
}

/** Both windows' notices behind one icon: `⚠ 5h out ~5:22pm (1h13m) · 7d resets Tue 7pm (5d3h)`. */
function warningsPart(state: StatuslineState, now: Date): string {
  const { fiveHourPct, sevenDayPct, fiveHourResetsAt, sevenDayResetsAt } = state.rateLimits;
  const detail = state.apiDetail;
  // ≥ 90% first, then a burn rate that empties the window, then only a server flag (its reset time).
  const notice = (
    label: string,
    pct: number | null,
    resetsAt: number | null,
    runway: Runway | null | undefined,
    window: ApiWindow | null | undefined,
  ): Notice | null =>
    windowNotice(label, pct, resetsAt, now) ??
    runwayNotice(label, runway, now) ??
    windowNotice(label, pct, resetsAt, now, flagged(window));
  const notices = [
    notice("5h", fiveHourPct, fiveHourResetsAt, state.runway?.fiveHour, detail?.fiveHour),
    notice("7d", sevenDayPct, sevenDayResetsAt, state.runway?.sevenDay, detail?.sevenDay),
  ].filter((entry): entry is Notice => entry !== null);
  if (notices.length === 0) return "";
  const text = notices.map((notice) => notice.text).join(" · ");
  return notices.some((notice) => notice.blocked)
    ? rgb("220;40;20", `⛔ ${text}`, true)
    : rgb("244;164;96", `⚠ ${text}`);
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
  const month = rgb(
    ccColor(pct),
    `${money(state.monthlySpent ?? 0)}/${money(state.monthlyCap)} (${String(Math.round(pct * 100))}%)`,
  );
  // The ledger fetch fails: the total is the old reading plus this machine's sessions, so say how old.
  const ageMin = Math.floor((state.ledgerAgeMs ?? 0) / 60_000);
  return ageMin >= 1 ? `${month} ${rgb("180;180;180", `${String(ageMin)}m old`)}` : month;
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
 * The current row of the cost-by-context table: what one API request costs now ($/req, cache read) and what a
 * miss would cost (re-writing the whole context), plus the move that avoids paying it.
 *   🔥 cold in 4m · $0.10/req · if cold +$2.40
 *   ❄ cold · next req ~$2.45 · miss: tools changed
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
    parts.push(`${money(cache.nextWarmUsd)}/req`);
    if (cache.missPremiumUsd !== null && cache.missPremiumUsd >= 0.01) {
      parts.push(`if cold +${money(cache.missPremiumUsd)}`);
    }
  } else {
    parts.push("❄ cold");
    parts.push(`next req ~${money(cache.nextColdUsd ?? cache.nextWarmUsd)}`);
  }
  if (cache.misses !== null && cache.misses > 0 && cache.requests !== null && cache.requests > 0) {
    parts.push(`${String(cache.misses)}/${String(cache.requests)} req missed`);
  }
  if (cache.recentMiss !== null) parts.push(`miss: ${cache.recentMiss}`);
  // Cold = the costly case, in the same red as "over budget"; warm fades as the expiry nears.
  const color = cache.warm ? warmColor(cache.secondsUntilCold, cache.ttlSeconds) : ccColor(1);
  return rgb(color, parts.join(" · "));
}

/** `⚠ claude-x: no price, $ not estimated` — a model src/pricing.ts does not know (too old or too new). */
function unpricedPart(payload: HookPayload): string {
  const id = payload.model?.id;
  return id && ratesFor(id) === null ? rgb("244;164;96", `⚠ ${id}: no price, $ not estimated`) : "";
}

/** `» /compact at the next break · 520k re-read each turn, ~$0.10`: the next action, urgent ones in orange. */
function actionPart(action: NextAction): string {
  const urgent = action.kind === "cold-soon" || action.kind === "cold";
  return rgb(urgent ? "244;164;96" : "255;215;0", `» ${action.text}`);
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
  const apiMs = payload.cost?.total_api_duration_ms;
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
        return rgb(
          "220;200;0",
          `${money(payload.cost?.total_cost_usd ?? 0)}${
            state?.promptUsd == null ? "" : ` · prompt ${money(state.promptUsd)}`
          }`,
        );
      case "duration":
        return totalMs === undefined
          ? ""
          : rgb(
              "150;150;150",
              `⏲ ${duration(totalMs)}${apiMs === undefined ? "" : ` · api ${duration(apiMs)}`}`,
            );
      case "model":
        return rgb("200;0;200", `🤖 ${payload.model?.display_name ?? ""}`);
      case "effort":
        return effort ? rgb("150;150;250", `💪 ${effort}`) : "";
      case "cache":
        return (state ? cacheSegment(state) : "") || unpricedPart(payload);
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
      case "coach": {
        const action = nextAction(payload, state);
        return action ? actionPart(action) : "";
      }
      case "spend":
        return state?.spendLimitPct == null
          ? ""
          : rgb(ccColor(state.spendLimitPct / 100), spendText(state.spendLimitPct, state));
    }
  };

  const rows = layout
    .map((row) =>
      row
        .map(part)
        .filter((text) => text !== "")
        .join(` ${SEP} `),
    )
    .filter((row) => row !== "");
  // A `/login` in another terminal moves this session too: say so where it is seen, whatever the layout.
  if (state?.accountSwitch) {
    const marker = rgb("220;200;0", `⇄ ${state.accountSwitch}`, true);
    rows[0] = rows[0] === undefined ? marker : `${marker} ${SEP} ${rows[0]}`;
  }
  return rows.join("\n");
}
