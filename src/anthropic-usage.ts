import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

import type {
  ApiCache,
  ApiExtraWindow,
  ApiPlan,
  ApiWindow,
} from "./interfaces/config.interface.js";
import { CLAUDE_DIR } from "./statusline-shared.js";

const BASE_API_URL = "https://api.anthropic.com";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const KEYCHAIN_SERVICE_NAME = "Claude Code-credentials";
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, ".credentials.json");
const FETCH_TIMEOUT_MS = 5000;

export interface ResolvedToken {
  readonly token: string;
  readonly expiresAt: number | null;
}

interface CredentialsFile {
  readonly claudeAiOauth?: {
    readonly accessToken?: string;
    readonly expiresAt?: number | null;
  };
}

function isExpired(expiresAt: number | null): boolean {
  return expiresAt !== null && expiresAt <= Date.now();
}

function tokenFromCredentials(raw: CredentialsFile): ResolvedToken | null {
  const accessToken = raw.claudeAiOauth?.accessToken;
  if (!accessToken) return null;
  return { token: accessToken, expiresAt: raw.claudeAiOauth.expiresAt ?? null };
}

function readPlaintextCredentials(): ResolvedToken | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    return tokenFromCredentials(
      JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as CredentialsFile,
    );
  } catch {
    return null;
  }
}

/** macOS only — the same `security find-generic-password` invocation Claude Code's own macOsKeychainStorage
 * uses (service name confirmed against a real Keychain entry). Falls through to the plaintext credentials
 * file on any failure, mirroring Claude Code's own fallback storage. */
function readMacKeychain(): ResolvedToken | null {
  if (process.platform !== "darwin") return null;
  try {
    const output = execFileSync(
      "security",
      ["find-generic-password", "-a", userInfo().username, "-w", "-s", KEYCHAIN_SERVICE_NAME],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return tokenFromCredentials(JSON.parse(output) as CredentialsFile);
  } catch {
    return null;
  }
}

/**
 * Same token resolution order Claude Code itself uses (src/utils/secureStorage/, src/utils/auth.ts): an
 * explicit env override, then macOS Keychain, then the plaintext credentials file (the only path on
 * Linux/Windows, and macOS's own fallback when the Keychain read fails). Never throws. An expired token is
 * treated as unavailable — OAuth refresh is out of scope; Claude Code's own refresh will fix it eventually.
 */
export function resolveOAuthAccessToken(): ResolvedToken | null {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) return { token: envToken, expiresAt: null };

  const resolved = readMacKeychain() ?? readPlaintextCredentials();
  if (!resolved || isExpired(resolved.expiresAt)) return null;
  return resolved;
}

export interface OauthProfile {
  readonly account?: {
    readonly display_name?: string;
    readonly email_address?: string;
    readonly created_at?: string;
  };
  readonly organization?: {
    readonly uuid?: string;
    readonly organization_type?: string;
    readonly rate_limit_tier?: string;
    readonly billing_type?: string;
    readonly has_extra_usage_enabled?: boolean;
    readonly subscription_created_at?: string;
    readonly subscription_status?: string | null;
    readonly claude_code_trial_ends_at?: string | null;
  };
}

export interface ExtraUsage {
  readonly usedCredits: number; // major units (dollars)
  readonly monthlyLimit: number; // major units (dollars)
  readonly utilizationPct: number;
  readonly currency: string;
  readonly spendLimitReached: boolean;
  readonly disabledReason: string | null;
  readonly stale?: boolean; // last good reading served after a failed fetch
}

interface RawWindow {
  readonly utilization?: number | null; // 0-100
  readonly resets_at?: string | null; // ISO 8601
  readonly used_dollars?: number | null;
  readonly limit_dollars?: number | null;
}

/** Observed 2026-10-15 on a Pro account; the endpoint is undocumented, so every field is optional. */
interface RawUsageResponse {
  readonly [key: string]: unknown;
  readonly five_hour?: RawWindow | null;
  readonly seven_day?: RawWindow | null;
  readonly limits?: ReadonlyArray<{
    readonly kind?: string;
    readonly severity?: string | null;
  }> | null;
  readonly seven_day_breakdown?: {
    readonly rows?: ReadonlyArray<{ readonly key?: string; readonly percent?: number }>;
  } | null;
  readonly extra_usage?: {
    readonly is_enabled?: boolean;
    readonly monthly_limit?: number | null;
    readonly used_credits?: number | null;
    readonly utilization?: number | null;
    readonly currency?: string | null;
    readonly decimal_places?: number | null;
    readonly spend_limit_reached?: boolean | null;
    readonly disabled_reason?: string | null;
  } | null;
}

async function fetchJson<T>(url: string, token: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** `GET /api/oauth/profile` — resolves account identity straight from a bearer token, independent of
 * whatever's in `~/.claude.json`. Used when this process overrides the token (a different terminal may be
 * logged into a different account than the global login). */
export async function fetchOauthProfile(token: string): Promise<OauthProfile | null> {
  return fetchJson<OauthProfile>(`${BASE_API_URL}/api/oauth/profile`, token);
}

