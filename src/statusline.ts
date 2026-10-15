import { accountKey, resolveActiveAccount } from "./account.js";
import { forecastCache } from "./cache-forecast.js";
import {
  addMissCauses,
  applyLedgerReading,
  captureSessionCost,
  classifyHasSpendCap,
  computeToday,
  isLaboralDay,
  rolloverIfNeeded,
} from "./calc.js";
import {
  listNewerFiles,
  loadApiCache,
  loadConfig,
  loadFeedAdvice,
  loadLimitSamples,
  loadSessionsMap,
  loadUsage,
  saveConfig,
  saveLimitSamples,
  saveSessionsMap,
  saveUsage,
} from "./config.js";
import { readGitBranch } from "./git.js";
import type {
  ApiCache,
  ApiWindow,
  RateLimitsCache,
  UsageState,
} from "./interfaces/config.interface.js";
import type {
  HookPayload,
  ResolvedRateLimits,
  StatuslineState,
} from "./interfaces/statusline.interface.js";
import { appendSample, computeRunway, type Runway, usdPerPercentWeek } from "./limits-history.js";
import { requestApiRefresh } from "./refresh.js";
import { recordSession } from "./sessions-map.js";
import { loadLayout } from "./statusline-layout.js";
import { renderStatusline } from "./statusline-render.js";
import {
  FAST_REFRESH_BELOW_SECONDS,
  STATUSLINE_FAST_REFRESH_SECONDS,
  STATUSLINE_REFRESH_SECONDS,
  syncRefreshInterval,
} from "./statusline-shared.js";

export async function readStdin(): Promise<string> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Garbage, a non-object, or an empty stdin is `{}` — a bad payload must never take the line down. */
export function parsePayload(raw: string): HookPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge one Claude Code rate-limit window into the cache.
 * - Window key absent → keep prior pct/resets_at (other side may still refresh this turn).
 * - Window key present → pct is the live used_percentage (or null). resets_at prefers the live value;
 *   if Claude omitted it while pct is still ≥100, keep the prior resets_at so ⚠ can stay visible;
 *   otherwise clear it so a recovered or seeded window cannot keep a stale reset time. */
export function mergeRateLimitWindow(
  incoming: { used_percentage?: number; resets_at?: number } | undefined,
  prevPct: number | null | undefined,
  prevResetsAt: number | null | undefined,
): { pct: number | null; resetsAt: number | null } {
  if (incoming === undefined) {
    return { pct: prevPct ?? null, resetsAt: prevResetsAt ?? null };
  }
  const pct = incoming.used_percentage ?? null;
  if (incoming.resets_at !== undefined) {
    return { pct, resetsAt: incoming.resets_at };
  }
  if (pct !== null && pct >= 100) {
    return { pct, resetsAt: prevResetsAt ?? null };
  }
  return { pct, resetsAt: null };
}

/** A window whose reset time has passed no longer describes current usage (Claude Code drops it too). */
function liveWindow(
  pct: number | null,
  resetsAt: number | null,
  nowSec: number,
): { pct: number | null; resetsAt: number | null } {
  if (resetsAt !== null && resetsAt <= nowSec) return { pct: null, resetsAt: null };
  return { pct, resetsAt };
}

/**
 * Which 5h/7d reading to show: this payload's own `rate_limits` when Claude Code sent them (freshest —
 * straight from the last model response), otherwise whichever is newer of the last hook snapshot and the
 * last `/api/oauth/usage` reading. The API reading is what fixes a new session's stale ⏱: Claude Code only
 * learns the windows from a model response, but the refresher fetches them without spending a token.
 */
