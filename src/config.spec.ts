import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConfigModule from "./config.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

async function freshConfigModule(): Promise<typeof ConfigModule> {
  vi.resetModules();
  return import("./config.js");
}

describe("config.ts", () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-test-"));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("seeds default config.json on first read and writes it 0o600", async () => {
    const { loadConfig, ACCOUNTS_DIR } = await freshConfigModule();
    const config = loadConfig("acct");
    expect(config.monthlyCap).toBe(200);
    expect(config.laboralDays).toEqual({});
    const mode = statSync(path.join(ACCOUNTS_DIR, "acct", "config.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("seeds default usage.json on first read and writes it 0o600", async () => {
    const { loadUsage, ACCOUNTS_DIR } = await freshConfigModule();
    const usage = loadUsage("acct");
    expect(usage.monthlySpent).toBe(0);
    expect(usage.sessions).toEqual({});
    const mode = statSync(path.join(ACCOUNTS_DIR, "acct", "usage.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips a saved config", async () => {
    const { loadConfig, saveConfig } = await freshConfigModule();
    saveConfig("acct", { monthlyCap: 650, laboralDays: { "2026": { "9": [1, 2, 3] } } });
    const config = loadConfig("acct");
    expect(config).toEqual({ monthlyCap: 650, laboralDays: { "2026": { "9": [1, 2, 3] } } });
  });

  it("round-trips saved usage", async () => {
    const { loadUsage, saveUsage } = await freshConfigModule();
    const usage = {
      monthlySpent: 42,
      lastUpdated: "2026-09-01T00:00:00.000Z",
      days: {},
      sessions: {},
      frozenForDate: null,
      frozenAvgPerDay: null,
      frozenSafeMonthTotal: null,
    };
    saveUsage("acct", usage);
    expect(loadUsage("acct")).toEqual(usage);
  });

  it("fills in monthlyCap/laboralDays from DEFAULT_CONFIG when a stored config omits them, without rewriting the file", async () => {
    const { loadConfig, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ planType: "claude_pro", hasSpendCap: false }));
    const config = loadConfig("acct");
    expect(config.monthlyCap).toBe(200);
    expect(config.laboralDays).toEqual({});
    expect(config.hasSpendCap).toBe(false);
    // In-memory fill only — the on-disk file is untouched.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      planType: "claude_pro",
      hasSpendCap: false,
    });
  });

  it("keeps two accounts' config/usage fully independent", async () => {
    const { loadConfig, saveConfig } = await freshConfigModule();
    saveConfig("alice_example_com", { monthlyCap: 100, laboralDays: {} });
    saveConfig("bob_example_com", { monthlyCap: 999, laboralDays: {} });
    expect(loadConfig("alice_example_com").monthlyCap).toBe(100);
    expect(loadConfig("bob_example_com").monthlyCap).toBe(999);
  });

  it("migrates a legacy config.json alone (no usage.json) into accounts/legacy/, never guessing the active account", async () => {
    const legacyDir = path.join(fakeHome, ".config", "cc-daily-usage");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      path.join(legacyDir, "config.json"),
      JSON.stringify({ monthlyCap: 555, laboralDays: {} }),
    );

    const { loadConfig } = await freshConfigModule();
    // Whichever account happens to be active right now must NOT receive someone else's history.
    expect(loadConfig("acct").monthlyCap).toBe(200);
    expect(loadConfig("legacy").monthlyCap).toBe(555);
  });

  it("migrates a legacy usage.json alone (no config.json) into accounts/legacy/", async () => {
    const legacyDir = path.join(fakeHome, ".config", "cc-daily-usage");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      path.join(legacyDir, "usage.json"),
      JSON.stringify({
        monthlySpent: 7,
        lastUpdated: "2026-09-01T00:00:00.000Z",
        days: {},
        sessions: {},
        frozenForDate: null,
        frozenAvgPerDay: null,
        frozenSafeMonthTotal: null,
      }),
    );

    const { loadUsage } = await freshConfigModule();
    expect(loadUsage("acct").monthlySpent).toBe(0);
    expect(loadUsage("legacy").monthlySpent).toBe(7);
  });

  it("migrates legacy single-account config.json/usage.json into accounts/legacy/ once", async () => {
    const legacyDir = path.join(fakeHome, ".config", "cc-daily-usage");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      path.join(legacyDir, "config.json"),
      JSON.stringify({ monthlyCap: 321, laboralDays: {} }),
    );
    writeFileSync(
      path.join(legacyDir, "usage.json"),
      JSON.stringify({
        monthlySpent: 12,
        lastUpdated: "2026-09-01T00:00:00.000Z",
        days: {},
        sessions: {},
        frozenForDate: null,
        frozenAvgPerDay: null,
        frozenSafeMonthTotal: null,
      }),
    );

    const { loadConfig, loadUsage } = await freshConfigModule();
    expect(loadConfig("legacy").monthlyCap).toBe(321);
    expect(loadUsage("legacy").monthlySpent).toBe(12);
  });
});
