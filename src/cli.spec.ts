import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CliModule from "./cli.js";

let tmpDir: string;

const loadConfigMock = vi.fn();
const loadUsageMock = vi.fn();
const saveConfigMock = vi.fn();
const saveUsageMock = vi.fn();

vi.mock("./config.js", () => ({
  loadConfig: (k: unknown) => loadConfigMock(k) as unknown,
  loadUsage: (k: unknown) => loadUsageMock(k) as unknown,
  saveConfig: (k: unknown, c: unknown) => saveConfigMock(k, c),
  saveUsage: (k: unknown, u: unknown) => saveUsageMock(k, u),
}));

const resolveActiveAccountMock = vi.fn().mockResolvedValue(null);
vi.mock("./account.js", () => ({
  resolveActiveAccount: () => resolveActiveAccountMock() as unknown,
  accountKey: () => "default",
}));

const resolveOAuthAccessTokenMock = vi.fn(
  (): { token: string; expiresAt: number | null } | null => null,
);
const getCachedExtraUsageMock = vi.fn().mockResolvedValue(null);
vi.mock("./anthropic-usage.js", () => ({
  resolveOAuthAccessToken: () => resolveOAuthAccessTokenMock() as unknown,
  getCachedExtraUsage: (...args: Array<unknown>) => getCachedExtraUsageMock(...args) as unknown,
}));

const runInitMock = vi.fn();
vi.mock("./init-server.js", () => ({ runInit: (...args: Array<unknown>) => runInitMock(...args) }));

const installStatuslineMock = vi.fn();
vi.mock("./statusline-install.js", () => ({
  installStatusline: (...args: Array<unknown>) => installStatuslineMock(...args),
}));

const installCaptureOnlyMock = vi.fn();
vi.mock("./statusline-capture-install.js", () => ({
  installCaptureOnly: (...args: Array<unknown>) => installCaptureOnlyMock(...args),
}));

const runDashboardTuiMock = vi.fn().mockResolvedValue(0);
vi.mock("./dashboard-tui.js", () => ({ runDashboardTui: () => runDashboardTuiMock() }));

function mockReadline(answer: string): void {
  vi.doMock("node:readline/promises", () => ({
    createInterface: () => ({ question: vi.fn().mockResolvedValue(answer), close: vi.fn() }),
  }));
}

function stubStdin(content: string): void {
  const stream = Readable.from([Buffer.from(content)]);
  vi.stubGlobal("process", { ...process, stdin: stream });
}

async function freshCli(): Promise<typeof CliModule> {
  vi.resetModules();
  return import("./cli.js");
}

