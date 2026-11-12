import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addDays,
  advance,
  avoidableUsd,
  changeOf,
  daysBetween,
  daysSoFar,
  emptyRecords,
  focusChange,
  formatAll,
  formatRecord,
  habitsBetter,
  metricChange,
  METRICS,
  metricValue,
  pickFocus,
  type RecordEntry,
  recordJson,
  recordNotice,
  type RecordsFile,
  type RecordView,
  ruleMoves,
  savedPerWeek,
  shortDay,
  type Snapshot,
  sparkline,
} from "./record.js";

function snap(fields: Partial<Snapshot> = {}): Snapshot {
  return {
    from: "2026-11-05",
    to: "2026-11-11",
    days: 7,
    usd: 100,
    isFloor: false,
    input: 10,
    output: 0,
    cacheRead: 80,
    cacheWrite: 10,
    growth: 2_000_000, // $50/MTok
    usdCarry: 50,
    usdRewrite: 20,
    subagentUsd: 0,
    turns: 10,
    sessions: 3,
    activeMs: 7 * 3_600_000,
    habits: { prompt: 70, interrupt: 1, clear: 2, model: 3, compact: 4, autoCompact: 5 },
    models: { "claude-opus-5-5": 90, "claude-sonnet-5-5": 10 },
    rules: { R4: 20, R5: 10, R6: 30, R10: 50 },
    peak5h: 40,
    peak7d: 60,
    ...fields,
  };
}

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("days", () => {
  it.each(["UTC", "America/New_York", "Pacific/Auckland", "Asia/Kolkata"])(
    "addDays, daysBetween and shortDay are local-day math in %s",
    (zone) => {
      vi.stubEnv("TZ", zone);
      expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
      expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // US DST starts
      expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
      expect(daysBetween("2026-11-05", "2026-11-11")).toBe(7);
      expect(daysBetween("2026-03-07", "2026-03-09")).toBe(3);
      expect(shortDay("2026-11-05")).toBe("Nov 5");
    },
  );

  it("daysSoFar is clamped to 1..length", () => {
    const entry: RecordEntry = {
      n: 1,
      from: "2026-11-12",
      to: "2026-11-18",
      focus: null,
      focusShare: null,
    };
    expect(daysSoFar(entry, "2026-11-12")).toBe(1);
    expect(daysSoFar(entry, "2026-11-14")).toBe(3);
    expect(daysSoFar(entry, "2026-12-01")).toBe(7);
    expect(daysSoFar(entry, "2026-11-01")).toBe(1);
  });
});

