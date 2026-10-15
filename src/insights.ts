import { localDateKey } from "./clock.js";
import { loadConfig, saveConfig } from "./config.js";
import type { Feed, Finding } from "./feed.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";
import { type DayRange, resolveRange, rowsInRange } from "./report.js";
import { coach } from "./rules.js";
import { loadSessionTotals } from "./transcript-index.js";

export type CoachWindow = "week" | "month";

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
  return coach({
    rows: rowsInRange(key, range),
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

const money = (usd: number | null): string => (usd === null ? "—" : `~$${usd.toFixed(2)}`);

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
      `${finding.id}  ${finding.title}  ${money(finding.usd)}/${window}${snoozed}`,
      `    ${finding.evidence}`,
      `    fix: ${finding.fix.text}${fix === finding.fix.text ? "" : ` → ${fix}`}`,
    ].join("\n");
  });
  return [
    ...lines,
    "",
    "API-equivalent estimates. Snooze one: cc-daily-usage insights --snooze R1 7d",
  ].join("\n");
}

export interface InsightsArgs {
  readonly window: CoachWindow;
  readonly json: boolean;
  readonly snooze: { readonly id: string; readonly days: number } | null;
}

/** `insights [--week|--month] [--json] [--snooze <rule> <N>d]` → args, or an error message. */
export function parseInsightsArgs(argv: ReadonlyArray<string>): InsightsArgs | string {
  let window: CoachWindow = "week";
  let json = false;
  let snooze: InsightsArgs["snooze"] = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--week") window = "week";
    else if (arg === "--month") window = "month";
    else if (arg === "--json") json = true;
    else if (arg === "--snooze") {
      const id = argv[i + 1] ?? "";
      const days = /^(\d+)d$/.exec(argv[i + 2] ?? "")?.[1];
      if (!/^R\d+$/.test(id) || days === undefined)
        return "--snooze needs a rule and days, e.g. --snooze R1 7d";
      snooze = { id, days: Number(days) };
      i += 2;
    } else return `Unknown insights argument: ${arg}`;
  }
  return { window, json, snooze };
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
