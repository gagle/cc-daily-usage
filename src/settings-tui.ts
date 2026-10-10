import { type Key, parseKeys } from "./calendar-tui.js";
import {
  DEFAULT_LAYOUT,
  type Layout,
  LAYOUT_FILE,
  loadLayout,
  PARTS,
  saveLayout,
} from "./statusline-layout.js";

/** Grid rows = statusline lines; one column per part, so a single row can hold every part. */
export const GRID_ROWS = 4;
export const GRID_COLS = PARTS.length;

export interface SettingsModel {
  readonly cells: ReadonlyArray<ReadonlyArray<string>>; // GRID_ROWS × GRID_COLS typed part numbers, "" = empty
  readonly cursor: { readonly row: number; readonly col: number };
}

export interface SettingsEffects {
  saveLayout(layout: Layout): void;
}

export interface SettingsStyle {
  readonly color: boolean;
}

/** The grid for a layout: part n (1-based, `PARTS` order) written where the layout places it. */
export function initialSettings(layout: Layout): SettingsModel {
  const cells = Array.from({ length: GRID_ROWS }, (_, row) =>
    Array.from({ length: GRID_COLS }, (_, col) => {
      const id = layout[row]?.[col];
      return id === undefined ? "" : String(PARTS.findIndex((part) => part.id === id) + 1);
    }),
  );
  return { cells, cursor: { row: 0, col: 0 } };
}

/** Cells → layout, or the first thing wrong with them. Empty cells and empty rows are skipped. */
export function cellsToLayout(
  cells: SettingsModel["cells"],
): { readonly layout: Layout } | { readonly error: string } {
  const seen = new Set<number>();
  const layout: Array<Layout[number]> = [];
  for (const row of cells) {
    const ids: Array<Layout[number][number]> = [];
    for (const cell of row) {
      if (cell === "") continue;
      const n = Number(cell);
      const part = PARTS[n - 1];
      if (!part) return { error: `${cell} is not a part number (1-${String(PARTS.length)})` };
      if (seen.has(n)) return { error: `part ${cell} is placed twice` };
      seen.add(n);
      ids.push(part.id);
    }
    if (ids.length > 0) layout.push(ids);
  }
  return layout.length > 0 ? { layout } : { error: "place at least one part" };
}

/** Typing a digit: appends when that still names a part ("1" then "2" → 12), else starts over ("5" then
 * "3" → 3). */
function typeDigit(cell: string, digit: string): string {
  const appended = `${cell}${digit}`;
  return cell !== "" && Number(appended) <= PARTS.length ? appended : digit;
}

function setCell(model: SettingsModel, value: string): SettingsModel {
  const { row, col } = model.cursor;
  const cells = model.cells.map((cells, r) =>
    r === row ? cells.map((cell, c) => (c === col ? value : cell)) : cells,
  );
  return { ...model, cells };
}

function move(model: SettingsModel, dRow: number, dCol: number): SettingsModel {
  const clamp = (value: number, max: number): number => Math.min(max - 1, Math.max(0, value));
  return {
    ...model,
    cursor: {
      row: clamp(model.cursor.row + dRow, GRID_ROWS),
      col: clamp(model.cursor.col + dCol, GRID_COLS),
    },
  };
}

/** One key → the next model, or null to exit. Enter saves only a valid grid. */
export function reduceSettingsKey(
  model: SettingsModel,
  key: Key,
  effects: SettingsEffects,
): SettingsModel | null {
  // The cursor is clamped inside the grid, so the cell always exists.
  /* v8 ignore next */
  const current = model.cells[model.cursor.row]?.[model.cursor.col] ?? "";
  switch (key.kind) {
    case "up":
      return move(model, -1, 0);
    case "down":
      return move(model, 1, 0);
    case "left":
    case "shift-tab":
      return move(model, 0, -1);
    case "right":
    case "tab":
      return move(model, 0, 1);
    case "backspace":
      return setCell(model, current.slice(0, -1));
    case "escape":
    case "ctrl-c":
      return null;
    case "enter": {
      const result = cellsToLayout(model.cells);
      if ("error" in result) return model;
      effects.saveLayout(result.layout);
      return null;
    }
    case "char":
      if (/^[0-9]$/.test(key.char)) return setCell(model, typeDigit(current, key.char));
      if (key.char === "x" || key.char === " ") return setCell(model, "");
      if (key.char === "r") return { ...model, cells: initialSettings(DEFAULT_LAYOUT).cells };
      if (key.char === "c") return { ...model, cells: initialSettings([]).cells };
      if (key.char === "q") return null;
      return model;
    default:
      return model;
  }
}

