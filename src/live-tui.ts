import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

import { accountKey, resolveActiveAccount } from "./account.js";
import { feedFile } from "./config.js";
import { type FeedState, type LiveView, parseFeed, renderLive } from "./live-render.js";
import { requestApiRefresh, writeFeed } from "./refresh.js";
import {
  addSessionCompaction,
  addSessionTurn,
  newSession,
  type SessionModel,
} from "./session-model.js";
import { listTranscripts, projectsDir, scopeOf } from "./transcript-index.js";
import { parseCompaction, parseTurn } from "./transcript-parse.js";

/** A transcript written in this window counts as active. */
export const ACTIVE_MS = 30 * 60 * 1000;
const TICK_MS = 1000;
const DISCOVER_EVERY = 5; // ticks

interface Tail {
  offset: number;
  partial: Buffer;
  readonly scope: string;
}

/** Everything `live` has read so far. Offsets live in memory only: `live` never writes a file. */
export interface LiveState {
  readonly root: string;
  readonly tails: Map<string, Tail>;
  readonly sessions: Map<string, SessionModel>;
}

export function newLiveState(root: string = projectsDir()): LiveState {
  return { root, tails: new Map(), sessions: new Map() };
}

function mtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Starts tailing transcripts written in the last ACTIVE_MS. A new file is read from its start, so a session
 * that began before `live` shows its full cost.
 * # ponytail: walks every project folder per call (a few hundred files); upgrade with fs.watch on the root.
 */
export function discover(state: LiveState, nowMs: number): void {
  for (const file of listTranscripts(state.root)) {
    if (state.tails.has(file)) continue;
    const mtime = mtimeMs(file);
    if (mtime === null || nowMs - mtime > ACTIVE_MS) continue;
    state.tails.set(file, { offset: 0, partial: Buffer.alloc(0), scope: scopeOf(file) });
  }
}

function sessionFor(state: LiveState, id: string): SessionModel {
  let session = state.sessions.get(id);
  if (session === undefined) {
    session = newSession(id);
    state.sessions.set(id, session);
  }
  return session;
}

/** Feeds the complete lines written since the last read; keeps a trailing partial line for the next one. A file
 * that shrank was rewritten: read it again from the start (the turn-key dedupe drops the repeats). */
export function readNew(state: LiveState, file: string): void {
  const tail = state.tails.get(file);
  if (tail === undefined) return;
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    state.tails.delete(file);
    return;
  }
  if (size < tail.offset) {
    tail.offset = 0;
    tail.partial = Buffer.alloc(0);
  }
  if (size === tail.offset) return;
  const chunk = Buffer.alloc(size - tail.offset);
  const fd = openSync(file, "r");
  try {
    readSync(fd, chunk, 0, chunk.length, tail.offset);
  } finally {
    closeSync(fd);
  }
  tail.offset = size;
  const data = Buffer.concat([tail.partial, chunk]);
  const end = data.lastIndexOf(0x0a);
  tail.partial = Buffer.from(data.subarray(end + 1));
  if (end === -1) return;
  for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
    const turn = parseTurn(line);
    if (turn !== null) {
      addSessionTurn(sessionFor(state, turn.sessionId), turn, tail.scope, file);
      continue;
    }
    const compaction = parseCompaction(line);
    if (compaction !== null)
      addSessionCompaction(sessionFor(state, compaction.sessionId), compaction);
  }
}

export function poll(state: LiveState, nowMs: number, rediscover: boolean): void {
  if (rediscover) discover(state, nowMs);
  for (const file of [...state.tails.keys()]) readNew(state, file);
}

/** Sessions with a turn in the last ACTIVE_MS, newest first. */
export function activeSessions(state: LiveState, nowMs: number): ReadonlyArray<SessionModel> {
  return [...state.sessions.values()]
    .filter((session) => session.turns > 0 && nowMs - session.lastMs <= ACTIVE_MS)
    .sort((a, b) => b.lastMs - a.lastMs);
}

export function readFeedState(key: string): FeedState {
  try {
    return parseFeed(readFileSync(feedFile(key), "utf8"));
  } catch {
    return parseFeed(null);
  }
}

export type LiveKey = "quit" | "up" | "down" | "view" | null;

export function liveKey(data: string): LiveKey {
  if (data === "q" || data === "Q" || data === "\x03" || data === "\x1b") return "quit";
  if (data === "\x1b[A" || data === "k") return "up";
  if (data === "\x1b[B" || data === "j") return "down";
  if (data === "\t") return "view";
  return null;
}

export interface LiveArgs {
  readonly once: boolean;
}

export function parseLiveArgs(argv: ReadonlyArray<string>): LiveArgs | string {
  let once = false;
  for (const arg of argv) {
    if (arg === "--once") once = true;
    else return `Unknown live argument: ${arg}`;
  }
  return { once };
}

/**
 * `cc-spend live`: a full-screen meter of every active session, redrawn each second. Read-only: no file
 * written apart from the feed refresh the statusline already does; no network on this process. Not covered by
 * unit tests (a TTY loop); the pieces above carry the logic.
 */
/* v8 ignore start */
export async function runLive(args: LiveArgs): Promise<number> {
  const key = accountKey(await resolveActiveAccount());
  const color = process.stdout.isTTY && process.env.NO_COLOR === undefined;
  await writeFeed(key, new Date());
  const state = newLiveState();
  poll(state, Date.now(), true);
  let feed = readFeedState(key);
  let feedMtime = mtimeMs(feedFile(key));
  let selected = 0;
  let view: LiveView = "advisor";

  const frame = (): ReadonlyArray<string> => {
    const sessions = activeSessions(state, Date.now());
    selected = Math.min(selected, Math.max(0, sessions.length - 1));
    return renderLive({
      sessions,
      selected,
      feed,
      nowMs: Date.now(),
      width: process.stdout.columns || 80,
      ...(args.once || !process.stdout.isTTY ? {} : { height: process.stdout.rows || 40 }),
      color,
      view,
    });
  };

  if (args.once || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${frame().join("\n")}\n`);
    return 0;
  }

  const draw = (): void => {
    const lines = frame().map((line) => `${line}\x1b[K`);
    process.stdout.write(`\x1b[H${lines.join("\n")}\x1b[J`);
  };
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  draw();

  return new Promise<number>((resolve) => {
    let tick = 0;
    const finish = (): void => {
      clearInterval(timer);
      process.stdin.off("data", onData);
      process.stdout.off("resize", draw);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      resolve(0);
    };
    const onData = (data: Buffer): void => {
      const pressed = liveKey(data.toString("utf8"));
      if (pressed === "quit") {
        finish();
        return;
      }
      if (pressed === "up") selected = Math.max(0, selected - 1);
      if (pressed === "down") selected += 1;
      if (pressed === "view") view = view === "advisor" ? "details" : "advisor";
      draw();
    };
    const timer = setInterval(() => {
      tick += 1;
      const now = new Date();
      poll(state, now.getTime(), tick % DISCOVER_EVERY === 0);
      requestApiRefresh(key, now);
      const mtime = mtimeMs(feedFile(key));
      if (mtime !== feedMtime) {
        feedMtime = mtime;
        feed = readFeedState(key);
      }
      draw();
    }, TICK_MS);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdout.on("resize", draw);
  });
}
/* v8 ignore stop */
