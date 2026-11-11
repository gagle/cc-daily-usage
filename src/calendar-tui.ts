import type { Account } from "./account.js";
import { accountKey, readOverageCreditGrantCache } from "./account.js";
import {
  applyLedgerReading,
  colorForPct,
  computeToday,
  getLaboralDays,
  isLaboralDay,
  rolloverIfNeeded,
} from "./calc.js";
import { daysInMonth, localDateKey, localYearMonth, utcPeriod } from "./clock.js";
import { loadApiCache, loadConfig, loadUsage, saveConfig, saveUsage } from "./config.js";
import type { ComputedUsage } from "./interfaces/calc.interface.js";
import type { ApiCache, Config, UsageState } from "./interfaces/config.interface.js";
import { requestApiRefresh } from "./refresh.js";
import { type DayBreakdown, dayBreakdown } from "./report.js";

// A dependency-free terminal UI: pure model → string rendering, a pure key reducer, and a thin raw-mode
// loop. No React/Ink: the first frame paints at Node's own startup speed.

export { daysInMonth };

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const POLL_MS = 2000;
const CELL_WIDTH = 9; // two-line cell: day on top, $amount below

function monthName(month: number): string {
  // month is always 1-12 (cursor/clock derived); noUncheckedIndexedAccess still wants the fallback.
  /* v8 ignore next */
  return MONTH_NAMES[month - 1] ?? "?";
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function pctLabel(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/** 0 = Monday .. 6 = Sunday — the calendar grid's column order. */
export function mondayFirstWeekday(year: number, month: number, day: number): number {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return (jsDay + 6) % 7;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface MonthKey {
  readonly year: number;
  readonly month: number;
}

export interface Cursor {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Sorted unique years that have laboral config, recorded spend, or are the current local year. */
export function yearsAvailable(
  config: Config,
  usage: UsageState,
  now: Date,
): ReadonlyArray<number> {
  const years = new Set<number>();
  for (const year of Object.keys(config.laboralDays)) years.add(Number(year));
  for (const iso of Object.keys(usage.days)) years.add(Number(iso.slice(0, 4)));
  years.add(now.getFullYear());
  return Array.from(years)
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => a - b);
}

/** Move the cursor by whole calendar days, crossing month/year boundaries (pure date math). */
export function moveCursor(cursor: Cursor, deltaDays: number): Cursor {
  const date = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function clampDay(day: number, year: number, month: number): number {
  return Math.max(1, Math.min(daysInMonth(year, month), day));
}

export interface CalendarSnapshot {
  readonly config: Config;
  readonly usage: UsageState;
  readonly computed: ComputedUsage;
  readonly account: Account | null;
  readonly capFromAnthropic: boolean;
  readonly now: Date;
}

/**
 * Read → rollover + ledger (in memory, the same steps a statusline render takes minus session capture) →
 * compute. The ledger's monthly_limit replaces the local cap here too, so an admin change shows up even
 * when no Claude Code session is running (the poll keeps api-cache.json fresh).
 */
export function computeSnapshot(account: Account | null, now: Date = new Date()): CalendarSnapshot {
  const key = accountKey(account);
  let config = loadConfig(key);
  const usage = loadUsage(key, now);
  const api: ApiCache | null = loadApiCache(key);
  const extra = api?.extraUsage ?? null;
  rolloverIfNeeded(usage, now, extra?.usedCredits ?? null);
  let capFromAnthropic = false;
  if (config.hasSpendCap === true && extra !== null) {
    applyLedgerReading(usage, extra.usedCredits, now);
    if (extra.monthlyLimit > 0) {
      capFromAnthropic = true;
      config = { ...config, monthlyCap: extra.monthlyLimit };
    }
  }
  return {
    config,
    usage,
    computed: computeToday(usage, config, now),
    account,
    capFromAnthropic,
    now,
  };
}

/** Manual day-edit session: redistribute recorded $ across the PAST days of one month. Today and future
 * days are live (the ledger/capture owns them), so they are never in the draft. */
export interface DayEditSession {
  readonly month: MonthKey;
  readonly draft: Readonly<Record<string, number>>;
  readonly buffer: string;
  readonly warning: string | null;
}

export interface CalendarModel {
  readonly snapshot: CalendarSnapshot;
  readonly cursor: Cursor;
  readonly capEdit: string | null;
  readonly dayEdit: DayEditSession | null;
  readonly notice: string | null; // one-shot message under the grid, cleared by the next key
  readonly detail: DayBreakdown | null; // `d`: where the cursor day's $ went (from the transcript index)
}

export function initialModel(snapshot: CalendarSnapshot): CalendarModel {
  const { now } = snapshot;
  return {
    snapshot,
    cursor: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
    capEdit: null,
    dayEdit: null,
    notice: null,
    detail: null,
  };
}

function monthPrefixOf(m: MonthKey): string {
  return `${String(m.year)}-${String(m.month).padStart(2, "0")}`;
}

function sumValues(values: Readonly<Record<string, number>>): number {
  return Object.values(values).reduce((total, amount) => total + amount, 0);
}

function todayKey(model: CalendarModel): string {
  return localDateKey(model.snapshot.now);
}

function isPastDay(model: CalendarModel, year: number, month: number, day: number): boolean {
  return isoDate(year, month, day) < todayKey(model);
}

/** The recorded past days of `month` (what a day edit may redistribute). */
function pastDaysOf(model: CalendarModel, month: MonthKey): Record<string, number> {
  const prefix = monthPrefixOf(month);
  const today = todayKey(model);
  const days: Record<string, number> = {};
  for (const [iso, amount] of Object.entries(model.snapshot.usage.days)) {
    if (iso.startsWith(prefix) && iso < today) days[iso] = amount;
  }
  return days;
}

/** The fixed total a month's edited past days must sum to: what they sum to now. Redistributing never
 * changes the month total, so periodFrozen and the ledger stay consistent. */
export function poolForMonth(model: CalendarModel, month: MonthKey): number {
  return sumValues(pastDaysOf(model, month));
}

function draftWithBufferCommitted(model: CalendarModel, session: DayEditSession) {
  if (session.buffer === "") return session.draft;
  const parsed = Number(session.buffer);
  if (!Number.isFinite(parsed) || parsed < 0) return session.draft;
  // A buffer only ever exists on a past day: typing on a live day is refused, arrows commit first.
  const { year, month, day } = model.cursor;
  return { ...session.draft, [isoDate(year, month, day)]: parsed };
}

export type Key =
  | { readonly kind: "up" | "down" | "left" | "right" }
  | { readonly kind: "shift-left" | "shift-right" }
  | { readonly kind: "tab" | "shift-tab" | "enter" | "escape" | "backspace" | "ctrl-c" }
  | { readonly kind: "char"; readonly char: string };

/** Splits one stdin chunk (raw mode) into key events. Unknown escape sequences are dropped. */
export function parseKeys(data: string): ReadonlyArray<Key> {
  const keys: Array<Key> = [];
  const sequences: ReadonlyArray<readonly [string, Key]> = [
    ["\x1b[1;2C", { kind: "shift-right" }],
    ["\x1b[1;2D", { kind: "shift-left" }],
    ["\x1b[A", { kind: "up" }],
    ["\x1b[B", { kind: "down" }],
    ["\x1b[C", { kind: "right" }],
    ["\x1b[D", { kind: "left" }],
    ["\x1bOA", { kind: "up" }],
    ["\x1bOB", { kind: "down" }],
    ["\x1bOC", { kind: "right" }],
    ["\x1bOD", { kind: "left" }],
    ["\x1b[Z", { kind: "shift-tab" }],
  ];
  let i = 0;
  outer: while (i < data.length) {
    for (const [sequence, key] of sequences) {
      if (data.startsWith(sequence, i)) {
        keys.push(key);
        i += sequence.length;
        continue outer;
      }
    }
    const char = data.charAt(i);
    if (char === "\x1b") {
      // A lone ESC is Escape; ESC + '[' + params + final byte is an unknown sequence — skip it whole. So is
      // a mouse event: SGR `ESC [ < b;x;y M|m`, or legacy `ESC [ M` + 3 bytes (settings turns reporting on).
      // eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
      const unknown = /^\x1b\[(?:<[0-9;]*[Mm]|M[\s\S]{3}|[0-9;]*[A-Za-z~])/.exec(data.slice(i));
      if (unknown) {
        i += unknown[0].length;
        continue;
      }
      keys.push({ kind: "escape" });
    } else if (char === "\t") keys.push({ kind: "tab" });
    else if (char === "\r" || char === "\n") keys.push({ kind: "enter" });
    else if (char === "\x7f" || char === "\b") keys.push({ kind: "backspace" });
    else if (char === "\x03") keys.push({ kind: "ctrl-c" });
    else if (char >= " ") keys.push({ kind: "char", char });
    i += 1;
  }
  return keys;
}

/** Side effects the reducer may request; the IO loop (or a test) supplies them. */
export interface CalendarEffects {
  saveConfig(config: Config): void;
  saveUsage(usage: UsageState): void;
  snapshot(): CalendarSnapshot;
  dayBreakdown(day: string): DayBreakdown;
}

function arrowDelta(kind: Key["kind"]): number | null {
  if (kind === "left") return -1;
  if (kind === "right") return 1;
  if (kind === "up") return -7;
  if (kind === "down") return 7;
  return null;
}

function reduceDayEdit(
  model: CalendarModel,
  session: DayEditSession,
  key: Key,
  effects: CalendarEffects,
): CalendarModel {
  if (key.kind === "escape") return { ...model, dayEdit: null };
  if (key.kind === "char" && key.char === "S") {
    const draft = draftWithBufferCommitted(model, session);
    const pool = poolForMonth(model, session.month);
    const total = sumValues(draft);
    if (Math.abs(total - pool) > 0.005) {
      return {
        ...model,
        dayEdit: {
          ...session,
          buffer: "",
          warning: `Adds up to ${money(total)}, needs to equal ${money(pool)} — not saved`,
        },
      };
    }
    const prefix = monthPrefixOf(session.month);
    const today = todayKey(model);
    const kept = Object.fromEntries(
      Object.entries(model.snapshot.usage.days).filter(
        ([iso]) => !iso.startsWith(prefix) || iso >= today,
      ),
    );
    effects.saveUsage({ ...model.snapshot.usage, days: { ...kept, ...draft } });
    return { ...model, dayEdit: null, snapshot: effects.snapshot(), notice: "Saved." };
  }
  if (key.kind === "enter") {
    return {
      ...model,
      dayEdit: {
        ...session,
        draft: draftWithBufferCommitted(model, session),
        buffer: "",
        warning: null,
      },
    };
  }
  if (key.kind === "backspace") {
    return { ...model, dayEdit: { ...session, buffer: session.buffer.slice(0, -1) } };
  }
  if (key.kind === "char" && /^[0-9.]$/.test(key.char)) {
    const { year, month, day } = model.cursor;
    if (!isPastDay(model, year, month, day)) {
      return {
        ...model,
        dayEdit: {
          ...session,
          warning: "Today and future days are live — only past days are editable",
        },
      };
    }
    return { ...model, dayEdit: { ...session, buffer: session.buffer + key.char, warning: null } };
  }
  const delta = arrowDelta(key.kind);
  if (delta !== null) {
    const committed = { ...session, draft: draftWithBufferCommitted(model, session), buffer: "" };
    const next = moveCursor(model.cursor, delta);
    // Stay inside the month being edited — cross-month browsing is for non-edit mode.
    const cursor =
      next.year === session.month.year && next.month === session.month.month ? next : model.cursor;
    return { ...model, cursor, dayEdit: committed };
  }
  return model;
}

function reduceCapEdit(
  model: CalendarModel,
  capEdit: string,
  key: Key,
  effects: CalendarEffects,
): CalendarModel {
  if (key.kind === "escape") return { ...model, capEdit: null };
  if (key.kind === "enter") {
    const parsed = Number(capEdit);
    if (capEdit === "" || !Number.isFinite(parsed) || parsed < 0) {
      return { ...model, capEdit: null, notice: "Cap not changed — enter a number ≥ 0." };
    }
    effects.saveConfig({ ...model.snapshot.config, monthlyCap: parsed });
    return { ...model, capEdit: null, snapshot: effects.snapshot(), notice: "Cap saved." };
  }
  if (key.kind === "backspace") return { ...model, capEdit: capEdit.slice(0, -1) };
  if (key.kind === "char" && /^[0-9.]$/.test(key.char))
    return { ...model, capEdit: capEdit + key.char };
  return model;
}

function toggleLaboral(model: CalendarModel, effects: CalendarEffects): CalendarModel {
  const { year, month, day } = model.cursor;
  if (isPastDay(model, year, month, day)) {
    return {
      ...model,
      notice: `Day ${String(day)} is in the past — its laboral mark is locked (use u to correct $).`,
    };
  }
  const { config } = model.snapshot;
  const yearKey = String(year);
  const monthKey = String(month);
  const existing = config.laboralDays[yearKey]?.[monthKey] ?? [];
  const next = existing.includes(day)
    ? existing.filter((d) => d !== day)
    : [...existing, day].sort((a, b) => a - b);
  // Save the file's own config: the snapshot's cap may be Anthropic's in-memory value.
  const onDisk = loadConfig(accountKey(model.snapshot.account));
  effects.saveConfig({
    ...onDisk,
    laboralDays: {
      ...onDisk.laboralDays,
      [yearKey]: { ...onDisk.laboralDays[yearKey], [monthKey]: next },
    },
  });
  return { ...model, snapshot: effects.snapshot() };
}

/** The whole key handler. Returns null to exit. Pure apart from the effects it calls. */
export function reduceKey(
  model: CalendarModel,
  key: Key,
  effects: CalendarEffects,
): CalendarModel | null {
  if (key.kind === "ctrl-c") return null;
  const base = { ...model, notice: null };
  if (model.dayEdit !== null) return reduceDayEdit(base, model.dayEdit, key, effects);
  if (model.capEdit !== null) return reduceCapEdit(base, model.capEdit, key, effects);

  if (key.kind === "char" && key.char === "d") {
    const { year, month, day } = model.cursor;
    return {
      ...base,
      detail: model.detail === null ? effects.dayBreakdown(isoDate(year, month, day)) : null,
    };
  }
  if (key.kind === "escape" && model.detail !== null) return { ...base, detail: null };
  if (key.kind === "escape" || (key.kind === "char" && key.char === "q")) return null;
  if (key.kind === "char" && key.char === "c") {
    if (model.snapshot.capFromAnthropic) {
      return {
        ...base,
        notice: "The cap comes from your org's Anthropic spend limit — an admin changes it there.",
      };
    }
    return { ...base, capEdit: String(model.snapshot.config.monthlyCap) };
  }
  if (key.kind === "char" && key.char === "u") {
    const month: MonthKey = { year: model.cursor.year, month: model.cursor.month };
    const firstOfMonth = isoDate(month.year, month.month, 1);
    if (firstOfMonth >= todayKey(model)) {
      return { ...base, notice: "Nothing to edit — this month has no past days yet." };
    }
    return {
      ...base,
      dayEdit: { month, draft: pastDaysOf(model, month), buffer: "", warning: null },
    };
  }
  if (key.kind === "tab" || key.kind === "shift-tab") {
    const direction = key.kind === "tab" ? 1 : -1;
    const { year, day } = model.cursor;
    let month = model.cursor.month + direction;
    if (month < 1) month = 12;
    if (month > 12) month = 1;
    return { ...base, cursor: { year, month, day: clampDay(day, year, month) } };
  }
  const yearStep =
    key.kind === "shift-left" || (key.kind === "char" && key.char === "[")
      ? -1
      : key.kind === "shift-right" || (key.kind === "char" && key.char === "]")
        ? 1
        : 0;
  if (yearStep !== 0) {
    const years = yearsAvailable(model.snapshot.config, model.snapshot.usage, model.snapshot.now);
    const { year, month, day } = model.cursor;
    const index = years.indexOf(year);
    const nextYear =
      index === -1 || years.length === 1
        ? year + yearStep
        : // index is in range, so the lookup always hits.
          (years[(index + yearStep + years.length) % years.length] as number);
    return { ...base, cursor: { year: nextYear, month, day: clampDay(day, nextYear, month) } };
  }
  if (key.kind === "enter" || (key.kind === "char" && key.char === " ")) {
    return toggleLaboral(base, effects);
  }
  const delta = arrowDelta(key.kind);
  if (delta !== null) {
    const cursor = moveCursor(model.cursor, delta);
    // An open day detail follows the cursor.
    const detail =
      model.detail === null
        ? null
        : effects.dayBreakdown(isoDate(cursor.year, cursor.month, cursor.day));
    return { ...base, cursor, detail };
  }
  return base;
}

// ── Rendering ──────────────────────────────────────────────────────────────────────────────────────────

export interface RenderStyle {
  readonly color: boolean;
}

function sgr(style: RenderStyle, codes: string, text: string): string {
  return style.color && codes !== "" ? `\x1b[${codes}m${text}\x1b[0m` : text;
}

function hexToSgr(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `38;2;${String((value >> 16) & 255)};${String((value >> 8) & 255)};${String(value & 255)}`;
}

function renderStats(model: CalendarModel, style: RenderStyle): Array<string> {
  const { config, computed, capFromAnthropic, now, usage } = model.snapshot;
  const { year, month } = model.cursor;
  const lines = [
    sgr(style, "1", `Year ${String(year)}  ([/] or S-←/→ year)   ${monthName(month)}  (Tab month)`),
  ];
  const laboralToday = isLaboralDay(config, now);
  if (laboralToday && computed.avgPerDay !== null && computed.todayUsedPct !== null) {
    lines.push(
      sgr(
        style,
        hexToSgr(colorForPct(computed.todayUsedPct)),
        `Today:      ${money(computed.todayUsage)} / ${money(computed.avgPerDay)}  (${pctLabel(computed.todayUsedPct)})  ·  ${String(computed.paceLabel)}`,
      ),
    );
  } else if (laboralToday && computed.avgPerDay === 0) {
    lines.push(
      sgr(style, hexToSgr("#F8696B"), `Today:      ${money(computed.todayUsage)} / $0.00  (over)`),
    );
  } else {
    lines.push(
      sgr(
        style,
        "2",
        `Today:      ${money(computed.todayUsage)}${laboralToday ? "" : "  (off day)"}`,
      ),
    );
  }
  lines.push(
    sgr(
      style,
      hexToSgr(colorForPct(computed.monthUsedPct)),
      `This month: ${money(computed.monthlySpent)} / ${money(computed.monthlyCap)}  (${pctLabel(computed.monthUsedPct)})  ${capFromAnthropic ? "cap: Anthropic" : "cap: local"}`,
    ),
  );
  const period = utcPeriod(now);
  const laboralCount = getLaboralDays(config, period.year, period.month).length;
  if (computed.monthDay0AvgPerDay !== null) {
    lines.push(
      sgr(
        style,
        "2",
        `Day-1 max:  ${money(computed.monthDay0AvgPerDay)}  (${String(computed.monthlyCap)} / ${String(laboralCount)})`,
      ),
    );
  }
  if (computed.realAvgPerDay !== null) {
    lines.push(
      sgr(style, "2", `Real avg:   ${money(computed.realAvgPerDay)}  / laboral day so far`),
    );
  }
  if (laboralCount > 0 && computed.avgPerDay === null) {
    lines.push(
      sgr(style, "2", "No laboral days left this month — remaining budget has nowhere to go."),
    );
  }
  const today = localDateKey(now);
  const missToday = Object.values(usage.sessions)
    .filter((session) => localDateKey(new Date(session.lastSeenAt)) === today)
    .reduce((total, session) => total + (session.cacheMissUsd ?? 0), 0);
  if (missToday >= 0.01) {
    lines.push(sgr(style, "2", `Cache re-paid today: ~${money(missToday)}  (prompt-cache misses)`));
  }
  return lines;
}

function renderBanners(model: CalendarModel, style: RenderStyle): Array<string> {
  const lines: Array<string> = [];
  const { config, account, now } = model.snapshot;
  const { year, month } = localYearMonth(now);
  if ((config.laboralDays[String(year)]?.[String(month)] ?? []).length === 0) {
    lines.push(
      sgr(
        style,
        "30;43",
        ` ⚠ No laboral days configured for ${monthName(month)} ${String(year)} — use the arrows + Space below to add some. `,
      ),
    );
  }
  const grant = readOverageCreditGrantCache(account?.accountUuid ?? null);
  if (grant && grant.eligible && !grant.granted && grant.amount_minor_units !== null) {
    lines.push(
      sgr(
        style,
        "30;42",
        ` 🎁 ${money(grant.amount_minor_units / 100)} credit grant available — claim it in Claude Code `,
      ),
    );
  }
  if (model.capEdit !== null) {
    lines.push(sgr(style, "36", `Monthly cap: $${model.capEdit}_ (Enter to save, Esc to cancel)`));
  }
  const session = model.dayEdit;
  if (session !== null) {
    const pool = poolForMonth(model, session.month);
    const draft = draftWithBufferCommitted(model, session);
    lines.push(
      sgr(
        style,
        "36",
        `Redistributing ${monthName(session.month.month)} ${String(session.month.year)} past days: allocated ${money(sumValues(draft))} of ${money(pool)}. Type digits on a past cell · Enter commits cell · S saves · Esc cancels.`,
      ),
    );
    if (session.warning !== null) lines.push(sgr(style, "30;41", ` ${session.warning} `));
  }
  return lines;
}

function renderCell(
  model: CalendarModel,
  usage: UsageState,
  year: number,
  month: number,
  day: number,
  style: RenderStyle,
): [string, string] {
  const { config } = model.snapshot;
  const iso = isoDate(year, month, day);
  const today = todayKey(model);
  const isToday = iso === today;
  const isPast = iso < today;
  const isLaboral = (config.laboralDays[String(year)]?.[String(month)] ?? []).includes(day);
  const isCursor =
    model.cursor.year === year && model.cursor.month === month && model.cursor.day === day;
  const editingHere = model.dayEdit !== null && isCursor;
  const amount = usage.days[iso];

  const dayText = `${String(day).padStart(2, " ")}${isToday ? " today" : ""}`;
  let moneyText: string;
  if (editingHere) moneyText = `$${model.dayEdit.buffer}_`;
  else if (isToday) moneyText = `•${money(model.snapshot.computed.todayUsage)}`;
  else moneyText = amount === undefined ? "—" : money(amount);

  const codes: Array<string> = [];
  if (isToday) codes.push("1", "4", "36");
  else if (isPast) codes.push("2", isLaboral ? "32" : "90");
  else codes.push(isLaboral ? "32" : "90");
  if (isCursor) codes.push("7");
  if (editingHere) codes.push("36");
  const codeText = codes.join(";");
  return [
    sgr(style, codeText, dayText.padEnd(CELL_WIDTH).slice(0, CELL_WIDTH)),
    sgr(style, codeText, moneyText.padEnd(CELL_WIDTH).slice(0, CELL_WIDTH)),
  ];
}

function renderGrid(model: CalendarModel, style: RenderStyle): Array<string> {
  const { year, month } = model.cursor;
  const usage =
    model.dayEdit === null
      ? model.snapshot.usage
      : {
          ...model.snapshot.usage,
          days: { ...model.snapshot.usage.days, ...draftWithBufferCommitted(model, model.dayEdit) },
        };
  const blank = " ".repeat(CELL_WIDTH);
  const cells: Array<[string, string]> = [];
  for (let i = 0; i < mondayFirstWeekday(year, month, 1); i++) cells.push([blank, blank]);
  for (let day = 1; day <= daysInMonth(year, month); day++) {
    cells.push(renderCell(model, usage, year, month, day, style));
  }
  const width = 7 * (CELL_WIDTH + 1) - 1;
  const border = (text: string): string => sgr(style, "36", text);
  const title = `${monthName(month)} ${String(year)}`;
  const header = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    .map((name) => name.padEnd(CELL_WIDTH))
    .join(" ");
  const lines = [
    border(`╭─ `) + sgr(style, "1", title) + border(` ${"─".repeat(width - title.length - 1)}╮`),
    `${border("│")} ${sgr(style, "2", header)}${" ".repeat(width - header.length)} ${border("│")}`,
  ];
  for (let i = 0; i < cells.length; i += 7) {
    const week = cells.slice(i, i + 7);
    while (week.length < 7) week.push([blank, blank]);
    lines.push(`${border("│")} ${week.map((cell) => cell[0]).join(" ")} ${border("│")}`);
    lines.push(`${border("│")} ${week.map((cell) => cell[1]).join(" ")} ${border("│")}`);
  }
  lines.push(border(`╰${"─".repeat(width + 2)}╯`));
  return lines;
}

function renderHint(model: CalendarModel, style: RenderStyle): string {
  const { year, month, day } = model.cursor;
  if (model.notice !== null) return sgr(style, "33", model.notice);
  if (model.dayEdit !== null) {
    return sgr(
      style,
      "33",
      isPastDay(model, year, month, day)
        ? `Editing day ${String(day)} $ · type digits · Enter: commit cell · S: save if sum matches · Esc: cancel`
        : `Day ${String(day)} is live (today or later) — move to a past day to edit`,
    );
  }
  if (isPastDay(model, year, month, day)) {
    return sgr(style, "2", `Day ${String(day)} · past · locked (use u to correct $)`);
  }
  const laboral = (model.snapshot.config.laboralDays[String(year)]?.[String(month)] ?? []).includes(
    day,
  );
  return sgr(
    style,
    "33",
    laboral
      ? `Day ${String(day)} · laboral · Enter/Space: unmark laboral (remaining budget re-splits over fewer days)`
      : `Day ${String(day)} · off · Enter/Space: mark as laboral (counts in daily pace)`,
  );
}

/** One full frame as lines. Pure. */
function renderDetail(detail: DayBreakdown, style: RenderStyle): Array<string> {
  if (detail.usd === 0 && detail.sessions.length === 0) {
    return [
      sgr(
        style,
        "2",
        `${detail.day}: no transcript spend indexed (cc-daily-usage report catches up)`,
      ),
    ];
  }
  const list = (entries: ReadonlyArray<readonly [string, number]>): string =>
    entries.length === 0 ? "—" : entries.map(([name, usd]) => `${name} ${money(usd)}`).join(" · ");
  return [
    sgr(style, "1", `${detail.day} · ${money(detail.usd)} API-equivalent, from transcripts`),
    `  sessions  ${list(detail.sessions)}`,
    `  models    ${list(detail.models.map(([model, usd]) => [model.replace(/^claude-/, ""), usd]))}`,
    `  projects  ${list(detail.projects)}`,
  ];
}

export function renderCalendar(model: CalendarModel, style: RenderStyle): ReadonlyArray<string> {
  return [
    ...renderStats(model, style),
    "",
    ...renderBanners(model, style),
    ...renderGrid(model, style),
    ...(model.detail === null ? [] : renderDetail(model.detail, style)),
    renderHint(model, style),
    sgr(
      style,
      "2",
      "←→↑↓ move  Tab month  [/] year  Space laboral  d day detail  u edit $  c cap  q quit",
    ),
  ];
}

// ── IO loop ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Opens the calendar; resolves once the user exits (q/Esc/Ctrl+C). First frame is drawn before anything
 * else runs. Non-TTY stdin/stdout (pipe, CI) prints one frame and exits. Thin IO shell around the pure
 * functions above, which carry the logic and the tests.
 */
/* v8 ignore start */
export async function runCalendarTui(account: Account | null): Promise<number> {
  const key = accountKey(account);
  const style: RenderStyle = {
    color: process.stdout.isTTY && process.env.NO_COLOR === undefined,
  };
  const effects: CalendarEffects = {
    saveConfig: (config) => {
      saveConfig(key, config);
    },
    saveUsage: (usage) => {
      saveUsage(key, usage);
    },
    snapshot: () => computeSnapshot(account),
    dayBreakdown: (day) => dayBreakdown(key, day),
  };
  let model = initialModel(effects.snapshot());

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${renderCalendar(model, style).join("\n")}\n`);
    return 0;
  }

  const draw = (): void => {
    const frame = renderCalendar(model, style)
      .map((line) => `${line}\x1b[K`)
      .join("\n");
    process.stdout.write(`\x1b[H${frame}\x1b[J`);
  };
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  draw();
  requestApiRefresh(key, new Date());

  return new Promise<number>((resolve) => {
    const finish = (): void => {
      clearInterval(timer);
      process.stdin.off("data", onData);
      process.stdout.off("resize", draw);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      resolve(0);
    };
    const onData = (data: Buffer): void => {
      for (const parsed of parseKeys(data.toString("utf8"))) {
        const next = reduceKey(model, parsed, effects);
        if (next === null) {
          finish();
          return;
        }
        model = next;
      }
      draw();
    };
    const timer = setInterval(() => {
      requestApiRefresh(key, new Date());
      model = { ...model, snapshot: effects.snapshot() };
      draw();
    }, POLL_MS);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdout.on("resize", draw);
  });
}
/* v8 ignore stop */
