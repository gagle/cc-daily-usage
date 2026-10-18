import { describe, expect, it } from "vitest";

import type { Feed, FeedWindow, Finding } from "./feed.js";
import {
  barCells,
  type FeedState,
  fit,
  kTokens,
  type LiveFrame,
  parseFeed,
  renderLive,
  span,
} from "./live-render.js";
import {
  addSessionCompaction,
  addSessionTurn,
  newSession,
  type SessionModel,
} from "./session-model.js";
import type { Turn } from "./transcript-parse.js";

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

let n = 0;
function turn(overrides: Partial<Turn> = {}): Turn {
  n += 1;
  return {
    key: `k${String(n)}`,
    sessionId: "s1",
    timestamp: iso(-60_000),
    model: "claude-opus-5-5",
    cwd: "/work/app",
    branch: "main",
    fast: false,
    input: 1000,
    output: 1000,
    cacheRead: 50_000,
    cacheWrite5m: 1000,
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

function session(
  id: string,
  turns: ReadonlyArray<[Partial<Turn>, string?, string?]>,
): SessionModel {
  const s = newSession(id);
  for (const [overrides, scope = "main", thread = "main"] of turns) {
    addSessionTurn(s, turn({ sessionId: id, ...overrides }), scope, thread);
  }
  return s;
}

const window = (overrides: Partial<FeedWindow> = {}): FeedWindow => ({
  usedPct: 40,
  resetsAt: iso(3 * 3600_000),
  ratePctPerHour: 5,
  exhaustsAt: iso(2 * 3600_000),
  verdict: "at-risk",
  ...overrides,
});

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: "R1",
  title: "Subagents on a premium model",
  usd: 12.4,
  window: "week",
  evidence: "e",
  fix: { kind: "habit", text: "t" },
  snoozedUntil: null,
  ...overrides,
});

function feed(overrides: Partial<Feed> = {}): FeedState {
  return {
    kind: "ok",
    feed: {
      schemaVersion: 1,
      writtenAt: iso(-42_000),
      accountKey: "a",
      plan: { organizationType: "claude_max", hasSpendCap: false },
      sessionIds: [],
      limits: {
        fiveHour: window(),
        sevenDay: window({ verdict: "comfortable" }),
        usdPerPercentWeek: 2,
        claudeCodeShare: null,
      },
      spend: { today: 18.4, week: 96, monthToDate: 310, last30Days: 400, isFloor: false },
      advice: [finding({ id: "R9", snoozedUntil: iso(1) }), finding()],
      ...overrides,
    },
  };
}

function frame(overrides: Partial<LiveFrame> = {}): LiveFrame {
  return {
    sessions: [session("aaaa1111", [[{}]])],
    selected: 0,
    feed: feed(),
    nowMs: NOW,
    width: 100,
    color: false,
    view: "details",
    ...overrides,
  };
}

const text = (f: LiveFrame): string => renderLive(f).join("\n");

describe("parseFeed", () => {
  it("missing, garbage, unversioned, newer, ok", () => {
    expect(parseFeed(null)).toEqual({ kind: "missing" });
    expect(parseFeed("{")).toEqual({ kind: "missing" });
    expect(parseFeed("null")).toEqual({ kind: "missing" });
    expect(parseFeed('{"schemaVersion":99}')).toEqual({ kind: "newer" });
    expect(parseFeed('{"schemaVersion":1}')).toMatchObject({ kind: "ok" });
  });
});

describe("formatters", () => {
  it("kTokens and span", () => {
    expect(kTokens(131_400)).toBe("131k");
    expect(kTokens(1_200_000)).toBe("1.2M");
    expect(span(-5)).toBe("0s");
    expect(span(40_000)).toBe("40s");
    expect(span(12 * 60_000)).toBe("12m");
    expect(span((4 * 60 + 5) * 60_000)).toBe("4h05");
    expect(span(72 * 3600_000)).toBe("3d");
  });
});

