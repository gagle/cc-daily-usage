import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

  it("self-heals an empty usage.json to a fresh usage and rewrites the file", async () => {
    const { loadUsage, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "usage.json");
    writeFileSync(file, "");
    const usage = loadUsage("acct");
    expect(usage.monthlySpent).toBe(0);
    expect(usage.sessions).toEqual({});
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ monthlySpent: 0, sessions: {} });
  });

  it("self-heals invalid usage.json to a fresh usage and rewrites the file", async () => {
    const { loadUsage, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "usage.json");
    writeFileSync(file, "{ not json");
    expect(loadUsage("acct").monthlySpent).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ monthlySpent: 0 });
  });

  it("self-heals non-object usage.json values (null/array/number) to a fresh usage", async () => {
    const { loadUsage, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "usage.json");
    for (const raw of ["null", "[]", "42"]) {
      writeFileSync(file, raw);
      expect(loadUsage("acct").monthlySpent).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ monthlySpent: 0 });
    }
  });

  it("self-heals an empty config.json to DEFAULT_CONFIG and rewrites the file", async () => {
    const { loadConfig, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    writeFileSync(file, "");
    expect(loadConfig("acct")).toEqual({ monthlyCap: 200, laboralDays: {} });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ monthlyCap: 200, laboralDays: {} });
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
      schemaVersion: 2,
      monthlySpent: 42,
      periodFrozen: 0,
      lastUpdated: "2026-09-01T00:00:00.000Z",
      days: {},
      sessions: {},
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
      }),
    );

    const { loadConfig, loadUsage } = await freshConfigModule();
    expect(loadConfig("legacy").monthlyCap).toBe(321);
    expect(loadUsage("legacy").monthlySpent).toBe(12);
  });

  it("keeps a copy of a corrupt file before re-seeding it", async () => {
    const { loadConfig, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), "{ broken");
    loadConfig("acct");
    const copies = readdirSync(dir).filter((name) => name.startsWith("config.json.corrupt-"));
    expect(copies).toHaveLength(1);
    expect(readFileSync(path.join(dir, copies[0] ?? ""), "utf8")).toBe("{ broken");
  });

  it("a quarantine failure never blocks the re-seed", async () => {
    const { loadUsage, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    // A directory named like the copy target makes copyFileSync throw.
    vi.spyOn(Date, "now").mockReturnValue(42);
    mkdirSync(path.join(dir, "usage.json.corrupt-42"));
    writeFileSync(path.join(dir, "usage.json"), "[]");
    expect(loadUsage("acct").monthlySpent).toBe(0);
  });

  it("a non-numeric monthlyCap falls back to the default", async () => {
    const { loadConfig, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ monthlyCap: "lots", laboralDays: {} }),
    );
    expect(loadConfig("acct").monthlyCap).toBe(200);
  });

  it("defaults are copies — mutating one never leaks into the next load", async () => {
    const { loadConfig } = await freshConfigModule();
    const first = loadConfig("a") as { laboralDays: Record<string, unknown> };
    first.laboralDays.x = 1;
    expect(loadConfig("b").laboralDays).toEqual({});
  });

  it("a fresh usage.json starts at now (no 1970 walk)", async () => {
    const { loadUsage } = await freshConfigModule();
    const now = new Date("2026-10-10T10:00:00.000Z");
    expect(loadUsage("acct", now).lastUpdated).toBe(now.toISOString());
  });

  it("saveUsage skips a write that would not change the file", async () => {
    const { loadUsage, saveUsage, ACCOUNTS_DIR } = await freshConfigModule();
    const usage = loadUsage("acct");
    const file = path.join(ACCOUNTS_DIR, "acct", "usage.json");
    writeFileSync(file, readFileSync(file, "utf8")); // same content
    const reread = loadUsage("acct");
    rmSync(file);
    saveUsage("acct", reread);
    expect(existsSync(file)).toBe(false); // unchanged → no write
    saveUsage("acct", { ...usage, monthlySpent: 3 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ monthlySpent: 3 });
  });

  it("api-cache.json round-trips; missing or invalid reads as null", async () => {
    const { loadApiCache, saveApiCache, apiCacheFile } = await freshConfigModule();
    expect(loadApiCache("acct")).toBeNull();
    const cache = { fetchedAt: 5, extraUsage: null, fiveHour: null, sevenDay: null };
    saveApiCache("acct", cache);
    expect(loadApiCache("acct")).toEqual(cache);
    writeFileSync(apiCacheFile("acct"), JSON.stringify({ fetchedAt: "x" }));
    expect(loadApiCache("acct")).toBeNull();
  });

  it("writeFileAtomic creates the parent directory and leaves no temp file", async () => {
    const { writeFileAtomic } = await freshConfigModule();
    const file = path.join(fakeHome, "deep", "dir", "f.json");
    writeFileAtomic(file, "{}");
    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(readdirSync(path.dirname(file))).toEqual(["f.json"]);
  });
});
