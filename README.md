# cc-daily-usage

Claude Code daily/monthly spend tracker: a laboral-day-aware budget report, an interactive calendar picker for
authoring which days count as "working days," and a statusline that shows live daily/monthly spend segments —
auto-captured from Claude Code's own statusline hook, no manual entry required.

## Install

```sh
npm install -g cc-daily-usage
```

## Usage

```sh
cc-daily-usage init          # author monthlyCap + laboral days via a browser calendar picker
cc-daily-usage report        # render ~/.config/cc-daily-usage/report.html
cc-daily-usage statusline    # install the live daily/monthly statusline segments
cc-daily-usage usage         # open a live terminal dashboard of today's/this month's spend
cc-daily-usage --help
```

All state lives under `~/.config/cc-daily-usage/` (`config.json`, `usage.json`), UTC-based throughout.

See `cc-daily-usage-PLAN.md` (in the sibling `gll/` directory this was planned from) for the full design
rationale.
