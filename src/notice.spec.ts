import { describe, expect, it } from "vitest";

import { box, calendarUnavailableNotice, noticeStyle, planName, visibleWidth } from "./notice.js";

describe("notice.ts", () => {
  it("colors only on a TTY without NO_COLOR or TERM=dumb", () => {
    expect(noticeStyle({ isTTY: true }, {})).toEqual({ color: true });
    expect(noticeStyle({ isTTY: false }, {})).toEqual({ color: false });
    expect(noticeStyle({ isTTY: true }, { NO_COLOR: "1" })).toEqual({ color: false });
    expect(noticeStyle({ isTTY: true }, { TERM: "dumb" })).toEqual({ color: false });
    expect(noticeStyle().color).toBe(false); // vitest stdout is not a TTY
  });

  it("visibleWidth ignores ANSI and counts emoji as 2", () => {
    expect(visibleWidth("\x1b[1mab\x1b[0m")).toBe(2);
    expect(visibleWidth("📅 x")).toBe(4);
    expect(visibleWidth("ℹ️")).toBe(2);
    expect(visibleWidth("a\u200db")).toBe(2);
    expect(visibleWidth("⟨")).toBe(1);
  });

  it("box draws aligned borders", () => {
    const lines = box({ color: false }, "T", ["a", "bbb"]).split("\n");
    expect(lines).toEqual(["╭─ T ─╮", "│ a   │", "│ bbb │", "╰─────╯"]);
    expect(box({ color: true }, "T", ["a"])).toContain("\x1b[");
  });

  it("planName maps known org types", () => {
    expect(planName("claude_pro")).toBe("Claude Pro");
    expect(planName("weird")).toBe("weird");
    expect(planName(null)).toBe("no Claude login");
  });

  it("subscription and unknown variants", () => {
    const pro = calendarUnavailableNotice({ color: false }, "claude_max", "subscription");
    expect(pro).toContain("Claude Max");
    expect(pro).toContain("⏱");
    const unknown = calendarUnavailableNotice({ color: false }, undefined, "unknown");
    expect(unknown).toContain("Plan not detected yet");
  });

  it("no U+FE0F glyphs: their width differs by terminal and would bend the right border", () => {
    for (const reason of ["subscription", "unknown"] as const) {
      expect(calendarUnavailableNotice({ color: false }, "claude_pro", reason)).not.toContain(
        String.fromCodePoint(0xfe0f),
      );
    }
  });
});
