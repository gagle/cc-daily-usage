import type { Feed } from "./feed.js";
import { cacheWriteRate, ratesFor } from "./pricing.js";
import {
  cacheState,
  costPerMTok,
  MTOK_BAD,
  MTOK_GOOD,
  type SessionModel,
  sessionUsd,
} from "./session-model.js";

/**
 * The live advisor: how one session compares with a lean one (scorecard) and what to do now (tips with the $
 * at stake). Pure and Node-free: `live` and the /cost-tracker mod share it. Targets are rules of thumb.
 */

export type ScoreStatus = "good" | "fair" | "bad";

export interface Score {
  readonly label: string;
  readonly fraction: number; // 0-1, for the bar
  readonly value: string; // "91%", "$19"
  readonly target: string; // "≥ 90%"
  readonly status: ScoreStatus;
  readonly meaning: string; // one line: what the number is
}

/** Share of input tokens served from the cache: a lean session reads most of its context, writes little. */
export const CACHE_READ_GOOD = 0.9;
export const CACHE_READ_FAIR = 0.8;
/** Re-sending (antiburn's rewrite share): good under 10%, bad over 25%. */
export const RESEND_GOOD = 0.1;
export const RESEND_BAD = 0.25;
/** Re-reading (antiburn's carry share): good under 54%, bad over 57%. */
export const REREAD_GOOD = 0.54;
export const REREAD_BAD = 0.57;
/** Context past this is re-read on every turn at a cost worth acting on; past 200k it is "deep" (R5). */
export const CONTEXT_AIM = 150_000;
export const CONTEXT_DEEP = 200_000;
/** A tip worth less than this is noise. */
const MIN_TIP_USD = 0.05;
/** Warn this long before the cache goes cold. */
const COLD_SOON_S = 90;
/** 1h cache writes cost 2× input, 5m ones 1.25×: a 1h TTL adds this share to every write. */
const ONE_HOUR_EXTRA = 2 / 1.25 - 1;

const pctText = (fraction: number): string => `${String(Math.round(fraction * 100))}%`;
export const usd = (value: number): string => `$${value.toFixed(2)}`;
const kTok = (tokens: number): string => `${String(Math.round(tokens / 1000))}k`;

function lowerIsBetter(value: number, good: number, bad: number): ScoreStatus {
  if (value < good) return "good";
  return value > bad ? "bad" : "fair";
}

/** The scorecard of a session; empty before a priced turn. */
export function scorecard(session: SessionModel): ReadonlyArray<Score> {
  const total = sessionUsd(session);
  if (total <= 0) return [];
  const { input, cacheRead, cacheWrite } = session.tokens;
  const fed = input + cacheRead + cacheWrite;
  const reads = fed > 0 ? cacheRead / fed : 0;
  const resend = session.efficiency.rewriteUsd / total;
  const reread = session.efficiency.carryUsd / total;
  const scores: Array<Score> = [
    {
      label: "cache reads",
      fraction: reads,
      value: pctText(reads),
      target: `≥ ${pctText(CACHE_READ_GOOD)}`,
      status: reads >= CACHE_READ_GOOD ? "good" : reads >= CACHE_READ_FAIR ? "fair" : "bad",
      meaning: "input tokens read from the cache (cheap) instead of written (expensive)",
    },
    {
      label: "re-sending",
      fraction: resend,
      value: pctText(resend),
      target: `< ${pctText(RESEND_GOOD)}`,
      status: lowerIsBetter(resend, RESEND_GOOD, RESEND_BAD),
      meaning: "$ on context the model already had, written again (cold cache, model switch)",
    },
    {
      label: "re-reading",
      fraction: reread,
      value: pctText(reread),
      target: `< ${pctText(REREAD_GOOD)}`,
      status: lowerIsBetter(reread, REREAD_GOOD, REREAD_BAD),
      meaning: "$ on reading the history again each turn; long sessions push it up",
    },
  ];
  const perMTok = costPerMTok(session);
  if (perMTok !== null) {
    scores.push({
      label: "$ per MTok",
      fraction: Math.min(1, perMTok / (MTOK_BAD * 1.5)),
      value: `$${perMTok.toFixed(0)}`,
      target: `< $${String(MTOK_GOOD)}`,
      status: lowerIsBetter(perMTok, MTOK_GOOD, MTOK_BAD),
      meaning: "what each million tokens of new work (new context + output) cost",
    });
  }
  return scores;
}

/** Context status against CONTEXT_AIM / CONTEXT_DEEP. */
export function contextStatus(tokens: number): ScoreStatus {
  if (tokens < CONTEXT_AIM) return "good";
  return tokens >= CONTEXT_DEEP ? "bad" : "fair";
}

export interface Tip {
  readonly key: string;
  readonly usd: number | null; // at stake; null = time, not money (ranked first)
  readonly see: string; // what the numbers say now
  readonly act: string; // the exact action
  readonly why: string; // what makes it cost money
}

