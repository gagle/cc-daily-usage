/* eslint-disable no-control-regex -- these tests assert on ANSI escape sequences */
import { describe, expect, it, vi } from "vitest";

import type { CacheForecast } from "./cache-forecast.js";
import type { HookPayload, StatuslineState } from "./interfaces/statusline.interface.js";
import { ccColor, renderStatusline, warmColor } from "./statusline-render.js";

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const NOW = new Date("2026-10-10T10:00:00.000Z");

const NO_LIMITS = {
  fiveHourPct: null,
  sevenDayPct: null,
  fiveHourResetsAt: null,
  sevenDayResetsAt: null,
  source: "none",
} as const;

function state(overrides: Partial<StatuslineState> = {}): StatuslineState {
  return {
    extraUsage: null,
    rateLimits: NO_LIMITS,
    rateLimitsCache: null,
    spendLimitPct: null,
    cache: null,
    hasSpendCap: true,
    planType: "claude_enterprise",
    ...overrides,
  };
}

const payload: HookPayload = {
  model: { display_name: "Opus 5.5" },
  workspace: { project_dir: "/work/my-repo" },
  cost: { total_cost_usd: 1.234 },
  context_window: { used_percentage: 55 },
};

function forecast(overrides: Partial<CacheForecast> = {}): CacheForecast {
  return {
    warm: true,
    secondsUntilCold: 245,
    ttlSeconds: 300,
    expiresAt: null,
    requests: null,
    misses: null,
    nextWarmUsd: 0.04,
    nextColdUsd: 1.24,
    missPremiumUsd: 1.2,
    sessionMissUsd: 0,
    recentMiss: null,
    ...overrides,
  };
}

