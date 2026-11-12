import {
  adviseNow,
  CONTEXT_AIM,
  contextStatus,
  scorecard,
  type ScoreStatus,
  wrap,
} from "./advisor.js";
import { type Feed, FEED_SCHEMA_VERSION, type FeedWindow, type Finding } from "./feed.js";
import { bar, paint, solidBar, sparkline } from "./meter.js";
import {
  buckets,
  cacheState,
  costPerMTok,
  mtokBand,
  type SessionModel,
  sessionUsd,
  topEntries,
  usdPerMinute,
} from "./session-model.js";

/** What `live` knows about feed.json: read, missing (no init / no refresh yet), or written by a newer CLI. */
export type FeedState =
  | { readonly kind: "ok"; readonly feed: Feed }
  | { readonly kind: "missing" }
  | { readonly kind: "newer" };

export function parseFeed(text: string | null): FeedState {
  if (text === null) return { kind: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "missing" };
  }
  const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version !== "number") return { kind: "missing" };
  if (version > FEED_SCHEMA_VERSION) return { kind: "newer" };
  return { kind: "ok", feed: parsed as Feed };
}

export interface LiveFrame {
  readonly sessions: ReadonlyArray<SessionModel>; // newest first
  readonly selected: number;
  readonly feed: FeedState;
  readonly nowMs: number;
  readonly width: number;
  readonly height?: number; // terminal rows; the frame never scrolls past them
  readonly color: boolean;
  readonly view?: LiveView; // default "advisor"
}

/** `advisor`: scorecard and what to do now; `details`: where the $ went, bar by bar. Tab switches. */
export type LiveView = "advisor" | "details";

/** Sparkline span of the selected session. */
export const SPARK_MS = 30 * 60 * 1000;
/** A session with a turn this recent shows as live; older ones show their idle time. */
const LIVE_MS = 2 * 60 * 1000;
/** Row name column (after a 2-space indent). */
const NAME = 14;

const COMPONENTS: ReadonlyArray<{
  readonly key: keyof SessionModel["usd"];
  readonly label: string;
  readonly rgb: string;
}> = [
  { key: "input", label: "input", rgb: "99;150;230" },
  { key: "output", label: "output", rgb: "200;120;220" },
  { key: "cacheRead", label: "cache read", rgb: "120;200;160" },
  { key: "cacheWrite", label: "cache write", rgb: "240;180;80" },
  { key: "webSearch", label: "web search", rgb: "230;110;110" },
];
const MODEL_RGB = "150;170;250";
const AGENT_RGB = "250;170;120";
const GOOD_RGB = "99;190;123";
const BAD_RGB = "248;105;107";

export const money = (usd: number): string => `$${usd.toFixed(2)}`;
const pct = (part: number, whole: number): string =>
  `${String(whole > 0 ? Math.round((part / whole) * 100) : 0)}%`;
const shortModel = (model: string): string => model.replace(/^claude-/, "");
const baseName = (dir: string): string => dir.split(/[\\/]/).filter(Boolean).pop() ?? "?";

export function kTokens(tokens: number): string {
  return tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : `${String(Math.round(tokens / 1000))}k`;
}

/** "4h20", "12m", "40s" — always positive. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h${String(minutes % 60).padStart(2, "0")}`;
  return `${String(Math.floor(hours / 24))}d`;
}

const clock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;

/** Bar width by terminal width. */
export function barCells(width: number): number {
  if (width >= 90) return 24;
  if (width >= 70) return 18;
  return width >= 60 ? 12 : 8;
}

const heading = (text: string, color: boolean, right = ""): string =>
  (color ? `\x1b[1m${text}\x1b[0m` : text) + (right === "" ? "" : `   ${right}`);
const subheading = (text: string, color: boolean): string =>
  `  ${paint("150;150;150", text, color)}`;
/** `  name          ████░░░░  right…` */
const row = (name: string, meter: string, right: ReadonlyArray<string>): string =>
  `  ${name.slice(0, NAME - 1).padEnd(NAME)}${meter}${right.length === 0 ? "" : `  ${right.join("  ")}`}`;
