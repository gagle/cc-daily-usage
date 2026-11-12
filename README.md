# cc-spend

**See what Claude Code costs you, and build habits that make it cost less.**

Claude Code bills by tokens. You rarely see what one prompt costs, so the
habits that waste money stay hidden: a long session that re-reads everything,
a cold cache, a big model on easy work. cc-spend puts the cost in front of you
while you work, tells you what to change, and checks each week if it worked.

## What you get

| Where               | What it tells you                                                                  |
| ------------------- | ---------------------------------------------------------------------------------- |
| Statusline          | This session's $, this prompt's $, the cache, your limits or budget, one tip (`»`) |
| `cc-spend insights` | What to change to spend less, with the $ and the exact fix                         |
| `cc-spend record`   | Your habits this week against your start: better or worse? Runs by itself          |
| `cc-spend report`   | Where the money went: by model, project, subagent, day, session                    |
| `cc-spend live`     | A live view of every open session and what to do now                               |

```
(🌿 main) | ████████░░ ⚡ 42% | $1.80 | 🤖 Opus 5.5 | 🔥 cold in 4m · $0.04/req · if cold +$1.20 | $12.40/$30.00 (41%)
» /compact at the next break · 520k re-read each turn, ~$0.10
```

- **Pro / Max:** your real 5h and 7d limits, when they run out, and when they reset.
- **Team / Enterprise:** a monthly $ budget split over your work days
  (`$today/$max` and `$month/$cap`), with a calendar for days off.

## Install

```sh
npm install -g @gllamas/cc-spend
cc-spend init
```

Needs Node 24+. Install it globally (`npx` is refused: Claude Code must point
at files that stay). `init` sets up the statusline; on Team/Enterprise it also
asks for your work days and cap. After that there is nothing to do: cc-spend
reads what Claude Code already writes.

## The loop: see, change, check

1. **See.** The statusline shows the cost as you work, and the most useful tip.
2. **Change.** `cc-spend insights` lists what costs you the most, with the fix.
3. **Check.** `cc-spend record` shows if your habits got better.

`record` needs no start or stop. The first week starts by itself, and the 7
days before it become your baseline. Each week closes by itself and the next
starts. When one closes, the statusline says so until you look:

```
RECORD #3  Nov 26 → Dec 2  ▕██████████████░░░░░░▏ day 5/7 · ends Dec 3
3 of 5 habits better than baseline · ~$19/week saved at your new rates

HABITS                 baseline    prev     now    vs prev     aim
$ per MTok new work         $61     $48     $41     −15% ✔   < $33
avoidable $                 34%     22%     18%     −4pt ✔   < 10%
cache reads                 82%     88%     91%     +3pt ✔   ≥ 90%
re-sending                  31%     24%     27%     +3pt ✖   < 10%
re-reading                  58%     51%     50%     −1pt ≈   < 54%

FOCUS  R5 Deep context · /compact before 150k
```

It scores how you work, not how much: a busy week does not look worse. Each
week gets one focus (your costliest habit) and shows if it went down.
`--all` lists every week, `--days 14` changes the length.

## Commands

```sh
cc-spend init         # first-run setup
cc-spend statusline   # install or update the statusline
cc-spend insights     # what to change to spend less, with $ and the fix
cc-spend record       # your habits week by week against your baseline (--all, --days N)
cc-spend report       # $ by model, project, subagent, … (week by default; --chart, --session <id>)
cc-spend live         # live view of every open session (Tab: details, q: quit)
cc-spend calendar     # work days, daily max, history (Team/Enterprise)
cc-spend settings     # choose and order the statusline parts
cc-spend doctor       # check Node, Claude Code, the statusline, hooks, files
cc-spend uninstall    # remove it and restore your old statusline
```

Each Claude account is tracked on its own, under `~/.config/cc-spend/`.

## What `insights` checks

`cc-spend insights` ranks what to change, each finding with its $ over
the last 7 days (`--month` for 30), the evidence, why it costs and the fix.
`cc-spend insights --rules` prints this list in the terminal and marks
the rules found now. The top finding also shows on the statusline (`»`) and in
`live`. Findings under $0.50 are hidden; `--snooze R1 7d` hides one for a week.

| ID  | Finding                      | Why it costs                                                                                                  | Fix                                                                                         |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| R1  | Subagents on a premium model | Subagents mostly search and read; a premium model bills the same tokens at 2-5x Sonnet.                       | CLAUDE_CODE_SUBAGENT_MODEL=sonnet, or model: in the agent file.                             |
| R2  | Fast mode                    | Fast mode bills every token at 2x the standard rate.                                                          | Turn fast mode off (/fast, setting fastMode=false).                                         |
| R3  | High effort thinking         | Thinking bills as output, the most expensive token; high effort is enough for most tasks.                     | Use high effort by default (/effort, setting effortLevel=high).                             |
| R4  | Prompt cache re-paid         | After a miss the whole context is written again at 1.25-2x the input rate instead of read at about 0.05-0.1x. | /compact before a break; keep the MCP servers and tools stable mid-session.                 |
| R5  | Deep context                 | Every turn, each tool call included, re-reads the whole context; the part above 200k is paid each time.       | Compact earlier or start fresh for a new task (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50).         |
| R6  | Outlier session              | One runaway session (a loop, a huge file, the wrong model) can cost more than a normal day.                   | cc-spend report week --by session, then report --session <id> to see what it did.           |
| R7  | Unused MCP servers           | A server loads into every turn of every session, used or not.                                                 | Turn off servers a project does not use (/mcp) or remove them from .mcp.json.               |
| R8  | Running out early            | At the limit work stops until the reset; the cost is time, not $.                                             | Slow down, or move routine work to a cheaper model.                                         |
| R9  | Older model                  | The newer model is at least as good for the same or a lower price.                                            | Switch with /model, and update the default model in your settings.                          |
| R10 | Most spend re-reads context  | Long sessions spend most of their $ re-reading history, not producing new work.                               | /compact at natural breaks, /clear between unrelated tasks.                                 |
| R11 | Context sent again and again | Context the model already had was sent again at write prices, often after a cold cache or a model switch.     | Avoid long mid-session breaks (/compact before one); do not switch models on a big context. |
| R12 | Large instruction files      | They load into every turn; each extra 1k tokens is paid on every turn of every session.                       | Trim them; move rare detail into files read on demand.                                      |

All $ are API-equivalent estimates from your local transcripts, not a bill.

## Privacy

No server, no analytics. The only network calls go to Anthropic's read-only
endpoints that Claude Code already uses (`/api/oauth/usage`,
`/api/oauth/profile`), with your Claude Code login, from a background process.

cc-spend reads your Claude Code transcripts in `~/.claude/projects` on this
machine. It keeps only numbers and names: tokens, $, model, project folder,
branch, session id and name, times, hook runs, MCP server names, and per day
how many prompts, `/clear`, `/compact` and `/model` you used. It reads the
size of your CLAUDE.md and MEMORY.md files. **No message text is stored, and
nothing is sent anywhere.**

## Development

```sh
pnpm install && pnpm build && pnpm test
```
