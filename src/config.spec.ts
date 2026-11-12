import type * as NodeFs from "node:fs";
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
    fakeHome = mkdtempSync(path.join(tmpdir(), "cc-spend-test-"));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("moves the pre-rename ~/.config/cc-daily-usage to ~/.config/cc-spend once", async () => {
    const legacy = path.join(fakeHome, ".config", "cc-daily-usage");
    mkdirSync(path.join(legacy, "accounts", "acct"), { recursive: true });
    writeFileSync(path.join(legacy, "accounts", "acct", "config.json"), '{"monthlyCap":321}');
    const { moveLegacyRootDir, loadConfig, CONFIG_ROOT_DIR } = await freshConfigModule();
    moveLegacyRootDir();
    expect(existsSync(legacy)).toBe(false);
    expect(loadConfig("acct").monthlyCap).toBe(321);
    // The new directory exists now: a second call (or a stray old directory) changes nothing.
    mkdirSync(legacy);
    moveLegacyRootDir();
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(CONFIG_ROOT_DIR)).toBe(true);
  });

  it("does nothing without the old directory, and keeps it when the move fails", async () => {
    const { moveLegacyRootDir, CONFIG_ROOT_DIR } = await freshConfigModule();
    moveLegacyRootDir();
    expect(existsSync(CONFIG_ROOT_DIR)).toBe(false);

    const legacy = path.join(fakeHome, ".config", "cc-daily-usage");
    mkdirSync(legacy, { recursive: true });
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => ({
      ...(await importOriginal<typeof NodeFs>()),
      renameSync: () => {
        throw new Error("EXDEV");
      },
    }));
    try {
      const failing = await import("./config.js");
      expect(() => {
        failing.moveLegacyRootDir();
      }).not.toThrow();
      expect(existsSync(legacy)).toBe(true);
    } finally {
      vi.doUnmock("node:fs");
    }
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
    const now = new Date("2026-10-10T10:00:00.000Z"); // one instant: every fresh usage serializes the same
    for (const raw of ["null", "[]", "42"]) {
      writeFileSync(file, raw);
      expect(loadUsage("acct", now).monthlySpent).toBe(0);
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
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      monthlyCap: 200,
      laboralDays: {},
      schemaVersion: 1,
    });
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
      apiEqDays: {},
      apiEqTotal: 0,
      missCauses: {},
    };
    saveUsage("acct", usage);
    expect(loadUsage("acct")).toEqual(usage);
  });

  it("fills in monthlyCap/laboralDays from DEFAULT_CONFIG when a stored config omits them, writing only the version", async () => {
    const { loadConfig, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ planType: "claude_pro", hasSpendCap: false }));
    const config = loadConfig("acct");
    expect(config.monthlyCap).toBe(200);
    expect(config.laboralDays).toEqual({});
    expect(config.hasSpendCap).toBe(false);
    // In-memory fill only — the migration adds the version and nothing else.
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      planType: "claude_pro",
      hasSpendCap: false,
      schemaVersion: 1,
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
    const legacyDir = path.join(fakeHome, ".config", "cc-spend");
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
    const legacyDir = path.join(fakeHome, ".config", "cc-spend");
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
    const legacyDir = path.join(fakeHome, ".config", "cc-spend");
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

  it("legacy files: versioned once with a backup, unknown fields kept, a rerun changes nothing", async () => {
    const { loadConfig, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ monthlyCap: 5, laboralDays: {}, future: "kept" }));
    expect(loadConfig("acct")).toMatchObject({ monthlyCap: 5, future: "kept" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      monthlyCap: 5,
      laboralDays: {},
      future: "kept",
      schemaVersion: 1,
    });
    const backups = (): Array<string> =>
      readdirSync(dir).filter((name) => name.startsWith("config.json.bak-"));
    expect(backups()).toHaveLength(1);
    loadConfig("acct");
    expect(backups()).toHaveLength(1);
  });

  it("a v1 usage.json gets a backup before its upgrade", async () => {
    const { loadUsage, ACCOUNTS_DIR } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "usage.json"), JSON.stringify({ monthlySpent: 1, days: {} }));
    loadUsage("acct");
    expect(readdirSync(dir).some((name) => name.startsWith("usage.json.bak-"))).toBe(true);
  });

  it("newer files are read but never rewritten, and are listed", async () => {
    const {
      loadConfig,
      saveConfig,
      loadUsage,
      saveUsage,
      loadApiCache,
      saveApiCache,
      ACCOUNTS_DIR,
      listNewerFiles,
    } = await freshConfigModule();
    const dir = path.join(ACCOUNTS_DIR, "acct");
    mkdirSync(dir, { recursive: true });
    const files = {
      config: JSON.stringify({ schemaVersion: 9, monthlyCap: 7, laboralDays: {} }),
      usage: JSON.stringify({ schemaVersion: 9, monthlySpent: 1, days: {}, sessions: {} }),
      api: JSON.stringify({ schemaVersion: 9, fetchedAt: 1 }),
    };
    writeFileSync(path.join(dir, "config.json"), files.config);
    writeFileSync(path.join(dir, "usage.json"), files.usage);
    writeFileSync(path.join(dir, "api-cache.json"), files.api);
    const config = loadConfig("acct");
    expect(config.monthlyCap).toBe(7);
    saveConfig("acct", { ...config, monthlyCap: 1 });
    const usage = loadUsage("acct");
    saveUsage("acct", { ...usage, monthlySpent: 99 });
    expect(loadApiCache("acct")).toBeNull();
    saveApiCache("acct", { fetchedAt: 2, extraUsage: null, fiveHour: null, sevenDay: null });
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).toBe(files.config);
    expect(readFileSync(path.join(dir, "usage.json"), "utf8")).toBe(files.usage);
    expect(readFileSync(path.join(dir, "api-cache.json"), "utf8")).toBe(files.api);
    expect(listNewerFiles()).toHaveLength(3);
  });

  it("history files: round-trip, empty when missing or garbled, a newer one left alone", async () => {
    const {
      loadLimitSamples,
      saveLimitSamples,
      loadSessionsMap,
      saveSessionsMap,
      limitsFile,
      sessionsMapFile,
    } = await freshConfigModule();
    expect(loadLimitSamples("acct")).toEqual([]);
    expect(loadSessionsMap("acct")).toEqual({});
    const sample = {
      t: 1,
      fiveHourPct: 1,
      sevenDayPct: null,
      fiveHourResetsAt: null,
      sevenDayResetsAt: null,
      apiEqTotal: 0,
    };
    saveLimitSamples("acct", [sample]);
    expect(loadLimitSamples("acct")).toEqual([sample]);
    const earlier = { ...sample, t: sample.t - 1000 };
    saveLimitSamples("acct", [sample, earlier]); // two racing renders wrote out of order
    expect(loadLimitSamples("acct")).toEqual([earlier, sample]);
    const entry = {
      transcriptPath: null,
      firstSeenAt: "a",
      lastSeenAt: "a",
      costUsd: 0,
      linesAdded: 0,
      linesRemoved: 0,
    };
    saveSessionsMap("acct", { s: entry });
    expect(loadSessionsMap("acct")).toEqual({ s: entry });
    writeFileSync(limitsFile("acct"), JSON.stringify({ schemaVersion: 1, samples: "x" }));
    writeFileSync(sessionsMapFile("acct"), JSON.stringify({ schemaVersion: 1, sessions: [] }));
    expect(loadLimitSamples("acct")).toEqual([]);
    expect(loadSessionsMap("acct")).toEqual({});
    const newer = JSON.stringify({ schemaVersion: 2, samples: [] });
    writeFileSync(limitsFile("acct"), newer);
    expect(loadLimitSamples("acct")).toEqual([]);
    saveLimitSamples("acct", [sample]);
    expect(readFileSync(limitsFile("acct"), "utf8")).toBe(newer);
  });

  it("feed advice: written by saveFeed, empty when missing or not a list", async () => {
    const { saveFeed, loadFeedAdvice, feedFile } = await freshConfigModule();
    expect(loadFeedAdvice("acct")).toEqual([]);
    saveFeed("acct", { schemaVersion: 1, advice: [{ id: "R1" }] });
    expect(loadFeedAdvice("acct")).toEqual([{ id: "R1" }]);
    writeFileSync(feedFile("acct"), JSON.stringify({ schemaVersion: 1, advice: {} }));
    expect(loadFeedAdvice("acct")).toEqual([]);
  });

  it("backupFile keeps the newest three and never throws", async () => {
    const { backupFile } = await freshConfigModule();
    const file = path.join(fakeHome, "f.json");
    writeFileSync(file, "{}");
    for (let day = 1; day <= 5; day++) backupFile(file, new Date(Date.UTC(2026, 9, day)));
    const names = readdirSync(fakeHome).filter((name) => name.startsWith("f.json.bak-"));
    expect(names).toHaveLength(3);
    expect(names.every((name) => !name.includes(":"))).toBe(true);
    expect(names.sort()[0]).toContain("2026-10-03");
    expect(() => {
      backupFile(path.join(fakeHome, "missing.json"));
    }).not.toThrow();
  });

  it("writeFileAtomic creates the parent directory and leaves no temp file", async () => {
    const { writeFileAtomic } = await freshConfigModule();
    const file = path.join(fakeHome, "deep", "dir", "f.json");
    writeFileAtomic(file, "{}");
    expect(readFileSync(file, "utf8")).toBe("{}");
    expect(readdirSync(path.dirname(file))).toEqual(["f.json"]);
  });

  it("lists account folders and peeks one session read-only", async () => {
    const { listAccountKeys, peekSessionCost, ACCOUNTS_DIR } = await freshConfigModule();
    expect(listAccountKeys()).toEqual([]);
    expect(peekSessionCost("a", "s1")).toBeUndefined(); // no file
    mkdirSync(path.join(ACCOUNTS_DIR, "a"), { recursive: true });
    const file = path.join(ACCOUNTS_DIR, "a", "usage.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
    expect(listAccountKeys()).toEqual(["a"]);
    expect(peekSessionCost("a", "s1")).toBeUndefined(); // no sessions
    const entry = { lastSeenCost: 3, lastSeenAt: "2026-10-23T08:00:00.000Z" };
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, sessions: { s1: entry } }));
    expect(peekSessionCost("a", "s1")).toEqual(entry);
    expect(readdirSync(path.join(ACCOUNTS_DIR, "a"))).toEqual(["usage.json"]); // no backup, no seed
  });

  it("account-log.json round-trips; a missing or bad one is empty", async () => {
    const { loadAccountLog, saveAccountLog, ACCOUNT_LOG_FILE } = await freshConfigModule();
    expect(loadAccountLog()).toEqual([]);
    saveAccountLog([{ t: 1, key: "a" }]);
    expect(loadAccountLog()).toEqual([{ t: 1, key: "a" }]);
    writeFileSync(ACCOUNT_LOG_FILE, JSON.stringify({ schemaVersion: 1, switches: {} }));
    expect(loadAccountLog()).toEqual([]);
  });
});
