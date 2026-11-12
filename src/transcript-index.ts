import {
  closeSync,
  cpSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { accountAt } from "./account.js";
import { localDateKey } from "./clock.js";
import {
  ACCOUNTS_DIR,
  CONFIG_ROOT_DIR,
  listAccountKeys,
  loadAccountLog,
  loadSessionsMap,
  markNewerFile,
  writeVersionedFile,
} from "./config.js";
import { schemaVersionOf } from "./migrate.js";
import { PRICES_VERSION } from "./pricing.js";
import {
  addTurn,
  type CcModelUsage,
  contextTokens,
  emptyHabits,
  emptyRollup,
  type HabitLine,
  type Habits,
  mcpServersUsed,
  mergeRollup,
  parseActivity,
  parseApiError,
  parseCostState,
  parseHabit,
  parseMcpLoad,
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
  context?: number; // context tokens of the file's last turn (the efficiency split needs the previous one)
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
  turnMs?: number; // absent in files written before 2026-10-15
  thinkingMs?: number;
  hookRuns?: number;
  entrypoint?: string | null;
  mcpLoaded?: Record<string, number>; // MCP server → est. tokens of its instructions in context
  mcpUsed?: Array<string>; // MCP servers the session called
  attributedUsd?: Record<string, number>; // `skill:<name>` / `mcp:<server>` → $ Claude Code attributed to it
  apiErrors?: Record<string, number>; // `429 usage_limit_reached`, … → failed requests
  // Claude Code's own cost per process run (`cost-state`), keyed by the run's start (epoch ms as a string).
  ccRuns?: Record<string, ClaudeCodeRun>;
}

/** One run's total as Claude Code counted it, and its per-model tokens and $. */
export interface ClaudeCodeRun {
  readonly usd: number;
  readonly models: Readonly<Record<string, CcModelUsage>>;
}

export interface PassResult {
  readonly filesRead: number;
  readonly bytesRead: number;
  readonly bytesBehind: number; // bytes left for later passes
  readonly turns: number;
  readonly repriced?: RepriceResult; // set on the pass that re-priced the index after a price change
}

/** What a re-price kept from the old index because no transcript could rebuild it. */
export interface RepriceResult {
  readonly from: string; // the old PRICES_VERSION, or "none" for an index written before it existed
  readonly rowsKept: number; // rows of sessions whose transcripts are gone, kept at the old prices
  readonly sessionsKept: number;
  readonly rowsShort: number; // rebuilt rows a deleted transcript shared; its part is added back (missingPart)
}

interface OwnerSnapshot {
  readonly months: Map<string, Record<string, Rollup>>;
  readonly sessions: Record<string, SessionTotals>;
  readonly habits: Record<string, Habits>;
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

/**
 * sessionId → owner of a line at an ISO time. A session one account's sessions-map.json knows is that
 * account's. A `/login` moves a running session to another account, so a session several accounts know
 * gives each turn to the login at the turn's time (account-log.json); a line with no time, or a time
 * before the log, goes to the account that saw the session last.
 */
function sessionOwners(): (sessionId: string, at?: string) => string {
  const owners = new Map<string, Array<{ readonly key: string; readonly lastSeenAt: string }>>();
  for (const key of listAccountKeys()) {
    for (const [sessionId, entry] of Object.entries(loadSessionsMap(key))) {
      owners.set(sessionId, [
        ...(owners.get(sessionId) ?? []),
        { key, lastSeenAt: entry.lastSeenAt },
      ]);
    }
  }
  const log = loadAccountLog();
  return (sessionId, at) => {
    const seen = owners.get(sessionId);
    if (seen === undefined) return UNATTRIBUTED;
    const last = (
      [...seen].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0] as (typeof seen)[0]
    ).key;
    if (seen.length === 1 || at === undefined) return last;
    const atTurn = accountAt(log, Date.parse(at));
    return seen.some((owner) => owner.key === atTurn) ? (atTurn as string) : last;
  };
}

interface OwnerDelta {
  readonly months: Map<string, Map<string, Rollup>>; // YYYY-MM → row key → delta
  readonly sessions: Map<string, SessionDelta>;
  readonly habits: Map<string, Habits>; // local day → counts
}

function emptyOwnerDelta(): OwnerDelta {
  return { months: new Map(), sessions: new Map(), habits: new Map() };
}

/** Adds one habit line to its local day; a line with a bad time is dropped. */
function addHabit(delta: OwnerDelta, habit: HabitLine): void {
  const time = new Date(habit.timestamp);
  if (Number.isNaN(time.getTime())) return;
  const day = localDateKey(time);
  const counts = delta.habits.get(day) ?? emptyHabits();
  counts[habit.kind] += 1;
  delta.habits.set(day, counts);
}

/** Adds each day's counts of `add` into `into`, key by key. */
function mergeHabits(into: Record<string, Habits>, add: Iterable<[string, Habits]>): void {
  for (const [day, counts] of add) {
    const sum = { ...emptyHabits(), ...into[day] };
    for (const kind of Object.keys(counts) as Array<keyof Habits>) sum[kind] += counts[kind];
    into[day] = sum;
  }
}

interface SessionDelta {
  turns: Array<Turn>;
  usd: number;
  unpriced: number;
  subagentUsd: number;
  turnMs: number;
  hookRuns: number;
  mcpLoaded: Map<string, number>;
  mcpUsed: Set<string>;
  attributedUsd: Map<string, number>;
  apiErrors: Map<string, number>;
  ccRuns: Map<string, ClaudeCodeRun>;
}

function emptySessionDelta(): SessionDelta {
  return {
    turns: [],
    usd: 0,
    unpriced: 0,
    subagentUsd: 0,
    turnMs: 0,
    hookRuns: 0,
    mcpLoaded: new Map(),
    mcpUsed: new Set(),
    attributedUsd: new Map(),
    apiErrors: new Map(),
    ccRuns: new Map(),
  };
}

/** A run's `cost-state` total only grows: the larger reading of the same run wins. */
function mergeRuns(
  prior: Readonly<Record<string, ClaudeCodeRun>> | undefined,
  add: ReadonlyMap<string, ClaudeCodeRun>,
): Record<string, ClaudeCodeRun> {
  const out: Record<string, ClaudeCodeRun> = { ...prior };
  for (const [start, run] of add) {
    const known = out[start];
    if (!known || run.usd >= known.usd) out[start] = run;
  }
  return out;
}

/** Adds the delta's counts to the prior record's, key by key. */
function addCounts(
  prior: Readonly<Record<string, number>> | undefined,
  add: ReadonlyMap<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...prior };
  for (const [key, value] of add) out[key] = (out[key] ?? 0) + value;
  return out;
}

