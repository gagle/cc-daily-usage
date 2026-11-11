import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as StatuslineInstallModule from "./statusline-install.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

async function freshModule(): Promise<typeof StatuslineInstallModule> {
  vi.resetModules();
  return import("./statusline-install.js");
}

describe("installStatusline", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-install-test-"));
    mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("installs fresh with confirmation and backs up settings.json when it exists", async () => {
    const { installStatusline } = await freshModule();
    const settingsPath = path.join(fakeHome, ".claude", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ keepMe: true }));
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await installStatusline(confirm);
    expect(result.installed).toBe(true);
    expect(result.backupPath).toMatch(/settings\.json\.bak_\d+$/);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(settings.keepMe).toBe(true);
    expect(settings.statusLine).toBeDefined();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Install"));
  });

  it("installs fresh with no settings.json to back up", async () => {
    const { installStatusline } = await freshModule();
    const result = await installStatusline(vi.fn().mockResolvedValue(true));
    expect(result.installed).toBe(true);
    expect(result.backupPath).toBeNull();
  });

  it("prompts to replace a foreign script and does so on yes", async () => {
    const { installStatusline } = await freshModule();
    const statuslinePath = path.join(fakeHome, ".claude", "statusline.mjs");
    writeFileSync(statuslinePath, "#!/usr/bin/env node\nconsole.log('hand-written')");
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await installStatusline(confirm);
    expect(result.installed).toBe(true);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("replaced"));
    expect(readFileSync(statuslinePath, "utf8")).toContain("cc-daily-usage:managed");
  });

  it("does nothing when the user declines", async () => {
    const { installStatusline } = await freshModule();
    const result = await installStatusline(vi.fn().mockResolvedValue(false));
    expect(result.installed).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(existsSync(path.join(fakeHome, ".claude", "statusline.mjs"))).toBe(false);
  });

  it("re-running against an already-managed script is a silent no-op: no backup, no prompt, same version", async () => {
    const { installStatusline } = await freshModule();
    const confirm = vi.fn().mockResolvedValue(true);
    const first = await installStatusline(confirm);
    confirm.mockClear();
    const result = await installStatusline(confirm);
    expect(result.installed).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(result.fromVersion).toBe(first.toVersion);
    expect(result.toVersion).toBe(first.toVersion);
  });

  it("upgrades silently in place when the managed script content changed but the marker is still present", async () => {
    const { installStatusline } = await freshModule();
    const statuslinePath = path.join(fakeHome, ".claude", "statusline.mjs");
    writeFileSync(
      statuslinePath,
      "// cc-daily-usage:managed vdeadbeef\nconsole.log('old-version')",
    );
    const confirm = vi.fn();
    const result = await installStatusline(confirm);
    expect(result.installed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(readFileSync(statuslinePath, "utf8")).not.toContain("old-version");
    expect(result.fromVersion).toBe("deadbeef");
    expect(result.toVersion).not.toBe("deadbeef");
  });

  it("a fresh install has no fromVersion, only a toVersion", async () => {
    const { installStatusline } = await freshModule();
    const result = await installStatusline(vi.fn().mockResolvedValue(true));
    expect(result.fromVersion).toBeNull();
    expect(result.toVersion).toMatch(/^[0-9a-f]{8}$/);
  });

  it("a decline has neither fromVersion nor toVersion", async () => {
    const { installStatusline } = await freshModule();
    const result = await installStatusline(vi.fn().mockResolvedValue(false));
    expect(result.fromVersion).toBeNull();
    expect(result.toVersion).toBeNull();
  });

  it("stamps the shim with an absolute file:// entry and records what it replaced", async () => {
    const { installStatusline, statuslineEntryUrl } = await freshModule();
    const statuslinePath = path.join(fakeHome, ".claude", "statusline.mjs");
    const settingsPath = path.join(fakeHome, ".claude", "settings.json");
    writeFileSync(statuslinePath, "foreign");
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "x" } }));
    await installStatusline(vi.fn().mockResolvedValue(true));
    const shim = readFileSync(statuslinePath, "utf8");
    expect(statuslineEntryUrl()).toMatch(/^file:\/\/.*statusline\.js$/);
    expect(shim).toContain(`const ENTRY = "${statuslineEntryUrl()}";`);
    expect(shim).not.toContain("__CC_DAILY_USAGE_");
    const previous = JSON.parse(
      readFileSync(
        path.join(fakeHome, ".config", "cc-daily-usage", "previous-statusline.json"),
        "utf8",
      ),
    ) as { statusLine: unknown; scriptBackup: string };
    expect(previous.statusLine).toEqual({ type: "command", command: "x" });
    expect(readFileSync(previous.scriptBackup, "utf8")).toBe("foreign");
  });

  it("a moved package (new entry path) counts as a new version", async () => {
    const { shippedStatusline } = await freshModule();
    const template =
      '// cc-daily-usage:managed v__CC_DAILY_USAGE_VERSION__\nconst ENTRY = "__CC_DAILY_USAGE_ENTRY__";';
    const a = shippedStatusline(template, "file:///a/statusline.js");
    const b = shippedStatusline(template, "file:///b/statusline.js");
    expect(a.version).not.toBe(b.version);
    expect(a.content).toContain(`v${a.version}`);
  });
});

