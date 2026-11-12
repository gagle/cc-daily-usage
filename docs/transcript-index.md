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
owner = account whose sessions-map.json has the session id, else "unattributed";
        a session several accounts know: the login at the turn's time
        (account-log.json), else the account that saw it last
        ▼
<owner>/index/YYYY-MM.json  rows: day × project × model × scope × speed → Rollup
<owner>/index/sessions.json session → totals, first/last time, project, branch, models,
                            turnMs, thinkingMs, hookRuns, entrypoint, mcpLoaded, mcpUsed,
                            attributedUsd, apiErrors, ccRuns
```

- Offsets live in `~/.config/cc-spend/index/offsets.json` with the size,
  mtime, the last 64 dedupe keys and the last turn's context (`context`) per
  file. The offset of a transcript no longer listed (Claude Code deleted it) is dropped. An unchanged file is skipped; a
  file smaller than its offset was rewritten and is read from the start.
- A pass starts no new file after 8 MB or 2 s (`PASS_BYTES`, `PASS_MS`); the
  rest is `bytesBehind` in `index/last-pass.json`. `catchUp` has no budget.
- One pass at a time: `index/index.lock` (stale after 2 min).
- A response that took several API requests carries `usage.iterations`; the
  top-level counts are their sum. `priceTurn` prices each request on its own
  (Haiku 5.5's long-prompt tier goes by one request's prompt), and
  `contextTokens` is the last request's prompt, not the sum.
- `usage.speed` "fast" and `usage.inference_geo` "us" select the fast and the
  1.1× US-only prices (see `docs/prompt-cache.md`).
- Re-price: `index/prices.json` holds the `PRICES_VERSION` (`src/pricing.ts`)
  the index was built at (the price date, plus `.N` for a rebuild with no
  price change). When a pass finds an older one (or none, with an
  index present), it copies every owner's index to
  `index/backup-prices-<old>/`, empties it, and rebuilds it from all
  transcripts in that pass, unbounded, keeping the lock fresh. Rows and
  sessions the rebuild did not produce (their transcripts are gone) come back
  from the copy at the prices they were stored with; a rebuilt row with fewer
  turns than before (a deleted transcript shared it, `rowsShort`) gets the
  missing part back (`missingPart`): exact token and turn counts, the main $
  fields at the old row's own $ per token. The
  result is in `last-pass.json` (`repriced`). A crashed re-price restarts from
  the copy. A newer `PRICES_VERSION` is never re-priced down.
- Attribution: `attributionSkill` and `attributionMcpServer` on a priced line
  (Claude Code's own, not in the public docs) add that turn's $ to the
  session's `attributedUsd` under `skill:<name>` / `mcp:<server>`.
- API errors (`parseApiError`): `<synthetic>` lines with `isApiErrorMessage`
  count per session in `apiErrors`, keyed `<apiErrorStatus> <apiError>`
  (`429 usage_limit_reached`), deduped like turns.
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

`cc-spend report [today|week|month|30d|YYYY-MM] [--by model|project|component|subagent|session|day] [--chart] [--json] [--account <key|unattributed>]`

`cc-spend report --session <id or prefix> [--json]`

- Ranges are local days: `week` = rolling 7 days, `month` = local month to date.
- Columns: input, output, cache read, cache write, total; footer with the
  subagent share, thinking $, web searches, turn time (thinking time), hook
  runs and how sessions started (`entrypoint` counts), the unattributed $ and
  the "API-equivalent estimate" label, the top 5 attributed skills and MCP
  servers by $ ("Attributed by Claude Code"), API errors by kind, and the
  efficiency line (new work /
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
- Claude Code's own cost (`parseCostState`): the `cost-state` line Claude
  Code writes when a run ends (not in the public docs) holds the run's
  `totalCostUSD`, its `startTime` and per-model tokens and $ (`modelUsage`).
  The session keeps one entry per run in `ccRuns`, keyed by `startTime`; a
  later reading of the same run replaces a smaller one (the total only
  grows). A resumed session starts a new run at $0.
- Self-check (`selfCheck`): per run and model in range, Claude Code's $
  against the same tokens at the table's prices (cache writes with no TTL
  split at the 5m rate, as Claude Code bills them). A gap over 1% on more than
  5 cents prints "Claude Code prices <model> N% higher|lower than this table: a
  price change, or fast mode." Haiku 5.5 is skipped: its price goes by each
  request's prompt size.
- `claudeCodeTotals`: for the sessions in range that Claude Code counted whole
  (a run starts no later than the first turn, and the runs add up to at
  least the transcripts' $), its total next to the index's. The report says
  how much more it counted: requests no transcript line records.

## Shared modules

The mod bundles Node-free modules. `src/node-free.spec.ts` fails when one of
them (or anything it imports) uses a `node:` module or a package.
