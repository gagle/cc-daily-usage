/* eslint-disable no-control-regex -- these tests assert on ANSI escape sequences */
import { describe, expect, it } from "vitest";

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
    nextWarmUsd: 0.04,
    nextColdUsd: 1.24,
    missPremiumUsd: 1.2,
    sessionMissUsd: 0,
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
    expect(line).not.toContain("+5"); // lines-changed segment was removed
    expect(line).toContain("💪 high");
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
    expect(line).toMatch(/⛔ 5h limit · continue at .+? \(in 1h\)/);
    expect(line).toMatch(/⛔ weekly limit · continue at \w+ \d+ .+? \(in 5d 1h\)/);
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
    expect(near).toMatch(/⚠ 5h resets .+? \(in 1h 13m\)/);
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
    expect(soon).toContain("(in 10m)");
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
      /🤖 Opus 5\.5 \| 🔥 cold in 4m · \$0\.04\/msg · if cold \+\$1\.20 \| ⏱ —\/5h —\/7d$/,
    );
  });

  it("a custom layout sets rows and order; a part in no row is hidden; an empty row is dropped", () => {
    const pro = state({ hasSpendCap: false, planType: "claude_pro", cache: forecast() });
    const rows = plain(
      renderStatusline(payload, pro, "main", NOW, [["model", "branch"], ["effort"], ["cache"]]),
    ).split("\n");
    expect(rows).toEqual(["🤖 Opus 5.5 | (🌿 main)", "🔥 cold in 4m · $0.04/msg · if cold +$1.20"]);
    expect(plain(renderStatusline(payload, null, "", NOW, [["branch", "effort"]]))).toBe("");
  });

  it("cache segment: warm countdown + premium, cold, no hints", () => {
    expect(plain(renderStatusline(payload, state({ cache: forecast() }), "", NOW))).toContain(
      "🔥 cold in 4m · $0.04/msg · if cold +$1.20",
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
    ).toMatch(/🔥 cold in 30s · \$0\.04\/msg$/);
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
    ).toMatch(/🔥 warm · \$0\.04\/msg$/);
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
    ).toMatch(/❄ cold · next msg ~\$1\.24$/);
    expect(
      plain(
        renderStatusline(
          payload,
          state({ cache: forecast({ warm: false, nextColdUsd: null }) }),
          "",
          NOW,
        ),
      ),
    ).toContain("❄ cold · next msg ~$0.04");
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
    expect(line).toMatch(/⚠ 5h runs out ~.+? \(in 1h\)/);
    expect(line).toMatch(/⚠ weekly resets/);
    expect(line).not.toMatch(/weekly runs out/);
    expect(
      sub({ runway: { fiveHour: { ...runway, verdict: "on-track" }, sevenDay: null } }),
    ).not.toMatch(/runs out/);
    expect(
      sub({ runway: { fiveHour: { ...runway, exhaustsAt: null }, sevenDay: null } }),
    ).not.toMatch(/runs out/);
  });

  it("shows $ per 1% of the week; no miss cause or hint in the cache part", () => {
    const line = sub({
      rateLimits: { ...NO_LIMITS, sevenDayPct: 20 },
      usdPerPctWeek: 0.85,
      cache: forecast(),
    });
    expect(line).toContain("⏱ 20%/7d · 1%/7d≈$0.85");
    expect(line).not.toContain("miss:");
    expect(line).not.toContain("→");
  });
});

describe("coach part", () => {
  it("shows the top tip with its $ and window; no $ for a rule without one; hidden without a tip", () => {
    const line = (coach: StatuslineState["coach"]): string =>
      plain(renderStatusline(payload, state({ coach }), "", NOW, [["coach"]]));
    expect(line({ title: "Fast mode", usd: 12.4, window: "week" })).toBe(
      "💡 Fast mode ~$12.40/week",
    );
    expect(line({ title: "Running out early", usd: null, window: "week" })).toBe(
      "💡 Running out early",
    );
    expect(line(null)).toBe("");
    expect(plain(renderStatusline(payload, null, "", NOW, [["coach"]]))).toBe("");
  });
});