describe("renderStatusline", () => {
  it("session part only when the budget pipeline failed", () => {
    const line = plain(renderStatusline(payload, null, "", NOW));
    expect(line).toBe(`${"█".repeat(20)} ⚡ 55% | $1.23 | 🤖 Opus 5.5`);
  });

  it("no repo name; branch first, duration, effort", () => {
    const line = plain(
      renderStatusline(
        {
          ...payload,
          workspace: { repo: { name: "named" } },
          cost: { total_cost_usd: 0, total_duration_ms: 3_725_000 },
          effort: { level: "high" },
        },
        null,
        "main",
        NOW,
      ),
    );
    expect(line).not.toContain("named");
    expect(line.startsWith("(🌿 main) |")).toBe(true);
    expect(line).toContain("⏲ 1h 2m");
    const api = plain(
      renderStatusline(
        {
          cost: {
            total_cost_usd: 1.8,
            total_duration_ms: 3_725_000,
            total_api_duration_ms: 65_000,
          },
        },
        state({ promptUsd: 0.4 }),
        "",
        NOW,
        [["cost", "duration"]],
      ),
    );
    expect(api).toBe("$1.80 · prompt $0.40 | ⏲ 1h 2m · api 1m 5s");
    expect(plain(renderStatusline(payload, state({ promptUsd: null }), "", NOW, [["cost"]]))).toBe(
      "$1.23",
    );
    expect(line).not.toContain("+5"); // lines-changed segment was removed
    expect(line).toContain("💪 high");
  });

  it("an account switch puts ⇄ first, on an empty line too", () => {
    const payload = { cost: { total_cost_usd: 1.23 } };
    const switched = state({ accountSwitch: "dev@example.com" });
    expect(plain(renderStatusline(payload, switched, "", NOW, [["cost"], ["branch"]]))).toBe(
      "⇄ dev@example.com | $1.23",
    );
    expect(plain(renderStatusline(payload, switched, "", NOW, [["branch"]]))).toBe(
      "⇄ dev@example.com",
    );
    expect(plain(renderStatusline(payload, state(), "", NOW, [["cost"]]))).toBe("$1.23");
  });

  it("minutes/seconds duration, removed-only lines, every context bucket", () => {
    const short = plain(renderStatusline({ cost: { total_duration_ms: 65_000 } }, null, "", NOW));
    expect(short).toContain("⏲ 1m 5s");
    expect(short).toContain("🟢 0%");
    expect(
      plain(renderStatusline({ context_window: { used_percentage: 75 } }, null, "", NOW)),
    ).toContain("🔥 75%");
    expect(
      plain(renderStatusline({ context_window: { used_percentage: 95 } }, null, "", NOW)),
    ).toContain("🚨 95%");
  });

  it("enterprise laboral day: $today/$max (pct) and $month/$cap (pct)", () => {
    const line = plain(
      renderStatusline(
        payload,
        state({
          todayUsage: 12,
          avgPerDay: 30,
          todayUsedPct: 0.4,
          monthlySpent: 120,
          monthlyCap: 650,
          monthUsedPct: 120 / 650,
        }),
        "",
        NOW,
      ),
    );
    expect(line).toContain("| $12.00/$30.00 (40%) | $120.00/$650.00 (18%)");
  });

  it("an old ledger reading shows its age after the month total", () => {
    const month = { monthlySpent: 120, monthlyCap: 650, monthUsedPct: 120 / 650 };
    const line = (ledgerAgeMs: number | null) =>
      plain(renderStatusline(payload, state({ ...month, ledgerAgeMs }), "", NOW));
    expect(line(27 * 60_000 + 5_000)).toContain("$120.00/$650.00 (18%) 27m old");
    expect(line(59_000)).not.toContain(" old");
    expect(line(null)).not.toContain(" old");
  });

  it("budget exhausted, off day, init nudge", () => {
    expect(
      plain(
        renderStatusline(
          payload,
          state({ todayUsage: 5, avgPerDay: 0, budgetExhausted: true }),
          "",
          NOW,
        ),
      ),
    ).toContain("$5.00/$0.00 (over)");
    expect(plain(renderStatusline(payload, state({ todayUsage: 5 }), "", NOW))).toContain(
      "| $5.00",
    );
    expect(
      plain(renderStatusline(payload, state({ needsInit: true, todayUsage: 5 }), "", NOW)),
    ).toContain("⚠ run: cc-daily-usage init");
    const noPct = plain(
      renderStatusline(payload, state({ avgPerDay: 10, monthlyCap: 100 }), "", NOW),
    );
    expect(noPct).toContain("$0.00/$10.00 (0%) | $0.00/$100.00 (0%)");
  });

  it("Pro: ⏱ placeholder, live windows, ⚠ resets, 🎫 credits — no $ budget", () => {
    const pro = { hasSpendCap: false, planType: "claude_pro" } as const;
    expect(plain(renderStatusline(payload, state(pro), "", NOW))).toContain("⏱ —/5h —/7d");
    const resetSoon = Math.floor(NOW.getTime() / 1000) + 3600;
    const line = plain(
      renderStatusline(
        payload,
        state({
          ...pro,
          rateLimits: {
            fiveHourPct: 100,
            sevenDayPct: 100.4,
            fiveHourResetsAt: resetSoon,
            sevenDayResetsAt: resetSoon + 5 * 86400,
            source: "api",
          },
          extraUsage: {
            usedCredits: 3,
            monthlyLimit: 20,
            utilizationPct: 15,
            currency: "USD",
            spendLimitReached: false,
            disabledReason: null,
          },
        }),
        "",
        NOW,
      ),
    );
    expect(line).toContain("⏱ 100%/5h 100%/7d");
    expect(line).toMatch(/⛔ 5h full → \S+ \(1h\) · 7d full → \w{3} \S+ \(5d1h\)/);
    const near = plain(
      renderStatusline(
        payload,
        state({
          ...pro,
          rateLimits: {
            ...NO_LIMITS,
            fiveHourPct: 92,
            fiveHourResetsAt: resetSoon + 750,
            source: "api",
          },
        }),
        "",
        NOW,
      ),
    );
    expect(near).toMatch(/⚠ 5h resets \S+ \(1h13m\)/);
    const soon = plain(
      renderStatusline(
        payload,
        state({
          ...pro,
          rateLimits: {
            ...NO_LIMITS,
            fiveHourPct: 100,
            fiveHourResetsAt: resetSoon - 3000,
            source: "api",
          },
        }),
        "",
        NOW,
      ),
    );
    expect(soon).toContain("(10m)");
    expect(
      plain(
        renderStatusline(
          payload,
          state({
            ...pro,
            rateLimits: {
              ...NO_LIMITS,
              fiveHourPct: 50,
              fiveHourResetsAt: resetSoon,
              source: "api",
            },
          }),
          "",
          NOW,
        ),
      ),
    ).not.toContain("resets");
    expect(line).toContain("🎫 $3.00/$20.00 (15%)");
    const sevenOnly = plain(
      renderStatusline(
        payload,
        state({ ...pro, rateLimits: { ...NO_LIMITS, sevenDayPct: 8, source: "cache" } }),
        "",
        NOW,
      ),
    );
    expect(sevenOnly).toContain("⏱ 8%/7d");
    const fiveNoReset = plain(
      renderStatusline(
        payload,
        state({ ...pro, rateLimits: { ...NO_LIMITS, fiveHourPct: 100, source: "hook" } }),
        "",
        NOW,
      ),
    );
    expect(fiveNoReset).not.toContain("resets");
  });

  it("default layout: one row, the cache part right after the model/effort, before ⏱", () => {
    const pro = state({ hasSpendCap: false, planType: "claude_pro", cache: forecast() });
    const line = plain(renderStatusline(payload, pro, "main", NOW));
    expect(line).not.toContain("\n");
    expect(line).toMatch(
      /🤖 Opus 5\.5 \| 🔥 cold in 4m · \$0\.04\/req · if cold \+\$1\.20 \| ⏱ —\/5h —\/7d$/,
    );
  });

  it("a custom layout sets rows and order; a part in no row is hidden; an empty row is dropped", () => {
    const pro = state({ hasSpendCap: false, planType: "claude_pro", cache: forecast() });
    const rows = plain(
      renderStatusline(payload, pro, "main", NOW, [["model", "branch"], ["effort"], ["cache"]]),
    ).split("\n");
    expect(rows).toEqual(["🤖 Opus 5.5 | (🌿 main)", "🔥 cold in 4m · $0.04/req · if cold +$1.20"]);
    expect(plain(renderStatusline(payload, null, "", NOW, [["branch", "effort"]]))).toBe("");
  });

  it("cache part warns on a model with no price, and only then", () => {
    const unknown = { ...payload, model: { id: "claude-opus-3", display_name: "Opus 3" } };
    expect(plain(renderStatusline(unknown, state(), "", NOW, [["cache"]]))).toBe(
      "⚠ claude-opus-3: no price, $ not estimated",
    );
    expect(plain(renderStatusline(unknown, null, "", NOW, [["cache"]]))).toContain("no price");
    const known = { ...payload, model: { id: "claude-opus-5-5", display_name: "Opus 5.5" } };
    expect(plain(renderStatusline(known, state(), "", NOW, [["cache"]]))).toBe("");
    expect(plain(renderStatusline(payload, state(), "", NOW, [["cache"]]))).toBe("");
  });

  it("cache segment: warm countdown + premium, cold, no hints", () => {
    expect(plain(renderStatusline(payload, state({ cache: forecast() }), "", NOW))).toContain(
      "🔥 cold in 4m · $0.04/req · if cold +$1.20",
    );
    expect(
      plain(
        renderStatusline(
          payload,
          state({ cache: forecast({ secondsUntilCold: 30, missPremiumUsd: 0 }) }),
          "",
          NOW,
        ),
      ),
    ).toMatch(/🔥 cold in <1m · \$0\.04\/req$/);
    expect(
      plain(
        renderStatusline(
          payload,
          state({
            cache: forecast({ secondsUntilCold: null, missPremiumUsd: null }),
          }),
          "",
          NOW,
        ),
      ),
    ).toMatch(/🔥 warm · \$0\.04\/req$/);
    expect(
      plain(
        renderStatusline(
          payload,
          state({
            cache: forecast({ warm: false }),
          }),
          "",
          NOW,
        ),
      ),
    ).toMatch(/❄ cold · next req ~\$1\.24$/m);
    expect(
      plain(
        renderStatusline(
          payload,
          state({ cache: forecast({ warm: false, recentMiss: "tools changed" }) }),
          "",
          NOW,
        ),
      ),
    ).toMatch(/❄ cold · next req ~\$1\.24 · miss: tools changed$/m);
    const counted = (requests: number | null, misses: number | null): string =>
      plain(
        renderStatusline(
          payload,
          state({ cache: forecast({ warm: false, requests, misses }) }),
          "",
          NOW,
          [["cache"]],
        ),
      );
    expect(counted(14, 2)).toBe("❄ cold · next req ~$1.24 · 2/14 req missed");
    expect(counted(14, 0)).toBe("❄ cold · next req ~$1.24");
    expect(counted(null, 2)).toBe("❄ cold · next req ~$1.24");
    expect(counted(0, 2)).toBe("❄ cold · next req ~$1.24");
    expect(counted(14, null)).toBe("❄ cold · next req ~$1.24");
    expect(
      plain(
        renderStatusline(
          payload,
          state({ cache: forecast({ warm: false, nextColdUsd: null }) }),
          "",
          NOW,
        ),
      ),
    ).toContain("❄ cold · next req ~$0.04");
  });

  it("warm color fades green → yellow → orange with the TTL; cold is red", () => {
    expect(warmColor(300, 300)).toBe("99;190;123");
    expect(warmColor(null, 300)).toBe("99;190;123");
    expect(warmColor(150, 300)).toBe("255;235;132");
    expect(warmColor(0, 300)).toBe("244;164;96");
    expect(warmColor(9999, 300)).toBe("99;190;123");
    expect(warmColor(75, 300)).toBe("250;200;114");
    expect(
      renderStatusline(payload, state({ cache: forecast({ warm: false }) }), "", NOW),
    ).toContain("\x1b[38;2;248;105;107m❄ cold");
  });

  it("gateway spend limit shows as 💳", () => {
    expect(plain(renderStatusline(payload, state({ spendLimitPct: 62.8 }), "", NOW))).toContain(
      "💳 63%",
    );
  });
});