describe("runCli", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-cli-test-"));
    loadConfigMock.mockReturnValue({
      monthlyCap: 650,
      laboralDays: { "2026": { "9": [1, 2, 3] } },
    });
    loadUsageMock.mockReturnValue({
      monthlySpent: 80.94,
      lastUpdated: "2026-09-03T00:00:00.000Z",
      days: {},
      sessions: {},
      frozenForDate: null,
      frozenAvgPerDay: null,
      frozenSafeMonthTotal: null,
    });
    resolveActiveAccountMock.mockResolvedValue(null);
    resolveOAuthAccessTokenMock.mockReturnValue(null);
    getCachedExtraUsageMock.mockResolvedValue(null);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.doUnmock("node:readline/promises");
    vi.clearAllMocks();
  });

  it("prints usage and exits 0 with --help", async () => {
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("cc-daily-usage"));
  });

  it("prints usage and exits 0 with -h", async () => {
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runCli(["-h"])).toBe(0);
  });

  it("prints usage and exits 0 with no arguments", async () => {
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runCli([])).toBe(0);
  });

  it("throws on an unknown operation", async () => {
    const { runCli } = await freshCli();
    await expect(runCli(["bogus-op"])).rejects.toThrow(/Unknown argument: bogus-op/);
  });

  it("throws on an empty-string operation argument", async () => {
    const { runCli } = await freshCli();
    await expect(runCli([""])).rejects.toThrow(/Unknown argument: /);
  });

  it("throws on an unknown flag", async () => {
    const { runCli } = await freshCli();
    await expect(runCli(["init", "--nope"])).rejects.toThrow(/Unknown argument: --nope/);
  });

  it("runs init, saves the returned config, then installs the full statusline on yes", async () => {
    runInitMock.mockResolvedValue({
      config: { monthlyCap: 650, laboralDays: {} },
      outcome: "done",
    });
    installStatuslineMock.mockResolvedValue({
      installed: true,
      backupPath: null,
      fromVersion: null,
      toVersion: "abc12345",
    });
    mockReadline("y");
    stubStdin("");
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["init"]);
    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledWith("default", { monthlyCap: 650, laboralDays: {} });
    expect(installStatuslineMock).toHaveBeenCalled();
    expect(installCaptureOnlyMock).not.toHaveBeenCalled();
  });

  it("runs init and falls back to capture-only install on no", async () => {
    runInitMock.mockResolvedValue({
      config: { monthlyCap: 650, laboralDays: {} },
      outcome: "heartbeat-gap",
    });
    mockReadline("n");
    stubStdin("");
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["init"]);
    expect(code).toBe(0);
    expect(installCaptureOnlyMock).toHaveBeenCalled();
    expect(installStatuslineMock).not.toHaveBeenCalled();
  });

  it("runs the statusline operation and reports a fresh install with a backup", async () => {
    installStatuslineMock.mockResolvedValue({
      installed: true,
      backupPath: "/tmp/settings.json.bak_123",
      fromVersion: null,
      toVersion: "abc12345",
    });
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["statusline"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Backed up"));
  });

  it("runs the statusline operation and reports an already-up-to-date no-op", async () => {
    installStatuslineMock.mockResolvedValue({
      installed: true,
      backupPath: null,
      fromVersion: "abc12345",
      toVersion: "abc12345",
    });
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runCli(["statusline"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already up to date"));
  });

  it("runs the statusline operation and reports a version upgrade", async () => {
    installStatuslineMock.mockResolvedValue({
      installed: true,
      backupPath: null,
      fromVersion: "aaaaaaaa",
      toVersion: "bbbbbbbb",
    });
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runCli(["statusline"]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Updated statusline: vaaaaaaaa → vbbbbbbbb"),
    );
  });

  it("runs the statusline operation and reports a decline", async () => {
    installStatuslineMock.mockResolvedValue({
      installed: false,
      backupPath: null,
      fromVersion: null,
      toVersion: null,
    });
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runCli(["statusline"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("declined"));
  });

  it("hidden --statusline mode: parses stdin, captures cost, and prints computed JSON", async () => {
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveUsageMock).toHaveBeenCalled();
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed).toHaveProperty("monthlySpent");
  });

  it("runs the dashboard operation", async () => {
    runDashboardTuiMock.mockResolvedValue(0);
    const { runCli } = await freshCli();
    const code = await runCli(["dashboard"]);
    expect(code).toBe(0);
    expect(runDashboardTuiMock).toHaveBeenCalled();
  });

  it("hidden --statusline mode: tolerates empty stdin and a missing session/cost", async () => {
    stubStdin("");
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
  });

  it("hidden --statusline mode: persists a reconciled config when a spent day isn't marked laboral", async () => {
    loadUsageMock.mockReturnValue({
      monthlySpent: 80.94,
      lastUpdated: "2026-09-03T00:00:00.000Z",
      days: { "2026-09-06": 12.5 }, // a Sunday, not in the fixture's laboralDays
      sessions: {},
      frozenForDate: null,
      frozenAvgPerDay: null,
      frozenSafeMonthTotal: null,
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ laboralDays: { "2026": { "9": [1, 2, 3, 6] } } }),
    );
  });

  it("hidden --statusline mode: includes extraUsage in the printed JSON when the live fetch has data", async () => {
    resolveOAuthAccessTokenMock.mockReturnValue({ token: "t", expiresAt: null });
    getCachedExtraUsageMock.mockResolvedValue({
      usedCredits: 162.99,
      monthlyLimit: 650,
      utilizationPct: 25,
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed.extraUsage).toEqual({
      usedCredits: 162.99,
      monthlyLimit: 650,
      utilizationPct: 25,
    });
  });

  it("hidden --statusline mode: extraUsage is null when there's no resolvable token", async () => {
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runCli(["--statusline"]);
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed.extraUsage).toBeNull();
    expect(getCachedExtraUsageMock).not.toHaveBeenCalled();
  });

  it("hidden --statusline mode: resolves and caches planType/hasSpendCap on first sight, hiding monthlyCap fields once rate_limits are present", async () => {
    resolveActiveAccountMock.mockResolvedValue({
      email: "a@b.com",
      accountUuid: "u1",
      organizationType: "claude_pro",
    });
    stubStdin(
      JSON.stringify({
        session_id: "s1",
        cost: { total_cost_usd: 5 },
        rate_limits: { five_hour: { used_percentage: 10 } },
      }),
    );
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ planType: "claude_pro", hasSpendCap: false }),
    );
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed).not.toHaveProperty("monthlySpent");
    expect(printed).not.toHaveProperty("monthlyCap");
    expect(printed).not.toHaveProperty("monthUsedPct");
  });

  it("hidden --statusline mode: does not re-resolve planType once already cached on config", async () => {
    loadConfigMock.mockReturnValue({
      monthlyCap: 650,
      laboralDays: { "2026": { "9": [1, 2, 3] } },
      planType: "enterprise",
      hasSpendCap: true,
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it("hidden --statusline mode: self-heals a previously-cached hasSpendCap:true once rate_limits is later observed", async () => {
    loadConfigMock.mockReturnValue({
      monthlyCap: 650,
      laboralDays: {},
      planType: "claude_pro",
      hasSpendCap: true, // wrong guess made on an earlier call whose payload lacked rate_limits
    });
    resolveActiveAccountMock.mockResolvedValue({
      email: "a@b.com",
      accountUuid: "u1",
      organizationType: "claude_pro",
    });
    stubStdin(
      JSON.stringify({
        session_id: "s1",
        cost: { total_cost_usd: 5 },
        rate_limits: { five_hour: { used_percentage: 10 } },
      }),
    );
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ hasSpendCap: false }),
    );
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed).not.toHaveProperty("monthlySpent");
  });

  it("hidden --statusline mode: self-heals a previously-cached hasSpendCap:false back to true when organizationType is claude_enterprise", async () => {
    loadConfigMock.mockReturnValue({
      monthlyCap: 650,
      laboralDays: {},
      planType: "claude_enterprise",
      hasSpendCap: false, // wrong guess baked in before classifyHasSpendCap existed
    });
    resolveActiveAccountMock.mockResolvedValue({
      email: "a@b.com",
      accountUuid: "u1",
      organizationType: "claude_enterprise",
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ hasSpendCap: true }),
    );
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed).toHaveProperty("monthlySpent");
  });

  it("hidden --statusline mode: never flips a confirmed hasSpendCap:false back to true", async () => {
    loadConfigMock.mockReturnValue({
      monthlyCap: 650,
      laboralDays: {},
      planType: "claude_pro",
      hasSpendCap: false,
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveConfigMock).not.toHaveBeenCalled();
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed).not.toHaveProperty("monthlySpent");
    expect(printed).not.toHaveProperty("todayUsage");
    expect(printed).not.toHaveProperty("avgPerDay");
    expect(printed).not.toHaveProperty("todayUsedPct");
  });

  it("hidden --statusline mode: skips rolloverIfNeeded/reconcileLaboralDays entirely on a confirmed no-spend-cap account", async () => {
    loadConfigMock.mockReturnValue({
      monthlyCap: 650,
      laboralDays: {},
      planType: "claude_pro",
      hasSpendCap: false,
    });
    loadUsageMock.mockReturnValue({
      monthlySpent: 80.94,
      lastUpdated: "2026-09-01T00:00:00.000Z", // a prior UTC day — would normally trigger rollover
      days: {},
      sessions: {},
      frozenForDate: null,
      frozenAvgPerDay: null,
      frozenSafeMonthTotal: null,
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveConfigMock).not.toHaveBeenCalled();
    const savedUsage = saveUsageMock.mock.calls[0]?.[1] as {
      frozenForDate: string | null;
      frozenAvgPerDay: number | null;
    };
    expect(savedUsage.frozenForDate).toBeNull();
    expect(savedUsage.frozenAvgPerDay).toBeNull();
  });

  it("hidden --statusline mode: a spend-cap account still prints todayUsage/avgPerDay/todayUsedPct alongside monthlySpent", async () => {
    loadConfigMock.mockReturnValue({
      monthlyCap: 650,
      laboralDays: { "2026": { "9": [1, 2, 3] } },
      planType: "claude_enterprise",
      hasSpendCap: true,
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed).toHaveProperty("todayUsage");
    expect(printed).toHaveProperty("avgPerDay");
    expect(printed).toHaveProperty("todayUsedPct");
    expect(printed).toHaveProperty("monthlySpent");
  });

  it("hidden --statusline mode: classifies hasSpendCap from organizationType on the very first render, no rate_limits needed", async () => {
    resolveActiveAccountMock.mockResolvedValue({
      email: "a@b.com",
      accountUuid: "u1",
      organizationType: "claude_enterprise",
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ planType: "claude_enterprise", hasSpendCap: true }),
    );
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed).toHaveProperty("monthlySpent");
  });

  it("hidden --statusline mode: a claude_pro account never accumulates monthlySpent, even on the first render", async () => {
    resolveActiveAccountMock.mockResolvedValue({
      email: "a@b.com",
      accountUuid: "u1",
      organizationType: "claude_pro",
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    const savedUsage = saveUsageMock.mock.calls[0]?.[1] as { monthlySpent: number };
    expect(savedUsage.monthlySpent).toBe(80.94); // unchanged from loadUsageMock's default
  });

  it("hidden --statusline mode: caches rate_limits percentages and echoes them in the printed JSON", async () => {
    stubStdin(
      JSON.stringify({
        session_id: "s1",
        cost: { total_cost_usd: 5 },
        rate_limits: { five_hour: { used_percentage: 46 }, seven_day: { used_percentage: 31 } },
      }),
    );
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    expect(saveUsageMock).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ rateLimitsCache: { fiveHourPct: 46, sevenDayPct: 31 } }),
    );
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed.rateLimitsCache).toEqual({ fiveHourPct: 46, sevenDayPct: 31 });
  });

  it("hidden --statusline mode: rateLimitsCache falls back per-field when only one side refreshes", async () => {
    loadUsageMock.mockReturnValue({
      monthlySpent: 80.94,
      lastUpdated: "2026-09-03T00:00:00.000Z",
      days: {},
      sessions: {},
      frozenForDate: null,
      frozenAvgPerDay: null,
      frozenSafeMonthTotal: null,
      rateLimitsCache: { fiveHourPct: 46, sevenDayPct: 31 },
    });
    stubStdin(
      JSON.stringify({
        session_id: "s1",
        cost: { total_cost_usd: 5 },
        rate_limits: { five_hour: { used_percentage: 60 } }, // seven_day absent this call
      }),
    );
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed.rateLimitsCache).toEqual({ fiveHourPct: 60, sevenDayPct: 31 });
  });

  it("hidden --statusline mode: rateLimitsCache falls back per-field when the other side refreshes", async () => {
    loadUsageMock.mockReturnValue({
      monthlySpent: 80.94,
      lastUpdated: "2026-09-03T00:00:00.000Z",
      days: {},
      sessions: {},
      frozenForDate: null,
      frozenAvgPerDay: null,
      frozenSafeMonthTotal: null,
      rateLimitsCache: { fiveHourPct: 46, sevenDayPct: 31 },
    });
    stubStdin(
      JSON.stringify({
        session_id: "s1",
        cost: { total_cost_usd: 5 },
        rate_limits: { seven_day: { used_percentage: 70 } }, // five_hour absent this call
      }),
    );
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed.rateLimitsCache).toEqual({ fiveHourPct: 46, sevenDayPct: 70 });
  });

  it("hidden --statusline mode: rateLimitsCache field is null with no percentage and no prior cache", async () => {
    stubStdin(
      JSON.stringify({
        session_id: "s1",
        cost: { total_cost_usd: 5 },
        rate_limits: { five_hour: {}, seven_day: {} }, // present but no used_percentage yet
      }),
    );
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed.rateLimitsCache).toEqual({ fiveHourPct: null, sevenDayPct: null });
  });

  it("hidden --statusline mode: echoes a prior rateLimitsCache when this call's payload has no rate_limits", async () => {
    loadUsageMock.mockReturnValue({
      monthlySpent: 80.94,
      lastUpdated: "2026-09-03T00:00:00.000Z",
      days: {},
      sessions: {},
      frozenForDate: null,
      frozenAvgPerDay: null,
      frozenSafeMonthTotal: null,
      rateLimitsCache: { fiveHourPct: 46, sevenDayPct: 31 },
    });
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed.rateLimitsCache).toEqual({ fiveHourPct: 46, sevenDayPct: 31 });
  });

  it("hidden --statusline mode: rateLimitsCache is null when never seen", async () => {
    stubStdin(JSON.stringify({ session_id: "s1", cost: { total_cost_usd: 5 } }));
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
    const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(printed.rateLimitsCache).toBeNull();
  });

  it("runs init and skips the calendar picker when the account has no spend cap", async () => {
    loadConfigMock.mockReturnValue({
      monthlyCap: 0,
      laboralDays: {},
      planType: "claude_max",
      hasSpendCap: false,
    });
    mockReadline("y");
    stubStdin("");
    installStatuslineMock.mockResolvedValue({
      installed: true,
      backupPath: null,
      fromVersion: null,
      toVersion: "abc12345",
    });
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["init"]);
    expect(code).toBe(0);
    expect(runInitMock).not.toHaveBeenCalled();
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("No spend cap on this plan (claude_max) — nothing to configure."),
    );
    expect(installStatuslineMock).toHaveBeenCalled();
  });

  it("runs init with no spend cap and no resolved planType, falling back to a generic label", async () => {
    loadConfigMock.mockReturnValue({ monthlyCap: 0, laboralDays: {}, hasSpendCap: false });
    mockReadline("n");
    stubStdin("");
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runCli(["init"]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("No spend cap on this plan (subscription) — nothing to configure."),
    );
  });
});
