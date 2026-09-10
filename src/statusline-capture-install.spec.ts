import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as StatuslineCaptureInstallModule from "./statusline-capture-install.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

async function freshModule(): Promise<typeof StatuslineCaptureInstallModule> {
  vi.resetModules();
  return import("./statusline-capture-install.js");
}

describe("installCaptureOnly", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-capture-test-"));
    mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("creates a minimal capture-only script when none exists", async () => {
    const { installCaptureOnly } = await freshModule();
    const result = await installCaptureOnly(vi.fn().mockResolvedValue(true));
    expect(result.installed).toBe(true);
    expect(result.backupPath).toBeNull();
    const content = readFileSync(path.join(fakeHome, ".claude", "statusline.sh"), "utf8");
    expect(content).toContain("cc-daily-usage:capture");
    expect(content).toContain("cc-daily-usage --statusline");
  });

  it("injects the capture line into an existing foreign script and backs it up", async () => {
    const { installCaptureOnly } = await freshModule();
    const statuslinePath = path.join(fakeHome, ".claude", "statusline.sh");
    writeFileSync(statuslinePath, '#!/usr/bin/env bash\ninput=$(cat)\necho "hi"');
    const result = await installCaptureOnly(vi.fn().mockResolvedValue(true));
    expect(result.installed).toBe(true);
    expect(result.backupPath).toMatch(/statusline\.sh\.bak_\d+$/);
    const content = readFileSync(statuslinePath, "utf8");
    expect(content).toContain("cc-daily-usage:capture");
    expect(content).toContain('echo "hi"');
  });

  it("injects at the very top when the existing script has no shebang line", async () => {
    const { installCaptureOnly } = await freshModule();
    const statuslinePath = path.join(fakeHome, ".claude", "statusline.sh");
    writeFileSync(statuslinePath, 'input=$(cat)\necho "hi"');
    await installCaptureOnly(vi.fn().mockResolvedValue(true));
    const content = readFileSync(statuslinePath, "utf8");
    expect(content.split("\n")[0]).toBe("# cc-daily-usage:capture v1");
  });

  it("does nothing on decline", async () => {
    const { installCaptureOnly } = await freshModule();
    const result = await installCaptureOnly(vi.fn().mockResolvedValue(false));
    expect(result.installed).toBe(false);
    expect(existsSync(path.join(fakeHome, ".claude", "statusline.sh"))).toBe(false);
  });

  it("is a silent no-op when the capture marker is already present", async () => {
    const { installCaptureOnly } = await freshModule();
    const statuslinePath = path.join(fakeHome, ".claude", "statusline.sh");
    writeFileSync(statuslinePath, "# cc-daily-usage:capture v1\necho hi");
    const confirm = vi.fn();
    const result = await installCaptureOnly(confirm);
    expect(result.installed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("is a silent no-op when the full managed marker is already present", async () => {
    const { installCaptureOnly } = await freshModule();
    const statuslinePath = path.join(fakeHome, ".claude", "statusline.sh");
    writeFileSync(statuslinePath, "# cc-daily-usage:managed vdeadbeef\necho hi");
    const confirm = vi.fn();
    const result = await installCaptureOnly(confirm);
    expect(result.installed).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
