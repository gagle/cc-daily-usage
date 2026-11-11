# Architecture Decision Records

Decisions that shape cc-daily-usage, one file each, named
`YYYY-MM-DD-short-title.md`. Copy [`template.md`](./template.md) to start one.

ADRs are **append-only**: once accepted, a record is not edited to match later
code. A changed decision gets a new ADR that supersedes the old one (set the old
one's status to `Superseded by …`). That is why `scripts/doc-drift.mjs` exempts
`adrs/` from the drift gate — the living description of the code is `docs/`.

| ADR                                                                                                              | Decision                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [2026-10-10-two-clock-day-model.md](./2026-10-10-two-clock-day-model.md)                                         | local days, UTC budget period                                                                            |
| [2026-10-10-statusline-render-in-cli.md](./2026-10-10-statusline-render-in-cli.md)                               | in-process shim, rendering in tested TypeScript                                                          |
| [2026-10-10-session-start-usage-refresh.md](./2026-10-10-session-start-usage-refresh.md)                         | token-free usage refresh, stale-while-revalidate                                                         |
| [2026-10-10-prompt-cache-cost-prediction.md](./2026-10-10-prompt-cache-cost-prediction.md)                       | next-prompt cost from `prompt_cache`                                                                     |
| [2026-10-10-terminal-only-ui.md](./2026-10-10-terminal-only-ui.md)                                               | no Ink, no browser picker, calendar gated by plan                                                        |
| [2026-10-10-manual-test-plan.md](./2026-10-10-manual-test-plan.md)                                               | release manual test plan                                                                                 |
| [2026-10-10-statusline-layout-and-model-switch-cost.md](./2026-10-10-statusline-layout-and-model-switch-cost.md) | user-set layout, `settings` grid, switch-cost hook                                                       |
| [2026-10-15-history-and-feed.md](./2026-10-15-history-and-feed.md)                                               | limit history, API-equivalent $, miss causes, `feed.json`                                                |
| [2026-10-15-transcript-index.md](./2026-10-15-transcript-index.md)                                               | local transcript index, `report`, price self-check                                                       |
| [2026-10-15-file-versions-and-downgrade-guard.md](./2026-10-15-file-versions-and-downgrade-guard.md)             | per-file `schemaVersion`, backups, newer files never rewritten                                           |
| [2026-10-15-coach.md](./2026-10-15-coach.md)                                                                     | coach rules, `insights`, 💡 part, snooze                                                                 |
| [2026-10-15-review-fixes-and-usage-data.md](./2026-10-15-review-fixes-and-usage-data.md)                         | atomic settings writes, fixed refresh, API backoff, new usage fields, subagent line                      |
| [2026-10-18-live-view-and-cli-gaps.md](./2026-10-18-live-view-and-cli-gaps.md)                                   | `live` meters, session burn-up, efficiency split, R7/R11/R12, typical peak, milestones, work-week runway |
| [2026-10-18-pricing-window-and-unpriced-warning.md](./2026-10-18-pricing-window-and-unpriced-warning.md)         | 6-month pricing window, Opus 4.6 fast, Haiku 5.5 tier, unpriced-model warning                            |
| [2026-10-18-exact-cost-formulas.md](./2026-10-18-exact-cost-formulas.md)                                         | cost formulas vs official docs: cached prefix, `$/req`, fast 6×, US 1.1×, tokenizer ratio                |
| [2026-10-18-index-reprice-and-turn-metadata.md](./2026-10-18-index-reprice-and-turn-metadata.md)                 | index re-price on a price change; prompt $, API time, miss counts, attribution, API errors               |
| [2026-10-23-account-switch-attribution.md](./2026-10-23-account-switch-attribution.md)                           | a `/login` moves running sessions: spend booked per login, `⇄` marker, index split by turn time          |
| [2026-11-11-claude-code-cost-state.md](./2026-11-11-claude-code-cost-state.md)                                   | Claude Code's `cost-state`: exact per-model price check, $ the transcripts do not record                 |
