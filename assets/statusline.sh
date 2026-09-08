#!/usr/bin/env bash
# Claude Code status line — reads session JSON from stdin, prints one ANSI line.
# cc-daily-usage:managed v1
# cc-daily-usage:capture v1
#
# Installed by `cc-daily-usage statusline`. Re-running that command is idempotent — it detects the marker
# above and silently no-ops/upgrades instead of prompting or backing up again. Don't hand-edit this file;
# your changes will be silently overwritten on the next managed re-install.
set -euo pipefail

input=$(cat)

# Single jq pass for all JSON fields
eval "$(echo "$input" | jq -r '
  def s($v): ($v // "") | tostring | @sh;
  [
    "cwd=\(s(.workspace.current_dir))",
    "repo=\(s(.workspace.repo.name))",
    "project_dir=\(s(.workspace.project_dir))",
    "model=\(s(.model.display_name))",
    "effort=\(s(.effort.level))",
    "rl5h=\(s(.rate_limits.five_hour.used_percentage))",
    "rl7d=\(s(.rate_limits.seven_day.used_percentage))",
    "pctraw=\(s(.context_window.used_percentage // 0))",
    "cost=\(s(.cost.total_cost_usd // 0))",
    "added=\(s(.cost.total_lines_added))",
    "removed=\(s(.cost.total_lines_removed))"
  ] | join("\n")
')"

if [ -z "${repo:-}" ]; then
  repo=$(basename "${project_dir:-}")
fi

branch=$(git -C "${cwd:-.}" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null || true)

pct=${pctraw%.*}
pct=${pct:-0}

filled=$((pct / 5))
if [ "$filled" -gt 20 ]; then
  filled=20
fi

if [ "$pct" -lt 20 ]; then
  emoji="🟢"; er=0; eg=200; eb=80
elif [ "$pct" -lt 70 ]; then
  emoji="⚡"; er=220; eg=200; eb=0
elif [ "$pct" -lt 90 ]; then
  emoji="🔥"; er=230; eg=120; eb=0
else
  emoji="🚨"; er=220; eg=40; eb=20
fi

# Color cells by position on the full 20-cell bar (not within filled span),
# so low percentages stay green instead of ending on a red tip.
bar=""
i=1
while [ "$i" -le 20 ]; do
  if [ "$i" -le "$filled" ]; then
    frac=$((i * 100 / 20))
    if [ "$frac" -le 50 ]; then
      t=$((frac * 2))
      r=$((220 * t / 100))
      g=200
      b=$((80 - 80 * t / 100))
    else
      t=$(((frac - 50) * 2))
      r=220
      g=$((200 - 160 * t / 100))
      b=$((20 * t / 100))
    fi
    bar="${bar}\033[38;2;${r};${g};${b}m█"
  else
    bar="${bar}\033[38;2;60;60;60m█"
  fi
  i=$((i + 1))
done
bar="${bar}\033[0m"

sep="\033[2;38;2;120;120;120m|\033[0m"
line="\033[1;38;2;220;200;0m${repo}\033[0m ${sep}"

if [ -n "${branch:-}" ]; then
  line="${line} \033[1;38;2;0;200;200m(🌿 ${branch})\033[0m ${sep}"
fi

line="${line} ${bar} ${emoji} \033[38;2;${er};${eg};${eb}m${pct}%\033[0m ${sep} \033[38;2;220;200;0m\$$(printf '%.2f' "$cost")\033[0m"

if [ -n "${added:-}" ] || [ -n "${removed:-}" ]; then
  line="${line} ${sep} \033[38;2;0;200;80m+${added:-0}\033[0m\033[38;2;220;40;20m-${removed:-0}\033[0m"
fi

line="${line} ${sep} \033[38;2;200;0;200m🤖 ${model}\033[0m"

if [ -n "${effort:-}" ]; then
  line="${line} ${sep} \033[38;2;150;150;250m💪 ${effort}\033[0m"
fi

if [ -n "${rl5h:-}" ] || [ -n "${rl7d:-}" ]; then
  rl_parts=""
  if [ -n "${rl5h:-}" ]; then
    rl_parts="$(printf '%.0f' "$rl5h")%/5h"
  fi
  if [ -n "${rl7d:-}" ]; then
    if [ -n "$rl_parts" ]; then
      rl_parts="${rl_parts} "
    fi
    rl_parts="${rl_parts}$(printf '%.0f' "$rl7d")%/7d"
  fi
  line="${line} ${sep} \033[38;2;100;180;255m⏱ ${rl_parts}\033[0m"
fi

# cc-daily-usage: daily/monthly spend segments (§18 auto-capture + §9.2 segment order). A SEPARATE jq pass
# over cc-daily-usage's own JSON output, not a second pass over $input — the extraction above is untouched.
# `2>/dev/null || echo ""` means a machine without cc-daily-usage on PATH yet, or before config.json exists,
# silently degrades to exactly today's statusline above — never a broken/crashing script.
statusline_json=$(echo "$input" | cc-daily-usage --statusline 2>/dev/null || echo "")

if [ -n "$statusline_json" ]; then
  eval "$(echo "$statusline_json" | jq -r '
    def s($v): ($v // "") | tostring | @sh;
    [
      "today_usage=\(s(.todayUsage // 0))",
      "avg_per_day=\(s(.avgPerDay))",
      "today_pct=\(s(.todayUsedPct))",
      "month_spent=\(s(.monthlySpent // 0))",
      "month_cap=\(s(.monthlyCap // 0))",
      "month_pct=\(s(.monthUsedPct // 0))"
    ] | join("\n")
  ')"

  # colorForPct's 5-bucket thresholds (src/calc.ts), ported inline: highest threshold first, first match wins.
  cc_color() {
    local frac="$1"
    if awk "BEGIN{exit !($frac>=1)}"; then echo "248;105;107";
    elif awk "BEGIN{exit !($frac>=0.75)}"; then echo "244;164;96";
    elif awk "BEGIN{exit !($frac>=0.5)}"; then echo "255;235;132";
    elif awk "BEGIN{exit !($frac>=0.25)}"; then echo "161;215;106";
    else echo "99;190;123"; fi
  }

  # avg_per_day/today_pct come through empty when laboral days aren't configured for the current month
  # (computeToday returns null) — skip the "today" segment entirely rather than show a misleading $X/$0.00.
  if [ -n "${avg_per_day:-}" ]; then
    today_color=$(cc_color "$today_pct")
    today_pct_display=$(awk "BEGIN{printf \"%.0f\", $today_pct*100}")
    line="${line} ${sep} \033[38;2;${today_color}m\$$(printf '%.2f' "$today_usage")/\$$(printf '%.2f' "$avg_per_day") (${today_pct_display}%)\033[0m"
  fi

  month_color=$(cc_color "$month_pct")
  month_pct_display=$(awk "BEGIN{printf \"%.0f\", $month_pct*100}")
  line="${line} ${sep} \033[38;2;${month_color}m\$$(printf '%.2f' "$month_spent")/\$$(printf '%.2f' "$month_cap") (${month_pct_display}%)\033[0m"
fi

printf '%b' "$line"