/** Session MCP facts: the larger instructions size per server, the union of servers called. */
function mcpTotals(
  prior: SessionTotals | undefined,
  add: SessionDelta,
): Pick<SessionTotals, "mcpLoaded" | "mcpUsed"> {
  const loaded: Record<string, number> = { ...prior?.mcpLoaded };
  for (const [server, tokens] of add.mcpLoaded) {
    loaded[server] = Math.max(loaded[server] ?? 0, tokens);
  }
  const used = [...new Set([...(prior?.mcpUsed ?? []), ...add.mcpUsed])].sort();
  return { mcpLoaded: loaded, mcpUsed: used };
}

function applyDelta(owner: string, delta: OwnerDelta): void {
  const dir = ownerIndexDir(owner);
  if (delta.habits.size > 0) {
    const habitsFile = path.join(dir, "habits.json");
    const days = readVersioned(habitsFile, "days") as Record<string, Habits>;
    mergeHabits(days, delta.habits);
    writeVersioned(habitsFile, "days", days);
  }
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
    const prior = sessions[sessionId];
    const timing = {
      turnMs: (prior?.turnMs ?? 0) + add.turnMs,
      thinkingMs:
        (prior?.thinkingMs ?? 0) + add.turns.reduce((total, turn) => total + turn.thinkingMs, 0),
      hookRuns: (prior?.hookRuns ?? 0) + add.hookRuns,
      ...mcpTotals(prior, add),
      attributedUsd: addCounts(prior?.attributedUsd, add.attributedUsd),
      apiErrors: addCounts(prior?.apiErrors, add.apiErrors),
      ...(prior?.ccRuns || add.ccRuns.size > 0
        ? { ccRuns: mergeRuns(prior?.ccRuns, add.ccRuns) }
        : {}),
    };
    if (add.turns.length === 0) {
      // Only system or attachment lines this pass: they extend a session the index has, never start one.
      if (prior) sessions[sessionId] = { ...prior, ...timing };
      continue;
    }
    // The session's project is where it started; its branch is the latest one.
    const ordered = [...add.turns].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = ordered[0] as Turn;
    const last = ordered.at(-1) as Turn;
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
      ...timing,
      entrypoint: prior?.entrypoint ?? first.entrypoint,
    };
  }
  writeVersioned(file, "sessions", sessions);
}

