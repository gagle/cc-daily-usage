import { describe, expect, it } from "vitest";

import { adviseNow, contextStatus, scorecard, wrap } from "./advisor.js";
import type { Feed, FeedWindow } from "./feed.js";
import { addSessionTurn, newSession, type SessionModel } from "./session-model.js";
import type { Turn } from "./transcript-parse.js";

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

let n = 0;
function turn(overrides: Partial<Turn> = {}): Turn {
  n += 1;
  return {
    key: `k${String(n)}`,
    sessionId: "s1",
    timestamp: at(-1),
    model: "claude-opus-5-5",
    cwd: "/p",
    branch: "",
    fast: false,
    usOnly: false,
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
    ...overrides,
  };
}

function session(turns: ReadonlyArray<Partial<Turn>>): SessionModel {
  const s = newSession("s1");
  for (const t of turns) addSessionTurn(s, turn(t), "main", "f");
  return s;
}

const window = (overrides: Partial<FeedWindow> = {}): FeedWindow => ({
  usedPct: 50,
  resetsAt: at(600),
  ratePctPerHour: 10,
  exhaustsAt: at(120),
  verdict: "at-risk",
  ...overrides,
});

const feedWith = (fiveHour: FeedWindow | null, sevenDay: FeedWindow | null): Feed =>
  ({
    limits: { fiveHour, sevenDay, usdPerPercentWeek: null, claudeCodeShare: null },
  }) as unknown as Feed;

const keys = (tips: ReturnType<typeof adviseNow>): ReadonlyArray<string> =>
  tips.map((tip) => tip.key);

describe("scorecard", () => {
  it("empty before a priced turn", () => {
    expect(scorecard(newSession("s"))).toEqual([]);
  });

  it("cache reads, re-sending, re-reading, $ per MTok with their status", () => {
    const lean = session([
      { input: 10_000, output: 2000 },
      { input: 100, output: 2000, cacheRead: 10_000, cacheWrite5m: 2100 },
    ]);
    const scores = scorecard(lean);
    expect(scores.map((score) => score.label)).toEqual([
      "cache reads",
      "re-sending",
      "re-reading",
      "$ per MTok",
    ]);
    expect(scores[0]).toMatchObject({ value: "45%", target: "≥ 90%", status: "bad" });
    expect(scores[1]).toMatchObject({ status: "good" });
    expect(scores[3]?.status).toBe("good");
    for (const score of scores) expect(score.meaning.length).toBeGreaterThan(10);
  });

  it("thresholds: fair cache reads, bad re-sending and re-reading, high $ per MTok", () => {
    const reads = session([{ cacheRead: 85, cacheWrite5m: 15 }]);
    expect(scorecard(reads)[0]?.status).toBe("fair");
    const resend = session([{ input: 100_000 }, { input: 100_000 }]); // same context sent again
    expect(scorecard(resend)[1]).toMatchObject({ status: "bad", value: "50%" });
    const reread = session([
      { input: 1_000_000 },
      ...Array.from({ length: 700 }, () => ({ cacheRead: 1_000_000 })),
    ]);
    expect(scorecard(reread)[2]?.status).toBe("bad");
    expect(scorecard(reread)[3]).toMatchObject({
      status: "bad",
      fraction: 1,
    });
    const middle = session([
      { input: 1_000_000 },
      ...Array.from({ length: 200 }, () => ({ cacheRead: 1_000_000 })),
    ]);
    expect(scorecard(middle)[3]?.status).toBe("fair");
  });

  it("no $ per MTok row without context growth", () => {
    const s = session([{ cacheRead: 1000 }]);
    s.efficiency.growthTokens = 0;
    expect(scorecard(s).map((score) => score.label)).not.toContain("$ per MTok");
  });

  it("an all-cache-free priced session reads 0%", () => {
    const s = session([{ output: 1000 }]);
    expect(scorecard(s)[0]?.value).toBe("0%");
  });
});

describe("contextStatus", () => {
  it("good under 150k, fair under 200k, bad from 200k", () => {
    expect([100_000, 160_000, 200_000].map(contextStatus)).toEqual(["good", "fair", "bad"]);
  });
});

