import { afterEach, describe, expect, it, vi } from "vitest";

import { coach, type CoachInput, MAX_FINDINGS, topFinding } from "./rules.js";
import type { SessionTotals } from "./transcript-index.js";
import {
  addTurn,
  emptyRollup,
  priceTurn,
  type Rollup,
  rowKey,
  type Turn,
} from "./transcript-parse.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");

const BASE_TURN: Turn = {
  key: "k",
  sessionId: "s",
  timestamp: NOW.toISOString(),
  model: "claude-opus-5-5",
  cwd: "/p",
  branch: "",
  fast: false,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  thinking: 0,
  webSearches: 0,
  webFetches: 0,
  effort: null,
  thinkingMs: 0,
  entrypoint: null,
};

function row(turn: Partial<Turn>, scope = "main"): readonly [string, Rollup] {
  const full = { ...BASE_TURN, ...turn };
  const rollup = emptyRollup();
  addTurn(rollup, full, priceTurn(full));
  const key = rowKey({
    day: "2026-10-07",
    project: "/p",
    model: full.model,
    scope,
    speed: full.fast ? "fast" : "standard",
  });
  return [key, rollup];
}

function input(overrides: Partial<CoachInput> = {}): CoachInput {
  return {
    rows: [],
    sessions: {},
    missCauses: {},
    limits: null,
    budget: undefined,
    window: "week",
    snoozed: {},
    now: NOW,
    ...overrides,
  };
}

function session(usd: number): SessionTotals {
  return {
    firstAt: "",
    lastAt: NOW.toISOString(),
    project: "/p",
    branch: "",
    models: [],
    turns: 1,
    usd,
    unpricedTurns: 0,
    subagentUsd: 0,
  };
}