/** Every owner with an index directory: the accounts' and the shared unattributed one. */
function indexOwners(): ReadonlyArray<string> {
  let keys: ReadonlyArray<string> = [];
  try {
    keys = readdirSync(ACCOUNTS_DIR).filter((key) => existsSync(ownerIndexDir(key)));
  } catch {
    keys = [];
  }
  return existsSync(ownerIndexDir(UNATTRIBUTED)) ? [...keys, UNATTRIBUTED] : keys;
}

const MONTH_FILE = /^\d{4}-\d{2}\.json$/;

/**
 * Starts a re-price: copies every owner's index to `index/backup-prices-<from>/` (once: a crashed re-price
 * restarts from that copy), loads it, and empties the live index so the pass rebuilds it from transcripts.
 */
function startReprice(from: string): Map<string, OwnerSnapshot> {
  const backup = path.join(INDEX_DIR, `backup-prices-${from}`);
  const restarted = existsSync(backup);
  const snapshots = new Map<string, OwnerSnapshot>();
  for (const owner of restarted ? readdirSync(backup) : indexOwners()) {
    const saved = path.join(backup, owner);
    if (!restarted) cpSync(ownerIndexDir(owner), saved, { recursive: true });
    const months = new Map<string, Record<string, Rollup>>();
    for (const name of readdirSync(saved).filter((file) => MONTH_FILE.test(file))) {
      months.set(
        name.slice(0, 7),
        readVersioned(path.join(saved, name), "rows") as Record<string, Rollup>,
      );
    }
    const sessions = readVersioned(path.join(saved, "sessions.json"), "sessions") as Record<
      string,
      SessionTotals
    >;
    const habits = readVersioned(path.join(saved, "habits.json"), "days") as Record<string, Habits>;
    snapshots.set(owner, { months, sessions, habits });
    rmSync(ownerIndexDir(owner), { recursive: true, force: true });
  }
  return snapshots;
}

/** $ fields priced from a token field: the row's own $ per token prices its missing tokens. */
const PRICED: ReadonlyArray<readonly [keyof Rollup, keyof Rollup]> = [
  ["usdInput", "input"],
  ["usdOutput", "output"],
  ["usdCacheRead", "cacheRead"],
  ["usdCacheWrite", "cacheWrite"],
  ["usdThinking", "thinking"],
];

/**
 * The part of an old row its rebuild lacks: turns of a transcript that is gone. Counts are the exact
 * difference; the main $ fields price the missing tokens at the old row's own rates (the prices it was stored
 * with), so the price change of the turns that were rebuilt is not counted again. Other $ fields (thinking at
 * high effort, deep context, the efficiency split) take the plain difference.
 */
export function missingPart(old: Rollup, rebuilt: Rollup): Rollup {
  const part = emptyRollup();
  for (const field of Object.keys(part) as Array<keyof Rollup>) {
    part[field] = field === "maxContext" ? 0 : Math.max(0, old[field] - rebuilt[field]);
  }
  for (const [usd, tokens] of PRICED) {
    part[usd] = old[tokens] > 0 ? part[tokens] * (old[usd] / old[tokens]) : 0;
  }
  part.usdThinkingHigh =
    old.usdThinking > 0 ? old.usdThinkingHigh * (part.usdThinking / old.usdThinking) : 0;
  return part;
}

/**
 * Ends a re-price: rows and sessions the rebuild did not produce (their transcripts are gone) come back from
 * the snapshot, at the prices they were stored with. A row the rebuild made with fewer turns (a gone
 * transcript shared it) gets its missing part back (missingPart).
 */
