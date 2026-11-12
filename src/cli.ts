import { isOperation } from "./interfaces/cli.interface.js";
import type { StatuslineInstallResult } from "./statusline-install.js";

// Every operation imports its modules lazily: the hot hidden modes (`--statusline-line`, `--refresh`) and
// the calendar notice must not pay for the init server, the installers or the calendar UI at startup.

const USAGE = `cc-spend <operation> [flags]

Operations:
  init              First-run setup: install the statusline, pick work days and the monthly cap
  statusline        Install/update the live usage statusline in ~/.claude/statusline.mjs
  calendar          Open the live terminal calendar: stats, laboral days, day-$ edit (Team/Enterprise)
  settings          Arrange the statusline: which parts show, in what order, on how many lines
  uninstall         Remove the managed statusline and restore your previous settings.json statusLine
  doctor            Check Node, Claude Code, the statusline, hooks and every account's files
  report [period]   API-equivalent $ from your local transcripts. period: today | week | month | 30d |
                    YYYY-MM (default week). --by model|project|component|subagent|session|day,
                    --chart (a stacked $ bar per row), --json, --account <key|unattributed>,
                    --session <id> (one session's $ over time, events and where it went)
  insights          What to change to spend less, with $, why and the exact fix. --week (default) |
                    --month, --json, --rules (every rule explained), --snooze <rule> <N>d (0d clears)
  live              Real-time meters of every active session: $ by component, model and subagent, cache,
                    context, limits or budget. --once prints one frame

Flags:
  -h, --help        Print this help and exit
  -v, --version     Print the version and exit
`;

const EPHEMERAL_INSTALL =
  "This copy runs from a temporary npx/dlx cache, which is cleared later and would break the statusline.\nInstall it first: npm install -g cc-spend";

/** Installs point Claude Code at this copy's files: refuse a copy that will be deleted. */
async function assertPersistentInstall(): Promise<void> {
  const { isEphemeralInstall } = await import("./statusline-install.js");
  if (isEphemeralInstall()) throw new Error(EPHEMERAL_INSTALL);
}

function printUsage(): void {
  console.log(USAGE);
}

async function askYesNo(question: string): Promise<boolean> {
  const { defaultConfirm } = await import("./statusline-shared.js");
  return defaultConfirm(question);
}

/**
 * First-run setup, all in the terminal: install the statusline (it is what detects the plan and captures
 * spend), then — for a dollar-budget plan — offer Mon–Fri laboral days for this month and the next, and
 * open the calendar to adjust days and the cap. Pro/Max stop after the statusline.
 */
async function runInitOperation(): Promise<number> {
  await assertPersistentInstall();
  const [
    { accountKey, resolveActiveAccount },
    { loadConfig, saveConfig },
    { classifyHasSpendCap },
  ] = await Promise.all([import("./account.js"), import("./config.js"), import("./calc.js")]);
  const account = await resolveActiveAccount();
  const key = accountKey(account);
  console.log(`Account: ${account?.email ?? "default (no OAuth account)"}`);

  if (await askYesNo("Install/update the live usage statusline now? (recommended)")) {
    const { installStatusline } = await import("./statusline-install.js");
    console.log(
      formatStatuslineInstallMessage(await installStatusline(() => Promise.resolve(true))),
    );
  } else {
    const { installCaptureOnly } = await import("./statusline-capture-install.js");
    await installCaptureOnly();
  }

  const { promptCacheTtl, setPromptCacheTtl } = await import("./statusline-shared.js");
  if (
    promptCacheTtl() === undefined &&
    (await askYesNo(
      "Keep the prompt cache 1 hour instead of 5 minutes? A 5–60 min break then no longer re-sends the whole conversation (cache writes cost 2× instead of 1.25×). (recommended)",
    ))
  ) {
    setPromptCacheTtl("1h");
    console.log('Set "promptCacheTtl": "1h" in ~/.claude/settings.json (applies to new sessions).');
  }

  const config = loadConfig(key);
  const planType = account?.organizationType ?? config.planType ?? null;
  const hasBudget = classifyHasSpendCap(planType) ?? config.hasSpendCap;
  if (hasBudget === false) {
    console.log(
      `No spend cap on this plan (${planType ?? "subscription"}) — nothing else to configure.`,
    );
    return 0;
  }
  if (hasBudget === undefined) {
    console.log(
      "Plan not detected yet. Start one Claude Code session, then run: cc-spend calendar",
    );
  }

  const { localYearMonth, nextYearMonth, weekdaysOf } = await import("./clock.js");
  const thisMonth = localYearMonth(new Date());
  const months = [thisMonth, nextYearMonth(thisMonth)];
  const unset = months.filter(
    ({ year, month }) => (config.laboralDays[String(year)]?.[String(month)] ?? []).length === 0,
  );
  if (
    unset.length > 0 &&
    (await askYesNo("Mark Monday–Friday as work days for this month and the next?"))
  ) {
    const laboralDays: Record<string, Record<string, ReadonlyArray<number>>> = structuredClone(
      config.laboralDays,
    );
    for (const { year, month } of unset) {
      laboralDays[String(year)] = {
        ...laboralDays[String(year)],
        [String(month)]: weekdaysOf(year, month),
      };
    }
    saveConfig(key, { ...config, laboralDays });
    console.log(
      "Saved. Adjust holidays and the monthly cap in the calendar (Space toggles a day, c sets the cap).",
    );
  }

  if (hasBudget === true && process.stdin.isTTY && process.stdout.isTTY) {
    const { runCalendarTui } = await import("./calendar-tui.js");
    return runCalendarTui(account);
  }
  return 0;
}

