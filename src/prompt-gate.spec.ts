import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as GateModule from "./prompt-gate.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

async function fresh(): Promise<typeof GateModule> {
  vi.resetModules();
  return import("./prompt-gate.js");
}

const NOW = new Date("2026-10-10T12:00:00.000Z");
const NOW_SEC = NOW.getTime() / 1000;
const KEY = "dev_example_com";

function accountDir(): string {
  return path.join(fakeHome, ".config", "cc-daily-usage", "accounts", KEY);
}

function seed(
  gate: unknown,
  config: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    path.join(fakeHome, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "dev@example.com", organizationType: "claude_pro" },
    }),
  );
  mkdirSync(accountDir(), { recursive: true });
  writeFileSync(
    path.join(accountDir(), "config.json"),
    JSON.stringify({ monthlyCap: 1, laboralDays: {}, ...config }),
  );
  writeFileSync(
    path.join(accountDir(), "usage.json"),
    JSON.stringify({
      schemaVersion: 2,
      monthlySpent: 0,
      periodFrozen: 0,
      lastUpdated: NOW.toISOString(),
      days: {},
      sessions: {
        s1: { lastSeenCost: 1, lastSeenAt: NOW.toISOString(), cacheGate: gate, ...extra },
      },
    }),
  );
}

const COLD = { expiresAt: NOW_SEC - 10, coldUsd: 2.45, warmUsd: 0.1 };

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "cc-daily-usage-gate-"));
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("decidePromptGate", () => {
  it("blocks a costly cold-cache prompt once, then lets the re-submit through", async () => {
    seed(COLD);
    const { decidePromptGate } = await fresh();
    const first = await decidePromptGate({ session_id: "s1", prompt: "go on" }, NOW);
    expect(first.kind).toBe("block");
    expect(first.kind === "block" && first.reason).toContain("~$2.45 instead of ~$0.10");
    expect(first.kind === "block" && first.reason).toContain("/clear (free)");
    const again = await decidePromptGate(
      { session_id: "s1", prompt: "go on" },
      new Date(NOW.getTime() + 30_000),
    );
    expect(again.kind).toBe("allow");
    const sessions = JSON.parse(
      readFileSync(path.join(accountDir(), "usage.json"), "utf8"),
    ).sessions;
    expect(sessions.s1.gateArmedAt).toBeUndefined();
  });

  it("a confirmation older than 2 minutes blocks again", async () => {
    seed(COLD, {}, { gateArmedAt: NOW.getTime() - 3 * 60_000 });
    const { decidePromptGate } = await fresh();
    expect((await decidePromptGate({ session_id: "s1", prompt: "x" }, NOW)).kind).toBe("block");
  });

  it.each([
    ["warm cache", { ...COLD, expiresAt: NOW_SEC + 60 }, {}],
    ["cheap miss", { ...COLD, coldUsd: 0.5 }, {}],
    ["unknown cold cost", { ...COLD, coldUsd: null }, {}],
    ["gate off", COLD, { promptGateMinUsd: 0 }],
    ["no gate state", undefined, {}],
  ])("allows: %s", async (_name, gate, config) => {
    seed(gate, config);
    const { decidePromptGate } = await fresh();
    expect((await decidePromptGate({ session_id: "s1", prompt: "x" }, NOW)).kind).toBe("allow");
  });

  it("a null expiry counts as cold; a custom threshold applies", async () => {
    seed({ ...COLD, expiresAt: null, coldUsd: 0.6 }, { promptGateMinUsd: 0.5 });
    const { decidePromptGate } = await fresh();
    expect((await decidePromptGate({ session_id: "s1", prompt: "x" }, NOW)).kind).toBe("block");
  });

  it("always allows slash commands, unknown sessions and payloads without a session", async () => {
    seed(COLD);
    const { decidePromptGate } = await fresh();
    expect((await decidePromptGate({ session_id: "s1", prompt: "  /clear" }, NOW)).kind).toBe(
      "allow",
    );
    expect((await decidePromptGate({ session_id: "other", prompt: "x" }, NOW)).kind).toBe("allow");
    expect((await decidePromptGate({ prompt: "x" }, NOW)).kind).toBe("allow");
    expect((await decidePromptGate({ session_id: "s1" })).kind).toBe("block"); // default now, no prompt text
  });
});

describe("runPromptGate", () => {
  let written: Array<string>;

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
  });

  it("prints the block JSON", async () => {
    seed({ ...COLD, expiresAt: 0 });
    const { runPromptGate } = await fresh();
    expect(await runPromptGate('{"session_id":"s1","prompt":"x"}')).toBe(0);
    expect(JSON.parse(written.join(""))).toMatchObject({ decision: "block" });
  });

  it("prints nothing to allow, and never throws on garbage or a non-object", async () => {
    const { runPromptGate } = await fresh();
    await runPromptGate("{nope");
    await runPromptGate("3");
    expect(written).toEqual([]);
  });

  it("reads stdin when no raw payload is given", async () => {
    seed({ ...COLD, expiresAt: 0 });
    const stdin = Readable.from([Buffer.from('{"session_id":"s1","prompt":"x"}')]);
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    const { runPromptGate } = await fresh();
    await runPromptGate();
    expect(written.join("")).toContain("block");
  });
});
