#!/usr/bin/env bash
set -uo pipefail

payload="$(cat 2>/dev/null || true)"
session="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null || true)"

root="${CLAUDE_PROJECT_DIR:-}"
[ -n "$root" ] || root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$root" ] || exit 0

script="$root/scripts/doc-drift.mjs"
[ -f "$script" ] || exit 0

marker_dir="${TMPDIR:-/tmp}/cc-daily-usage-doc-drift"
marker="$marker_dir/${session:-nosession}"
mkdir -p "$marker_dir" 2>/dev/null || true
[ -e "$marker" ] && exit 0

drift="$(node "$script" drift --quiet 2>/dev/null || true)"
[ -n "$drift" ] || exit 0

: > "$marker" 2>/dev/null || true

{
  echo "$drift"
  echo
  echo "Correct what is now false in those docs before finishing. If this change does not alter documented behaviour, say so and stop — this fires once per session."
} >&2

exit 2
