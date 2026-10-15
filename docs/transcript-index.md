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
<owner>/index/sessions.json session → totals, first/last time, project, branch, models
```

- Offsets live in `~/.config/cc-daily-usage/index/offsets.json` with the size,
  mtime and the last 64 dedupe keys per file. An unchanged file is skipped; a
  file smaller than its offset was rewritten and is read from the start.
- A pass starts no new file after 8 MB or 2 s (`PASS_BYTES`, `PASS_MS`); the
  rest is `bytesBehind` in `index/last-pass.json`. `catchUp` has no budget.
- One pass at a time: `index/index.lock` (stale after 2 min).
- An unknown model counts tokens with no $ (`unpricedTurns`); totals that
  include one are a floor (`feed.json.spend.isFloor`).
- Thinking $ is the output $ share of `thinking_tokens` (an estimate).
- Index files carry `schemaVersion` 1 and follow the downgrade guard in
  `docs/data-model.md`.

## When it runs

| Caller                                       | Pass                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| refresher (`runRefresh` in `src/refresh.ts`) | one bounded pass after the API call, before `feed.json` |
| `report`                                     | `catchUp`, then rebuilds `feed.json`                    |
| render                                       | never                                                   |

## `report` (`src/report.ts`)

`cc-daily-usage report [today|week|month|30d|YYYY-MM] [--by model|project|component|subagent|session|day] [--json] [--account <key|unattributed>]`

- Ranges are local days: `week` = rolling 7 days, `month` = local month to date.
- Columns: input, output, cache read, cache write, total; footer with the
  subagent share, thinking $, web searches, the unattributed $ and the
  "API-equivalent estimate" label.
- Self-check (`selfCheck`): per session in range with no unpriced turn, index
  $ vs the statusline's last `cost.total_cost_usd`; a gap over 5% (and over a
  cent) prints "price table may be stale for <model>".

## Shared modules

The mod bundles Node-free modules. `src/node-free.spec.ts` fails when one of
them (or anything it imports) uses a `node:` module or a package.
