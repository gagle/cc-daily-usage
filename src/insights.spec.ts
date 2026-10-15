import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Finding } from "./feed.js";
import type * as InsightsModule from "./insights.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

function fresh(): Promise<typeof InsightsModule> {
  return import("./insights.js");
}

const NOW = new Date("2026-10-07T12:00:00.000Z");

const FINDING: Finding = {
  id: "R2",
  title: "Fast mode",
  usd: 4,
  window: "week",
  evidence: "1 fast turns",
  fix: { kind: "setting", key: "fastMode", value: "false", text: "Turn fast mode off (/fast)" },
  snoozedUntil: null,
};

beforeEach(() => {
  vi.resetModules();
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccdu-insights-"));
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("parseInsightsArgs", () => {
  it("defaults, window, json, snooze, errors", async () => {
    const { parseInsightsArgs } = await fresh();
    expect(parseInsightsArgs([])).toEqual({ window: "week", json: false, snooze: null });
    expect(parseInsightsArgs(["--month", "--json", "--snooze", "R1", "7d"])).toEqual({
      window: "month",
      json: true,
      snooze: { id: "R1", days: 7 },
    });
    expect(parseInsightsArgs(["--month", "--week"])).toMatchObject({ window: "week" });
    expect(parseInsightsArgs(["--snooze", "R1"])).toContain("--snooze needs");
    expect(parseInsightsArgs(["--snooze"])).toContain("--snooze needs");
    expect(parseInsightsArgs(["--snooze", "x", "7d"])).toContain("--snooze needs");
    expect(parseInsightsArgs(["--nope"])).toBe("Unknown insights argument: --nope");
  });
});

describe("formatInsights", () => {
  it("one block per finding with the fix; snoozed marked; empty says so", async () => {
    const { formatInsights } = await fresh();
    expect(formatInsights([], "week")).toBe("Nothing to change this week.");
    const text = formatInsights(
      [
        FINDING,
        {
          ...FINDING,
          id: "R8",
          usd: null,
          fix: { kind: "habit", text: "Slow down" },
          snoozedUntil: "2026-10-14T00:00:00.000Z",
        },
        { ...FINDING, id: "R9", fix: { kind: "command", value: "/model", text: "Switch" } },
      ],
      "week",
    );
    expect(text).toContain("R2  Fast mode  ~$4.00/week");
    expect(text).toContain("fix: Turn fast mode off (/fast) → fastMode=false");
    expect(text).toContain("R8  Fast mode  —/week (snoozed until 2026-10-14)");
    expect(text).toContain("fix: Slow down\n");
    expect(text).toContain("fix: Switch → /model");
    expect(text).toContain("API-equivalent estimates");
    expect(
      formatInsights([{ ...FINDING, fix: { kind: "env", key: "K", text: "t" } }], "week"),
    ).toContain("→ K=");
  });
});

describe("snoozeRule / adviceFor", () => {
  it("stores and clears a snooze; the coach then puts that finding last", async () => {
    const { snoozeRule, adviceFor } = await fresh();
    const { loadConfig, loadUsage } = await import("./config.js");
    expect(snoozeRule("acct", "R2", 7, NOW)).toBe("2026-10-14T12:00:00.000Z");
    expect(loadConfig("acct").snoozed).toEqual({ R2: "2026-10-14T12:00:00.000Z" });

    const dir = path.join(fakeHome, ".claude", "projects", "-p");
    mkdirSync(dir, { recursive: true });
    const line = (id: string, speed: string, timestamp: string): string =>
      `${JSON.stringify({
        type: "assistant",
        requestId: id,
        sessionId: "s1",
        timestamp,
        cwd: "/p",
        message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, speed } },
      })}\n`;
    writeFileSync(
      path.join(dir, "s1.jsonl"),
      line("a", "fast", NOW.toISOString()) + line("b", "fast", "2026-09-01T00:00:00.000Z"),
    );
    const accountDir = path.join(fakeHome, ".config", "cc-daily-usage", "accounts", "acct");
    writeFileSync(
      path.join(accountDir, "sessions-map.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessions: {
          s1: {
            transcriptPath: null,
            firstSeenAt: NOW.toISOString(),
            lastSeenAt: NOW.toISOString(),
            costUsd: 8,
            linesAdded: 0,
            linesRemoved: 0,
          },
        },
      }),
    );
    const { runIndexPass } = await import("./transcript-index.js");
    runIndexPass({ now: NOW });
    const usage = loadUsage("acct", NOW);
    usage.missCauses = {
      "2026-10-07": { tools_changed: { count: 1, usd: 2 } },
      "2026-08-01": { tools_changed: { count: 1, usd: 50 } },
    };
    const feed = {
      limits: { fiveHour: null, sevenDay: null, usdPerPercentWeek: null, claudeCodeShare: null },
    };
    const week = adviceFor("acct", "week", feed, loadConfig("acct"), usage, NOW);
    expect(week.map((finding) => [finding.id, finding.usd, finding.snoozedUntil !== null])).toEqual(
      [
        ["R4", 2, false],
        ["R2", 4, true],
      ],
    );
    const month = adviceFor("acct", "month", feed, loadConfig("acct"), usage, NOW);
    expect(month.find((finding) => finding.id === "R2")?.window).toBe("month");

    expect(snoozeRule("acct", "R2", 0, NOW)).toBeNull();
    expect(loadConfig("acct").snoozed).toEqual({});
    expect(
      adviceFor("acct", "week", feed, { monthlyCap: 1, laboralDays: {} }, usage, NOW)[0]?.id,
    ).toBe("R2");
  });
});