export function resolveRateLimits(
  sawHookLimits: boolean,
  cached: RateLimitsCache | undefined,
  api: ApiCache | null,
  now: Date,
): ResolvedRateLimits {
  const nowSec = Math.floor(now.getTime() / 1000);
  const apiUsable = api !== null && (api.fiveHour !== null || api.sevenDay !== null);
  const useApi =
    !sawHookLimits && apiUsable && (cached?.seenAt === undefined || api.fetchedAt > cached.seenAt);
  if (useApi) {
    const five = liveWindow(api.fiveHour?.pct ?? null, api.fiveHour?.resetsAt ?? null, nowSec);
    const seven = liveWindow(api.sevenDay?.pct ?? null, api.sevenDay?.resetsAt ?? null, nowSec);
    return {
      fiveHourPct: five.pct,
      sevenDayPct: seven.pct,
      fiveHourResetsAt: five.resetsAt,
      sevenDayResetsAt: seven.resetsAt,
      source: "api",
    };
  }
  if (!cached) {
    return {
      fiveHourPct: null,
      sevenDayPct: null,
      fiveHourResetsAt: null,
      sevenDayResetsAt: null,
      source: "none",
    };
  }
  const five = liveWindow(cached.fiveHourPct, cached.fiveHourResetsAt, nowSec);
  const seven = liveWindow(cached.sevenDayPct, cached.sevenDayResetsAt, nowSec);
  return {
    fiveHourPct: five.pct,
    sevenDayPct: seven.pct,
    fiveHourResetsAt: five.resetsAt,
    sevenDayResetsAt: seven.resetsAt,
    source: sawHookLimits ? "hook" : "cache",
  };
}

/**
 * Appends the API reading to limits.json when a % changed, then the runway of each window. Only the API
 * reading is sampled: it is account-wide and carries its time, while an idle session keeps sending the
 * `rate_limits` of its last response (old values would read as resets and rises).
 */
function trackLimits(
  key: string,
  api: ApiCache | null,
  apiEqTotal: number,
  now: Date,
): Pick<StatuslineState, "runway" | "usdPerPctWeek"> {
  const samples = loadLimitSamples(key);
  const five = api?.fiveHour ?? null;
  const seven = api?.sevenDay ?? null;
  if (api === null || api.stale === true || (five === null && seven === null)) {
    return {
      runway: { fiveHour: null, sevenDay: null },
      usdPerPctWeek: usdPerPercentWeek(samples, now),
    };
  }
  const last = samples.at(-1);
  const next =
    last !== undefined && api.fetchedAt <= last.t
      ? samples
      : appendSample(samples, {
          t: api.fetchedAt,
          fiveHourPct: five?.pct ?? null,
          sevenDayPct: seven?.pct ?? null,
          fiveHourResetsAt: five?.resetsAt ?? null,
          sevenDayResetsAt: seven?.resetsAt ?? null,
          apiEqTotal,
        });
  if (next !== samples) saveLimitSamples(key, next);
  const runway = (window: "fiveHour" | "sevenDay", reading: ApiWindow | null): Runway | null =>
    reading === null
      ? null
      : computeRunway(next, window, reading.pct, reading.resetsAt, api.fetchedAt, now);
  return {
    runway: { fiveHour: runway("fiveHour", five), sevenDay: runway("sevenDay", seven) },
    usdPerPctWeek: usdPerPercentWeek(next, now),
  };
}

/** The first non-snoozed finding of feed.json (written by the refresher), or null. */
function coachTip(key: string): StatuslineState["coach"] {
  const top = loadFeedAdvice(key).find((finding) => finding.snoozedUntil == null);
  if (typeof top?.title !== "string") return null;
  return {
    title: top.title,
    usd: typeof top.usd === "number" ? top.usd : null,
    window: typeof top.window === "string" ? top.window : "week",
  };
}

/** api-cache.json, or — before the first refresh after upgrading — the v1 cache inside usage.json. */
function apiCacheOrLegacy(key: string, usage: UsageState): ApiCache | null {
  const cache = loadApiCache(key);
  if (cache !== null) return cache;
  const legacy = usage.extraUsageCache;
  if (!legacy) return null;
  return { fetchedAt: legacy.fetchedAt, extraUsage: legacy.data, fiveHour: null, sevenDay: null };
}

/**
 * Everything one render needs, with zero network on the hot path: local files only, plus at most one
 * detached refresher spawn when the API cache is older than its TTL. Account resolution runs fresh on every
 * call, so a mid-session account switch is picked up on the very next render, each scoped to its own
 * accounts/<key>/ config+usage.
 */