describe("ccColor", () => {
  it("matches colorForPct's buckets", () => {
    expect([0, 0.3, 0.6, 0.8, 1].map(ccColor)).toEqual([
      "99;190;123",
      "161;215;106",
      "255;235;132",
      "244;164;96",
      "248;105;107",
    ]);
  });
});

describe("history parts", () => {
  const sub = (overrides: Partial<StatuslineState>): string =>
    plain(
      renderStatusline(payload, state({ hasSpendCap: false, ...overrides }), "", NOW, [
        ["limits", "warnings", "cache"],
      ]),
    );
  const nowSec = NOW.getTime() / 1000;
  const runway = {
    usedPct: 60,
    resetsAt: nowSec + 7200,
    ratePctPerHour: 40,
    exhaustsAt: nowSec + 3600,
    verdict: "at-risk",
  } as const;

  it("warns when the burn rate empties a window before reset, under the 90% notice", () => {
    const line = sub({
      rateLimits: { ...NO_LIMITS, fiveHourPct: 60, sevenDayPct: 95, sevenDayResetsAt: nowSec + 60 },
      runway: { fiveHour: runway, sevenDay: { ...runway, usedPct: 95 } },
    });
    expect(line).toMatch(/⚠ 5h out ~\S+ \(1h\) · 7d resets \S+ \(1m\)/);
    expect(line).not.toMatch(/7d out/);
    expect(
      sub({ runway: { fiveHour: { ...runway, verdict: "on-track" }, sevenDay: null } }),
    ).not.toMatch(/ out /);
    expect(
      sub({ runway: { fiveHour: { ...runway, exhaustsAt: null }, sevenDay: null } }),
    ).not.toMatch(/ out /);
  });

  it("shows dollar meters, model weekly windows, server-flagged windows and gateway dollars", () => {
    const window = { pct: 40, resetsAt: nowSec + 600, usedDollars: 2, limitDollars: 5 };
    const line = sub({
      rateLimits: {
        ...NO_LIMITS,
        fiveHourPct: 40,
        fiveHourResetsAt: nowSec + 600,
        sevenDayPct: 20,
      },
      apiDetail: {
        fiveHour: { ...window, severity: "warning" },
        sevenDay: { pct: 20, resetsAt: null, severity: "normal" },
        extraWindows: [
          { key: "opus", pct: 55, resetsAt: null },
          { key: "omelette", pct: 1, resetsAt: null },
        ],
      },
    });
    expect(line).toContain("⏱ 40%/5h ($2.00/$5.00) 20%/7d 55%/7d-opus");
    expect(line).not.toContain("omelette");
    expect(line).toContain("⚠ 5h resets");
    const flaggedAtRisk = sub({
      rateLimits: { ...NO_LIMITS, fiveHourPct: 40, fiveHourResetsAt: nowSec + 7200 },
      runway: { fiveHour: runway, sevenDay: null },
      apiDetail: { fiveHour: { ...window, severity: "warning" }, sevenDay: null, extraWindows: [] },
    });
    expect(flaggedAtRisk).toContain("⚠ 5h out ~");
    expect(flaggedAtRisk).not.toContain("resets");
    const spend = (spendLimitUsd: StatuslineState["spendLimitUsd"]): string =>
      plain(
        renderStatusline(payload, state({ spendLimitPct: 62.8, spendLimitUsd }), "", NOW, [
          ["spend"],
        ]),
      );
    expect(spend(null)).toBe("💳 63%");
    expect(spend({ used: 62.8, limit: 100, period: "monthly" })).toBe("💳 63% $62.80/$100.00/mo");
    expect(spend({ used: 1, limit: 2, period: "hourly" })).toBe("💳 63% $1.00/$2.00");
    expect(spend({ used: 1, limit: 2, period: null })).toBe("💳 63% $1.00/$2.00");
  });

  it("writes short times: 12-hour and 24-hour locales, a weekday within a week, a date after", () => {
    vi.stubEnv("TZ", "UTC"); // NOW is 10:00 UTC
    const at = (hours: number): number => nowSec + hours * 3600;
    const line = (exhaustsAt: number): string =>
      sub({ runway: { fiveHour: { ...runway, exhaustsAt }, sevenDay: null } });
    expect(line(at(2))).toContain("5h out ~12pm (2h)");
    expect(line(at(2.5))).toContain("5h out ~12:30pm (2h30m)");
    expect(line(at(-1))).toContain("5h out ~9am (1m)");
    expect(line(at(26))).toMatch(/5h out ~\w{3} 12pm \(1d2h\)/);
    expect(line(at(24 * 8))).toMatch(/5h out ~\w{3} \d+ \(8d0h\)/);
    const options = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
      this: Intl.DateTimeFormat,
    ) {
      return { ...options.call(this), hour12: false };
    });
    expect(line(at(7.5))).toContain("5h out ~17:30 (7h30m)");
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("shows no $ per 1% of the week; no miss cause or hint in the cache part", () => {
    const line = sub({ rateLimits: { ...NO_LIMITS, sevenDayPct: 20 }, cache: forecast() });
    expect(line).toContain("⏱ 20%/7d");
    expect(line).not.toContain("1%/7d");
    expect(line).not.toContain("miss:");
    expect(line).not.toContain("→");
  });
});

describe("next action part", () => {
  it("renders the next action; urgent ones orange; hidden when there is none", () => {
    const line = (overrides: Partial<StatuslineState>, colored = false): string => {
      const out = renderStatusline(payload, state(overrides), "", NOW, [["coach"]]);
      return colored ? out : plain(out);
    };
    expect(
      line({ coach: { title: "Fast mode", action: "/fast off", usd: 12.4, window: "week" } }),
    ).toBe("» /fast off · ~$12.40/week");
    const cold = line({ cache: forecast({ warm: false, nextColdUsd: 2.45 }) }, true);
    expect(cold).toContain("244;164;96");
    expect(plain(cold)).toBe("» new task? /clear · same task? /compact first");
    expect(line({ coach: null })).toBe("");
    expect(plain(renderStatusline(payload, null, "", NOW, [["coach"]]))).toBe("");
  });
});
