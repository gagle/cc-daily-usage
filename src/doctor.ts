import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { API_CACHE_TTL_MS } from "./anthropic-usage.js";
import { ACCOUNTS_DIR } from "./config.js";
import { schemaVersionOf } from "./migrate.js";
import { binPath, shippedStatusline, statuslineEntryUrl } from "./statusline-install.js";
import {
  assetsDir,
  CAPTURE_MARKER_REGEX,
  extractVersion,
  hookCommand,
  MANAGED_HOOKS,
  readJsonFile,
  SETTINGS_FILE,
  STATUSLINE_FILE,
  SUBAGENT_LINE_FLAG,
} from "./statusline-shared.js";
import { lastPass } from "./transcript-index.js";

export interface Check {
  readonly status: "ok" | "warn" | "fail";
  readonly name: string;
  readonly detail: string;
}

const MIN_NODE_MAJOR = 24;
/** A refresher lock older than this belongs to a dead process (refresh.ts uses the same bound). */
const LOCK_STALE_MS = 30_000;
/** Files in an account folder and the format version this code writes (see docs/data-model.md). */
const ACCOUNT_FILES: ReadonlyArray<readonly [string, number]> = [
  ["config.json", 1],
  ["usage.json", 2],
  ["api-cache.json", 1],
  ["limits.json", 1],
  ["sessions-map.json", 1],
  ["feed.json", 1],
];

