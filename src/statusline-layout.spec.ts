import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as LayoutModule from "./statusline-layout.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

async function fresh(): Promise<typeof LayoutModule> {
  vi.resetModules();
  return import("./statusline-layout.js");
}

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccs-layout-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("parseLayout", () => {
  it("keeps known ids once, drops empty rows; nothing usable → the default", async () => {
    const { parseLayout, DEFAULT_LAYOUT } = await fresh();
    expect(
      parseLayout({ rows: [["model", "nope", "model"], [], "x", ["cache", "model"]] }),
    ).toEqual([["model"], ["cache"]]);
    expect(parseLayout({ rows: [[], ["nope"]] })).toBe(DEFAULT_LAYOUT);
    expect(parseLayout({ rows: "x" })).toBe(DEFAULT_LAYOUT);
    expect(parseLayout(null)).toBe(DEFAULT_LAYOUT);
  });

  it("the default is every part on one row, the coach tip then the limit warnings on a second", async () => {
    const { DEFAULT_LAYOUT, PARTS } = await fresh();
    expect(DEFAULT_LAYOUT).toEqual([
      PARTS.map((part) => part.id).filter((id) => id !== "coach" && id !== "warnings"),
      ["coach", "warnings"],
    ]);
  });
});

describe("loadLayout / saveLayout", () => {
  it("round-trips through statusline.json; a missing or corrupt file → the default", async () => {
    const { loadLayout, saveLayout, DEFAULT_LAYOUT, LAYOUT_FILE } = await fresh();
    expect(loadLayout()).toBe(DEFAULT_LAYOUT);
    saveLayout([["cost"], ["cache"]]);
    expect(JSON.parse(readFileSync(LAYOUT_FILE, "utf8"))).toEqual({
      schemaVersion: 2,
      rows: [["cost"], ["cache"]],
    });
    expect(loadLayout()).toEqual([["cost"], ["cache"]]);
    writeFileSync(LAYOUT_FILE, "{not json");
    expect(loadLayout()).toBe(DEFAULT_LAYOUT);
    writeFileSync(LAYOUT_FILE, "null");
    expect(loadLayout()).toBe(DEFAULT_LAYOUT);
  });

  it("an older statusline.json gets the new resets part at the end of its first row, in memory", async () => {
    const { loadLayout, LAYOUT_FILE } = await fresh();
    mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true });
    const v1 = JSON.stringify({ schemaVersion: 1, rows: [["cost", "limits"], ["coach"]] });
    writeFileSync(LAYOUT_FILE, v1);
    expect(loadLayout()).toEqual([["cost", "limits", "resets"], ["coach"]]);
    expect(readFileSync(LAYOUT_FILE, "utf8")).toBe(v1);
    writeFileSync(LAYOUT_FILE, JSON.stringify({ rows: [["cost"], ["resets"]] }));
    expect(loadLayout()).toEqual([["cost"], ["resets"]]);
    writeFileSync(LAYOUT_FILE, JSON.stringify({ schemaVersion: 1, rows: ["x", ["cost"]] }));
    expect(loadLayout()).toEqual([["resets"], ["cost"]]);
    writeFileSync(LAYOUT_FILE, JSON.stringify({ schemaVersion: 1, rows: "x" }));
    expect(loadLayout()).toEqual((await fresh()).DEFAULT_LAYOUT);
  });

  it("a newer statusline.json still renders but is never overwritten", async () => {
    const { loadLayout, saveLayout, LAYOUT_FILE } = await fresh();
    const { listNewerFiles } = await import("./config.js");
    const newer = JSON.stringify({ schemaVersion: 3, rows: [["cost", "future-part"]] });
    mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true });
    writeFileSync(LAYOUT_FILE, newer);
    expect(loadLayout()).toEqual([["cost"]]);
    saveLayout([["cache"]]);
    expect(readFileSync(LAYOUT_FILE, "utf8")).toBe(newer);
    expect(listNewerFiles()).toEqual([LAYOUT_FILE]);
  });
});
