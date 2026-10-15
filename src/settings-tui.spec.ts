import { describe, expect, it, vi } from "vitest";

import type { Key } from "./calendar-tui.js";
import {
  cellsToLayout,
  GRID_COLS,
  GRID_ROWS,
  initialSettings,
  reduceSettingsKey,
  renderSettings,
  type SettingsModel,
} from "./settings-tui.js";
import { DEFAULT_LAYOUT, type Layout, PARTS } from "./statusline-layout.js";

const effects = () => ({ saveLayout: vi.fn<(layout: Layout) => void>() });

function press(model: SettingsModel, keys: ReadonlyArray<Key | string>, fx = effects()) {
  let current: SettingsModel | null = model;
  for (const key of keys) {
    if (current === null) break;
    const parsed: Key = typeof key === "string" ? { kind: "char", char: key } : key;
    current = reduceSettingsKey(current, parsed, fx);
  }
  return current;
}

const empty = (): SettingsModel => initialSettings([]);

describe("initialSettings / cellsToLayout", () => {
  it("the default layout is 1..N-1 on the first row, the coach (N) on the second, and round-trips", () => {
    const model = initialSettings(DEFAULT_LAYOUT);
    expect(model.cells).toHaveLength(GRID_ROWS);
    expect(model.cells[0]).toEqual(
      PARTS.slice(0, -1)
        .map((_, i) => String(i + 1))
        .concat(""),
    );
    expect(model.cells[1]?.[0]).toBe(String(PARTS.length));
    expect(model.cells[2]).toEqual(Array.from({ length: GRID_COLS }, () => ""));
    expect(cellsToLayout(model.cells)).toEqual({ layout: DEFAULT_LAYOUT });
  });

  it("skips empty cells and rows; reports bad numbers, repeats and an empty grid", () => {
    expect(
      cellsToLayout([
        ["", "5"],
        ["", ""],
        ["7", "3"],
      ]),
    ).toEqual({
      layout: [["model"], ["cache", "cost"]],
    });
    expect(cellsToLayout([["0"]])).toEqual({ error: "0 is not a part number (1-14)" });
    expect(cellsToLayout([["99"]])).toEqual({ error: "99 is not a part number (1-14)" });
    expect(cellsToLayout([["5", "5"]])).toEqual({ error: "part 5 is placed twice" });
    expect(cellsToLayout([[""]])).toEqual({ error: "place at least one part" });
  });
});

describe("reduceSettingsKey", () => {
  it("digits: append while the number names a part, else start over", () => {
    expect(press(empty(), ["1", "2"])?.cells[0]?.[0]).toBe("12");
    expect(press(empty(), ["1", "2", "3"])?.cells[0]?.[0]).toBe("3");
    expect(press(empty(), ["5", "3"])?.cells[0]?.[0]).toBe("3");
    expect(press(empty(), ["1", { kind: "backspace" }])?.cells[0]?.[0]).toBe("");
  });

  it("arrows and tab move inside the grid, clamped at the edges", () => {
    const right = { kind: "right" } as const;
    const down = { kind: "down" } as const;
    expect(press(empty(), [{ kind: "up" }, { kind: "left" }])?.cursor).toEqual({ row: 0, col: 0 });
    expect(press(empty(), [down, right, { kind: "tab" }])?.cursor).toEqual({ row: 1, col: 2 });
    expect(press(empty(), [down, right, { kind: "shift-tab" }])?.cursor).toEqual({
      row: 1,
      col: 0,
    });
    const far = press(empty(), [...Array<Key>(20).fill(down), ...Array<Key>(20).fill(right)]);
    expect(far?.cursor).toEqual({ row: GRID_ROWS - 1, col: GRID_COLS - 1 });
  });

  it("x / space clear a cell, c clears all, r restores the default; other keys do nothing", () => {
    const start = initialSettings(DEFAULT_LAYOUT);
    expect(press(start, ["x"])?.cells[0]?.[0]).toBe("");
    expect(press(start, [" "])?.cells[0]?.[0]).toBe("");
    expect(
      press(start, ["c"])
        ?.cells.flat()
        .every((cell) => cell === ""),
    ).toBe(true);
    expect(press(empty(), ["r"])?.cells).toEqual(start.cells);
    expect(press(start, ["z", { kind: "shift-left" }])).toEqual(start);
  });

  it("Enter saves a valid grid and exits; an invalid grid stays open unsaved", () => {
    const fx = effects();
    expect(press(empty(), ["7", { kind: "down" }, "5", { kind: "enter" }], fx)).toBeNull();
    expect(fx.saveLayout).toHaveBeenCalledWith([["cache"], ["model"]]);
    const bad = effects();
    expect(press(empty(), [{ kind: "enter" }], bad)).not.toBeNull();
    expect(bad.saveLayout).not.toHaveBeenCalled();
  });

  it("Esc, q and Ctrl+C exit without saving", () => {
    for (const key of [{ kind: "escape" }, "q", { kind: "ctrl-c" }] as const) {
      const fx = effects();
      expect(press(empty(), ["5", key], fx)).toBeNull();
      expect(fx.saveLayout).not.toHaveBeenCalled();
    }
  });
});

describe("renderSettings", () => {
  it("lists numbered parts (placed ones ticked), the dashed grid, a preview and the keys", () => {
    const model = press(initialSettings([["model", "cost"]]), [{ kind: "right" }]);
    const frame = renderSettings(model ?? empty(), { color: false }).join("\n");
    expect(frame).toContain("   5  Model");
    expect(frame).toMatch(/ 5 {2}Model .*🤖 Opus 5\.5 {2}✓/);
    expect(frame).not.toMatch(/ 1 {2}Git branch .*✓/);
    expect(frame).toContain(`┌${Array.from({ length: GRID_COLS }, () => "╌╌╌╌").join("┬")}┐`);
    expect(frame).toContain("╎  5 ╎[ 3]╎");
    expect(frame).toContain("Preview:\n  🤖 Opus 5.5 | $1.23\n");
    expect(frame).toContain("Enter save · Esc cancel");
  });

  it("an invalid grid previews the error; colour marks the cursor with inverse video", () => {
    const frame = renderSettings(press(empty(), ["0"]) ?? empty(), { color: true }).join("\n");
    expect(frame).toContain("✗ 0 is not a part number (1-14)");
    expect(frame).toContain("\x1b[7m  0 \x1b[0m");
  });
});