function parseExtraUsage(raw: RawUsageResponse | null): ExtraUsage | null {
  const extraUsage = raw?.extra_usage;
  if (!extraUsage?.is_enabled) return null;
  if (typeof extraUsage.used_credits !== "number" || typeof extraUsage.monthly_limit !== "number")
    return null;
  const divisor = 10 ** (extraUsage.decimal_places ?? 2);
  return {
    usedCredits: extraUsage.used_credits / divisor,
    monthlyLimit: extraUsage.monthly_limit / divisor,
    utilizationPct: extraUsage.utilization ?? 0,
    currency: extraUsage.currency ?? "USD",
    spendLimitReached: extraUsage.spend_limit_reached ?? false,
    disabledReason: extraUsage.disabled_reason ?? null,
  };
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

function parseWindow(raw: unknown, severity: string | null = null): ApiWindow | null {
  const window = raw as RawWindow | null | undefined;
  if (typeof window?.utilization !== "number") return null;
  const resetsMs = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
  return {
    pct: window.utilization,
    resetsAt: Number.isNaN(resetsMs) ? null : Math.floor(resetsMs / 1000),
    usedDollars: numberOrNull(window.used_dollars),
    limitDollars: numberOrNull(window.limit_dollars),
    severity,
  };
}

/** `limits[]` severity for one kind (`session` = 5h, `weekly_all` = 7d). */
function severityOf(raw: RawUsageResponse, kind: string): string | null {
  const severity = raw.limits?.find((limit) => limit.kind === kind)?.severity;
  return typeof severity === "string" ? severity : null;
}

/** Every other `seven_day_<key>` window that carries a reading (opus, sonnet, cowork, …). */
function parseExtraWindows(raw: RawUsageResponse): Array<ApiExtraWindow> {
  const windows: Array<ApiExtraWindow> = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!name.startsWith("seven_day_")) continue;
    const window = parseWindow(value);
    if (window !== null) windows.push({ key: name.slice("seven_day_".length), ...window });
  }
  return windows;
}

/** Claude Code's share (0-1) of this week's use, from `seven_day_breakdown.rows`; null when absent. */
function parseClaudeCodeShare(raw: RawUsageResponse): number | null {
  const percent = raw.seven_day_breakdown?.rows?.find((row) => row.key === "claude_code")?.percent;
  return typeof percent === "number" ? Math.min(1, Math.max(0, percent / 100)) : null;
}

/** `GET /api/oauth/usage` — the same read-only endpoint Claude Code's own `/usage` calls (no model request, no
 * tokens). Returns null on any fetch/parse failure. `extra_usage` is Anthropic's server-side "Usage credits"
 * ledger; `five_hour`/`seven_day` are the seat windows Claude Code only learns from a model response. */
export async function fetchUsage(
  token: string,
): Promise<Omit<ApiCache, "fetchedAt" | "stale"> | null> {
  const raw = await fetchJson<RawUsageResponse>(`${BASE_API_URL}/api/oauth/usage`, token);
  if (raw === null || typeof raw !== "object") return null;
  return {
    extraUsage: parseExtraUsage(raw),
    fiveHour: parseWindow(raw.five_hour, severityOf(raw, "session")),
    sevenDay: parseWindow(raw.seven_day, severityOf(raw, "weekly_all")),
    extraWindows: parseExtraWindows(raw),
    claudeCodeShare: parseClaudeCodeShare(raw),
  };
}

/** Plan facts from `/api/oauth/profile`, or null on failure. */
export async function fetchPlan(token: string, now: Date): Promise<ApiPlan | null> {
  const organization = (await fetchOauthProfile(token))?.organization;
  if (!organization) return null;
  return {
    fetchedAt: now.getTime(),
    rateLimitTier: organization.rate_limit_tier ?? null,
    subscriptionStatus: organization.subscription_status ?? null,
    billingType: organization.billing_type ?? null,
    trialEndsAt: organization.claude_code_trial_ends_at ?? null,
  };
}

/** The plan is re-read once a day: it changes on an upgrade or a lapse, not by the minute. */
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

/** Back-compat wrapper (exported API): just the usage-credits part of fetchUsage. */
export async function fetchExtraUsage(token: string): Promise<ExtraUsage | null> {
  return (await fetchUsage(token))?.extraUsage ?? null;
}

export const API_CACHE_TTL_MS = 60_000;
/** After failures the wait doubles per failure, up to 2^4 × the TTL (16 min): a 429 or a dead token is not
 * hammered every minute. # ponytail: ignores Retry-After; upgrade path: return the status from fetchJson. */
const MAX_BACKOFF_DOUBLINGS = 4;

/** When the reading a stale cache keeps was taken; absent when no good reading is known. */
function readAtOf(previous: ApiCache | null): { readAt?: number } {
  const readAt = previous?.stale === true ? previous.readAt : previous?.fetchedAt;
  return readAt === undefined ? {} : { readAt };
}

/** Next cache after one fetch attempt: a failure keeps the previous good reading marked `stale` instead of
 * dropping to null — null would put the caller on session-delta accumulation, which can count phantom
 * spend. The plan survives either way; the caller replaces it when it re-reads the profile. */
export function nextApiCache(
  previous: ApiCache | null,
  fetched: Omit<ApiCache, "fetchedAt" | "stale"> | null,
  now: Date,
): ApiCache {
  const plan = previous?.plan === undefined ? {} : { plan: previous.plan };
  if (fetched !== null) return { fetchedAt: now.getTime(), ...plan, ...fetched };
  return {
    extraUsage: null,
    fiveHour: null,
    sevenDay: null,
    ...previous,
    fetchedAt: now.getTime(),
    stale: true,
    ...readAtOf(previous),
    failures: (previous?.failures ?? 0) + 1,
  };
}

export function isApiCacheFresh(cache: ApiCache | null, now: Date): boolean {
  if (cache === null) return false;
  const doublings = Math.min(cache.failures ?? 0, MAX_BACKOFF_DOUBLINGS);
  return now.getTime() - cache.fetchedAt < API_CACHE_TTL_MS * 2 ** doublings;
}
