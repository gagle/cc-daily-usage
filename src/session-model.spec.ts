import { describe, expect, it } from "vitest";

import {
  addSessionCompaction,
  addSessionTurn,
  buckets,
  cacheState,
  COLD_MIN_CONTEXT,
  costPerMTok,
  markBuckets,
  mtokBand,
  newSession,
  sessionUsd,
  topEntries,
  usdPerMinute,
} from "./session-model.js";
import type { Turn } from "./transcript-parse.js";

const T0 = Date.parse("2026-10-18T10:00:00.000Z");
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

let n = 0;
function turn(overrides: Partial<Turn> = {}): Turn {
  n += 1;
  return {
    key: `k${String(n)}`,
    sessionId: "s1",
    timestamp: at(0),
    model: "claude-opus-5-5",
    cwd: "/work/app",
    branch: "main",
    fast: false,
    usOnly: false,
    input: 1000,
    output: 1000,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    thinking: 0,
    webSearches: 0,
    webFetches: 0,
    effort: null,
    thinkingMs: 0,
    entrypoint: null,
    ...overrides,
  };
}

describe("addSessionTurn", () => {
  it("totals $ by component, model and scope; dedupes repeated keys", () => {
    const s = newSession("s1");
    const first = turn();
    expect(addSessionTurn(s, first, "main", "f")).toBe(true);
    expect(addSessionTurn(s, first, "main", "f")).toBe(false);
    addSessionTurn(
      s,
      turn({ model: "claude-sonnet-5-5", timestamp: at(2) }),
      "subagent:Explore",
      "a1",
    );
    // opus: 1000 in × $4 + 1000 out × $20; sonnet: × $2 / $10 (per MTok)
    expect(s.usd.input).toBeCloseTo(0.006);
    expect(s.usd.output).toBeCloseTo(0.03);
    expect(sessionUsd(s)).toBeCloseTo(0.036);
    expect(s.byModel["claude-opus-5-5"]).toBeCloseTo(0.024);
    expect(s.byScope["subagent:Explore"]).toBeCloseTo(0.012);
    expect(s.marks).toEqual([{ ms: T0 + 120_000, kind: "subagent" }]);
    expect(s).toMatchObject({ turns: 2, project: "/work/app", branch: "main", firstMs: T0 });
  });

  it("skips a turn with no time; keeps the old project when a turn has none", () => {
    const s = newSession("s1");
    expect(addSessionTurn(s, turn({ timestamp: "" }), "main", "f")).toBe(false);
    addSessionTurn(s, turn(), "main", "f");
    addSessionTurn(s, turn({ cwd: "", branch: "" }), "main", "f");
    expect(s.project).toBe("/work/app");
  });

  it("counts an unpriced model apart and still tracks its context", () => {
    const s = newSession("s1");
    addSessionTurn(s, turn({ model: "claude-future-9" }), "main", "f");
    expect(s).toMatchObject({ unpricedTurns: 1, points: [] });
    expect(s.lastMain?.model).toBe("claude-future-9");
    expect(cacheState(s, T0)).toBeNull();
  });

  it("marks a cold cache when a big context comes back as a write", () => {
    const s = newSession("s1");
    addSessionTurn(s, turn({ cacheWrite5m: COLD_MIN_CONTEXT }), "main", "f");
    addSessionTurn(
      s,
      turn({ timestamp: at(30), cacheWrite5m: COLD_MIN_CONTEXT + 1000 }),
      "main",
      "f",
    );
    addSessionTurn(s, turn({ timestamp: at(31), cacheRead: 22_000 }), "main", "f");
    expect(s.marks.filter((m) => m.kind === "cold")).toHaveLength(1);
    expect(s.coldUsd).toBeGreaterThan(0);
  });

  it("keeps the newest main turn when lines arrive out of order", () => {
    const s = newSession("s1");
    addSessionTurn(s, turn({ timestamp: at(5) }), "main", "f");
    addSessionTurn(s, turn({ timestamp: at(1), input: 7 }), "main", "f");
    expect(s.lastMain?.ms).toBe(T0 + 300_000);
  });
});