/** Shared between runInitOperation and runStatuslineOperation so both commands report installStatusline's
 * result the same way — a version transition tells apart a real upgrade from an already-current no-op. */
export function formatStatuslineInstallMessage(result: StatuslineInstallResult): string {
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
  await assertPersistentInstall();
  const { installStatusline } = await import("./statusline-install.js");
  console.log(formatStatuslineInstallMessage(await installStatusline()));
  return 0;
}

async function runUninstallOperation(): Promise<number> {
  const { uninstallStatusline } = await import("./statusline-install.js");
  const result = uninstallStatusline();
  console.log(
    result.removed
      ? `Removed the managed statusline.${result.restoredFrom ? ` Restored statusLine from ${result.restoredFrom}.` : " Removed statusLine from settings.json."}`
      : "Nothing to remove — the managed statusline is not installed.",
  );
  return 0;
}

/** The calendar plans a dollar budget — only Team/Enterprise (or an unknown plan the hook already judged
 * to have one) gets the UI. Everyone else gets a notice, without loading the UI at all. */
async function runCalendarOperation(): Promise<number> {
  const [{ accountKey, resolveActiveAccount }, { loadConfig }, { classifyHasSpendCap }] =
    await Promise.all([import("./account.js"), import("./config.js"), import("./calc.js")]);
  const account = await resolveActiveAccount();
  const config = loadConfig(accountKey(account));
  const planType = account?.organizationType ?? config.planType ?? null;
  const classified = classifyHasSpendCap(planType);
  const hasBudget = classified ?? config.hasSpendCap;
  if (hasBudget !== true) {
    const { calendarUnavailableNotice, noticeStyle } = await import("./notice.js");
    console.log(
      calendarUnavailableNotice(
        noticeStyle(),
        planType,
        hasBudget === false ? "subscription" : "unknown",
      ),
    );
    return 0;
  }
  const { runCalendarTui } = await import("./calendar-tui.js");
  return runCalendarTui(account);
}

const HOOK_MODES = new Set([
  "--statusline-line",
  "--statusline",
  "--prompt-gate",
  "--model-switch",
  "--subagent-statusline",
  "--refresh",
]);

/**
 * `report`: catch the transcript index up (local files only), then print the table or JSON for the active
 * account. Also refreshes feed.json, so the mod sees the same numbers.
 */
async function runReportOperation(argv: ReadonlyArray<string>): Promise<number> {
  const report = await import("./report.js");
  const args = report.parseReportArgs(argv);
  if (typeof args === "string") throw new Error(`${args}\nUse --help for help.`);
  const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  if (args.session !== null) {
    const sessionReport = await import("./session-report.js");
    const found = sessionReport.sessionFiles(args.session);
    if (typeof found === "string") throw new Error(found);
    const session = sessionReport.loadSessionModel(found.id, found.files);
    console.log(
      args.json
        ? JSON.stringify(sessionReport.sessionJson(session), null, 2)
        : sessionReport
            .renderSessionReport(session, color, process.stdout.columns || 80)
            .join("\n"),
    );
    return 0;
  }
  const now = new Date();
  const range = report.resolveRange(args.period, now);
  if (range === null) throw new Error(`Unknown period: ${args.period}\nUse --help for help.`);
  const [{ accountKey, resolveActiveAccount }, { catchUp }, { writeFeed }, config, limits] =
    await Promise.all([
      import("./account.js"),
      import("./transcript-index.js"),
      import("./refresh.js"),
      import("./config.js"),
      import("./limits-history.js"),
    ]);
  const key = args.account ?? accountKey(await resolveActiveAccount());
  if (process.stderr.isTTY) process.stderr.write("Reading new transcript lines…\r");
  if (!catchUp({ now })) console.error("Another index pass is running; numbers may lag.");
  if (key !== "unattributed") await writeFeed(key, now);
  const perPercent =
    key === "unattributed" ? null : limits.usdPerPercentWeek(config.loadLimitSamples(key), now);
  const built = report.buildReport(key, range, args.by, perPercent);
  console.log(
    args.json
      ? JSON.stringify(built, null, 2)
      : report.formatReport(built, { chart: args.chart, color }),
  );
  return 0;
}

