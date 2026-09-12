#!/usr/bin/env bash
# PreToolUse guard: never let Edit/Write touch the *installed* statusline
# script (~/.claude/statusline.mjs) — it's silently overwritten on the next
# managed install (marker: `// cc-daily-usage:managed v<hash>`). Edit
# assets/statusline.mjs (the template) instead. See docs/data-model.md.
set -euo pipefail

input="$(cat)"
file_path="$(node -e '
let d = "";
process.stdin.on("data", (c) => (d += c));
process.stdin.on("end", () => {
  try {
    console.log(JSON.parse(d).tool_input?.file_path ?? "");
  } catch {
    console.log("");
  }
});
' <<<"$input")"

if [[ "$file_path" == */.claude/statusline.mjs ]]; then
  echo "Blocked: never hand-edit the installed ~/.claude/statusline.mjs — it's overwritten on the next managed install. Edit assets/statusline.mjs (the template) instead." >&2
  exit 2
fi

exit 0