function finishReprice(from: string, snapshots: Map<string, OwnerSnapshot>): RepriceResult {
  let rowsKept = 0;
  let sessionsKept = 0;
  let rowsShort = 0;
  for (const [owner, snapshot] of snapshots) {
    const dir = ownerIndexDir(owner);
    for (const [month, oldRows] of snapshot.months) {
      const file = path.join(dir, `${month}.json`);
      const rows = readVersioned(file, "rows") as Record<string, Rollup>;
      for (const [key, row] of Object.entries(oldRows)) {
        const rebuilt = rows[key];
        if (rebuilt === undefined) {
          rows[key] = row;
          rowsKept += 1;
        } else if (rebuilt.turns < row.turns) {
          mergeRollup(rebuilt, missingPart({ ...emptyRollup(), ...row }, rebuilt));
          rowsShort += 1;
        }
      }
      writeVersioned(file, "rows", rows);
    }
    const file = path.join(dir, "sessions.json");
    const sessions = readVersioned(file, "sessions") as Record<string, SessionTotals>;
    for (const [id, totals] of Object.entries(snapshot.sessions)) {
      if (sessions[id] !== undefined) continue;
      sessions[id] = totals;
      sessionsKept += 1;
    }
    writeVersioned(file, "sessions", sessions);
    // Days whose transcripts are all gone keep their old counts.
    const habitsFile = path.join(dir, "habits.json");
    const days = readVersioned(habitsFile, "days") as Record<string, Habits>;
    const lost = Object.entries(snapshot.habits).filter(([day]) => days[day] === undefined);
    if (lost.length > 0) {
      mergeHabits(days, lost);
      writeVersioned(habitsFile, "days", days);
    }
  }
  pruneRepriceBackups(from);
  return { from, rowsKept, sessionsKept, rowsShort };
}

