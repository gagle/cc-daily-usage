import { readFileSync } from "node:fs";
import path from "node:path";

import { localDateKey } from "./clock.js";
import {
  accountDir,
  loadLimitSamples,
  loadUsage,
  markNewerFile,
  writeVersionedFile,
} from "./config.js";
import { instructionFiles } from "./insights.js";
import { schemaVersionOf } from "./migrate.js";
import {
  advance,
  daysBetween,
  daysSoFar,
  emptyRecords,
  type RecordEntry,
  recordNotice,
  type RecordsFile,
  type RecordView,
  type Snapshot,
} from "./record.js";
import { rowsInRange } from "./report.js";
import { coach } from "./rules.js";
import { loadHabits, loadSessionTotals } from "./transcript-index.js";
import { emptyHabits, type Habits, parseRowKey, rollupUsd } from "./transcript-parse.js";

/** Format version of records.json (new file, versioned from the start). */
export const RECORDS_SCHEMA_VERSION = 1;

export function recordsFile(accountKey: string): string {
  return path.join(accountDir(accountKey), "records.json");
}

/** records.json; empty when missing or unreadable. A newer version reads as empty and is marked, so no save
 * overwrites it. */
export function loadRecords(accountKey: string): RecordsFile {
  const file = recordsFile(accountKey);
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return emptyRecords();
  }
  if (schemaVersionOf(value) > RECORDS_SCHEMA_VERSION) {
    markNewerFile(file);
    return emptyRecords();
  }
  const records = value.records as Partial<RecordsFile> | undefined;
  return { ...emptyRecords(), ...records };
}

export function saveRecords(accountKey: string, records: RecordsFile): void {
  writeVersionedFile(
    recordsFile(accountKey),
    JSON.stringify({ schemaVersion: RECORDS_SCHEMA_VERSION, records }),
  );
}

/** Epoch ms of local midnight starting `day`. */
function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
}

/** What the account's index and limit history hold for local days `from..to`; `days` is what rates divide
 * by. # ponytail: a session counts (sessions, active time) in the range of its last activity; a session that
 * spans two records counts once, in the later one. */
export function snapshotFor(
  accountKey: string,
  from: string,
  to: string,
  days: number,
  now: Date,
): Snapshot {
  const inRange = (day: string): boolean => day >= from && day <= to;
  const rows = rowsInRange(accountKey, { label: "record", from, to });
  const sessions = Object.fromEntries(
    Object.entries(loadSessionTotals(accountKey)).filter(([, session]) =>
      inRange(localDateKey(new Date(session.lastAt))),
    ),
  );
  let habits: Habits | null = null;
  for (const [day, counts] of Object.entries(loadHabits(accountKey))) {
    if (!inRange(day)) continue;
    const sum: Habits = habits ?? emptyHabits();
    for (const kind of Object.keys(counts) as Array<keyof Habits>) sum[kind] += counts[kind];
    habits = sum;
  }
  const usage = loadUsage(accountKey, now);
  const projects = [...new Set(rows.map(([key]) => parseRowKey(key).project))];
  const findings = coach({
    rows,
    instructions: instructionFiles(projects),
    sessions,
    missCauses: Object.fromEntries(
      Object.entries(usage.missCauses).filter(([day]) => inRange(day)),
    ),
    limits: null,
    budget: undefined,
    window: "week",
    snoozed: {},
    now,
  });
  const start = dayStart(from);
  const end = dayStart(to) + 86_400_000; // # ponytail: a 23/25 h DST day ends an hour off; peaks only
  const samples = loadLimitSamples(accountKey).filter(
    (sample) => sample.t >= start && sample.t < end,
  );
  const peak = (pick: (s: (typeof samples)[number]) => number | null): number | null => {
    const values = samples.map(pick).filter((value) => value !== null);
    return values.length === 0 ? null : Math.max(...values);
  };
  const models: Record<string, number> = {};
  let totals = {
    usd: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    growth: 0,
    usdCarry: 0,
    usdRewrite: 0,
    subagentUsd: 0,
    turns: 0,
  };
  let isFloor = false;
  for (const [key, row] of rows) {
    const { model, scope } = parseRowKey(key);
    const usd = rollupUsd(row);
    models[model] = (models[model] ?? 0) + usd;
    if (row.unpricedTurns > 0) isFloor = true;
    totals = {
      usd: totals.usd + usd,
      input: totals.input + row.input,
      output: totals.output + row.output,
      cacheRead: totals.cacheRead + row.cacheRead,
      cacheWrite: totals.cacheWrite + row.cacheWrite,
      growth: totals.growth + row.growth,
      usdCarry: totals.usdCarry + row.usdCarry,
      usdRewrite: totals.usdRewrite + row.usdRewrite,
      subagentUsd: totals.subagentUsd + (scope === "main" ? 0 : usd),
      turns: totals.turns + row.turns,
    };
  }
  return {
    from,
    to,
    days,
    ...totals,
    isFloor,
    sessions: Object.keys(sessions).length,
    activeMs: Object.values(sessions).reduce((sum, session) => sum + (session.turnMs ?? 0), 0),
    habits,
    models,
    rules: Object.fromEntries(
      // No limits and no budget: R8, the one rule with no $, never fires here.
      findings.map((finding) => [finding.id, Number(finding.usd)]),
    ),
    peak5h: peak((sample) => sample.fiveHourPct),
    peak7d: peak((sample) => sample.sevenDayPct),
  };
}

/** Starts, closes and restarts the account's records up to `now`; saves only on a change. Called by the
 * refresher after a pass that left nothing behind, and by `cc-spend record`. */
export function advanceRecord(accountKey: string, now: Date): RecordsFile {
  const file = loadRecords(accountKey);
  const next = advance(file, localDateKey(now), (from, to) =>
    snapshotFor(accountKey, from, to, daysBetween(from, to), now),
  );
  if (next !== file) saveRecords(accountKey, next);
  return next;
}

/** feed.json's `record`: the statusline's note for a record that closed since the last look. */
export function recordFeed(accountKey: string): { readonly notice: string | null } {
  return { notice: recordNotice(loadRecords(accountKey)) };
}

export interface RecordArgs {
  readonly all: boolean;
  readonly json: boolean;
  readonly days: number | null; // length of the next record
}

export function parseRecordArgs(argv: ReadonlyArray<string>): RecordArgs | string {
  let all = false;
  let json = false;
  let days: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") all = true;
    else if (arg === "--json") json = true;
    else if (arg === "--days") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 90)
        return "--days needs a whole number 1-90";
      days = value;
      i += 1;
    } else return `Unknown record argument: ${String(arg)}`;
  }
  return { all, json, days };
}

/** The view `cc-spend record` prints, and the records with the closed one marked as seen. */
export function recordView(
  accountKey: string,
  file: RecordsFile,
  now: Date,
): { readonly view: RecordView; readonly seen: RecordsFile } {
  const today = localDateKey(now);
  const current = file.current;
  const live =
    current === null
      ? null
      : snapshotFor(accountKey, current.from, today, daysSoFar(current, today), now);
  const closedNow: RecordEntry | null =
    file.unseen === null ? null : (file.closed.find((entry) => entry.n === file.unseen) ?? null);
  return { view: { file, live, today, closedNow }, seen: { ...file, unseen: null } };
}
