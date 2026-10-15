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
  (0.05× Opus 5.5, 0.025× Fable 5.1), 5-minute write 1.25×, 1-hour write 2×.
- Claude Code reports it all in the statusline payload as `prompt_cache`
  (v2.1.251+): `warm`, `ttl`, `expires_at`, `recache_tokens_if_cold`,
  `miss_recache_tokens`, `hit_ratio`, `last_miss_cause` (not shown: the
  `$` figures already say what a miss costs).

## Formulas (`forecastCache`)

```
rates      = ratesFor(model.id, fast_mode)            (null → no segment)
writeRate  = input × (ttl == 1h ? 2 : 1.25)
warm       = prompt_cache.warm and (expires_at null or > now)
nextWarm   = context_window.total_input_tokens × cacheRead
nextCold   = recache_tokens_if_cold × writeRate        (null after /compact)
premium    = max(0, nextCold − nextWarm)               what letting it expire costs
sessionMiss= miss_recache_tokens × (writeRate − cacheRead)   already re-paid
hint       = warm and premium ≥ $1 → "break" ; cold and nextCold ≥ $1 → "clear" ;
             context ≥ 60% → "compact"
```

The forecast is the **input-side floor** the history alone costs on the next
prompt. Output tokens and the new prompt text are unknown in advance.

## Cost by context size (Opus 5.5, $4/MTok input)

| Context | Each message, warm (read 0.05×) | Miss, 5m TTL (1.25×) | Miss, 1h TTL (2×) |
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
🔥 cold in 4m · $0.10/msg · if cold +$2.40
❄ cold · next msg ~$2.45
```

- `$/msg` — what each message costs now with a warm cache (the table's first
  column for your context). `if cold +$` — the extra the next message costs if the cache goes cold
  first (expiry, `/model`); a forecast, not a miss that happened.
- No advice text and no miss cause on the line: they only widened it. Miss
  causes are booked per day (below) and feed the coach (`insights`).

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
commands always pass. State: `cacheGate` / `gateArmedAt` on the session in
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

`RATES` in `src/pricing.ts` is a dated snapshot of Anthropic list prices. An
unknown model id is unpriced (no segment) rather than guessed. Fast mode
doubles rates on the models that have it. The `# ponytail` note in the file
names the upgrade path (Claude Code's `modelPricing` setting, or a pricing
file).
