import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AccountModule from "./account.js";
import type * as CliModule from "./cli.js";
import type * as InsightsModule from "./insights.js";
import type * as LiveModule from "./live-tui.js";
import type * as ReportModule from "./report.js";
import type * as SharedModule from "./statusline-shared.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

const accountMock = vi.fn();
vi.mock("./account.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AccountModule>();
  return { ...actual, resolveActiveAccount: () => Promise.resolve(accountMock() as unknown) };
});

const runStatuslineLineMock = vi.fn().mockResolvedValue(0);
const runStatuslineJsonMock = vi.fn().mockResolvedValue(0);
vi.mock("./statusline.js", () => ({
  runStatuslineLine: () => runStatuslineLineMock() as unknown,
  runStatuslineJson: () => runStatuslineJsonMock() as unknown,
}));

const runPromptGateMock = vi.fn().mockResolvedValue(0);
vi.mock("./prompt-gate.js", () => ({ runPromptGate: () => runPromptGateMock() as unknown }));

const runModelSwitchMock = vi.fn().mockResolvedValue(0);
vi.mock("./model-switch.js", () => ({ runModelSwitch: () => runModelSwitchMock() as unknown }));
const runSubagentMock = vi.fn().mockResolvedValue(0);
vi.mock("./subagent-line.js", () => ({
  runSubagentStatusline: () => runSubagentMock() as unknown,
}));

const runRefreshMock = vi.fn().mockResolvedValue(0);
const writeFeedMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./refresh.js", () => ({
  runRefresh: (key: string) => runRefreshMock(key) as unknown,
  writeFeed: (key: string) => writeFeedMock(key) as unknown,
}));

const catchUpMock = vi.fn().mockReturnValue(true);
vi.mock("./transcript-index.js", () => ({ catchUp: () => catchUpMock() as unknown }));

const insightsAdviceMock = vi.fn().mockReturnValue([]);
vi.mock("./insights.js", async (importOriginal) => ({
  ...(await importOriginal<typeof InsightsModule>()),
  adviceFor: () => insightsAdviceMock() as unknown,
  snoozeRule: (_key: string, _id: string, days: number) =>
    days > 0 ? "2026-10-14T00:00:00.000Z" : null,
}));

const buildReportMock = vi.fn().mockReturnValue({ rows: [] });
vi.mock("./report.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ReportModule>()),
  buildReport: (...args: Array<unknown>) => buildReportMock(...args) as unknown,
  formatReport: () => "TABLE",
}));

const sessionFilesMock = vi.fn();
vi.mock("./session-report.js", () => ({
  sessionFiles: (prefix: string) => sessionFilesMock(prefix) as unknown,
  loadSessionModel: (id: string) => ({ id }),
  renderSessionReport: (_s: unknown, color: boolean, width: number) => [
    `BURNUP ${String(color)} ${String(width)}`,
  ],
  sessionJson: (s: unknown) => s,
}));

const installStatuslineMock = vi.fn();
const uninstallStatuslineMock = vi.fn();
const isEphemeralInstallMock = vi.fn(() => false);
vi.mock("./statusline-install.js", () => ({
  isEphemeralInstall: () => isEphemeralInstallMock(),
  installStatusline: (...args: Array<unknown>) => installStatuslineMock(...args) as unknown,
  uninstallStatusline: () => uninstallStatuslineMock() as unknown,
}));

const installCaptureOnlyMock = vi.fn().mockResolvedValue({ installed: true, backupPath: null });
vi.mock("./statusline-capture-install.js", () => ({
  installCaptureOnly: () => installCaptureOnlyMock() as unknown,
}));

const confirmAnswers: Array<boolean> = [];
const ttl: { value: string | undefined } = { value: undefined };
vi.mock("./statusline-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  defaultConfirm: () => Promise.resolve(confirmAnswers.shift() ?? false),
  promptCacheTtl: () => ttl.value,
  setPromptCacheTtl: (value: string) => {
    ttl.value = value;
  },
}));

const runCalendarTuiMock = vi.fn().mockResolvedValue(0);
vi.mock("./calendar-tui.js", () => ({
  runCalendarTui: (account: unknown) => runCalendarTuiMock(account) as unknown,
}));

const runLiveMock = vi.fn().mockResolvedValue(0);
vi.mock("./live-tui.js", async (importOriginal) => ({
  ...(await importOriginal<typeof LiveModule>()),
  runLive: (args: unknown) => runLiveMock(args) as unknown,
}));

