import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

import type { UsageState } from "./interfaces/config.interface.js";
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

interface RawUsageResponse {
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

/** `GET /api/oauth/usage` — same endpoint that already backs Claude Code's own `⏱ 5h/7d` rate-limit display;
 * this reads its `extra_usage` field (Anthropic's server-side "Usage credits" ledger). Returns null when
 * extra usage isn't enabled for this account, or on any fetch/parse failure. */
export async function fetchExtraUsage(token: string): Promise<ExtraUsage | null> {
  return parseExtraUsage(
    await fetchJson<RawUsageResponse>(`${BASE_API_URL}/api/oauth/usage`, token),
  );
}

const EXTRA_USAGE_CACHE_TTL_MS = 60_000;

/** Throttles the usage fetch to at most once per TTL window, cached on the per-account usage.json — a
 * statusline can redraw on every keystroke; this keeps that from hammering Anthropic's endpoint on every
 * single render. A failed fetch (network, 401, 429) keeps the last good reading, marked `stale`, instead of
 * caching null — null would drop the caller onto session-delta accumulation, which can count phantom spend.
 * Mutates `usage.extraUsageCache` in place, matching calc.ts's mutation style. */
export async function getCachedExtraUsage(
  usage: UsageState,
  token: string,
  nowUtc: Date,
): Promise<ExtraUsage | null> {
  const cache = usage.extraUsageCache;
  if (cache && nowUtc.getTime() - cache.fetchedAt < EXTRA_USAGE_CACHE_TTL_MS) {
    return cache.data;
  }
  const raw = await fetchJson<RawUsageResponse>(`${BASE_API_URL}/api/oauth/usage`, token);
  const data = raw === null && cache?.data ? { ...cache.data, stale: true } : parseExtraUsage(raw);
  usage.extraUsageCache = { fetchedAt: nowUtc.getTime(), data };
  return data;
}
