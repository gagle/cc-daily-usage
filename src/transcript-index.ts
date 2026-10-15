import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  ACCOUNTS_DIR,
  CONFIG_ROOT_DIR,
  loadSessionsMap,
  markNewerFile,
  writeVersionedFile,
} from "./config.js";
import { schemaVersionOf } from "./migrate.js";
import {
  addTurn,
  emptyRollup,
  mergeRollup,
  parseTurn,
  priceTurn,
  type Rollup,
  rowKey,
  type Turn,
  turnRowKey,
} from "./transcript-parse.js";

/** Format version of every index file. */
export const INDEX_SCHEMA_VERSION = 1;
/** Owner of sessions no account's sessions-map.json knows (no statusline ran for them). */
export const UNATTRIBUTED = "unattributed";
/** One pass stops starting new files after this many bytes or this long; the rest waits for the next. */
export const PASS_BYTES = 8 * 1024 * 1024;
export const PASS_MS = 2000;
/** Dedupe keys remembered per file across passes (repeats are adjacent: one per content block). */
const RECENT_KEYS = 64;
const LOCK_STALE_MS = 120_000;

export function projectsDir(): string {
  return path.join(homedir(), ".claude", "projects");
}

export const INDEX_DIR = path.join(CONFIG_ROOT_DIR, "index");

/** Rollups and sessions of one owner: an account's `index/` or the shared `index/unattributed/`. */
export function ownerIndexDir(owner: string): string {
  return owner === UNATTRIBUTED
    ? path.join(INDEX_DIR, UNATTRIBUTED)
    : path.join(ACCOUNTS_DIR, owner, "index");
}

interface FileOffset {
  offset: number;
  size: number;
  mtimeMs: number;
  recent: Array<string>;
}

/** Per-session totals (sessions.json). */
export interface SessionTotals {
  firstAt: string;
  lastAt: string;
  project: string;
  branch: string;
  models: Array<string>;
  turns: number;
  usd: number;
  unpricedTurns: number;
  subagentUsd: number;
}

export interface PassResult {
  readonly filesRead: number;
  readonly bytesRead: number;
  readonly bytesBehind: number; // bytes left for later passes
  readonly turns: number;
}

function readVersioned(file: string, key: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (schemaVersionOf(value) > INDEX_SCHEMA_VERSION) {
      markNewerFile(file);
      return {};
    }
    const inner = value[key];
    return inner !== null && typeof inner === "object" ? (inner as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeVersioned(file: string, key: string, value: unknown): void {
  writeVersionedFile(file, JSON.stringify({ schemaVersion: INDEX_SCHEMA_VERSION, [key]: value }));
}

/** Every transcript: `<project>/<session>.jsonl` and `<project>/<session>/subagents/agent-*.jsonl`. */
export function listTranscripts(root: string = projectsDir()): ReadonlyArray<string> {
  const files: Array<string> = [];
  const entries = (dir: string): ReadonlyArray<string> => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const project of entries(root)) {
    const projectDir = path.join(root, project);
    for (const name of entries(projectDir)) {
      if (name.endsWith(".jsonl")) files.push(path.join(projectDir, name));
      const subagents = path.join(projectDir, name, "subagents");
      for (const agent of entries(subagents)) {
        if (agent.startsWith("agent-") && agent.endsWith(".jsonl")) {
          files.push(path.join(subagents, agent));
        }
      }
    }
  }
  return files;
}

/** `main` for a session file; `subagent:<agentType>` from the agent's `.meta.json`, else `subagent`. */
export function scopeOf(file: string): string {
  if (path.basename(path.dirname(file)) !== "subagents") return "main";
  try {
    const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")) as {
      agentType?: unknown;
    };
    return typeof meta.agentType === "string" ? `subagent:${meta.agentType}` : "subagent";
  } catch {
    return "subagent";
  }
}

