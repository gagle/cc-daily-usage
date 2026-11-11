import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as LiveModule from "./live-tui.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

function fresh(): Promise<typeof LiveModule> {
  return import("./live-tui.js");
}

const NOW = Date.parse("2026-10-18T10:00:00.000Z");

function line(id: string, minutesAgo: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "assistant",
    requestId: `r-${id}`,
    sessionId: "s1",
    timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
    cwd: "/work/app",
    message: {
      id: `m-${id}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: 1000, output_tokens: 1000 },
    },
    ...extra,
  })}\n`;
}

let root: string;
let mainFile: string;

beforeEach(() => {
  vi.resetModules();
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccdu-live-"));
  root = path.join(fakeHome, ".claude", "projects");
  mkdirSync(path.join(root, "proj", "s1", "subagents"), { recursive: true });
  mainFile = path.join(root, "proj", "s1.jsonl");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

const touch = (file: string, ms: number): void => {
  utimesSync(file, ms / 1000, ms / 1000);
};

describe("discover + readNew", () => {
  it("tails active files only, main and subagent, into one session", async () => {
    const { activeSessions, discover, newLiveState, poll } = await fresh();
    writeFileSync(mainFile, line("a", 1));
    const agent = path.join(root, "proj", "s1", "subagents", "agent-x.jsonl");
    writeFileSync(agent, line("b", 1));
    writeFileSync(
      agent.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentType: "Explore" }),
    );
    const old = path.join(root, "proj", "old.jsonl");
    writeFileSync(old, line("c", 120, { sessionId: "old" }));
    touch(mainFile, NOW);
    touch(agent, NOW);
    touch(old, NOW - 60 * 60_000);

    const state = newLiveState(root);
    discover(state, NOW);
    expect([...state.tails.keys()].sort()).toEqual([agent, mainFile].sort());
    poll(state, NOW, false);
    const [s1] = activeSessions(state, NOW);
    expect(s1?.turns).toBe(2);
    expect(Object.keys(s1?.byScope ?? {}).sort()).toEqual(["main", "subagent:Explore"]);

    discover(state, NOW); // known files are not reset
    expect(state.tails.get(mainFile)?.offset).toBeGreaterThan(0);
  });

  it("keeps a partial last line for the next read; reads compactions; ignores other lines", async () => {
    const { activeSessions, newLiveState, poll } = await fresh();
    const full = line("a", 1);
    writeFileSync(mainFile, full.slice(0, 20));
    touch(mainFile, NOW);
    const state = newLiveState(root);
    poll(state, NOW, true);
    expect(activeSessions(state, NOW)).toEqual([]);
    appendFileSync(mainFile, full.slice(20));
    appendFileSync(
      mainFile,
      `${JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: "s1", timestamp: new Date(NOW).toISOString() })}\n{"type":"user"}\n`,
    );
    poll(state, NOW, false);
    const [s1] = activeSessions(state, NOW);
    expect(s1?.turns).toBe(1);
    expect(s1?.marks).toEqual([{ ms: NOW, kind: "compact" }]);
    poll(state, NOW, false); // nothing new
    expect(activeSessions(state, NOW)[0]?.turns).toBe(1);
  });

  it("a shrunk file is read again from the start (dedupe keeps totals); a deleted one is dropped", async () => {
    const { activeSessions, newLiveState, poll, readNew } = await fresh();
    writeFileSync(mainFile, line("a", 1) + line("b", 1));
    touch(mainFile, NOW);
    const state = newLiveState(root);
    poll(state, NOW, true);
    writeFileSync(mainFile, line("a", 1));
    poll(state, NOW, false);
    expect(activeSessions(state, NOW)[0]?.turns).toBe(2);
    rmSync(mainFile);
    poll(state, NOW, false);
    expect(state.tails.size).toBe(0);
    readNew(state, "/nope"); // untracked: no-op
  });

  it("drops sessions idle past the window and sorts newest first", async () => {
    const { activeSessions, newLiveState, poll } = await fresh();
    writeFileSync(mainFile, line("a", 25) + line("z", 5, { sessionId: "s2" }));
    touch(mainFile, NOW);
    const state = newLiveState(root);
    poll(state, NOW, true);
    expect(activeSessions(state, NOW).map((s) => s.sessionId)).toEqual(["s2", "s1"]);
    expect(activeSessions(state, NOW + 10 * 60_000).map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it("the default root is ~/.claude/projects", async () => {
    const { newLiveState } = await fresh();
    expect(newLiveState().root).toBe(root);
  });

  it("a file whose stat fails (dangling link) is skipped", async () => {
    const { discover, newLiveState } = await fresh();
    symlinkSync(path.join(fakeHome, "gone"), path.join(root, "proj", "dead.jsonl"));
    const state = newLiveState(root);
    discover(state, NOW);
    expect(state.tails.size).toBe(0);
  });
});

describe("readFeedState", () => {
  it("missing, then ok", async () => {
    const { readFeedState } = await fresh();
    expect(readFeedState("a")).toEqual({ kind: "missing" });
    const dir = path.join(fakeHome, ".config", "cc-daily-usage", "accounts", "a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "feed.json"), '{"schemaVersion":1}');
    expect(readFeedState("a").kind).toBe("ok");
  });
});

describe("keys and args", () => {
  it("liveKey", async () => {
    const { liveKey } = await fresh();
    expect(["q", "Q", "\x03", "\x1b"].map(liveKey)).toEqual(["quit", "quit", "quit", "quit"]);
    expect(["\x1b[A", "k", "\x1b[B", "j", "\t", "x"].map(liveKey)).toEqual([
      "up",
      "up",
      "down",
      "down",
      "view",
      null,
    ]);
  });

  it("parseLiveArgs", async () => {
    const { parseLiveArgs } = await fresh();
    expect(parseLiveArgs([])).toEqual({ once: false });
    expect(parseLiveArgs(["--once"])).toEqual({ once: true });
    expect(parseLiveArgs(["--x"])).toBe("Unknown live argument: --x");
  });
});
