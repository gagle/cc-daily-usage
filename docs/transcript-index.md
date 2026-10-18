# Transcript index and `report`

Where the per-model, per-project, per-subagent $ comes from. Local files only,
never on the render path.

## Reader (`src/transcript-index.ts`, `src/transcript-parse.ts`)

```
~/.claude/projects/<project>/<session>.jsonl                      scope main
~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl    scope subagent:<agentType from .meta.json>
        │  bytes past the saved offset, complete lines only
        ▼
parseTurn ─ assistant lines with message.usage (not <synthetic>)
        │  dedupe on requestId|message.id (Claude Code repeats the line per content block)
        ▼
priceTurn ─ src/pricing.ts; 5m and 1h cache writes priced apart; speed "fast" doubles
        ▼
owner = account whose sessions-map.json has the session id, else "unattributed"
        ▼
<owner>/index/YYYY-MM.json  rows: day × project × model × scope × speed → Rollup
<owner>/index/sessions.json session → totals, first/last time, project, branch, models,
                            turnMs, thinkingMs, hookRuns, entrypoint, mcpLoaded, mcpUsed
```

- Offsets live in `~/.config/cc-daily-usage/index/offsets.json` with the size,
  mtime, the last 64 dedupe keys and the last turn's context (`context`) per
  file. An unchanged file is skipped; a
  file smaller than its offset was rewritten and is read from the start.
- A pass starts no new file after 8 MB or 2 s (`PASS_BYTES`, `PASS_MS`); the
  rest is `bytesBehind` in `index/last-pass.json`. `catchUp` has no budget.
- One pass at a time: `index/index.lock` (stale after 2 min).
- An unknown model counts tokens with no $ (`unpricedTurns`); totals that
  include one are a floor (`feed.json.spend.isFloor`).
- Thinking $ is the output $ share of `thinking_tokens` (an estimate).
- Web searches are priced at $10 per 1,000 (`WEB_SEARCH_USD`) on any model;
  web fetches stay a count (no fee of their own).
- Efficiency split (`splitTurn`, antiburn's): per thread (file), a turn's
  cache-read $ is carry; its fresh input (input + cache write) that grows the
  context past the thread's previous turn is new work, the rest a rewrite;
  output is new work. Rollups add `growth` (context growth + output),
  `freshSplit`, `rewriteTokens`, `usdNewWork`, `usdCarry`, `usdRewrite`. A file
  resumed from an offset with no saved `context` skips the split for one turn;
  rows indexed before 2026-10-18 read these as 0 (`loadRollups` fills missing
  fields).
- MCP (`parseMcpLoad`, `mcpServersUsed`): an `mcp_instructions_delta`
  attachment gives the servers whose instructions entered context and their
  size (4 characters per token) → `mcpLoaded`; every copy of an assistant line
  is read for `mcp__<server>__` tool uses → `mcpUsed`. Names are matched in
  Claude Code's tool-prefix form (`plugin:figma:figma` → `plugin_figma_figma`).
  Servers with no instructions and tool definitions are not in the transcript.
  Lines already indexed are not read again, so older sessions have none.
- Time and hooks (`parseActivity`): `system` lines `turn_duration`
  (`durationMs`) add `turnMs`, `stop_hook_summary` (`hookCount`) add
  `hookRuns`; an assistant line's `thinkingDurationMs` (on the first copy of
  the message, so the dedupe keeps it) adds `thinkingMs`; the first turn's
  `entrypoint` (cli, sdk-ts, …) is kept. System lines only extend a session the
  index already has. Sessions indexed before these fields read as zero.
- Index files carry `schemaVersion` 1 and follow the downgrade guard in
  `docs/data-model.md`.

## When it runs

| Caller                                       | Pass                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| refresher (`runRefresh` in `src/refresh.ts`) | one bounded pass after the API call, before `feed.json` |
| `report`                                     | `catchUp`, then rebuilds `feed.json`                    |
| render                                       | never                                                   |

## `report` (`src/report.ts`)

`cc-daily-usage report [today|week|month|30d|YYYY-MM] [--by model|project|component|subagent|session|day] [--chart] [--json] [--account <key|unattributed>]`

`cc-daily-usage report --session <id or prefix> [--json]`

- Ranges are local days: `week` = rolling 7 days, `month` = local month to date.
- Columns: input, output, cache read, cache write, total; footer with the
  subagent share, thinking $, web searches, turn time (thinking time), hook
  runs and how sessions started (`entrypoint` counts), the unattributed $ and
  the "API-equivalent estimate" label, and the efficiency line (new work /
  carry / rewrite shares and $ per MTok of new work with its band: good under
  $33, high over $80; only rows with the split count). `--by session` labels a
  row with Claude Code's session name when `sessions-map.json` has one, shows
  its parts as — (the index keeps a session's total only), and adds "% of week"
  (`usd ÷ usdPerPercentWeek`) and "$/100 lines" (lines changed from
  `sessions-map.json`).
- `--chart`: a stacked bar per row (input, output, cache read, cache write, web
  search), scaled to the largest row; `--by day` then lists days in time order.
- `--session` (`src/session-report.ts`): finds the one session whose id starts
  with the argument (main file and subagent files), reads them whole through
  the session model (`docs/live.md`) and prints $ per time slot, the running
  total, event marks (`!` cold re-write, `C` compaction, `S` subagent start) and
  where the $ went. Several matches → an error listing them.
- `dayBreakdown(owner, day)`: one local day's $ with the top 3 sessions (last
  active that day), models and projects; the calendar's `d` key shows it.
- Self-check (`selfCheck`): per session in range with no unpriced turn, index
  $ vs the statusline's last `cost.total_cost_usd`; a gap over 5% (and over a
  cent) prints "price table may be stale for <model>".

## Shared modules

The mod bundles Node-free modules. `src/node-free.spec.ts` fails when one of
them (or anything it imports) uses a `node:` module or a package.
