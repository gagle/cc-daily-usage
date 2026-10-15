# Architecture

How `cc-daily-usage` is put together: module map, data flow, multi-account
model, and the `hasSpendCap` branch that decides whether dollar-cap tracking
runs at all. Runtime dependencies: none (Node built-ins only).

## System context

```
                 +-----------------------------+
   +--------+    |        cc-daily-usage       |    +-------------------+
   |  User  |<-->| CLI + statusline + terminal |<-->| Anthropic API     |
   +--------+    |          calendar           |    | /api/oauth/usage  |
                 +-----------------------------+    | /api/oauth/profile|
                    ^                    |          +-------------------+
                    |                    v               ^ (detached
             +-------------+     +----------------+      |  refresher only)
             | Claude Code |     |  Filesystem    |------+
             | statusline  |     | ~/.config/cc-  |
             | stdin JSON  |     | daily-usage/,  |
             +-------------+     | ~/.claude/     |
                                 +----------------+
```

The render path never touches the network. A detached `--refresh` process
fetches `/api/oauth/usage` (read-only, no model call, no tokens) and writes
`api-cache.json`; renders read it.

## Why these decisions

- **One process per render, no network on it.** The installed shim imports
  `src/statusline.ts` in-process. Branch comes from `.git/HEAD`
  (`src/git.ts`), not a `git` spawn. See `docs/performance.md`.
- **Stale-while-revalidate for API data.** `requestApiRefresh` in
  `src/refresh.ts` spawns at most one refresher per account per TTL (lock
  file). The fresh reading shows on the next render; `statusLine.refreshInterval`
  (fixed 30 s; the render never writes `settings.json`) makes that next render
  happen while idle. ADR:
  `adrs/2026-10-10-session-start-usage-refresh.md`.
- **Two clocks.** Days are local; the budget period is the UTC month (the
  ledger's). See `docs/time-model.md` and
  `adrs/2026-10-10-two-clock-day-model.md`.
- **`calc.ts` mutates `UsageState` in place.** One writer per render; a
  copy-on-write style only adds allocation.
- **Derived, not stored:** today's max (`computeAvgPerDay`) is computed every
  call, so a cap change or a laboral-day change applies at once.
- **`hasSpendCap` self-heals.** `organizationType` wins when known;
  `rate_limits` may demote an _unrecognized_ org's dollar guess to false, never
  a known enterprise/team classification.
- **Atomic writes.** Every JSON file goes through `writeFileAtomic` in
  `src/config.ts` (temp file + rename). A killed render (Claude Code cancels
  in-flight statusline runs) never leaves a half-written file.

## Module map

```
cli.ts                 operation dispatch; every operation lazy-imports its modules
statusline.ts          render pipeline: account → config/usage → calc → state (hot path)
statusline-render.ts   pure (payload, state, branch) → ANSI line
refresh.ts             lock + detached --refresh spawn; the refresher body
anthropic-usage.ts     token resolution, /api/oauth/usage + profile fetch, cache helpers
account.ts             identity (~/.claude.json, token-override profile cache), accountKey()
config.ts              per-account JSON persistence, atomic writes, legacy migration
calc.ts                pure budget math (rollover, ledger, pace)
clock.ts               local-day / UTC-period helpers
cache-forecast.ts      prompt-cache next-prompt cost prediction
pricing.ts             per-model $/MTok table and cache multipliers
git.ts                 branch from .git/HEAD
calendar-tui.ts        dependency-free terminal calendar (pure render + reducer + IO loop)
notice.ts              boxed terminal notices (calendar on Pro/Max)
statusline-install.ts  install / upgrade / uninstall of the shim
statusline-shared.ts   installer helpers, settings.json merges (statusLine, hooks, subagentStatusLine), atomic settings write
statusline-capture-install.ts  capture-only fallback for a foreign statusline
subagent-line.ts       hidden --subagent-statusline: agent-panel rows (model, effort, tokens, context %)
```

## Data flow

**Statusline render (every Claude Code statusline update):**

```
Claude Code (stdin JSON)
  -> node ~/.claude/statusline.mjs          (shim from assets/statusline.mjs)
       import(<package>/dist/statusline.js) (same process)
       runStatuslineLine()
         -> parsePayload (garbage → {})
         -> resolveActiveAccount() -> accountKey()
         -> loadConfig / loadUsage (upgradeUsage) / loadApiCache
         -> classify hasSpendCap, merge hook rate_limits (seenAt)
         -> rolloverIfNeeded -> captureSessionCost -> applyLedgerReading
         -> forecastCache (prompt_cache) ; saveUsage (skipped when unchanged)
         -> requestApiRefresh (detached, at most once per TTL)
         -> renderStatusline(payload, state, readGitBranch(cwd))
  <- ANSI on stdout: row 1, prompt-cache row 2
```

Shims installed by older versions still spawn `cc-daily-usage --statusline`
and render the JSON themselves; that mode is kept.

**Refresher (`cc-daily-usage --refresh <key>`, detached):**

```
resolveOAuthAccessToken (env → macOS Keychain → ~/.claude/.credentials.json)
  -> GET /api/oauth/usage -> nextApiCache (failure keeps last reading, stale,
     failures + 1: the next try waits 60 s × 2^failures, at most 16 min)
  -> GET /api/oauth/profile when the plan is a day old (after a good usage read)
  -> accounts/<key>/api-cache.json -> index pass -> feed.json ; remove refresh.lock
```

**`init`:** statusline install prompt → (Team/Enterprise) offer Mon–Fri for
this and next month → open the calendar on a TTY. Pro/Max stop after the
statusline.

**`calendar`:** plan gate (`classifyHasSpendCap`, else the hook's cached
`hasSpendCap`) → Pro/Max/unknown print a notice from `src/notice.ts` and
exit → Team/Enterprise open `runCalendarTui`. The calendar re-reads files every
poll, applies the ledger in memory and requests a refresh, so an admin limit
change shows without a running session.

## Multi-account model

Every account is scoped by `accountKey()` under
`~/.config/cc-daily-usage/accounts/<key>/`:

- `accountKey()` sanitizes the OAuth account's email into a filesystem-safe key.
- `"default"` is used when there is no OAuth account at all.
- A `CLAUDE_CODE_OAUTH_TOKEN` override resolves its account through
  `/api/oauth/profile` once per token; the result is cached in
  `~/.config/cc-daily-usage/profiles.json` under a token hash.
- A one-time migration moves pre-multi-account files into `accounts/legacy/`.

## `hasSpendCap` branching

| `organizationType`                 | `hasSpendCap` (dollar self-budget)        |
| ---------------------------------- | ----------------------------------------- |
| `claude_enterprise`, `claude_team` | `true`                                    |
| `claude_pro`, `claude_max`         | `false`                                   |
| anything else / unknown            | guessed: `true`, demoted by `rate_limits` |

Statusline display: Pro/Max show `⏱` (+ `🎫` when usage credits exist);
budget plans show `$today/$max` and `$month/$cap`. Both show the `🔥`/`❄` cache
segment and the gateway `💳` spend limit when present.
