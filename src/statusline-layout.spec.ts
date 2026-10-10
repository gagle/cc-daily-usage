import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccdu-layout-"));
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

  it("the default is every part on one row", async () => {
    const { DEFAULT_LAYOUT, PARTS } = await fresh();
    expect(DEFAULT_LAYOUT).toEqual([PARTS.map((part) => part.id)]);
  });
});

describe("loadLayout / saveLayout", () => {
  it("round-trips through statusline.json; a missing or corrupt file → the default", async () => {
    const { loadLayout, saveLayout, DEFAULT_LAYOUT, LAYOUT_FILE } = await fresh();
    expect(loadLayout()).toBe(DEFAULT_LAYOUT);
    saveLayout([["cost"], ["cache"]]);
    expect(JSON.parse(readFileSync(LAYOUT_FILE, "utf8"))).toEqual({ rows: [["cost"], ["cache"]] });
    expect(loadLayout()).toEqual([["cost"], ["cache"]]);
    writeFileSync(LAYOUT_FILE, "{not json");
    expect(loadLayout()).toBe(DEFAULT_LAYOUT);
  });
});
