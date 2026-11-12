import { CACHE_READ_GOOD, REREAD_GOOD, RESEND_GOOD } from "./advisor.js";
import { ruleInfo } from "./rules.js";
import { MTOK_GOOD } from "./session-model.js";
import type { Habits } from "./transcript-parse.js";

/**
 * The record: back-to-back periods (7 local days by default) that start and end by themselves, each frozen
 * when it closes and compared with the 7 days before the first one (the baseline) and with the record before
 * it. Pure and Node-free; the files and the index live in `src/record-store.ts`.
 */

/** Length of a record in local days, unless `record --days` set another. */
export const RECORD_DAYS = 7;
/** The baseline: this many local days before record #1. */
export const BASELINE_DAYS = 7;
/** Closed records kept. # ponytail: a year of weekly records; older ones drop, the baseline stays. */
export const KEEP_RECORDS = 52;
/** Before this many days a live record's rates are still noise. */
export const SETTLE_DAYS = 3;
/** A rate change smaller than this is noise (`≈`): 3% relative for $, 2 points for a share. */
export const SAME_RELATIVE = 0.03;
export const SAME_POINTS = 0.02;
/** A rule's $ per week must move this much to be listed. */
export const MIN_MOVE_USD = 0.5;
/** Rules that are not waste you can cut: R6 is relative to your median, R8 has no $, R10 and R11 are the
 * re-reading and re-sending scores already. They count neither in "avoidable $" nor as a focus (R6, R8). */
const NOT_AVOIDABLE: ReadonlySet<string> = new Set(["R6", "R8", "R10", "R11"]);
const NOT_FOCUS: ReadonlySet<string> = new Set(["R6", "R8"]);

/** Everything the record measures over a range of local days. */
export interface Snapshot {
  readonly from: string; // YYYY-MM-DD, inclusive
  readonly to: string;
  readonly days: number; // days covered: the whole range, or the days so far for a live record
  readonly usd: number;
  readonly isFloor: boolean; // an unpriced model was seen: $ is a floor
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly growth: number; // context growth + output: new work
  readonly usdCarry: number;
  readonly usdRewrite: number;
  readonly subagentUsd: number;
  readonly turns: number;
  readonly sessions: number;
  readonly activeMs: number;
  readonly habits: Habits | null; // null: no day of the range was counted (indexed before habits existed)
  readonly models: Readonly<Record<string, number>>; // model → $
  readonly rules: Readonly<Record<string, number>>; // rule id → $ in the range
  readonly peak5h: number | null; // highest 5h / 7d % read in the range
  readonly peak7d: number | null;
}

export interface RecordEntry {
  readonly n: number;
  readonly from: string;
  readonly to: string;
  readonly focus: string | null; // rule id to work on, from the record (or baseline) before
  readonly focusShare: number | null; // that rule's share of $ where it was picked
  readonly snapshot?: Snapshot; // set when the record closed
}

/** accounts/<key>/records.json */
export interface RecordsFile {
  readonly days: number; // length of the next record
  readonly baseline: Snapshot | null; // null: no use in the days before record #1
  readonly current: RecordEntry | null;
  readonly closed: ReadonlyArray<RecordEntry>;
  readonly unseen: number | null; // a closed record `cc-spend record` has not shown yet
}

export function emptyRecords(): RecordsFile {
  return { days: RECORD_DAYS, baseline: null, current: null, closed: [], unseen: null };
}

// ── days ──

/** `day` + `n` local days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d + n);
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local days `from..to` inclusive. */
export function daysBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((day) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  }) as [number, number];
  return Math.round((b - a) / 86_400_000) + 1;
}

// ── metrics ──

export type Metric = "perMTok" | "avoidable" | "cacheReads" | "resend" | "reread";

export interface MetricInfo {
  readonly id: Metric;
  readonly label: string;
  readonly aim: string;
  readonly higherIsBetter: boolean;
  readonly share: boolean; // a 0-1 share (compared in points) or $ (compared relatively)
  readonly good: (value: number) => boolean;
}

const pct = (fraction: number): string => `${String(Math.round(fraction * 100))}%`;