/** `insights`: catch up the index, rank the coach findings, refresh feed.json, print them. */
async function runInsightsOperation(argv: ReadonlyArray<string>): Promise<number> {
  const insights = await import("./insights.js");
  const args = insights.parseInsightsArgs(argv);
  if (typeof args === "string") throw new Error(`${args}\nUse --help for help.`);
  const now = new Date();
  const [{ accountKey, resolveActiveAccount }, { catchUp }, { writeFeed }, config, { buildFeed }] =
    await Promise.all([
      import("./account.js"),
      import("./transcript-index.js"),
      import("./refresh.js"),
      import("./config.js"),
      import("./feed.js"),
    ]);
  const key = accountKey(await resolveActiveAccount());
  if (args.snooze) {
    const until = insights.snoozeRule(key, args.snooze.id, args.snooze.days, now);
    console.log(until ? `${args.snooze.id} snoozed until ${until}` : `${args.snooze.id} unsnoozed`);
  }
  if (!catchUp({ now })) console.error("Another index pass is running; numbers may lag.");
  await writeFeed(key, now);
  const cfg = config.loadConfig(key);
  const usage = config.loadUsage(key, now);
  const feed = buildFeed(
    {
      accountKey: key,
      config: cfg,
      usage,
      samples: config.loadLimitSamples(key),
      api: config.loadApiCache(key),
      sessions: config.loadSessionsMap(key),
    },
    now,
  );
  const advice = insights.adviceFor(key, args.window, feed, cfg, usage, now);
  if (args.rules) {
    console.log(
      args.json
        ? JSON.stringify(insights.rulesWithFound(advice), null, 2)
        : insights.formatRules(advice, args.window),
    );
    return 0;
  }
  console.log(
    args.json ? JSON.stringify(advice, null, 2) : insights.formatInsights(advice, args.window),
  );
  return 0;
}

export async function runCli(argv: ReadonlyArray<string>): Promise<number> {
  const { moveLegacyRootDir } = await import("./config.js");
  moveLegacyRootDir();
  const code = await dispatch(argv);
  // Hidden hook modes print to Claude Code, not a person; the render shows its own marker.
  if (!HOOK_MODES.has(argv[0] ?? "")) {
    const { listNewerFiles, NEWER_FILE_HINT } = await import("./config.js");
    if (listNewerFiles().length > 0) console.error(NEWER_FILE_HINT);
  }
  return code;
}

async function dispatch(argv: ReadonlyArray<string>): Promise<number> {
  if (argv[0] === "--statusline-line") {
    const { runStatuslineLine } = await import("./statusline.js");
    return runStatuslineLine();
  }
  if (argv[0] === "--statusline") {
    const { runStatuslineJson } = await import("./statusline.js");
    return runStatuslineJson();
  }
  if (argv[0] === "--prompt-gate") {
    const { runPromptGate } = await import("./prompt-gate.js");
    return runPromptGate();
  }
  if (argv[0] === "--model-switch") {
    const { runModelSwitch } = await import("./model-switch.js");
    return runModelSwitch();
  }
  if (argv[0] === "--subagent-statusline") {
    const { runSubagentStatusline } = await import("./subagent-line.js");
    return runSubagentStatusline();
  }
  if (argv[0] === "--refresh") {
    if (!argv[1]) throw new Error("--refresh needs an account key");
    const { runRefresh } = await import("./refresh.js");
    return runRefresh(argv[1]);
  }

  if (argv[0] === "-v" || argv[0] === "--version") {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    console.log(pkg.version);
    return 0;
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

  if (operationArg === "report") return runReportOperation(rest);
  if (operationArg === "insights") return runInsightsOperation(rest);
  if (operationArg === "live") {
    const live = await import("./live-tui.js");
    const args = live.parseLiveArgs(rest);
    if (typeof args === "string") throw new Error(`${args}\nUse --help for help.`);
    return live.runLive(args);
  }
  if (rest[0] !== undefined) {
    throw new Error(`Unknown argument: ${rest[0]}\nUse --help for help.`);
  }

  switch (operationArg) {
    case "init":
      return runInitOperation();
    case "statusline":
      return runStatuslineOperation();
    case "calendar":
      return runCalendarOperation();
    case "settings": {
      const { runSettingsTui } = await import("./settings-tui.js");
      return runSettingsTui();
    }
    case "uninstall":
      return runUninstallOperation();
    case "doctor": {
      const { doctorReport } = await import("./doctor.js");
      const { text, code } = await doctorReport();
      console.log(text);
      return code;
    }
  }
}