export async function buildStatuslineState(
  payload: HookPayload,
  now: Date = new Date(),
): Promise<StatuslineState> {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown-session";
  const rawCost = payload.cost?.total_cost_usd;
  const currentCost = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : 0;

  const account = await resolveActiveAccount();
  const key = accountKey(account);
  let config = loadConfig(key);
  const usage = loadUsage(key, now);

  // organizationType classifies the dollar self-budget (`hasSpendCap`). Seat-window `rate_limits` are
  // separate: Team/Enterprise seats have them too. A recognized organizationType always wins (mismatch
  // re-derives either direction). `rate_limits` may demote an *unrecognized* org's true guess to false
  // (subscription seat, no dollar budget) — never a known enterprise/team classification.
  const sawRateLimits = payload.rate_limits !== undefined;
  const classified = classifyHasSpendCap(account?.organizationType ?? null);
  const mismatch = classified !== undefined && classified !== config.hasSpendCap;
  if (
    config.hasSpendCap === undefined ||
    mismatch ||
    (sawRateLimits && config.hasSpendCap && classified === undefined)
  ) {
    config = {
      ...config,
      planType: account?.organizationType ?? config.planType ?? null,
      hasSpendCap: classified ?? (sawRateLimits ? false : (config.hasSpendCap ?? true)),
    };
    saveConfig(key, config);
  } else if (account?.organizationType && config.planType !== account.organizationType) {
    config = { ...config, planType: account.organizationType };
    saveConfig(key, config);
  }

  // Claude Code attaches `rate_limits` only after the session's first model response. Keep the last-seen
  // snapshot (with when it was seen) so later renders can fall back; an absent window keeps its prior side.
  if (payload.rate_limits) {
    const prev = usage.rateLimitsCache;
    const five = mergeRateLimitWindow(
      payload.rate_limits.five_hour,
      prev?.fiveHourPct,
      prev?.fiveHourResetsAt,
    );
    const seven = mergeRateLimitWindow(
      payload.rate_limits.seven_day,
      prev?.sevenDayPct,
      prev?.sevenDayResetsAt,
    );
    const changed =
      !prev ||
      prev.fiveHourPct !== five.pct ||
      prev.sevenDayPct !== seven.pct ||
      prev.fiveHourResetsAt !== five.resetsAt ||
      prev.sevenDayResetsAt !== seven.resetsAt;
    if (changed) {
      usage.rateLimitsCache = {
        fiveHourPct: five.pct,
        sevenDayPct: seven.pct,
        fiveHourResetsAt: five.resetsAt,
        sevenDayResetsAt: seven.resetsAt,
        seenAt: now.getTime(),
      };
    }
  }

  const api = apiCacheOrLegacy(key, usage);
  const extraUsage = api?.extraUsage ?? null;

  // A confirmed no-spend-cap account (Pro/Max) has nothing for rollover to compute.
  if (config.hasSpendCap !== false) rolloverIfNeeded(usage, now, extraUsage?.usedCredits ?? null);

  // When the ledger is present it is the authoritative month total for dollar-cap accounts: Claude's
  // cost.total_cost_usd can invent phantom spend on a brand-new session id, so session deltas only fold
  // into monthlySpent when the credits ledger is unavailable.
  const accumulateSessions = config.hasSpendCap === true && extraUsage === null;
  captureSessionCost(usage, sessionId, currentCost, now, accumulateSessions);
  let capSource: "anthropic" | "local" = "local";
  if (config.hasSpendCap === true && extraUsage !== null) {
    applyLedgerReading(usage, extraUsage.usedCredits, now);
    // Anthropic's monthly_limit is the source of truth for the cap — an admin change lands within one TTL.
    if (extraUsage.monthlyLimit > 0) {
      capSource = "anthropic";
      if (extraUsage.monthlyLimit !== config.monthlyCap) {
        config = { ...config, monthlyCap: extraUsage.monthlyLimit };
        saveConfig(key, config);
      }
    }
  }

  const cache = forecastCache(payload, Math.floor(now.getTime() / 1000));
  const session = usage.sessions[sessionId];
  if (cache && session) {
    const cacheGate = {
      expiresAt: cache.expiresAt,
      coldUsd: cache.nextColdUsd,
      warmUsd: cache.nextWarmUsd,
    };
    // Like the cost capture: a lower cumulative miss $ than last seen is a reset, all of it new.
    const priorMissUsd = session.cacheMissUsd ?? 0;
    const missUsdDelta =
      cache.sessionMissUsd >= priorMissUsd
        ? cache.sessionMissUsd - priorMissUsd
        : cache.sessionMissUsd;
    const missCounts = addMissCauses(
      usage,
      session.missCounts,
      payload.prompt_cache?.miss_causes ?? session.missCounts ?? {},
      missUsdDelta,
      now,
    );
    // saveUsage skips the write when the serialized file is unchanged.
    usage.sessions[sessionId] = {
      ...session,
      cacheMissUsd: cache.sessionMissUsd,
      cacheGate,
      missCounts,
    };
  }
  saveUsage(key, usage);

  const sessions = loadSessionsMap(key);
  const nextSessions = recordSession(
    sessions,
    sessionId,
    {
      transcriptPath: typeof payload.transcript_path === "string" ? payload.transcript_path : null,
      costUsd: currentCost,
      linesAdded: payload.cost?.total_lines_added ?? 0,
      linesRemoved: payload.cost?.total_lines_removed ?? 0,
    },
    now,
  );
  if (nextSessions !== sessions) saveSessionsMap(key, nextSessions);

  const rateLimits = resolveRateLimits(sawRateLimits, usage.rateLimitsCache, api, now);
  const limits = trackLimits(key, api, usage.apiEqTotal, now);
  const fastRefresh =
    cache?.secondsUntilCold != null && cache.secondsUntilCold <= FAST_REFRESH_BELOW_SECONDS;
  try {
    syncRefreshInterval(fastRefresh ? STATUSLINE_FAST_REFRESH_SECONDS : STATUSLINE_REFRESH_SECONDS);
  } catch {
    // An unreadable settings.json only costs the live countdown.
  }

  // No OAuth login (API-key user) → the usage endpoint has nothing to say; don't spawn refreshers for it.
  if (account !== null || process.env.CLAUDE_CODE_OAUTH_TOKEN) requestApiRefresh(key, now);

  const computed = computeToday(usage, config, now);
  const showTodayPace = config.hasSpendCap !== false && isLaboralDay(config, now);
  const spendLimit = payload.rate_limits?.spend_limit?.used_percentage;
  return {
    // Dollar self-budget: omitted entirely for Pro/Max. todayUsage always ships so off-days still show
    // spent-today; avgPerDay/todayUsedPct only on laboral days (pace vs max).
    ...(config.hasSpendCap === false
      ? {}
      : {
          todayUsage: computed.todayUsage,
          ...(showTodayPace
            ? {
                avgPerDay: computed.avgPerDay,
                todayUsedPct: computed.todayUsedPct,
                budgetExhausted: computed.avgPerDay === 0,
              }
            : {}),
          monthlySpent: computed.monthlySpent,
          monthlyCap: computed.monthlyCap,
          monthUsedPct: computed.monthUsedPct,
          // Before `init` ever picked laboral days the today/month segments are meaningless — nudge instead.
          needsInit: Object.keys(config.laboralDays).length === 0,
          capSource,
        }),
    // Pro/Max only — enterprise hides 🎫 to avoid duplicating $month.
    extraUsage: config.hasSpendCap === false ? extraUsage : null,
    rateLimits,
    ...limits,
    coach: coachTip(key),
    rateLimitsCache: usage.rateLimitsCache ?? null,
    spendLimitPct: typeof spendLimit === "number" ? spendLimit : null,
    cache,
    hasSpendCap: config.hasSpendCap === true, // always resolved by the classification above
    planType: config.planType ?? null,
  };
}

/** Hidden `--statusline`: one JSON line (StatuslineState). Kept for shims installed by older versions. */
export async function runStatuslineJson(raw?: string): Promise<number> {
  const payload = parsePayload(raw ?? (await readStdin()));
  process.stdout.write(`${JSON.stringify(await buildStatuslineState(payload))}\n`);
  return 0;
}

/** Hidden `--statusline-line` and the installed shim's entry point: the finished ANSI line. A failure in
 * the budget pipeline still prints the session part of the line. */
export async function runStatuslineLine(raw?: string): Promise<number> {
  const payload = parsePayload(raw ?? (await readStdin()));
  const now = new Date();
  let state: StatuslineState | null;
  try {
    state = await buildStatuslineState(payload, now);
  } catch {
    state = null;
  }
  const cwd = payload.workspace?.current_dir ?? payload.cwd ?? "";
  const line = renderStatusline(payload, state, readGitBranch(cwd), now, loadLayout());
  // A file from a newer version is left alone; say so instead of quietly showing old numbers.
  process.stdout.write(listNewerFiles().length > 0 ? `⚠ update cc-daily-usage | ${line}` : line);
  return 0;
}
