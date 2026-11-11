# Prompt-cache cost prediction

ADR: `adrs/2026-10-10-prompt-cache-cost-prediction.md`. Code:
`src/cache-forecast.ts`, `src/pricing.ts`, segment in
`src/statusline-render.ts`.

## How Claude Code's cache works (what we rely on)

Sources: `docs/claude-code-upstream/prompt-caching.md`,
`docs/claude-code-upstream/statusline.md`, the claude-api skill, antiburn's
cache-rehydration check.

- Caching is a **prefix match**: system prompt + tools + history. Anything that
  changes the prefix (model switch, effort change, fast mode on, MCP tool list
  change, `/compact`) makes the next request re-write the whole prefix.
- The cache **expires after inactivity** (TTL). Each hit resets the timer.
  Main conversation on a subscription within plan: `1h`; on usage credits /
  API key / cloud: `5m`. Subagents: `5m`.
- Prices per MTok, relative to the model's input rate: cache read ≈ 0.1×
  (0.05× Opus 5.5, 0.025× Fable 5.2 / 5.1), 5-minute write 1.25×, 1-hour write 2×.
- Claude Code reports it all in the statusline payload as `prompt_cache`
  (v2.1.251+): `warm`, `ttl`, `expires_at`, `recache_tokens_if_cold`,
  `miss_recache_tokens`, `hit_ratio`, `last_miss_at`, `last_miss_cause`.

## Formulas (`forecastCache`)

```
tail       = current_usage.input_tokens + output_tokens  (no current_usage → 0)
rates      = ratesFor(model.id, fast_mode, context + tail)   (null → ⚠ no-price warning)
writeRate  = input × (ttl == 1h ? 2 : 1.25)
warm       = prompt_cache.warm and (expires_at null or > now)
cached     = current_usage.cache_read_input_tokens + cache_creation_input_tokens
             (no current_usage → total_input_tokens)
nextWarm   = cached × cacheRead + tail × writeRate    read the prefix, write the last reply
premium    = min(recache_tokens_if_cold, cached) × (writeRate − cacheRead)
             (null after /compact)                    what letting it expire costs
nextCold   = nextWarm + premium
sessionMiss= miss_recache_tokens × (writeRate − cacheRead)   already re-paid
recentMiss = last_miss_cause.causes ("_" → " "), only within RECENT_MISS_S (120 s) of last_miss_at
hint       = warm and premium ≥ $1 → "break" ; cold and nextCold ≥ $1 → "clear" ;
             context ≥ 60% → "compact"
```

The forecast is the **input-side floor** the history alone costs on the next
API request. The next request reads the last request's cached prefix and
writes its fresh input and output (the `tail`); both are known, so both are
in `$/req`. The tail is written warm or cold alike, so it is not in the
premium. The new prompt or tool results are also written, but their size is
unknown in advance. Measured on 2,569 consecutive warm requests (2026-11-11):
97% read exactly the last cached prefix, and the forecast was a median 94% of
the real input-side cost (84% before the tail), above it in 3 cases. One
prompt can make many requests (each tool call is one), each paying `$/req`
again. Rates are list price (see Pricing table): on a subscription the $ is
API-equivalent, not billed.

## Cost by context size (Opus 5.5, $4/MTok input)

| Context | Each request, warm (read 0.05×) | Miss, 5m TTL (1.25×) | Miss, 1h TTL (2×) |
| ------- | ------------------------------- | -------------------- | ----------------- |
| 50k     | $0.01                           | $0.25                | $0.40             |
| 200k    | $0.04                           | $1.00                | $1.60             |
| 500k    | $0.10                           | $2.50                | $4.00             |
| 1M      | $0.20                           | $5.00                | $8.00             |

No long-context premium (the 1M window bills at standard rates), but every
tool step re-reads the whole context, and every miss re-writes it. The
statusline segment shows the row for the current context.

## Segment

Part 7 (`cache`) of the statusline layout (see `docs/use-cases.md`).

```
🔥 cold in 4m · $0.10/req · if cold +$2.40
❄ cold · next req ~$2.45 · miss: tools changed
```

- `$/req` — what each API request (each prompt and each tool step) costs now with a warm cache (the table's first
  column for your context). `if cold +$` — the extra the next request costs if the cache goes cold
  first (expiry, `/model`); a forecast, not a miss that happened.
- `2/14 req missed` — `prompt_cache.misses` of `requests` this session, when
  any; expected rebuilds (compaction, tool-result clearing) are not misses.
