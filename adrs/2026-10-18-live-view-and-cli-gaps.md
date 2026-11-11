# 2026-10-18 - `live` meters, session burn-up, efficiency and the last CLI gaps before the mod

## Status

Accepted

## Context

The handoff for the `/cost-tracker` mod (2026-10-15) listed the CLI work as
done, but the 2026-10-10 analysis still had CLI gaps (G4 efficiency, G5
burn-up, G7 initial-context tax, G14 memory size, R7, limit allowance and
milestones, work-week runway, last miss cause, web search $). The user asked
for full, real-time cost visibility with bars and meters before the mod, and
chose a CLI `live` view first, account-wide.

## Decision

- `cc-daily-usage live`: a full-screen terminal view of every session active in
  the last 30 minutes, built from the transcripts it tails (not from statusline
  payloads), so subagents and sessions without our statusline count. Read-only:
  in-memory offsets, no index write, no network in the process.
- The per-session model, the frame and the meters are pure and Node-free
  (`src/session-model.ts`, `src/live-render.ts`, `src/meter.ts`), so the mod
  reuses them instead of forking the logic.
- Cache state in `live` is estimated from the transcript (TTL after the last
  main turn); it is labelled an estimate.
- `insights` stays: it produces the advice that `live`, the statusline and the
  mod show.
- `report --session` computes a session's burn-up on demand from its files; no
  new storage. `report --chart` draws stacked bars per row.
- The index keeps the efficiency split per turn (antiburn's new work / carry /
  rewrite) and MCP facts per session; new fields, no version bump. Lines
  already indexed are not re-read: older rows and sessions have no split and no
  MCP facts. The index is never rebuilt silently.
- New coach rules: R7 unused MCP servers (instructions sizes from
  `mcp_instructions_delta`; a floor, tool definitions are not in the
  transcript), R11 cache churn (antiburn check 9, multiple ≥ 2.35), R12 large
  instruction files (CLAUDE.md / MEMORY.md over 2,000 tokens).
- Limits: 29 days of samples; a typical peak (median top % of finished windows)
  and 75/90/100 % crossings derived from samples with no stored state (the mod
  keeps which ones it toasted). The 7-day runway counts only work days when
  `laboralDays` are set. No OS notifications.
- The statusline `cache` part names a miss's causes for two minutes after it.
  This changes the 2026-10-10 prompt-cache choice of "no miss cause on the
  line" for that short window only.
- Web searches are priced at $10 per 1,000 (claude-api skill, 2026-10-18); web
  fetch has no listed fee and stays a count.

## Options considered

| Option                                 | Why not / why                                                        |
| -------------------------------------- | -------------------------------------------------------------------- |
| Build the live view only in the mod    | Only inside Claude Code, and blocked on the mod API spike            |
| `live` from statusline payloads        | Misses subagents, headless runs and sessions without our statusline  |
| Store burn-up points in the index      | A new file per session; computing from one transcript is fast enough |
| Store milestone state in `limits.json` | Derivable from samples; the consumer owns "already shown"            |
| Rebuild the index for the new fields   | Transcripts may be pruned by Claude Code; history could be lost      |

## Consequences

- `limits.json` holds up to 2,000 samples over 29 days; the render reads it.
  Measured render time did not change beyond noise.
- R7 and R11 fire only on sessions and rows indexed from 2026-10-18.
- The calendar imports `src/report.ts` for the day detail (`d`).

## Verification

Specs: `src/meter.spec.ts`, `src/session-model.spec.ts`,
`src/live-render.spec.ts`, `src/live-tui.spec.ts`, `src/session-report.spec.ts`,
`src/rules.spec.ts`, `src/limits-history.spec.ts`, `src/report.spec.ts`,
`src/transcript-index.spec.ts`. Manual plan section Q.