const runSettingsTuiMock = vi.fn().mockResolvedValue(0);
vi.mock("./settings-tui.js", () => ({ runSettingsTui: () => runSettingsTuiMock() as unknown }));

const doctorReportMock = vi.fn();
vi.mock("./doctor.js", () => ({ doctorReport: () => doctorReportMock() as unknown }));

async function fresh(): Promise<typeof CliModule> {
  vi.resetModules();
  return import("./cli.js");
}

const ENTERPRISE = {
  email: "dev@example.com",
  accountUuid: "u",
  organizationType: "claude_enterprise",
};
const KEY = "dev_example_com";
const INSTALLED = { installed: true, backupPath: null, fromVersion: null, toVersion: "abcd1234" };

function configFile(): string {
  return path.join(fakeHome, ".config", "cc-daily-usage", "accounts", KEY, "config.json");
}

let logs: Array<string>;

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-cli-"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: Array<unknown>) => {
    logs.push(args.map(String).join(" "));
  });
  accountMock.mockReturnValue(ENTERPRISE);
  installStatuslineMock.mockResolvedValue(INSTALLED);
  confirmAnswers.length = 0;
  ttl.value = undefined;
  runCalendarTuiMock.mockResolvedValue(0);
  installCaptureOnlyMock.mockResolvedValue({ installed: true, backupPath: null });
  runStatuslineLineMock.mockResolvedValue(0);
  runStatuslineJsonMock.mockResolvedValue(0);
  runRefreshMock.mockResolvedValue(0);
  runPromptGateMock.mockResolvedValue(0);
  setTty(false);
  vi.useFakeTimers({ now: new Date("2026-10-07T10:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("hidden modes", () => {
  it("--statusline-line, --statusline and --refresh dispatch without the CLI help path", async () => {
    const { runCli } = await fresh();
    await runCli(["--statusline-line"]);
    await runCli(["--statusline"]);
    await runCli(["--refresh", "k"]);
    await runCli(["--prompt-gate"]);
    await runCli(["--model-switch"]);
    await runCli(["--subagent-statusline"]);
    expect(runSubagentMock).toHaveBeenCalled();
    expect(runPromptGateMock).toHaveBeenCalled();
    expect(runModelSwitchMock).toHaveBeenCalled();
    expect(runStatuslineLineMock).toHaveBeenCalled();
    expect(runStatuslineJsonMock).toHaveBeenCalled();
    expect(runRefreshMock).toHaveBeenCalledWith("k");
    await expect(runCli(["--refresh"])).rejects.toThrow("needs an account key");
  });
});

describe("arguments", () => {
  it("a command that met a newer file prints the update hint; hook modes stay quiet", async () => {
    const { runCli } = await fresh();
    const { markNewerFile } = await import("./config.js");
    markNewerFile("/x/config.json");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runCli(["--statusline-line"]);
    expect(errors).not.toHaveBeenCalled();
    await runCli(["--help"]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("npm i -g cc-daily-usage"));
  });

  it("help for no args, -h or --help anywhere", async () => {
    const { runCli } = await fresh();
    for (const argv of [[], ["-h"], ["calendar", "--help"]]) {
      expect(await runCli(argv)).toBe(0);
    }
    expect(logs.filter((line) => line.includes("Operations:"))).toHaveLength(3);
  });

  it("unknown operation or extra argument throws a helpful error", async () => {
    const { runCli } = await fresh();
    await expect(runCli(["nope"])).rejects.toThrow("Unknown argument: nope");
    await expect(runCli(["calendar", "extra"])).rejects.toThrow("Unknown argument: extra");
    await expect(runCli(["calendar", ""])).rejects.toThrow("Unknown argument: ");
  });
});

describe("statusline / uninstall", () => {
  it("formats every install outcome", async () => {
    const { formatStatuslineInstallMessage: format } = await fresh();
    expect(format({ installed: false, backupPath: null, fromVersion: null, toVersion: null })).toBe(
      "Not installed — declined.",
    );
    expect(format(INSTALLED)).toBe("Installed (vabcd1234).");
    expect(format({ ...INSTALLED, backupPath: "/b" })).toBe(
      "Installed (vabcd1234). Backed up previous settings.json to /b.",
    );
    expect(format({ ...INSTALLED, fromVersion: "abcd1234" })).toBe(
      "Statusline already up to date (vabcd1234).",
    );
    expect(format({ ...INSTALLED, fromVersion: "00000000" })).toBe(
      "Updated statusline: v00000000 → vabcd1234.",
    );
  });

  it("statusline installs and reports", async () => {
    const { runCli } = await fresh();
    expect(await runCli(["statusline"])).toBe(0);
    expect(logs).toContain("Installed (vabcd1234).");
  });

  it("init and statusline refuse a copy in the npx/dlx cache", async () => {
    const { runCli } = await fresh();
    isEphemeralInstallMock.mockReturnValue(true);
    try {
      await expect(runCli(["statusline"])).rejects.toThrow(/npm install -g cc-daily-usage/);
      await expect(runCli(["init"])).rejects.toThrow(/temporary npx\/dlx cache/);
    } finally {
      isEphemeralInstallMock.mockReturnValue(false);
    }
  });

  it("--version prints the package version", async () => {
    const { runCli } = await fresh();
    const { version } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(await runCli(["--version"])).toBe(0);
    expect(await runCli(["-v"])).toBe(0);
    expect(logs).toEqual([version, version]);
  });

  it("uninstall reports restore, plain removal, or nothing to do", async () => {
    const { runCli } = await fresh();
    uninstallStatuslineMock.mockReturnValueOnce({ removed: true, restoredFrom: "/x.bak" });
    await runCli(["uninstall"]);
    uninstallStatuslineMock.mockReturnValueOnce({ removed: true, restoredFrom: null });
    await runCli(["uninstall"]);
    uninstallStatuslineMock.mockReturnValueOnce({ removed: false, restoredFrom: null });
    await runCli(["uninstall"]);
    expect(logs).toEqual([
      "Removed the managed statusline. Restored statusLine from /x.bak.",
      "Removed the managed statusline. Removed statusLine from settings.json.",
      "Nothing to remove — the managed statusline is not installed.",
    ]);
  });
});

describe("settings", () => {
  it("opens the layout editor", async () => {
    runSettingsTuiMock.mockResolvedValue(0);
    const { runCli } = await fresh();
    expect(await runCli(["settings"])).toBe(0);
    expect(runSettingsTuiMock).toHaveBeenCalled();
  });
});

describe("doctor", () => {
  it("prints the report and returns its exit code", async () => {
    doctorReportMock.mockResolvedValue({ text: "✖ node: 22", code: 1 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { runCli } = await fresh();
    expect(await runCli(["doctor"])).toBe(1);
    expect(log).toHaveBeenCalledWith("✖ node: 22");
  });
});

describe("report", () => {
  it("catches up, refreshes the feed and prints the table or JSON", async () => {
    buildReportMock.mockReturnValue({ rows: [] });
    catchUpMock.mockReturnValue(true);
    writeFeedMock.mockResolvedValue(undefined);
    accountMock.mockReturnValue({ email: "dev@example.com", organizationType: "claude_max" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runCli } = await fresh();
    expect(await runCli(["report"])).toBe(0);
    expect(log).toHaveBeenCalledWith("TABLE");
    expect(writeFeedMock).toHaveBeenCalledWith("dev_example_com");
    expect(buildReportMock).toHaveBeenCalledWith(
      "dev_example_com",
      expect.objectContaining({ label: "last 7 days" }),
      "model",
      null, // no limit samples yet → no $ per 1%
    );
    catchUpMock.mockReturnValueOnce(false);
    writeFeedMock.mockClear();
    expect(await runCli(["report", "today", "--json", "--account", "unattributed"])).toBe(0);
    expect(log).toHaveBeenLastCalledWith(JSON.stringify({ rows: [] }, null, 2));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Another index pass"));
    expect(writeFeedMock).not.toHaveBeenCalled();
  });

  it("--session prints one session's burn-up or JSON; a bad id throws", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    sessionFilesMock.mockReturnValue({ id: "abc", files: [] });
    const { runCli } = await fresh();
    expect(await runCli(["report", "--session", "abc"])).toBe(0);
    expect(log).toHaveBeenLastCalledWith("BURNUP false 80");
    expect(await runCli(["report", "--session", "abc", "--json"])).toBe(0);
    expect(log).toHaveBeenLastCalledWith(JSON.stringify({ id: "abc" }, null, 2));
    sessionFilesMock.mockReturnValue("No transcript for session zz");
    await expect(runCli(["report", "--session", "zz"])).rejects.toThrow(
      "No transcript for session zz",
    );
  });

  it("--chart reaches the formatter; colors and width follow the terminal", async () => {
    buildReportMock.mockReturnValue({ rows: [] });
    catchUpMock.mockReturnValue(true);
    writeFeedMock.mockResolvedValue(undefined);
    accountMock.mockReturnValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const columns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
    sessionFilesMock.mockReturnValue({ id: "abc", files: [] });
    try {
      const { runCli } = await fresh();
      expect(await runCli(["report", "--chart"])).toBe(0);
      expect(log).toHaveBeenLastCalledWith("TABLE");
      expect(await runCli(["report", "--session", "abc"])).toBe(0);
      expect(log).toHaveBeenLastCalledWith("BURNUP true 120");
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (columns) Object.defineProperty(process.stdout, "columns", columns);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });

  it("shows progress on a TTY; bad arguments throw", async () => {
    buildReportMock.mockReturnValue({ rows: [] });
    catchUpMock.mockReturnValue(true);
    writeFeedMock.mockResolvedValue(undefined);
    accountMock.mockReturnValue(null);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const { runCli } = await fresh();
    try {
      await runCli(["report", "month"]);
      expect(write).toHaveBeenCalledWith(expect.stringContaining("Reading new transcript lines"));
    } finally {
      if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
      else Reflect.deleteProperty(process.stderr, "isTTY");
    }
    await expect(runCli(["report", "--by", "x"])).rejects.toThrow("--by needs one of");
    await expect(runCli(["report", "2026-13"])).rejects.toThrow("Unknown period: 2026-13");
  });
});

describe("insights", () => {
  it("snoozes, catches up, refreshes the feed and prints findings or JSON", async () => {
    catchUpMock.mockReturnValue(true);
    writeFeedMock.mockResolvedValue(undefined);
    insightsAdviceMock.mockReturnValue([]);
    accountMock.mockReturnValue({ email: "dev@example.com", organizationType: "claude_max" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runCli } = await fresh();
    expect(await runCli(["insights"])).toBe(0);
    expect(log).toHaveBeenLastCalledWith("Nothing to change this week.");
    expect(writeFeedMock).toHaveBeenCalledWith("dev_example_com");
    expect(await runCli(["insights", "--snooze", "R1", "7d", "--json"])).toBe(0);
    expect(log).toHaveBeenCalledWith("R1 snoozed until 2026-10-14T00:00:00.000Z");
    expect(log).toHaveBeenLastCalledWith("[]");
    catchUpMock.mockReturnValueOnce(false);
    expect(await runCli(["insights", "--snooze", "R1", "0d"])).toBe(0);
    expect(log).toHaveBeenCalledWith("R1 unsnoozed");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Another index pass"));
    await expect(runCli(["insights", "--x"])).rejects.toThrow("Unknown insights argument");
    expect(await runCli(["insights", "--rules"])).toBe(0);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("What cc-daily-usage insights checks"),
    );
    expect(await runCli(["insights", "--rules", "--json"])).toBe(0);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('"found": false'));
  });
});

describe("live", () => {
  it("passes --once to the live view; rejects unknown flags", async () => {
    runLiveMock.mockResolvedValue(0);
    const { runCli } = await fresh();
    expect(await runCli(["live", "--once"])).toBe(0);
    expect(runLiveMock).toHaveBeenCalledWith({ once: true });
    await expect(runCli(["live", "--x"])).rejects.toThrow("Unknown live argument: --x");
  });
});

describe("calendar", () => {
  it("enterprise/team opens the UI with the resolved account", async () => {
    const { runCli } = await fresh();
    await runCli(["calendar"]);
    expect(runCalendarTuiMock).toHaveBeenCalledWith(ENTERPRISE);
  });

  it("Pro/Max get a notice and the UI never loads", async () => {
    accountMock.mockReturnValue({ ...ENTERPRISE, organizationType: "claude_max" });
    const { runCli } = await fresh();
    expect(await runCli(["calendar"])).toBe(0);
    expect(runCalendarTuiMock).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Claude Max");
  });

  it("unknown plan: notice to start a session first — unless the hook already judged it a budget plan", async () => {
    accountMock.mockReturnValue(null);
    const { runCli } = await fresh();
    await runCli(["calendar"]);
    expect(logs.join("\n")).toContain("Plan not detected yet");
    mkdirSync(path.join(fakeHome, ".config", "cc-daily-usage", "accounts", "default"), {
      recursive: true,
    });
    writeFileSync(
      path.join(fakeHome, ".config", "cc-daily-usage", "accounts", "default", "config.json"),
      JSON.stringify({ monthlyCap: 1, laboralDays: {}, hasSpendCap: true, planType: "mystery" }),
    );
    await runCli(["calendar"]);
    expect(runCalendarTuiMock).toHaveBeenCalledWith(null);
  });
});

describe("init", () => {
  it("enterprise on a TTY: statusline, Mon–Fri for this and next month, then the calendar", async () => {
    setTty(true);
    confirmAnswers.push(true, true, true);
    const { runCli } = await fresh();
    expect(await runCli(["init"])).toBe(0);
    expect(ttl.value).toBe("1h");
    expect(installStatuslineMock).toHaveBeenCalled();
    const config = JSON.parse(readFileSync(configFile(), "utf8")) as {
      laboralDays: Record<string, Record<string, Array<number>>>;
    };
    expect(config.laboralDays["2026"]?.["10"]).toContain(7);
    expect(config.laboralDays["2026"]?.["10"]).not.toContain(10); // Saturday
    expect(config.laboralDays["2026"]?.["11"]?.[0]).toBe(2);
    expect(runCalendarTuiMock).toHaveBeenCalledWith(ENTERPRISE);
    expect(logs[0]).toBe("Account: dev@example.com");
  });

  it("the installer's own confirm is pre-answered (init already asked)", async () => {
    confirmAnswers.push(true, false);
    const { runCli } = await fresh();
    await runCli(["init"]);
    const confirm = installStatuslineMock.mock.calls[0]?.[0] as () => Promise<boolean>;
    expect(await confirm()).toBe(true);
  });

  it("declining the statusline installs capture-only; declining days saves nothing; no TTY → no UI", async () => {
    confirmAnswers.push(false, false);
    const { runCli } = await fresh();
    await runCli(["init"]);
    expect(installCaptureOnlyMock).toHaveBeenCalled();
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toMatchObject({ laboralDays: {} });
    expect(runCalendarTuiMock).not.toHaveBeenCalled();
  });

  it("months already configured → no weekday prompt", async () => {
    mkdirSync(path.dirname(configFile()), { recursive: true });
    writeFileSync(
      configFile(),
      JSON.stringify({ monthlyCap: 9, laboralDays: { "2026": { "10": [1], "11": [2] } } }),
    );
    confirmAnswers.push(true, false, true);
    const { runCli } = await fresh();
    await runCli(["init"]);
    expect(confirmAnswers).toEqual([true]); // second answer never consumed
  });

  it("December rolls the second month into January", async () => {
    vi.setSystemTime(new Date("2026-12-15T10:00:00.000Z"));
    confirmAnswers.push(true, false, true);
    const { runCli } = await fresh();
    await runCli(["init"]);
    const config = JSON.parse(readFileSync(configFile(), "utf8")) as {
      laboralDays: Record<string, Record<string, Array<number>>>;
    };
    expect(config.laboralDays["2027"]?.["1"]).toBeDefined();
  });

  it("a TTL already set is not asked again", async () => {
    ttl.value = "5m";
    accountMock.mockReturnValue({ ...ENTERPRISE, organizationType: "claude_pro" });
    confirmAnswers.push(true, true);
    const { runCli } = await fresh();
    await runCli(["init"]);
    expect(confirmAnswers).toEqual([true]);
  });

  it("Pro stops after the statusline", async () => {
    accountMock.mockReturnValue({ ...ENTERPRISE, organizationType: "claude_pro" });
    confirmAnswers.push(true);
    const { runCli } = await fresh();
    await runCli(["init"]);
    expect(logs.at(-1)).toContain("No spend cap on this plan (claude_pro)");
  });

  it("no login: unknown plan message, default account, no UI", async () => {
    accountMock.mockReturnValue(null);
    setTty(true);
    confirmAnswers.push(true, false);
    const { runCli } = await fresh();
    await runCli(["init"]);
    expect(logs[0]).toBe("Account: default (no OAuth account)");
    expect(logs.join("\n")).toContain("Plan not detected yet");
    expect(runCalendarTuiMock).not.toHaveBeenCalled();
  });

  it("a plan judged subscription by the hook (unknown org) also stops", async () => {
    accountMock.mockReturnValue({ ...ENTERPRISE, organizationType: null });
    mkdirSync(path.dirname(configFile()), { recursive: true });
    writeFileSync(
      configFile(),
      JSON.stringify({ monthlyCap: 1, laboralDays: {}, hasSpendCap: false }),
    );
    confirmAnswers.push(true);
    const { runCli } = await fresh();
    await runCli(["init"]);
    expect(logs.at(-1)).toContain("No spend cap on this plan (subscription)");
  });
});
