import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newSession } from "./session-model.js";
import {
  loadSessionModel,
  renderSessionReport,
  sessionFiles,
  sessionIdOf,
  sessionJson,
} from "./session-report.js";

const T0 = Date.parse("2026-10-18T10:00:00.000Z");

function turnLine(id: string, minutes: number, usage: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "assistant",
    requestId: `r-${id}`,
    sessionId: "abcd1234-0000",
    timestamp: new Date(T0 + minutes * 60_000).toISOString(),
    cwd: "/work/app",
    gitBranch: "main",
    message: {
      id: `m-${id}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: 1000, output_tokens: 1000, ...usage },
    },
  })}\n`;
}

const compactLine = (minutes: number): string =>
  `${JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    sessionId: "abcd1234-0000",
    timestamp: new Date(T0 + minutes * 60_000).toISOString(),
  })}\n`;

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ccs-session-"));
  const project = path.join(root, "-work-app");
  mkdirSync(path.join(project, "abcd1234-0000", "subagents"), { recursive: true });
  writeFileSync(
    path.join(project, "abcd1234-0000.jsonl"),
    turnLine("a", 0, { cache_creation_input_tokens: 30_000 }) +
      compactLine(10) +
      turnLine("b", 30, { cache_creation_input_tokens: 30_000 }) +
      "not json\n",
  );
  writeFileSync(
    path.join(project, "abcd1234-0000", "subagents", "agent-x.jsonl"),
    turnLine("c", 5),
  );
  writeFileSync(path.join(project, "abcd9999-0000.jsonl"), "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("finding a session's files", () => {
  it("session id from a main or subagent path", () => {
    expect(sessionIdOf("/p/x/abc.jsonl")).toBe("abc");
    expect(sessionIdOf("/p/x/abc/subagents/agent-1.jsonl")).toBe("abc");
  });

  it("one match, none, or several", () => {
    const found = sessionFiles("abcd1234", root);
    expect(typeof found === "string" ? found : found.files).toHaveLength(2);
    expect(sessionFiles("zz", root)).toBe("No transcript for session zz");
    expect(sessionFiles("abcd", root)).toBe("abcd matches 2 sessions: abcd1234-000, abcd9999-000");
  });
});

describe("loadSessionModel + render", () => {
  it("reads main and subagent turns and compactions; renders slots, total, events and the summary", () => {
    const found = sessionFiles("abcd1234", root);
    if (typeof found === "string") throw new Error(found);
    const session = loadSessionModel(found.id, found.files);
    expect(session.turns).toBe(3);
    const out = renderSessionReport(session, false, 80).join("\n");
    expect(out).toMatch(/^Session abcd1234 · app @ main · 3 turns · \$0\.\d\d · .* \(30m\)/);
    expect(out).toMatch(/\$ \/ slot {2}[▁-█]{60} {2}\d+s per slot/);
    expect(out).toMatch(/total {5}[▁-█]{60}/);
    expect(out).toMatch(/events +S +C +! +! cold re-write/);
    expect(out).toContain("agents");
    expect(out).toContain("API-equivalent estimate, not a bill.");
    expect(renderSessionReport(session, false, 20).join("\n")).toMatch(/[▁-█]{10} /);
  });

  it("no events row without marks; an empty session; no folder", () => {
    const quiet = newSession("s");
    expect(renderSessionReport(quiet, false, 80)).toEqual([
      "Session s · ? · 0 turns · $0.00",
      "No billed turn in this session.",
    ]);
    const found = sessionFiles("abcd1234", root);
    if (typeof found === "string") throw new Error(found);
    const mainOnly = loadSessionModel(found.id, [
      found.files.find((f) => !f.includes("subagents")) as string,
    ]);
    mainOnly.marks.length = 0;
    expect(renderSessionReport(mainOnly, true, 80).join("\n")).not.toContain("events    ");
  });

  it("JSON: totals, components, marks as ISO; nulls when empty", () => {
    const found = sessionFiles("abcd1234", root);
    if (typeof found === "string") throw new Error(found);
    const json = sessionJson(loadSessionModel(found.id, found.files));
    expect(json).toMatchObject({
      sessionId: "abcd1234-0000",
      turns: 3,
      firstAt: new Date(T0).toISOString(),
      marks: expect.arrayContaining([
        { at: new Date(T0 + 600_000).toISOString(), kind: "compact" },
      ]),
    });
    expect(sessionJson(newSession("s"))).toMatchObject({ firstAt: null, lastAt: null, usd: 0 });
  });
});
