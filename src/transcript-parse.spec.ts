import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addTurn,
  contextTokens,
  DEEP_CONTEXT_TOKENS,
  emptyRollup,
  mcpServerKey,
  mcpServersUsed,
  mergeRollup,
  parseActivity,
  parseCompaction,
  parseMcpLoad,
  parseRowKey,
  parseTurn,
  priceTurn,
  rollupUsd,
  rowKey,
  splitTurn,
  turnRowKey,
} from "./transcript-parse.js";

function usageLine(
  overrides: Record<string, unknown> = {},
  usage: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "assistant",
    requestId: "req_1",
    sessionId: "s1",
    timestamp: "2026-10-07T10:00:00.000Z",
    cwd: "/work/app",
    gitBranch: "main",
    effort: "high",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 300_000,
        cache_creation: { ephemeral_5m_input_tokens: 200_000, ephemeral_1h_input_tokens: 100_000 },
        output_tokens_details: { thinking_tokens: 50_000 },
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
        speed: "standard",
        ...usage,
      },
    },
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseTurn", () => {
  it("reads every usage field of an assistant line", () => {
    expect(parseTurn(usageLine())).toEqual({
      key: "req_1|msg_1",
      sessionId: "s1",
      timestamp: "2026-10-07T10:00:00.000Z",
      model: "claude-opus-5-5",
      cwd: "/work/app",
      branch: "main",
      fast: false,
      input: 1_000_000,
      output: 100_000,
      cacheRead: 1_000_000,
      cacheWrite5m: 200_000,
      cacheWrite1h: 100_000,
      thinking: 50_000,
      webSearches: 2,
      webFetches: 1,
      effort: "high",
      thinkingMs: 0,
      entrypoint: null,
    });
    expect(parseTurn(usageLine({ thinkingDurationMs: 1200, entrypoint: "cli" }))).toMatchObject({
      thinkingMs: 1200,
      entrypoint: "cli",
    });
  });

  it("parseActivity reads turn time and hook runs from system lines; anything else is null", () => {
    const system = (fields: Record<string, unknown>): string =>
      JSON.stringify({ type: "system", sessionId: "s1", ...fields });
    expect(parseActivity(system({ subtype: "turn_duration", durationMs: 4400 }))).toEqual({
      sessionId: "s1",
      turnMs: 4400,
      hookRuns: 0,
    });
    expect(parseActivity(system({ subtype: "stop_hook_summary", hookCount: 4 }))).toEqual({
      sessionId: "s1",
      turnMs: 0,
      hookRuns: 4,
    });
    expect(parseActivity(usageLine())).toBeNull();
    expect(parseActivity('{"subtype":"turn_duration"')).toBeNull();
    expect(parseActivity(JSON.stringify({ type: "user", subtype: "turn_duration" }))).toBeNull();
    expect(parseActivity(system({ subtype: "other", note: "turn_duration" }))).toBeNull();
  });

  it("skips non-usage lines, garbage and synthetic messages", () => {
    expect(parseTurn("{oops")).toBeNull();
    expect(parseTurn("null")).toBeNull();
    expect(parseTurn(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(parseTurn(JSON.stringify({ type: "assistant", message: { model: "x" } }))).toBeNull();
    expect(parseTurn(JSON.stringify({ type: "assistant", message: { usage: {} } }))).toBeNull();
    const synthetic = JSON.parse(usageLine()) as { message: { model: string } };
    synthetic.message.model = "<synthetic>";
    expect(parseTurn(JSON.stringify(synthetic))).toBeNull();
  });

  it("older lines: only a write total (5m), missing ids and fields default", () => {
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u1",
      message: {
        model: "claude-sonnet-5-5",
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 7,
          output_tokens: -1,
          speed: "fast",
        },
      },
    });
    expect(parseTurn(line)).toMatchObject({
      key: "|u1",
      sessionId: "unknown",
      timestamp: "",
      cwd: "",
      branch: "",
      fast: true,
      input: 5,
      output: 0,
      cacheWrite5m: 7,
      cacheWrite1h: 0,
      thinking: 0,
      effort: null,
    });
    const noIds = JSON.parse(line) as Record<string, unknown>;
    delete noIds.uuid;
    expect(parseTurn(JSON.stringify(noIds))?.key).toBe("|");
  });
});