export const METRICS: ReadonlyArray<MetricInfo> = [
  {
    id: "perMTok",
    label: "$ per MTok new work",
    aim: `< $${String(MTOK_GOOD)}`,
    higherIsBetter: false,
    share: false,
    good: (v) => v < MTOK_GOOD,
  },
  {
    id: "avoidable",
    label: "avoidable $",
    aim: "< 10%",
    higherIsBetter: false,
    share: true,
    good: (v) => v < 0.1,
  },
  {
    id: "cacheReads",
    label: "cache reads",
    aim: `≥ ${pct(CACHE_READ_GOOD)}`,
    higherIsBetter: true,
    share: true,
    good: (v) => v >= CACHE_READ_GOOD,
  },
  {
    id: "resend",
    label: "re-sending",
    aim: `< ${pct(RESEND_GOOD)}`,
    higherIsBetter: false,
    share: true,
    good: (v) => v < RESEND_GOOD,
  },
  {
    id: "reread",
    label: "re-reading",
    aim: `< ${pct(REREAD_GOOD)}`,
    higherIsBetter: false,
    share: true,
    good: (v) => v < REREAD_GOOD,
  },
];

/** $ of the rules that are waste you can cut, capped at the total (rules overlap). */
export function avoidableUsd(snapshot: Snapshot): number {
  const sum = Object.entries(snapshot.rules)
    .filter(([id]) => !NOT_AVOIDABLE.has(id))
    .reduce((total, [, usd]) => total + usd, 0);
  return Math.min(snapshot.usd, sum);
}

/** One habit's value; null when the snapshot has nothing to divide by. */
export function metricValue(snapshot: Snapshot, metric: Metric): number | null {
  const { usd } = snapshot;
  if (metric === "perMTok") {
    return snapshot.growth > 0 ? (usd / snapshot.growth) * 1_000_000 : null;
  }
  if (metric === "cacheReads") {
    const fed = snapshot.input + snapshot.cacheRead + snapshot.cacheWrite;
    return fed > 0 ? snapshot.cacheRead / fed : null;
  }
  if (usd <= 0) return null;
  if (metric === "avoidable") return avoidableUsd(snapshot) / usd;
  return (metric === "resend" ? snapshot.usdRewrite : snapshot.usdCarry) / usd;
}

export type Change = "better" | "worse" | "same";

/** `after` against `before` for a value where lower (or higher) is better; null when either is unknown. */
export function changeOf(
  before: number | null,
  after: number | null,
  higherIsBetter: boolean,
  share: boolean,
): Change | null {
  if (before === null || after === null) return null;
  const delta = after - before;
  const small = share
    ? Math.abs(delta) < SAME_POINTS
    : before === 0 || Math.abs(delta / before) < SAME_RELATIVE;
  if (small) return "same";
  return delta > 0 === higherIsBetter ? "better" : "worse";
}

export function metricChange(
  before: Snapshot | null | undefined,
  after: Snapshot | null | undefined,
  metric: MetricInfo,
): Change | null {
  if (!before || !after) return null;
  return changeOf(
    metricValue(before, metric.id),
    metricValue(after, metric.id),
    metric.higherIsBetter,
    metric.share,
  );
}

/** How many of the habits got better from `before` to `after`, out of those both can measure. */
export function habitsBetter(
  before: Snapshot,
  after: Snapshot,
): { readonly better: number; readonly of: number } {
  const changes = METRICS.map((metric) => metricChange(before, after, metric)).filter(
    (change) => change !== null,
  );
  return { better: changes.filter((change) => change === "better").length, of: changes.length };
}

/** $ per week the new $/MTok saves (positive) or costs (negative) on the new work done at it. */
export function savedPerWeek(before: Snapshot, after: Snapshot): number | null {
  const was = metricValue(before, "perMTok");
  const now = metricValue(after, "perMTok");
  if (was === null || now === null || after.days <= 0) return null;
  return (((was - now) * after.growth) / 1_000_000) * (7 / after.days);
}

/** A rule's $ per 7 days. */
function weekly(snapshot: Snapshot, id: string): number {
  return ((snapshot.rules[id] ?? 0) * 7) / Math.max(1, snapshot.days);
}

export interface RuleMove {
  readonly id: string;
  readonly title: string;
  readonly usdPerWeek: number; // after − before; negative = less waste
}