const amount = (usd: number, whole: number): ReadonlyArray<string> => [
  money(usd).padStart(8),
  pct(usd, whole).padStart(4),
];

/** One block per part of a session's $: components, models, agents, work, events. Shared by `live` and
 * `report --session`. */
export function summaryBlocks(
  session: SessionModel,
  color: boolean,
  cells: number,
): Array<Array<string>> {
  const usd = sessionUsd(session);
  const blocks: Array<Array<string>> = [];
  const share = (value: number): number => (usd > 0 ? value / usd : 0);

  // Web search shows only when the session ran one.
  const parts = COMPONENTS.filter((c) => c.key !== "webSearch" || session.usd.webSearch > 0);
  blocks.push([
    subheading("where it went", color),
    ...parts.map((c) =>
      row(
        c.label,
        solidBar(share(session.usd[c.key]), cells, c.rgb, color),
        amount(session.usd[c.key], usd),
      ),
    ),
  ]);

  const models = topEntries(session.byModel, 4);
  if (models.length > 0) {
    blocks.push([
      subheading("models", color),
      ...models.map(([model, value]) =>
        row(shortModel(model), solidBar(share(value), cells, MODEL_RGB, color), amount(value, usd)),
      ),
    ]);
  }

  const subagents = Object.entries(session.byScope).filter(([scope]) => scope !== "main");
  if (subagents.length > 0) {
    const spawned = session.marks.filter((mark) => mark.kind === "subagent").length;
    const main = session.byScope.main ?? 0;
    blocks.push([
      subheading(`agents · ${String(spawned)} subagent(s) started`, color),
      row("main", solidBar(share(main), cells, AGENT_RGB, color), amount(main, usd)),
      ...topEntries(Object.fromEntries(subagents), 3).map(([scope, value]) =>
        row(
          scope.replace(/^subagent:?/, "") || "subagent",
          solidBar(share(value), cells, AGENT_RGB, color),
          amount(value, usd),
        ),
      ),
    ]);
  }

  const perMTok = costPerMTok(session);
  if (perMTok !== null && usd > 0) {
    const { newWorkUsd, carryUsd, rewriteUsd } = session.efficiency;
    const kind = mtokBand(perMTok);
    const band =
      kind === "good"
        ? paint(GOOD_RGB, kind, color)
        : kind === "high"
          ? paint(BAD_RGB, kind, color)
          : kind;
    blocks.push([
      subheading(`work · $${perMTok.toFixed(0)} per MTok of new work (${band})`, color),
      row("new work", solidBar(share(newWorkUsd), cells, GOOD_RGB, color), amount(newWorkUsd, usd)),
      row(
        "re-reading",
        solidBar(share(carryUsd), cells, "120;200;160", color),
        amount(carryUsd, usd),
      ),
      row(
        "re-sending",
        solidBar(share(rewriteUsd), cells, BAD_RGB, color),
        amount(rewriteUsd, usd),
      ),
    ]);
  }

  const compactions = session.marks.filter((mark) => mark.kind === "compact").length;
  const colds = session.marks.filter((mark) => mark.kind === "cold").length;
  if (compactions + colds > 0) {
    const events: Array<string> = [];
    if (colds > 0) events.push(`${String(colds)} cold re-write(s) ${money(session.coldUsd)}`);
    if (compactions > 0) events.push(`${String(compactions)} compaction(s)`);
    blocks.push([row("events", events.join(" · "), [])]);
  }
  return blocks;
}

function sessionsBlock(frame: LiveFrame, cells: number): Array<string> {
  const shown = frame.sessions.slice(0, 6);
  const max = Math.max(...shown.map(sessionUsd));
  const perPercent = frame.feed.kind === "ok" ? frame.feed.feed.limits.usdPerPercentWeek : null;
  return [
    heading("SESSIONS", frame.color),
    ...shown.map((session, i) => {
      const usd = sessionUsd(session);
      const idle = frame.nowMs - session.lastMs;
      const name = `${i === frame.selected ? "▸" : " "} ${session.sessionId.slice(0, 4)} ${baseName(session.project)}`;
      const right = [money(usd).padStart(8)];
      if (perPercent !== null && perPercent > 0)
        right.push(`≈${(usd / perPercent).toFixed(1)}% wk`);
      right.push(idle < LIVE_MS ? paint(GOOD_RGB, "● live", frame.color) : `idle ${span(idle)}`);
      return `  ${name.slice(0, 22).padEnd(23)}${bar(max > 0 ? usd / max : 0, cells, frame.color)}  ${right.join("  ")}`;
    }),
  ];
}