describe("barCells and fit", () => {
  it("bar width follows the terminal width", () => {
    expect([100, 90, 75, 62, 40].map(barCells)).toEqual([24, 24, 18, 12, 8]);
  });

  it("blank lines between blocks when it fits; dense when not; then a cut with a note", () => {
    const sections = [[["t"]], [["a", "b"], ["c"]], [["d"]]];
    expect(fit(sections, 99, false)).toEqual(["t", "", "a", "b", "", "c", "", "d"]);
    expect(fit(sections, 5, false)).toEqual(["t", "a", "b", "c", "d"]);
    expect(fit(sections, 3, false)).toEqual(["t", "a", "… a taller terminal shows the rest"]);
    expect(fit(sections, 0, false)).toEqual(["… a taller terminal shows the rest"]);
  });
});

describe("renderLive: sessions and this session", () => {
  it("title with keys; sessions with a bar, share of week, live or idle; the selected one marked", () => {
    const old = session("bbbb2222", [[{ timestamp: iso(-10 * 60_000), cwd: "C:\\code\\other" }]]);
    const out = text(frame({ sessions: [session("aaaa1111", [[{}]]), old], selected: 1 }));
    expect(out).toMatch(
      /^cc-daily-usage live · 2 active · \d\d:\d\d +q quit · ↑↓ session · tab advisor$/m,
    );
    expect(out).toMatch(/^SESSIONS$/m);
    expect(out).toMatch(/^ {4}aaaa app +█{16} +\$0\.04 +≈0\.0% wk +● live$/m);
    expect(out).toMatch(/^ {2}▸ bbbb other +█{16} +\$0\.04 +≈0\.0% wk +idle 10m$/m);
  });

  it("this session: facts, sparkline, one bar per component, model, work; cache and context", () => {
    const out = text(frame());
    expect(out).toMatch(/^THIS SESSION {3}\$0\.04 · \$0\.00\/min · 0s · 1 turns$/m);
    expect(out).toMatch(/^ {2}last 30 min {3}[▁-█]{30} {2}\$ per minute$/m);
    expect(out).toMatch(/^ {2}where it went$/m);
    expect(out).toMatch(/^ {2}input {9}[█░]{24} +\$0\.00 +10%$/m);
    expect(out).toMatch(/^ {2}output {8}[█░]{24} +\$0\.02 +51%$/m);
    expect(out).not.toContain("web search");
    expect(out).toMatch(/^ {2}opus-5-5 {6}█{24} +\$0\.04 +100%$/m);
    expect(out).toMatch(/^ {2}work · \$\d+ per MTok of new work \(good\)$/m);
    expect(out).toMatch(/^ {2}new work {6}[█░]{24} +\$0\.03 +74%$/m);
    expect(out).toMatch(/^ {2}re-reading {4}[█░]{24}/m);
    expect(out).toMatch(/^ {2}re-sending {4}[█░]{24}/m);
    expect(out).toMatch(/^CACHE & CONTEXT {3}estimate from the transcript$/m);
    expect(out).toMatch(
      /^ {2}cache {9}[█░]{24} {2}warm 4:00 {2}next ~\$0\.01 {2}if cold ~\$0\.26$/m,
    );
    expect(out).toMatch(/^ {2}context {7}[█░]{24} {2}52k \/ 200k {2}aim < 150k {2}✔$/m);
    // blocks are spaced when the frame fits
    expect(out).toContain("\n\n  where it went\n");
  });

  it("agents, web search, unpriced turns, events, cold cache, 1M context", () => {
    const s = session("aaaa1111", [
      [{ timestamp: iso(-40 * 60_000), cacheRead: 0, cacheWrite5m: 300_000 }],
      [{ timestamp: iso(-20 * 60_000), cacheRead: 0, cacheWrite5m: 300_000, webSearches: 3 }],
      [{ model: "claude-sonnet-5-5" }, "subagent:Explore", "a1"],
      [{}, "subagent", "a2"],
      [{ model: "claude-future-9" }, "subagent:Explore", "a1"],
    ]);
    addSessionCompaction(s, {
      sessionId: "s",
      timestamp: iso(-30 * 60_000),
      trigger: "auto",
      preTokens: 1,
      postTokens: 1,
    });
    const out = text(frame({ sessions: [s] }));
    expect(out).toMatch(/^ {2}web search {4}[█░]{24} +\$0\.03 +1%$/m);
    expect(out).toMatch(/^ +\+1 turns on a model with no price$/m);
    expect(out).toMatch(/^ {2}agents · 2 subagent\(s\) started$/m);
    expect(out).toMatch(/^ {2}main {10}[█░]{24}/m);
    expect(out).toMatch(/^ {2}subagent {6}[█░]{24} +\$0\.04/m);
    expect(out).toMatch(/^ {2}Explore {7}[█░]{24} +\$0\.02/m);
    expect(out).toMatch(/^ {2}events {8}1 cold re-write\(s\) \$\d\.\d\d · 1 compaction\(s\)$/m);
    expect(out).toMatch(/^ {2}cache {9}cold {2}next prompt re-writes ~\$/m);
    expect(out).toContain("301k / 1.0M");
  });

  it("only compactions; an all-unpriced session has no models, work or cache rows", () => {
    const s = session("aaaa1111", [[{ model: "claude-future-9" }]]);
    addSessionCompaction(s, {
      sessionId: "s",
      timestamp: iso(-1),
      trigger: "auto",
      preTokens: 1,
      postTokens: 1,
    });
    const out = text(frame({ sessions: [s] }));
    expect(out).toMatch(/^ {2}events {8}1 compaction\(s\)$/m);
    expect(out).not.toContain("models");
    expect(out).not.toContain("work ·");
    expect(out).not.toContain("CACHE");
  });

  it("only subagent turns: main at $0; only cold re-writes in events", () => {
    const s = session("aaaa1111", [
      [{ timestamp: iso(-20 * 60_000), cacheRead: 0, cacheWrite5m: 300_000 }, "subagent:x", "a"],
      [{ timestamp: iso(-60_000), cacheRead: 0, cacheWrite5m: 300_000 }, "subagent:x", "a"],
    ]);
    const out = text(frame({ sessions: [s] }));
    expect(out).toMatch(/^ {2}main {10}░{24} +\$0\.00 +0%$/m);
    expect(out).toMatch(/^ {2}events {8}1 cold re-write\(s\) \$\d+\.\d\d$/m);
  });

  it("efficiency bands: high and fair", () => {
    const reads = (count: number): SessionModel =>
      session("aaaa1111", [
        [{ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite5m: 0 }],
        ...Array.from({ length: count }, (): [Partial<Turn>] => [
          { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite5m: 0 },
        ]),
      ]);
    expect(text(frame({ sessions: [reads(500)] }))).toContain("$104 per MTok of new work (high)");
    expect(text(frame({ sessions: [reads(200)] }))).toContain("$44 per MTok of new work (fair)");
  });

  it("narrow: short bars, no sparkline, short title; a session with no folder", () => {
    const s = session("aaaa1111", [[{ cwd: "" }]]);
    const out = text(frame({ width: 50, sessions: [s] }));
    expect(out).not.toContain("last 30 min");
    expect(out).not.toContain("q quit");
    expect(out).toMatch(/^ {2}input {9}[█░]{8} /m);
    expect(out).toMatch(/^ {2}▸ aaaa \? +[█░]{8} /m);
    expect(text(frame({ width: 65 }))).toMatch(/last 30 min {3}[▁-█]{15} /);
  });

  it("a short terminal drops the spacing, then cuts", () => {
    const tall = text(frame({ height: 100 }));
    const dense = text(frame({ height: tall.split("\n").length - 1 }));
    expect(dense).not.toContain("\n\n");
    expect(text(frame({ height: 6 })).split("\n")).toHaveLength(6);
  });

  it("no active session", () => {
    expect(text(frame({ sessions: [] }))).toContain("No Claude Code session wrote");
  });

  it("colors when asked", () => {
    expect(text(frame({ color: true }))).toContain("\x1b[38;2;");
    expect(text(frame({ color: true }))).toContain("\x1b[1mSESSIONS\x1b[0m");
  });
});

