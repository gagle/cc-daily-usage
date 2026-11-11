# 2026-10-15 - Read local transcripts into an index

## Status

Accepted

## Context

The statusline sees one session's total cost. "Where did the money go" needs
$ per model, project, subagent and component. Claude Code writes every model
response with its `usage` to `~/.claude/projects/**.jsonl`, subagents to
`<session>/subagents/agent-*.jsonl` with the agent type in `.meta.json`.
A check of real files on 2026-10-15 showed each response line repeated once
per content block with the same `requestId`, `message.id` and usage.

## Decision

- Read transcripts locally, incrementally from saved byte offsets, in the
  refresher (bounded: 8 MB or 2 s) and in `report` (full catch-up). Never in
  the render.
- Dedupe on `requestId|message.id`; price with `src/pricing.ts`; keep
  token counts and metadata only, no message text.
- Roll up per local day × project × model × scope × speed into monthly files
  per account; sessions with no known account go to `unattributed`.
- Self-check against the statusline's own session cost; a gap over 5% names
  the models whose price may be stale. Prices stay a static table (no new host).

## Options considered

| Option                     | Why not / why                                                        |
| -------------------------- | -------------------------------------------------------------------- |
| Statusline-only data       | No per-model or per-subagent split, misses `-p` and desktop sessions |
| Scan whole files each time | Transcripts grow to many MB; offsets make a repeat pass read 0 bytes |
| Fetch prices from a URL    | A new network host; the self-check flags drift instead               |

## Consequences

- A privacy note in the README: local read of `~/.claude/projects`.
- Format changes in transcripts can break counts; unknown lines are ignored
  and the self-check shows drift.
- The coach (CLI-9) builds on these rollups.

## Verification

`src/transcript-parse.spec.ts`, `src/transcript-index.spec.ts`,
`src/report.spec.ts`, manual plan section N.
