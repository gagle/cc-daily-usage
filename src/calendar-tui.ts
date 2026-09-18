import { Box, render, Text, useApp, useInput } from "ink";
import React, { useEffect, useState } from "react";

import type { Account } from "./account.js";
import { accountKey, readOverageCreditGrantCache, resolveActiveAccountSync } from "./account.js";
import { colorForPct, computeToday, isLaboralDay, rolloverIfNeeded } from "./calc.js";
import { loadConfig, loadUsage, saveConfig, saveUsage } from "./config.js";
import type { ComputedUsage } from "./interfaces/calc.interface.js";
import type { Config, UsageState } from "./interfaces/config.interface.js";

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

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function pctLabel(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Monday .. 6 = Sunday — same convention assets/init-calendar.html uses. */
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

/** Every year/month with configured laboral days or recorded spend, plus always the current month — so
 * there's always a grid to toggle days into existence on, even from a totally empty config. Kept for
 * tests / callers; the live calendar focuses one month and uses yearsAvailable for year switching. */
export function monthsToShow(
  config: Config,
  usage: UsageState,
  now: Date,
): ReadonlyArray<MonthKey> {
  const keys = new Set<string>();
  for (const [year, months] of Object.entries(config.laboralDays)) {
    for (const month of Object.keys(months)) keys.add(`${year}-${month}`);
  }
  for (const iso of Object.keys(usage.days)) {
    keys.add(`${iso.slice(0, 4)}-${String(Number(iso.slice(5, 7)))}`);
  }
  keys.add(`${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1)}`);
  return Array.from(keys)
    .map((key): MonthKey => {
      const [year, month] = key.split("-").map(Number);
      // Every key was built above as `${year}-${month}` from numeric sources, so both parts always parse —
      // noUncheckedIndexedAccess just can't see that through the destructure.
      /* v8 ignore next */
      return { year: year ?? 0, month: month ?? 0 };
    })
    .sort((a, b) => a.year - b.year || a.month - b.month);
}

/** Sorted unique years that have laboral config, recorded spend, or are the current UTC year. */
export function yearsAvailable(
  config: Config,
  usage: UsageState,
  now: Date,
): ReadonlyArray<number> {
  const years = new Set<number>();
  for (const year of Object.keys(config.laboralDays)) years.add(Number(year));
  for (const iso of Object.keys(usage.days)) years.add(Number(iso.slice(0, 4)));
  years.add(now.getUTCFullYear());
  return Array.from(years)
    .filter((year) => Number.isFinite(year))
    .sort((a, b) => a - b);
}

/** Move the cursor by whole calendar days (UTC), crossing month/year boundaries. */
export function moveCursor(cursor: Cursor, deltaDays: number): Cursor {
  const date = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export interface CalendarSnapshot {
  readonly config: Config;
  readonly usage: UsageState;
  readonly computed: ComputedUsage;
  readonly account: Account | null;
}

/** Read → rollover (in-memory only, matching the former usage-tui's "never persist on read" decision — the
 * statusline hook is what actually persists usage.json) → compute. Account resolution is sync-only here (no
 * per-session token-override profile fetch — see account.ts) since this feeds Ink's synchronous useState
 * initializer. */
export function computeSnapshot(): CalendarSnapshot {
  const account = resolveActiveAccountSync();
  const key = accountKey(account);
  const config = loadConfig(key);
  const usage = loadUsage(key);
  const now = new Date();
  rolloverIfNeeded(usage, config, now);
  const computed = computeToday(usage, config, now);
  return { config, usage, computed, account };
}

/** "YYYY-MM" prefix for a MonthKey — used to scope a month's own usage.days entries out of the rest. */
function monthPrefixOf(m: MonthKey): string {
  return `${String(m.year)}-${String(m.month).padStart(2, "0")}`;
}

export interface Cursor {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function clampDay(day: number, year: number, month: number): number {
  return Math.max(1, Math.min(daysInMonth(year, month), day));
}

/** Manual calendar day-edit session (plan item: let the user directly type historical per-day $ amounts).
 * `draft` starts as a copy of the edited month's existing usage.days (plus, for the current in-progress
 * month, a synthetic today entry) and only ever grows/overwrites from there — never loses an untouched day. */
interface DayEditSession {
  readonly month: MonthKey;
  readonly draft: Readonly<Record<string, number>>;
  readonly buffer: string;
  readonly warning: string | null;
}

function sumValues(values: Readonly<Record<string, number>>): number {
  return Object.values(values).reduce((total, amount) => total + amount, 0);
}

const POLL_MS = 2000;

function renderStatsHeader(
  config: Config,
  computed: ComputedUsage,
  cursor: Cursor,
  now: Date,
): React.ReactElement {
  const showTodayPace =
    config.hasSpendCap !== false &&
    isLaboralDay(config, now) &&
    computed.avgPerDay !== null &&
    computed.todayUsedPct !== null &&
    computed.paceLabel !== null;
  const showTodayUsageOnly = config.hasSpendCap !== false && !isLaboralDay(config, now);
  // cursor.month is always 1-12.
  /* v8 ignore next */
  const monthName = MONTH_NAMES[cursor.month - 1] ?? "?";
  return React.createElement(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    React.createElement(
      Text,
      { bold: true },
      `Year ${String(cursor.year)}  ([/] or S-←/→ year)   ${monthName}  (←→/Tab month)`,
    ),
    showTodayPace
      ? React.createElement(
          Text,
          { color: colorForPct(computed.todayUsedPct) },
          `Today:      ${money(computed.todayUsage)} / ${money(computed.avgPerDay)}  (${pctLabel(computed.todayUsedPct)})  ·  ${computed.paceLabel}`,
        )
      : showTodayUsageOnly
        ? React.createElement(Text, { dimColor: true }, `Today:      ${money(computed.todayUsage)}`)
        : null,
    config.hasSpendCap === false
      ? React.createElement(
          Text,
          { dimColor: true },
          `No spend cap on this plan (${config.planType ?? "subscription"}) — see the ⏱ 5h/7d segment in Claude Code's own statusline instead.`,
        )
      : React.createElement(
          Text,
          { color: colorForPct(computed.monthUsedPct) },
          `This month: ${money(computed.monthlySpent)} / ${money(computed.monthlyCap)}  (${pctLabel(computed.monthUsedPct)})`,
        ),
    config.hasSpendCap !== false && computed.monthDay0AvgPerDay !== null
      ? React.createElement(
          Text,
          { dimColor: true },
          `Day-0 max:  ${money(computed.monthDay0AvgPerDay)}  (first equal-split this month)`,
        )
      : null,
    config.hasSpendCap !== false && computed.realAvgPerDay !== null
      ? React.createElement(
          Text,
          { dimColor: true },
          `Real avg:   ${money(computed.realAvgPerDay)}  / laboral day so far`,
        )
      : null,
  );
}

function renderWarningBanner(config: Config, now: Date): React.ReactElement | null {
  if (config.hasSpendCap === false) return null;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const configured = config.laboralDays[String(year)]?.[String(month)] ?? [];
  if (configured.length > 0) return null;
  // month is always 1-12 here (derived from getUTCMonth() + 1), so the index is always in range —
  // noUncheckedIndexedAccess still requires the fallback.
  /* v8 ignore next */
  const monthName = MONTH_NAMES[month - 1] ?? "?";
  return React.createElement(
    Text,
    { color: "black", backgroundColor: "yellow" },
    ` ⚠ No laboral days configured for ${monthName} ${String(year)} — use the arrows + Space below to add some. `,
  );
}

function renderDayEditBanner(
  dayEdit: DayEditSession | null,
  cursor: Cursor,
  poolForMonth: (month: MonthKey) => number,
  draftWithBufferCommitted: (session: DayEditSession) => Readonly<Record<string, number>>,
): React.ReactElement | null {
  if (dayEdit === null) return null;
  // dayEdit.month.month always comes from cursor.month (always 1-12) — same always-in-range indexing as
  // renderWarningBanner's monthName.
  /* v8 ignore next */
  const monthName = MONTH_NAMES[dayEdit.month.month - 1] ?? "?";
  const draft = draftWithBufferCommitted(dayEdit);
  const pool = poolForMonth(dayEdit.month);
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(
      Text,
      { color: "cyan" },
      `Redistributing ${monthName} ${String(dayEdit.month.year)} pool ${money(pool)} across days ` +
        `(now on day ${String(cursor.day)}). Allocated ${money(sumValues(draft))} of ${money(pool)}. ` +
        `Type digits on the cell (auto $). Enter commits cell, S saves, Esc cancels.`,
    ),
    React.createElement(
      Text,
      { dimColor: true },
      "Tip: put leftover on today to keep history simple and start clean next laboral day.",
    ),
    dayEdit.warning !== null
      ? React.createElement(
          Text,
          { color: "black", backgroundColor: "red" },
          ` ${dayEdit.warning} `,
        )
      : null,
  );
}

/** One-line hint under the calendar: what Enter/Space or $ edit will do for the focused day. */
function renderContextHint(
  config: Config,
  cursor: Cursor,
  dayEdit: DayEditSession | null,
  poolForMonth: (month: MonthKey) => number,
): React.ReactElement | null {
  if (config.hasSpendCap === false) return null;
  if (dayEdit !== null) {
    const pool = poolForMonth(dayEdit.month);
    return React.createElement(
      Box,
      { flexDirection: "column", marginTop: 1 },
      React.createElement(
        Text,
        { color: "yellow" },
        `Editing day ${String(cursor.day)} $ (month pool ${money(pool)}) · type digits · Enter: commit cell · S: save if sum matches · Esc: cancel`,
      ),
    );
  }
  const laboral = (config.laboralDays[String(cursor.year)]?.[String(cursor.month)] ?? []).includes(
    cursor.day,
  );
  return React.createElement(
    Box,
    { marginTop: 1 },
    React.createElement(
      Text,
      { color: "yellow" },
      laboral
        ? `Day ${String(cursor.day)} · laboral · Enter/Space: unmark laboral (excluded from daily pace)`
        : `Day ${String(cursor.day)} · off · Enter/Space: mark as laboral (counts in daily pace)`,
    ),
  );
}

/** Calendar-only nudge (see plan item 7) — reads Claude Code's own already-fetched overage-credit-
 * grant cache (account.ts's readOverageCreditGrantCache), no new network call. Deliberately not surfaced in
 * assets/statusline.mjs. */
function renderCreditGrantBanner(account: Account | null): React.ReactElement | null {
  const grant = readOverageCreditGrantCache(account?.accountUuid ?? null);
  if (!grant || !grant.eligible || grant.granted || grant.amount_minor_units === null) return null;
  return React.createElement(
    Text,
    { color: "black", backgroundColor: "green" },
    ` 🎁 ${money(grant.amount_minor_units / 100)} credit grant available — claim it in Claude Code `,
  );
}

const CELL_WIDTH = 9; // two-line cell: day on top, $amount below

function blankDayCell(key: string): React.ReactElement {
  return React.createElement(
    Box,
    { key, flexDirection: "column", width: CELL_WIDTH, marginRight: 1 },
    React.createElement(Text, null, "".padEnd(CELL_WIDTH, " ")),
    React.createElement(Text, null, "".padEnd(CELL_WIDTH, " ")),
  );
}

function renderDayCell(
  year: number,
  month: number,
  day: number,
  config: Config,
  usage: UsageState,
  cursor: Cursor,
  today: string,
  dayEdit: DayEditSession | null,
): React.ReactElement {
  const iso = isoDate(year, month, day);
  const isLaboral = (config.laboralDays[String(year)]?.[String(month)] ?? []).includes(day);
  const isCursor = cursor.year === year && cursor.month === month && cursor.day === day;
  const isToday = iso === today;
  const amount = usage.days[iso];
  const editingHere = dayEdit !== null && isCursor;
  let moneyLine: string;
  if (editingHere) {
    // `$` is display chrome — the buffer is digits/`.` only.
    moneyLine = `$${dayEdit.buffer}_`;
  } else if (amount === undefined) {
    moneyLine = "—";
  } else {
    moneyLine = money(amount);
  }
  const dayColor = isToday ? "cyan" : isLaboral ? "green" : "gray";
  // No border on the cursor cell — Ink borders change width/height and shift the grid. Inverse text only.
  return React.createElement(
    Box,
    {
      key: iso,
      flexDirection: "column",
      width: CELL_WIDTH,
      marginRight: 1,
    },
    React.createElement(
      Text,
      {
        bold: isToday || isCursor,
        inverse: isCursor,
        color: dayColor,
        dimColor: !isLaboral && amount === undefined && !editingHere && !isCursor,
      },
      String(day).padStart(2, " ").padEnd(CELL_WIDTH, " ").slice(0, CELL_WIDTH),
    ),
    React.createElement(
      Text,
      {
        inverse: isCursor,
        color: editingHere ? "cyan" : dayColor,
        dimColor: amount === undefined && !editingHere && !isCursor,
      },
      moneyLine.padEnd(CELL_WIDTH, " ").slice(0, CELL_WIDTH),
    ),
  );
}

function renderMonthCard(
  year: number,
  month: number,
  config: Config,
  usage: UsageState,
  cursor: Cursor,
  today: string,
  dayEdit: DayEditSession | null,
): React.ReactElement {
  const total = daysInMonth(year, month);
  const leading = mondayFirstWeekday(year, month, 1);
  // Same always-in-range indexing as renderWarningBanner's monthName.
  /* v8 ignore next */
  const monthName = MONTH_NAMES[month - 1] ?? "?";
  const cells: Array<React.ReactElement> = [];
  for (let i = 0; i < leading; i++) {
    cells.push(blankDayCell(`blank-${String(i)}`));
  }
  for (let day = 1; day <= total; day++) {
    cells.push(renderDayCell(year, month, day, config, usage, cursor, today, dayEdit));
  }
  const rows: Array<React.ReactElement> = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(
      React.createElement(
        Box,
        { key: `row-${String(i)}`, flexDirection: "row" },
        ...cells.slice(i, i + 7),
      ),
    );
  }
  // Shrink-wrap to the 7-column grid — without alignSelf, a bordered Box stretches to the terminal width.
  const gridWidth = 7 * CELL_WIDTH + 7; // cell widths + per-cell marginRight
  return React.createElement(
    Box,
    {
      key: `${String(year)}-${String(month)}`,
      flexDirection: "column",
      borderStyle: "round",
      borderColor: "cyan",
      paddingX: 1,
      marginBottom: 1,
      alignSelf: "flex-start",
      width: gridWidth + 2, // + paddingX left/right; border is drawn around this box
    },
    React.createElement(Text, { bold: true }, `${monthName} ${String(year)}`),
    ...rows,
  );
}

export function CalendarApp(): React.ReactElement {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>(computeSnapshot);
  const [cursor, setCursor] = useState<Cursor>(() => {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  });
  const [capEdit, setCapEdit] = useState<string | null>(null);
  const [dayEdit, setDayEdit] = useState<DayEditSession | null>(null);

  const years = yearsAvailable(snapshot.config, snapshot.usage, new Date());
  const today = new Date().toISOString().slice(0, 10);
  const currentMonthPrefix = today.slice(0, 7);

  // saveConfig writes synchronously (writeFileSync), so calling this right after a save re-reads the file
  // we just wrote — no need to thread the new config through by hand.
  function refresh(): void {
    setSnapshot(computeSnapshot());
  }

  // Live polling — same interval/reasoning the former usage-tui.ts used: reflects the statusline hook's
  // continual usage.json writes without the user having to manually re-open the calendar.
  useEffect(() => {
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  function toggleCursorDay(): void {
    const { year, month, day } = cursor;
    const yearKey = String(year);
    const monthKey = String(month);
    const existing = snapshot.config.laboralDays[yearKey]?.[monthKey] ?? [];
    const next = existing.includes(day)
      ? existing.filter((d) => d !== day)
      : [...existing, day].sort((a, b) => a - b);
    const config: Config = {
      ...snapshot.config,
      laboralDays: {
        ...snapshot.config.laboralDays,
        [yearKey]: { ...snapshot.config.laboralDays[yearKey], [monthKey]: next },
      },
    };
    saveConfig(accountKey(snapshot.account), config);
    refresh();
  }

  /** Cycle month 1–12 within the current year (wraps Jan↔Dec). */
  function switchMonth(direction: 1 | -1): void {
    setCursor((c) => {
      let month = c.month + direction;
      if (month < 1) month = 12;
      if (month > 12) month = 1;
      return { year: c.year, month, day: clampDay(c.day, c.year, month) };
    });
  }

  /** Jump to the previous/next year that has data (or adjacent calendar year if only one exists). */
  function switchYear(direction: 1 | -1): void {
    setCursor((c) => {
      const index = years.indexOf(c.year);
      let nextYear: number;
      if (index === -1) {
        nextYear = c.year + direction;
      } else {
        const nextIndex = (index + direction + years.length) % years.length;
        // years is non-empty here (index was found) and nextIndex is always in range.
        /* v8 ignore next */
        nextYear = years[nextIndex] ?? c.year + direction;
      }
      return { year: nextYear, month: c.month, day: clampDay(c.day, nextYear, c.month) };
    });
  }

  /** The fixed total a month's manually-entered days must sum to exactly. The current in-progress month's
   * pool is the live monthlySpent (still accruing from real usage); a closed month has no live scalar left
   * (monthlySpent resets every calendar-month boundary — see rolloverIfNeeded) so its pool is just whatever
   * its own recorded days already sum to. */
  function poolForMonth(month: MonthKey): number {
    if (monthPrefixOf(month) === currentMonthPrefix) return snapshot.usage.monthlySpent;
    const prefix = monthPrefixOf(month);
    return sumValues(
      Object.fromEntries(
        Object.entries(snapshot.usage.days).filter(([iso]) => iso.startsWith(prefix)),
      ),
    );
  }

  function enterDayEdit(): void {
    const month: MonthKey = { year: cursor.year, month: cursor.month };
    const prefix = monthPrefixOf(month);
    const draft: Record<string, number> = {};
    for (const [iso, amount] of Object.entries(snapshot.usage.days)) {
      if (iso.startsWith(prefix)) draft[iso] = amount;
    }
    // The live in-progress month's "today" isn't frozen into usage.days yet — seed it from the live figure
    // so the draft already sums to the pool exactly, a valid starting point to redistribute from.
    if (prefix === currentMonthPrefix && draft[today] === undefined) {
      draft[today] = snapshot.computed.todayUsage;
    }
    setDayEdit({ month, draft, buffer: "", warning: null });
  }

  /** Folds any in-progress typed buffer into a draft, at the currently-cursored day — used both by Enter
   * and by arrow-key navigation (which auto-commits before moving, spreadsheet-style). A non-numeric or
   * empty buffer is silently dropped rather than corrupting the draft. */
  function draftWithBufferCommitted(session: DayEditSession): Readonly<Record<string, number>> {
    if (session.buffer === "") return session.draft;
    const parsed = Number(session.buffer);
    if (!Number.isFinite(parsed) || parsed < 0) return session.draft;
    const iso = isoDate(cursor.year, cursor.month, cursor.day);
    return { ...session.draft, [iso]: parsed };
  }

  function saveDayEdit(session: DayEditSession): void {
    const draft = draftWithBufferCommitted(session);
    const pool = poolForMonth(session.month);
    const total = sumValues(draft);
    if (Math.abs(total - pool) > 0.005) {
      setDayEdit({
        ...session,
        buffer: "",
        warning: `Adds up to ${money(total)}, needs to equal ${money(pool)} — not saved`,
      });
      return;
    }
    const prefix = monthPrefixOf(session.month);
    const otherMonths = Object.fromEntries(
      Object.entries(snapshot.usage.days).filter(([iso]) => !iso.startsWith(prefix)),
    );
    const usage = { ...snapshot.usage, days: { ...otherMonths, ...draft } };
    saveUsage(accountKey(snapshot.account), usage);
    setDayEdit(null);
    refresh();
  }

  /** Applies `fn` to the live dayEdit session. The null branch can't actually occur — every call site is
   * inside the `dayEdit !== null` guard below — but setDayEdit's updater always receives the true latest
   * state (see the functional-update comment above), which is typed as possibly-null. */
  function updateDayEdit(fn: (session: DayEditSession) => DayEditSession): void {
    setDayEdit((prev) => {
      /* v8 ignore next */
      if (prev === null) return null;
      return fn(prev);
    });
  }

  useInput((input, key) => {
    if (dayEdit !== null) {
      if (key.escape) {
        setDayEdit(null);
        return;
      }
      if (input === "S") {
        saveDayEdit(dayEdit);
        return;
      }
      // Functional updates throughout below — a burst of keystrokes (fast typing, held arrow keys) can
      // fire several of these before Ink re-renders once; reading the outer `dayEdit` closure directly
      // would let a later event silently clobber an earlier one instead of stacking on top of it.
      if (key.return) {
        updateDayEdit((prev) => ({
          ...prev,
          draft: draftWithBufferCommitted(prev),
          buffer: "",
          warning: null,
        }));
        return;
      }
      if (key.backspace || key.delete) {
        updateDayEdit((prev) => ({ ...prev, buffer: prev.buffer.slice(0, -1) }));
        return;
      }
      if (/^[0-9.]$/.test(input)) {
        updateDayEdit((prev) => ({ ...prev, buffer: prev.buffer + input, warning: null }));
        return;
      }
      if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
        const delta = key.leftArrow ? -1 : key.rightArrow ? 1 : key.upArrow ? -7 : 7;
        updateDayEdit((prev) => ({
          ...prev,
          draft: draftWithBufferCommitted(prev),
          buffer: "",
          // Stay in the month being edited — cross-month browse is for non-edit mode.
          month: prev.month,
        }));
        setCursor((c) => {
          const next = moveCursor(c, delta);
          if (next.year !== dayEdit.month.year || next.month !== dayEdit.month.month) {
            return { ...c, day: clampDay(c.day + delta, c.year, c.month) };
          }
          return next;
        });
      }
      return;
    }

    if (capEdit !== null) {
      if (key.escape) setCapEdit(null);
      else if (key.return) {
        const parsed = Number(capEdit);
        if (Number.isFinite(parsed) && parsed >= 0) {
          const config: Config = { ...snapshot.config, monthlyCap: parsed };
          saveConfig(accountKey(snapshot.account), config);
          refresh();
        }
        setCapEdit(null);
      } else if (key.backspace || key.delete) setCapEdit(capEdit.slice(0, -1));
      else if (/^[0-9.]$/.test(input)) setCapEdit(capEdit + input);
      return;
    }

    if (input === "q" || key.escape || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (input === "c" && snapshot.config.hasSpendCap !== false) {
      setCapEdit(String(snapshot.config.monthlyCap));
      return;
    }
    if (input === "u" && snapshot.config.hasSpendCap !== false) {
      enterDayEdit();
      return;
    }
    if (key.tab && key.shift) {
      switchMonth(-1);
      return;
    }
    if (key.tab) {
      switchMonth(1);
      return;
    }
    if (input === "[" || (key.leftArrow && key.shift)) {
      switchYear(-1);
      return;
    }
    if (input === "]" || (key.rightArrow && key.shift)) {
      switchYear(1);
      return;
    }
    if ((input === " " || key.return) && snapshot.config.hasSpendCap !== false) {
      toggleCursorDay();
      return;
    }
    if (key.leftArrow) setCursor((c) => moveCursor(c, -1));
    if (key.rightArrow) setCursor((c) => moveCursor(c, 1));
    if (key.upArrow) setCursor((c) => moveCursor(c, -7));
    if (key.downArrow) setCursor((c) => moveCursor(c, 7));
  });

  // While editing, the focused month's cells reflect the in-progress draft (plus any not-yet-committed
  // typed buffer) rather than the saved usage.days — pure display overlay, nothing is written until `S`.
  const usageForCalendar: UsageState =
    dayEdit === null
      ? snapshot.usage
      : {
          ...snapshot.usage,
          days: { ...snapshot.usage.days, ...draftWithBufferCommitted(dayEdit) },
        };

  return React.createElement(
    Box,
    // No fixed width here — letting Ink size against the real terminal (stdout.columns) is what makes
    // the month-card grid below actually flex-wrap responsively; 80 is only the *minimum* a terminal needs
    // for a single card to fit, not a cap on how many fit side by side on a wider one.
    { flexDirection: "column" },
    renderStatsHeader(snapshot.config, snapshot.computed, cursor, new Date()),
    renderWarningBanner(snapshot.config, new Date()),
    renderCreditGrantBanner(snapshot.account),
    capEdit !== null
      ? React.createElement(
          Text,
          { color: "cyan" },
          `Monthly cap: $${capEdit}_ (Enter to save, Esc to cancel)`,
        )
      : null,
    renderDayEditBanner(dayEdit, cursor, poolForMonth, draftWithBufferCommitted),
    snapshot.config.hasSpendCap === false
      ? null
      : renderMonthCard(
          cursor.year,
          cursor.month,
          snapshot.config,
          usageForCalendar,
          cursor,
          today,
          dayEdit,
        ),
    renderContextHint(snapshot.config, cursor, dayEdit, poolForMonth),
    React.createElement(
      Text,
      { dimColor: true },
      snapshot.config.hasSpendCap === false
        ? "q quit"
        : "←→↑↓ move  Tab month  [/] year  u edit $  c cap  q quit",
    ),
  );
}

/**
 * Opens the calendar; resolves once the user exits (q/Esc/Ctrl+C). Thin IO wrapper around ink's real render
 * against process.stdout/stdin — CalendarApp carries the actual logic and is covered directly via
 * ink-testing-library; this shim isn't meaningfully testable without a real terminal (same reasoning the
 * former usage-tui.ts's runUsageTui shim used).
 */
/* v8 ignore start */
export async function runCalendarTui(): Promise<number> {
  const { waitUntilExit } = render(React.createElement(CalendarApp));
  await waitUntilExit();
  return 0;
}
/* v8 ignore stop */