/** Complete lines from `offset` to the last newline; the partial tail waits for the next pass. */
function readNewLines(
  file: string,
  offset: number,
  size: number,
): { lines: Array<string>; next: number } {
  const length = size - offset;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  const end = buffer.lastIndexOf(0x0a);
  if (end === -1) return { lines: [], next: offset };
  return { lines: buffer.subarray(0, end).toString("utf8").split("\n"), next: offset + end + 1 };
}

/** sessionId → account key, from every account's sessions-map.json. */
function sessionOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  let keys: ReadonlyArray<string> = [];
  try {
    keys = readdirSync(ACCOUNTS_DIR);
  } catch {
    return owners;
  }
  for (const key of keys) {
    for (const sessionId of Object.keys(loadSessionsMap(key))) owners.set(sessionId, key);
  }
  return owners;
}

interface OwnerDelta {
  readonly months: Map<string, Map<string, Rollup>>; // YYYY-MM → row key → delta
  readonly sessions: Map<
    string,
    { turns: Array<Turn>; usd: number; unpriced: number; subagentUsd: number }
  >;
}

function applyDelta(owner: string, delta: OwnerDelta): void {
  const dir = ownerIndexDir(owner);
  for (const [month, rows] of delta.months) {
    const file = path.join(dir, `${month}.json`);
    const stored = readVersioned(file, "rows") as Record<string, Rollup>;
    for (const [key, add] of rows) {
      const into = { ...emptyRollup(), ...stored[key] };
      mergeRollup(into, add);
      stored[key] = into;
    }
    writeVersioned(file, "rows", stored);
  }
  const file = path.join(dir, "sessions.json");
  const sessions = readVersioned(file, "sessions") as Record<string, SessionTotals>;
  for (const [sessionId, add] of delta.sessions) {
    // The session's project is where it started; its branch is the latest one.
    const ordered = [...add.turns].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = ordered[0] as Turn;
    const last = ordered.at(-1) as Turn;
    const prior = sessions[sessionId];
    const models = new Set([...(prior?.models ?? []), ...add.turns.map((turn) => turn.model)]);
    sessions[sessionId] = {
      firstAt: prior?.firstAt ?? first.timestamp,
      lastAt: prior && prior.lastAt > last.timestamp ? prior.lastAt : last.timestamp,
      project: prior?.project || first.cwd,
      branch: last.branch || prior?.branch || "",
      models: [...models].sort(),
      turns: (prior?.turns ?? 0) + add.turns.length,
      usd: (prior?.usd ?? 0) + add.usd,
      unpricedTurns: (prior?.unpricedTurns ?? 0) + add.unpriced,
      subagentUsd: (prior?.subagentUsd ?? 0) + add.subagentUsd,
    };
  }
  writeVersioned(file, "sessions", sessions);
}