describe("adviseNow", () => {
  it("nothing for a small, warm, lean session", () => {
    expect(adviseNow(session([{ input: 1000, output: 1000 }]), NOW, null)).toEqual([]);
    expect(adviseNow(session([{ model: "claude-future-9", input: 1000 }]), NOW, null)).toEqual([]);
  });

  it("limits at risk: one tip naming each window, ranked first with no $", () => {
    const s = session([{ input: 300_000, cacheRead: 0 }]);
    const tips = adviseNow(s, NOW, feedWith(window(), window({ exhaustsAt: at(-60) })));
    expect(tips[0]).toMatchObject({ key: "limits", usd: null });
    expect(tips[0]?.see).toContain("5h in 2.0 h, 7d in 0.0 h");
    expect(
      keys(
        adviseNow(s, NOW, feedWith(window({ verdict: "on-track" }), window({ exhaustsAt: null }))),
      ),
    ).not.toContain("limits");
  });

  it("cache going cold soon, and already cold", () => {
    const s = session([{ timestamp: at(-4), cacheRead: 100_000 }]);
    const soon = adviseNow(s, NOW, null);
    expect(soon[0]).toMatchObject({ key: "cold-soon" });
    expect(soon[0]?.see).toContain("goes cold in 60 s");
    expect(keys(adviseNow(s, NOW - 120_000, null))).not.toContain("cold-soon"); // 3 min left
    const cold = adviseNow(s, NOW + 600_000, null);
    expect(cold[0]).toMatchObject({ key: "cold", usd: 0.5 });
    expect(keys(adviseNow(session([{ timestamp: at(-4), cacheRead: 10_000 }]), NOW, null))).toEqual(
      [],
    );
    // cold soon but cheap: no tip
    const cheap = session([{ timestamp: at(-4), cacheRead: 20_000, model: "claude-haiku-5-5" }]);
    expect(adviseNow(cheap, NOW, null)).toEqual([]);
    expect(adviseNow(cheap, NOW + 600_000, null)).toEqual([]);
  });

  it("breaks that expired the cache: 1h TTL when it pays, else compact before breaks", () => {
    const breaks = session([
      { timestamp: at(-120), cacheWrite5m: 200_000 },
      { timestamp: at(-60), cacheWrite5m: 200_000 },
      { timestamp: at(-1), cacheRead: 200_000 },
    ]);
    const pays = adviseNow(breaks, NOW, null).find((tip) => tip.key === "breaks");
    expect(pays?.see).toContain("1 break(s) let the cache expire: $1.00");
    expect(pays?.act).toContain('"promptCacheTtl": "1h"');
    const writesHeavy = session([
      { timestamp: at(-120), cacheWrite5m: 200_000 },
      { timestamp: at(-60), cacheWrite5m: 200_000 },
      { timestamp: at(-1), cacheRead: 200_000, cacheWrite5m: 2_000_000 },
    ]);
    expect(adviseNow(writesHeavy, NOW, null, 9).find((tip) => tip.key === "breaks")?.act).toContain(
      "/compact before a break",
    );
  });

  it("deep context: per-turn read and the gain from compacting", () => {
    const deep = session([{ timestamp: at(-1), cacheRead: 400_000 }]);
    const tip = adviseNow(deep, NOW, null).find((t) => t.key === "deep");
    expect(tip?.see).toBe(
      "Context is 400k: every turn and tool call re-reads it, ~$0.08 each (~$8.00 per 100).",
    );
    expect(tip?.act).toContain("~$0.01 a turn");
  });

  it("new context arriving fast; history re-read; the cap and the $ ranking", () => {
    const writes = session([{ input: 1000, output: 100, cacheWrite5m: 50_000 }]);
    const tip = adviseNow(writes, NOW, null).find((t) => t.key === "new-context");
    expect(tip?.see).toContain("($5/MTok here)");
    const reread = session([
      { input: 10_000 },
      ...Array.from({ length: 50 }, () => ({ cacheRead: 100_000 })),
    ]);
    expect(keys(adviseNow(reread, NOW, null))).toContain("reread");
    const all = adviseNow(reread, NOW + 600_000, feedWith(window(), null), 9);
    expect(all[0]?.key).toBe("limits");
    const dollars = all.flatMap((t) => (t.usd === null ? [] : [t.usd]));
    expect([...dollars].sort((a, b) => b - a)).toEqual(dollars);
    expect(adviseNow(reread, NOW + 600_000, feedWith(window(), null))).toHaveLength(3);
  });

  it("an unpriced last model: no rate in the new-context tip, no compact gain", () => {
    const s = session([{ input: 1000, output: 100, cacheWrite5m: 50_000 }]);
    addSessionTurn(s, turn({ model: "claude-future-9", timestamp: at(0) }), "main", "f");
    const tip = adviseNow(s, NOW, null).find((t) => t.key === "new-context");
    expect(tip?.see).toMatch(/fast\.$/);
  });
});

describe("adviseNow: subagent-only sessions", () => {
  it("new context from subagents only: no rate in the text", () => {
    const s = newSession("s1");
    addSessionTurn(s, turn({ input: 1000, cacheWrite5m: 50_000 }), "subagent:x", "a");
    expect(adviseNow(s, NOW, null)[0]?.see).toMatch(/new context arrives fast\.$/);
  });
});

describe("wrap", () => {
  it("splits at spaces within the width; a long word stays whole", () => {
    expect(wrap("aa bb cc dd", 5)).toEqual(["aa bb", "cc dd"]);
    expect(wrap("abcdefgh ij", 4)).toEqual(["abcdefgh", "ij"]);
    expect(wrap("", 4)).toEqual([]);
  });
});
