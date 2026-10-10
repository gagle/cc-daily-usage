import { readFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_ROOT_DIR, writeFileAtomic } from "./config.js";

/** Every statusline part, in the default left-to-right order. `sample` is what `settings` previews. */
export const PARTS = [
  { id: "branch", label: "Git branch", sample: "(🌿 main)" },
  { id: "context", label: "Context bar + %", sample: "████░░ ⚡ 55%" },
  { id: "cost", label: "Session cost", sample: "$1.23" },
  { id: "duration", label: "Session duration", sample: "⏲ 12m 5s" },
  { id: "model", label: "Model", sample: "🤖 Opus 5.5" },
  { id: "effort", label: "Effort", sample: "💪 high" },
  { id: "cache", label: "Prompt cache", sample: "🔥 cold in 4m · $0.04/msg" },
  { id: "limits", label: "5h / 7d limits (Pro/Max)", sample: "⏱ 25%/5h 76%/7d" },
  { id: "warnings", label: "Limit warnings (Pro/Max)", sample: "⚠ 5h resets 14:00" },
  { id: "credits", label: "Usage credits (Pro/Max)", sample: "🎫 $3.00/$50.00 (6%)" },
  { id: "today", label: "Today's budget (Team)", sample: "$4.10/$9.50 (43%)" },
  { id: "month", label: "Month's budget (Team)", sample: "$120.00/$200.00 (60%)" },
  { id: "spend", label: "Spend limit", sample: "💳 40%" },
] as const;

export type PartId = (typeof PARTS)[number]["id"];
/** Rows top to bottom, parts left to right. A part in no row is hidden. */
export type Layout = ReadonlyArray<ReadonlyArray<PartId>>;

/** Everything on one row, in `PARTS` order. */
export const DEFAULT_LAYOUT: Layout = [PARTS.map((part) => part.id)];

/** Global, not per account: the layout is how the user likes the line, whatever the plan. */
export const LAYOUT_FILE = path.join(CONFIG_ROOT_DIR, "statusline.json");

function isPartId(value: unknown): value is PartId {
  return PARTS.some((part) => part.id === value);
}

/** `{ "rows": [[...ids]] }` → a layout. Unknown ids and repeats are dropped, empty rows removed. Nothing
 * usable left → the default, so a broken file never blanks the statusline. */
export function parseLayout(raw: unknown): Layout {
  const rows = (raw as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return DEFAULT_LAYOUT;
  const seen = new Set<PartId>();
  const layout: Array<ReadonlyArray<PartId>> = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const ids: Array<PartId> = [];
    for (const id of row) {
      if (!isPartId(id) || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length > 0) layout.push(ids);
  }
  return layout.length > 0 ? layout : DEFAULT_LAYOUT;
}

export function loadLayout(): Layout {
  try {
    return parseLayout(JSON.parse(readFileSync(LAYOUT_FILE, "utf8")));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(layout: Layout): void {
  writeFileAtomic(LAYOUT_FILE, `${JSON.stringify({ rows: layout }, null, 2)}\n`);
}
