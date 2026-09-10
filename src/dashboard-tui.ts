import { Box, render, Text, useApp, useInput } from "ink";
import React, { useEffect, useState } from "react";

import type { Account } from "./account.js";
import { accountKey, readOverageCreditGrantCache, resolveActiveAccountSync } from "./account.js";
import { colorForPct, computeToday, reconcileLaboralDays, rolloverIfNeeded } from "./calc.js";
import { loadConfig, loadUsage, saveConfig } from "./config.js";
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
 * there's always a grid to toggle days into existence on, even from a totally empty config. */
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

export interface DashboardSnapshot {
  readonly config: Config;
  readonly usage: UsageState;
  readonly computed: ComputedUsage;
  readonly account: Account | null;
}

/** Read → rollover (in-memory only, matching the former usage-tui's "never persist on read" decision — the
 * statusline hook is what actually persists usage.json) → reconcile laboral days (persisted, since toggling/
 * auto-adding days must stick) → compute. Account resolution is sync-only here (no per-session token-override
 * profile fetch — see account.ts) since this feeds Ink's synchronous useState initializer. */
export function computeSnapshot(): DashboardSnapshot {
  const account = resolveActiveAccountSync();
  const key = accountKey(account);
  const loadedConfig = loadConfig(key);
  const usage = loadUsage(key);
  const now = new Date();
  rolloverIfNeeded(usage, loadedConfig, now);
  const config = reconcileLaboralDays(loadedConfig, usage);
  if (config !== loadedConfig) saveConfig(key, config);
  const computed = computeToday(usage, config, now);
  return { config, usage, computed, account };
}