/** Rules whose $ per week moved at least MIN_MOVE_USD: the two that dropped most, the two that grew most. */
export function ruleMoves(
  before: Snapshot,
  after: Snapshot,
): { readonly better: ReadonlyArray<RuleMove>; readonly worse: ReadonlyArray<RuleMove> } {
  const ids = [...new Set([...Object.keys(before.rules), ...Object.keys(after.rules)])];
  const moves = ids
    .map((id) => ({
      id,
      title: ruleInfo(id)?.title ?? id,
      usdPerWeek: weekly(after, id) - weekly(before, id),
    }))
    .filter((move) => Math.abs(move.usdPerWeek) >= MIN_MOVE_USD);
  return {
    better: moves
      .filter((move) => move.usdPerWeek < 0)
      .sort((a, b) => a.usdPerWeek - b.usdPerWeek)
      .slice(0, 2),
    worse: moves
      .filter((move) => move.usdPerWeek > 0)
      .sort((a, b) => b.usdPerWeek - a.usdPerWeek)
      .slice(0, 2),
  };
}

/** The rule with the most $ that is a habit to change, and its share of $. */
export function pickFocus(snapshot: Snapshot | null | undefined): {
  readonly focus: string | null;
  readonly focusShare: number | null;
} {
  if (!snapshot || snapshot.usd <= 0) return { focus: null, focusShare: null };
  const top = Object.entries(snapshot.rules)
    .filter(([id]) => !NOT_FOCUS.has(id))
    .sort((a, b) => b[1] - a[1])[0];
  return top
    ? { focus: top[0], focusShare: top[1] / snapshot.usd }
    : { focus: null, focusShare: null };
}

/** The focus rule's share of $ now against where it was picked. */
export function focusChange(entry: RecordEntry, snapshot: Snapshot): Change | null {
  if (entry.focus === null || entry.focusShare === null || snapshot.usd <= 0) return null;
  return changeOf(entry.focusShare, (snapshot.rules[entry.focus] ?? 0) / snapshot.usd, false, true);
}

// ── lifecycle ──

export type SnapshotOf = (from: string, to: string) => Snapshot;

/** The entry that starts on `from`, with its focus picked from `source`. */
function startEntry(
  n: number,
  from: string,
  days: number,
  source: Snapshot | null | undefined,
): RecordEntry {
  return { n, from, to: addDays(from, days - 1), ...pickFocus(source) };
}

/**
 * Moves the records to `today`: starts record #1 (and freezes the baseline) when there is none, closes the
 * current record once `today` is past its last day and starts the next one the day after. A closed record with
 * no turns is not kept; the next one then starts today, with the same number and focus.
 */
export function advance(file: RecordsFile, today: string, snapshotOf: SnapshotOf): RecordsFile {
  if (file.current === null) {
    const taken = snapshotOf(addDays(today, -BASELINE_DAYS), addDays(today, -1));
    const baseline = taken.turns > 0 ? taken : null;
    return { ...file, baseline, current: startEntry(1, today, file.days, baseline) };
  }
  let next = file;
  let current = file.current;
  while (today > current.to) {
    const snapshot = snapshotOf(current.from, current.to);
    current =
      snapshot.turns === 0
        ? { ...current, from: today, to: addDays(today, next.days - 1) }
        : startEntry(current.n + 1, addDays(current.to, 1), next.days, snapshot);
    next =
      snapshot.turns === 0
        ? { ...next, current }
        : {
            ...next,
            closed: [...next.closed, { ...(next.current as RecordEntry), snapshot }].slice(
              -KEEP_RECORDS,
            ),
            unseen: (next.current as RecordEntry).n,
            current,
          };
  }
  return next;
}

/** Days of `entry` up to `today`, at least 1, at most its length. */
export function daysSoFar(entry: RecordEntry, today: string): number {
  const length = daysBetween(entry.from, entry.to);
  return Math.max(1, Math.min(length, daysBetween(entry.from, today)));
}

/** The statusline's note for a closed record nobody has looked at yet; null when there is none. */
export function recordNotice(file: RecordsFile): string | null {
  if (file.unseen === null) return null;
  const index = file.closed.findIndex((entry) => entry.n === file.unseen);
  const entry = file.closed[index];
  if (!entry?.snapshot) return null;
  const against = file.baseline ?? file.closed[index - 1]?.snapshot;
  const score = against ? habitsBetter(against, entry.snapshot) : null;
  const habits =
    score && score.of > 0 ? `: ${String(score.better)}/${String(score.of)} habits better` : "";
  return `record #${String(entry.n)} done${habits} · cc-spend record`;
}

