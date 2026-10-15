# Architecture Decision Records

Decisions that shape cc-daily-usage, one file each, named
`YYYY-MM-DD-short-title.md`. Copy [`template.md`](./template.md) to start one.

ADRs are **append-only**: once accepted, a record is not edited to match later
code. A changed decision gets a new ADR that supersedes the old one (set the old
one's status to `Superseded by …`). That is why `scripts/doc-drift.mjs` exempts
`adrs/` from the drift gate — the living description of the code is `docs/`.

| ADR                                                                                                              | Decision                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [2026-10-10-two-clock-day-model.md](./2026-10-10-two-clock-day-model.md)                                         | local days, UTC budget period                                                       |
| [2026-10-10-statusline-render-in-cli.md](./2026-10-10-statusline-render-in-cli.md)                               | in-process shim, rendering in tested TypeScript                                     |
| [2026-10-10-session-start-usage-refresh.md](./2026-10-10-session-start-usage-refresh.md)                         | token-free usage refresh, stale-while-revalidate                                    |
| [2026-10-10-prompt-cache-cost-prediction.md](./2026-10-10-prompt-cache-cost-prediction.md)                       | next-prompt cost from `prompt_cache`                                                |
| [2026-10-10-terminal-only-ui.md](./2026-10-10-terminal-only-ui.md)                                               | no Ink, no browser picker, calendar gated by plan                                   |
| [2026-10-10-manual-test-plan.md](./2026-10-10-manual-test-plan.md)                                               | release manual test plan                                                            |
| [2026-10-10-statusline-layout-and-model-switch-cost.md](./2026-10-10-statusline-layout-and-model-switch-cost.md) | user-set layout, `settings` grid, switch-cost hook                                  |
| [2026-10-15-history-and-feed.md](./2026-10-15-history-and-feed.md)                                               | limit history, API-equivalent $, miss causes, `feed.json`                           |
| [2026-10-15-transcript-index.md](./2026-10-15-transcript-index.md)                                               | local transcript index, `report`, price self-check                                  |
| [2026-10-15-file-versions-and-downgrade-guard.md](./2026-10-15-file-versions-and-downgrade-guard.md)             | per-file `schemaVersion`, backups, newer files never rewritten                      |
| [2026-10-15-coach.md](./2026-10-15-coach.md)                                                                     | coach rules, `insights`, 💡 part, snooze                                            |
| [2026-10-15-review-fixes-and-usage-data.md](./2026-10-15-review-fixes-and-usage-data.md)                         | atomic settings writes, fixed refresh, API backoff, new usage fields, subagent line |
