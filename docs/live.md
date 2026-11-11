# `live`, the session model and `report --session`

Real-time cost meters in a second terminal. `insights` looks back over a week
and writes advice; `live` shows where $ goes now and reads that advice. Both
stay: `live` shows the top finding that `insights` (or the refresher) wrote.

## Data flow

```
~/.claude/projects/**/<session>.jsonl  (written in the last 30 min)     accounts/<key>/feed.json
~/.claude/projects/**/<session>/subagents/agent-*.jsonl                  limits · spend · advice
        │ new bytes from an in-memory offset per file                         │ re-read when its mtime changes
        ▼                                                                     │
parseTurn / parseCompaction (src/transcript-parse.ts)                         │
        ▼                                                                     ▼
src/session-model.ts (pure) ── SessionModel ──► src/live-render.ts (pure) ── src/meter.ts (pure)
                                                        ▲
                         src/live-tui.ts (IO: alt screen, 1 s tick, ↑↓/j k, Tab view, q)
```

- Read-only: offsets live in memory, no index write, no network. At start it
  rebuilds `feed.json` once from local files (`writeFeed`) and, like the
  calendar, asks for a usage refresh when `api-cache.json` is past its TTL
  (the detached refresher; never in this process).
- Discovery (`discover`) every 5 s: transcripts written in the last 30 min
  (`ACTIVE_MS`), read from their start, so a session that began earlier shows
  its full cost. A shrunk file is read again; the turn-key dedupe drops repeats.
- Sessions with a turn in the last 30 min show, newest first.

## Session model (`src/session-model.ts`)

`addSessionTurn(session, turn, scope, thread)` per turn (a thread = one file):

| Kept                         | How                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| $ by component, model, scope | `priceTurn`; web search at $10 per 1,000                                                                                                                                                                                                                                                                              |
| points `{ ms, usd }`         | one per priced turn; `buckets` / `markBuckets` grid them                                                                                                                                                                                                                                                              |
| marks                        | `subagent` (first turn of a new subagent thread), `compact` (`compact_boundary`), `cold` (below)                                                                                                                                                                                                                      |
| cold re-write                | previous context of the thread ≥ 20k, cache read < half of it, cache write ≥ half of it; its cache-write $ is `coldUsd`                                                                                                                                                                                               |
| efficiency                   | `splitTurn` per thread (`docs/transcript-index.md`); `costPerMTok` = $ ÷ (context growth + output); `mtokBand` good < $33, high > $80                                                                                                                                                                                 |
| cache state (`cacheState`)   | estimate from the transcript only: warm for one TTL after the last main turn (1h when its write was 1h, else 5m); next warm = cached prefix × cache-read rate, cold = cached prefix × write rate, both + the last request's fresh input and output × write rate (rates with that turn's fast and US-only multipliers) |

An unpriced model counts in `unpricedTurns` with no $; its context still moves
the cache state, which then has no price (no CACHE row).

## Advisor (`src/advisor.ts`)

The default view of `live` (Tab switches to the details view). It answers
"is this session lean, and what do I do now". Pure and Node-free, so the mod
can show the same.

Scorecard (`scorecard`), each row a bar, your value, the aim, and ✔ / ~ / ✖.
The aims are rules of thumb, not limits:

| Row         | Value                                                                   | Aim (✔) | ✖ when |
| ----------- | ----------------------------------------------------------------------- | ------- | ------ |
| cache reads | cache-read tokens ÷ (input + cache read + cache write) tokens           | ≥ 90%   | < 80%  |
| re-sending  | rewrite $ ÷ $ (context sent again after a cold cache or a model switch) | < 10%   | > 25%  |
| re-reading  | cache-read $ ÷ $ (history re-read each turn)                            | < 54%   | > 57%  |
| $ per MTok  | $ ÷ (context growth + output) tokens                                    | < $33   | > $80  |
| context     | on the CONTEXT row of CACHE & CONTEXT: tokens of the last main turn     | < 150k  | ≥ 200k |

Cache writes are not all waste: every new token is written once. The waste is
writes of context the model already had (re-sending) and history re-read
turn after turn (re-reading, context size).

