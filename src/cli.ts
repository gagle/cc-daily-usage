import { isOperation } from "./interfaces/cli.interface.js";
import type { StatuslineInstallResult } from "./statusline-install.js";

// Every operation imports its modules lazily: the hot hidden modes (`--statusline-line`, `--refresh`) and
// the calendar notice must not pay for the init server, the installers or the calendar UI at startup.

const USAGE = `cc-daily-usage <operation> [flags]

Operations:
  init              First-run setup: install the statusline, pick work days and the monthly cap
  statusline        Install/update the live usage statusline in ~/.claude/statusline.mjs
  calendar          Open the live terminal calendar: stats, laboral days, day-$ edit (Team/Enterprise)
  settings          Arrange the statusline: which parts show, in what order, on how many lines
  uninstall         Remove the managed statusline and restore your previous settings.json statusLine

Flags:
  -h, --help        Print this help and exit
`;

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
      "Plan not detected yet. Start one Claude Code session, then run: cc-daily-usage calendar",
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

export async function runCli(argv: ReadonlyArray<string>): Promise<number> {
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
  if (argv[0] === "--refresh") {
    if (!argv[1]) throw new Error("--refresh needs an account key");
    const { runRefresh } = await import("./refresh.js");
    return runRefresh(argv[1]);
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
  }
}