/** Keeps only the backup this re-price took: older ones were superseded by a re-price that already succeeded. */
function pruneRepriceBackups(kept: string): void {
  for (const name of readdirSync(INDEX_DIR)) {
    if (name.startsWith("backup-prices-") && name !== `backup-prices-${kept}`) {
      rmSync(path.join(INDEX_DIR, name), { recursive: true, force: true });
    }
  }
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
    const pricesFile = path.join(INDEX_DIR, "prices.json");
    const storedPrices = readVersioned(pricesFile, "prices").version;
    const priorOffsets = readVersioned(offsetsFile, "files") as Record<string, FileOffset>;
    // An index built at other prices is rebuilt from the transcripts, whole, in this pass.
    const from = typeof storedPrices === "string" ? storedPrices : "none";
    const reprice =
      // Only forward: an older build never re-prices what a newer one wrote (versions are ISO dates).
      Object.keys(priorOffsets).length > 0 &&
      (typeof storedPrices !== "string" || storedPrices < PRICES_VERSION)
        ? { from, snapshots: startReprice(from) }
        : null;
    const offsets = reprice === null ? priorOffsets : {};
    const unbounded = options.unbounded === true || reprice !== null;
    const ownerOf = sessionOwners();
    const deltas = new Map<string, OwnerDelta>();
    const started = Date.now();
    let bytesRead = 0;
    let bytesBehind = 0;
    let filesRead = 0;
    let turns = 0;

    const listed = new Set<string>();
    for (const file of listTranscripts(options.root)) {
      listed.add(file);
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
      const out = !unbounded && (bytesRead >= PASS_BYTES || Date.now() - started >= PASS_MS);
      // A long re-price keeps its lock fresh so no second pass takes it over as stale.
      if (reprice !== null) utimesSync(lockFile, new Date(), new Date());
      if (out) {
        bytesBehind += stat.size - from;
        continue;
      }
      const { lines, next } = readNewLines(file, from, stat.size);
      bytesRead += next - from;
      filesRead += 1;
      const recent = from === 0 || !prior ? [] : [...prior.recent];
      // The previous turn's context in this thread; unknown when resuming a file indexed before it was kept.
      let context: number | null = from === 0 ? 0 : (prior?.context ?? null);
      const scope = scopeOf(file);
      // Claude Code repeats a line once per content block: true for a key seen in the last RECENT_KEYS.
      const repeated = (key: string): boolean => {
        if (recent.includes(key)) return true;
        recent.push(key);
        if (recent.length > RECENT_KEYS) recent.shift();
        return false;
      };
      const sessionDelta = (sessionId: string, owner = ownerOf(sessionId)): SessionDelta => {
        const delta = deltas.get(owner) ?? emptyOwnerDelta();
        deltas.set(owner, delta);
        const session = delta.sessions.get(sessionId) ?? emptySessionDelta();
        delta.sessions.set(sessionId, session);
        return session;
      };
      for (const line of lines) {
        const called = mcpServersUsed(line);
        if (called !== null) {
          const session = sessionDelta(called.sessionId);
          for (const server of called.servers) session.mcpUsed.add(server);
        }
        const turn = parseTurn(line);
        if (turn === null) {
          const loaded = parseMcpLoad(line);
          if (loaded !== null) {
            const session = sessionDelta(loaded.sessionId);
            for (const [server, tokens] of Object.entries(loaded.servers)) {
              session.mcpLoaded.set(server, Math.max(session.mcpLoaded.get(server) ?? 0, tokens));
            }
            continue;
          }
          const state = parseCostState(line);
          if (state !== null) {
            const runs = sessionDelta(state.sessionId).ccRuns;
            const start = String(state.startTime);
            const known = runs.get(start);
            if (!known || state.usd >= known.usd) {
              runs.set(start, { usd: state.usd, models: state.models });
            }
            continue;
          }
          const error = parseApiError(line);
          if (error !== null) {
            if (repeated(error.key)) continue;
            const session = sessionDelta(error.sessionId);
            session.apiErrors.set(error.kind, (session.apiErrors.get(error.kind) ?? 0) + 1);
            continue;
          }
          const habit = scope === "main" ? parseHabit(line) : null;
          if (habit !== null) {
            const owner = ownerOf(habit.sessionId, habit.timestamp);
            const delta = deltas.get(owner) ?? emptyOwnerDelta();
            deltas.set(owner, delta);
            addHabit(delta, habit);
            continue;
          }
          const activity = parseActivity(line);
          if (activity === null) continue;
          const session = sessionDelta(activity.sessionId);
          session.turnMs += activity.turnMs;
          session.hookRuns += activity.hookRuns;
          continue;
        }
        if (repeated(turn.key)) continue;
        const key = turnRowKey(turn, scope);
        if (key === null) continue;
        const owner = ownerOf(turn.sessionId, turn.timestamp);
        const delta = deltas.get(owner) ?? emptyOwnerDelta();
        deltas.set(owner, delta);
        const month = key.day.slice(0, 7);
        const rows = delta.months.get(month) ?? new Map<string, Rollup>();
        delta.months.set(month, rows);
        const row = rows.get(rowKey(key)) ?? emptyRollup();
        rows.set(rowKey(key), row);
        const cost = priceTurn(turn);
        addTurn(row, turn, cost, context);
        context = contextTokens(turn);
        const usd =
          cost === null
            ? 0
            : cost.input + cost.output + cost.cacheRead + cost.cacheWrite + cost.webSearch;
        const session = sessionDelta(turn.sessionId, owner);
        session.turns.push(turn);
        session.usd += usd;
        for (const name of [
          turn.skill && `skill:${turn.skill}`,
          turn.mcpServer && `mcp:${turn.mcpServer}`,
        ]) {
          if (name) session.attributedUsd.set(name, (session.attributedUsd.get(name) ?? 0) + usd);
        }
        if (cost === null) session.unpriced += 1;
        if (scope !== "main") session.subagentUsd += usd;
        turns += 1;
      }
      offsets[file] = {
        offset: next,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        recent,
        ...(context === null ? {} : { context }),
      };
    }

    for (const [owner, delta] of deltas) applyDelta(owner, delta);
    const repriced = reprice === null ? undefined : finishReprice(reprice.from, reprice.snapshots);
    // A transcript Claude Code deleted (cleanupPeriodDays) never comes back: its offset only grows the file.
    const kept = Object.entries(offsets).filter(([file]) => listed.has(file));
    writeVersioned(offsetsFile, "files", Object.fromEntries(kept));
    if (reprice !== null || typeof storedPrices !== "string") {
      writeVersioned(pricesFile, "prices", { version: PRICES_VERSION });
    }
    writeVersioned(path.join(INDEX_DIR, "last-pass.json"), "pass", {
      at: now.toISOString(),
      bytesRead,
      bytesBehind,
      ...(repriced ? { repriced } : {}),
    });
    return { filesRead, bytesRead, bytesBehind, turns, ...(repriced ? { repriced } : {}) };
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
    // Rows written before a field existed read it as 0.
    for (const [key, value] of Object.entries(stored)) {
      rows.set(key, { ...emptyRollup(), ...(value as Partial<Rollup>) });
    }
  }
  return rows;
}

/** Habit counts of one owner, local day → counts; empty before the first pass that counted them. */
export function loadHabits(owner: string): Record<string, Habits> {
  const days = readVersioned(path.join(ownerIndexDir(owner), "habits.json"), "days");
  return Object.fromEntries(
    Object.entries(days).map(([day, counts]) => [
      day,
      { ...emptyHabits(), ...(counts as Partial<Habits>) },
    ]),
  );
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