describe("renderLive: advisor view", () => {
  const advisor = (overrides: Partial<LiveFrame> = {}): string =>
    text(frame({ view: "advisor", ...overrides }));

  it("default view: scorecard and do-now instead of the detail blocks; tab names the other view", () => {
    const deep = session("aaaa1111", [
      [{ timestamp: iso(-60_000), input: 1000, cacheRead: 300_000, cacheWrite5m: 1000 }],
    ]);
    const out = text({ ...frame({ sessions: [deep] }), view: undefined });
    expect(out).toMatch(/q quit · ↑↓ session · tab details$/m);
    expect(out).not.toContain("where it went");
    expect(out).toMatch(/^ADVISOR {3}cache reads cost ~0\.1x input, writes 1\.25x \(1h: 2x\)$/m);
    expect(out).toMatch(/^ {2}cache reads {3}[█░]{24} {3}99% {2}aim ≥ 90% {3}✔$/m);
    expect(out).toMatch(/^ {2}re-reading {4}[█░]{24} +\d+% {2}aim < 54% {3}✖$/m);
    expect(out).toMatch(/^ {2}do now$/m);
    expect(out).toMatch(
      /^ {2}1\. At this pace your limits run out before they reset: 5h in 2\.0 h\.$/m,
    );
    expect(out).toMatch(/^ {2}2\. Context is 302k: .*\n {5}.*~\$6\.04 at stake$/m);
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(out).toMatch(/^ {5}→ /m);
    expect(out).toMatch(/^ {5}why: /m);
    expect(out).toMatch(/context .* 302k \/ 1\.0M {2}aim < 150k {2}✖$/m);
  });

  it("limits at risk come first, with no $; a wrapped first line carries the stake at its end", () => {
    const out = advisor({ width: 60 });
    expect(out).toMatch(/^ {2}1\. At this pace your limits run out before they reset:$/m);
    const narrow = advisor({
      width: 40,
      feed: feed({
        limits: { fiveHour: null, sevenDay: null, usdPerPercentWeek: null, claudeCodeShare: null },
      }),
      sessions: [
        session("aaaa1111", [
          [{ timestamp: iso(-60_000), input: 1000, cacheRead: 300_000, cacheWrite5m: 1000 }],
        ]),
      ],
    });
    expect(narrow).toMatch(/^ {5}.*~\$\d+\.\d\d at stake$/m);
  });

  it("a lean session: nothing to change; fair scores marked ~; no scorecard before a priced turn", () => {
    expect(advisor({ feed: { kind: "missing" } })).toContain(
      "Nothing to change: this session runs lean.",
    );
    const fair = session("aaaa1111", [
      [{ input: 0, output: 0, cacheRead: 100_000, cacheWrite5m: 15_000 }],
    ]);
    expect(advisor({ sessions: [fair], feed: { kind: "missing" } })).toMatch(
      /cache reads .* {3}~$/m,
    );
    const unpriced = session("aaaa1111", [[{ model: "claude-future-9" }]]);
    expect(advisor({ sessions: [unpriced] })).not.toContain("ADVISOR");
  });
});