// ── screen ──

export interface RecordView {
  readonly file: RecordsFile;
  readonly live: Snapshot | null; // the current record so far
  readonly today: string;
  readonly closedNow: RecordEntry | null; // the record that closed since the last look
}

type Paint = (code: string, text: string) => string;

function painter(color: boolean): Paint {
  return (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
}

const BOLD = "1";
const DIM = "2";
// Truecolor, the statusline's own red (`❄ cold`) and a matching green.
const GREEN = "1;38;2;80;220;120";
const RED = "1;38;2;248;105;107";
const ORANGE = "38;5;208";
/** A pill: bold text on a dark tint of the same hue, for the "vs" cell. */
const GREEN_PILL = "1;38;2;80;220;120;48;2;18;58;34";
const RED_PILL = "1;38;2;248;105;107;48;2;70;22;24";

const money = (usd: number): string =>
  usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2).replace(/\.00$/, "")}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 26" */
export function shortDay(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1] as string} ${String(Number(day.slice(8, 10)))}`;
}

function valueText(metric: MetricInfo, value: number | null): string {
  if (value === null) return "—";
  return metric.share ? pct(value) : `$${value.toFixed(0)}`;
}

function deltaText(metric: MetricInfo, before: number | null, after: number | null): string {
  if (before === null || after === null) return "";
  if (metric.share) {
    const points = Math.round((after - before) * 100);
    return `${points > 0 ? "+" : points < 0 ? "−" : "±"}${String(Math.abs(points))}pt`;
  }
  if (before === 0) return "";
  const relative = Math.round(((after - before) / before) * 100);
  return `${relative > 0 ? "+" : relative < 0 ? "−" : "±"}${String(Math.abs(relative))}%`;
}

/** A value against its aim: green when met, red when not; dim before it settles. */
function aimPaint(metric: MetricInfo, value: number | null, text: string, paint: Paint): string {
  if (value === null) return paint(DIM, text);
  return paint(metric.good(value) ? GREEN : RED, text);
}

/** The "vs" cell: `−15% ✔` in a green pill, `+3pt ✖` in a red one, `≈` dim. */
function vsCell(delta: string, change: Change | null, paint: Paint): string {
  const text = ` ${pad(delta, 6, true)} ${change === "better" ? "✔" : change === "worse" ? "✖" : change === "same" ? "≈" : " "} `;
  if (change === "better") return paint(GREEN_PILL, text);
  if (change === "worse") return paint(RED_PILL, text);
  return change === "same" ? paint(DIM, text) : text;
}

function mark(change: Change, paint: Paint): string {
  if (change === "better") return paint(GREEN, "✔");
  return change === "worse" ? paint(RED, "✖") : paint(DIM, "≈");
}

/** Pads to `width` columns, counting what is printed (ANSI codes take no column). */
function pad(text: string, width: number, left = false): string {
  // eslint-disable-next-line no-control-regex
  const shown = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  const space = " ".repeat(Math.max(0, width - shown));
  return left ? space + text : text + space;
}

function bar(fraction: number, cells: number): string {
  const full = Math.round(Math.max(0, Math.min(1, fraction)) * cells);
  return `▕${"█".repeat(full)}${"░".repeat(cells - full)}▏`;
}

function habitsTable(
  base: Snapshot | null,
  prev: Snapshot | null,
  now: Snapshot,
  paint: Paint,
  dim: boolean,
): ReadonlyArray<string> {
  const head = [
    pad("HABITS", 22),
    pad("baseline", 9, true),
    pad(prev ? "prev" : "", 8, true),
    pad("now", 8, true),
    pad(prev ? "vs prev " : "vs base ", 12, true),
    pad("aim", 8, true),
  ].join("");
  const rows = METRICS.map((metric) => {
    const valueNow = metricValue(now, metric.id);
    const ref = prev ?? base;
    const refValue = ref ? metricValue(ref, metric.id) : null;
    const change = ref ? metricChange(ref, now, metric) : null;
    const nowText = valueText(metric, valueNow);
    return [
      pad(metric.label, 22),
      pad(paint(DIM, base ? valueText(metric, metricValue(base, metric.id)) : "—"), 9, true),
      pad(prev ? valueText(metric, metricValue(prev, metric.id)) : "", 8, true),
      // Meeting the aim is a fact on any day; only the comparison waits for SETTLE_DAYS.
      pad(aimPaint(metric, valueNow, nowText, paint), 8, true),
      pad(vsCell(deltaText(metric, refValue, valueNow), dim ? null : change, paint), 12, true),
      pad(paint(DIM, metric.aim), 8, true),
    ].join("");
  });
  return [paint(BOLD, head), ...rows];
}

function verdictLine(base: Snapshot | null, now: Snapshot): string {
  if (!base)
    return "No baseline yet: no use in the 7 days before record #1. This record becomes it.";
  const score = habitsBetter(base, now);
  const saved = savedPerWeek(base, now);
  const money7 =
    saved === null || Math.abs(saved) < MIN_MOVE_USD
      ? ""
      : saved > 0
        ? ` · ~${money(saved)}/week saved at your new rates`
        : ` · ~${money(-saved)}/week more at your new rates`;
  return `${String(score.better)} of ${String(score.of)} habits better than baseline${money7}`;
}

function focusLines(
  entry: RecordEntry,
  now: Snapshot,
  paint: Paint,
  dim: boolean,
): ReadonlyArray<string> {
  if (entry.focus === null) return [];
  const info = ruleInfo(entry.focus);
  const share = now.usd > 0 ? (now.rules[entry.focus] ?? 0) / now.usd : 0;
  const change = focusChange(entry, now);
  const verdict =
    dim || change === null
      ? ""
      : ` · ${change === "better" ? paint(GREEN, "better ✔") : change === "worse" ? paint(RED, "worse ✖") : paint(DIM, "same ≈")}`;
  const was = entry.focusShare === null ? "" : ` (was ${pct(entry.focusShare)})`;
  return [
    `${paint(ORANGE, "FOCUS")}  ${entry.focus} ${info?.title ?? ""} · ${info?.action ?? ""}`,
    `       ${pct(share)} of $ now${was}${verdict}`,
  ];
}

function moveLines(before: Snapshot | null, now: Snapshot, paint: Paint): ReadonlyArray<string> {
  if (!before) return [];
  const { better, worse } = ruleMoves(before, now);
  if (better.length === 0 && worse.length === 0) return [];
  const line = (move: RuleMove): string =>
    `${pad(`${move.id} ${move.title}`, 38)}${pad(`${move.usdPerWeek < 0 ? "−" : "+"}${money(Math.abs(move.usdPerWeek))}/week`, 14, true)}`;
  return [
    ...better.map(
      (move, i) => `${i === 0 ? "MOVED  better  " : "               "}${paint(GREEN, line(move))}`,
    ),
    ...worse.map(
      (move, i) =>
        `${i === 0 ? (better.length === 0 ? "MOVED  worse   " : "       worse   ") : "               "}${paint(RED, line(move))}`,
    ),
  ];
}

function hours(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, "0")}m`;
}

