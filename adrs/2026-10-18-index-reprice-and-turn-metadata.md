# 2026-10-18 - Re-price the index; use more of the per-turn metadata

## Status

Accepted

## Context

`adrs/2026-10-18-exact-cost-formulas.md` changed prices, but rows already in
the transcript index kept the old $. Of 170 indexed sessions, 6 (about $60)
no longer have a transcript, so a plain rebuild would lose them. The
statusline payload and the transcripts carry data the CLI did not read:
`prompt_id`, `prompt_cache.requests` / `misses`,
`cost.total_api_duration_ms`, `attributionSkill` / `attributionMcpServer`,
and the API-error lines.

## Decision

- `PRICES_VERSION` in `src/pricing.ts`, stored in `index/prices.json`. An
  older version makes the next pass back up the index, rebuild it from every
  transcript, and restore rows and sessions the rebuild did not produce (see
  `docs/transcript-index.md`). The re-price only moves forward.
- Statusline: `$X · prompt $Y` (`trackPrompt`), `⏲ … · api …`, and
  `N/M req missed` in the cache part.
- Index: `attributedUsd` and `apiErrors` per session. The report shows the
  top attributed skills and MCP servers, and API errors by kind.

## Options considered

| Option                           | Why not / why                                               |
| -------------------------------- | ----------------------------------------------------------- |
| Leave old rows                   | Sonnet 5.5 cache reads stay at 2× the real price            |
| Drop and rebuild                 | Loses sessions whose transcripts Claude Code deleted        |
| Re-price rows from stored tokens | Rows lack the TTL split, per-request prompt size and geo    |
| Prompt $ from transcripts        | The statusline already has `prompt_id` and the session cost |

## Consequences

A row shared by a live and a deleted transcript is rebuilt from the live part
and gets the missing part back at the old row's own rates (`missingPart`). The
first run on a real index lost that part (516 `claude-sonnet-5` turns,
$53.63); it was re-run from `backup-prices-none/` after the fix. Kept rows stay
at the prices they were stored with.

The self-check compared the index with a session cost that `recordSession`
updated at most hourly, so it warned "price table may be stale" on correct
prices (this session: index $19.38, independent recount $19.80, Claude Code
$19.87; `sessions-map.json` held $15.56). The cost is now written when it
changes, and a sighting older than the last indexed turn is not compared.

The prompt gate blocked Claude Code's automatic continue after a usage-limit
reset, which ends the wait (interactive-mode docs). The continue prompt now
passes: the cache is always cold after a limit wait, so the re-send cannot be
avoided and nobody is there to confirm. It is matched on its first sentence,
which is not in the docs. The
attribution fields are not in the public docs; the report labels them as
Claude Code's.

## Verification

`src/transcript-index.spec.ts`, `src/report.spec.ts`, `src/calc.spec.ts`,
`src/statusline.spec.ts`, `src/statusline-render.spec.ts`; manual test plan
G15 to G17.
