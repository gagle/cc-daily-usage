import { describe, expect, it } from "vitest";

import { bar, gradientRgb, paint, sparkline, stacked } from "./meter.js";

// eslint-disable-next-line no-control-regex
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("paint", () => {
  it("wraps in truecolor only when color is on", () => {
    expect(paint("1;2;3", "x", true)).toBe("\x1b[38;2;1;2;3mx\x1b[0m");
    expect(paint("1;2;3", "x", false)).toBe("x");
  });
});

describe("gradientRgb", () => {
  it("green at 0, yellow at 50, red at 100", () => {
    expect(gradientRgb(0)).toBe("0;200;80");
    expect(gradientRgb(50)).toBe("220;200;0");
    expect(gradientRgb(100)).toBe("220;40;20");
  });
});

describe("bar", () => {
  it("fills by fraction and clamps", () => {
    expect(bar(0.5, 10, false)).toBe("█████░░░░░");
    expect(bar(2, 4, false)).toBe("████");
    expect(bar(-1, 4, false)).toBe("░░░░");
    expect(bar(Number.NaN, 3, false)).toBe("░░░");
  });

  it("colors filled cells by position", () => {
    const out = bar(0.5, 2, true);
    expect(out).toContain(gradientRgb(50));
    expect(strip(out)).toBe("█░");
  });
});

describe("stacked", () => {
  const seg = (value: number, glyph: string) => ({ value, rgb: "1;1;1", glyph });

  it("splits cells by value and fills exactly", () => {
    expect(stacked([seg(1, "a"), seg(3, "b")], 8, false)).toBe("aabbbbbb");
    expect(stacked([seg(1, "a"), seg(1, "b"), seg(1, "c")], 10, false)).toHaveLength(10);
  });

  it("gives a tiny non-zero part one cell; zero parts none", () => {
    expect(stacked([seg(0.01, "a"), seg(100, "b"), seg(0, "c")], 5, false)).toBe("abbbb");
  });

  it("fewer cells than parts: still exactly `cells` wide", () => {
    expect(stacked([seg(1, "a"), seg(1, "b"), seg(1, "c")], 2, false)).toHaveLength(2);
    expect(stacked([seg(5, "a"), seg(1, "b")], 1, false)).toBe("a");
  });

  it("empty when the total is zero", () => {
    expect(stacked([seg(0, "a")], 3, false)).toBe("░░░");
  });

  it("uses full blocks when colored", () => {
    expect(strip(stacked([seg(1, "a")], 2, true))).toBe("██");
  });
});

describe("sparkline", () => {
  it("scales to the max", () => {
    expect(sparkline([0, 1, 2, 4])).toBe("▁▃▅█");
    expect(sparkline([0, 0])).toBe("▁▁");
    expect(sparkline([])).toBe("");
  });
});
