import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { fetchOauthProfile } from "./anthropic-usage.js";

// Sibling to ~/.claude/ (CLAUDE_DIR in statusline-shared.ts), not inside it.
const CLAUDE_JSON_FILE = path.join(homedir(), ".claude.json");

export interface Account {
  readonly email: string | null;
  readonly accountUuid: string | null;
  readonly organizationType: string | null;
}

interface RawOauthAccount {
  readonly emailAddress?: string;
  readonly accountUuid?: string;
  readonly organizationType?: string;
}

/** Sync-only resolution — just `~/.claude.json`'s global `oauthAccount`, no per-session token-override
 * lookup (that path needs a network call — see resolveActiveAccount). Used by callers that can't await, e.g.
 * the calendar's Ink `useState` initializer. */
export function resolveActiveAccountSync(): Account | null {
  return readGlobalOauthAccount();
}

function readGlobalOauthAccount(): Account | null {
  if (!existsSync(CLAUDE_JSON_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_JSON_FILE, "utf8")) as {
      readonly oauthAccount?: RawOauthAccount;
    };
    const oauthAccount = raw.oauthAccount;
    if (!oauthAccount) return null;
    return {
      email: oauthAccount.emailAddress ?? null,
      accountUuid: oauthAccount.accountUuid ?? null,
      organizationType: oauthAccount.organizationType ?? null,
    };
  } catch {
    return null;
  }
}

// Profile lookups for a CLAUDE_CODE_OAUTH_TOKEN override, keyed by a token hash (never the token itself) —
// the network call then happens once per token instead of once per statusline render.
const PROFILE_CACHE_FILE = path.join(homedir(), ".config", "cc-spend", "profiles.json");

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function readProfileCache(): Record<string, Account> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(PROFILE_CACHE_FILE, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, Account>) : {};
  } catch {
    return {};
  }
}

function writeProfileCache(cache: Record<string, Account>): void {
  try {
    mkdirSync(path.dirname(PROFILE_CACHE_FILE), { recursive: true });
    writeFileSync(PROFILE_CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    // A read-only home only costs the cache, not the lookup.
  }
}

/**
 * Resolves whichever account is active for THIS process. A per-session `CLAUDE_CODE_OAUTH_TOKEN` override
 * — a different terminal may be logged into a different account than the global login — takes precedence
 * over `~/.claude.json`'s `oauthAccount`, resolved via `/api/oauth/profile` once per token and cached in
 * profiles.json. Falls back to the global file otherwise, or when the profile fetch fails. Never throws.
 */
export async function resolveActiveAccount(): Promise<Account | null> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) {
    const hash = tokenHash(envToken);
    const cache = readProfileCache();
    const cached = cache[hash];
    if (cached) return cached;
    const profile = await fetchOauthProfile(envToken);
    if (profile) {
      const account: Account = {
        email: profile.account?.email_address ?? null,
        accountUuid: profile.organization?.uuid ?? null,
        organizationType: profile.organization?.organization_type ?? null,
      };
      writeProfileCache({ ...cache, [hash]: account });
      return account;
    }
    // Override present but the fetch failed (offline, expired, ...) — fall through to the global file
    // rather than losing account scoping entirely.
  }
  return readGlobalOauthAccount();
}

export interface OverageCreditGrantInfo {
  readonly available: boolean;
  readonly eligible: boolean;
  readonly granted: boolean;
  readonly amount_minor_units: number | null;
  readonly currency: string | null;
}

/** Reads Claude Code's own already-fetched overage-credit-grant cache straight out of `~/.claude.json` —
 * never fetches it ourselves (Claude Code refreshes it on its own upsell-surface cadence). Returns null when
 * there's no cached entry for this org (Claude Code hasn't fetched it recently) or on any read/parse
 * failure. Calendar-only (see plan item 7) — deliberately not surfaced in the statusline. */
export function readOverageCreditGrantCache(
  accountUuid: string | null,
): OverageCreditGrantInfo | null {
  if (!accountUuid || !existsSync(CLAUDE_JSON_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_JSON_FILE, "utf8")) as {
      readonly overageCreditGrantCache?: Record<string, { readonly info?: OverageCreditGrantInfo }>;
    };
    return raw.overageCreditGrantCache?.[accountUuid]?.info ?? null;
  } catch {
    return null;
  }
}

const UNSAFE_CHARS = /[^a-z0-9]+/g;

/** Filesystem-safe per-account folder name: sanitized lowercase email, or "default" with no OAuth account
 * (raw ANTHROPIC_API_KEY usage, no login). */
export function accountKey(account: Account | null): string {
  if (!account?.email) return "default";
  return account.email.toLowerCase().replace(UNSAFE_CHARS, "_");
}

/** One entry of account-log.json: from `t` (epoch ms) on, `key` was the login in `~/.claude.json`. */
export interface AccountSwitch {
  readonly t: number;
  readonly key: string;
}

/** Entries kept: the sessions-map window, plus the newest older one (the account active when it opened). */
const ACCOUNT_LOG_DAYS = 35;

/**
 * The log with `key` appended when it differs from the last entry, else null (nothing to write). A
 * `/login` in any terminal changes the login of every Claude Code process, so the first render that sees
 * the new key dates the switch for all sessions.
 */
export function recordAccountSwitch(
  log: ReadonlyArray<AccountSwitch>,
  key: string,
  now: Date,
): ReadonlyArray<AccountSwitch> | null {
  if (log.at(-1)?.key === key) return null;
  const cutoff = now.getTime() - ACCOUNT_LOG_DAYS * 24 * 60 * 60 * 1000;
  const firstKept = log.findIndex((entry) => entry.t >= cutoff);
  const kept = firstKept === -1 ? log.slice(-1) : log.slice(Math.max(0, firstKept - 1));
  return [...kept, { t: now.getTime(), key }];
}

/** The login at epoch ms `t`; null before the log starts. */
export function accountAt(log: ReadonlyArray<AccountSwitch>, t: number): string | null {
  return latest(log, (entry) => entry.t <= t)?.key ?? null;
}

/** Epoch ms of the latest switch to `key`; null when the log never saw it. */
export function lastSwitchTo(log: ReadonlyArray<AccountSwitch>, key: string): number | null {
  return latest(log, (entry) => entry.key === key)?.t ?? null;
}

// Array#findLast is ES2023; the build targets ES2022.
function latest(
  log: ReadonlyArray<AccountSwitch>,
  match: (entry: AccountSwitch) => boolean,
): AccountSwitch | undefined {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const entry = log[i] as AccountSwitch;
    if (match(entry)) return entry;
  }
  return undefined;
}