describe("priceTurn", () => {
  it("prices each component with the 5m/1h write split", () => {
    const turn = parseTurn(usageLine());
    expect(turn && priceTurn(turn)).toEqual({
      input: 4,
      output: 2,
      cacheRead: 0.2,
      cacheWrite: 0.2 * 4 * 1.25 + 0.1 * 4 * 2,
      webSearch: 0.02, // 2 searches × $0.01
    });
  });

  it("doubles fast mode and has no price for an unknown model", () => {
    const fast = parseTurn(usageLine({}, { speed: "fast" }));
    expect(fast && priceTurn(fast)?.input).toBe(8);
    const unknown = parseTurn(usageLine({ message: { model: "claude-future-9", usage: {} } }));
    expect(unknown && priceTurn(unknown)).toBeNull();
  });
});

describe("MCP lines", () => {
  const attachment = (attachmentBody: Record<string, unknown>, type = "attachment"): string =>
    JSON.stringify({ type, sessionId: "s1", attachment: attachmentBody });

  it("mcpServerKey matches Claude Code's tool prefix", () => {
    expect(mcpServerKey("plugin:figma:figma")).toBe("plugin_figma_figma");
    expect(mcpServerKey("code-review-graph")).toBe("code-review-graph");
  });

  it("parseMcpLoad: names → est. tokens; skips bad names, missing blocks and other lines", () => {
    expect(
      parseMcpLoad(
        attachment({
          type: "mcp_instructions_delta",
          addedNames: ["a", 7, "b"],
          addedBlocks: ["12345", "x"],
        }),
      ),
    ).toEqual({ sessionId: "s1", servers: { a: 2, b: 0 } });
    expect(parseMcpLoad(attachment({ type: "mcp_instructions_delta" }))).toEqual({
      sessionId: "s1",
      servers: {},
    });
    expect(parseMcpLoad(attachment({ type: "mcp_instructions_delta" }, "user"))).toBeNull();
    expect(parseMcpLoad('{"mcp_instructions_delta"')).toBeNull();
    expect(parseMcpLoad(usageLine())).toBeNull();
  });

  it("mcpServersUsed: servers of mcp__ tool uses on assistant lines", () => {
    const withContent = (content: unknown, type = "assistant"): string =>
      JSON.stringify({ type, sessionId: "s1", message: { content } });
    expect(
      mcpServersUsed(
        withContent([
          { type: "tool_use", name: "mcp__zvec_grep__zvec_grep_search" },
          { type: "tool_use", name: "mcp__zvec_grep__other" },
          { type: "tool_use", name: "Read" },
          { type: "text", text: "mcp__fake__x" },
          { type: "tool_use", name: 5 },
          null,
        ]),
      ),
    ).toEqual({ sessionId: "s1", servers: ["zvec_grep"] });
    expect(mcpServersUsed(withContent([{ type: "text", text: "mcp__x__y" }]))).toBeNull();
    expect(mcpServersUsed(withContent("mcp__x__y"))).toBeNull();
    expect(
      mcpServersUsed(withContent([{ type: "tool_use", name: "mcp__a__b" }], "user")),
    ).toBeNull();
    expect(mcpServersUsed('{"mcp__')).toBeNull();
    expect(mcpServersUsed(usageLine())).toBeNull();
  });
});

describe("addTurn efficiency split", () => {
  it("adds the split only when the previous context is known", () => {
    const turn = parseTurn(usageLine());
    if (!turn) throw new Error("turn");
    const known = emptyRollup();
    addTurn(known, turn, priceTurn(turn), 0);
    expect(known.growth).toBe(contextTokens(turn) + turn.output);
    expect(known.freshSplit).toBe(turn.input + turn.cacheWrite5m + turn.cacheWrite1h);
    expect(known.usdCarry).toBeCloseTo(0.2);
    const unknown = emptyRollup();
    addTurn(unknown, turn, priceTurn(turn));
    expect(unknown).toMatchObject({ growth: 0, usdNewWork: 0 });
  });
});

describe("parseCompaction", () => {
  const boundary = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      sessionId: "s1",
      timestamp: "2026-10-07T10:00:00.000Z",
      compactMetadata: { trigger: "manual", preTokens: 160_000, postTokens: 15_000 },
      ...extra,
    });

  it("reads trigger and token counts", () => {
    expect(parseCompaction(boundary())).toEqual({
      sessionId: "s1",
      timestamp: "2026-10-07T10:00:00.000Z",
      trigger: "manual",
      preTokens: 160_000,
      postTokens: 15_000,
    });
  });

  it("defaults a missing metadata block; ignores other lines and garbage", () => {
    expect(parseCompaction(boundary({ compactMetadata: undefined }))).toMatchObject({
      trigger: "auto",
      preTokens: 0,
    });
    expect(parseCompaction(boundary({ type: "user" }))).toBeNull();
    expect(parseCompaction(usageLine())).toBeNull();
    expect(parseCompaction('{"compact_boundary"')).toBeNull();
  });
});