describe("renderLive: feed", () => {
  it("limits with $ per 1%, rate, runway, verdict; spend; top non-snoozed finding; feed age", () => {
    const out = text(frame());
    expect(out).toMatch(/^LIMITS {3}≈\$2\.00 per 1% of the week$/m);
    expect(out).toMatch(/^ {2}5 hours {7}[█░]{24} {3}40% {2}\+5\.0%\/h · out in 2h00 · at-risk$/m);
    expect(out).toMatch(/^ {2}7 days {8}[█░]{24} {3}40% {2}.* · comfortable$/m);
    expect(out).toMatch(/^SPEND {3}today \$18\.40 · 7 days \$96\.00 · month \$310\.00$/m);
    expect(out).toMatch(
      /^» R1 Subagents on a premium model ~\$12\.40\/week {2}why and fix: cc-daily-usage insights$/m,
    );
    expect(out).toContain("feed 42s old");
  });

  it("typical peak and the last crossing on a line under their window", () => {
    const out = text(
      frame({
        feed: feed({
          limits: {
            fiveHour: window({ typicalPeakPct: 61.6 }),
            sevenDay: window({ verdict: "comfortable", typicalPeakPct: null }),
            usdPerPercentWeek: null,
            claudeCodeShare: null,
            milestones: [
              { window: "sevenDay", threshold: 75, at: iso(-3 * 3600_000), resetsAt: iso(1) },
              { window: "sevenDay", threshold: 90, at: iso(-20 * 60_000), resetsAt: iso(1) },
            ],
          },
        }),
      }),
    );
    expect(out).toMatch(/^LIMITS$/m);
    expect(out).toMatch(/5 hours .*\n +typical peak 62%$/m);
    expect(out).toMatch(/7 days .*\n +crossed 90% 20m ago$/m);
  });

  it("not enough data, stale, no rate, no runway, past reset, no reset time, one window, none", () => {
    const limits = (fiveHour: FeedWindow | null, sevenDay: FeedWindow | null) =>
      text(
        frame({
          feed: feed({
            limits: { fiveHour, sevenDay, usdPerPercentWeek: null, claudeCodeShare: null },
          }),
        }),
      );
    expect(limits(window({ verdict: "insufficient-data" }), window({ verdict: "stale" }))).toMatch(
      /not enough data[\s\S]*reading is old/,
    );
    expect(limits(window({ ratePctPerHour: null, exhaustsAt: null }), null)).toMatch(
      /40% {2}at-risk$/m,
    );
    expect(limits(window({ exhaustsAt: iso(5 * 3600_000) }), null)).toContain("lasts past reset");
    expect(limits(window({ resetsAt: null }), null)).toContain("out in 2h00");
    expect(limits(null, window())).not.toContain("5 hours");
    expect(limits(null, null)).toMatch(/^LIMITS\n +no reading yet/m);
  });

  it("budget plans: today and month bars with pace; no max; zero max and cap; floor; no advice $", () => {
    const budget = (b: Feed["budget"]) =>
      text(
        frame({
          feed: feed({
            budget: b,
            limits: {
              fiveHour: null,
              sevenDay: null,
              usdPerPercentWeek: null,
              claudeCodeShare: null,
            },
            spend: { today: 1, week: 1, monthToDate: 1, last30Days: 1, isFloor: true },
            advice: [finding({ usd: null })],
          }),
        }),
      );
    const out = budget({
      todaySpent: 5,
      todayMax: 10,
      monthSpent: 50,
      monthCap: 200,
      paceLabel: "On pace",
    });
    expect(out).toMatch(/^BUDGET {3}On pace$/m);
    expect(out).toMatch(/^ {2}today {9}█{12}░{12} {2}\$5\.00 of \$10\.00$/m);
    expect(out).toMatch(/^ {2}month {9}█{6}░{18} {2}\$50\.00 of \$200\.00$/m);
    expect(out).not.toContain("LIMITS");
    expect(out).toContain("(floor: unpriced model seen)");
    expect(out).toMatch(/^» R1 Subagents on a premium model {2}why/m);
    const noMax = budget({
      todaySpent: 5,
      todayMax: null,
      monthSpent: 0,
      monthCap: 0,
      paceLabel: null,
    });
    expect(noMax).toMatch(/^BUDGET$/m);
    expect(noMax).toMatch(/^ {2}today {9}\$5\.00 {2}no work day left this month$/m);
    expect(
      budget({ todaySpent: 5, todayMax: 0, monthSpent: 0, monthCap: 0, paceLabel: null }),
    ).toMatch(/today {9}█{24}/);
  });

  it("no advice; missing and newer feeds", () => {
    expect(text(frame({ feed: feed({ advice: [] }) }))).not.toContain("»");
    expect(text(frame({ feed: { kind: "missing" } }))).toContain(
      "no feed.json yet: run cc-daily-usage init",
    );
    const newer = text(frame({ feed: { kind: "newer" } }));
    expect(newer).toContain("feed.json is newer: update cc-daily-usage");
    expect(newer).not.toContain("SPEND");
  });
});