describe("metrics", () => {
  it("values, with null when there is nothing to divide by", () => {
    const s = snap();
    expect(metricValue(s, "perMTok")).toBe(50);
    expect(metricValue(s, "cacheReads")).toBe(0.8);
    expect(metricValue(s, "resend")).toBe(0.2);
    expect(metricValue(s, "reread")).toBe(0.5);
    expect(metricValue(s, "avoidable")).toBe(0.3); // R4 + R5; R6 and R10 are not waste you can cut
    const empty = snap({ usd: 0, growth: 0, input: 0, cacheRead: 0, cacheWrite: 0 });
    for (const metric of METRICS) expect(metricValue(empty, metric.id)).toBeNull();
    expect(avoidableUsd(snap({ usd: 5, rules: { R4: 20 } }))).toBe(5); // capped: rules overlap
  });

  it("aims match the advisor", () => {
    expect(METRICS.map((m) => [m.id, m.aim, m.good(m.share ? 0.05 : 20)])).toEqual([
      ["perMTok", "< $33", true],
      ["avoidable", "< 10%", true],
      ["cacheReads", "≥ 90%", false],
      ["resend", "< 10%", true],
      ["reread", "< 54%", true],
    ]);
    expect(METRICS.map((m) => m.good(m.share ? 0.95 : 90))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it("changeOf: 3% relative for $, 2 points for a share; direction; unknown", () => {
    expect(changeOf(50, 40, false, false)).toBe("better");
    expect(changeOf(50, 60, false, false)).toBe("worse");
    expect(changeOf(50, 51, false, false)).toBe("same");
    expect(changeOf(0, 5, false, false)).toBe("same");
    expect(changeOf(0.8, 0.9, true, true)).toBe("better");
    expect(changeOf(0.8, 0.81, true, true)).toBe("same");
    expect(changeOf(0.3, 0.2, false, true)).toBe("better");
    expect(changeOf(null, 1, false, true)).toBeNull();
    expect(changeOf(1, null, false, true)).toBeNull();
    const metric = METRICS[0] as (typeof METRICS)[number];
    expect(metricChange(null, snap(), metric)).toBeNull();
    expect(metricChange(snap(), undefined, metric)).toBeNull();
  });

  it("habitsBetter counts what both can measure", () => {
    const before = snap();
    const after = snap({ growth: 4_000_000, cacheRead: 90, cacheWrite: 0, usdRewrite: 21 });
    expect(habitsBetter(before, after)).toEqual({ better: 2, of: 5 });
    expect(habitsBetter(before, snap({ usd: 0, growth: 0 }))).toEqual({ better: 0, of: 1 });
  });

  it("savedPerWeek: the $/MTok change on the new work, per 7 days", () => {
    const after = snap({ days: 3.5, usd: 25, growth: 1_000_000 }); // $25/MTok
    expect(savedPerWeek(snap(), after)).toBe(50); // ($50 − $25) × 1 MTok × 7/3.5
    expect(savedPerWeek(snap(), snap({ growth: 0 }))).toBeNull();
    expect(savedPerWeek(snap(), snap({ days: 0 }))).toBeNull();
  });

  it("ruleMoves: $ per week, at least $0.50, two each way", () => {
    const before = snap({ rules: { R1: 10, R2: 10, R3: 10, R4: 1, R9: 0.2 } });
    const after = snap({ days: 3.5, rules: { R1: 1, R2: 2, R3: 3, R5: 4, R12: 1, X1: 9 } });
    const moves = ruleMoves(before, after);
    expect(moves.better.map((m) => [m.id, m.usdPerWeek])).toEqual([
      ["R1", -8],
      ["R2", -6],
    ]);
    expect(moves.worse.map((m) => [m.id, m.title, m.usdPerWeek])).toEqual([
      ["X1", "X1", 18],
      ["R5", "Deep context", 8],
    ]);
    expect(ruleMoves(snap({ days: 0, rules: {} }), snap({ days: 0, rules: { R1: 0.05 } }))).toEqual(
      {
        better: [],
        worse: [],
      },
    );
  });

  it("pickFocus: the top rule but R6/R8, with its share; none without $", () => {
    expect(pickFocus(snap())).toEqual({ focus: "R10", focusShare: 0.5 });
    expect(pickFocus(snap({ rules: { R6: 9, R8: 0 } }))).toEqual({ focus: null, focusShare: null });
    expect(pickFocus(snap({ usd: 0 }))).toEqual({ focus: null, focusShare: null });
    expect(pickFocus(null)).toEqual({ focus: null, focusShare: null });
  });

  it("focusChange: the focus share now against where it was picked", () => {
    const entry: RecordEntry = { n: 1, from: "a", to: "b", focus: "R4", focusShare: 0.3 };
    expect(focusChange(entry, snap())).toBe("better"); // 20% now
    expect(focusChange(entry, snap({ rules: {} }))).toBe("better");
    expect(focusChange({ ...entry, focusShare: 0.1 }, snap())).toBe("worse");
    expect(focusChange({ ...entry, focus: null }, snap())).toBeNull();
    expect(focusChange({ ...entry, focusShare: null }, snap())).toBeNull();
    expect(focusChange(entry, snap({ usd: 0 }))).toBeNull();
  });
});

describe("advance", () => {
  const busy = (from: string, to: string): Snapshot => snap({ from, to });

  it("starts record #1 with the 7 days before as baseline and its top rule as focus", () => {
    const calls: Array<string> = [];
    const file = advance(emptyRecords(), "2026-11-12", (from, to) => {
      calls.push(`${from}..${to}`);
      return busy(from, to);
    });
    expect(calls).toEqual(["2026-11-05..2026-11-11"]);
    expect(file.baseline?.from).toBe("2026-11-05");
    expect(file.current).toEqual({
      n: 1,
      from: "2026-11-12",
      to: "2026-11-18",
      focus: "R10",
      focusShare: 0.5,
    });
    expect(advance(file, "2026-11-18", () => busy("x", "y"))).toBe(file); // nothing to do: same object
  });

  it("no use before record #1: no baseline, no focus", () => {
    const file = advance({ ...emptyRecords(), days: 3 }, "2026-11-12", () => snap({ turns: 0 }));
    expect(file.baseline).toBeNull();
    expect(file.current).toMatchObject({ to: "2026-11-14", focus: null });
  });

  it("closes a record the day after its end, starts the next back to back, marks it unseen", () => {
    const one = advance(emptyRecords(), "2026-11-12", busy);
    const two = advance(one, "2026-11-19", busy);
    expect(two.closed).toHaveLength(1);
    expect(two.closed[0]).toMatchObject({
      n: 1,
      snapshot: { from: "2026-11-12", to: "2026-11-18" },
    });
    expect(two.unseen).toBe(1);
    expect(two.current).toMatchObject({ n: 2, from: "2026-11-19", to: "2026-11-25" });
  });

  it("an empty record is not kept: the next starts today with the same number; a long gap closes at most once", () => {
    const one = advance(emptyRecords(), "2026-11-12", busy);
    const later = advance(one, "2026-12-20", (from, to) =>
      from === "2026-11-12" ? busy(from, to) : snap({ turns: 0 }),
    );
    expect(later.closed.map((entry) => entry.n)).toEqual([1]);
    expect(later.current).toMatchObject({ n: 2, from: "2026-12-20", to: "2026-12-26" });
  });

  it("keeps the newest 52 closed records", () => {
    let file: RecordsFile = advance(emptyRecords(), "2026-01-01", busy);
    for (let week = 1; week <= 53; week++)
      file = advance(file, addDays("2026-01-01", week * 7), busy);
    expect(file.closed).toHaveLength(52);
    expect(file.closed[0]?.n).toBe(2);
  });
});

describe("recordNotice", () => {
  const closed = (n: number, s: Snapshot): RecordEntry => ({
    n,
    from: s.from,
    to: s.to,
    focus: null,
    focusShare: null,
    snapshot: s,
  });
  const better = snap({ growth: 4_000_000 });

  it("against the baseline, else the record before; none when seen or unknown", () => {
    const file: RecordsFile = {
      ...emptyRecords(),
      baseline: snap(),
      closed: [closed(1, better)],
      unseen: 1,
    };
    expect(recordNotice(file)).toBe("record #1 done: 1/5 habits better · cc-spend record");
    expect(recordNotice({ ...file, baseline: null })).toBe("record #1 done · cc-spend record");
    expect(
      recordNotice({
        ...file,
        baseline: null,
        closed: [closed(1, snap()), closed(2, better)],
        unseen: 2,
      }),
    ).toBe("record #2 done: 1/5 habits better · cc-spend record");
    expect(
      recordNotice({
        ...file,
        baseline: snap({ usd: 0, growth: 0, cacheRead: 0, input: 0, cacheWrite: 0 }),
      }),
    ).toBe("record #1 done · cc-spend record");
    expect(recordNotice({ ...file, unseen: null })).toBeNull();
    expect(recordNotice({ ...file, unseen: 9 })).toBeNull();
    expect(
      recordNotice({ ...file, closed: [{ ...closed(1, better), snapshot: undefined }] }),
    ).toBeNull();
  });
});

describe("formatRecord", () => {
  const current: RecordEntry = {
    n: 2,
    from: "2026-11-19",
    to: "2026-11-25",
    focus: "R4",
    focusShare: 0.3,
  };
  const prevEntry: RecordEntry = {
    n: 1,
    from: "2026-11-12",
    to: "2026-11-18",
    focus: "R10",
    focusShare: 0.5,
    snapshot: snap({ from: "2026-11-12", to: "2026-11-18", rules: { R10: 40, R1: 20 } }),
  };
  const live = snap({
    from: "2026-11-19",
    to: "2026-11-23",
    days: 5,
    usd: 50,
    growth: 2_000_000, // $25/MTok
    cacheRead: 95,
    cacheWrite: 0,
    input: 5,
    usdCarry: 20,
    usdRewrite: 2,
    rules: { R4: 5, R5: 20 },
    isFloor: true,
  });
  const view = (fields: Partial<RecordView> = {}): RecordView => ({
    file: { ...emptyRecords(), baseline: snap(), current, closed: [prevEntry] },
    live,
    today: "2026-11-23",
    closedNow: null,
    ...fields,
  });

  it("the live record: progress, verdict, habits vs the previous record, focus, moves, volume", () => {
    const text = strip(formatRecord(view(), false));
    expect(text).toContain(
      "RECORD #2  Nov 19 → Nov 25  ▕██████████████░░░░░░▏ day 5/7 · ends Nov 26",
    );
    expect(text).toContain(
      "4 of 5 habits better than baseline · ~$70/week saved at your new rates",
    );
    expect(text).toMatch(/HABITS\s+baseline\s+prev\s+now\s+vs prev\s+aim/);
    expect(text).toMatch(/\$ per MTok new work\s+\$50\s+\$50\s+\$25\s+−50% ✔\s+< \$33/);
    expect(text).toMatch(/re-sending\s+20%\s+20%\s+4%\s+−16pt ✔/);
    expect(text).toContain("FOCUS  R4 Prompt cache re-paid");
    expect(text).toContain("10% of $ now (was 30%) · better ✔");
    expect(text).toMatch(/MOVED {2}better {2}R10 Most spend re-reads context\s+−\$40\/week/);
    expect(text).toMatch(/worse {3}R5 Deep context\s+\+\$28\/week/);
    expect(text).toContain("$ total    ≥ $50 so far");
    expect(text).toContain("prompts    14/day          prev 10/day · baseline 10/day");
    expect(text).toContain("$/prompt   $0.71");
    expect(text).toContain(
      "commands   2 /clear · 4 /compact · 5 auto-compact · 3 /model · 1 interrupts",
    );
    expect(text).toContain("active     1h24m/day · 3 sessions · opus-5-5 180% of $ · 7d peak 60%");
    const colored = formatRecord(view(), true);
    // Better in a green pill, worse in a red one; a value green when it meets its aim, red when not.
    expect(colored).toContain("\x1b[1;38;2;80;220;120;48;2;18;58;34m   −50% ✔ \x1b[0m");
    expect(colored).toContain("\x1b[1;38;2;248;105;107;48;2;70;22;24m  +30pt ✖ \x1b[0m");
    expect(colored).toContain("\x1b[1;38;2;80;220;120m$25\x1b[0m");
    expect(colored).toContain("\x1b[1;38;2;248;105;107m50%\x1b[0m");
  });

  it("too early: dim values, no verdict, no moves", () => {
    const text = strip(
      formatRecord(view({ today: "2026-11-20", live: { ...live, days: 2 } }), false),
    );
    expect(text).toContain("Too early: 2 day(s). Numbers settle after day 3.");
    expect(text).not.toContain("✔");
    expect(text).not.toContain("MOVED");
    expect(text).toContain("10% of $ now (was 30%)\n");
    const colored = formatRecord(view({ today: "2026-11-20", live: { ...live, days: 2 } }), true);
    expect(colored).toContain("\x1b[1;38;2;80;220;120m$25\x1b[0m"); // aim colors from day 1
    expect(colored).not.toContain("48;2;"); // no pills before day 3
  });

  it("no baseline, no previous record, no habits, no focus, no limits, no $", () => {
    const bare = snap({
      usd: 0,
      growth: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      habits: null,
      rules: {},
      models: {},
      peak7d: null,
      sessions: 0,
      activeMs: 0,
    });
    const text = strip(
      formatRecord(
        view({ file: { ...emptyRecords(), current: { ...current, focus: null } }, live: bare }),
        false,
      ),
    );
    expect(text).toContain("No baseline yet");
    expect(text).toMatch(/HABITS\s+baseline\s+now\s+vs base/);
    expect(text).toMatch(/\$ per MTok new work\s+—\s+—/);
    expect(text).not.toContain("FOCUS");
    expect(text).not.toContain("prompts");
    expect(text).toContain("active     0h00m/day · 0 sessions\n");
  });

  it("deltas round to ± and moves list only one side; costlier rates say so", () => {
    const worse = { ...live, days: 7, usd: 101, rules: { ...snap().rules, R10: 60 } };
    const text = strip(
      formatRecord(view({ live: worse, file: { ...view().file, closed: [] } }), false),
    );
    expect(text).toContain("~$1/week more at your new rates");
    expect(text).toMatch(/MOVED {2}worse {3}R10/);
    expect(text).toMatch(/cache reads\s+80%\s+95%\s+\+15pt ✔/);
    const same = strip(
      formatRecord(
        view({
          live: { ...snap(), days: 5 },
          file: { ...view().file, closed: [], current: { ...current, focusShare: 0.2 } },
        }),
        false,
      ),
    );
    expect(same).toMatch(/\$ per MTok new work\s+\$50\s+\$50\s+±0% ≈/);
    expect(same).toMatch(/cache reads\s+80%\s+80%\s+±0pt ≈/);
    expect(same).toContain("same ≈");
    expect(same).not.toContain("/week saved");
    const focusWorse = strip(formatRecord(view({ live: { ...live, rules: { R4: 40 } } }), false));
    expect(focusWorse).toContain("worse ✖");
    const zeroBase = strip(
      formatRecord(
        view({ file: { ...view().file, closed: [], baseline: snap({ growth: 1, usd: 0 }) } }),
        false,
      ),
    );
    expect(zeroBase).toMatch(/\$ per MTok new work\s+\$0\s+\$25\s+ /);
  });

  it("a record that closed since the last look comes first", () => {
    const closedNow = { ...prevEntry, n: 1 };
    const two: RecordEntry = { ...prevEntry, n: 2, focus: "R1", focusShare: 0.5 };
    const file = {
      ...emptyRecords(),
      baseline: snap(),
      current: { ...current, n: 3 },
      closed: [closedNow, two],
    };
    const text = strip(formatRecord(view({ file, closedNow: two }), false));
    expect(text).toContain("RECORD #2 CLOSED  Nov 12 → Nov 18");
    expect(text).toContain("Focus R1 Subagents on a premium model: ✔ done");
    expect(text).toContain("vs record #1: 0 of 5 habits better");
    expect(text).toContain("Record #3 started Nov 19 · new focus: R4 Prompt cache re-paid");
    const first = strip(
      formatRecord(
        view({
          file: { ...file, closed: [closedNow] },
          closedNow: { ...closedNow, focus: "R10", focusShare: 0.2 },
        }),
        false,
      ),
    );
    expect(first).toContain("Focus R10 Most spend re-reads context: ✖ not yet");
    expect(first).not.toContain("vs record #");
    const same = strip(
      formatRecord(
        view({
          file: { ...file, current: { ...current, focus: null } },
          closedNow: { ...closedNow, focus: "R10", focusShare: 0.4 },
        }),
        false,
      ),
    );
    expect(same).toContain("≈ same");
    expect(same).toContain("Record #2 started Nov 19\n");
    const noFocus = strip(formatRecord(view({ closedNow: { ...closedNow, focus: null } }), false));
    expect(noFocus).not.toContain("Focus R");
    const unknownRule = strip(
      formatRecord(
        view({
          file: { ...file, current: { ...current, focus: "R99" } },
          closedNow: { ...closedNow, focus: "R99", focusShare: 1 },
        }),
        false,
      ),
    );
    expect(unknownRule).toContain("Focus R99 : ✔ done");
    expect(unknownRule).toContain("FOCUS  R99  · ");
    expect(
      strip(formatRecord(view({ closedNow: { ...closedNow, snapshot: undefined } }), false)),
    ).not.toContain("CLOSED");
  });

  it("edge values: a focus with no $ or share, unknown references, no moves", () => {
    const flat = snap({
      days: 7,
      usd: 0,
      habits: { prompt: 0, interrupt: 0, clear: 0, model: 0, compact: 0, autoCompact: 0 },
    });
    const file: RecordsFile = {
      ...emptyRecords(),
      baseline: snap({ habits: null }),
      current: { ...current, focusShare: null },
      closed: [{ ...prevEntry, snapshot: flat }],
    };
    const text = strip(formatRecord(view({ file, live: { ...flat, usd: 0 } }), false));
    expect(text).toContain("0% of $ now\n");
    expect(text).toContain("prev 0/day · baseline —");
    expect(text).toContain("prev — · baseline —");
    expect(text).not.toContain("MOVED");
  });

  it("no record yet", () => {
    expect(formatRecord(view({ file: emptyRecords() }), false)).toContain("No record yet");
    expect(formatRecord(view({ live: null }), false)).toContain("No record yet");
  });
});

describe("formatAll and sparkline", () => {
  it("sparkline scales min..max; equal values are flat; unknown is ·", () => {
    expect(sparkline([1, 2, 3])).toBe("▁▅█");
    expect(sparkline([2, 2])).toBe("▁▁");
    expect(sparkline([null, 1, 3])).toBe("·▁█");
  });

  it("baseline, closed and live rows with focus results and a trend", () => {
    const closed: RecordEntry = {
      n: 1,
      from: "2026-11-12",
      to: "2026-11-18",
      focus: "R10",
      focusShare: 0.6,
      snapshot: snap({ from: "2026-11-12", to: "2026-11-18" }),
    };
    const current: RecordEntry = {
      n: 2,
      from: "2026-11-19",
      to: "2026-11-25",
      focus: "R4",
      focusShare: 0.3,
    };
    const file: RecordsFile = {
      ...emptyRecords(),
      baseline: snap(),
      closed: [closed, { ...closed, n: 9, snapshot: undefined }],
      current,
    };
    const live = snap({ from: "2026-11-19", days: 4, growth: 4_000_000 });
    const text = strip(formatAll({ file, live, today: "2026-11-22", closedNow: null }, false));
    expect(text).toMatch(/ b {2}Nov 5 → Nov 11\s+\$50\s+30%\s+80%\s+20%\s+\$100\s+—\s+$/m);
    expect(text).toMatch(/ 1 {2}Nov 12 → Nov 18\s+\$50 .*R10 {2}✔$/m);
    expect(text).toMatch(/ 2 {2}Nov 19 → now\s+\$25 .*\$100…\s+R4 {2}✔ so far$/m);
    expect(text).toMatch(/trend\s+██▁\s+▁▁▁/);
    expect(text).toContain("Next record: 7 days. The live one is on day 4.");
    const colored = formatAll({ file, live, today: "2026-11-22", closedNow: null }, true);
    expect(colored).toContain("\x1b[1;38;2;80;220;120m$25\x1b[0m");
    expect(colored).toContain("\x1b[1;38;2;248;105;107m$50\x1b[0m");
    const results = strip(
      formatAll(
        {
          file: {
            ...file,
            closed: [
              { ...closed, focusShare: 0.1 },
              { ...closed, n: 2, focusShare: 0.5 },
            ],
          },
          live: null,
          today: "x",
          closedNow: null,
        },
        false,
      ),
    );
    expect(results).toMatch(/R10 {2}✖$/m);
    expect(results).toMatch(/R10 {2}≈$/m);
    const early = strip(
      formatAll({ file, live: { ...live, days: 2 }, today: "2026-11-20", closedNow: null }, false),
    );
    expect(early).toMatch(/R4 {2}$/m);
    expect(
      formatAll({ file: emptyRecords(), live: null, today: "x", closedNow: null }, false),
    ).toContain("No record yet");
    const noCurrent = strip(
      formatAll(
        { file: { ...file, current: null }, live: null, today: "x", closedNow: null },
        false,
      ),
    );
    expect(noCurrent).toContain("The live one is on day 0.");
  });
});

describe("recordJson", () => {
  it("every snapshot with its habit values", () => {
    const current: RecordEntry = { n: 1, from: "a", to: "b", focus: null, focusShare: null };
    const json = recordJson({
      file: {
        ...emptyRecords(),
        baseline: snap(),
        current,
        closed: [{ ...current, snapshot: snap() }],
      },
      live: snap(),
      today: "x",
      closedNow: null,
    }) as {
      baseline: { values: Record<string, number> };
      closed: Array<{ snapshot: { values: Record<string, number> } }>;
      current: { snapshot: { values: Record<string, number> } };
    };
    expect(json.baseline.values.perMTok).toBe(50);
    expect(json.closed[0]?.snapshot.values.resend).toBe(0.2);
    expect(json.current.snapshot.values.cacheReads).toBe(0.8);
    expect(recordJson({ file: emptyRecords(), live: null, today: "x", closedNow: null })).toEqual({
      days: 7,
      baseline: null,
      closed: [],
      current: null,
    });
  });
});