describe("splitTurn", () => {
  const turn = parseTurn(
    usageLine(
      {},
      {
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_input_tokens: 10_000,
        cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 0 },
      },
    ),
  );
  const cost = { input: 4, output: 2, cacheRead: 1, cacheWrite: 4, webSearch: 0 };

  it("context tokens are input + read + writes", () => {
    expect(turn && contextTokens(turn)).toBe(14_000);
  });

  it("fresh input that grows context is new work; the rest is a rewrite", () => {
    // previous 12k → growth 2k of 4k fresh → half of the fresh $ is a rewrite
    expect(turn && splitTurn(turn, cost, 12_000)).toEqual({
      growth: 2000,
      rewriteTokens: 2000,
      newWorkUsd: 2 + 4,
      carryUsd: 1,
      rewriteUsd: 4,
    });
  });

  it("a first turn (no previous context) is all new work; no fresh input → no rewrite", () => {
    expect(turn && splitTurn(turn, cost, 0).rewriteUsd).toBe(0);
    const readOnly = parseTurn(
      usageLine({}, { input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0 } }),
    );
    expect(readOnly && splitTurn(readOnly, cost, 5_000_000)).toMatchObject({
      growth: 0,
      rewriteTokens: 0,
      rewriteUsd: 0,
    });
  });
});

describe("rollups", () => {
  it("adds turns, keeps the deepest context, splits thinking $ and deep-context reads", () => {
    const turn = parseTurn(usageLine());
    if (!turn) throw new Error("parse");
    const row = emptyRollup();
    addTurn(row, turn, priceTurn(turn));
    addTurn(row, { ...turn, output: 0 }, priceTurn({ ...turn, output: 0 }));
    addTurn(row, { ...turn, model: "claude-future-9" }, null);
    expect(row).toMatchObject({
      turns: 3,
      unpricedTurns: 1,
      input: 3_000_000,
      thinking: 150_000,
      webSearches: 6,
      maxContext: 2_300_000,
      usdThinking: 1,
      usdThinkingHigh: 0,
      deepContextReadUsd: 2 * 0.2 * (2_100_000 / 2_300_000),
    });
    expect(rollupUsd(row)).toBeCloseTo(2 * (4 + 0.2 + 1.8) + 2 + 6 * 0.01);
    const small = { ...turn, input: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    const shallow = emptyRollup();
    addTurn(shallow, small, priceTurn(small));
    expect(shallow.deepContextReadUsd).toBe(0);
    const high = emptyRollup();
    addTurn(high, { ...turn, effort: "max" }, priceTurn(turn));
    addTurn(high, { ...turn, effort: null }, priceTurn(turn));
    expect(high.usdThinkingHigh).toBe(1);
    expect(shallow.maxContext).toBeLessThan(DEEP_CONTEXT_TOKENS);
  });

  it("merges by sum, maxContext by max", () => {
    const a = { ...emptyRollup(), turns: 1, maxContext: 5 };
    mergeRollup(a, { ...emptyRollup(), turns: 2, maxContext: 3 });
    expect(a).toMatchObject({ turns: 3, maxContext: 5 });
  });

  it("row keys round-trip; speed defaults to standard", () => {
    const key = {
      day: "2026-10-07",
      project: "/p",
      model: "m",
      scope: "main",
      speed: "fast",
    } as const;
    expect(parseRowKey(rowKey(key))).toEqual(key);
    expect(parseRowKey("")).toEqual({
      day: "",
      project: "",
      model: "",
      scope: "",
      speed: "standard",
    });
  });

  it.each([
    ["UTC", "2026-10-07"],
    ["Europe/Madrid", "2026-10-08"],
    ["America/Los_Angeles", "2026-10-07"],
  ])("a turn's row uses its local day (%s)", (tz, day) => {
    vi.stubEnv("TZ", tz);
    const turn = parseTurn(usageLine({ timestamp: "2026-10-07T23:30:00.000Z" }, { speed: "fast" }));
    if (!turn) throw new Error("parse");
    expect(turnRowKey(turn, "subagent:Explore")).toEqual({
      day,
      project: "/work/app",
      model: "claude-opus-5-5",
      scope: "subagent:Explore",
      speed: "fast",
    });
    expect(turnRowKey({ ...turn, timestamp: "" }, "main")).toBeNull();
  });
});
