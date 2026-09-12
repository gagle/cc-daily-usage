#!/usr/bin/env bash
# PostToolUse reminder: src/calc.ts changed — the formula/doc/test triad
# (docs/calculations.md + calc.spec.ts) must stay in sync. See the
# add-calc-formula skill for the full checklist.
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

if [[ "$file_path" == *src/calc.ts ]]; then
  echo "Reminder: calc.ts changed — update docs/calculations.md and run: pnpm vitest run src/calc.spec.ts" >&2
  exit 2
fi

exit 0
