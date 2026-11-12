import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as SwitchModule from "./model-switch.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

async function fresh(): Promise<typeof SwitchModule> {
  vi.resetModules();
  return import("./model-switch.js");
}

const PAYLOAD = {
  to_model: "claude-opus-5",
  context_tokens: 182_340,
  prompt_cache_warm: true,
  estimated_cache_write_usd: 1.1396,
};

let written: Array<string>;

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccs-switch-"));
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("decideModelSwitch", () => {
  it("warm cache and a costly re-send → ask with the price", async () => {
    const { decideModelSwitch } = await fresh();
    expect(decideModelSwitch(PAYLOAD, 1)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreModelSwitch",
        permissionDecision: "ask",
        permissionDecisionReason:
          "Switching to claude-opus-5 re-sends 182k tokens uncached: ~$1.14, and the current warm cache is lost. Continue?",
      },
    });
  });

  it("cold cache, under the threshold, or threshold off → only show the cost", async () => {
    const { decideModelSwitch } = await fresh();
    const message = {
      systemMessage: "cc-spend: switching to claude-opus-5 re-sends 182k tokens uncached: ~$1.14.",
    };
    expect(decideModelSwitch({ ...PAYLOAD, prompt_cache_warm: false }, 1)).toEqual(message);
    expect(decideModelSwitch(PAYLOAD, 2)).toEqual(message);
    expect(decideModelSwitch(PAYLOAD, 0)).toEqual(message);
    expect(decideModelSwitch({ estimated_cache_write_usd: 0.5 }, 1)).toEqual({
      systemMessage: "cc-spend: switching to the new model re-sends 0k tokens uncached: ~$0.50.",
    });
  });

  it("no estimate or under a cent → nothing (Claude Code's own flow)", async () => {
    const { decideModelSwitch } = await fresh();
    expect(decideModelSwitch({}, 1)).toBeNull();
    expect(decideModelSwitch({ ...PAYLOAD, estimated_cache_write_usd: 0.004 }, 1)).toBeNull();
  });
});

describe("runModelSwitch", () => {
  it("uses the account's promptGateMinUsd, default $1", async () => {
    const { runModelSwitch } = await fresh();
    expect(await runModelSwitch(JSON.stringify(PAYLOAD))).toBe(0);
    expect(written.join("")).toContain('"permissionDecision":"ask"');

    writeFileSync(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "dev@example.com" } }),
    );
    const dir = path.join(fakeHome, ".config", "cc-spend", "accounts", "dev_example_com");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ monthlyCap: 1, laboralDays: {}, promptGateMinUsd: 5 }),
    );
    written.length = 0;
    await (await fresh()).runModelSwitch(JSON.stringify(PAYLOAD));
    expect(written.join("")).toContain('"systemMessage"');
  });

  it("reads the hook payload from stdin", async () => {
    const stdin = Readable.from([Buffer.from(JSON.stringify(PAYLOAD))]);
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    const { runModelSwitch } = await fresh();
    expect(await runModelSwitch()).toBe(0);
    expect(written.join("")).toContain('"permissionDecision":"ask"');
  });

  it("bad input or nothing to price → prints nothing, exits 0", async () => {
    const { runModelSwitch } = await fresh();
    expect(await runModelSwitch("not json")).toBe(0);
    expect(await runModelSwitch("null")).toBe(0);
    expect(await runModelSwitch("{}")).toBe(0);
    expect(written).toEqual([]);
  });
});
