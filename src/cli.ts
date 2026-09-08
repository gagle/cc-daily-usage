import { writeFileSync } from "node:fs";

import { captureSessionCost, computeToday, rolloverIfNeeded } from "./calc.js";
import { loadConfig, loadUsage, REPORT_HTML_FILE, saveConfig, saveUsage } from "./config.js";
import { runInit } from "./init-server.js";
import { isOperation } from "./interfaces/cli.interface.js";
import { renderReport } from "./report.js";
import { installCaptureOnly } from "./statusline-capture-install.js";
import { installStatusline } from "./statusline-install.js";

const USAGE = `cc-daily-usage <operation> [flags]

Operations:
  report            Render report.html under ~/.config/cc-daily-usage/
  init              Open an interactive calendar picker to author laboralDays + monthlyCap
  statusline        Install/update the live usage statusline in ~/.claude/statusline.sh
  usage             Open a live terminal dashboard of today's/this month's spend

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

/** Hidden internal mode — called by assets/statusline.sh (or the capture-only injected line) on every render. */
async function runStatuslineHidden(): Promise<number> {
  const raw = await readStdin();
  const hookPayload = raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const sessionId =
    typeof hookPayload.session_id === "string" ? hookPayload.session_id : "unknown-session";
  const cost = hookPayload.cost as Record<string, unknown> | undefined;
  const currentCost = typeof cost?.total_cost_usd === "number" ? cost.total_cost_usd : 0;

  const config = loadConfig();
  const usage = loadUsage();
  const now = new Date();

  rolloverIfNeeded(usage, config, now);
  captureSessionCost(usage, sessionId, currentCost, now);
  saveUsage(usage);

  const computed = computeToday(usage, config, now);
  console.log(
    JSON.stringify({
      todayUsage: computed.todayUsage,
      avgPerDay: computed.avgPerDay,
      todayUsedPct: computed.todayUsedPct,
      monthlySpent: computed.monthlySpent,
      monthlyCap: computed.monthlyCap,
      monthUsedPct: computed.monthUsedPct,
    }),
  );
  return 0;
}

function runReport(): number {
  const config = loadConfig();
  const usage = loadUsage();
  const now = new Date();
  rolloverIfNeeded(usage, config, now);
  saveUsage(usage);
  const computed = computeToday(usage, config, now);
  const html = renderReport(config, usage, computed, now);
  writeFileSync(REPORT_HTML_FILE, html);
  console.log(`Wrote ${REPORT_HTML_FILE}`);
  return 0;
}

async function runInitOperation(): Promise<number> {
  const config = loadConfig();
  const usage = loadUsage();
  const result = await runInit({ initialConfig: config, usageMonthlySpent: usage.monthlySpent });
  saveConfig(result.config);
  console.log(
    `Saved monthlyCap=$${String(result.config.monthlyCap)}, laboral days across ${String(
      Object.keys(result.config.laboralDays).length,
    )} year(s). (finished via: ${result.outcome})`,
  );

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
    await installStatusline();
  } else {
    await installCaptureOnly();
  }
  return 0;
}

async function runStatuslineOperation(): Promise<number> {
  const result = await installStatusline();
  if (result.installed) {
    console.log(
      result.backupPath
        ? `Installed. Backed up previous settings.json to ${result.backupPath}`
        : "Installed (no-op/upgrade — already managed).",
    );
  } else {
    console.log("Not installed — declined.");
  }
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
    case "report":
      return runReport();
    case "init":
      return runInitOperation();
    case "statusline":
      return runStatuslineOperation();
    case "usage": {
      const { runUsageTui } = await import("./usage-tui.js");
      return runUsageTui();
    }
  }
}
