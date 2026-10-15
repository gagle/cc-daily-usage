# 2026-10-15 - Safe settings writes, fixed refresh, more usage data

## Status

Accepted

## Context

A repo review found: `~/.claude/settings.json` was written in place, once on
the render path (`syncRefreshInterval` switched `refreshInterval` 30 ↔ 1 s
twice per cache cycle) while Claude Code cancels a running statusline when a
newer one starts; a failed usage fetch saved old % values with a new
`fetchedAt`, so they beat a newer hook snapshot; racing renders saved
`limits.json` samples out of time order; failed fetches retried every 60 s.
The live upstream docs and a live `/api/oauth/usage` response (2026-10-15)
showed data we did not read: `seven_day_breakdown` (Claude Code's share of the
week), `limits[]` severity, model weekly windows, dollar-metered windows, plan
facts from `/api/oauth/profile`, `spend_limit.used_usd/limit_usd/period`,
`session_name`, `version`, `subagentStatusLine`, and transcript time fields.
The limit warnings segment was also too long for one line.

## Decision

- Every `settings.json` write goes through `writeSettings` (temp file + rename,
  mode kept). The render never writes it: `refreshInterval` is a fixed 30 s,
  Claude Code re-runs the line at a cache `expires_at` and a limit `resets_at`;
  `statusline` puts an old 1 s value back to 30.
- A stale API reading only stands in when there is no hook snapshot.
- Limit samples are sorted by time on load.
- Failed fetches count `failures`; the TTL doubles per failure, up to 16 min.
- `$ per 1%` divides each rise by Claude Code's share of the week.
- The statusline shows dollar meters, Opus/Sonnet weekly windows, warns on a
  non-"normal" server severity, shows gateway dollars, and draws both window
  notices behind one icon with short times.
- The refresher reads the plan once a day; `doctor` shows it with the Claude
  Code version of the newest session.
- `statusline` installs a `subagentStatusLine` (kept when the user has one).
- The transcript index keeps turn time, thinking time, hook runs and the
  entrypoint per session; `report` prints them and labels sessions by name.

## Options considered

| Option                                                    | Why not / why                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the 1 s switch, only make the write atomic           | Still writes user settings twice per cache cycle from a process Claude Code kills; the gain is a seconds countdown in the last minute |
| Lock around every load → save                             | A lock on the render path costs every render for a race that only reorders or drops a sample                                          |
| Read `Retry-After`                                        | `fetchJson` returns null for any failure; exponential backoff covers 429 and dead tokens without new plumbing                         |
| Base logic on `extra_usage.daily/weekly`, `spend.balance` | Null on the observed account: no known shape, so not read                                                                             |
| Show every `seven_day_<key>` window                       | The API sends internal and codename windows; only opus and sonnet are shown, all are stored                                           |

## Consequences

- The countdown under a minute reads `<1m`.
- `/api/oauth/usage` stays undocumented; every new field is optional and a
  missing one changes nothing.
- One more process per agent-panel tick while subagents run.

## Verification

Manual test plan section P; specs named there.