const SAMPLES = new Map<string, string>(PARTS.map((part) => [part.id, part.sample]));

/** The editor frame: numbered parts, the dashed grid with the cursor cell, a preview, the keys. */
export function renderSettings(model: SettingsModel, style: SettingsStyle): ReadonlyArray<string> {
  const paint = (code: string, text: string): string =>
    style.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const result = cellsToLayout(model.cells);
  const placed = new Set(model.cells.flat().filter((cell) => cell !== ""));

  const lines: Array<string> = [paint("1", "cc-daily-usage settings · statusline layout"), ""];
  lines.push("Parts (type a number into the grid; a part not in the grid is hidden):");
  PARTS.forEach((part, i) => {
    const n = String(i + 1);
    const row = `  ${n.padStart(2)}  ${part.label.padEnd(26)} ${part.sample}`;
    lines.push(placed.has(n) ? `${row}  ${paint("32", "✓")}` : paint("2", row));
  });

  lines.push("", "Grid (each row is one statusline line, read left to right):");
  const dash = "╌".repeat(4);
  const border = (left: string, mid: string, right: string): string =>
    paint("2", `${left}${Array.from({ length: GRID_COLS }, () => dash).join(mid)}${right}`);
  lines.push(border("┌", "┬", "┐"));
  model.cells.forEach((row, r) => {
    const cells = row.map((cell, c) => {
      const text = ` ${cell.padStart(2)} `;
      const here = r === model.cursor.row && c === model.cursor.col;
      if (!here) return text;
      return style.color ? paint("7", text) : `[${cell.padStart(2)}]`;
    });
    lines.push(`${paint("2", "╎")}${cells.join(paint("2", "╎"))}${paint("2", "╎")}`);
    if (r < GRID_ROWS - 1) lines.push(border("├", "┼", "┤"));
  });
  lines.push(border("└", "┴", "┘"));

  lines.push("", "Preview:");
  if ("error" in result) lines.push(`  ${paint("31", `✗ ${result.error}`)}`);
  else {
    for (const row of result.layout) {
      const samples = row.map((id) => SAMPLES.get(id));
      lines.push(`  ${samples.join(" | ")}`);
    }
  }

  lines.push(
    "",
    paint(
      "2",
      `←↑↓→ move · 1-${String(PARTS.length)} type a part · ⌫ delete · x clear cell · c clear all · r default · Enter save · Esc cancel`,
    ),
  );
  return lines;
}

/**
 * The `settings` operation: edit the statusline layout in a grid, save to statusline.json. The next
 * statusline render uses it, nothing to reinstall. Not a TTY → prints the current layout and exits.
 */
/* v8 ignore start */
export async function runSettingsTui(): Promise<number> {
  const style: SettingsStyle = {
    color: process.stdout.isTTY && process.env.NO_COLOR === undefined,
  };
  let saved = false;
  const effects: SettingsEffects = {
    saveLayout: (layout) => {
      saveLayout(layout);
      saved = true;
    },
  };
  let model = initialSettings(loadLayout());

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${renderSettings(model, style).join("\n")}\n`);
    return 0;
  }

  const draw = (): void => {
    const frame = renderSettings(model, style)
      .map((line) => `${line}\x1b[K`)
      .join("\n");
    process.stdout.write(`\x1b[H${frame}\x1b[J`);
  };
  // Mouse reporting on (SGR): in the alternate screen a terminal otherwise turns the wheel into ↑/↓ keys,
  // which moved the grid cursor. Wheel events now arrive as mouse sequences, which parseKeys drops.
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  draw();

  return new Promise<number>((resolve) => {
    const finish = (): void => {
      process.stdin.off("data", onData);
      process.stdout.off("resize", draw);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
      process.stdout.write(saved ? `Saved statusline layout to ${LAYOUT_FILE}.\n` : "Not saved.\n");
      resolve(0);
    };
    const onData = (data: Buffer): void => {
      for (const parsed of parseKeys(data.toString("utf8"))) {
        const next = reduceSettingsKey(model, parsed, effects);
        if (next === null) {
          finish();
          return;
        }
        model = next;
      }
      draw();
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdout.on("resize", draw);
  });
}
/* v8 ignore stop */
