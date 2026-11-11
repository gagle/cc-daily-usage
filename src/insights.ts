import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { localDateKey } from "./clock.js";
import { loadConfig, saveConfig } from "./config.js";
import type { Feed, Finding } from "./feed.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";
import { type DayRange, resolveRange, rowsInRange } from "./report.js";
import { coach, type InstructionFile, RULE_INFO, type RuleInfo } from "./rules.js";
import { loadSessionTotals } from "./transcript-index.js";
import { parseRowKey } from "./transcript-parse.js";

export type CoachWindow = "week" | "month";

function tokensOf(file: string): number | null {
  try {
    return Math.ceil(statSync(file).size / 4);
  } catch {
    return null;
  }
}

/** `@path` import lines of an instruction file, resolved (`~/` = home, else next to the file). */
function importsOf(file: string): ReadonlyArray<string> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(/^@(\S+)\s*$/gm)].map(([, target]) => {
    const value = target as string;
    return value.startsWith("~/")
      ? path.join(homedir(), value.slice(2))
      : path.resolve(path.dirname(file), value);
  });
}

/**
 * Instruction files Claude Code loads on every turn (R12): the global CLAUDE.md and its `@` imports (one
 * level), and per project its CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md and the auto-memory MEMORY.md.
 * # ponytail: parent-folder CLAUDE.md files and nested imports are not followed; the $ is then a floor.
 */
export function instructionFiles(projects: ReadonlyArray<string>): ReadonlyArray<InstructionFile> {
  const files: Array<InstructionFile> = [];
  const add = (file: string, project: string | null): void => {
    const tokens = tokensOf(file);
    if (tokens !== null && tokens > 0) files.push({ path: file, project, tokens });
  };
  const global = path.join(homedir(), ".claude", "CLAUDE.md");
  add(global, null);
  for (const imported of importsOf(global)) add(imported, null);
  for (const project of projects) {
    if (project === "") continue;
    add(path.join(project, "CLAUDE.md"), project);
    add(path.join(project, "CLAUDE.local.md"), project);
    add(path.join(project, ".claude", "CLAUDE.md"), project);
    const slug = project.replace(/[^A-Za-z0-9]/g, "-");
    add(path.join(homedir(), ".claude", "projects", slug, "memory", "MEMORY.md"), project);
  }
  return files;
}

/** The coach over the account's index and its usage history, for `window` (rolling 7 days or 30 days). */
export function adviceFor(
  key: string,
  window: CoachWindow,
  feed: Pick<Feed, "limits" | "budget">,
  config: Config,
  usage: UsageState,
  now: Date,
): ReadonlyArray<Finding> {
  const range = resolveRange(window === "week" ? "week" : "30d", now) as DayRange;
  const inRange = (day: string): boolean => day >= range.from && day <= range.to;
  const sessions = Object.fromEntries(
    Object.entries(loadSessionTotals(key)).filter(([, session]) =>
      inRange(localDateKey(new Date(session.lastAt))),
    ),
  );
  const rows = rowsInRange(key, range);
  const projects = [...new Set(rows.map(([row]) => parseRowKey(row).project))];
  return coach({
    rows,
    instructions: instructionFiles(projects),
    sessions,
    missCauses: Object.fromEntries(
      Object.entries(usage.missCauses).filter(([day]) => inRange(day)),
    ),
    limits: feed.limits,
    budget: feed.budget,
    window,
    snoozed: config.snoozed ?? {},
    now,
  });
}

const money = (usd: number): string => `~$${usd.toFixed(2)}`;

export function formatInsights(advice: ReadonlyArray<Finding>, window: CoachWindow): string {
  if (advice.length === 0) return `Nothing to change this ${window}.`;
  const lines = advice.map((finding) => {
    const fix =
      finding.fix.key === undefined
        ? (finding.fix.value ?? finding.fix.text)
        : `${finding.fix.key}=${finding.fix.value ?? ""}`;
    const snoozed = finding.snoozedUntil
      ? ` (snoozed until ${finding.snoozedUntil.slice(0, 10)})`
      : "";
    return [
      `${finding.id}  ${finding.title}${finding.usd === null ? "" : `  ${money(finding.usd)}/${window}`}${snoozed}`,
      `    ${finding.evidence}`,
      ...(finding.why === undefined ? [] : [`    why: ${finding.why}`]),
      `    fix: ${finding.fix.text}${fix === finding.fix.text ? "" : ` → ${fix}`}`,
    ].join("\n");
  });
  return [
    lines.join("\n\n"),
    "",
    "API-equivalent estimates. Every rule explained: cc-daily-usage insights --rules",
    "Snooze one: cc-daily-usage insights --snooze R1 7d",
  ].join("\n");
}

/** `insights --rules --json`: the catalog with `found` for the rules that fired. */
export function rulesWithFound(
  advice: ReadonlyArray<Finding>,
): ReadonlyArray<RuleInfo & { readonly found: boolean }> {
  const found = new Set(advice.map((finding) => finding.id));
  return RULE_INFO.map((rule) => ({ ...rule, found: found.has(rule.id) }));
}

/** `insights --rules`: every rule, what it checks, why it costs, how the $ is estimated and the fix; `●` marks
 * the ones found in this window. */
export function formatRules(advice: ReadonlyArray<Finding>, window: CoachWindow): string {
  const found = new Set(advice.map((finding) => finding.id));
  const blocks = RULE_INFO.map((rule) =>
    [
      `${found.has(rule.id) ? "●" : " "} ${rule.id.padEnd(4)}${rule.title}`,
      `       checks  ${rule.checks}`,
      `       why     ${rule.why}`,
      `       $       ${rule.estimate}`,
      `       fix     ${rule.fix}`,
    ].join("\n"),
  );
  return [
    `What cc-daily-usage insights checks, over the last ${window === "week" ? "7" : "30"} days (--month for 30). ● = found now.`,
    "",
    blocks.join("\n\n"),
    "",
    "Findings under $0.50 are hidden. API-equivalent estimates, not a bill.",
  ].join("\n");
}

export interface InsightsArgs {
  readonly window: CoachWindow;
  readonly json: boolean;
  readonly rules: boolean;
  readonly snooze: { readonly id: string; readonly days: number } | null;
}

/** `insights [--week|--month] [--json] [--rules] [--snooze <rule> <N>d]` → args, or an error message. */
export function parseInsightsArgs(argv: ReadonlyArray<string>): InsightsArgs | string {
  let window: CoachWindow = "week";
  let json = false;
  let rules = false;
  let snooze: InsightsArgs["snooze"] = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--week") window = "week";
    else if (arg === "--month") window = "month";
    else if (arg === "--json") json = true;
    else if (arg === "--rules") rules = true;
    else if (arg === "--snooze") {
      const id = argv[i + 1] ?? "";
      const days = /^(\d+)d$/.exec(argv[i + 2] ?? "")?.[1];
      if (!/^R\d+$/.test(id) || days === undefined)
        return "--snooze needs a rule and days, e.g. --snooze R1 7d";
      snooze = { id, days: Number(days) };
      i += 2;
    } else return `Unknown insights argument: ${arg}`;
  }
  return { window, json, rules, snooze };
}

/** Stores a snooze in config.json; 0 days clears it. Returns the ISO time it ends (or null). */
export function snoozeRule(key: string, id: string, days: number, now: Date): string | null {
  const config = loadConfig(key);
  const { [id]: _, ...rest } = config.snoozed ?? {};
  const until =
    days > 0 ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString() : null;
  saveConfig(key, { ...config, snoozed: until === null ? rest : { ...rest, [id]: until } });
  return until;
}
