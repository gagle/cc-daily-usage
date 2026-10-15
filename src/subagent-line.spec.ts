/* eslint-disable no-control-regex -- these tests assert on ANSI escape sequences */
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runSubagentStatusline, shortModel, subagentLines, subagentRow } from "./subagent-line.js";

const plain = (text: string | null): string | null =>
  text === null ? null : text.replace(/\x1b\[[0-9;]*m/g, "");

describe("shortModel", () => {
  it("names a Claude model id; anything else as given", () => {
    expect(shortModel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(shortModel("us.anthropic.claude-opus-5[1m]")).toBe("Opus 5");
    expect(shortModel("gpt-x")).toBe("gpt-x");
  });
});

describe("subagentRow", () => {
  const task = {
    id: "t1",
    agentType: "Explore",
    description: "find endpoints",
    model: "claude-sonnet-5-5",
    effort: "high",
    tokenCount: 41_200,
    contextWindowSize: 1_000_000,
  };

  it("who · what · model effort · tokens (context %)", () => {
    expect(subagentRow(task, 200)).toBe("Explore · find endpoints · 🤖 Sonnet 5.5 high · 41k (4%)");
    expect(subagentRow({ ...task, name: "scout", label: "reading src" }, 200)).toBe(
      "scout · reading src · 🤖 Sonnet 5.5 high · 41k (4%)",
    );
  });

  it("drops what it does not have; null without an id", () => {
    expect(subagentRow({ id: "t2", tokenCount: 900 }, 80)).toBe("1k");
    expect(subagentRow({ id: "t2", model: "m", effort: 4000 }, 80)).toBe("🤖 m 4000");
    expect(subagentRow({ id: "t2", model: "m" }, 80)).toBe("🤖 m");
    expect(subagentRow({ id: "t2", tokenCount: 10, contextWindowSize: 0 }, 80)).toBe("0k");
    expect(subagentRow({ ...task, id: undefined }, 80)).toBeNull();
  });

  it("draws a premium model orange; a cut row stays plain", () => {
    const row = subagentRow({ ...task, model: "claude-opus-5-5" }, 200);
    expect(row).toContain("\x1b[38;2;244;164;96m🤖 Opus 5.5 high\x1b[0m");
    expect(plain(row)).toBe("Explore · find endpoints · 🤖 Opus 5.5 high · 41k (4%)");
    expect(subagentRow({ ...task, model: "claude-opus-5-5" }, 10)).toBe("Explore ·…");
    expect(subagentRow(task, 0)).toBe("…");
  });
});

describe("subagentLines / runSubagentStatusline", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("one JSON line per drawable task; garbage gives none", () => {
    const raw = JSON.stringify({ columns: 30, tasks: [{ id: "a", agentType: "Plan" }, {}] });
    expect(subagentLines(raw)).toEqual([JSON.stringify({ id: "a", content: "Plan" })]);
    expect(subagentLines(JSON.stringify({ tasks: "x" }))).toEqual([]);
    expect(subagentLines("{")).toEqual([]);
    expect(
      subagentLines(JSON.stringify({ tasks: [{ id: "b", name: "n".repeat(100) }] }))[0],
    ).toContain("…");
  });

  it("prints the lines, or nothing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(
      runSubagentStatusline(JSON.stringify({ tasks: [{ id: "a", agentType: "Plan" }] })),
    ).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(`${JSON.stringify({ id: "a", content: "Plan" })}\n`);
    write.mockClear();
    await runSubagentStatusline("nope");
    expect(write).not.toHaveBeenCalled();
    const stdin = Readable.from([Buffer.from(JSON.stringify({ tasks: [{ id: "s", name: "x" }] }))]);
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    await runSubagentStatusline();
    expect(write).toHaveBeenCalledWith(`${JSON.stringify({ id: "s", content: "x" })}\n`);
  });
});