/** Takes the global index lock; false while a live pass holds it. Wall clock: the lock's mtime is real. */
function acquireIndexLock(): boolean {
  const lock = path.join(INDEX_DIR, "index.lock");
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
    rmSync(lock, { force: true });
    writeVersionedFile(lock, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

/**
 * One bounded pass over every transcript: reads only bytes past each file's saved offset, dedupes repeated
 * usage lines, prices each turn, and adds it to its owner's month rollup and session totals. Files start
 * until PASS_BYTES or PASS_MS is used (`unbounded` for a catch-up); a started file is read to its end.
 * # ponytail: a file is read whole from its offset — one huge transcript can pass the byte budget; fix with
 * a chunked read that carries the partial line.
 */
export function runIndexPass(
  options: { readonly unbounded?: boolean; readonly root?: string; readonly now?: Date } = {},
): PassResult | null {
  const now = options.now ?? new Date();
  if (!acquireIndexLock()) return null;
  const lockFile = path.join(INDEX_DIR, "index.lock");
  try {
    const offsetsFile = path.join(INDEX_DIR, "offsets.json");
    const offsets = readVersioned(offsetsFile, "files") as Record<string, FileOffset>;
    const owners = sessionOwners();
    const deltas = new Map<string, OwnerDelta>();
    const started = Date.now();
    let bytesRead = 0;
    let bytesBehind = 0;
    let filesRead = 0;
    let turns = 0;

    for (const file of listTranscripts(options.root)) {
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      const prior = offsets[file];
      // A file smaller than its offset was rewritten: read it again from the start.
      const from = prior && stat.size >= prior.offset ? prior.offset : 0;
      // Unchanged since the last pass (a partial last line waits here too).
      if (prior?.size === stat.size && prior.mtimeMs === stat.mtimeMs) continue;
      const out =
        !options.unbounded && (bytesRead >= PASS_BYTES || Date.now() - started >= PASS_MS);
      if (out) {
        bytesBehind += stat.size - from;
        continue;
      }
      const { lines, next } = readNewLines(file, from, stat.size);
      bytesRead += next - from;
      filesRead += 1;
      const recent = from === 0 || !prior ? [] : [...prior.recent];
      const scope = scopeOf(file);
      for (const line of lines) {
        const turn = parseTurn(line);
        if (turn === null || recent.includes(turn.key)) continue;
        recent.push(turn.key);
        if (recent.length > RECENT_KEYS) recent.shift();
        const key = turnRowKey(turn, scope);
        if (key === null) continue;
        const owner = owners.get(turn.sessionId) ?? UNATTRIBUTED;
        let delta = deltas.get(owner);
        if (!delta) {
          delta = { months: new Map(), sessions: new Map() };
          deltas.set(owner, delta);
        }
        const month = key.day.slice(0, 7);
        const rows = delta.months.get(month) ?? new Map<string, Rollup>();
        delta.months.set(month, rows);
        const row = rows.get(rowKey(key)) ?? emptyRollup();
        rows.set(rowKey(key), row);
        const cost = priceTurn(turn);
        addTurn(row, turn, cost);
        const usd = cost === null ? 0 : cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
        const session = delta.sessions.get(turn.sessionId) ?? {
          turns: [],
          usd: 0,
          unpriced: 0,
          subagentUsd: 0,
        };
        delta.sessions.set(turn.sessionId, session);
        session.turns.push(turn);
        session.usd += usd;
        if (cost === null) session.unpriced += 1;
        if (scope !== "main") session.subagentUsd += usd;
        turns += 1;
      }
      offsets[file] = { offset: next, size: stat.size, mtimeMs: stat.mtimeMs, recent };
    }

    for (const [owner, delta] of deltas) applyDelta(owner, delta);
    writeVersioned(offsetsFile, "files", offsets);
    writeVersioned(path.join(INDEX_DIR, "last-pass.json"), "pass", {
      at: now.toISOString(),
      bytesRead,
      bytesBehind,
    });
    return { filesRead, bytesRead, bytesBehind, turns };
  } finally {
    rmSync(lockFile, { force: true });
  }
}

/** Runs passes until nothing is behind (report/insights). Returns false when another pass holds the lock. */
export function catchUp(options: { readonly root?: string; readonly now?: Date } = {}): boolean {
  return runIndexPass({ ...options, unbounded: true }) !== null;
}

/** Month rollups of one owner, `YYYY-MM` → row key → totals. */
export function loadRollups(owner: string, months: ReadonlyArray<string>): Map<string, Rollup> {
  const rows = new Map<string, Rollup>();
  for (const month of months) {
    const stored = readVersioned(path.join(ownerIndexDir(owner), `${month}.json`), "rows");
    for (const [key, value] of Object.entries(stored)) rows.set(key, value as Rollup);
  }
  return rows;
}

export function loadSessionTotals(owner: string): Record<string, SessionTotals> {
  return readVersioned(path.join(ownerIndexDir(owner), "sessions.json"), "sessions") as Record<
    string,
    SessionTotals
  >;
}

/** When the last pass ran and how far behind it left the index; null before the first pass. */
export function lastPass(): { readonly at: string; readonly bytesBehind: number } | null {
  const pass = readVersioned(path.join(INDEX_DIR, "last-pass.json"), "pass");
  return typeof pass.at === "string" && typeof pass.bytesBehind === "number"
    ? { at: pass.at, bytesBehind: pass.bytesBehind }
    : null;
}
