import { accountKey, resolveActiveAccount } from "./account.js";
import { getCachedExtraUsage, resolveOAuthAccessToken } from "./anthropic-usage.js";
import {
  captureSessionCost,
  classifyHasSpendCap,
  computeToday,
  isLaboralDay,
  reconcileFromExtraUsageSnapshot,
  refreshFrozenPaceIfNonLaboral,
  rolloverIfNeeded,
} from "./calc.js";
import { loadConfig, loadUsage, saveConfig, saveUsage } from "./config.js";
import { runInit } from "./init-server.js";
import { isOperation } from "./interfaces/cli.interface.js";
import { installCaptureOnly } from "./statusline-capture-install.js";
import { installStatusline, type StatuslineInstallResult } from "./statusline-install.js";

const USAGE = `cc-daily-usage <operation> [flags]

Operations:
  init              Open an interactive calendar picker to author laboralDays + monthlyCap
  statusline        Install/update the live usage statusline in ~/.claude/statusline.mjs
  calendar          Open the live terminal calendar: stats, laboral days, day-$ edit

Flags:
  -h, --help        Print this help and exit
`;

function printUsage(): void {
  console.log(USAGE);
}

async function readStdin(): Promise<string> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Merge one Claude Code rate-limit window into the cache.
 * - Window key absent → keep prior pct/resets_at (other side may still refresh this turn).
 * - Window key present → pct is the live used_percentage (or null). resets_at prefers the live value;
 *   if Claude omitted it while pct is still ≥100, keep the prior resets_at so ⚠ can stay visible;
 *   otherwise clear it so a recovered or seeded window cannot keep a stale reset time. */
