import { Box, render, Text, useApp, useInput } from "ink";
import React, { useEffect, useState } from "react";

import { colorForPct, computeToday, rolloverIfNeeded } from "./calc.js";
import { loadConfig, loadUsage } from "./config.js";
import type { ComputedUsage } from "./interfaces/calc.interface.js";

const POLL_MS = 2000;

function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function pctLabel(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/** Same read-rollover-compute sequence as `runReport` — never mutates anything back to disk. */
export function computeSnapshot(): ComputedUsage {
  const config = loadConfig();
  const usage = loadUsage();
  const now = new Date();
  rolloverIfNeeded(usage, config, now);
  return computeToday(usage, config, now);
}

export function UsageDashboard(): React.ReactElement {
  const { exit } = useApp();
  const [computed, setComputed] = useState<ComputedUsage>(computeSnapshot);

  useInput((input, key) => {
    if (input === "q" || key.escape) exit();
  });

  useEffect(() => {
    const timer = setInterval(() => {
      setComputed(computeSnapshot());
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  // Mirrors the statusline's null-handling: laboral days not configured for the current month means
  // avgPerDay/todayUsedPct are null — show only the raw month total, never a misleading $X/$0.00 row.
  const showToday = computed.avgPerDay !== null && computed.todayUsedPct !== null;

  return React.createElement(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1 },
    React.createElement(Text, { bold: true, color: "yellow" }, "💰 Monthly budget"),
    showToday
      ? React.createElement(
          Text,
          { color: colorForPct(computed.todayUsedPct) },
          `Today:      ${money(computed.todayUsage)} / ${money(computed.avgPerDay)}  (${pctLabel(computed.todayUsedPct)})`,
        )
      : null,
    React.createElement(
      Text,
      { color: colorForPct(computed.monthUsedPct) },
      `This month: ${money(computed.monthlySpent)} / ${money(computed.monthlyCap)}  (${pctLabel(computed.monthUsedPct)})`,
    ),
    React.createElement(Text, { dimColor: true }, "Press q to exit"),
  );
}

/**
 * Opens the live terminal dashboard; resolves once the user exits (q/Esc/Ctrl+C). Thin IO wrapper around
 * `ink`'s real render against process.stdout/stdin — `UsageDashboard` carries the actual logic and is
 * covered directly via ink-testing-library; this shim isn't meaningfully testable without a real terminal.
 */
/* v8 ignore start */
export async function runUsageTui(): Promise<number> {
  const { waitUntilExit } = render(React.createElement(UsageDashboard));
  await waitUntilExit();
  return 0;
}
/* v8 ignore stop */
