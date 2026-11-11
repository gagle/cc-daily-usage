import path from "node:path";

import { localDateKey } from "./clock.js";
import { loadSessionsMap } from "./config.js";
import { paint, type Segment, stacked } from "./meter.js";
import { cacheWriteRate, hasPromptTiers, ratesFor, tokensCost, WEB_SEARCH_USD } from "./pricing.js";
import { mtokBand } from "./session-model.js";
import {
  loadRollups,
  loadSessionTotals,
  type SessionTotals,
  UNATTRIBUTED,
} from "./transcript-index.js";
import {
  type CcModelUsage,
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
  readonly weekPct?: number | null; // --by session: share of the 7-day limit (needs $ per 1%)
  readonly usdPer100Lines?: number | null; // --by session: $ per 100 changed lines (statusline sessions)
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
  readonly activity: ReportActivity;
  readonly claudeCode: ClaudeCodeTotals | null; // Claude Code's own $ for the sessions it fully counted
}

/** Sessions in range whose every run left a `cost-state` line: Claude Code's $ next to the transcripts' $. */
export interface ClaudeCodeTotals {
  readonly sessions: number;
  readonly claudeCodeUsd: number;
  readonly transcriptUsd: number;
}

/** Time and hook totals of the sessions last active in the range (from Claude Code's system lines). */
export interface ReportActivity {
  readonly turnMs: number;
  readonly thinkingMs: number;
  readonly hookRuns: number;
  readonly entrypoints: Readonly<Record<string, number>>; // how sessions started → session count
  readonly attributedUsd: Readonly<Record<string, number>>; // `skill:<name>` / `mcp:<server>` → $
  readonly apiErrors: Readonly<Record<string, number>>; // `429 usage_limit_reached` → failed requests
}

export function activityOf(sessions: ReadonlyArray<SessionTotals>): ReportActivity {
  const entrypoints: Record<string, number> = {};
  const attributedUsd: Record<string, number> = {};
  const apiErrors: Record<string, number> = {};
  const add = (into: Record<string, number>, from: Readonly<Record<string, number>> = {}): void => {
    for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
  };
  let turnMs = 0;
  let thinkingMs = 0;
  let hookRuns = 0;
  for (const session of sessions) {
    turnMs += session.turnMs ?? 0;
    thinkingMs += session.thinkingMs ?? 0;
    hookRuns += session.hookRuns ?? 0;
    add(attributedUsd, session.attributedUsd);
    add(apiErrors, session.apiErrors);
    if (session.entrypoint) {
      entrypoints[session.entrypoint] = (entrypoints[session.entrypoint] ?? 0) + 1;
    }
  }
  return { turnMs, thinkingMs, hookRuns, entrypoints, attributedUsd, apiErrors };
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

function lastInRange(session: SessionTotals, range: DayRange): boolean {
  const day = localDateKey(new Date(session.lastAt));
  return day >= range.from && day <= range.to;
}

/** One model's tokens of one run at this table's prices; null for a model the table cannot re-price. */
function tablePrice(model: string, usage: CcModelUsage): number | null {
  const rates = ratesFor(model);
  if (rates === null || hasPromptTiers(model)) return null;
  return (
    tokensCost(usage.input, rates.input) +
    tokensCost(usage.output, rates.output) +
    tokensCost(usage.cacheRead, rates.cacheRead) +
    tokensCost(usage.cacheWrite5m + usage.cacheWriteOther, cacheWriteRate(rates, "5m")) +
    tokensCost(usage.cacheWrite1h, cacheWriteRate(rates, "1h")) +
    usage.webSearches * WEB_SEARCH_USD
  );
}

/**
 * Self-check: Claude Code's own $ per model and run (`cost-state`) against the same tokens at this table's
 * prices. Both price the same tokens, so a gap over 1% (on more than 5 cents) means the table is stale for that
 * model, or the run used fast mode. Haiku 5.5 is skipped: its price depends on each request's prompt size.
 */
export function selfCheck(
  totals: Readonly<Record<string, SessionTotals>>,
  range: DayRange,
): ReadonlyArray<string> {
  const worst = new Map<string, number>();
  for (const session of Object.values(totals)) {
    if (!lastInRange(session, range)) continue;
    for (const run of Object.values(session.ccRuns ?? {})) {
      for (const [model, usage] of Object.entries(run.models)) {
        const table = tablePrice(model, usage);
        if (table === null || usage.usd <= 0.05) continue;
        const gap = (table - usage.usd) / usage.usd;
        if (Math.abs(gap) > 0.01 && Math.abs(gap) > Math.abs(worst.get(model) ?? 0)) {
          worst.set(model, gap);
        }
      }
    }
  }
  return [...worst]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([model, gap]) =>
        `Claude Code prices ${model} ${String(Math.round(Math.abs(gap) * 100))}% ${gap < 0 ? "higher" : "lower"} than this table: a price change, or fast mode.`,
    );
}

