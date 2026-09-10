import { accountKey, resolveActiveAccount } from "./account.js";
import { getCachedExtraUsage, resolveOAuthAccessToken } from "./anthropic-usage.js";
import {
  captureSessionCost,
  classifyHasSpendCap,
  computeToday,
  reconcileFromExtraUsageSnapshot,
  reconcileLaboralDays,
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
  statusline        Install/update the live usage statusline in ~/.claude/statusline.sh
  dashboard         Open a live terminal dashboard: stats, calendar, laboral-day editing

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

/** Hidden internal mode — called by assets/statusline.sh (or the capture-only injected line) on every render.
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

  // Cached on config — see the Config.planType/hasSpendCap doc comment. `organizationType`, resolved from
  // ~/.claude.json at session start (account.ts), is authoritative and available before any turn happens, so
  // it classifies hasSpendCap immediately — no need to wait for `rate_limits`. A recognized organizationType
  // always wins over whatever's cached (a `mismatch` re-derives it either direction), which also self-heals
  // installs that had a wrong guess baked in before this classifier existed. `rate_limits` on the hook payload
  // is Claude Code's own signal that this account has 5h/7d request windows (a subscription plan) rather than
  // our fabricated dollar-cap tracking meant for pay-as-you-go/API-key use; it's kept only as a fallback
  // guess/self-heal for org types classifyHasSpendCap doesn't recognize.
  const sawRateLimits = "rate_limits" in hookPayload;
  const classified = classifyHasSpendCap(account?.organizationType ?? null);
  const mismatch = classified !== undefined && classified !== loadedConfig.hasSpendCap;
  if (loadedConfig.hasSpendCap === undefined || mismatch || (sawRateLimits && loadedConfig.hasSpendCap)) {
    loadedConfig = {
      ...loadedConfig,
      planType: account?.organizationType ?? null,
      hasSpendCap: classified ?? (sawRateLimits ? false : (loadedConfig.hasSpendCap ?? true)),
    };
    saveConfig(key, loadedConfig);
  }

  // Claude Code doesn't attach `rate_limits` to the very first --statusline call of a session (it needs a
  // turn to know current window usage) — assets/statusline.sh's native ⏱ segment would render blank for
  // that render. Cache the last-seen five_hour/seven_day percentages here so the JSON below always carries
  // *something* to fall back to; per-field, so a payload that only refreshes one side doesn't blank the other.
  const rawRateLimits = hookPayload.rate_limits as
    | { five_hour?: { used_percentage?: number }; seven_day?: { used_percentage?: number } }
    | undefined;
  if (rawRateLimits) {
    usage.rateLimitsCache = {
      fiveHourPct:
        rawRateLimits.five_hour?.used_percentage ?? usage.rateLimitsCache?.fiveHourPct ?? null,
      sevenDayPct:
        rawRateLimits.seven_day?.used_percentage ?? usage.rateLimitsCache?.sevenDayPct ?? null,
    };
  }

  // Live "Extra usage" fetch (cached — see anthropic-usage.ts) is independent of and additional to the
  // self-tracked monthlyCap tracking below; a failed/missing token just means the segment stays absent.
  const token = resolveOAuthAccessToken();
  const extraUsage = token ? await getCachedExtraUsage(usage, token.token, now) : null;
  reconcileFromExtraUsageSnapshot(usage, extraUsage, now);

  rolloverIfNeeded(usage, loadedConfig, now);
  // Only a confirmed dollar-cap (enterprise) account accumulates cost into monthlySpent — a mid-session
  // pro/enterprise switch (see classifyHasSpendCap above) must never fold a pro-classified interval's
  // cost into the enterprise total, or vice versa. The lastSeenCost baseline still advances either way.
  captureSessionCost(usage, sessionId, currentCost, now, loadedConfig.hasSpendCap === true);
  saveUsage(key, usage);

  const config = reconcileLaboralDays(loadedConfig, usage);
  if (config !== loadedConfig) saveConfig(key, config);

  const computed = computeToday(usage, config, now);
  console.log(
    JSON.stringify({
      // Both dollar segments (today's and the month's) are fabricated self-tracked estimates, meaningless
      // once this account is known to have no dollar cap — omit both so assets/statusline.sh's guards skip
      // rendering, leaving Claude Code's own native ⏱ 5h/7d rate-limit segment as the sole usage indicator.
      ...(config.hasSpendCap === false
        ? {}
        : {
            todayUsage: computed.todayUsage,
            avgPerDay: computed.avgPerDay,
            todayUsedPct: computed.todayUsedPct,
            monthlySpent: computed.monthlySpent,
            monthlyCap: computed.monthlyCap,
            monthUsedPct: computed.monthUsedPct,
          }),
      extraUsage,
      rateLimitsCache: usage.rateLimitsCache ?? null,
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
    case "dashboard": {
      const { runDashboardTui } = await import("./dashboard-tui.js");
      return runDashboardTui();
    }
  }
}