const ok = (name: string, detail: string): Check => ({ status: "ok", name, detail });
const warn = (name: string, detail: string): Check => ({ status: "warn", name, detail });
const fail = (name: string, detail: string): Check => ({ status: "fail", name, detail });

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${String(seconds)} s ago`;
  if (seconds < 7200) return `${String(Math.round(seconds / 60))} min ago`;
  return `${String(Math.round(seconds / 3600))} h ago`;
}

export function checkNode(version: string): Check {
  const major = Number(version.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? ok("node", version)
    : fail("node", `${version}; needs ${String(MIN_NODE_MAJOR)} or later`);
}

export function packageVersion(): string {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

/** `claude --version`, or null when it does not run. No shell: argument array only.
 * # ponytail: execFile without a shell does not find `claude.cmd` on Windows; a warn there is the cost. */
export function claudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 5000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim().split(/\s/)[0] || null);
    });
  });
}

export function checkClaude(version: string | null): Check {
  return version === null
    ? warn("claude", "not found on PATH (the statusline still works inside Claude Code)")
    : ok("claude", version);
}

/** The shim, the settings.json entry that runs it, and our hooks. */
export function checkStatusline(): ReadonlyArray<Check> {
  const existing = existsSync(STATUSLINE_FILE) ? readFileSync(STATUSLINE_FILE, "utf8") : null;
  const settings = readJsonFile(SETTINGS_FILE);
  const command = (settings.statusLine as { command?: unknown } | undefined)?.command;
  const checks: Array<Check> = [];
  const installed = existing === null ? null : extractVersion(existing);
  if (installed !== null) {
    const template = readFileSync(path.join(assetsDir(), "statusline.mjs"), "utf8");
    const shipped = shippedStatusline(template, statuslineEntryUrl()).version;
    checks.push(
      installed === shipped
        ? ok("statusline", `shim v${installed}`)
        : warn(
            "statusline",
            `shim v${installed}, this package ships v${shipped}; run: cc-spend statusline`,
          ),
    );
    const interval = (settings.statusLine as { refreshInterval?: unknown } | undefined)
      ?.refreshInterval;
    checks.push(
      command !== `node ${JSON.stringify(STATUSLINE_FILE)}`
        ? fail(
            "settings",
            "settings.json statusLine does not run the shim; run: cc-spend statusline",
          )
        : interval === 1
          ? warn("settings", "refreshInterval 1 s from an older version; run: cc-spend statusline")
          : ok("settings", "statusLine runs the shim"),
    );
  } else if (existing !== null && CAPTURE_MARKER_REGEX.test(existing)) {
    checks.push(ok("statusline", "capture-only line in your own statusline script"));
  } else {
    checks.push(
      fail("statusline", `${STATUSLINE_FILE} is missing or not ours; run: cc-spend statusline`),
    );
  }
  const hooks = (settings.hooks ?? {}) as Record<
    string,
    ReadonlyArray<{ hooks?: ReadonlyArray<{ command?: string }> }>
  >;
  for (const { event, flag } of MANAGED_HOOKS) {
    const commands = (hooks[event] ?? [])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command);
    checks.push(
      commands.includes(hookCommand(binPath(), flag))
        ? ok(`hook ${event}`, flag)
        : warn(`hook ${event}`, `missing or for another install; run: cc-spend statusline`),
    );
  }
  const subagent = (settings.subagentStatusLine as { command?: unknown } | undefined)?.command;
  checks.push(
    subagent === hookCommand(binPath(), SUBAGENT_LINE_FLAG)
      ? ok("subagent line", SUBAGENT_LINE_FLAG)
      : subagent === undefined
        ? warn("subagent line", "missing; run: cc-spend statusline")
        : ok("subagent line", "your own subagentStatusLine (kept)"),
  );
  return checks;
}

/** Per account: each file's format version, garbled or newer files, refresher and feed ages. */
export function checkAccounts(now: Date): ReadonlyArray<Check> {
  if (!existsSync(ACCOUNTS_DIR)) return [warn("accounts", "none yet; open Claude Code once")];
  const checks: Array<Check> = [];
  for (const key of readdirSync(ACCOUNTS_DIR)) {
    const dir = path.join(ACCOUNTS_DIR, key);
    if (!statSync(dir).isDirectory()) continue;
    const versions: Array<string> = [];
    const problems: Array<string> = [];
    const values: Record<string, Record<string, unknown>> = {};
    for (const [name, known] of ACCOUNT_FILES) {
      const file = path.join(dir, name);
      if (!existsSync(file)) continue;
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        value = null;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        problems.push(`${name} is not valid JSON`);
        continue;
      }
      values[name] = value as Record<string, unknown>;
      const version = schemaVersionOf(values[name]);
      versions.push(`${name.replace(".json", "")} v${String(version)}`);
      if (version > known) problems.push(`${name} v${String(version)} is from a newer cc-spend`);
    }
    checks.push(
      problems.length > 0
        ? fail(`account ${key}`, problems.join("; "))
        : ok(`account ${key}`, versions.join(", ") || "no files yet"),
    );
    checks.push(...checkRefresher(key, dir, values, now));
    const plan = checkPlan(key, values);
    if (plan !== null) checks.push(plan);
  }
  return checks;
}

/** The plan from the daily profile read and the Claude Code version the newest session rendered with. */
export function checkPlan(
  key: string,
  values: Readonly<Record<string, Record<string, unknown>>>,
): Check | null {
  const plan = values["api-cache.json"]?.plan as Record<string, unknown> | undefined;
  const sessions = (values["sessions-map.json"]?.sessions ?? {}) as Record<
    string,
    { lastSeenAt?: string; claudeVersion?: string | null }
  >;
  const newest = Object.values(sessions)
    .filter((session) => typeof session.claudeVersion === "string")
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))[0];
  const parts = [
    typeof plan?.rateLimitTier === "string" ? `tier ${plan.rateLimitTier}` : null,
    typeof plan?.subscriptionStatus === "string" ? `subscription ${plan.subscriptionStatus}` : null,
    typeof plan?.trialEndsAt === "string" ? `trial ends ${plan.trialEndsAt.slice(0, 10)}` : null,
    newest?.claudeVersion ? `last session on Claude Code ${newest.claudeVersion}` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const lapsed =
    typeof plan?.subscriptionStatus === "string" && plan.subscriptionStatus !== "active";
  return (lapsed ? warn : ok)(`plan ${key}`, parts.join(", "));
}

function checkRefresher(
  key: string,
  dir: string,
  values: Readonly<Record<string, Record<string, unknown>>>,
  now: Date,
): ReadonlyArray<Check> {
  const name = `refresher ${key}`;
  const lock = path.join(dir, "refresh.lock");
  if (existsSync(lock) && now.getTime() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
    return [warn(name, "a refresh.lock from a dead refresher; the next render clears it")];
  }
  const fetchedAt = values["api-cache.json"]?.fetchedAt;
  if (typeof fetchedAt !== "number")
    return [warn(name, "no usage reading yet (needs an OAuth login)")];
  const parts = [`usage read ${ago(now.getTime() - fetchedAt)}`];
  const writtenAt = values["feed.json"]?.writtenAt;
  if (typeof writtenAt === "string")
    parts.push(`feed written ${ago(now.getTime() - Date.parse(writtenAt))}`);
  const cache = values["api-cache.json"];
  if (cache?.stale === true) {
    const error = typeof cache.lastError === "string" ? ` (${cache.lastError})` : "";
    const readAt =
      typeof cache.readAt === "number"
        ? `; last good reading ${ago(now.getTime() - cache.readAt)}`
        : "";
    return [warn(name, `${parts.join(", ")}; last fetch failed${error}${readAt}`)];
  }
  // Renders refresh after the TTL; much older only means no session ran since.
  return [
    ok(
      name,
      parts.join(", ") +
        (now.getTime() - fetchedAt > 10 * API_CACHE_TTL_MS ? " (no session since)" : ""),
    ),
  ];
}

/** The transcript index: when its last pass ran and how many bytes it left for the next one. */
export function checkIndex(
  pass: { readonly at: string; readonly bytesBehind: number } | null,
  now: Date,
): Check {
  if (pass === null) return warn("index", "no pass yet (run cc-spend report)");
  const age = ago(now.getTime() - Date.parse(pass.at));
  if (pass.bytesBehind === 0) return ok("index", `last pass ${age}, up to date`);
  const mb = (pass.bytesBehind / (1024 * 1024)).toFixed(1);
  return warn("index", `last pass ${age}, ${mb} MB behind (report or insights catches up)`);
}

export function formatCheck(check: Check): string {
  const mark = check.status === "ok" ? "✔" : check.status === "warn" ? "⚠" : "✖";
  return `${mark} ${check.name}: ${check.detail}`;
}

/** `cc-spend doctor`: one line per check; exit code 1 when any check fails. */
export async function doctorReport(
  now: Date = new Date(),
): Promise<{ readonly text: string; readonly code: number }> {
  const checks = [
    checkNode(process.versions.node),
    ok("cc-spend", packageVersion()),
    checkClaude(await claudeVersion()),
    ...checkStatusline(),
    ...checkAccounts(now),
    checkIndex(lastPass(), now),
  ];
  return {
    text: checks.map(formatCheck).join("\n"),
    code: checks.some((check) => check.status === "fail") ? 1 : 0,
  };
}