/**
 * Claude Code's own total next to the transcripts' for the sessions it counted whole: a `cost-state` run
 * starts no later than the first turn, and the runs add up to at least the transcripts' $ (a run that ended
 * without its line would leave less). The difference is requests no transcript line shows.
 */
export function claudeCodeTotals(sessions: ReadonlyArray<SessionTotals>): ClaudeCodeTotals | null {
  let count = 0;
  let claudeCodeUsd = 0;
  let transcriptUsd = 0;
  for (const session of sessions) {
    const runs = Object.entries(session.ccRuns ?? {});
    if (runs.length === 0) continue;
    const firstStart = Math.min(...runs.map(([start]) => Number(start)));
    const usd = runs.reduce((sum, [, run]) => sum + run.usd, 0);
    if (firstStart > Date.parse(session.firstAt) || usd < session.usd * 0.99) continue;
    count += 1;
    claudeCodeUsd += usd;
    transcriptUsd += session.usd;
  }
  return count === 0 ? null : { sessions: count, claudeCodeUsd, transcriptUsd };
}

export function buildReport(
  owner: string,
  range: DayRange,
  by: Dimension,
  usdPerPercentWeek: number | null = null,
): Report {
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
  const names = owner === UNATTRIBUTED ? {} : loadSessionsMap(owner);
  const inRange = Object.entries(totals).filter(([, session]) => lastInRange(session, range));
  let rows: Array<ReportRow>;
  if (by === "component") {
    rows = COMPONENTS.map(([label, field]) => ({ label, rollup: componentRollup(total, field) }));
  } else if (by === "session") {
    rows = inRange.map(([id, session]) => {
      const lines = (names[id]?.linesAdded ?? 0) + (names[id]?.linesRemoved ?? 0);
      return {
        label: `${id.slice(0, 8)} ${names[id]?.name ?? path.basename(session.project)}`,
        rollup: { ...emptyRollup(), turns: session.turns, usdInput: session.usd },
        weekPct:
          usdPerPercentWeek && usdPerPercentWeek > 0 ? session.usd / usdPerPercentWeek : null,
        usdPer100Lines: lines > 0 ? session.usd / (lines / 100) : null,
      };
    });
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
    gaps: owner === UNATTRIBUTED ? [] : selfCheck(totals, range),
    activity: activityOf(inRange.map(([, session]) => session)),
    claudeCode: claudeCodeTotals(inRange.map(([, session]) => session)),
  };
}

/** One local day from the index: its $ and the top sessions (last active that day), models and projects. */
export interface DayBreakdown {
  readonly day: string;
  readonly usd: number;
  readonly sessions: ReadonlyArray<readonly [string, number]>;
  readonly models: ReadonlyArray<readonly [string, number]>;
  readonly projects: ReadonlyArray<readonly [string, number]>;
}