function sessionSection(
  session: SessionModel,
  frame: LiveFrame,
  cells: number,
  details: boolean,
): Array<Array<string>> {
  const usd = sessionUsd(session);
  const facts = [
    money(usd),
    `${money(usdPerMinute(session, frame.nowMs))}/min`,
    span(session.lastMs - session.firstMs),
    `${String(session.turns)} turns`,
  ];
  const head = [heading("THIS SESSION", frame.color, facts.join(" · "))];
  if (frame.width >= 60) {
    const count = frame.width >= 80 ? 30 : 15;
    const line = sparkline(buckets(session.points, frame.nowMs - SPARK_MS, frame.nowMs, count));
    head.push(row("last 30 min", paint(MODEL_RGB, line, frame.color), ["$ per minute"]));
  }
  if (session.unpricedTurns > 0) {
    head.push(row("", `+${String(session.unpricedTurns)} turns on a model with no price`, []));
  }
  return [head, ...(details ? summaryBlocks(session, frame.color, cells) : [])];
}

const STATUS: Readonly<Record<ScoreStatus, { readonly mark: string; readonly rgb: string }>> = {
  good: { mark: "✔", rgb: GOOD_RGB },
  fair: { mark: "~", rgb: "255;215;0" },
  bad: { mark: "✖", rgb: BAD_RGB },
};
const statusMark = (status: ScoreStatus, color: boolean): string =>
  paint(STATUS[status].rgb, STATUS[status].mark, color);

/** Scorecard against a lean session, then up to 3 actions with the $ at stake and why. */
function advisorSection(
  session: SessionModel,
  frame: LiveFrame,
  cells: number,
): Array<Array<string>> {
  const feed = frame.feed.kind === "ok" ? frame.feed.feed : null;
  const scores = scorecard(session);
  if (scores.length === 0) return [];
  const blocks: Array<Array<string>> = [
    [
      heading(
        "ADVISOR",
        frame.color,
        paint("150;150;150", "cache reads cost ~0.1x input, writes 1.25x (1h: 2x)", frame.color),
      ),
      ...scores.map((score) =>
        row(score.label, bar(score.fraction, cells, frame.color), [
          score.value.padStart(4),
          `aim ${score.target}`.padEnd(10),
          statusMark(score.status, frame.color),
        ]),
      ),
    ],
  ];
  const tips = adviseNow(session, frame.nowMs, feed);
  const text = Math.max(30, frame.width - 7);
  if (tips.length === 0) {
    blocks.push([
      subheading("do now", frame.color),
      "  Nothing to change: this session runs lean.",
    ]);
    return blocks;
  }
  const lines = [subheading("do now", frame.color)];
  tips.forEach((tip, i) => {
    const stakeText = tip.usd === null ? "" : `~${money(tip.usd)} at stake`;
    const stake = stakeText === "" ? "" : `  ${paint("255;215;0", stakeText, frame.color)}`;
    // The stake goes at the end of the "see" text; leave room for it so the line fits.
    const [first = "", ...rest] = wrap(
      tip.see,
      text - (stakeText === "" ? 0 : stakeText.length + 2),
    );
    lines.push(`  ${String(i + 1)}. ${first}${rest.length === 0 ? stake : ""}`);
    rest.forEach((more, j) => lines.push(`     ${more}${j === rest.length - 1 ? stake : ""}`));
    for (const more of wrap(`→ ${tip.act}`, text)) lines.push(`     ${more}`);
    for (const more of wrap(`why: ${tip.why}`, text)) {
      lines.push(`     ${paint("150;150;150", more, frame.color)}`);
    }
  });
  blocks.push(lines);
  return blocks;
}

