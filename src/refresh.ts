import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchUsage,
  isApiCacheFresh,
  nextApiCache,
  resolveOAuthAccessToken,
} from "./anthropic-usage.js";
import {
  accountDir,
  loadApiCache,
  loadConfig,
  loadLimitSamples,
  loadSessionsMap,
  loadUsage,
  saveApiCache,
  saveFeed,
} from "./config.js";

/** A refresher that died without removing its lock stops blocking new ones after this long. */
const LOCK_STALE_MS = 30_000;

const BIN_PATH = fileURLToPath(new URL("../bin/cc-daily-usage.js", import.meta.url));

function lockFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "refresh.lock");
}

/** Takes the per-account refresh lock; false when a live refresher already holds it. */
function acquireLock(accountKey: string, now: Date): boolean {
  const file = lockFile(accountKey);
  try {
    closeSync(openSync(file, "wx"));
    return true;
  } catch {
    try {
      if (now.getTime() - statSync(file).mtimeMs < LOCK_STALE_MS) return false;
      rmSync(file, { force: true });
      closeSync(openSync(file, "wx"));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Stale-while-revalidate: when api-cache.json is older than its TTL, start ONE detached
 * `cc-daily-usage --refresh <key>` and return at once. The caller renders the cached reading now; the next
 * render (event or statusLine.refreshInterval) shows the fresh one. Network latency never reaches a render.
 * Returns true when a refresher was started.
 */
export function requestApiRefresh(accountKey: string, now: Date): boolean {
  if (isApiCacheFresh(loadApiCache(accountKey), now)) return false;
  if (!acquireLock(accountKey, now)) return false;
  try {
    spawn(process.execPath, [BIN_PATH, "--refresh", accountKey], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return true;
  } catch {
    rmSync(lockFile(accountKey), { force: true });
    return false;
  }
}

/** Rebuilds feed.json from the account's files (the /cost-tracker mod reads it). Lazy: never on render. */
export async function writeFeed(accountKey: string, now: Date): Promise<void> {
  const [{ buildFeed }, { hasUnpricedTurns }, { adviceFor }] = await Promise.all([
    import("./feed.js"),
    import("./report.js"),
    import("./insights.js"),
  ]);
  const config = loadConfig(accountKey);
  const usage = loadUsage(accountKey, now);
  const feed = buildFeed(
    {
      accountKey,
      config,
      usage,
      samples: loadLimitSamples(accountKey),
      api: loadApiCache(accountKey),
      sessions: loadSessionsMap(accountKey),
      isFloor: hasUnpricedTurns(accountKey, now),
    },
    now,
  );
  saveFeed(accountKey, {
    ...feed,
    advice: adviceFor(accountKey, "week", feed, config, usage, now),
  });
}

/** Body of the hidden `--refresh <key>` mode: token → GET /api/oauth/usage → api-cache.json → one bounded
 * transcript-index pass → feed.json.
 * The token read (macOS Keychain spawn) lives here, off the render path. Never throws; always releases the
 * lock. */
export async function runRefresh(accountKey: string, now: Date = new Date()): Promise<number> {
  try {
    const previous = loadApiCache(accountKey);
    const token = resolveOAuthAccessToken();
    const fetched = token ? await fetchUsage(token.token) : null;
    saveApiCache(accountKey, nextApiCache(previous, fetched, now));
    const { runIndexPass } = await import("./transcript-index.js");
    runIndexPass({ now }); // bounded; the rest waits for the next refresh
    await writeFeed(accountKey, now);
  } catch {
    // A failed refresh keeps the previous files; the next render asks again after the TTL.
  } finally {
    rmSync(lockFile(accountKey), { force: true });
  }
  return 0;
}
