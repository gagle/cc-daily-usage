# cc-daily-usage

Claude Code daily/monthly spend tracker: a laboral-day-aware budget dashboard, an interactive terminal calendar
for authoring which days count as "working days," and a statusline that shows live daily/monthly spend
segments — auto-captured from Claude Code's own statusline hook, no manual entry required. Any day with
recorded spend is automatically counted as a laboral day too, whether or not it was ever configured that way.

## Install

```sh
npm install -g cc-daily-usage
```

## Usage

```sh
cc-daily-usage init          # author monthlyCap + laboral days via a browser calendar picker
cc-daily-usage statusline    # install the live daily/monthly statusline segments
cc-daily-usage dashboard     # live terminal dashboard: stats, calendar, laboral-day editing
cc-daily-usage --help
```

All state lives under `~/.config/cc-daily-usage/` (`config.json`, `usage.json`), UTC-based throughout.
