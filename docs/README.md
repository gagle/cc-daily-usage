# docs

Read this folder before the source — it is kept current by the drift gate
(`scripts/doc-drift.mjs`) and is cheaper than re-deriving behavior from `src/`.
`cc-daily-usage` is a zero-dependency CLI + statusline + terminal calendar that
keeps Claude Code spend predictable.

| Doc                                                          | Read it for                                                                    | Keywords                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------------- |
| [architecture.md](./architecture.md)                         | module map, render/refresher/init/calendar flows, multi-account, `hasSpendCap` | data flow, shim, refresher, accountKey |
| [time-model.md](./time-model.md)                             | local days vs the UTC budget period, month-edge behaviour per zone, v1 upgrade | timezone, rollover, periodFrozen       |
| [calculations.md](./calculations.md)                         | every formula in `src/calc.ts`                                                 | max per day, pace, ledger, capture     |
| [prompt-cache.md](./prompt-cache.md)                         | how prompt caching is billed and how the next-prompt cost is predicted         | cache miss, TTL, cold cache            |
| [data-model.md](./data-model.md)                             | files on disk, every persisted field, managed markers                          | schema, api-cache, uninstall           |
| [history-and-feed.md](./history-and-feed.md)                 | limit history, burn rate, $ per 1%, session map, `feed.json` for the mod       | runway, feed, cost-tracker             |
| [transcript-index.md](./transcript-index.md)                 | transcript reader, rollups, `report`, Node-free shared modules                 | transcripts, subagent, report          |
| [coach.md](./coach.md)                                       | coaching rules, `insights`, snooze, the coach part                             | advice, findings, savings              |
| [live.md](./live.md)                                         | `live` meters, the advisor (scorecard, do now), `report --session` burn-up     | real time, advisor, sparkline          |
| [use-cases.md](./use-cases.md)                               | each operation end-to-end, calendar keys, statusline segments                  | init, calendar, segments               |
| [performance.md](./performance.md)                           | measured timings and what keeps the hot paths fast                             | latency, startup                       |
| [testing-and-verification.md](./testing-and-verification.md) | coverage policy, commands, test layout, docs gate, CI                          | vitest, e2e, CI                        |

Decisions and the manual test plan: `adrs/README.md`. Vendored Claude Code
docs (reference only, not maintained here): `docs/claude-code-upstream/`.
