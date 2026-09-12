# Architecture

How `cc-daily-usage` is put together: module map, data flow, multi-account model,
and the `hasSpendCap` branch that decides whether dollar-cap tracking runs at all.

## System context (C4 L1)

```
                 +-----------------------------+
   +--------+    |        cc-daily-usage        |    +----------------+
   |  User  |<-->|  CLI + statusline + Ink TUI  |<-->| Anthropic API  |
   +--------+    +-----------------------------+    | (/api/oauth/    |
                    ^                    |          |  usage)         |
                    |                    v          +----------------+
             +-------------+     +----------------+
             | Claude Code |     |  Filesystem    |
             | (hook stdin,|     | ~/.config/cc-  |
             |  statusline |     | daily-usage/,  |
             |  render)    |     | ~/.claude/     |
             +-------------+     +----------------+
```

User runs the CLI or reads the statusline; Claude Code drives the hook that
triggers every statusline render; `cc-daily-usage` reads/writes its own
config+usage files under `~/.config/`, manages the installed statusline
script under `~/.claude/`, and calls Anthropic's usage API directly for
extra-usage credit reconciliation.

## Why these decisions

- **`calc.ts` mutates `UsageState` in place, never returns a new object.**
  The hook path re-reads/re-writes the same JSON file every render; a
  copy-on-write style would just add allocation and diffing work for no
  benefit, since there's only ever one writer per account and no concurrent
  readers to protect against.
- **`avgPerDay`/`safeMonthTotal` are frozen once per UTC day, not live.**
  Recomputing on every render would make the statusline's "$/day budget"
  number jitter as `monthlySpent` changes within the same day — freezing at
  day-start keeps it a stable target to spend against, at the cost of not
  reflecting same-day catch-up until midnight UTC. See `docs/calculations.md`.
- **`hasSpendCap` starts `undefined` and self-heals, instead of requiring
  explicit config.** `organizationType` from `~/.claude.json` isn't always
  present or trustworthy at first run; waiting for the first hook payload
  that actually carries Claude Code's own `rate_limits` field (a hard
  signal a Pro/Max plan has no dollar cap) avoids misclassifying an account
  from a stale or missing OAuth field.

## Module map

```
account.ts            identity/token resolution (OAuth account, keychain/plaintext token)
anthropic-usage.ts     Anthropic API calls (oauth profile, extra-usage credits, cached)
calc.ts                pure math, mutates its UsageState argument in place
config.ts              per-account JSON persistence, legacy single-account migration
cli.ts                 operation dispatch + hidden `--statusline` hook path
dashboard-tui.ts       Ink TUI app (calendar, cap edit, day edit)
statusline-shared.ts   installer utilities shared by both install paths below
statusline-install.ts        idempotent full install of assets/statusline.mjs
statusline-capture-install.ts  fallback capture-only install (no full statusline)
init-server.ts         loopback HTTP server backing assets/init-calendar.html
http-utils.ts          security utilities used by init-server.ts
```

`account.ts` → `anthropic-usage.ts` → `calc.ts` → `config.ts` is the read/compute/write
chain the statusline hook runs on every render. `cli.ts` is the entrypoint that wires
all of the above into the three user-facing operations.

## Data flow

**Statusline hook (every Claude Code render):**

```
Claude Code hook (stdin JSON)
  -> assets/statusline.mjs (installed into ~/.claude/statusline.mjs)
       spawns: cc-daily-usage --statusline
         -> runStatuslineHidden() in cli.ts
              -> resolveActiveAccount() (account.ts) -> accountKey()
              -> reads ~/.config/cc-daily-usage/accounts/<key>/{config,usage}.json
              -> rolloverIfNeeded(), captureSessionCost(), reconcileFromExtraUsageSnapshot() (calc.ts)
              -> writes usage.json back
              -> prints one JSON line to stdout
  <- statusline.mjs renders the ANSI line (bar, cost, rate limits, cc-daily-usage segments)
```

`dashboard-tui.ts` polls the same `config.json`/`usage.json` files independently every
2000ms — it does not talk to `cli.ts` or the hook path at all, just the filesystem.

**`init` operation:**

```
cc-daily-usage init
  -> runInit() starts a loopback-only HTTP server (init-server.ts)
  -> opens assets/init-calendar.html in the default browser
  -> user picks laboral days + monthly cap
  -> browser POSTs an InitPayload to the loopback server
  -> written to config.json
```

**`statusline` operation (installer):**

```
cc-daily-usage statusline
  -> installStatusline() (statusline-install.ts)
       stamps assets/statusline.mjs (content-hash version) into ~/.claude/statusline.mjs
       patches ~/.claude/settings.json to point statusLine.command at it
       idempotent: re-running detects the `// cc-daily-usage:managed v<hash>` marker
       and no-ops/upgrades instead of prompting or backing up again
```

## Multi-account model

Every account is scoped by `accountKey()` under
`~/.config/cc-daily-usage/accounts/<key>/`:

- `accountKey()` sanitizes the OAuth account's email into a filesystem-safe key.
- `"default"` is used when there is no OAuth account at all.
- A one-time migration moves any pre-existing single-account state into
  `accounts/legacy/` the first time multi-account support runs.

Never assume `"default"` — always resolve the key via `accountKey()`.

## `hasSpendCap` branching

`classifyHasSpendCap(organizationType)` (from `~/.claude.json`'s `oauthAccount.organizationType`):

| `organizationType`      | `hasSpendCap`            |
| ----------------------- | ------------------------ |
| `claude_enterprise`     | `true`                   |
| `claude_pro`            | `false`                  |
| anything else / unknown | `undefined` (unresolved) |

This self-heals: once any statusline hook payload carries Claude Code's own
`rate_limits` field (a subscription plan with 5h/7d request windows, not a
dollar-metered account), `hasSpendCap` is permanently set `false` for that account —
even if the initial `organizationType` guess said otherwise.

`hasSpendCap` gates whether `rolloverIfNeeded()`/`captureSessionCost()` run at all.
Pro/Max accounts (`hasSpendCap === false`) skip all dollar-cap math entirely and rely
solely on Claude Code's own `rate_limits` 5h/7d window display in the statusline —
see `docs/calculations.md` for what runs when it's `true`.

## Security model

`init-server.ts` (backing the `init` calendar picker) is loopback-only and hardened,
via `http-utils.ts`:

- `isAllowedHost()` — Host-header allowlist, loopback addresses only.
- `constantTimeEquals()` — constant-time token comparison (no timing side-channel).
- `readRequestBody()` / `BodyTooLargeError` — 256KB request body cap.
- Hardened response headers on every response.

See `docs/use-cases.md` for the full request flow this protects.