function volumeLines(
  base: Snapshot | null,
  prev: Snapshot | null,
  now: Snapshot,
  paint: Paint,
): ReadonlyArray<string> {
  const floor = now.isFloor ? "≥ " : "";
  const ref = (label: string, s: Snapshot | null, text: (s: Snapshot) => string): string =>
    s ? `${label} ${text(s)}` : "";
  const refs = (text: (s: Snapshot) => string): string =>
    paint(DIM, [ref("prev", prev, text), ref("baseline", base, text)].filter(Boolean).join(" · "));
  const lines = [
    paint(BOLD, "VOLUME") + paint(DIM, " (context only, not scored)"),
    `${pad("$ total", 11)}${pad(`${floor}${money(now.usd)} so far`, 16)}${refs((s) => money(s.usd))}`,
  ];
  const prompts = (s: Snapshot): number | null => (s.habits ? s.habits.prompt : null);
  const nowPrompts = prompts(now);
  if (nowPrompts !== null) {
    const perDay = (s: Snapshot): string => {
      const p = prompts(s);
      return p === null ? "—" : `${String(Math.round(p / s.days))}/day`;
    };
    lines.push(`${pad("prompts", 11)}${pad(perDay(now), 16)}${refs(perDay)}`);
    const perPrompt = (s: Snapshot): string => {
      const p = prompts(s);
      return p ? money(s.usd / p) : "—";
    };
    lines.push(`${pad("$/prompt", 11)}${pad(perPrompt(now), 16)}${refs(perPrompt)}`);
    const h = now.habits as Habits;
    lines.push(
      `${pad("commands", 11)}${String(h.clear)} /clear · ${String(h.compact)} /compact · ${String(h.autoCompact)} auto-compact · ${String(h.model)} /model · ${String(h.interrupt)} interrupts`,
    );
  }
  const top = Object.entries(now.models).sort((a, b) => b[1] - a[1])[0];
  const model =
    top && now.usd > 0 ? ` · ${top[0].replace(/^claude-/, "")} ${pct(top[1] / now.usd)} of $` : "";
  const peak = now.peak7d === null ? "" : ` · 7d peak ${String(Math.round(now.peak7d))}%`;
  lines.push(
    `${pad("active", 11)}${hours(now.activeMs / now.days)}/day · ${String(now.sessions)} sessions${model}${peak}`,
  );
  return lines;
}

