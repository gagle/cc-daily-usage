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
(🌿 main) | ████████░░ ⚡ 42% | $1.80 | 🤖 Opus 5.5 | 🔥 cold in 4m · $0.04/msg · if cold +$1.20 | $12.40/$30.00 (41%) | $210.00/$650.00 (32%)
```

## Install

```sh
npm install -g cc-daily-usage
cc-daily-usage init
```

`init` installs the statusline and, on Team/Enterprise, offers Monday–Friday
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
cc-daily-usage insights     # what to change to spend less, with $ and the exact fix
```

Spend is captured from Claude Code's own statusline data — nothing to log by
hand. Each Claude account gets its own tracking under
`~/.config/cc-daily-usage/`.

## Privacy

No server, no analytics. The only network calls go to Anthropic's own
read-only endpoints Claude Code already uses (`/api/oauth/usage`,
`/api/oauth/profile`), with your existing Claude Code login, from a background
process.

`report` and the background process read your Claude Code transcripts in
`~/.claude/projects` on this machine to total tokens and $ by model, project
and subagent. Only token counts, model, project folder, branch, session id and
name, turn and thinking times, hook-run counts and how the session started are
kept (in `~/.config/cc-daily-usage/`); no message text is stored, and nothing
is sent anywhere.

## Development

```sh
pnpm install && pnpm build && pnpm test
```
