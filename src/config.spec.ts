import { mkdtempSync, rmSync, statSync } from "node:fs";
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
    const { loadConfig, CONFIG_FILE } = await freshConfigModule();
    const config = loadConfig();
    expect(config.monthlyCap).toBe(200);
    expect(config.laboralDays).toEqual({});
    const mode = statSync(CONFIG_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("seeds default usage.json on first read and writes it 0o600", async () => {
    const { loadUsage, USAGE_FILE } = await freshConfigModule();
    const usage = loadUsage();
    expect(usage.monthlySpent).toBe(0);
    expect(usage.sessions).toEqual({});
    const mode = statSync(USAGE_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("round-trips a saved config", async () => {
    const { loadConfig, saveConfig } = await freshConfigModule();
    saveConfig({ monthlyCap: 650, laboralDays: { "2026": { "9": [1, 2, 3] } } });
    const config = loadConfig();
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
    saveUsage(usage);
    expect(loadUsage()).toEqual(usage);
  });
});