function cacheBlock(session: SessionModel, frame: LiveFrame, cells: number): Array<string> | null {
  const cache = cacheState(session, frame.nowMs);
  if (cache === null) return null;
  const window = cache.context > 200_000 ? 1_000_000 : 200_000;
  return [
    heading("CACHE & CONTEXT", frame.color, "estimate from the transcript"),
    cache.warm
      ? row("cache", bar(cache.secondsLeft / cache.ttlSeconds, cells, frame.color), [
          `warm ${clock(cache.secondsLeft)}`,
          `next ~${money(cache.nextWarmUsd)}`,
          `if cold ~${money(cache.nextColdUsd)}`,
        ])
      : row("cache", paint("244;164;96", "cold", frame.color), [
          `next prompt re-writes ~${money(cache.nextColdUsd)}`,
        ]),
    row("context", bar(cache.context / window, cells, frame.color), [
      `${kTokens(cache.context)} / ${kTokens(window)}`,
      `aim < ${kTokens(CONTEXT_AIM)}`,
      statusMark(contextStatus(cache.context), frame.color),
    ]),
  ];
}

/** `+2.2%/h · out in 20h15 · at-risk`, or why there is no runway. */
function runwayText(window: FeedWindow, nowMs: number): string {
  if (window.verdict === "insufficient-data") return "not enough data";
  if (window.verdict === "stale") return "reading is old";
  const parts: Array<string> = [];
  if (window.ratePctPerHour !== null) parts.push(`+${window.ratePctPerHour.toFixed(1)}%/h`);
  if (window.exhaustsAt !== null) {
    const out = Date.parse(window.exhaustsAt);
    const reset = window.resetsAt === null ? Number.POSITIVE_INFINITY : Date.parse(window.resetsAt);
    parts.push(out >= reset ? "lasts past reset" : `out in ${span(out - nowMs)}`);
  }
  parts.push(window.verdict);
  return parts.join(" · ");
}

/** `typical peak 64%` and the last 75/90/100 % crossing of the open window. */
function windowNotes(
  feed: Feed,
  key: "fiveHour" | "sevenDay",
  window: FeedWindow,
  nowMs: number,
): Array<string> {
  const notes: Array<string> = [];
  if (window.typicalPeakPct != null) {
    notes.push(`typical peak ${String(Math.round(window.typicalPeakPct))}%`);
  }
  const last = (feed.limits.milestones ?? [])
    .filter((milestone) => milestone.window === key)
    .at(-1);
  if (last !== undefined) {
    notes.push(`crossed ${String(last.threshold)}% ${span(nowMs - Date.parse(last.at))} ago`);
  }
  return notes;
}

function limitsBlock(feed: Feed, frame: LiveFrame, cells: number): Array<string> {
  const { fiveHour, sevenDay, usdPerPercentWeek } = feed.limits;
  if (feed.budget) {
    const b = feed.budget;
    return [
      heading("BUDGET", frame.color, b.paceLabel ?? ""),
      b.todayMax === null
        ? row("today", money(b.todaySpent), ["no work day left this month"])
        : row("today", bar(b.todayMax > 0 ? b.todaySpent / b.todayMax : 1, cells, frame.color), [
            `${money(b.todaySpent)} of ${money(b.todayMax)}`,
          ]),
      row("month", bar(b.monthCap > 0 ? b.monthSpent / b.monthCap : 0, cells, frame.color), [
        `${money(b.monthSpent)} of ${money(b.monthCap)}`,
      ]),
    ];
  }
  if (fiveHour === null && sevenDay === null) {
    return [
      heading("LIMITS", frame.color),
      row("", "no reading yet (needs an OAuth login and one statusline render)", []),
    ];
  }
  const lines = [
    heading(
      "LIMITS",
      frame.color,
      usdPerPercentWeek === null ? "" : `≈${money(usdPerPercentWeek)} per 1% of the week`,
    ),
  ];
  for (const [name, key, window] of [
    ["5 hours", "fiveHour", fiveHour],
    ["7 days", "sevenDay", sevenDay],
  ] as const) {
    if (window === null) continue;
    lines.push(
      row(name, bar(window.usedPct / 100, cells, frame.color), [
        `${String(Math.round(window.usedPct))}%`.padStart(4),
        runwayText(window, frame.nowMs),
      ]),
    );
    const notes = windowNotes(feed, key, window, frame.nowMs);
    if (notes.length > 0) lines.push(row("", " ".repeat(cells), ["    ", notes.join(" · ")]));
  }
  return lines;
}

