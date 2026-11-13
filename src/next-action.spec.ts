import { describe, expect, it } from "vitest";

import type { CacheForecast } from "./cache-forecast.js";
import type { HookPayload, StatuslineState } from "./interfaces/statusline.interface.js";
import type { Runway } from "./limits-history.js";
import { autoCompactAt, nextAction } from "./next-action.js";

function forecast(overrides: Partial<CacheForecast> = {}): CacheForecast {
  return {
    warm: true,
    secondsUntilCold: 245,
    ttlSeconds: 300,
    expiresAt: null,
    requests: null,
    misses: null,
    nextWarmUsd: 0.02,
    nextColdUsd: 1.24,
    missPremiumUsd: 1.22,
    sessionMissUsd: 0,
    recentMiss: null,
    ...overrides,
  };
}

const atRisk: Runway = {
  usedPct: 60,
  resetsAt: null,
  ratePctPerHour: 10,
  exhaustsAt: 1,
  verdict: "at-risk",
};

function state(overrides: Partial<StatuslineState> = {}): StatuslineState {
  return {
    cache: null,
    coach: null,
    runway: { fiveHour: null, sevenDay: null },
    ...overrides,
  } as unknown as StatuslineState;
}

const payload = (tokens = 0): HookPayload => ({ context_window: { total_input_tokens: tokens } });

const text = (p: HookPayload, s: StatuslineState | null): string | undefined =>
  nextAction(p, s)?.text;

describe("nextAction", () => {
  it("nothing without state or anything to act on", () => {
    expect(nextAction(payload(), null)).toBeNull();
    expect(nextAction(payload(), state())).toBeNull();
    expect(nextAction({}, state({ cache: forecast() }))).toBeNull();
  });

  it("cache going cold soon, ranked first", () => {
    const s = state({
      cache: forecast({ secondsUntilCold: 45 }),
      runway: { fiveHour: atRisk, sevenDay: null },
    });
    expect(nextAction(payload(500_000), s)).toEqual({
      kind: "cold-soon",
      text: "send now or /compact · cache cold in 45s, then +$1.22",
    });
    // cheap or unknown premium, unknown countdown, or more time left: no warning
    expect(
      nextAction(
        payload(),
        state({ cache: forecast({ secondsUntilCold: 45, missPremiumUsd: 0.01 }) }),
      ),
    ).toBeNull();
    expect(
      nextAction(
        payload(),
        state({ cache: forecast({ secondsUntilCold: 45, missPremiumUsd: null }) }),
      ),
    ).toBeNull();
    expect(
      nextAction(payload(), state({ cache: forecast({ secondsUntilCold: null }) })),
    ).toBeNull();
    expect(nextAction(payload(), state({ cache: forecast({ secondsUntilCold: 91 }) }))).toBeNull();
  });

  it("cache cold: /clear or /compact before a costly prompt", () => {
    expect(text(payload(), state({ cache: forecast({ warm: false, nextColdUsd: 2.45 }) }))).toBe(
      "new task? /clear · same task? /compact first",
    );
    expect(
      nextAction(payload(), state({ cache: forecast({ warm: false, nextColdUsd: 0.3 }) })),
    ).toBeNull();
    expect(
      nextAction(payload(), state({ cache: forecast({ warm: false, nextColdUsd: null }) })),
    ).toBeNull();
  });

  it("deep context: /compact with the per-turn read", () => {
    expect(text(payload(520_000), state({ cache: forecast({ nextWarmUsd: 0.1 }) }))).toBe(
      "/compact at the next break · 520k re-read each turn, ~$0.10",
    );
    expect(nextAction(payload(520_000), state())).toBeNull(); // no cache data: no price
    expect(
      nextAction(payload(520_000), state({ cache: forecast({ nextWarmUsd: 0.001 }) })),
    ).toBeNull();
  });

  it("auto-compact near: Claude Code's trigger, from its own countdown point on", () => {
    expect(autoCompactAt(200_000)).toBe(167_000);
    expect(autoCompactAt(1_000_000)).toBe(967_000);
    const near = (tokens: number, size: number): HookPayload => ({
      context_window: { total_input_tokens: tokens, context_window_size: size },
    });
    const s = state({ cache: forecast({ nextWarmUsd: 0.1 }) });
    expect(nextAction(near(150_000, 200_000), s)).toEqual({
      kind: "auto-compact",
      text: "/compact now, with a focus · auto-compact in 17k (at 167k)",
    });
    expect(text(near(170_000, 200_000), state())).toBe(
      "/compact now, with a focus · auto-compact next turn (at 167k)",
    );
    expect(nextAction(near(146_999, 200_000), state())).toBeNull(); // before the countdown
    expect(text(near(520_000, 1_000_000), s)).toMatch(/^\/compact at the next break/); // 1M: deep
    expect(text(near(950_000, 1_000_000), s)).toBe(
      "/compact now, with a focus · auto-compact in 17k (at 967k)",
    );
    // cold cache stays first: what the next prompt costs matters more
    expect(
      nextAction(
        near(160_000, 200_000),
        state({ cache: forecast({ warm: false, nextColdUsd: 2 }) }),
      )?.kind,
    ).toBe("cold");
  });

  it("a limit at risk: switch routine steps to Sonnet", () => {
    for (const runway of [
      { fiveHour: atRisk, sevenDay: null },
      { fiveHour: null, sevenDay: atRisk },
    ]) {
      expect(nextAction(payload(), state({ runway }))?.kind).toBe("limits");
    }
    expect(nextAction(payload(), state({ runway: undefined }))).toBeNull();
  });

  it("else the week's top habit: its short action, or its title from an older feed", () => {
    expect(
      text(
        payload(),
        state({ coach: { title: "Fast mode", action: "/fast off", usd: 3, window: "week" } }),
      ),
    ).toBe("/fast off · ~$3.00/week");
    expect(
      text(
        payload(),
        state({ coach: { title: "Older model", action: null, usd: null, window: "week" } }),
      ),
    ).toBe("Older model");
  });
});
