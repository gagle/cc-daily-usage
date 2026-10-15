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
  const dir = path.join(fakeHome, ".config", "cc-daily-usage", "accounts", key);
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
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccdu-index-"));
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
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
