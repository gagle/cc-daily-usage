# cc-daily-usage

Know exactly where your Claude Code spend stands — without lifting a finger.

## What it does

Drops a live spend bar into your Claude Code statusline, tracks daily/monthly
totals automatically, and warns you before you blow the budget. On a
Pro/Max plan? It shows your real 5h/7d rate limits instead — no fake dollar
numbers.

## Install

```sh
npm install -g cc-daily-usage
```

## Use it

```sh
cc-daily-usage init         # pick a monthly budget + working days (one-time, browser calendar)
cc-daily-usage statusline   # turn on the live statusline
cc-daily-usage dashboard    # open the terminal dashboard
```

Spend is captured automatically from Claude Code's own hooks — nothing to
log by hand. Everything lives in `~/.config/cc-daily-usage/`. Logged into
multiple Claude accounts? Each one gets its own tracking, automatically.
