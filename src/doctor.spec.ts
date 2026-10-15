import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as DoctorModule from "./doctor.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: Array<unknown>) => execFileMock(...args) as unknown,
}));

function fresh(): Promise<typeof DoctorModule> {
  return import("./doctor.js");
}

const NOW = new Date("2026-10-15T10:00:00.000Z");

function accountDir(key: string): string {
  const dir = path.join(fakeHome, ".config", "cc-daily-usage", "accounts", key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function claudeAnswers(stdout: string | null): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: unknown,
      _opts: unknown,
      done: (e: Error | null, out: string) => void,
    ) => {
      done(stdout === null ? new Error("ENOENT") : null, stdout ?? "");
    },
  );
}

beforeEach(() => {
  vi.resetModules(); // module-level paths read homedir() at import
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccdu-doctor-"));
  claudeAnswers("2.1.293 (Claude Code)\n");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("single checks", () => {
  it("node: 24 or later", async () => {
    const { checkNode } = await fresh();
    expect(checkNode("24.1.0").status).toBe("ok");
    expect(checkNode("22.9.0")).toMatchObject({
      status: "fail",
      detail: "22.9.0; needs 24 or later",
    });
  });

  it("claude: version, a warn when it does not run", async () => {
    const { claudeVersion, checkClaude } = await fresh();
    expect(await claudeVersion()).toBe("2.1.293");
    claudeAnswers(null);
    expect(await claudeVersion()).toBeNull();
    claudeAnswers("");
    expect(await claudeVersion()).toBeNull();
    expect(checkClaude(null).status).toBe("warn");
    expect(checkClaude("2.1.293")).toEqual({ status: "ok", name: "claude", detail: "2.1.293" });
  });

  it("formats each status", async () => {
    const { formatCheck } = await fresh();
    expect(formatCheck({ status: "ok", name: "a", detail: "b" })).toBe("✔ a: b");
    expect(formatCheck({ status: "warn", name: "a", detail: "b" })).toBe("⚠ a: b");
    expect(formatCheck({ status: "fail", name: "a", detail: "b" })).toBe("✖ a: b");
  });
});

describe("checkStatusline", () => {
  it("nothing installed: the shim fails, hooks warn", async () => {
    const { checkStatusline } = await fresh();
    const checks = checkStatusline();
    expect(checks[0]?.status).toBe("fail");
    expect(checks.filter((check) => check.name.startsWith("hook"))).toHaveLength(2);
    expect(checks.every((check) => check.status !== "ok")).toBe(true);
  });

  it("after install: shim current, settings and hooks ok; an old shim or foreign command flags", async () => {
    const { installStatusline } = await import("./statusline-install.js");
    await installStatusline(() => Promise.resolve(true));
    const { checkStatusline } = await fresh();
    expect(checkStatusline().map((check) => check.status)).toEqual(["ok", "ok", "ok", "ok"]);

    const { STATUSLINE_FILE, SETTINGS_FILE } = await import("./statusline-shared.js");
    writeFileSync(STATUSLINE_FILE, "// cc-daily-usage:managed v00000000\n");
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify({ statusLine: { command: "other" }, hooks: { UserPromptSubmit: [{}] } }),
    );
    expect(checkStatusline().map((check) => check.status)).toEqual([
      "warn",
      "fail",
      "warn",
      "warn",
    ]);
  });

  it("a capture-only line counts as installed", async () => {
    const { STATUSLINE_FILE } = await import("./statusline-shared.js");
    mkdirSync(path.dirname(STATUSLINE_FILE), { recursive: true });
    writeFileSync(STATUSLINE_FILE, "// cc-daily-usage:capture v1\n");
    const { checkStatusline } = await fresh();
    expect(checkStatusline()[0]).toMatchObject({ status: "ok", name: "statusline" });
  });
});

describe("checkAccounts", () => {
  it("no accounts folder", async () => {
    const { checkAccounts } = await fresh();
    expect(checkAccounts(NOW)).toEqual([
      { status: "warn", name: "accounts", detail: "none yet; open Claude Code once" },
    ]);
  });

  it("versions, garbled and newer files, refresher state", async () => {
    const good = accountDir("good");
    writeFileSync(path.join(good, "config.json"), JSON.stringify({ schemaVersion: 1 }));
    writeFileSync(path.join(good, "usage.json"), JSON.stringify({ schemaVersion: 2 }));
    writeFileSync(
      path.join(good, "api-cache.json"),
      JSON.stringify({ schemaVersion: 1, fetchedAt: NOW.getTime() - 30_000 }),
    );
    writeFileSync(
      path.join(good, "feed.json"),
      JSON.stringify({
        schemaVersion: 1,
        writtenAt: new Date(NOW.getTime() - 300_000).toISOString(),
      }),
    );
    const bad = accountDir("bad");
    writeFileSync(path.join(bad, "config.json"), "{oops");
    writeFileSync(path.join(bad, "usage.json"), "[]");
    writeFileSync(path.join(bad, "limits.json"), JSON.stringify({ schemaVersion: 7 }));
    writeFileSync(
      path.join(bad, "api-cache.json"),
      JSON.stringify({ fetchedAt: NOW.getTime() - 3 * 3_600_000, stale: true }),
    );
    const idle = accountDir("idle");
    writeFileSync(
      path.join(idle, "api-cache.json"),
      JSON.stringify({ fetchedAt: NOW.getTime() - 3_600_000 }),
    );
    const empty = accountDir("empty");
    const lock = path.join(empty, "refresh.lock");
    writeFileSync(lock, "");
    utimesSync(lock, new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 60_000));
    accountDir("nolock");
    writeFileSync(path.join(fakeHome, ".config", "cc-daily-usage", "accounts", "stray.txt"), "");

    const { checkAccounts } = await fresh();
    const byName = Object.fromEntries(checkAccounts(NOW).map((check) => [check.name, check]));
    expect(byName["account good"]).toEqual({
      status: "ok",
      name: "account good",
      detail: "config v1, usage v2, api-cache v1, feed v1",
    });
    expect(byName["refresher good"]?.detail).toBe("usage read 30 s ago, feed written 5 min ago");
    expect(byName["account bad"]).toMatchObject({
      status: "fail",
      detail:
        "config.json is not valid JSON; usage.json is not valid JSON; limits.json v7 is from a newer cc-daily-usage",
    });
    expect(byName["refresher bad"]).toMatchObject({
      status: "warn",
      detail: "usage read 3 h ago; last fetch failed",
    });
    expect(byName["refresher idle"]?.detail).toBe("usage read 60 min ago (no session since)");
    expect(byName["account empty"]?.detail).toBe("no files yet");
    expect(byName["refresher empty"]?.detail).toContain("dead refresher");
    expect(byName["refresher nolock"]?.detail).toContain("no usage reading yet");
    expect(byName["account stray.txt"]).toBeUndefined();
  });
});

describe("doctorReport", () => {
  it("exit 1 when a check fails; package version comes from package.json", async () => {
    const { doctorReport, packageVersion } = await fresh();
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    const report = await doctorReport(NOW);
    expect(report.code).toBe(1); // nothing installed in the temp HOME
    expect(report.text).toContain(`✔ cc-daily-usage: ${packageVersion()}`);
  });

  it("exit 0 when nothing fails", async () => {
    const { installStatusline } = await import("./statusline-install.js");
    await installStatusline(() => Promise.resolve(true));
    const { doctorReport } = await fresh();
    expect((await doctorReport()).code).toBe(0);
  });
});
