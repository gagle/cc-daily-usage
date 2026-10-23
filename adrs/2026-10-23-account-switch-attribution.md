# 2026-10-23 - Book a session's spend to the login it ran on

## Status

Accepted

## Context

A `/login` in one terminal changes the login of every running Claude Code
process. There is one Keychain entry and one `oauthAccount` in
`~/.claude.json` per machine. The 2026-03 Claude Code source
(`src/utils/auth.ts`, `invalidateOAuthCacheIfDiskChanged`) re-reads the
credentials so that other terminals follow a `/login`. So a running session
really moves to the new account. It is not only the display.

The statusline payload has no account field. The render reads the login from
`~/.claude.json` on every call and scopes all data by `accountKey()`. The
per-session baselines (`lastSeenCost`, `cacheMissUsd`, `missCounts`) were per
account. Evidence from one machine on 2026-10-22, after a `/login` at 08:48:30Z:

- A session that was new to the enterprise account booked its full cumulative
  cost as new enterprise spend. At least $80.92 of Pro spend went into the
  enterprise `apiEqDays`.
- 19 session ids were in the `sessions-map.json` of both accounts. The
  transcript index gave each whole session to one account (whichever one
  `readdir` listed last).
- The first payloads after the switch still had the old account's
  `rate_limits`.
- The user did not see the switch, because the `/login` was typed in another
  terminal.

## Decision

- Each $ delta goes to the login active when it was spent. The cost baseline
  belongs to the session, not to the account.
- `account-log.json` (global, `{ t, key }[]`, 35 days plus the newest older
  entry): the render appends the login when it differs from the last entry. A
  `CLAUDE_CODE_OAUTH_TOKEN` override never writes it.
- `takeOverSession`: when this account has no entry for the session, or has
  not seen it since the last switch to this account, the newest sighting under
  another account becomes the baseline.
- The hook's `rate_limits` are ignored until the session's cost moves after
  the takeover (`switchCost`).
- `⇄ <email>` starts the line for 10 minutes after the takeover (`switchedAt`).
- Transcript index: a session that several accounts know goes, turn by turn, to
  the login at the turn's time. A line with no time, or a time before the log,
  goes to the account that saw the session last.
- Data recorded before this change stays as it is (no backfill).

## Options considered

| Option                                         | Why not / why                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Pin each session to its first account          | Wrong: after a `/login` the session really bills the new account                       |
| Global per-session baseline file               | One more write on every render; the switch is rare                                     |
| Switch log + baseline taken over on a switch   | Chosen: small read per render; other accounts read only on a takeover                  |
| Backfill the log from `history.jsonl` `/login` | Not chosen: `/login` lines do not say which account; past `apiEqDays` stay approximate |

## Consequences

- No more $ moves from one account to another at a switch. Each account's API-equivalent $, cache-miss $, limit
  samples and report are its own.
- Every render reads `account-log.json`. A takeover also reads the other
  accounts' `usage.json` until the session's cost moves.
- Gap: Claude Code keeps the old token for a short time after a `/login` (30 s
  in the 2026-03 source, not checked for later versions). A turn in that gap
  goes to the new account.
- Lines in the index with no time (turn duration, hooks, MCP) of a session that
  switched go to the account that saw the session last.

## Verification

- `src/statusline.spec.ts` "account switch": each account books only its own part,
  the old limits are ignored, the marker shows and then goes, a per-terminal token writes no log.
- `src/transcript-index.spec.ts`: a session a `/login` moved is split by turn time.
- `src/account.spec.ts`, `src/config.spec.ts`: log rules and file I/O.
- Manual test plan F4, F7, F8.