function mergeRateLimitWindow(
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

/** Hidden internal mode — called by assets/statusline.mjs (or the capture-only injected line) on every render.
 * Account resolution (see account.ts) runs fresh on every call — this is the "every interaction" hook — so a
 * mid-session account switch (even a different terminal's own CLAUDE_CODE_OAUTH_TOKEN override) is picked up
 * on the very next render, each scoped to its own accounts/<key>/ config+usage. */
async function runStatuslineHidden(): Promise<number> {
  const raw = await readStdin();
  const hookPayload = raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const sessionId =
    typeof hookPayload.session_id === "string" ? hookPayload.session_id : "unknown-session";
  const cost = hookPayload.cost as Record<string, unknown> | undefined;
  const currentCost = typeof cost?.total_cost_usd === "number" ? cost.total_cost_usd : 0;

  const account = await resolveActiveAccount();
  const key = accountKey(account);
  let loadedConfig = loadConfig(key);
  const usage = loadUsage(key);
  const now = new Date();

  // Cached on config — see the Config.planType/hasSpendCap doc comment. `organizationType` classifies the
  // dollar self-budget (`hasSpendCap`) at session start. Seat-window `rate_limits` (5h/7d) are separate:
  // Team/Enterprise seats have them too (costs.md), and may appear alongside dollar tracking. A recognized
  // organizationType always wins (mismatch re-derives either direction). `sawRateLimits` may demote an
  // *unrecognized* org's true guess to false (subscription seat, no dollar budget) — never demote a known
  // enterprise/team classification just because rate_limits arrived.
  const sawRateLimits = "rate_limits" in hookPayload;
  const classified = classifyHasSpendCap(account?.organizationType ?? null);
  const mismatch = classified !== undefined && classified !== loadedConfig.hasSpendCap;
  if (
    loadedConfig.hasSpendCap === undefined ||
    mismatch ||
    (sawRateLimits && loadedConfig.hasSpendCap && classified === undefined)
  ) {
    loadedConfig = {
      ...loadedConfig,
      planType: account?.organizationType ?? loadedConfig.planType ?? null,
      hasSpendCap: classified ?? (sawRateLimits ? false : (loadedConfig.hasSpendCap ?? true)),
    };
    saveConfig(key, loadedConfig);
  } else if (account?.organizationType && loadedConfig.planType !== account.organizationType) {
    loadedConfig = { ...loadedConfig, planType: account.organizationType };
    saveConfig(key, loadedConfig);
  }

  // Claude Code doesn't attach `rate_limits` to the very first --statusline call of a session (it needs a
  // turn to know current window usage) — assets/statusline.mjs's native ⏱ segment would render blank for
  // that render. Cache the last-seen five_hour/seven_day snapshot so later renders can fall back. Each
  // present window is authoritative for that turn (clears seeded/stale values); an absent window key keeps
  // the prior side so a one-sided refresh doesn't blank the other.
  const rawRateLimits = hookPayload.rate_limits as
    | {
        five_hour?: { used_percentage?: number; resets_at?: number };
        seven_day?: { used_percentage?: number; resets_at?: number };
      }
    | undefined;
  if (rawRateLimits) {
    const prev = usage.rateLimitsCache;
    const five = mergeRateLimitWindow(
      rawRateLimits.five_hour,
      prev?.fiveHourPct,
      prev?.fiveHourResetsAt,
    );
    const seven = mergeRateLimitWindow(
      rawRateLimits.seven_day,
      prev?.sevenDayPct,
      prev?.sevenDayResetsAt,
    );
    usage.rateLimitsCache = {
      fiveHourPct: five.pct,
      sevenDayPct: seven.pct,
      fiveHourResetsAt: five.resetsAt,
      sevenDayResetsAt: seven.resetsAt,
    };
  }

  // Live "Extra usage" fetch (cached — see anthropic-usage.ts). When present it is the authoritative
  // month ledger for dollar-cap accounts; Claude's cost.total_cost_usd can invent phantom spend on a
  // brand-new session id (full currentCost accumulate), so we only fold session deltas into
  // monthlySpent when the credits API is unavailable.
  const token = resolveOAuthAccessToken();
  const extraUsage = token ? await getCachedExtraUsage(usage, token.token, now) : null;
  reconcileFromExtraUsageSnapshot(usage, extraUsage, now);

  // A confirmed no-spend-cap account (Pro/Max) has nothing meaningful for either of these to compute —
  // skip both so config.json's laboralDays/monthlyCap and usage.json's frozen* fields stop growing/changing
  // on every turn for a feature this account provably doesn't use (mirrors the captureSessionCost gate below).
  if (loadedConfig.hasSpendCap !== false) {
    rolloverIfNeeded(usage, loadedConfig, now);
  }
  const accumulateSessions = loadedConfig.hasSpendCap === true && extraUsage === null;
  // lastSeenCost baseline still advances even when accumulateSessions is false.
  captureSessionCost(usage, sessionId, currentCost, now, accumulateSessions);
  if (loadedConfig.hasSpendCap === true && extraUsage !== null) {
    usage.monthlySpent = extraUsage.usedCredits;
  }
  if (loadedConfig.hasSpendCap === true) {
    refreshFrozenPaceIfNonLaboral(usage, loadedConfig, now);
  }
  saveUsage(key, usage);

  const computed = computeToday(usage, loadedConfig, now);
  const showTodayPace = loadedConfig.hasSpendCap !== false && isLaboralDay(loadedConfig, now);
  console.log(
    JSON.stringify({
      // Dollar self-budget: omitted entirely for Pro/Max. On enterprise, todayUsage always ships so
      // off-days still show spent-today; avgPerDay/todayUsedPct only on laboral days (pace vs max).
      ...(loadedConfig.hasSpendCap === false
        ? {}
        : {
            todayUsage: computed.todayUsage,
            ...(showTodayPace
              ? {
                  avgPerDay: computed.avgPerDay,
                  todayUsedPct: computed.todayUsedPct,
                }
              : {}),
            monthlySpent: computed.monthlySpent,
            monthlyCap: computed.monthlyCap,
            monthUsedPct: computed.monthUsedPct,
            // True the very first time a dollar-cap account is seen, before `init` has ever picked laboral
            // days — assets/statusline.mjs shows a short "run init" nudge instead of the (meaningless-until-
            // configured) today/month segments above.
            needsInit: Object.keys(loadedConfig.laboralDays).length === 0,
          }),
      // Pro/Max only in the statusline UI — enterprise hides 🎫 to avoid duplicating $month.
      extraUsage: loadedConfig.hasSpendCap === false ? extraUsage : null,
      rateLimitsCache: usage.rateLimitsCache ?? null,
      // hasSpendCap gates ⏱ (Pro only) vs $ budget (enterprise) in assets/statusline.mjs.
      hasSpendCap: loadedConfig.hasSpendCap as boolean,
      planType: loadedConfig.planType ?? null,
    }),
  );
  return 0;
}

async function runInitOperation(): Promise<number> {
  const account = await resolveActiveAccount();
  const key = accountKey(account);
  const config = loadConfig(key);
  const usage = loadUsage(key);
  console.log(`Account: ${account?.email ?? "default (no OAuth account)"}`);

  // No dollar cap on this plan (see Config.hasSpendCap doc comment) — the calendar/cap picker has nothing
  // meaningful to author, so skip straight to the statusline install prompt below.
  if (config.hasSpendCap === false) {
    console.log(
      `No spend cap on this plan (${config.planType ?? "subscription"}) — nothing to configure.`,
    );
  } else {
    const result = await runInit({
      initialConfig: config,
      usageMonthlySpent: usage.monthlySpent,
      accountKey: key,
    });
    saveConfig(key, result.config);
    console.log(
      `Saved monthlyCap=$${String(result.config.monthlyCap)}, laboral days across ${String(
        Object.keys(result.config.laboralDays).length,
      )} year(s). (finished via: ${result.outcome})`,
    );
  }

  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let installFull: boolean;
  try {
    const answer = (
      await rl.question("Install/update the live usage statusline now? (recommended) (Y/n) ")
    )
      .trim()
      .toLowerCase();
    installFull = answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }

  if (installFull) {
    console.log(formatStatuslineInstallMessage(await installStatusline()));
  } else {
    await installCaptureOnly();
  }
  return 0;
}

/** Shared between runInitOperation and runStatuslineOperation so both commands report installStatusline's
 * result the same way — a version transition tells apart a real upgrade from an already-current no-op. */
function formatStatuslineInstallMessage(result: StatuslineInstallResult): string {
  if (!result.installed) return "Not installed — declined.";
  if (result.fromVersion === null) {
    const backupNote = result.backupPath
      ? ` Backed up previous settings.json to ${result.backupPath}.`
      : "";
    return `Installed (v${String(result.toVersion)}).${backupNote}`;
  }
  if (result.fromVersion === result.toVersion) {
    return `Statusline already up to date (v${result.toVersion}).`;
  }
  return `Updated statusline: v${result.fromVersion} → v${String(result.toVersion)}.`;
}

async function runStatuslineOperation(): Promise<number> {
  console.log(formatStatuslineInstallMessage(await installStatusline()));
  return 0;
}

export async function runCli(argv: ReadonlyArray<string>): Promise<number> {
  if (argv[0] === "--statusline") {
    return runStatuslineHidden();
  }

  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    printUsage();
    return 0;
  }

  const [operationArg, ...rest] = argv;
  if (!operationArg || !isOperation(operationArg)) {
    // operationArg can't actually be undefined here — argv.length === 0 already returned above — but
    // noUncheckedIndexedAccess can't express that invariant through a destructured rest element.
    /* v8 ignore next */
    throw new Error(`Unknown argument: ${operationArg ?? ""}\nUse --help for help.`);
  }

  if (rest[0]) {
    throw new Error(`Unknown argument: ${rest[0]}\nUse --help for help.`);
  }

  switch (operationArg) {
    case "init":
      return runInitOperation();
    case "statusline":
      return runStatuslineOperation();
    case "calendar": {
      const { runCalendarTui } = await import("./calendar-tui.js");
      return runCalendarTui();
    }
  }
}
