import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as IndexModule from "./transcript-index.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

function fresh(): Promise<typeof IndexModule> {
  return import("./transcript-index.js");
}

const NOW = new Date("2026-10-07T12:00:00.000Z");

function line(
  requestId: string,
  overrides: Record<string, unknown> = {},
  usage: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    type: "assistant",
    requestId,
    sessionId: "s1",
    timestamp: "2026-10-07T10:00:00.000Z",
    cwd: "/work/app",
    gitBranch: "main",
    message: {
      id: `msg_${requestId}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: 1_000_000, output_tokens: 0, ...usage },
    },
    ...overrides,
  })}\n`;
}

function projectDir(): string {
  const dir = path.join(fakeHome, ".claude", "projects", "-work-app");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionsMap(key: string, ids: ReadonlyArray<string>): void {
  const dir = path.join(fakeHome, ".config", "cc-spend", "accounts", key);
  mkdirSync(dir, { recursive: true });
  const entry = {
    transcriptPath: null,
    firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    costUsd: 0,
    linesAdded: 0,
    linesRemoved: 0,
  };
  writeFileSync(
    path.join(dir, "sessions-map.json"),
    JSON.stringify({
      schemaVersion: 1,
      sessions: Object.fromEntries(ids.map((id) => [id, entry])),
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccs-index-"));
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("missingPart", () => {
  it("exact counts; main $ at the old row's own rates; other $ by difference; no max", async () => {
    const { missingPart } = await fresh();
    const { emptyRollup } = await import("./transcript-parse.js");
    const old = {
      ...emptyRollup(),
      turns: 3,
      input: 300,
      usdInput: 30, // $0.10 per token
      output: 100,
      usdOutput: 10,
      thinking: 50,
      usdThinking: 5,
      usdThinkingHigh: 2,
      cacheRead: 0,
      usdCacheRead: 0,
      usdCarry: 9,
      maxContext: 900,
    };
    const rebuilt = {
      ...emptyRollup(),
      turns: 2,
      input: 200,
      usdInput: 5, // new, lower price
      output: 100,
      usdOutput: 10,
      thinking: 25,
      usdThinking: 2.5,
      usdCarry: 10,
      maxContext: 800,
    };
    expect(missingPart(old, rebuilt)).toMatchObject({
      turns: 1,
      input: 100,
      usdInput: 10, // 100 tokens × $0.10, not $30 − $5
      output: 0,
      usdOutput: 0,
      thinking: 25,
      usdThinking: 2.5,
      usdThinkingHigh: 1,
      usdCacheRead: 0,
      usdCarry: 0,
      maxContext: 0,
    });
    expect(missingPart({ ...old, usdThinking: 0 }, rebuilt).usdThinkingHigh).toBe(0);
  });
});

describe("listTranscripts / scopeOf", () => {
  it("finds session files and subagent files; a missing root is empty", async () => {
    const { listTranscripts, scopeOf } = await fresh();
    expect(listTranscripts()).toEqual([]);
    const dir = projectDir();
    writeFileSync(path.join(dir, "s1.jsonl"), "");
    writeFileSync(path.join(dir, "notes.txt"), "");
    const agents = path.join(dir, "s1", "subagents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(path.join(agents, "agent-a.jsonl"), "");
    writeFileSync(path.join(agents, "agent-a.meta.json"), JSON.stringify({ agentType: "Explore" }));
    writeFileSync(path.join(agents, "agent-b.jsonl"), "");
    writeFileSync(path.join(agents, "agent-c.jsonl"), "");
    writeFileSync(path.join(agents, "agent-c.meta.json"), "{}");
    writeFileSync(path.join(agents, "other.jsonl"), "");
    const files = listTranscripts();
    expect(files.map((file) => path.basename(file)).sort()).toEqual([
      "agent-a.jsonl",
      "agent-b.jsonl",
      "agent-c.jsonl",
      "s1.jsonl",
    ]);
    expect(scopeOf(path.join(dir, "s1.jsonl"))).toBe("main");
    expect(scopeOf(path.join(agents, "agent-a.jsonl"))).toBe("subagent:Explore");
    expect(scopeOf(path.join(agents, "agent-b.jsonl"))).toBe("subagent");
    expect(scopeOf(path.join(agents, "agent-c.jsonl"))).toBe("subagent");
  });
});

describe("runIndexPass", () => {
  it("rolls up main + subagent turns, dedupes repeats, waits on a partial line, resumes", async () => {
    sessionsMap("acct", ["s1"]);
    const dir = projectDir();
    const main = path.join(dir, "s1.jsonl");
    const repeated = line("r1");
    writeFileSync(
      main,
      repeated +
        repeated + // one line per content block: counted once
        JSON.stringify({ type: "user" }) +
        "\n" +
        line("r2", {
          message: { id: "m2", model: "claude-future-9", usage: { input_tokens: 10 } },
        }) +
        line("r3", { timestamp: "bad" }) +
        line("r4", {}, { speed: "fast" }).slice(0, 40), // partial: not read yet
    );
    const agents = path.join(dir, "s1", "subagents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(path.join(agents, "agent-a.meta.json"), JSON.stringify({ agentType: "Explore" }));
    writeFileSync(
      path.join(agents, "agent-a.jsonl"),
      line("r9", {}, { cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }),
    );
    const { runIndexPass, loadRollups, loadSessionTotals, lastPass, INDEX_DIR } = await fresh();
    expect(lastPass()).toBeNull();

    expect(runIndexPass({ now: NOW })).toMatchObject({ filesRead: 2, bytesBehind: 0, turns: 3 });
    const rows = loadRollups("acct", ["2026-10"]);
    const byKey = Object.fromEntries(
      [...rows].map(([key, row]) => [key.split("\t").slice(2).join("|"), row]),
    );
    expect(byKey["claude-opus-5-5|main|standard"]).toMatchObject({ turns: 1, usdInput: 4 });
    expect(byKey["claude-future-9|main|standard"]).toMatchObject({ turns: 1, unpricedTurns: 1 });
    expect(byKey["claude-opus-5-5|subagent:Explore|standard"]).toMatchObject({
      turns: 1,
      usdCacheWrite: 8,
    });
    expect(loadSessionTotals("acct").s1).toMatchObject({
      turns: 3,
      usd: 16,
      unpricedTurns: 1,
      subagentUsd: 12,
      project: "/work/app",
      branch: "main",
      models: ["claude-future-9", "claude-opus-5-5"],
    });

    // Second pass with nothing new reads 0 bytes.
    expect(runIndexPass({ now: NOW })).toMatchObject({ filesRead: 0, bytesRead: 0 });

    // The partial line completes, plus a repeat of a line already counted.
    appendFileSync(
      main,
      line("r4", {}, { speed: "fast" }).slice(40) + line("r4", {}, { speed: "fast" }),
    );
    expect(runIndexPass({ now: NOW })).toMatchObject({ filesRead: 1, turns: 1 });
    const after = loadRollups("acct", ["2026-10"]);
    expect([...after.keys()].some((key) => key.endsWith("\tfast"))).toBe(true);
    expect(loadSessionTotals("acct").s1).toMatchObject({ turns: 4, usd: 24 });
    expect(lastPass()).toMatchObject({ at: NOW.toISOString(), bytesBehind: 0 });
    expect(existsSync(path.join(INDEX_DIR, "index.lock"))).toBe(false);
  });

  it("an unknown session goes to unattributed; a rewritten file is read again", async () => {
    const main = path.join(projectDir(), "s2.jsonl");
    // A line with no newline yet: nothing to read; then 70 distinct turns (past the dedupe memory).
    writeFileSync(main, line("a", { sessionId: "s2" }).trimEnd());
    const { runIndexPass, loadSessionTotals, UNATTRIBUTED } = await fresh();
    expect(runIndexPass()).toMatchObject({ turns: 0 });
    writeFileSync(
      main,
      line("a", { sessionId: "s2" }) + line("b", { sessionId: "s2", gitBranch: "" }),
    );
    runIndexPass({ now: NOW });
    expect(loadSessionTotals(UNATTRIBUTED).s2?.branch).toBe("");
    expect(loadSessionTotals(UNATTRIBUTED).s2?.turns).toBe(2);
    writeFileSync(main, line("c", { sessionId: "s2", timestamp: "2026-10-07T09:00:00.000Z" }));
    runIndexPass({ now: NOW });
    expect(loadSessionTotals(UNATTRIBUTED).s2).toMatchObject({
      turns: 3,
      branch: "main",
      firstAt: "2026-10-07T10:00:00.000Z",
      lastAt: "2026-10-07T10:00:00.000Z",
    });
  });

  it("a session a /login moved is split by the login at each turn's time", async () => {
    const root = path.join(fakeHome, ".config", "cc-spend");
    const known = (key: string, lastSeenAt: string): void => {
      mkdirSync(path.join(root, "accounts", key), { recursive: true });
      writeFileSync(
        path.join(root, "accounts", key, "sessions-map.json"),
        JSON.stringify({ schemaVersion: 1, sessions: { s1: { lastSeenAt } } }),
      );
    };
    known("pro", "2026-10-07T09:00:00.000Z");
    known("ent", "2026-10-07T11:00:00.000Z");
    const t = (hhmm: string): number => Date.parse(`2026-10-07T${hhmm}:00.000Z`);
    writeFileSync(
      path.join(root, "account-log.json"),
      JSON.stringify({
        schemaVersion: 1,
        switches: [
          { t: t("08:00"), key: "pro" },
          { t: t("09:30"), key: "ent" },
          { t: t("10:30"), key: "other" },
        ],
      }),
    );
    const at = (hhmm: string) => ({ timestamp: `2026-10-07T${hhmm}:00.000Z` });
    writeFileSync(
      path.join(projectDir(), "s1.jsonl"),
      line("a", at("09:00")) + // pro's login
        line("b", at("10:00")) + // ent's login
        line("c", at("07:00")) + // before the log: the last account to see it
        line("d", at("10:45")) + // a login that never saw the session: the same
        `${JSON.stringify({ type: "system", sessionId: "s1", subtype: "turn_duration", durationMs: 5 })}\n`,
    );
    const { runIndexPass, loadSessionTotals } = await fresh();
    runIndexPass({ now: NOW });
    expect(loadSessionTotals("pro").s1).toMatchObject({ turns: 1, turnMs: 0 });
    expect(loadSessionTotals("ent").s1).toMatchObject({ turns: 3, turnMs: 5 });
  });

  it("adds turn time, thinking time, hook runs and entrypoint; system lines alone never start a session", async () => {
    sessionsMap("acct", ["s1"]);
    const file = path.join(projectDir(), "s1.jsonl");
    const system = (fields: Record<string, unknown>): string =>
      `${JSON.stringify({ type: "system", sessionId: "s1", ...fields })}\n`;
    writeFileSync(
      file,
      line("a", { thinkingDurationMs: 1500, entrypoint: "cli" }) +
        line("a", { thinkingDurationMs: 1500 }) + // a repeat of the same message: counted once
        system({ subtype: "turn_duration", durationMs: 30_000 }) +
        system({ subtype: "stop_hook_summary", hookCount: 4 }) +
        system({ sessionId: "nobody", subtype: "turn_duration", durationMs: 9 }),
    );
    const { runIndexPass, loadSessionTotals, UNATTRIBUTED } = await fresh();
    runIndexPass({ now: NOW });
    expect(loadSessionTotals("acct").s1).toMatchObject({
      turnMs: 30_000,
      thinkingMs: 1500,
      hookRuns: 4,
      entrypoint: "cli",
    });
    expect(loadSessionTotals(UNATTRIBUTED).nobody).toBeUndefined();
    writeFileSync(file, system({ subtype: "turn_duration", durationMs: 10_000 }), { flag: "a" });
    runIndexPass({ now: NOW });
    expect(loadSessionTotals("acct").s1).toMatchObject({ turnMs: 40_000, turns: 1 });
  });

  it("keeps Claude Code's own cost per run: the larger reading of a run wins, across passes", async () => {
    sessionsMap("acct", ["s1"]);
    const file = path.join(projectDir(), "s1.jsonl");
    const state = (startTime: number, totalCostUSD: number): string =>
      `${JSON.stringify({
        type: "cost-state",
        sessionId: "s1",
        startTime,
        totalCostUSD,
        modelUsage: { "claude-opus-5-5": { inputTokens: 10, costUSD: totalCostUSD } },
      })}\n`;
    writeFileSync(file, line("a") + state(100, 2) + state(100, 1.5) + state(200, 0.5));
    const { runIndexPass, loadSessionTotals } = await fresh();
    runIndexPass({ now: NOW });
    const runs = loadSessionTotals("acct").s1?.ccRuns;
    expect(runs?.["100"]?.usd).toBe(2);
    expect(runs?.["200"]?.models["claude-opus-5-5"]).toMatchObject({ input: 10, usd: 0.5 });
    writeFileSync(file, state(100, 1) + state(200, 3), { flag: "a" });
    runIndexPass({ now: NOW });
    const after = loadSessionTotals("acct").s1?.ccRuns;
    expect([after?.["100"]?.usd, after?.["200"]?.usd]).toEqual([2, 3]);
    // A pass with no cost-state line keeps the runs.
    writeFileSync(file, line("b"), { flag: "a" });
    runIndexPass({ now: NOW });
    expect(loadSessionTotals("acct").s1?.ccRuns?.["200"]?.usd).toBe(3);
  });

  it("efficiency split: known context per thread, kept across passes; a legacy offset skips one turn", async () => {
    sessionsMap("acct", ["s1"]);
    const main = path.join(projectDir(), "s1.jsonl");
    writeFileSync(main, line("e1", {}, { input_tokens: 1000, output_tokens: 100 }));
    const { runIndexPass, loadRollups, INDEX_DIR } = await fresh();
    runIndexPass({ now: NOW });
    const row = (): Record<string, number> =>
      [...loadRollups("acct", ["2026-10"]).values()][0] as unknown as Record<string, number>;
    expect(row()).toMatchObject({ growth: 1100, freshSplit: 1000, rewriteTokens: 0 });
    appendFileSync(main, line("e2", {}, { input_tokens: 1000, output_tokens: 0 }));
    runIndexPass({ now: NOW });
    // second turn: same 1000-token context sent again → a rewrite, no growth
    expect(row()).toMatchObject({ growth: 1100, freshSplit: 2000, rewriteTokens: 1000 });

    // An offsets file from before `context` was kept: the next turn has no split.
    const offsetsFile = path.join(INDEX_DIR, "offsets.json");
    const offsets = JSON.parse(readFileSync(offsetsFile, "utf8")) as {
      files: Record<string, { context?: number }>;
    };
    delete (offsets.files[main] as { context?: number }).context;
    writeFileSync(offsetsFile, JSON.stringify(offsets));
    appendFileSync(main, `${JSON.stringify({ type: "user" })}\n`); // no turn: context stays unknown
    runIndexPass({ now: NOW });
    appendFileSync(main, line("e3", {}, { input_tokens: 5000 }));
    runIndexPass({ now: NOW });
    expect(row()).toMatchObject({ freshSplit: 2000, turns: 3 });
  });

  it("records MCP servers loaded (instructions size) and called, per session", async () => {
    sessionsMap("acct", ["s1"]);
    const delta = (names: Array<unknown>, blocks: Array<unknown>): string =>
      `${JSON.stringify({
        type: "attachment",
        sessionId: "s1",
        attachment: { type: "mcp_instructions_delta", addedNames: names, addedBlocks: blocks },
      })}\n`;
    const call = (id: string, tool: string): string =>
      line(id, {
        message: {
          id: `m-${id}`,
          model: "claude-opus-5-5",
          usage: { input_tokens: 1 },
          content: [{ type: "tool_use", name: tool }],
        },
      });
    const main = path.join(projectDir(), "s1.jsonl");
    writeFileSync(
      main,
      delta(["plugin:figma:figma", "tokensave"], ["x".repeat(400), "y".repeat(40)]) +
        call("c1", "mcp__tokensave__tokensave_context") +
        call("c1", "mcp__zvec_grep__search"), // second copy of the same turn: still read for the call
    );
    const { runIndexPass, loadSessionTotals } = await fresh();
    runIndexPass({ now: NOW });
    expect(loadSessionTotals("acct").s1).toMatchObject({
      turns: 1,
      mcpLoaded: { plugin_figma_figma: 100, tokensave: 10 },
      mcpUsed: ["tokensave", "zvec_grep"],
    });
    appendFileSync(main, delta(["tokensave"], ["y".repeat(8)]));
    runIndexPass({ now: NOW });
    expect(loadSessionTotals("acct").s1?.mcpLoaded).toEqual({
      plugin_figma_figma: 100,
      tokensave: 10,
    });
  });

  it("rows indexed before a rollup field existed read it as 0", async () => {
    const { loadRollups, ownerIndexDir } = await fresh();
    mkdirSync(ownerIndexDir("acct"), { recursive: true });
    writeFileSync(
      path.join(ownerIndexDir("acct"), "2026-10.json"),
      JSON.stringify({ schemaVersion: 1, rows: { k: { turns: 2 } } }),
    );
    expect(loadRollups("acct", ["2026-10"]).get("k")).toMatchObject({
      turns: 2,
      growth: 0,
      usdRewrite: 0,
    });
  });

  it("remembers only the newest dedupe keys", async () => {
    const main = path.join(projectDir(), "s3.jsonl");
    writeFileSync(main, Array.from({ length: 70 }, (_, i) => line(`k${String(i)}`)).join(""));
    const { runIndexPass, INDEX_DIR } = await fresh();
    expect(runIndexPass({ now: NOW })?.turns).toBe(70);
    const offsets = JSON.parse(readFileSync(path.join(INDEX_DIR, "offsets.json"), "utf8")) as {
      files: Record<string, { recent: Array<string> }>;
    };
    expect(offsets.files[main]?.recent).toHaveLength(64);
  });

  it("budget: files past the byte budget wait for the next pass; catch-up reads all", async () => {
    const dir = projectDir();
    const big = "x".repeat(9 * 1024 * 1024);
    writeFileSync(path.join(dir, "a.jsonl"), `${big}\n${line("a")}`);
    writeFileSync(path.join(dir, "b.jsonl"), line("b"));
    const { runIndexPass, catchUp, lastPass } = await fresh();
    const first = runIndexPass({ now: NOW });
    expect(first?.filesRead).toBe(1);
    expect(first?.bytesBehind).toBeGreaterThan(0);
    expect(lastPass()?.bytesBehind).toBe(first?.bytesBehind);
    expect(catchUp({ now: NOW })).toBe(true);
    expect(runIndexPass({ now: NOW })?.bytesRead).toBe(0);
  });

  it("a live lock blocks a second pass; a stale one is taken over; unreadable files are skipped", async () => {
    const { runIndexPass, catchUp, INDEX_DIR } = await fresh();
    mkdirSync(INDEX_DIR, { recursive: true });
    const lock = path.join(INDEX_DIR, "index.lock");
    writeFileSync(lock, "1");
    expect(runIndexPass({ now: NOW })).toBeNull();
    expect(catchUp({ now: NOW })).toBe(false);
    const old = new Date(Date.now() - 200_000);
    utimesSync(lock, old, old);
    const dir = projectDir();
    const dangling = path.join(dir, "gone.jsonl");
    rmSync(dangling, { force: true });
    // A symlink to nothing lists but cannot be stat'ed.
    const { symlinkSync } = await import("node:fs");
    symlinkSync(path.join(dir, "nowhere"), dangling);
    expect(runIndexPass({ now: NOW })).toMatchObject({ filesRead: 0 });
  });

  it("the lock cannot be written: no pass", async () => {
    const { runIndexPass, INDEX_DIR } = await fresh();
    mkdirSync(path.dirname(INDEX_DIR), { recursive: true });
    writeFileSync(INDEX_DIR, "a file where the folder should be");
    expect(runIndexPass({ now: NOW })).toBeNull();
  });

  it("drops the offset of a transcript Claude Code deleted", async () => {
    const dir = projectDir();
    writeFileSync(path.join(dir, "s1.jsonl"), line("a"));
    writeFileSync(path.join(dir, "s2.jsonl"), line("b", { sessionId: "s2" }));
    const { runIndexPass, INDEX_DIR } = await fresh();
    runIndexPass({ now: NOW });
    rmSync(path.join(dir, "s2.jsonl"));
    runIndexPass({ now: NOW });
    const offsets = JSON.parse(readFileSync(path.join(INDEX_DIR, "offsets.json"), "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(offsets.files)).toEqual([path.join(dir, "s1.jsonl")]);
  });

  it("a price change re-prices the index from transcripts; rows of deleted transcripts are kept", async () => {
    const dir = projectDir();
    const other = path.join(fakeHome, ".claude", "projects", "-work-other");
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(dir, "s1.jsonl"), line("a") + line("b"));
    writeFileSync(path.join(dir, "s2.jsonl"), line("c", { sessionId: "s2" })); // shares s1's row
    writeFileSync(path.join(other, "s3.jsonl"), line("d", { sessionId: "s3", cwd: "/work/other" }));
    const { runIndexPass, loadRollups, loadSessionTotals, UNATTRIBUTED, INDEX_DIR, ownerIndexDir } =
      await fresh();
    expect(runIndexPass({ now: NOW })?.repriced).toBeUndefined(); // first build: nothing to re-price
    const pricesFile = path.join(INDEX_DIR, "prices.json");
    expect(JSON.parse(readFileSync(pricesFile, "utf8"))).toMatchObject({
      prices: { version: expect.any(String) },
    });

    // An index from older prices: s1's rows hold a stale $; s2 and s3 lost their transcripts.
    const month = path.join(ownerIndexDir(UNATTRIBUTED), "2026-10.json");
    const stored = JSON.parse(readFileSync(month, "utf8")) as {
      rows: Record<string, { usdInput: number }>;
    };
    for (const row of Object.values(stored.rows)) row.usdInput = 999;
    writeFileSync(month, JSON.stringify(stored));
    writeFileSync(
      pricesFile,
      JSON.stringify({ schemaVersion: 1, prices: { version: "2026-01-01" } }),
    );
    rmSync(path.join(dir, "s2.jsonl"));
    rmSync(path.join(other, "s3.jsonl"));
    mkdirSync(path.join(INDEX_DIR, "backup-prices-2025-01-01")); // an older re-price's backup

    expect(runIndexPass({ now: NOW })?.repriced).toEqual({
      from: "2026-01-01",
      rowsKept: 1, // s3's row: nothing rebuilt it
      sessionsKept: 2,
      rowsShort: 1, // s1 + s2 shared a row; s2's transcript is gone
    });
    const rows = [...loadRollups(UNATTRIBUTED, ["2026-10"]).values()];
    const shared = rows.find((row) => row.usdInput !== 999);
    // s1 rebuilt at today's price (2 × 1M × $4 = $8) + s2's 1M tokens at the row's stored rate ($999 / 3M).
    expect(shared?.usdInput).toBeCloseTo(8 + 333, 9);
    expect(shared).toMatchObject({ turns: 3, input: 3_000_000 });
    expect(rows.filter((row) => row.usdInput === 999)).toHaveLength(1); // s3's row, kept whole
    expect(Object.keys(loadSessionTotals(UNATTRIBUTED)).sort()).toEqual(["s1", "s2", "s3"]);
    expect(
      existsSync(path.join(INDEX_DIR, "backup-prices-2026-01-01", UNATTRIBUTED, "2026-10.json")),
    ).toBe(true);
    expect(existsSync(path.join(INDEX_DIR, "backup-prices-2025-01-01"))).toBe(false); // superseded
    const offsets = JSON.parse(readFileSync(path.join(INDEX_DIR, "offsets.json"), "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(offsets.files)).toEqual([path.join(dir, "s1.jsonl")]); // gone transcripts pruned
    expect(runIndexPass({ now: NOW })?.repriced).toBeUndefined(); // once

    // A newer build's prices are never re-priced down; an index with no prices file is ("none").
    writeFileSync(
      pricesFile,
      JSON.stringify({ schemaVersion: 1, prices: { version: "2999-01-01" } }),
    );
    appendFileSync(path.join(dir, "s1.jsonl"), line("f"));
    expect(runIndexPass({ now: NOW })?.repriced).toBeUndefined();
    rmSync(pricesFile);
    appendFileSync(path.join(dir, "s1.jsonl"), line("g"));
    expect(runIndexPass({ now: NOW })?.repriced?.from).toBe("none");
  });

  it("a re-price covers account indexes too, with no unattributed index", async () => {
    sessionsMap("acct", ["s1"]);
    writeFileSync(path.join(projectDir(), "s1.jsonl"), line("a"));
    mkdirSync(path.join(fakeHome, ".config", "cc-spend", "accounts", "empty"), {
      recursive: true,
    });
    const { runIndexPass, INDEX_DIR, loadSessionTotals } = await fresh();
    runIndexPass({ now: NOW });
    writeFileSync(
      path.join(INDEX_DIR, "prices.json"),
      JSON.stringify({ schemaVersion: 1, prices: { version: "2026-01-01" } }),
    );
    expect(runIndexPass({ now: NOW })?.repriced).toEqual({
      from: "2026-01-01",
      rowsKept: 0,
      sessionsKept: 0,
      rowsShort: 0,
    });
    expect(loadSessionTotals("acct").s1?.turns).toBe(1);
    expect(
      existsSync(path.join(INDEX_DIR, "backup-prices-2026-01-01", "acct", "sessions.json")),
    ).toBe(true);
  });

  it("a re-price that crashed restarts from its backup, not from the half-built index", async () => {
    writeFileSync(path.join(projectDir(), "s1.jsonl"), line("a"));
    const { runIndexPass, loadSessionTotals, UNATTRIBUTED, INDEX_DIR, ownerIndexDir } =
      await fresh();
    runIndexPass({ now: NOW });
    const backup = path.join(INDEX_DIR, "backup-prices-2026-01-01", UNATTRIBUTED);
    mkdirSync(backup, { recursive: true });
    writeFileSync(
      path.join(backup, "sessions.json"),
      JSON.stringify({ schemaVersion: 1, sessions: { gone: { usd: 7, turns: 1 } } }),
    );
    writeFileSync(path.join(backup, "notes.txt"), "not a month file");
    writeFileSync(
      path.join(INDEX_DIR, "prices.json"),
      JSON.stringify({ schemaVersion: 1, prices: { version: "2026-01-01" } }),
    );
    rmSync(ownerIndexDir(UNATTRIBUTED), { recursive: true }); // the crash emptied the live index
    expect(runIndexPass({ now: NOW })?.repriced).toMatchObject({ sessionsKept: 1, rowsKept: 0 });
    expect(Object.keys(loadSessionTotals(UNATTRIBUTED)).sort()).toEqual(["gone", "s1"]);
  });

  it("a newer index file is ignored and not overwritten", async () => {
    sessionsMap("acct", ["s1"]);
    writeFileSync(path.join(projectDir(), "s1.jsonl"), line("a"));
    const { runIndexPass, ownerIndexDir, loadRollups } = await fresh();
    const file = path.join(ownerIndexDir("acct"), "2026-10.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const newer = JSON.stringify({ schemaVersion: 2, rows: {} });
    writeFileSync(file, newer);
    runIndexPass({ now: NOW });
    expect(readFileSync(file, "utf8")).toBe(newer);
    expect(loadRollups("acct", ["2026-10"]).size).toBe(0);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, rows: null }));
    expect(loadRollups("acct", ["2026-10"]).size).toBe(0);
  });
});
