import type { Feed, Finding } from "./feed.js";
import type { MissCauseDay } from "./interfaces/config.interface.js";
import { type ModelRates, ratesFor, tokensCost } from "./pricing.js";
import type { SessionTotals } from "./transcript-index.js";
import { parseRowKey, type Rollup, rollupUsd } from "./transcript-parse.js";

/** A finding under this many dollars is noise next to the others.
 * # ponytail: one fixed floor for every plan; upgrade path: a share of the window's total $. */
export const MIN_FINDING_USD = 0.5;
export const MAX_FINDINGS = 10;
/** The model R1 suggests for subagents. */
const SUBAGENT_MODEL = "claude-sonnet-5-5";
/** R6 (antiburn's cost outlier): above max($2, 3 × median), with at least 8 sessions to judge by. */
const OUTLIER_MIN_USD = 2;
const OUTLIER_FACTOR = 3;
const OUTLIER_MIN_SESSIONS = 8;
/** R10: re-reading context above this share of $ (antiburn's "bad" Claude band). */
const CARRY_SHARE_BAD = 0.57;
/** R9: same family, a newer model at the same or a lower list price. */
const REPLACEMENTS: Readonly<Record<string, string>> = {
  "claude-opus-5": "claude-opus-5-5",
  "claude-opus-4-8": "claude-opus-5-5",
  "claude-opus-4-7": "claude-opus-5-5",
  "claude-opus-4-6": "claude-opus-5-5",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-sonnet-4-6": "claude-sonnet-5-5",
  "claude-fable-5": "claude-fable-5-1",
  "claude-mythos-5": "claude-mythos-5-1",
};
const PREMIUM = /opus|fable|mythos/;