function spendBlock(feed: Feed, frame: LiveFrame): Array<string> {
  const s = feed.spend;
  const lines = [
    heading(
      "SPEND",
      frame.color,
      `today ${money(s.today)} · 7 days ${money(s.week)} · month ${money(s.monthToDate)}${s.isFloor ? " (floor: unpriced model seen)" : ""}`,
    ),
  ];
  const top = feed.advice.find((finding: Finding) => finding.snoozedUntil === null);
  if (top !== undefined) {
    const usd = top.usd === null ? "" : ` ~${money(top.usd)}/${top.window}`;
    lines.push(
      `${paint("255;235;132", "»", frame.color)} ${top.id} ${top.title}${usd}  ${paint("150;150;150", "why and fix: cc-spend insights", frame.color)}`,
    );
  }
  return lines;
}

function footer(frame: LiveFrame): string {
  const notes = ["API-equivalent estimate, not a bill"];
  if (frame.feed.kind === "missing") notes.push("no feed.json yet: run cc-spend init");
  else if (frame.feed.kind === "newer") notes.push("feed.json is newer: update cc-spend");
  else notes.push(`feed ${span(frame.nowMs - Date.parse(frame.feed.feed.writtenAt))} old`);
  return paint("120;120;120", notes.join(" · "), frame.color);
}

/**
 * Sections (each a list of blocks) → lines: a blank line between blocks when the frame fits the terminal, none
 * when it does not, then a cut with a note. The frame never scrolls the alternate screen.
 */
export function fit(
  sections: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>,
  height: number,
  color: boolean,
): ReadonlyArray<string> {
  const spaced = sections.flatMap((blocks, i) =>
    blocks.flatMap((block, j) => (i === 0 && j === 0 ? block : ["", ...block])),
  );
  if (spaced.length <= height) return spaced;
  const dense = sections.flatMap((blocks) => blocks.flat());
  if (dense.length <= height) return dense;
  return [
    ...dense.slice(0, Math.max(0, height - 1)),
    paint("150;150;150", "… a taller terminal shows the rest", color),
  ];
}

/** One full frame of `cc-spend live`. Narrow terminals get shorter bars and no sparkline. */
export function renderLive(frame: LiveFrame): ReadonlyArray<string> {
  const cells = barCells(frame.width);
  const time = new Date(frame.nowMs).toTimeString().slice(0, 5);
  const title = `cc-spend live · ${String(frame.sessions.length)} active · ${time}`;
  const view = frame.view ?? "advisor";
  const keys = `q quit · ↑↓ session · tab ${view === "advisor" ? "details" : "advisor"}`;
  const sections: Array<Array<Array<string>>> = [
    [
      [
        frame.width >= title.length + keys.length + 2
          ? `${heading(title, frame.color)}${" ".repeat(frame.width - title.length - keys.length)}${paint("150;150;150", keys, frame.color)}`
          : heading(title, frame.color),
      ],
    ],
  ];
  const selected = frame.sessions[frame.selected];
  if (selected === undefined) {
    sections.push([["No Claude Code session wrote a transcript in the last 30 min."]]);
  } else {
    sections.push([sessionsBlock(frame, Math.min(cells, 16))]);
    sections.push(sessionSection(selected, frame, cells, view === "details"));
    if (view === "advisor") {
      const advisor = advisorSection(selected, frame, cells);
      if (advisor.length > 0) sections.push(advisor);
    }
    const cache = cacheBlock(selected, frame, cells);
    if (cache !== null) sections.push([cache]);
  }
  if (frame.feed.kind === "ok") {
    sections.push([limitsBlock(frame.feed.feed, frame, cells)]);
    sections.push([spendBlock(frame.feed.feed, frame)]);
  }
  sections.push([[footer(frame)]]);
  return fit(sections, frame.height ?? Number.POSITIVE_INFINITY, frame.color);
}
