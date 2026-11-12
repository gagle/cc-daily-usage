import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

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
    fakeHome = mkdtempSync(path.join(tmpdir(), "cc-spend-shared-test-"));
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
    expect(hasMarker("// cc-spend:managed vdeadbeef", MANAGED_MARKER_REGEX)).toBe(true);
    expect(hasMarker("// cc-spend:capture v1", CAPTURE_MARKER_REGEX)).toBe(true);
    expect(hasMarker("plain script", MANAGED_MARKER_REGEX)).toBe(false);
  });

  it("computeShippedVersion is a stable 8-hex-char hash of the template", async () => {
    const { computeShippedVersion } = await freshModule();
    const version = computeShippedVersion("echo hi __CC_SPEND_VERSION__");
    expect(version).toMatch(/^[0-9a-f]{8}$/);
    expect(computeShippedVersion("echo hi __CC_SPEND_VERSION__")).toBe(version);
    expect(computeShippedVersion("echo bye __CC_SPEND_VERSION__")).not.toBe(version);
  });

  it("stampVersion substitutes every placeholder occurrence", async () => {
    const { stampVersion } = await freshModule();
    expect(stampVersion("v=__CC_SPEND_VERSION__ (__CC_SPEND_VERSION__)", "abc12345")).toBe(
      "v=abc12345 (abc12345)",
    );
  });

  it("extractVersion reads the version out of a managed marker, or null when absent", async () => {
    const { extractVersion } = await freshModule();
    expect(extractVersion("// cc-spend:managed vabc12345\necho hi")).toBe("abc12345");
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
    expect(settings.statusLine).toEqual({
      type: "command",
      command: `node ${JSON.stringify(STATUSLINE_FILE)}`,
      refreshInterval: 30,
    });
  });

  it("ensureSettingsStatusLine merges without touching other existing keys", async () => {
    const { ensureSettingsStatusLine, SETTINGS_FILE } = await freshModule();
    writeFileSync(SETTINGS_FILE, JSON.stringify({ someOtherKey: "keep-me" }));
    ensureSettingsStatusLine();
    const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
    expect(settings.someOtherKey).toBe("keep-me");
    expect(settings.statusLine).toBeDefined();
  });

  it("assetsDir is the package's assets/ next to dist/", async () => {
    const { assetsDir } = await freshModule();
    expect(existsSync(path.join(assetsDir(), "statusline.mjs"))).toBe(true);
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

  describe("refresh interval, prompt gate hook, cache TTL", () => {
    const readSettings = (file: string): Record<string, unknown> =>
      JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

    it("ensureSettingsStatusLine puts the legacy live 1s interval back to 30, keeps a user value, keeps the mode", async () => {
      const { ensureSettingsStatusLine, STATUSLINE_FILE, SETTINGS_FILE } = await freshModule();
      const interval = (): unknown =>
        (readSettings(SETTINGS_FILE).statusLine as { refreshInterval: unknown }).refreshInterval;
      const command = `node ${JSON.stringify(STATUSLINE_FILE)}`;
      mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      writeFileSync(SETTINGS_FILE, JSON.stringify({ statusLine: { command, refreshInterval: 1 } }));
      chmodSync(SETTINGS_FILE, 0o640);
      ensureSettingsStatusLine();
      expect(interval()).toBe(30);
      expect(statSync(SETTINGS_FILE).mode & 0o777).toBe(0o640);
      writeFileSync(SETTINGS_FILE, JSON.stringify({ statusLine: { command, refreshInterval: 7 } }));
      ensureSettingsStatusLine();
      expect(interval()).toBe(7);
    });

    it("ensureManagedHooks adds, re-points and removes only our hooks", async () => {
      const { ensureManagedHooks, hookCommand, SETTINGS_FILE } = await freshModule();
      const theirs = { hooks: [{ type: "command", command: "their-hook" }] };
      const bare = { matcher: "" }; // a group with no hooks array is kept as is
      writeFileSync(
        SETTINGS_FILE,
        JSON.stringify({ hooks: { UserPromptSubmit: [theirs, bare], Stop: [] } }),
      );
      ensureManagedHooks("/a/bin.js");
      ensureManagedHooks("/b/bin.js");
      let hooks = readSettings(SETTINGS_FILE).hooks as Record<string, Array<unknown>>;
      expect(hooks.UserPromptSubmit).toEqual([
        theirs,
        bare,
        {
          hooks: [
            { type: "command", command: hookCommand("/b/bin.js", "--prompt-gate"), timeout: 10 },
          ],
        },
      ]);
      expect(hooks.PreModelSwitch).toEqual([
        {
          hooks: [
            { type: "command", command: hookCommand("/b/bin.js", "--model-switch"), timeout: 10 },
          ],
        },
      ]);
      ensureManagedHooks("/b/bin.js"); // unchanged → no write
      ensureManagedHooks(null);
      hooks = readSettings(SETTINGS_FILE).hooks as Record<string, Array<unknown>>;
      expect(hooks.UserPromptSubmit).toEqual([theirs, bare]);
      expect(hooks.PreModelSwitch).toBeUndefined();
    });

    it("ensureManagedHooks installs our subagentStatusLine, keeps a user's own, removes only ours", async () => {
      const { ensureManagedHooks, hookCommand, SETTINGS_FILE } = await freshModule();
      mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      writeFileSync(SETTINGS_FILE, "{}");
      ensureManagedHooks("/a/bin.js");
      expect(readSettings(SETTINGS_FILE).subagentStatusLine).toEqual({
        type: "command",
        command: hookCommand("/a/bin.js", "--subagent-statusline"),
      });
      ensureManagedHooks(null);
      expect(readSettings(SETTINGS_FILE).subagentStatusLine).toBeUndefined();
      writeFileSync(SETTINGS_FILE, JSON.stringify({ subagentStatusLine: { command: "mine" } }));
      ensureManagedHooks("/a/bin.js");
      ensureManagedHooks(null);
      expect(readSettings(SETTINGS_FILE).subagentStatusLine).toEqual({ command: "mine" });
    });

    it("removing our only hooks drops empty hook keys", async () => {
      const { ensureManagedHooks, SETTINGS_FILE } = await freshModule();
      writeFileSync(SETTINGS_FILE, "{}");
      ensureManagedHooks("/a/bin.js");
      ensureManagedHooks(null);
      expect(readSettings(SETTINGS_FILE).hooks).toBeUndefined();
      writeFileSync(SETTINGS_FILE, JSON.stringify({ hooks: { Stop: [{ hooks: [] }] } }));
      ensureManagedHooks(null);
      expect(readSettings(SETTINGS_FILE).hooks).toEqual({ Stop: [{ hooks: [] }] });
    });

    it("promptCacheTtl reads and writes settings.json", async () => {
      const { promptCacheTtl, setPromptCacheTtl, SETTINGS_FILE } = await freshModule();
      expect(promptCacheTtl()).toBeUndefined();
      writeFileSync(SETTINGS_FILE, JSON.stringify({ keep: true, promptCacheTtl: 5 }));
      expect(promptCacheTtl()).toBeUndefined();
      setPromptCacheTtl("1h");
      expect(promptCacheTtl()).toBe("1h");
      expect(readSettings(SETTINGS_FILE).keep).toBe(true);
    });
  });
});