describe("cacheState", () => {
  it("counts down one TTL after the last main turn; 1h writes keep the 1h TTL", () => {
    const s = newSession("s1");
    expect(cacheState(s, T0)).toBeNull();
    addSessionTurn(s, turn({ input: 0, cacheRead: 100_000, cacheWrite5m: 0 }), "main", "f");
    expect(cacheState(s, T0 + 60_000)).toMatchObject({
      warm: true,
      secondsLeft: 240,
      ttlSeconds: 300,
      context: 100_000,
    });
    const warm = cacheState(s, T0);
    expect(warm?.nextWarmUsd).toBeCloseTo(0.02); // 100k × $0.20
    expect(warm?.nextColdUsd).toBeCloseTo(0.5); // 100k × $4 × 1.25
    expect(cacheState(s, T0 + 600_000)).toMatchObject({ warm: false, secondsLeft: 0 });

    addSessionTurn(s, turn({ timestamp: at(1), cacheWrite1h: 10 }), "main", "f");
    expect(cacheState(s, T0 + 60_000)?.ttlSeconds).toBe(3600);
    expect(cacheState(s, T0 + 60_000)?.nextColdUsd).toBeCloseTo((10 * 8) / 1e6, 9); // cached prefix only, not fresh input
    addSessionTurn(s, turn({ timestamp: at(2), cacheWrite5m: 10 }), "main", "f");
    expect(cacheState(s, T0)?.ttlSeconds).toBe(300);
  });

  it("subagent turns do not move the main cache", () => {
    const s = newSession("s1");
    addSessionTurn(s, turn({ cacheWrite1h: 10 }), "subagent:x", "a");
    expect(s.lastMain).toBeNull();
    expect(s.ttlSeconds).toBe(300);
  });
});

describe("compactions and time series", () => {
  it("marks compactions; ignores a bad time", () => {
    const s = newSession("s1");
    const c = { sessionId: "s1", trigger: "auto", preTokens: 1, postTokens: 1 };
    addSessionCompaction(s, { ...c, timestamp: at(3) });
    addSessionCompaction(s, { ...c, timestamp: "x" });
    expect(s.marks).toEqual([{ ms: T0 + 180_000, kind: "compact" }]);
  });

  it("buckets $ and marks on one grid", () => {
    const points = [
      { ms: T0, usd: 1 },
      { ms: T0 + 59_999, usd: 2 },
      { ms: T0 + 60_000, usd: 4 },
      { ms: T0 + 120_000, usd: 8 }, // at the end: out
      { ms: T0 - 1, usd: 16 }, // before: out
    ];
    expect(buckets(points, T0, T0 + 120_000, 2)).toEqual([3, 4]);
    expect(buckets(points, T0, T0, 2)).toEqual([0, 0]);
    const marks = markBuckets(
      [
        { ms: T0 + 61_000, kind: "cold" },
        { ms: T0 - 1, kind: "compact" },
      ],
      T0,
      T0 + 120_000,
      2,
    );
    expect(marks.map((set) => [...set])).toEqual([[], ["cold"]]);
    expect(markBuckets([], T0, T0, 1).map((set) => set.size)).toEqual([0]);
  });

  it("$ per minute over the window", () => {
    const s = newSession("s1");
    addSessionTurn(s, turn({ timestamp: at(-20) }), "main", "f");
    addSessionTurn(s, turn({ timestamp: at(-5) }), "main", "f");
    expect(usdPerMinute(s, T0)).toBeCloseTo(0.024 / 10);
  });
});

describe("efficiency", () => {
  it("$ per MTok of new work; null before any growth", () => {
    const s = newSession("s1");
    expect(costPerMTok(s)).toBeNull();
    addSessionTurn(s, turn(), "main", "f");
    // growth 1000 (first turn) + 1000 output = 2000 tokens for $0.024
    expect(costPerMTok(s)).toBeCloseTo(12);
    expect(s.efficiency.newWorkUsd).toBeCloseTo(0.024);
  });
});

describe("mtokBand", () => {
  it("good under $33, high over $80, fair between", () => {
    expect([10, 33, 80, 81].map(mtokBand)).toEqual(["good", "fair", "fair", "high"]);
  });
});

describe("topEntries", () => {
  it("sorts and cuts", () => {
    expect(topEntries({ a: 1, b: 3, c: 2 }, 2)).toEqual([
      ["b", 3],
      ["c", 2],
    ]);
  });
});
