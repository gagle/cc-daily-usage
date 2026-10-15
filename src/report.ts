import path from "node:path";

import { localDateKey } from "./clock.js";
import { loadSessionsMap } from "./config.js";
import type { SessionMapEntry } from "./interfaces/config.interface.js";
import {
  loadRollups,
  loadSessionTotals,
  type SessionTotals,
  UNATTRIBUTED,
} from "./transcript-index.js";
import {
  emptyRollup,
  mergeRollup,
  parseRowKey,
  type Rollup,
  rollupUsd,
} from "./transcript-parse.js";

export const PERIODS = ["today", "week", "month", "30d"] as const;
export const DIMENSIONS = ["model", "project", "component", "subagent", "session", "day"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Local days `from..to` inclusive, as YYYY-MM-DD. */
export interface DayRange {
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

function daysBack(now: Date, back: number): string {
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
}

/** `today`, `week` (rolling 7 local days), `month` (local month to date), `30d`, or `YYYY-MM`; null = bad. */
export function resolveRange(period: string, now: Date): DayRange | null {
  const today = localDateKey(now);
  if (period === "today") return { label: "today", from: today, to: today };
  if (period === "week") return { label: "last 7 days", from: daysBack(now, 6), to: today };
  if (period === "30d") return { label: "last 30 days", from: daysBack(now, 29), to: today };
  if (period === "month")
    return { label: today.slice(0, 7), from: `${today.slice(0, 7)}-01`, to: today };
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) return null;
  return { label: period, from: `${period}-01`, to: `${period}-31` };
}

/** Months a range touches, `YYYY-MM`. */
export function monthsOf(range: DayRange): ReadonlyArray<string> {
  const months: Array<string> = [];
  let year = Number(range.from.slice(0, 4));
  let month = Number(range.from.slice(5, 7));
  const last = range.to.slice(0, 7);
  for (;;) {
    const key = `${String(year)}-${String(month).padStart(2, "0")}`;
    months.push(key);
    if (key >= last) return months;
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
}

export interface ReportRow {
  readonly label: string;
  readonly rollup: Rollup;
}

export interface Report {
  readonly owner: string;
  readonly range: DayRange;
  readonly by: Dimension;
  readonly rows: ReadonlyArray<ReportRow>; // by $ descending
  readonly total: Rollup;
  readonly subagentUsd: number;
  readonly unattributedUsd: number; // same range, sessions no account claimed
  readonly gaps: ReadonlyArray<string>; // self-check notes
}

/** Rollups of `owner` inside `range`, keyed by row key. */
export function rowsInRange(owner: string, range: DayRange): ReadonlyArray<[string, Rollup]> {
  return [...loadRollups(owner, monthsOf(range))].filter(([key]) => {
    const { day } = parseRowKey(key);
    return day >= range.from && day <= range.to;
  });
}

function labelOf(key: string, by: Exclude<Dimension, "component" | "session">): string {
  const parts = parseRowKey(key);
  if (by === "project") return parts.project === "" ? "(unknown)" : path.basename(parts.project);
  if (by === "subagent")
    return parts.scope === "main" ? "main" : parts.scope.replace("subagent:", "");
  if (by === "day") return parts.day;
  return parts.speed === "fast" ? `${parts.model} (fast)` : parts.model;
}

const COMPONENTS: ReadonlyArray<readonly [string, keyof Rollup]> = [
  ["input", "usdInput"],
  ["output", "usdOutput"],
  ["cache read", "usdCacheRead"],
  ["cache write", "usdCacheWrite"],
];

/** A rollup holding only one $ component (for `--by component`). */
function componentRollup(total: Rollup, field: keyof Rollup): Rollup {
  return { ...emptyRollup(), [field]: total[field] };
}

/**
 * Self-check: per session in range, index $ vs Claude Code's own `cost.total_cost_usd` last seen by the
 * statusline. A gap over 5% (and over a cent) on a fully priced session names its models: the price table
 * may be stale for them.
 */
export function selfCheck(
  totals: Readonly<Record<string, SessionTotals>>,
  seen: Readonly<Record<string, SessionMapEntry>>,
  range: DayRange,
): ReadonlyArray<string> {
  const stale = new Set<string>();
  for (const [sessionId, session] of Object.entries(totals)) {
    const statusline = seen[sessionId];
    if (!statusline || session.unpricedTurns > 0) continue;
    const day = localDateKey(new Date(session.lastAt));
    if (day < range.from || day > range.to) continue;
    const gap = Math.abs(session.usd - statusline.costUsd);
    if (gap > 0.01 && gap > statusline.costUsd * 0.05)
      for (const model of session.models) stale.add(model);
  }
  return [...stale].sort().map((model) => `price table may be stale for ${model}`);
}

export function buildReport(owner: string, range: DayRange, by: Dimension): Report {
  const entries = rowsInRange(owner, range);
  const total = emptyRollup();
  let subagentUsd = 0;
  const groups = new Map<string, Rollup>();
  for (const [key, rollup] of entries) {
    mergeRollup(total, rollup);
    if (parseRowKey(key).scope !== "main") subagentUsd += rollupUsd(rollup);
    if (by === "component" || by === "session") continue;
    const label = labelOf(key, by);
    const group = groups.get(label) ?? emptyRollup();
    mergeRollup(group, rollup);
    groups.set(label, group);
  }
  const totals = loadSessionTotals(owner);
  let rows: Array<ReportRow>;
  if (by === "component") {
    rows = COMPONENTS.map(([label, field]) => ({ label, rollup: componentRollup(total, field) }));
  } else if (by === "session") {
    rows = Object.entries(totals)
      .filter(([, session]) => {
        const day = localDateKey(new Date(session.lastAt));
        return day >= range.from && day <= range.to;
      })
      .map(([id, session]) => ({
        label: `${id.slice(0, 8)} ${path.basename(session.project)}`,
        rollup: { ...emptyRollup(), turns: session.turns, usdInput: session.usd },
      }));
  } else {
    rows = [...groups].map(([label, rollup]) => ({ label, rollup }));
  }
  rows.sort((a, b) => rollupUsd(b.rollup) - rollupUsd(a.rollup));
  const unattributed =
    owner === UNATTRIBUTED
      ? 0
      : rowsInRange(UNATTRIBUTED, range).reduce((sum, [, rollup]) => sum + rollupUsd(rollup), 0);
  return {
    owner,
    range,
    by,
    rows,
    total,
    subagentUsd,
    unattributedUsd: unattributed,
    gaps: owner === UNATTRIBUTED ? [] : selfCheck(totals, loadSessionsMap(owner), range),
  };
}

/** Whether the account's last 30 days hold a turn with no price (totals are then a floor). */
export function hasUnpricedTurns(owner: string, now: Date): boolean {
  const range = resolveRange("30d", now) as DayRange;
  return rowsInRange(owner, range).some(([, rollup]) => rollup.unpricedTurns > 0);
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** The report as a terminal table. */
export function formatReport(report: Report): string {
  const header = ["", "input", "output", "cache read", "cache write", "total"];
  const cells = (label: string, r: Rollup): ReadonlyArray<string> => [
    label,
    money(r.usdInput),
    money(r.usdOutput),
    money(r.usdCacheRead),
    money(r.usdCacheWrite),
    money(rollupUsd(r)),
  ];
  const body = [
    header,
    ...report.rows.map((row) => cells(row.label, row.rollup)),
    cells("total", report.total),
  ];
  const widths = header.map((_, column) =>
    Math.max(...body.map((row) => (row[column] as string).length)),
  );
  const lines = body.map((row) =>
    row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[0] as number) : cell.padStart(widths[column] as number),
      )
      .join("  "),
  );
  const totalUsd = rollupUsd(report.total);
  const share = totalUsd === 0 ? 0 : Math.round((report.subagentUsd / totalUsd) * 100);
  const notes = [
    `${report.range.label} (${report.range.from} → ${report.range.to}), by ${report.by}. API-equivalent estimate, not a bill.`,
    `Subagents ${money(report.subagentUsd)} (${String(share)}%) · thinking ${money(report.total.usdThinking)} · web searches ${String(report.total.webSearches)}`,
  ];
  if (report.total.unpricedTurns > 0) {
    notes.push(
      `${String(report.total.unpricedTurns)} turns on models with no price: totals are a floor.`,
    );
  }
  if (report.unattributedUsd > 0) {
    notes.push(
      `${money(report.unattributedUsd)} more in sessions no account claimed (report --account unattributed).`,
    );
  }
  notes.push(...report.gaps);
  if (report.rows.length === 0) return `No usage in ${report.range.label}.\n${notes[0] as string}`;
  return [...lines, "", ...notes].join("\n");
}

export interface ReportArgs {
  readonly period: string;
  readonly by: Dimension;
  readonly json: boolean;
  readonly account: string | null;
}

/** `report [period] [--by <dim>] [--json] [--account <key>]` → args, or an error message. */
export function parseReportArgs(argv: ReadonlyArray<string>): ReportArgs | string {
  let period = "week";
  let by: Dimension = "model";
  let json = false;
  let account: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--by") {
      const value = argv[++i] ?? "";
      if (!(DIMENSIONS as ReadonlyArray<string>).includes(value)) {
        return `--by needs one of: ${DIMENSIONS.join(", ")}`;
      }
      by = value as Dimension;
    } else if (arg === "--account") {
      account = argv[++i] ?? "";
      if (account === "") return "--account needs an account key";
    } else if ((PERIODS as ReadonlyArray<string>).includes(arg) || /^\d{4}-\d{2}$/.test(arg)) {
      period = arg;
    } else return `Unknown report argument: ${arg}`;
  }
  return { period, by, json, account };
}