/** What to do now in this session, most urgent first (a limit about to run out, then by $ at stake). */
export function adviseNow(
  session: SessionModel,
  nowMs: number,
  feed: Feed | null,
  max = 3,
): ReadonlyArray<Tip> {
  const tips: Array<Tip> = [];
  const total = sessionUsd(session);
  const cache = cacheState(session, nowMs);

  const atRisk = (
    [
      ["5h", feed?.limits.fiveHour],
      ["7d", feed?.limits.sevenDay],
    ] as const
  ).flatMap(([name, window]) =>
    window?.verdict === "at-risk" && window.exhaustsAt !== null
      ? [
          `${name} in ${Math.max(0, (Date.parse(window.exhaustsAt) - nowMs) / 3_600_000).toFixed(1)} h`,
        ]
      : [],
  );
  if (atRisk.length > 0) {
    tips.push({
      key: "limits",
      usd: null,
      see: `At this pace your limits run out before they reset: ${atRisk.join(", ")}.`,
      act: "Move routine steps to Sonnet (/model sonnet), keep Opus for the hard ones; /compact long sessions.",
      why: "At the limit work stops until the reset; cheaper models and smaller contexts use less of it.",
    });
  }

  if (cache !== null && cache.context >= 20_000) {
    const premium = cache.nextColdUsd - cache.nextWarmUsd;
    if (cache.warm && cache.secondsLeft <= COLD_SOON_S && premium >= MIN_TIP_USD) {
      tips.push({
        key: "cold-soon",
        usd: premium,
        see: `The cache goes cold in ${String(cache.secondsLeft)} s: a prompt now costs ~${usd(cache.nextWarmUsd)}, after that ~${usd(cache.nextColdUsd)}.`,
        act: "Send the next prompt now. Stepping away? /compact first, so the restart re-writes less.",
        why: "A cold cache re-writes the whole context at 1.25-2x the input rate instead of reading it at ~0.1x.",
      });
    } else if (!cache.warm && cache.nextColdUsd >= MIN_TIP_USD) {
      tips.push({
        key: "cold",
        usd: cache.nextColdUsd,
        see: `The cache is cold: your next prompt re-writes ${kTok(cache.context)} tokens (~${usd(cache.nextColdUsd)}).`,
        act: "New task: /clear first (nothing to re-write). Same task: /compact first, then go on.",
        why: "After the TTL the cached context is gone; the next request writes all of it again.",
      });
    }
  }

  const colds = session.marks.filter((mark) => mark.kind === "cold").length;
  if (colds > 0 && session.coldUsd >= MIN_TIP_USD) {
    const extra = ONE_HOUR_EXTRA * Math.max(0, session.usd.cacheWrite - session.coldUsd);
    const longer = session.ttlSeconds === 300 && session.coldUsd > extra;
    tips.push({
      key: "breaks",
      usd: session.coldUsd,
      see: `${String(colds)} break(s) let the cache expire: ${usd(session.coldUsd)} spent writing context again.`,
      act: longer
        ? `Set "promptCacheTtl": "1h" in ~/.claude/settings.json: ~${usd(extra)} more on writes here instead of ${usd(session.coldUsd)}.`
        : "/compact before a break over the cache TTL, or finish the step before you leave.",
      why: "The 5-minute cache expires during short breaks; a 1-hour cache costs more per write but survives them.",
    });
  }

  if (cache !== null && cache.context >= CONTEXT_AIM) {
    const perTurn = cache.nextWarmUsd;
    const after = (perTurn * 50_000) / cache.context;
    tips.push({
      key: "deep",
      usd: perTurn * 100,
      see: `Context is ${kTok(cache.context)}: every turn and tool call re-reads it, ~${usd(perTurn)} each (~${usd(perTurn * 100)} per 100).`,
      act: `/compact at the next natural break (about 50k after: ~${usd(after)} a turn); new task: /clear.`,
      why: "Each request sends the whole history again; cost grows with context size, not with your prompt.",
    });
  }

  if (total > 0) {
    const writeShare = session.usd.cacheWrite / total;
    const resend = session.efficiency.rewriteUsd / total;
    if (writeShare > 0.3 && resend < RESEND_GOOD) {
      const rates = session.lastMain === null ? null : ratesFor(session.lastMain.model);
      const rate = rates === null ? "" : ` ($${String(cacheWriteRate(rates, "5m"))}/MTok here)`;
      tips.push({
        key: "new-context",
        usd: session.usd.cacheWrite,
        see: `Cache writes are ${pctText(writeShare)} of $: new context arrives fast${rate}.`,
        act: "Read file ranges or grep, not whole files; cut long command output (head, tail); do not paste big logs.",
        why: "Every new token is written to the cache once at 1.25x input (2x on 1h); less new text, fewer writes.",
      });
    }
    const reread = session.efficiency.carryUsd / total;
    if (reread > REREAD_BAD) {
      tips.push({
        key: "reread",
        usd: session.efficiency.carryUsd,
        see: `${pctText(reread)} of this session's $ re-reads its history.`,
        act: "/clear between unrelated tasks; /compact when a sub-task is done; one session per task.",
        why: "A long history is re-read on every turn; the same work in a fresh session reads far less.",
      });
    }
  }

  return tips
    .filter((tip) => tip.usd === null || tip.usd >= MIN_TIP_USD)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, max);
}

/** No $ ranks first: a limit running out is about time. */
const rank = (tip: Tip): number => tip.usd ?? Number.MAX_VALUE;

/** Splits `text` into lines of at most `width` characters at spaces. */
export function wrap(text: string, width: number): ReadonlyArray<string> {
  const lines: Array<string> = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines;
}