- `miss: <causes>` shows for two minutes after a miss (`recentMiss`), so the
  cause is on screen when the $ jumps; then the line is short again. No advice
  text. Miss causes are booked per day (below) and feed the coach
  (`insights`).

Color: warm fades green → yellow → orange with the share of the TTL left
(`warmColor` in `src/statusline-render.ts`); cold is red. The line re-renders
every 30 s and Claude Code re-runs it itself when the cache's `expires_at`
passes, so under a minute the countdown reads `<1m`. The render never writes
`settings.json`.

The calendar header sums `cacheMissUsd` of today's sessions as
"Cache re-paid today". Per local day, `usage.missCauses` keeps the count and $
of misses by cause (`prompt_cache.miss_causes`, Claude Code v2.1.260+); see
`addMissCauses` in `docs/calculations.md`.

## Prompt gate (`src/prompt-gate.ts`)

A `UserPromptSubmit` hook (`cc-daily-usage --prompt-gate`, installed by
`cc-daily-usage statusline`, removed by `uninstall`). When a prompt is sent
while the cache is cold and the re-send would cost at least
`promptGateMinUsd` (config, default $1, `0` turns it off), the prompt is
blocked — a blocked prompt is never sent, so it costs $0 — with the price and
the choices: send again within 2 minutes to go ahead, or `/clear`. Slash
commands always pass, and so does Claude Code's automatic continue after a
usage-limit reset (`AUTO_CONTINUE_PROMPT`, matched on "Your claude.ai usage
limit has reset."): blocking it ends the unattended wait, and after a limit
wait the cache is always cold, so the re-send cannot be avoided. Background-task and subagent notices
(`TASK_NOTIFICATION_PROMPT`, matched on `<task-notification>`) also pass: nobody is there to re-send them, so a
block drops the result. Known gap: a scheduled task or `/loop` firing with plain text has no marker in the hook
input and can still be blocked; set `promptGateMinUsd` to `0` in sessions that run one. State: `cacheGate` / `gateArmedAt` on the session in
`usage.json`, written by the statusline; no network.

## Model switch (`src/model-switch.ts`)

Each model has its own cache, so a switch re-sends the whole conversation
uncached: `context_tokens × new model input × (1.25 for 5m | 2 for 1h)`, paid
once, plus the old model's warm cache is lost. A `PreModelSwitch` hook
(`cc-daily-usage --model-switch`, installed and removed with the prompt gate)
reads Claude Code's own estimate, `estimated_cache_write_usd`; we do not
price it. `decideModelSwitch`:

- warm cache and estimate ≥ `promptGateMinUsd` (default $1, `0` = never ask)
  → `permissionDecision: "ask"` with target, tokens and `~$`.
- any other estimate ≥ $0.01 → `systemMessage` with the cost only.
- no estimate / under a cent → nothing; Claude Code's own flow.

The hook never fails a switch: errors print nothing and exit 0 (a timed-out
`PreModelSwitch` hook blocks the switch, so the timeout is 10 s).

## 1-hour TTL

`init` offers `"promptCacheTtl": "1h"` in `~/.claude/settings.json` when it is
unset. With a 5-minute TTL any break over 5 minutes is a full miss; with 1h,
writes cost 2× instead of 1.25×, but a turn writes only its new tokens, so
for large sessions with breaks it is far cheaper.

## Pricing table

`RATES` in `src/pricing.ts` is a dated snapshot of Anthropic list prices
(platform.claude.com pricing page), covering every model served in the last
6 months. An unknown model id is unpriced rather than guessed: the `cache`
part reads `⚠ <model id>: no price, $ not estimated`.

- Cache writes 1.25× input (5m) / 2× (1h). Cache reads 0.1× input, except
  Fable 5.2 / 5.1 and Mythos 5.2 / 5.1 (0.025×) and Opus 5.5 / Sonnet 5.5 (0.05×).
- Fast mode (`FAST_MODE_MULTIPLIER`) when `usage.speed` is `fast`: 2× on Fable /
  Mythos 5.2 and Opus 5.5 / 5 / 4.8; 6× on Opus 4.6 / 4.7 (archived fast-mode page), whose fast
  mode is removed, so the live forecast prices them standard
  (`fastModeBilled`).
- Haiku 5.5 over 100K prompt tokens (input + cache read + cache write): $0.50
  input, $0.05 read, $2.50 output. `ratesFor` takes the prompt size.
- `usage.inference_geo: "us"` in a transcript: 1.1× on every token price,
  stacked on the above. The statusline payload has no geo field, so the live
  forecast is at global prices.
- Claude Code's `modelPricing` (contracted rates) is not read.