/** The `cc-spend record` screen: the current record so far against the baseline and the record before it. */
export function formatRecord(view: RecordView, color: boolean): string {
  const paint = painter(color);
  const { file, live, today } = view;
  const current = file.current;
  if (current === null || live === null) {
    return "No record yet. The first one starts with the next background refresh (open Claude Code).";
  }
  const out: Array<string> = [];
  const closed = view.closedNow;
  if (closed?.snapshot) {
    const before = file.closed[file.closed.indexOf(closed) - 1]?.snapshot ?? null;
    out.push(
      paint(
        BOLD,
        `RECORD #${String(closed.n)} CLOSED  ${shortDay(closed.from)} → ${shortDay(closed.to)}`,
      ),
      verdictLine(file.baseline, closed.snapshot),
    );
    const change = focusChange(closed, closed.snapshot);
    if (closed.focus !== null && change !== null) {
      const word =
        change === "better"
          ? paint(GREEN, "✔ done")
          : change === "worse"
            ? paint(RED, "✖ not yet")
            : paint(DIM, "≈ same");
      out.push(`Focus ${closed.focus} ${ruleInfo(closed.focus)?.title ?? ""}: ${word}`);
    }
    if (before) {
      const score = habitsBetter(before, closed.snapshot);
      out.push(
        paint(
          DIM,
          `vs record #${String(closed.n - 1)}: ${String(score.better)} of ${String(score.of)} habits better`,
        ),
      );
    }
    const focus =
      current.focus === null
        ? ""
        : ` · new focus: ${current.focus} ${ruleInfo(current.focus)?.title ?? ""}`;
    out.push("", `Record #${String(current.n)} started ${shortDay(current.from)}${focus}`, "");
  }
  const length = daysBetween(current.from, current.to);
  const soFar = daysSoFar(current, today);
  const early = soFar < SETTLE_DAYS;
  out.push(
    `${paint(BOLD, `RECORD #${String(current.n)}`)}  ${shortDay(current.from)} → ${shortDay(current.to)}  ${bar(soFar / length, 20)} day ${String(soFar)}/${String(length)} · ends ${shortDay(addDays(current.to, 1))}`,
  );
  out.push(
    early
      ? paint(
          DIM,
          `Too early: ${String(soFar)} day(s). Numbers settle after day ${String(SETTLE_DAYS)}.`,
        )
      : verdictLine(file.baseline, live),
  );
  const prev = file.closed.at(-1)?.snapshot ?? null;
  out.push("", ...habitsTable(file.baseline, prev, live, paint, early));
  const focus = focusLines(current, live, paint, early);
  if (focus.length > 0) out.push("", ...focus);
  const moves = early ? [] : moveLines(prev ?? file.baseline, live, paint);
  if (moves.length > 0) out.push("", ...moves);
  out.push("", ...volumeLines(file.baseline, prev, live, paint));
  out.push(
    "",
    paint(DIM, "API-equivalent estimate, not a bill. cc-spend record --all: every record."),
  );
  return out.join("\n");
}

