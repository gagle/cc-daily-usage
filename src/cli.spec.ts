import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CliModule from "./cli.js";

let tmpDir: string;
let reportHtmlFile: string;

const loadConfigMock = vi.fn();
const loadUsageMock = vi.fn();
const saveConfigMock = vi.fn();
const saveUsageMock = vi.fn();

vi.mock("./config.js", () => ({
  loadConfig: () => loadConfigMock(),
  loadUsage: () => loadUsageMock(),
  saveConfig: (c: unknown) => saveConfigMock(c),
  saveUsage: (u: unknown) => saveUsageMock(u),
  get REPORT_HTML_FILE() {
    return reportHtmlFile;
  },
}));

vi.mock("./report.js", () => ({ renderReport: vi.fn(() => "<html>report</html>") }));

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

const runUsageTuiMock = vi.fn().mockResolvedValue(0);
vi.mock("./usage-tui.js", () => ({ runUsageTui: () => runUsageTuiMock() }));

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
    reportHtmlFile = path.join(tmpDir, "report.html");
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
    await expect(runCli(["report", "--nope"])).rejects.toThrow(/Unknown argument: --nope/);
  });

  it("runs report and writes report.html", async () => {
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["report"]);
    expect(code).toBe(0);
    expect(readFileSync(reportHtmlFile, "utf8")).toBe("<html>report</html>");
    expect(saveUsageMock).toHaveBeenCalled();
  });

  it("runs init, saves the returned config, then installs the full statusline on yes", async () => {
    runInitMock.mockResolvedValue({
      config: { monthlyCap: 650, laboralDays: {} },
      outcome: "done",
    });
    mockReadline("y");
    stubStdin("");
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["init"]);
    expect(code).toBe(0);
    expect(saveConfigMock).toHaveBeenCalledWith({ monthlyCap: 650, laboralDays: {} });
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
    });
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["statusline"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Backed up"));
  });

  it("runs the statusline operation and reports a silent no-op install", async () => {
    installStatuslineMock.mockResolvedValue({ installed: true, backupPath: null });
    const { runCli } = await freshCli();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runCli(["statusline"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("no-op/upgrade"));
  });

  it("runs the statusline operation and reports a decline", async () => {
    installStatuslineMock.mockResolvedValue({ installed: false, backupPath: null });
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

  it("runs the usage operation", async () => {
    runUsageTuiMock.mockResolvedValue(0);
    const { runCli } = await freshCli();
    const code = await runCli(["usage"]);
    expect(code).toBe(0);
    expect(runUsageTuiMock).toHaveBeenCalled();
  });

  it("hidden --statusline mode: tolerates empty stdin and a missing session/cost", async () => {
    stubStdin("");
    const { runCli } = await freshCli();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCli(["--statusline"]);
    expect(code).toBe(0);
  });
});
