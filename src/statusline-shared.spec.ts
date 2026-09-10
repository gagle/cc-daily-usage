import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as StatuslineSharedModule from "./statusline-shared.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

async function freshModule(): Promise<typeof StatuslineSharedModule> {
  vi.resetModules();
  return import("./statusline-shared.js");
}

describe("statusline-shared", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-shared-test-"));
    mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("readIfExists returns null for a missing file and content for an existing one", async () => {
    const { readIfExists, STATUSLINE_FILE } = await freshModule();
    expect(readIfExists(STATUSLINE_FILE)).toBeNull();
    writeFileSync(STATUSLINE_FILE, "hello");
    expect(readIfExists(STATUSLINE_FILE)).toBe("hello");
  });

  it("hasMarker matches the managed and capture markers independently", async () => {
    const { hasMarker, MANAGED_MARKER_REGEX, CAPTURE_MARKER_REGEX } = await freshModule();
    expect(hasMarker("# cc-daily-usage:managed vdeadbeef", MANAGED_MARKER_REGEX)).toBe(true);
    expect(hasMarker("# cc-daily-usage:capture v1", CAPTURE_MARKER_REGEX)).toBe(true);
    expect(hasMarker("plain script", MANAGED_MARKER_REGEX)).toBe(false);
  });

  it("computeShippedVersion is a stable 8-hex-char hash of the template", async () => {
    const { computeShippedVersion } = await freshModule();
    const version = computeShippedVersion("echo hi __CC_DAILY_USAGE_VERSION__");
    expect(version).toMatch(/^[0-9a-f]{8}$/);
    expect(computeShippedVersion("echo hi __CC_DAILY_USAGE_VERSION__")).toBe(version);
    expect(computeShippedVersion("echo bye __CC_DAILY_USAGE_VERSION__")).not.toBe(version);
  });

  it("stampVersion substitutes every placeholder occurrence", async () => {
    const { stampVersion } = await freshModule();
    expect(
      stampVersion("v=__CC_DAILY_USAGE_VERSION__ (__CC_DAILY_USAGE_VERSION__)", "abc12345"),
    ).toBe("v=abc12345 (abc12345)");
  });

  it("extractVersion reads the version out of a managed marker, or null when absent", async () => {
    const { extractVersion } = await freshModule();
    expect(extractVersion("# cc-daily-usage:managed vabc12345\necho hi")).toBe("abc12345");
    expect(extractVersion("echo hi")).toBeNull();
  });

  it("backupFile returns null when the source is missing, and copies it otherwise", async () => {
    const { backupFile, STATUSLINE_FILE } = await freshModule();
    expect(backupFile(STATUSLINE_FILE)).toBeNull();
    writeFileSync(STATUSLINE_FILE, "content");
    const backupPath = backupFile(STATUSLINE_FILE);
    expect(backupPath).toMatch(/\.bak_\d+$/);
    expect(readFileSync(backupPath as string, "utf8")).toBe("content");
  });

  it("ensureSettingsStatusLine creates settings.json from scratch, preserving nothing to lose", async () => {
    const { ensureSettingsStatusLine, SETTINGS_FILE, STATUSLINE_FILE } = await freshModule();
    ensureSettingsStatusLine();
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
    expect(settings.statusLine).toEqual({ type: "command", command: STATUSLINE_FILE });
  });

  it("ensureSettingsStatusLine merges without touching other existing keys", async () => {
    const { ensureSettingsStatusLine, SETTINGS_FILE } = await freshModule();
    writeFileSync(SETTINGS_FILE, JSON.stringify({ someOtherKey: "keep-me" }));
    ensureSettingsStatusLine();
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
    expect(settings.someOtherKey).toBe("keep-me");
    expect(settings.statusLine).toBeDefined();
  });

  it("assetsDir falls back to the un-flattened ../assets layout (local dev/test tree)", async () => {
    const { assetsDir } = await freshModule();
    expect(assetsDir()).toMatch(/assets$/);
  });

  it("assetsDir prefers a same-level assets/ sibling when present (flattened prepare-dist layout)", async () => {
    // Simulate the flattened publish layout by giving import.meta.url's own directory a real sibling
    // assets/ — dirname(this test file) is src/, so a same-level src/assets/ must exist for the check.
    const sameLevelAssets = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
    mkdirSync(sameLevelAssets, { recursive: true });
    try {
      const { assetsDir } = await freshModule();
      expect(assetsDir()).toBe(sameLevelAssets);
    } finally {
      rmSync(sameLevelAssets, { recursive: true, force: true });
    }
  });

  it("readJsonFile returns an empty object when the file doesn't exist", async () => {
    const { readJsonFile, SETTINGS_FILE } = await freshModule();
    expect(readJsonFile(SETTINGS_FILE)).toEqual({});
  });
});

describe("defaultConfirm", () => {
  afterEach(() => {
    vi.doUnmock("node:readline/promises");
    vi.resetModules();
  });

  it.each([
    ["", true],
    ["y", true],
    ["yes", true],
    ["n", false],
    ["nope", false],
  ])("treats %j as %s", async (answer, expected) => {
    const close = vi.fn();
    vi.doMock("node:readline/promises", () => ({
      createInterface: () => ({ question: vi.fn().mockResolvedValue(answer), close }),
    }));
    vi.resetModules();
    const { defaultConfirm } = await import("./statusline-shared.js");
    await expect(defaultConfirm("Proceed?")).resolves.toBe(expected);
    expect(close).toHaveBeenCalled();
  });
});