export interface Cursor {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function clampDay(day: number, year: number, month: number): number {
  return Math.max(1, Math.min(daysInMonth(year, month), day));
}

const POLL_MS = 2000;

function renderStatsHeader(config: Config, computed: ComputedUsage): React.ReactElement {
  const showToday =
    config.hasSpendCap !== false && computed.avgPerDay !== null && computed.todayUsedPct !== null;
  return React.createElement(
    Box,
    { flexDirection: "column", marginBottom: 1 },
    React.createElement(Text, { bold: true, color: "yellow" }, "💰 cc-daily-usage dashboard"),
    showToday
      ? React.createElement(
          Text,
          { color: colorForPct(computed.todayUsedPct) },
          `Today:      ${money(computed.todayUsage)} / ${money(computed.avgPerDay)}  (${pctLabel(computed.todayUsedPct)})`,
        )
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

/** Dashboard/calendar-only nudge (see plan item 7) — reads Claude Code's own already-fetched overage-credit-
 * grant cache (account.ts's readOverageCreditGrantCache), no new network call. Deliberately not surfaced in
 * assets/statusline.sh. */
function renderCreditGrantBanner(account: Account | null): React.ReactElement | null {
  const grant = readOverageCreditGrantCache(account?.accountUuid ?? null);
  if (!grant || !grant.eligible || grant.granted || grant.amount_minor_units === null) return null;
  return React.createElement(
    Text,
    { color: "black", backgroundColor: "green" },
    ` 🎁 ${money(grant.amount_minor_units / 100)} credit grant available — claim it in Claude Code `,
  );
}

const CELL_WIDTH = 7; // " 7 $26" style, rounded to whole dollars to fit a compact grid

function renderDayCell(
  year: number,
  month: number,
  day: number,
  config: Config,
  usage: UsageState,
  cursor: Cursor,
  today: string,
): React.ReactElement {
  const iso = isoDate(year, month, day);
  const isLaboral = (config.laboralDays[String(year)]?.[String(month)] ?? []).includes(day);
  const isCursor = cursor.year === year && cursor.month === month && cursor.day === day;
  const isToday = iso === today;
  const amount = usage.days[iso];
  const label =
    amount === undefined
      ? String(day).padStart(2, " ")
      : `${String(day).padStart(2, " ")}$${String(Math.round(amount))}`;
  return React.createElement(
    Text,
    {
      key: iso,
      inverse: isCursor,
      bold: isToday,
      color: isLaboral ? "green" : "gray",
      dimColor: !isLaboral && amount === undefined,
    },
    label.padEnd(CELL_WIDTH, " "),
  );
}

function renderMonthCard(
  year: number,
  month: number,
  config: Config,
  usage: UsageState,
  cursor: Cursor,
  today: string,
): React.ReactElement {
  const total = daysInMonth(year, month);
  const leading = mondayFirstWeekday(year, month, 1);
  // Same always-in-range indexing as renderWarningBanner's monthName.
  /* v8 ignore next */
  const monthName = MONTH_NAMES[month - 1] ?? "?";
  const cells: Array<React.ReactElement> = [];
  for (let i = 0; i < leading; i++) {
    cells.push(
      React.createElement(Text, { key: `blank-${String(i)}` }, "".padEnd(CELL_WIDTH, " ")),
    );
  }
  for (let day = 1; day <= total; day++) {
    cells.push(renderDayCell(year, month, day, config, usage, cursor, today));
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
  return React.createElement(
    Box,
    {
      key: `${String(year)}-${String(month)}`,
      flexDirection: "column",
      borderStyle: "round",
      borderColor: cursor.year === year && cursor.month === month ? "cyan" : "gray",
      paddingX: 1,
      marginRight: 1,
      marginBottom: 1,
    },
    React.createElement(Text, { bold: true }, `${monthName} ${String(year)}`),
    ...rows,
  );
}

function renderFooterBar(config: Config, computed: ComputedUsage): React.ReactElement | null {
  if (config.hasSpendCap === false) return null;
  const showToday = computed.avgPerDay !== null && computed.todayUsedPct !== null;
  const parts: Array<React.ReactElement> = [];
  if (showToday) {
    parts.push(
      React.createElement(
        Text,
        { key: "today", color: colorForPct(computed.todayUsedPct) },
        `${money(computed.todayUsage)}/${money(computed.avgPerDay)} (${pctLabel(computed.todayUsedPct)})`,
      ),
    );
    parts.push(React.createElement(Text, { key: "sep", dimColor: true }, " | "));
  }
  parts.push(
    React.createElement(
      Text,
      { key: "month", color: colorForPct(computed.monthUsedPct) },
      `${money(computed.monthlySpent)}/${money(computed.monthlyCap)} (${pctLabel(computed.monthUsedPct)})`,
    ),
  );
  return React.createElement(Box, { marginTop: 1 }, ...parts);
}

export function DashboardApp(): React.ReactElement {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(computeSnapshot);
  const [cursor, setCursor] = useState<Cursor>(() => {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  });
  const [capEdit, setCapEdit] = useState<string | null>(null);

  const months = monthsToShow(snapshot.config, snapshot.usage, new Date());
  const today = new Date().toISOString().slice(0, 10);

  // saveConfig writes synchronously (writeFileSync), so calling this right after a save re-reads the file
  // we just wrote — no need to thread the new config through by hand.
  function refresh(): void {
    setSnapshot(computeSnapshot());
  }

  // Live polling — same interval/reasoning the former usage-tui.ts used: reflects the statusline hook's
  // continual usage.json writes without the user having to manually re-open the dashboard.
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

  function switchMonth(direction: 1 | -1): void {
    const index = months.findIndex((m) => m.year === cursor.year && m.month === cursor.month);
    const nextIndex = (index + direction + months.length) % months.length;
    const target = months[nextIndex];
    // `months` always contains at least the current month (see monthsToShow) and nextIndex is always a valid
    // index into it, so target is always defined — noUncheckedIndexedAccess still requires the guard.
    /* v8 ignore next */
    if (!target) return;
    setCursor({ ...target, day: clampDay(cursor.day, target.year, target.month) });
  }

  useInput((input, key) => {
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

    if (input === "q" || key.escape) {
      exit();
      return;
    }
    if (input === "c" && snapshot.config.hasSpendCap !== false) {
      setCapEdit(String(snapshot.config.monthlyCap));
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
    if ((input === " " || key.return) && snapshot.config.hasSpendCap !== false) {
      toggleCursorDay();
      return;
    }
    if (key.leftArrow) setCursor((c) => ({ ...c, day: clampDay(c.day - 1, c.year, c.month) }));
    if (key.rightArrow) setCursor((c) => ({ ...c, day: clampDay(c.day + 1, c.year, c.month) }));
    if (key.upArrow) setCursor((c) => ({ ...c, day: clampDay(c.day - 7, c.year, c.month) }));
    if (key.downArrow) setCursor((c) => ({ ...c, day: clampDay(c.day + 7, c.year, c.month) }));
  });

  return React.createElement(
    Box,
    // No fixed width here — letting Ink size against the real terminal (stdout.columns) is what makes
    // the month-card grid below actually flex-wrap responsively; 80 is only the *minimum* a terminal needs
    // for a single card to fit, not a cap on how many fit side by side on a wider one.
    { flexDirection: "column" },
    renderStatsHeader(snapshot.config, snapshot.computed),
    renderWarningBanner(snapshot.config, new Date()),
    renderCreditGrantBanner(snapshot.account),
    capEdit !== null
      ? React.createElement(
          Text,
          { color: "cyan" },
          `Monthly cap: $${capEdit}_ (Enter to save, Esc to cancel)`,
        )
      : null,
    snapshot.config.hasSpendCap === false
      ? null
      : React.createElement(
          Box,
          { flexDirection: "row", flexWrap: "wrap" },
          ...months.map((m) =>
            renderMonthCard(m.year, m.month, snapshot.config, snapshot.usage, cursor, today),
          ),
        ),
    renderFooterBar(snapshot.config, snapshot.computed),
    React.createElement(
      Text,
      { dimColor: true },
      snapshot.config.hasSpendCap === false
        ? "q quit"
        : "←→ day  ↑↓ week  Tab month  Space/Enter toggle laboral  c cap  q quit",
    ),
  );
}

/**
 * Opens the dashboard; resolves once the user exits (q/Esc/Ctrl+C). Thin IO wrapper around ink's real render
 * against process.stdout/stdin — DashboardApp carries the actual logic and is covered directly via
 * ink-testing-library; this shim isn't meaningfully testable without a real terminal (same reasoning the
 * former usage-tui.ts's runUsageTui shim used).
 */
/* v8 ignore start */
export async function runDashboardTui(): Promise<number> {
  const { waitUntilExit } = render(React.createElement(DashboardApp));
  await waitUntilExit();
  return 0;
}
/* v8 ignore stop */