const only = (findings: ReturnType<typeof coach>, id: string) =>
  findings.find((finding) => finding.id === id);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("coach rules", () => {
  it("nothing to say on an empty window", () => {
    expect(coach(input())).toEqual([]);
    expect(topFinding([])).toBeNull();
  });

  it("R1: premium subagents vs Sonnet", () => {
    const findings = coach(
      input({
        rows: [
          row({ input: 1_000_000, output: 100_000 }, "subagent:Explore"),
          row({ input: 1_000_000, model: "claude-sonnet-5-5" }, "subagent:Plan"),
          row({ input: 1_000_000, model: "claude-future-opus" }, "subagent:x"),
        ],
      }),
    );
    expect(only(findings, "R1")).toEqual({
      id: "R1",
      title: "Subagents on a premium model",
      usd: 3,
      window: "week",
      evidence: "1 subagent turns on claude-opus-5-5",
      fix: {
        kind: "env",
        key: "CLAUDE_CODE_SUBAGENT_MODEL",
        value: "sonnet",
        text: "Run subagents on Sonnet (or set model: in the agent file)",
      },
      snoozedUntil: null,
    });
  });

  it("R1 reprices cache writes with the input ratio", () => {
    const findings = coach(input({ rows: [row({ cacheWrite5m: 1_000_000 }, "subagent:a")] }));
    expect(only(findings, "R1")?.usd).toBe(2.5); // $5 of writes at Opus → $2.50 at Sonnet
  });

  it("R2: fast mode costs half its $ extra", () => {
    const findings = coach(
      input({
        rows: [
          row({ input: 1_000_000, fast: true }),
          row({ input: 1_000_000, fast: true }, "subagent:a"),
        ],
      }),
    );
    expect(only(findings, "R2")).toMatchObject({
      usd: 8,
      evidence: "2 fast turns, 1 in subagents",
      fix: { kind: "setting", key: "fastMode", value: "false" },
    });
    expect(
      only(coach(input({ rows: [row({ input: 1_000_000, fast: true })] })), "R2")?.evidence,
    ).toBe("1 fast turns");
  });

  it("R3: thinking at high effort", () => {
    const findings = coach(
      input({ rows: [row({ output: 100_000, thinking: 50_000, effort: "max" })] }),
    );
    expect(only(findings, "R3")).toMatchObject({
      usd: 1,
      fix: { key: "effortLevel", value: "high" },
    });
  });

  it("R4: cache misses by cause, top three", () => {
    const findings = coach(
      input({
        missCauses: {
          "2026-10-06": { tools_changed: { count: 2, usd: 3 }, a: { count: 1, usd: 0.1 } },
          "2026-10-07": {
            ttl_expired_5m: { count: 1, usd: 1 },
            tools_changed: { count: 1, usd: 1 },
            b: { count: 1, usd: 0.2 },
          },
        },
      }),
    );
    expect(only(findings, "R4")).toMatchObject({
      usd: 5.3,
      evidence: "misses: tools changed $4.00, ttl expired 5m $1.00, b $0.20",
      fix: { kind: "habit" },
    });
  });

  it("R5: context past 200k", () => {
    const findings = coach(input({ rows: [row({ cacheRead: 10_000_000 })] }));
    expect(only(findings, "R5")).toMatchObject({
      evidence: "re-reading context above 200k tokens (deepest 10000k)",
      fix: { key: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" },
    });
    expect(only(findings, "R5")?.usd).toBeCloseTo(2 * 0.98);
  });

  it("R6: outlier sessions need 8 sessions and pass max($2, 3 × median)", () => {
    const sessions = (values: ReadonlyArray<number>) =>
      Object.fromEntries(values.map((usd, i) => [`session-${String(i)}`, session(usd)]));
    expect(
      only(coach(input({ sessions: sessions([1, 1, 1, 1, 1, 1, 50]) })), "R6"),
    ).toBeUndefined();
    expect(
      only(coach(input({ sessions: sessions([1, 1, 1, 1, 1, 1, 1, 2]) })), "R6"),
    ).toBeUndefined();
    const findings = coach(input({ sessions: sessions([1, 1, 1, 1, 1, 1, 1, 10, 7]) }));
    expect(only(findings, "R6")).toMatchObject({
      usd: 15,
      evidence: "session- cost $10.00 vs median $1.00 (+1 more)",
      fix: { kind: "command", value: "cc-daily-usage report week --by session" },
    });
    const even = coach(input({ sessions: sessions([1, 1, 1, 1, 1, 1, 3, 10]) }));
    expect(only(even, "R6")).toMatchObject({
      usd: 9,
      evidence: "session- cost $10.00 vs median $1.00",
    });
  });

  it("R8: a window at risk or today's budget passed, ranked first", () => {
    vi.stubEnv("TZ", "UTC");
    const window = {
      usedPct: 80,
      resetsAt: null,
      ratePctPerHour: 10,
      exhaustsAt: "2026-10-07T14:05:00.000Z",
      verdict: "at-risk",
    } as const;
    const findings = coach(
      input({
        rows: [row({ input: 1_000_000, fast: true })],
        limits: {
          fiveHour: window,
          sevenDay: { ...window, exhaustsAt: null },
          usdPerPercentWeek: null,
          claudeCodeShare: null,
        },
        budget: { todaySpent: 12, todayMax: 10, monthSpent: 0, monthCap: 0, paceLabel: null },
      }),
    );
    expect(findings[0]).toMatchObject({
      id: "R8",
      usd: null,
      evidence: "5h limit runs out Wed 14:05; 7d limit runs out soon; today $12.00 of $10.00",
    });
    expect(
      only(
        coach(
          input({
            budget: { todaySpent: 12, todayMax: null, monthSpent: 0, monthCap: 0, paceLabel: null },
          }),
        ),
        "R8",
      ),
    ).toBeUndefined();
    expect(
      coach(
        input({
          budget: { todaySpent: 1, todayMax: 10, monthSpent: 0, monthCap: 0, paceLabel: null },
        }),
      ),
    ).toEqual([]);
  });

  it("R8 alone from the budget, and ranked above every $ finding", () => {
    const budget = { todaySpent: 12, todayMax: 10, monthSpent: 0, monthCap: 0, paceLabel: null };
    const findings = coach(
      input({
        budget,
        rows: [
          row({ input: 1_000_000, output: 100_000 }, "subagent:a"),
          row({ input: 1_000_000, fast: true }),
        ],
      }),
    );
    expect(findings.map((finding) => finding.id)).toEqual(["R8", "R2", "R1"]);
    expect(findings[0]?.evidence).toBe("today $12.00 of $10.00");
    const limitsOnly = coach(
      input({
        limits: {
          fiveHour: null,
          sevenDay: {
            usedPct: 90,
            resetsAt: null,
            ratePctPerHour: 1,
            exhaustsAt: null,
            verdict: "at-risk",
          },
          usdPerPercentWeek: null,
          claudeCodeShare: null,
        },
      }),
    );
    expect(limitsOnly[0]?.evidence).toBe("7d limit runs out soon");
  });

  it("R9: an older model with a cheaper or equal replacement", () => {
    const findings = coach(
      input({
        rows: [
          row({ input: 1_000_000, model: "claude-opus-4-8" }),
          row({ input: 1_000_000, model: "claude-sonnet-4-6" }),
          row({ input: 1_000_000, model: "claude-haiku-4-5" }),
        ],
      }),
    );
    expect(only(findings, "R9")).toMatchObject({
      usd: 2,
      evidence: "claude-opus-4-8 → claude-opus-5-5, claude-sonnet-4-6 → claude-sonnet-5-5",
      fix: { kind: "command", value: "/model" },
    });
  });

  it("R10: carry share past 57%", () => {
    const heavy = coach(input({ rows: [row({ cacheRead: 5_000_000, input: 100_000 })] }));
    expect(only(heavy, "R10")).toMatchObject({ usd: 1, evidence: "71% of $ is cache reads" });
    expect(only(coach(input({ rows: [row({ input: 1_000_000 })] })), "R10")).toBeUndefined();
  });

  it("drops small $, ranks by $, puts snoozed last, caps at ten", () => {
    const rows = [
      row({ input: 1_000_000, output: 100_000 }, "subagent:a"), // R1 $3
      row({ input: 1_000_000, fast: true }), // R2 $4
      row({ output: 10_000, thinking: 10_000, effort: "ultra" }), // R3 $0.20: dropped
    ];
    const findings = coach(
      input({ rows, snoozed: { R2: "2026-10-10T00:00:00.000Z", R1: "2026-10-01T00:00:00.000Z" } }),
    );
    expect(findings.map((finding) => finding.id)).toEqual(["R1", "R2"]);
    expect(findings[1]?.snoozedUntil).toBe("2026-10-10T00:00:00.000Z");
    expect(findings[0]?.snoozedUntil).toBeNull();
    expect(topFinding(findings)?.id).toBe("R1");
    expect(topFinding(findings.slice(1))).toBeNull();
    expect(MAX_FINDINGS).toBe(10);
  });
});