export interface CoachInput {
  readonly rows: ReadonlyArray<readonly [string, Rollup]>; // rollups inside the window
  readonly sessions: Readonly<Record<string, SessionTotals>>; // last activity inside the window
  readonly missCauses: Readonly<Record<string, Readonly<Record<string, MissCauseDay>>>>; // window days
  readonly limits: Feed["limits"] | null;
  readonly budget: Feed["budget"] | undefined;
  readonly window: "week" | "month";
  readonly snoozed: Readonly<Record<string, string>>; // rule id → ISO until
  readonly now: Date;
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue 14:05" in local time, the same in every locale. */
function localWhen(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${WEEKDAYS[date.getDay()] as string} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The rollup's $ had its tokens been priced at `to` instead of `from` (cache writes scale with input). */
function repriced(rollup: Rollup, from: ModelRates, to: ModelRates): number {
  return (
    tokensCost(rollup.input, to.input) +
    tokensCost(rollup.output, to.output) +
    tokensCost(rollup.cacheRead, to.cacheRead) +
    rollup.usdCacheWrite * (to.input / from.input)
  );
}

function sum(rows: CoachInput["rows"], pick: (key: string, rollup: Rollup) => number): number {
  return rows.reduce((total, [key, rollup]) => total + pick(key, rollup), 0);
}

type Draft = Omit<Finding, "snoozedUntil" | "window">;

/** R1: subagents on a premium model; $ saved had they run on Sonnet. */
function premiumSubagents(input: CoachInput): Draft | null {
  const target = ratesFor(SUBAGENT_MODEL) as ModelRates;
  let usd = 0;
  let turns = 0;
  const models = new Set<string>();
  for (const [key, rollup] of input.rows) {
    const parts = parseRowKey(key);
    const rates = ratesFor(parts.model, parts.speed === "fast");
    if (parts.scope === "main" || !PREMIUM.test(parts.model) || rates === null) continue;
    usd += Math.max(0, rollupUsd(rollup) - repriced(rollup, rates, target));
    turns += rollup.turns;
    models.add(parts.model);
  }
  if (turns === 0) return null;
  return {
    id: "R1",
    title: "Subagents on a premium model",
    usd,
    evidence: `${String(turns)} subagent turns on ${[...models].sort().join(", ")}`,
    fix: {
      kind: "env",
      key: "CLAUDE_CODE_SUBAGENT_MODEL",
      value: "sonnet",
      text: "Run subagents on Sonnet (or set model: in the agent file)",
    },
  };
}

/** R2: fast mode costs twice the standard rate on the same tokens. */
function fastMode(input: CoachInput): Draft | null {
  const fast = input.rows.filter(([key]) => parseRowKey(key).speed === "fast");
  if (fast.length === 0) return null;
  const usd = sum(fast, (_, rollup) => rollupUsd(rollup)) / 2;
  const sub = sum(fast, (key, rollup) => (parseRowKey(key).scope === "main" ? 0 : rollup.turns));
  return {
    id: "R2",
    title: "Fast mode",
    usd,
    evidence: `${String(sum(fast, (_, r) => r.turns))} fast turns${sub > 0 ? `, ${String(sub)} in subagents` : ""}`,
    fix: { kind: "setting", key: "fastMode", value: "false", text: "Turn fast mode off (/fast)" },
  };
}

/** R3: thinking at xhigh/max/ultra effort. The estimate is all of that thinking: the floor is unknown. */
function highEffort(input: CoachInput): Draft | null {
  const usd = sum(input.rows, (_, rollup) => rollup.usdThinkingHigh);
  if (usd === 0) return null;
  return {
    id: "R3",
    title: "High effort thinking",
    usd,
    evidence: `${money(usd)} of thinking at xhigh/max/ultra effort`,
    fix: {
      kind: "setting",
      key: "effortLevel",
      value: "high",
      text: "Use high effort by default (/effort)",
    },
  };
}

/** R4: prompt-cache misses, by cause. */
function cacheMisses(input: CoachInput): Draft | null {
  const byCause = new Map<string, MissCauseDay>();
  for (const day of Object.values(input.missCauses)) {
    for (const [cause, entry] of Object.entries(day)) {
      const total = byCause.get(cause) ?? { count: 0, usd: 0 };
      byCause.set(cause, { count: total.count + entry.count, usd: total.usd + entry.usd });
    }
  }
  const ranked = [...byCause].sort(([, a], [, b]) => b.usd - a.usd);
  const usd = ranked.reduce((total, [, entry]) => total + entry.usd, 0);
  if (usd === 0) return null;
  const top = ranked
    .slice(0, 3)
    .map(([cause, entry]) => `${cause.replaceAll("_", " ")} ${money(entry.usd)}`)
    .join(", ");
  return {
    id: "R4",
    title: "Prompt cache re-paid",
    usd,
    evidence: `misses: ${top}`,
    fix: {
      kind: "habit",
      text: "/compact before a break; keep the MCP server and tool set stable mid-session",
    },
  };
}

/** R5: context past 200k tokens is re-read on every turn. */
function deepContext(input: CoachInput): Draft | null {
  const usd = sum(input.rows, (_, rollup) => rollup.deepContextReadUsd);
  if (usd === 0) return null;
  const deepest = Math.max(...input.rows.map(([, rollup]) => rollup.maxContext));
  return {
    id: "R5",
    title: "Deep context",
    usd,
    evidence: `re-reading context above 200k tokens (deepest ${String(Math.round(deepest / 1000))}k)`,
    fix: {
      kind: "env",
      key: "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
      value: "50",
      text: "Compact earlier, or start fresh for a new task",
    },
  };
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** R6: the session that cost far more than usual. */
function outlierSession(input: CoachInput): Draft | null {
  const sessions = Object.entries(input.sessions);
  if (sessions.length < OUTLIER_MIN_SESSIONS) return null;
  const middle = median(sessions.map(([, session]) => session.usd));
  const bar = Math.max(OUTLIER_MIN_USD, OUTLIER_FACTOR * middle);
  const outliers = sessions.filter(([, session]) => session.usd > bar);
  if (outliers.length === 0) return null;
  const [id, top] = outliers.sort(([, a], [, b]) => b.usd - a.usd)[0] as [string, SessionTotals];
  return {
    id: "R6",
    title: "Outlier session",
    usd: outliers.reduce((total, [, session]) => total + session.usd - middle, 0),
    evidence: `${id.slice(0, 8)} cost ${money(top.usd)} vs median ${money(middle)}${outliers.length > 1 ? ` (+${String(outliers.length - 1)} more)` : ""}`,
    fix: {
      kind: "command",
      value: `cc-daily-usage report ${input.window} --by session`,
      text: "Look at what that session did differently",
    },
  };
}

/** R8: a limit window or today's budget runs out early. No $: the cost is lost time. */
function runway(input: CoachInput): Draft | null {
  const atRisk = (["fiveHour", "sevenDay"] as const).filter(
    (window) => input.limits?.[window]?.verdict === "at-risk",
  );
  const budget = input.budget;
  const todayMax = budget?.todayMax ?? null;
  const overToday = budget !== undefined && todayMax !== null && budget.todaySpent > todayMax;
  if (atRisk.length === 0 && !overToday) return null;
  const parts = atRisk.map((window) => {
    const at = input.limits?.[window]?.exhaustsAt;
    return `${window === "fiveHour" ? "5h" : "7d"} limit runs out ${at ? localWhen(new Date(at)) : "soon"}`;
  });
  if (overToday) parts.push(`today ${money(budget.todaySpent)} of ${money(todayMax)}`);
  return {
    id: "R8",
    title: "Running out early",
    usd: null,
    evidence: parts.join("; "),
    fix: { kind: "habit", text: "Slow down, or move routine work to a cheaper model" },
  };
}

/** R9: an older model whose newer replacement costs the same or less. */
function oldModels(input: CoachInput): Draft | null {
  let usd = 0;
  const seen = new Map<string, string>();
  for (const [key, rollup] of input.rows) {
    const parts = parseRowKey(key);
    const replacement = REPLACEMENTS[parts.model];
    const from = ratesFor(parts.model, parts.speed === "fast");
    const to = replacement ? ratesFor(replacement, parts.speed === "fast") : null;
    if (!replacement || !from || !to || to.input > from.input || to.output > from.output) continue;
    usd += Math.max(0, rollupUsd(rollup) - repriced(rollup, from, to));
    seen.set(parts.model, replacement);
  }
  if (seen.size === 0) return null;
  const pairs = [...seen].sort().map(([from, to]) => `${from} → ${to}`);
  return {
    id: "R9",
    title: "Older model",
    usd,
    evidence: pairs.join(", "),
    fix: { kind: "command", value: "/model", text: `Switch: ${pairs.join(", ")}` },
  };
}

/** R10: most of the $ re-reads context (carry) instead of producing new work. */
function carryShare(input: CoachInput): Draft | null {
  const total = sum(input.rows, (_, rollup) => rollupUsd(rollup));
  const carry = sum(input.rows, (_, rollup) => rollup.usdCacheRead);
  if (total === 0 || carry / total <= CARRY_SHARE_BAD) return null;
  return {
    id: "R10",
    title: "Most spend re-reads context",
    usd: carry,
    evidence: `${String(Math.round((carry / total) * 100))}% of $ is cache reads`,
    fix: { kind: "habit", text: "/compact at natural breaks, /clear between unrelated tasks" },
  };
}

const RULES = [
  premiumSubagents,
  fastMode,
  highEffort,
  cacheMisses,
  deepContext,
  outlierSession,
  runway,
  oldModels,
  carryShare,
];

/**
 * Every rule over the window, ranked: active before snoozed, then $ descending (no $ first: R8 is urgent),
 * at most 10. A finding with a $ under MIN_FINDING_USD is dropped. R7 (unused MCP servers) needs the
 * initial-context source of CLI-10 and is not here yet.
 */
export function coach(input: CoachInput): ReadonlyArray<Finding> {
  const nowIso = input.now.toISOString();
  return RULES.map((rule) => rule(input))
    .filter((draft): draft is Draft => draft !== null)
    .filter((draft) => draft.usd === null || draft.usd >= MIN_FINDING_USD)
    .map((draft): Finding => {
      const until = input.snoozed[draft.id];
      return {
        ...draft,
        window: input.window,
        snoozedUntil: until && until > nowIso ? until : null,
      };
    })
    .sort(
      (a, b) =>
        Number(a.snoozedUntil !== null) - Number(b.snoozedUntil !== null) || rank(b) - rank(a),
    )
    .slice(0, MAX_FINDINGS);
}

/** No $ ranks highest: R8 is about time, not money. */
function rank(finding: Finding): number {
  return finding.usd ?? Number.MAX_VALUE;
}

/** The finding the statusline shows: the first one not snoozed. */
export function topFinding(advice: ReadonlyArray<Finding>): Finding | null {
  return advice.find((finding) => finding.snoozedUntil === null) ?? null;
}