function top3(totals: ReadonlyMap<string, number>): ReadonlyArray<readonly [string, number]> {
  return [...totals]
    .filter(([, usd]) => usd > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
}

export function dayBreakdown(owner: string, day: string): DayBreakdown {
  const models = new Map<string, number>();
  const projects = new Map<string, number>();
  let usd = 0;
  for (const [key, rollup] of rowsInRange(owner, { label: day, from: day, to: day })) {
    const value = rollupUsd(rollup);
    usd += value;
    const model = labelOf(key, "model");
    const project = labelOf(key, "project");
    models.set(model, (models.get(model) ?? 0) + value);
    projects.set(project, (projects.get(project) ?? 0) + value);
  }
  const names = owner === UNATTRIBUTED ? {} : loadSessionsMap(owner);
  const sessions = new Map<string, number>();
  for (const [id, session] of Object.entries(loadSessionTotals(owner))) {
    if (localDateKey(new Date(session.lastAt)) !== day) continue;
    sessions.set(
      `${id.slice(0, 8)} ${names[id]?.name ?? path.basename(session.project)}`,
      session.usd,
    );
  }
  return { day, usd, sessions: top3(sessions), models: top3(models), projects: top3(projects) };
}

/** Whether the account's last 30 days hold a turn with no price (totals are then a floor). */
export function hasUnpricedTurns(owner: string, now: Date): boolean {
  const range = resolveRange("30d", now) as DayRange;
  return rowsInRange(owner, range).some(([, rollup]) => rollup.unpricedTurns > 0);
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** `3h12m` / `40m` / `<1m`. */
function hoursMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${String(minutes)}m` : `${String(hours)}h${String(minutes % 60)}m`;
}

/** `Turn time 3h12m (thinking 40m) · 123 hook runs · started from cli 12, sdk-ts 2`, or null when empty. */
function activityNote(activity: ReportActivity): string | null {
  const parts: Array<string> = [];
  if (activity.turnMs > 0 || activity.thinkingMs > 0) {
    parts.push(
      `Turn time ${hoursMinutes(activity.turnMs)} (thinking ${hoursMinutes(activity.thinkingMs)})`,
    );
  }
  if (activity.hookRuns > 0) parts.push(`${String(activity.hookRuns)} hook runs`);
  const starts = Object.entries(activity.entrypoints).sort(([, a], [, b]) => b - a);
  if (starts.length > 0) {
    parts.push(
      `started from ${starts.map(([name, count]) => `${name} ${String(count)}`).join(", ")}`,
    );
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

/** `Attributed: skill claude-api $12.40 · mcp tokensave $3.10 · …` (top 5), or null when nothing is. */
function attributionNote(activity: ReportActivity): string | null {
  const top = Object.entries(activity.attributedUsd)
    .filter(([, usd]) => usd >= 0.01)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (top.length === 0) return null;
  const items = top.map(([name, usd]) => `${name.replace(":", " ")} ${money(usd)}`);
  return `Attributed by Claude Code: ${items.join(" · ")}`;
}

/** `API errors 11: 429 usage_limit_reached ×8, 529 ×3`, or null with none. */
function apiErrorNote(activity: ReportActivity): string | null {
  const kinds = Object.entries(activity.apiErrors).sort(([, a], [, b]) => b - a);
  if (kinds.length === 0) return null;
  const total = kinds.reduce((sum, [, count]) => sum + count, 0);
  return `API errors ${String(total)}: ${kinds.map(([kind, count]) => `${kind} ×${String(count)}`).join(", ")}`;
}

/** `Efficiency: new work 44% · carry 41% · rewrite 15% · $9/MTok of new work (good)`, or null before any
 * turn with the split (rows indexed before 2026-10-18 have none). */
function efficiencyNote(total: Rollup): string | null {
  const base = total.usdNewWork + total.usdCarry + total.usdRewrite;
  if (base <= 0) return null;
  const share = (usd: number): string => `${String(Math.round((usd / base) * 100))}%`;
  const perMTok = total.growth > 0 ? (base / total.growth) * 1_000_000 : null;
  const mtok =
    perMTok === null ? "" : ` · $${perMTok.toFixed(0)}/MTok of new work (${mtokBand(perMTok)})`;
  return `Efficiency: new work ${share(total.usdNewWork)} · carry ${share(total.usdCarry)} · rewrite ${share(total.usdRewrite)}${mtok}`;
}

/** The report as a terminal table. */
const CHART: ReadonlyArray<{
  readonly rgb: string;
  readonly glyph: string;
  readonly label: string;
  readonly usd: (r: Rollup) => number;
}> = [
  { rgb: "99;150;230", glyph: "i", label: "input", usd: (r) => r.usdInput },
  { rgb: "200;120;220", glyph: "o", label: "output", usd: (r) => r.usdOutput },
  { rgb: "120;200;160", glyph: "r", label: "cache read", usd: (r) => r.usdCacheRead },
  { rgb: "240;180;80", glyph: "w", label: "cache write", usd: (r) => r.usdCacheWrite },
  {
    rgb: "230;110;110",
    glyph: "s",
    label: "web search",
    usd: (r) => r.webSearches * WEB_SEARCH_USD,
  },
];
const CHART_CELLS = 30;

export interface FormatOptions {
  readonly chart: boolean; // a stacked bar per row, scaled to the largest row
  readonly color: boolean;
}

const pctText = (value: number | null | undefined): string =>
  value == null ? "—" : `≈${value.toFixed(1)}%`;

export function formatReport(
  report: Report,
  options: FormatOptions = { chart: false, color: false },
): string {
  const sessions = report.by === "session";
  const header = ["", "input", "output", "cache read", "cache write", "total"];
  if (sessions) header.push("% of week", "$/100 lines");
  const cells = (label: string, r: Rollup, row?: ReportRow): ReadonlyArray<string> => {
    // The index keeps only a session's total, so its parts show as —.
    const part = (usd: number): string => (sessions && row ? "—" : money(usd));
    const out = [
      label,
      part(r.usdInput),
      part(r.usdOutput),
      part(r.usdCacheRead),
      part(r.usdCacheWrite),
      money(rollupUsd(r)),
    ];
    if (sessions) {
      out.push(
        row ? pctText(row.weekPct) : "",
        row?.usdPer100Lines == null ? (row ? "—" : "") : money(row.usdPer100Lines),
      );
    }
    return out;
  };
  // A chart by day reads left to right in time; every other view ranks by $.
  const rows =
    options.chart && report.by === "day"
      ? [...report.rows].sort((a, b) => a.label.localeCompare(b.label))
      : report.rows;
  const body = [
    header,
    ...rows.map((row) => cells(row.label, row.rollup, row)),
    cells("total", report.total),
  ];
  const widths = header.map((_, column) =>
    Math.max(...body.map((row) => (row[column] as string).length)),
  );
  const largest = Math.max(0, ...rows.map((row) => rollupUsd(row.rollup)));
  const chartOf = (index: number): string => {
    const row = rows[index - 1];
    if (!options.chart || row === undefined || largest <= 0) return "";
    const usd = rollupUsd(row.rollup);
    if (usd <= 0) return "";
    const segments: ReadonlyArray<Segment> = CHART.map((part) => ({
      value: part.usd(row.rollup),
      rgb: part.rgb,
      glyph: part.glyph,
    }));
    return `  ${stacked(segments, Math.max(1, Math.round((usd / largest) * CHART_CELLS)), options.color)}`;
  };
  const lines = body.map(
    (row, index) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[0] as number) : cell.padStart(widths[column] as number),
        )
        .join("  ") + chartOf(index),
  );
  const totalUsd = rollupUsd(report.total);
  const share = totalUsd === 0 ? 0 : Math.round((report.subagentUsd / totalUsd) * 100);
  const notes = [
    `${report.range.label} (${report.range.from} → ${report.range.to}), by ${report.by}. API-equivalent estimate, not a bill.`,
    `Subagents ${money(report.subagentUsd)} (${String(share)}%) · thinking ${money(report.total.usdThinking)} · web searches ${String(report.total.webSearches)} (${money(report.total.webSearches * WEB_SEARCH_USD)})`,
  ];
  if (options.chart) {
    notes.push(
      `chart: ${CHART.map((part) => (options.color ? paint(part.rgb, part.label, true) : `${part.glyph} ${part.label}`)).join(" · ")}`,
    );
  }
  const efficiency = efficiencyNote(report.total);
  if (efficiency !== null) notes.push(efficiency);
  const activity = activityNote(report.activity);
  if (activity !== null) notes.push(activity);
  for (const note of [attributionNote(report.activity), apiErrorNote(report.activity)]) {
    if (note !== null) notes.push(note);
  }
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
  const claudeCode = claudeCodeNote(report.claudeCode);
  if (claudeCode !== null) notes.push(claudeCode);
  notes.push(...report.gaps);
  if (report.rows.length === 0) return `No usage in ${report.range.label}.\n${notes[0] as string}`;
  return [...lines, "", ...notes].join("\n");
}

/** `Claude Code counted $41.20 for 12 sessions: $3.10 (8%) more than the transcripts show …`. */
function claudeCodeNote(totals: ClaudeCodeTotals | null): string | null {
  if (totals === null) return null;
  const extra = totals.claudeCodeUsd - totals.transcriptUsd;
  if (extra < 0.01) return null;
  const pct = totals.transcriptUsd > 0 ? Math.round((extra / totals.transcriptUsd) * 100) : 100;
  return `Claude Code counted ${money(totals.claudeCodeUsd)} for ${String(totals.sessions)} of these sessions: ${money(extra)} (${String(pct)}%) more than the transcripts show, in requests they do not record.`;
}

export interface ReportArgs {
  readonly period: string;
  readonly by: Dimension;
  readonly json: boolean;
  readonly account: string | null;
  readonly chart: boolean;
  readonly session: string | null; // id or id prefix: one session's burn-up instead of the table
}

/** `report [period] [--by <dim>] [--json] [--account <key>] [--chart] [--session <id>]` → args, or an error
 * message. */
export function parseReportArgs(argv: ReadonlyArray<string>): ReportArgs | string {
  let period = "week";
  let by: Dimension = "model";
  let json = false;
  let account: string | null = null;
  let chart = false;
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--chart") chart = true;
    else if (arg === "--session") {
      session = argv[++i] ?? "";
      if (session === "") return "--session needs a session id (or its first characters)";
    } else if (arg === "--by") {
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
  return { period, by, json, account, chart, session };
}
