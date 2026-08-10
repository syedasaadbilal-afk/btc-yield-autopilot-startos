import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { StrategyDecision } from "@autopilot/shared";
import { gate, currentBtcDrawdownFraction } from "../src/gate.js";

const baseDecision: StrategyDecision = {
  timestamp: 0,
  regime: "bullish",
  target: "long",
  confidence: 0.8,
  reason: "test",
};

describe("gate", () => {
  it("allows a position change with no blocking conditions", () => {
    const result = gate({
      runMode: "PAPER",
      currentPosition: "flat",
      decision: baseDecision,
      now: 1_000_000,
      navHistory: [],
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(result.allow).toBe(true);
  });

  it("blocks new entries when PAUSED", () => {
    const result = gate({
      runMode: "PAUSED",
      currentPosition: "flat",
      decision: baseDecision,
      now: 1_000_000,
      navHistory: [],
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(result.allow).toBe(false);
  });

  it("allows exits even when PAUSED", () => {
    const result = gate({
      runMode: "PAUSED",
      currentPosition: "long",
      decision: { ...baseDecision, target: "flat" },
      now: 1_000_000,
      navHistory: [],
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(result.allow).toBe(true);
  });

  it("blocks a new entry during the post-stop-out cooldown", () => {
    const now = 1_000_000_000;
    const cooldownMs = DEFAULT_STRATEGY_CONFIG.risk.cooldownDaysAfterStop * 24 * 60 * 60 * 1000;
    const result = gate({
      runMode: "PAPER",
      currentPosition: "flat",
      decision: baseDecision,
      now,
      lastStopOutAt: now - cooldownMs / 2,
      navHistory: [],
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/cooldown/i);
  });

  it("allows a new entry once the cooldown has elapsed", () => {
    const now = 1_000_000_000;
    const cooldownMs = DEFAULT_STRATEGY_CONFIG.risk.cooldownDaysAfterStop * 24 * 60 * 60 * 1000;
    const result = gate({
      runMode: "PAPER",
      currentPosition: "flat",
      decision: baseDecision,
      now,
      lastStopOutAt: now - cooldownMs - 1,
      navHistory: [],
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(result.allow).toBe(true);
  });

  it("trips the drawdown circuit breaker on a new entry after a large BTC NAV decline", () => {
    const navHistory = [
      { timestamp: 0, btcHeld: 3, xautHeld: 0, btcXautRatio: 10, btcEquivalentNav: 3 },
      { timestamp: 1, btcHeld: 2.5, xautHeld: 0, btcXautRatio: 10, btcEquivalentNav: 2.5 },
    ];
    const result = gate({
      runMode: "PAPER",
      currentPosition: "flat",
      decision: baseDecision,
      now: 2,
      navHistory,
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/drawdown/i);
  });
});

describe("currentBtcDrawdownFraction", () => {
  it("is zero with no history", () => {
    expect(currentBtcDrawdownFraction([])).toBe(0);
  });

  it("computes the fraction below the running peak", () => {
    const history = [
      { timestamp: 0, btcHeld: 10, xautHeld: 0, btcXautRatio: 1, btcEquivalentNav: 10 },
      { timestamp: 1, btcHeld: 8, xautHeld: 0, btcXautRatio: 1, btcEquivalentNav: 8 },
    ];
    expect(currentBtcDrawdownFraction(history)).toBeCloseTo(0.2, 6);
  });
});
