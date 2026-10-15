# Coach: findings, `insights` and the 💡 part

Pure rules in `src/rules.ts` turn the index rollups (`docs/transcript-index.md`)
and the usage history (`docs/history-and-feed.md`) into findings with an
estimated avoidable $ and an exact fix. `src/insights.ts` loads the window and
runs them; the refresher writes them to `feed.json.advice`.

## Rules (window: rolling 7 days, or 30 with `--month`)

| ID  | Finding                      | Trigger                                                      | $ estimate                                                                               | Fix                                      |
| --- | ---------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| R1  | Subagents on a premium model | subagent rows on a model id with `opus`, `fable` or `mythos` | actual − the same tokens at `claude-sonnet-5-5` (cache writes scale with the input rate) | env `CLAUDE_CODE_SUBAGENT_MODEL=sonnet`  |
| R2  | Fast mode                    | rows with `speed` fast                                       | half their $ (fast = 2× standard)                                                        | setting `fastMode=false`                 |
| R3  | High effort thinking         | thinking on turns at `xhigh`/`max`/`ultra`                   | all of that thinking $ (the floor is unknown)                                            | setting `effortLevel=high`               |
| R4  | Prompt cache re-paid         | `usage.missCauses` in the window                             | miss $, top three causes                                                                 | habit                                    |
| R5  | Deep context                 | turns with context over 200k tokens                          | cache-read $ for the part above 200k                                                     | env `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50` |
| R6  | Outlier session              | ≥ 8 sessions; $ > max($2, 3 × median)                        | Σ ($ − median)                                                                           | `report <window> --by session`           |
| R8  | Running out early            | a window `at-risk` in the feed, or today's budget passed     | none                                                                                     | habit                                    |
| R9  | Older model                  | a newer model of the family at the same or a lower price     | actual − repriced                                                                        | `/model`                                 |
| R10 | Most spend re-reads context  | cache-read $ > 57% of $                                      | cache-read $                                                                             | habit                                    |

R7 (unused MCP servers) needs the initial-context source of CLI-10 and is not
built. R10 uses only the carry share; antiburn's "cost per MTok" needs context
growth per turn, which the index does not keep.

Ranking (`coach`): not snoozed first, then $ descending, a finding with no $
(R8) first; findings under $0.50 (`MIN_FINDING_USD`) drop; at most 10.

## Surfaces

- `cc-daily-usage insights [--week|--month] [--json] [--snooze <rule> <N>d]`:
  catches the index up, rewrites `feed.json`, prints each finding with its
  evidence and fix. `--snooze R1 0d` clears a snooze. Snoozes live in
  `config.json` `snoozed` (rule → ISO end).
- Statusline part 14 `coach`: `💡 <title> ~$X/<window>` from the first
  non-snoozed finding in `feed.json` (one small file read per render). On by
  default, on its own row.
- `feed.json.advice`: the week's findings for the `/cost-tracker` mod. The CLI
  never writes Claude Code settings; a fix is text to copy.