const SPARK = "▁▂▃▄▅▆▇█";

/** One glyph per value, scaled from the smallest to the largest; `·` for an unknown one. */
export function sparkline(values: ReadonlyArray<number | null>): string {
  const known = values.filter((value) => value !== null);
  const low = Math.min(...known);
  const high = Math.max(...known);
  return values
    .map((value) => {
      if (value === null) return "·";
      const step =
        high === low ? 0 : Math.round(((value - low) / (high - low)) * (SPARK.length - 1));
      return SPARK[step] as string;
    })
    .join("");
}

/** `cc-spend record --all`: the baseline, every closed record and the live one, one row each. */
export function formatAll(view: RecordView, color: boolean): string {
  const paint = painter(color);
  const { file, live, today } = view;
  type Row = {
    readonly label: string;
    readonly snapshot: Snapshot;
    readonly entry: RecordEntry | null;
    readonly live: boolean;
  };
  const rows: Array<Row> = [
    ...(file.baseline ? [{ label: "b", snapshot: file.baseline, entry: null, live: false }] : []),
    ...file.closed.flatMap((entry) =>
      entry.snapshot
        ? [{ label: String(entry.n), snapshot: entry.snapshot, entry, live: false }]
        : [],
    ),
    ...(file.current && live
      ? [{ label: String(file.current.n), snapshot: live, entry: file.current, live: true }]
      : []),
  ];
  if (rows.length === 0)
    return "No record yet. The first one starts with the next background refresh (open Claude Code).";
  const shown = METRICS.filter((metric) => metric.id !== "reread");
  const head = [
    pad(" #", 4),
    pad("period", 18),
    ...shown.map((metric) =>
      pad(
        {
          perMTok: "$/MTok",
          avoidable: "avoid",
          cacheReads: "cache",
          resend: "resend",
          reread: "reread",
        }[metric.id],
        8,
        true,
      ),
    ),
    pad("$ total", 10, true),
    pad("focus", 7, true),
    "  result",
  ].join("");
  const lines = rows.map((row) => {
    const period = `${shortDay(row.snapshot.from)} → ${row.live ? "now" : shortDay(row.snapshot.to)}`;
    const early = row.live && row.snapshot.days < SETTLE_DAYS;
    const change = row.entry && !early ? focusChange(row.entry, row.snapshot) : null;
    const result =
      row.entry?.focus == null || change === null
        ? ""
        : `${mark(change, paint)}${row.live ? paint(DIM, " so far") : ""}`;
    return [
      pad(` ${row.label}`, 4),
      pad(period, 18),
      ...shown.map((metric) => {
        const value = metricValue(row.snapshot, metric.id);
        return pad(aimPaint(metric, value, valueText(metric, value), paint), 8, true);
      }),
      pad(`${money(row.snapshot.usd)}${row.live ? "…" : ""}`, 10, true),
      pad(row.entry?.focus ?? "—", 7, true),
      `  ${result}`,
    ].join("");
  });
  const trend = [
    pad("", 4),
    pad("trend", 18),
    ...shown.map((metric) =>
      pad(sparkline(rows.map((row) => metricValue(row.snapshot, metric.id))), 8, true),
    ),
  ].join("");
  const days = file.current ? daysSoFar(file.current, today) : 0;
  return [
    paint(BOLD, "RECORDS") + paint(DIM, "  baseline = 7 days before record #1"),
    "",
    paint(BOLD, head),
    ...lines,
    paint(DIM, trend),
    "",
    paint(DIM, `Next record: ${String(file.days)} days. The live one is on day ${String(days)}.`),
  ].join("\n");
}

/** `--json`: every snapshot with its habit values. */
export function recordJson(view: RecordView): unknown {
  const withValues = (snapshot: Snapshot | null | undefined): unknown =>
    snapshot
      ? {
          ...snapshot,
          values: Object.fromEntries(
            METRICS.map((metric) => [metric.id, metricValue(snapshot, metric.id)]),
          ),
        }
      : null;
  return {
    days: view.file.days,
    baseline: withValues(view.file.baseline),
    closed: view.file.closed.map((entry) => ({ ...entry, snapshot: withValues(entry.snapshot) })),
    current: view.file.current ? { ...view.file.current, snapshot: withValues(view.live) } : null,
  };
}
