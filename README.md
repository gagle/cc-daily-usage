# cc-daily-usage

Know where your Claude Code spend stands, and what your next prompt costs.

## What it does

- A fast live statusline (one Node process, no network on the render path).
- **Team / Enterprise:** a monthly $ budget spread over your work days —
  `$today/$max` and `$month/$cap`. The cap follows your org's Anthropic spend
  limit automatically; take a day off and the rest re-splits evenly.
- **Pro / Max:** real 5h/7d limits, fresh at session start without sending a
  message, when you can continue after hitting a limit, plus usage credits.
- **Everyone:** the prompt-cache cost of each message and of a miss, a live
  countdown, and a gate that stops a costly cold-cache prompt before it is sent.

```
(🌿 main) | ████████░░ ⚡ 42% | $1.80 | 🤖 Opus 5.5 | 🔥 cold in 4m · $0.04/req · if cold +$1.20 | $12.40/$30.00 (41%) | $210.00/$650.00 (32%)
```

## Install

```sh
npm install -g cc-daily-usage
cc-daily-usage init
```

Install it globally: `init` points Claude Code at this copy's files, so a
copy run through `npx` is refused. `init` installs the statusline and, on Team/Enterprise, offers Monday–Friday
as work days and opens the calendar to set holidays and the cap. Requires
Node 24+.

## Commands

```sh
cc-daily-usage init         # first-run setup (terminal only)
cc-daily-usage statusline   # install / update the statusline
cc-daily-usage calendar     # work days, daily max, history (Team/Enterprise)
cc-daily-usage settings     # arrange the statusline: parts, order, lines
cc-daily-usage uninstall    # remove it and restore your previous statusline
cc-daily-usage doctor       # check Node, Claude Code, the statusline, hooks, account files
cc-daily-usage report       # API-equivalent $ by model, project, subagent, … (week by default)
cc-daily-usage report --chart            # the same with a stacked $ bar per row
cc-daily-usage report --session <id>     # one session: $ over time, compactions, cold caches, where it went
cc-daily-usage insights     # what to change to spend less, with $ and the exact fix
cc-daily-usage live         # real-time advisor and meters of every active session (Tab: details, q quits)
```

Spend is captured from Claude Code's own statusline data — nothing to log by
hand. Each Claude account gets its own tracking under
`~/.config/cc-daily-usage/`.

## What `insights` checks

`cc-daily-usage insights` ranks what to change, each finding with its $ over
the last 7 days (`--month` for 30), the evidence, why it costs and the fix.
`cc-daily-usage insights --rules` prints this list in the terminal and marks
the rules found now. The top finding also shows on the statusline (`»`) and in
`live`. Findings under $0.50 are hidden; `--snooze R1 7d` hides one for a week.

| ID  | Finding                      | Why it costs                                                                                                  | Fix                                                                                         |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| R1  | Subagents on a premium model | Subagents mostly search and read; a premium model bills the same tokens at 2-5x Sonnet.                       | CLAUDE_CODE_SUBAGENT_MODEL=sonnet, or model: in the agent file.                             |
| R2  | Fast mode                    | Fast mode bills every token at 2x the standard rate.                                                          | Turn fast mode off (/fast, setting fastMode=false).                                         |
| R3  | High effort thinking         | Thinking bills as output, the most expensive token; high effort is enough for most tasks.                     | Use high effort by default (/effort, setting effortLevel=high).                             |
| R4  | Prompt cache re-paid         | After a miss the whole context is written again at 1.25-2x the input rate instead of read at about 0.05-0.1x. | /compact before a break; keep the MCP servers and tools stable mid-session.                 |
| R5  | Deep context                 | Every turn, each tool call included, re-reads the whole context; the part above 200k is paid each time.       | Compact earlier or start fresh for a new task (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50).         |
| R6  | Outlier session              | One runaway session (a loop, a huge file, the wrong model) can cost more than a normal day.                   | cc-daily-usage report week --by session, then report --session <id> to see what it did.     |
| R7  | Unused MCP servers           | A server loads into every turn of every session, used or not.                                                 | Turn off servers a project does not use (/mcp) or remove them from .mcp.json.               |
| R8  | Running out early            | At the limit work stops until the reset; the cost is time, not $.                                             | Slow down, or move routine work to a cheaper model.                                         |
| R9  | Older model                  | The newer model is at least as good for the same or a lower price.                                            | Switch with /model, and update the default model in your settings.                          |
| R10 | Most spend re-reads context  | Long sessions spend most of their $ re-reading history, not producing new work.                               | /compact at natural breaks, /clear between unrelated tasks.                                 |
| R11 | Context sent again and again | Context the model already had was sent again at write prices, often after a cold cache or a model switch.     | Avoid long mid-session breaks (/compact before one); do not switch models on a big context. |
| R12 | Large instruction files      | They load into every turn; each extra 1k tokens is paid on every turn of every session.                       | Trim them; move rare detail into files read on demand.                                      |

All $ are API-equivalent estimates from your local transcripts, not a bill.

## Privacy

No server, no analytics. The only network calls go to Anthropic's own
read-only endpoints Claude Code already uses (`/api/oauth/usage`,
`/api/oauth/profile`), with your existing Claude Code login, from a background
process.

`report`, `live` and the background process read your Claude Code transcripts
in `~/.claude/projects` on this machine to total tokens and $ by model, project
and subagent. Only token counts, model, project folder, branch, session id and
name, turn and thinking times, hook-run counts, how the session started, and
the names of MCP servers loaded or called (with the size of their instructions)
are kept (in `~/.config/cc-daily-usage/`); `live` keeps nothing. `insights`
reads the size of your CLAUDE.md and MEMORY.md files. No message text is
stored, and nothing is sent anywhere.

## Development

```sh
pnpm install && pnpm build && pnpm test
```
