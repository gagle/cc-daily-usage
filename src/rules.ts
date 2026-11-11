import type { Feed, Finding } from "./feed.js";
import type { MissCauseDay } from "./interfaces/config.interface.js";
import {
  type ModelRates,
  ratesFor,
  tokenizerRatio,
  tokensCost,
  WEB_SEARCH_USD,
} from "./pricing.js";
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
  "claude-opus-4-5": "claude-opus-5-5",
  "claude-opus-4-1": "claude-opus-5-5",
  "claude-opus-4": "claude-opus-5-5",
  "claude-sonnet-4-5": "claude-sonnet-5-5",
  "claude-sonnet-4": "claude-sonnet-5-5",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-sonnet-4-6": "claude-sonnet-5-5",
  "claude-fable-5": "claude-fable-5-1",
  "claude-mythos-5": "claude-mythos-5-1",
};
const PREMIUM = /opus|fable|mythos/;
/** R11 (antiburn check #9): fresh input this many times the context it added means context is re-sent. */
const CHURN_MULTIPLE = 2.35;
/** R12: instruction files (CLAUDE.md, MEMORY.md) past this many tokens per project are worth trimming. */
export const LEAN_INSTRUCTION_TOKENS = 2000;

/** A file Claude Code loads into every turn of a project: `project` null = every project (global). */
export interface InstructionFile {
  readonly path: string;
  readonly project: string | null;
  readonly tokens: number; // estimate: bytes ÷ 4
}

