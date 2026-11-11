import { readFileSync } from "node:fs";
import path from "node:path";

import { localDateKey } from "./clock.js";
import { barCells, money, span, summaryBlocks } from "./live-render.js";
import { paint, sparkline } from "./meter.js";
import {
  addSessionCompaction,
  addSessionTurn,
  buckets,
  costPerMTok,
  markBuckets,
  type MarkKind,
  newSession,
  type SessionModel,
  sessionUsd,
} from "./session-model.js";
import { listTranscripts, projectsDir, scopeOf } from "./transcript-index.js";
import { parseCompaction, parseTurn } from "./transcript-parse.js";

/** Session id of a transcript: the file name for a main thread, the parent folder for a subagent. */
export function sessionIdOf(file: string): string {
  return path.basename(path.dirname(file)) === "subagents"
    ? path.basename(path.dirname(path.dirname(file)))
    : path.basename(file, ".jsonl");
}

/** The transcripts of the one session whose id starts with `prefix`, or an error message. */
export function sessionFiles(
  prefix: string,
  root: string = projectsDir(),
): { readonly id: string; readonly files: ReadonlyArray<string> } | string {
  const byId = new Map<string, Array<string>>();
  for (const file of listTranscripts(root)) {
    const id = sessionIdOf(file);
    if (!id.startsWith(prefix)) continue;
    byId.set(id, [...(byId.get(id) ?? []), file]);
  }
  const ids = [...byId.keys()].sort();
  if (ids.length === 0) return `No transcript for session ${prefix}`;
  if (ids.length > 1) {
    return `${prefix} matches ${String(ids.length)} sessions: ${ids.map((id) => id.slice(0, 12)).join(", ")}`;
  }
  const id = ids[0] as string;
  return { id, files: byId.get(id) as Array<string> };
}

/** Reads every line of the session's transcripts into one model. */
export function loadSessionModel(id: string, files: ReadonlyArray<string>): SessionModel {
  const session = newSession(id);
  for (const file of files) {
    const scope = scopeOf(file);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const turn = parseTurn(line);
      if (turn !== null) {
        addSessionTurn(session, turn, scope, file);
        continue;
      }
      const compaction = parseCompaction(line);
      if (compaction !== null) addSessionCompaction(session, compaction);
    }
  }
  return session;
}

const MARK_GLYPH: ReadonlyArray<readonly [MarkKind, string]> = [
  ["cold", "!"],
  ["compact", "C"],
  ["subagent", "S"],
];

function stamp(ms: number): string {
  const date = new Date(ms);
  return `${localDateKey(date)} ${date.toTimeString().slice(0, 5)}`;
}

/** `report --session`: header, $ per time slot, running total, event marks, then where the $ went. */
export function renderSessionReport(
  session: SessionModel,
  color: boolean,
  width: number,
): ReadonlyArray<string> {
  const usd = sessionUsd(session);
  const where = [path.basename(session.project) || "?", session.branch].filter(Boolean).join(" @ ");
  const head = `Session ${session.sessionId.slice(0, 8)} · ${where} · ${String(session.turns)} turns · ${money(usd)}`;
  if (session.turns === 0) return [head, "No billed turn in this session."];
  const from = session.firstMs;
  const to = session.lastMs + 1;
  const lines = [`${head} · ${stamp(from)} → ${stamp(session.lastMs)} (${span(to - from)})`];
  const slots = Math.max(10, Math.min(60, width - 12));
  const perSlot = buckets(session.points, from, to, slots);
  let running = 0;
  const cumulative = perSlot.map((value) => (running += value));
  const marks = markBuckets(session.marks, from, to, slots).map(
    (kinds) => MARK_GLYPH.find(([kind]) => kinds.has(kind))?.[1] ?? " ",
  );
  const dim = (text: string): string => paint("150;150;150", text.padEnd(10), color);
  lines.push(`${dim("$ / slot")}${sparkline(perSlot)}  ${span((to - from) / slots)} per slot`);
  lines.push(`${dim("total")}${sparkline(cumulative)}`);
  if (marks.some((glyph) => glyph !== " ")) {
    lines.push(`${dim("events")}${marks.join("")}  ! cold re-write · C compaction · S subagent`);
  }
  for (const block of summaryBlocks(session, color, barCells(width))) lines.push("", ...block);
  lines.push("");
  lines.push("API-equivalent estimate, not a bill.");
  return lines;
}

/** `report --session --json`. */
export function sessionJson(session: SessionModel): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    project: session.project,
    branch: session.branch,
    firstAt: session.turns > 0 ? new Date(session.firstMs).toISOString() : null,
    lastAt: session.turns > 0 ? new Date(session.lastMs).toISOString() : null,
    turns: session.turns,
    unpricedTurns: session.unpricedTurns,
    usd: sessionUsd(session),
    components: session.usd,
    byModel: session.byModel,
    byScope: session.byScope,
    efficiency: { ...session.efficiency, costPerMTok: costPerMTok(session) },
    coldUsd: session.coldUsd,
    marks: session.marks.map((mark) => ({ at: new Date(mark.ms).toISOString(), kind: mark.kind })),
  };
}
