import { colorForPct, getLaboralDays, theoreticalAvgFromDayOne, utcDateString } from "./calc.js";
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

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? "Unknown";
}

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function pct(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

function renderStatTile(label: string, value: string, accentColor?: string): string {
  const style = accentColor ? ` style="border-color:${accentColor}"` : "";
  return `<div class="stat-tile"${style}><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div></div>`;
}

function renderMonthTable(
  config: Config,
  usage: UsageState,
  year: number,
  month: number,
  today: string,
): string {
  const days = getLaboralDays(config, year, month);
  if (days.length === 0) return "";
  const rows = days
    .map((day) => {
      const isoDate = `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const amount = usage.days[isoDate];
      const isToday = isoDate === today;
      const rowClass = isToday ? ' class="today-row"' : "";
      const amountCell = amount === undefined ? "" : money(amount);
      return `<tr${rowClass}><td>${String(day)}</td><td>${amountCell}</td></tr>`;
    })
    .join("");
  return `<div class="month-card"><h3>${monthName(month)} ${String(year)}</h3><div class="table-wrap"><table><thead><tr><th>Day</th><th>Spent</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

/** Mobile-first, fluid, Framer dark-canvas report matching /Users/gabrielllamasllopis/projects/DESIGN.md. */
export function renderReport(
  config: Config,
  usage: UsageState,
  computed: ComputedUsage,
  nowUtc: Date,
): string {
  const today = utcDateString(nowUtc);
  const currentYear = nowUtc.getUTCFullYear();
  const currentMonth = nowUtc.getUTCMonth() + 1;
  const avgFromDayOne = theoreticalAvgFromDayOne(config, currentYear, currentMonth);

  // Object.entries here (rather than re-indexing config.laboralDays by a separately-derived year list) means
  // every monthsBlock is one already known to exist — no defensive `?? {}` fallback that could never fire.
  const yearSections = Object.entries(config.laboralDays)
    .map(([yearStr, monthsBlock]) => ({ year: Number(yearStr), monthsBlock }))
    .sort((a, b) => a.year - b.year)
    .map(({ year, monthsBlock }) => {
      const months = Object.keys(monthsBlock)
        .map(Number)
        .sort((a, b) => a - b);
      const monthCards = months
        .map((month) => renderMonthTable(config, usage, year, month, today))
        .join("");
      return `<section class="year-section"><h2>${String(year)}</h2><div class="month-grid">${monthCards}</div></section>`;
    })
    .join("");

  const todayUsedColor =
    computed.todayUsedPct === null ? "#63BE7B" : colorForPct(computed.todayUsedPct);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claude usage report</title>
<style>
  :root {
    --canvas: #090909;
    --surface-1: #141414;
    --surface-2: #1c1c1c;
    --ink: #ffffff;
    --ink-muted: #999999;
    --accent-blue: #0099ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--canvas);
    color: var(--ink);
    font-family: "Inter", system-ui, sans-serif;
    padding: 20px;
  }
  h1 { font-size: 1.5rem; margin: 0 0 20px; }
  h2 { font-size: 1.25rem; margin: 40px 0 15px; }
  h3 { font-size: 1rem; margin: 0 0 10px; color: var(--ink-muted); }
  .stat-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .stat-tile {
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    border-radius: 20px;
    padding: 15px;
  }
  .stat-label { font-size: 0.8rem; color: var(--ink-muted); margin-bottom: 5px; }
  .stat-value { font-size: 1.25rem; font-weight: 600; }
  .month-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 15px;
  }
  .month-card {
    background: var(--surface-1);
    border-radius: 20px;
    padding: 15px;
  }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 5px 10px; }
  th { color: var(--ink-muted); font-weight: 500; }
  tr.today-row { background: #a1d76a; color: #090909; font-weight: 700; border-radius: 6px; }
  a { color: var(--accent-blue); }
  @media (min-width: 810px) {
    .stat-grid { grid-template-columns: repeat(4, 1fr); }
    .month-grid { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<h1>Claude usage — ${today}</h1>
<div class="stat-grid">
  ${renderStatTile("Monthly cap", money(computed.monthlyCap))}
  ${renderStatTile("Left this month", money(computed.leftThisMonth))}
  ${renderStatTile("Avg per day from day 1", avgFromDayOne === null ? "—" : money(avgFromDayOne))}
  ${renderStatTile("Today used", pct(computed.todayUsedPct ?? 0), todayUsedColor)}
</div>
${yearSections}
</body>
</html>`;
}