export interface CoachInput {
  readonly rows: ReadonlyArray<readonly [string, Rollup]>; // rollups inside the window
  readonly sessions: Readonly<Record<string, SessionTotals>>; // last activity inside the window
  readonly missCauses: Readonly<Record<string, Readonly<Record<string, MissCauseDay>>>>; // window days
  readonly limits: Feed["limits"] | null;
  readonly budget: Feed["budget"] | undefined;
  readonly window: "week" | "month";
  readonly snoozed: Readonly<Record<string, string>>; // rule id → ISO until
  readonly now: Date;
  readonly instructions?: ReadonlyArray<InstructionFile>; // R12; none = rule skipped
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Tue 14:05" in local time, the same in every locale. */
function localWhen(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${WEEKDAYS[date.getDay()] as string} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The rollup's $ had its tokens been priced at `to` instead of `from`. Each component scales by its rate
 * ratio, so multipliers already in the $ (US-only inference) carry over; `tokens` is how many tokens the
 * same text is on `to` (see tokenizerRatio).
 */
function repriced(rollup: Rollup, from: ModelRates, to: ModelRates, tokens = 1): number {
  return (
    (rollup.usdInput * (to.input / from.input) +
      rollup.usdOutput * (to.output / from.output) +
      rollup.usdCacheRead * (to.cacheRead / from.cacheRead) +
      rollup.usdCacheWrite * (to.input / from.input)) * // cache writes are a fixed multiple of input
      tokens +
    rollup.webSearches * WEB_SEARCH_USD // the same on any model
  );
}

function sum(rows: CoachInput["rows"], pick: (key: string, rollup: Rollup) => number): number {
  return rows.reduce((total, [key, rollup]) => total + pick(key, rollup), 0);
}

type Draft = Omit<Finding, "snoozedUntil" | "window" | "title" | "why">;

/** What a rule looks for, why it costs money, how its $ is estimated and the usual fix: `insights --rules`, the
 * `why` line of each finding, and the README table. */
export interface RuleInfo {
  readonly id: string;
  readonly title: string;
  readonly checks: string;
  readonly why: string;
  readonly estimate: string;
  readonly fix: string;
  readonly action: string; // a few words for the statusline's next-action part
}

export const RULE_INFO: ReadonlyArray<RuleInfo> = [
  {
    id: "R1",
    title: "Subagents on a premium model",
    checks: "Subagent turns on an Opus, Fable or Mythos model.",
    why: "Subagents mostly search and read; a premium model bills the same tokens at 2-5x Sonnet.",
    estimate: "What those turns would cost less on Sonnet 5.5.",
    fix: "CLAUDE_CODE_SUBAGENT_MODEL=sonnet, or model: in the agent file.",
    action: "subagents on Sonnet: CLAUDE_CODE_SUBAGENT_MODEL=sonnet",
  },
  {
    id: "R2",
    title: "Fast mode",
    checks: "Turns run in fast mode.",
    why: "Fast mode bills every token at 2x the standard rate.",
    estimate: "Half of the fast-mode $.",
    fix: "Turn fast mode off (/fast, setting fastMode=false).",
    action: "/fast off",
  },
  {
    id: "R3",
    title: "High effort thinking",
    checks: "Thinking on turns at xhigh, max or ultra effort.",
    why: "Thinking bills as output, the most expensive token; high effort is enough for most tasks.",
    estimate: "All thinking $ at those levels (an upper bound).",
    fix: "Use high effort by default (/effort, setting effortLevel=high).",
    action: "/effort high",
  },
  {
    id: "R4",
    title: "Prompt cache re-paid",
    checks: "Prompt-cache misses the statusline saw, by cause.",
    why: "After a miss the whole context is written again at 1.25-2x the input rate instead of read at about 0.05-0.1x.",
    estimate: "What the misses re-paid.",
    fix: "/compact before a break; keep the MCP servers and tools stable mid-session.",
    action: "/compact before breaks",
  },
  {
    id: "R5",
    title: "Deep context",
    checks: "Turns with more than 200k tokens of context.",
    why: "Every turn, each tool call included, re-reads the whole context; the part above 200k is paid each time.",
    estimate: "Cache-read $ for the part above 200k.",
    fix: "Compact earlier or start fresh for a new task (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50).",
    action: "/compact earlier",
  },
  {
    id: "R6",
    title: "Outlier session",
    checks: "A session above 3x your median cost (and $2), once you have 8 sessions.",
    why: "One runaway session (a loop, a huge file, the wrong model) can cost more than a normal day.",
    estimate: "The outliers' $ above the median.",
    fix: "cc-daily-usage report week --by session, then report --session <id> to see what it did.",
    action: "see why: cc-daily-usage report --by session",
  },
  {
    id: "R7",
    title: "Unused MCP servers",
    checks: "MCP servers whose instructions were in context in sessions that never called them.",
    why: "A server loads into every turn of every session, used or not.",
    estimate: "Those tokens re-read on each turn (a floor: tool definitions are not counted).",
    fix: "Turn off servers a project does not use (/mcp) or remove them from .mcp.json.",
    action: "/mcp: turn off unused servers",
  },
  {
    id: "R8",
    title: "Running out early",
    checks: "A 5h or 7d limit on course to run out before it resets, or today's budget passed.",
    why: "At the limit work stops until the reset; the cost is time, not $.",
    estimate: "None.",
    fix: "Slow down, or move routine work to a cheaper model.",
    action: "/model sonnet for routine steps",
  },
  {
    id: "R9",
    title: "Older model",
    checks: "Turns on a model whose newer replacement costs the same or less.",
    why: "The newer model is at least as good for the same or a lower price.",
    estimate: "The difference at the newer model's prices.",
    fix: "Switch with /model, and update the default model in your settings.",
    action: "/model: newer, same price",
  },
  {
    id: "R10",
    title: "Most spend re-reads context",
    checks: "More than 57% of $ is cache reads.",
    why: "Long sessions spend most of their $ re-reading history, not producing new work.",
    estimate: "All cache-read $ (the part /compact and /clear can cut).",
    fix: "/compact at natural breaks, /clear between unrelated tasks.",
    action: "/clear between tasks",
  },
  {
    id: "R11",
    title: "Context sent again and again",
    checks: "Fresh input at least 2.35x the context it added.",
    why: "Context the model already had was sent again at write prices, often after a cold cache or a model switch.",
    estimate: "The re-sent part.",
    fix: "Avoid long mid-session breaks (/compact before one); do not switch models on a big context.",
    action: "no long breaks mid-task",
  },
  {
    id: "R12",
    title: "Large instruction files",
    checks: "CLAUDE.md and MEMORY.md over 2,000 tokens in a project.",
    why: "They load into every turn; each extra 1k tokens is paid on every turn of every session.",
    estimate: "The tokens above 2,000 re-read on each main turn.",
    fix: "Trim them; move rare detail into files read on demand.",
    action: "trim CLAUDE.md and MEMORY.md",
  },
];

export function ruleInfo(id: string): RuleInfo | undefined {
  return RULE_INFO.find((rule) => rule.id === id);
}

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
    const tokens = tokenizerRatio(parts.model, SUBAGENT_MODEL);
    usd += Math.max(0, rollupUsd(rollup) - repriced(rollup, rates, target, tokens));
    turns += rollup.turns;
    models.add(parts.model);
  }
  if (turns === 0) return null;
  return {
    id: "R1",
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

/** R2: fast mode multiplies every token price (2×; 6× on Opus 4.6 / 4.7); the $ is that surcharge. */
function fastMode(input: CoachInput): Draft | null {
  const fast = input.rows.filter(([key]) => parseRowKey(key).speed === "fast");
  if (fast.length === 0) return null;
  const usd = sum(fast, (key, rollup) => {
    const model = parseRowKey(key).model;
    const fastRates = ratesFor(model, true);
    const standard = ratesFor(model);
    return fastRates && standard ? rollupUsd(rollup) - repriced(rollup, fastRates, standard) : 0;
  });
  const sub = sum(fast, (key, rollup) => (parseRowKey(key).scope === "main" ? 0 : rollup.turns));
  return {
    id: "R2",
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
    if (!replacement || !from || !to) continue;
    const tokens = tokenizerRatio(parts.model, replacement);
    if (to.input * tokens > from.input || to.output * tokens > from.output) continue;
    usd += Math.max(0, rollupUsd(rollup) - repriced(rollup, from, to, tokens));
    seen.set(parts.model, replacement);
  }
  if (seen.size === 0) return null;
  const pairs = [...seen].sort().map(([from, to]) => `${from} → ${to}`);
  return {
    id: "R9",
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
    usd: carry,
    evidence: `${String(Math.round((carry / total) * 100))}% of $ is cache reads`,
    fix: { kind: "habit", text: "/compact at natural breaks, /clear between unrelated tasks" },
  };
}

/**
 * R7: MCP servers whose instructions sat in context for a whole session that never called them. The $ is
 * those tokens re-read on every turn at the session's cheapest model's cache-read rate (a floor: tool
 * definitions are not in the transcript).
 */
function unusedMcp(input: CoachInput): Draft | null {
  const byServer = new Map<string, { usd: number; tokens: number; sessions: number }>();
  for (const session of Object.values(input.sessions)) {
    const rates = session.models
      .map((model) => ratesFor(model))
      .filter((rate): rate is ModelRates => rate !== null)
      .sort((a, b) => a.cacheRead - b.cacheRead)[0];
    if (!session.mcpLoaded || rates === undefined) continue;
    const used = new Set(session.mcpUsed ?? []);
    for (const [server, tokens] of Object.entries(session.mcpLoaded)) {
      if (used.has(server) || tokens === 0) continue;
      const entry = byServer.get(server) ?? { usd: 0, tokens: 0, sessions: 0 };
      entry.usd += tokensCost(tokens * session.turns, rates.cacheRead);
      entry.tokens = Math.max(entry.tokens, tokens);
      entry.sessions += 1;
      byServer.set(server, entry);
    }
  }
  if (byServer.size === 0) return null;
  const ranked = [...byServer].sort(([, a], [, b]) => b.usd - a.usd);
  return {
    id: "R7",
    usd: ranked.reduce((total, [, entry]) => total + entry.usd, 0),
    evidence: ranked
      .slice(0, 3)
      .map(
        ([server, entry]) =>
          `${server} ~${String(Math.round(entry.tokens / 100) / 10)}k tokens, unused in ${String(entry.sessions)} session(s) ${money(entry.usd)}`,
      )
      .join("; "),
    fix: {
      kind: "command",
      value: "/mcp",
      text: "Turn off servers a project does not use (/mcp), or remove them from .mcp.json",
    },
  };
}

/** R11: fresh input far above the context it added — the same context is sent (written) again. */
function cacheChurn(input: CoachInput): Draft | null {
  const fresh = sum(input.rows, (_, rollup) => rollup.freshSplit);
  const rewrite = sum(input.rows, (_, rollup) => rollup.rewriteTokens);
  const usd = sum(input.rows, (_, rollup) => rollup.usdRewrite);
  if (rewrite === 0) return null;
  const multiple = fresh - rewrite > 0 ? fresh / (fresh - rewrite) : Number.POSITIVE_INFINITY;
  if (multiple < CHURN_MULTIPLE) return null;
  return {
    id: "R11",
    usd,
    evidence: Number.isFinite(multiple)
      ? `fresh input is ${multiple.toFixed(1)}× the context it added`
      : "every fresh token re-sent context the model already had",
    fix: {
      kind: "habit",
      text: "Avoid long breaks mid-session (/compact before one); do not switch models on a big context",
    },
  };
}

/** R12: CLAUDE.md / MEMORY.md re-read on every turn; the part past a lean size, priced at cache-read rates. */
function instructionSize(input: CoachInput): Draft | null {
  const files = input.instructions ?? [];
  if (files.length === 0) return null;
  const tokensFor = (project: string): number =>
    files
      .filter((file) => file.project === null || file.project === project)
      .reduce((total, file) => total + file.tokens, 0);
  let usd = 0;
  for (const [key, rollup] of input.rows) {
    const parts = parseRowKey(key);
    const rates = ratesFor(parts.model, parts.speed === "fast");
    const over = tokensFor(parts.project) - LEAN_INSTRUCTION_TOKENS;
    if (parts.scope !== "main" || rates === null || over <= 0) continue;
    usd += tokensCost(over * rollup.turns, rates.cacheRead);
  }
  if (usd === 0) return null;
  const largest = [...files]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
    .map((file) => `${file.path} ~${String(Math.round(file.tokens / 100) / 10)}k`);
  return {
    id: "R12",
    usd,
    evidence: `re-read every turn: ${largest.join(", ")} tokens`,
    fix: {
      kind: "habit",
      text: "Trim CLAUDE.md and MEMORY.md; move rare detail into files read on demand",
    },
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
  unusedMcp,
  cacheChurn,
  instructionSize,
];

/**
 * Every rule over the window, ranked: active before snoozed, then $ descending (no $ first: R8 is urgent),
 * at most 10. A finding with a $ under MIN_FINDING_USD is dropped.
 */
export function coach(input: CoachInput): ReadonlyArray<Finding> {
  const nowIso = input.now.toISOString();
  return RULES.map((rule) => rule(input))
    .filter((draft): draft is Draft => draft !== null)
    .filter((draft) => draft.usd === null || draft.usd >= MIN_FINDING_USD)
    .map((draft): Finding => {
      const until = input.snoozed[draft.id];
      const info = ruleInfo(draft.id) as RuleInfo;
      return {
        ...draft,
        title: info.title,
        why: info.why,
        action: info.action,
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