describe("uninstallStatusline", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-uninstall-test-"));
    mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  const statuslinePath = (): string => path.join(fakeHome, ".claude", "statusline.mjs");
  const settingsPath = (): string => path.join(fakeHome, ".claude", "settings.json");
  const readSettings = (): Record<string, unknown> =>
    JSON.parse(readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;

  it("no-op when nothing managed is installed", async () => {
    const { uninstallStatusline } = await freshModule();
    expect(uninstallStatusline()).toEqual({ removed: false, restoredFrom: null });
    writeFileSync(statuslinePath(), "foreign");
    expect(uninstallStatusline()).toEqual({ removed: false, restoredFrom: null });
  });

  it("restores the foreign script and the previous statusLine", async () => {
    const { installStatusline, uninstallStatusline } = await freshModule();
    writeFileSync(statuslinePath(), "foreign");
    writeFileSync(
      settingsPath(),
      JSON.stringify({ keep: 1, statusLine: { type: "command", command: "old" } }),
    );
    await installStatusline(vi.fn().mockResolvedValue(true));
    const result = uninstallStatusline();
    expect(result.removed).toBe(true);
    expect(result.restoredFrom).toMatch(/statusline\.mjs\.bak_\d+$/);
    expect(readFileSync(statuslinePath(), "utf8")).toBe("foreign");
    expect(readSettings()).toEqual({ keep: 1, statusLine: { type: "command", command: "old" } });
  });

  it("with nothing before: removes the shim and the statusLine key", async () => {
    const { installStatusline, uninstallStatusline } = await freshModule();
    await installStatusline(vi.fn().mockResolvedValue(true));
    expect(uninstallStatusline()).toEqual({ removed: true, restoredFrom: null });
    expect(existsSync(statuslinePath())).toBe(false);
    expect(readSettings().statusLine).toBeUndefined();
  });

  it("a shim installed before uninstall existed (no record) still uninstalls", async () => {
    const { uninstallStatusline } = await freshModule();
    writeFileSync(statuslinePath(), "// cc-daily-usage:managed vdeadbeef\n");
    writeFileSync(settingsPath(), JSON.stringify({ statusLine: { command: "node x" } }));
    expect(uninstallStatusline()).toEqual({ removed: true, restoredFrom: null });
    expect(readSettings().statusLine).toBeUndefined();
  });
  it("isEphemeralInstall spots npx and pnpm dlx caches", async () => {
    const { isEphemeralInstall } = await import("./statusline-install.js");
    expect(isEphemeralInstall("/home/u/.npm/_npx/1a2b/node_modules/cc-daily-usage/bin/x.js")).toBe(
      true,
    );
    expect(isEphemeralInstall("C:\\Users\\u\\AppData\\pnpm\\dlx\\abc\\x.js")).toBe(true);
    expect(isEphemeralInstall("/usr/local/lib/node_modules/cc-daily-usage/bin/x.js")).toBe(false);
    expect(isEphemeralInstall()).toBe(false);
  });
});