"Do now" (`adviseNow`): at most 3 tips, a limit running out first (no $), then
by $ at stake. Each tip says what the numbers show, the action (`→`) and why it
costs (`why:`):

| Tip         | When                                          | $ at stake                       | Action                                                                                                                                         |
| ----------- | --------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| limits      | a 5h or 7d window `at-risk` in `feed.json`    | none                             | routine steps on Sonnet, `/compact` long sessions                                                                                              |
| cold-soon   | cache warm, ≤ 90 s left, context ≥ 20k        | cold − warm price of next prompt | send now; `/compact` before stepping away                                                                                                      |
| cold        | cache cold, context ≥ 20k                     | next prompt's re-write           | new task: `/clear`; same task: `/compact` first                                                                                                |
| breaks      | cold re-writes happened                       | their cache-write $              | `"promptCacheTtl": "1h"` when the extra on writes (0.6 × other writes, 1h = 2x vs 1.25x) is under the re-writes; else `/compact` before breaks |
| deep        | context ≥ 150k                                | per-turn read × 100              | `/compact` at a break (about 50k after, with the per-turn price then); new task `/clear`                                                       |
| new-context | cache writes > 30% of $ with re-sending < 10% | cache-write $                    | read file ranges or grep, cut long output, do not paste big logs                                                                               |
| reread      | re-reading > 57%                              | cache-read $                     | `/clear` between tasks, `/compact` after sub-tasks, one session per task                                                                       |

Tips under $0.05 are dropped. `promptCacheTtl` is a Claude Code setting
(v2.1.242+, `docs/claude-code-upstream/settings-reference.md`).

## Frame (`renderLive`)

Sections, each a heading in bold and blocks under it; rows are
`name · bar · $ · %`, one bar per item so values compare by length. The
advisor view shows SESSIONS, the THIS SESSION header and sparkline, ADVISOR,
then the sections from CACHE & CONTEXT down; the details view replaces ADVISOR
with the blocks below:

```
SESSIONS          one row per active session: bar against the largest, $, ≈% of week, live / idle
THIS SESSION      $ · $/min · duration · turns; sparkline of the last 30 min ($ per minute)
  where it went   input, output, cache read, cache write (web search when used): bar = share of $
  models          top 4 models, share of $
  agents          main and the top 3 subagent types (when any ran), subagents started
  work            new work / re-reading / re-sending, and $ per MTok of new work with its band
  events          cold re-writes ($), compactions
CACHE & CONTEXT   cache countdown bar (or cold + re-write $), context bar (200k, or 1M past it)
LIMITS / BUDGET   5 hours and 7 days bars: %, rate, runway or "lasts past reset", verdict;
                  $ per 1% in the heading; typical peak and last crossing on a line below
SPEND             today, 7 days, month; then » the top finding (why and fix: insights)
footer            "API-equivalent estimate, not a bill" and the feed's age, or why there is none
```

Width: bars are 24 cells from 90 columns, 18 from 70, 12 from 60, else 8
(`barCells`); the sparkline is 30 buckets from 80 columns, 15 from 60, none
below. Height (`fit`): a blank line between blocks when the frame fits the
terminal rows, none when it does not, then a cut with "… a taller terminal
shows the rest"; the frame never scrolls the alternate screen. `--once` and
pipes print the spaced frame whole. `verdict` `insufficient-data` / `stale`
print words, never a number.

## `report --session` (`src/session-report.ts`)

Same model over one session's files read whole: header (project, branch,
turns, $, first → last time), $ per slot (10 to 60 slots across the session),
running total, an events row (`!` cold re-write, `C` compaction, `S` subagent
start), then the same bar blocks as `live` (`summaryBlocks`). `--json` prints the
model as plain data.

## Meters (`src/meter.ts`)

`bar` (cells colored by position, so a low value stays green; the statusline
context bar uses the same ramp, `gradientRgb`), `solidBar` (one color: a share
of a whole), `stacked` (largest-remainder
fill; each non-zero part keeps one cell while cells last; letters when color is
off), `sparkline` (8 levels, scaled to the largest value).
