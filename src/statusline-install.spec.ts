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
    const statuslinePath = path.join(fakeHome, ".claude", "statusline.sh");
    writeFileSync(statuslinePath, "#!/usr/bin/env bash\necho hand-written");
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
    expect(existsSync(path.join(fakeHome, ".claude", "statusline.sh"))).toBe(false);
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
    const statuslinePath = path.join(fakeHome, ".claude", "statusline.sh");
    writeFileSync(statuslinePath, "# cc-daily-usage:managed vdeadbeef\necho old-version");
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
});
