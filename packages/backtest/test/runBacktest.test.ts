import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { Candle } from "@autopilot/shared";
import { runBacktest } from "../src/runBacktest.js";

function makeCandles(closes: number[]): Candle[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2020, 0, 1);
  return closes.map((close, i) => ({
    timestamp: start + i * dayMs,
    open: i === 0 ? close : closes[i - 1]!,
    close,
    high: close * 1.001,
    low: close * 0.999,
    volume: 100,
  }));
}

function linearRamp(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

describe("runBacktest", () => {
  it("starts holding BTC, matching the design doc's deployment assumption", () => {
    const ratioCandles = makeCandles(linearRamp(15, 15.5, 50));
    const result = runBacktest({ ratioCandles, config: DEFAULT_STRATEGY_CONFIG });
    expect(result.navHistory[0]!.btcHeld).toBe(DEFAULT_STRATEGY_CONFIG.capital.startingBtc);
    expect(result.navHistory[0]!.xautHeld).toBe(0);
  });

  it("one NAV point is produced per input candle", () => {
    const ratioCandles = makeCandles(linearRamp(15, 15.5, 80));
    const result = runBacktest({ ratioCandles, config: DEFAULT_STRATEGY_CONFIG });
    expect(result.navHistory).toHaveLength(ratioCandles.length);
  });

  it("is deterministic given identical input", () => {
    const ratioCandles = makeCandles(linearRamp(15, 25, 300));
    const a = runBacktest({ ratioCandles, config: DEFAULT_STRATEGY_CONFIG });
    const b = runBacktest({ ratioCandles, config: DEFAULT_STRATEGY_CONFIG });
    expect(a.summary).toEqual(b.summary);
  });

  it("reports zero BTC yield when the strategy never rotates out of BTC", () => {
    // Flat ratio: no regime signal strong enough to leave BTC.
    const ratioCandles = makeCandles(new Array(300).fill(15));
    const result = runBacktest({ ratioCandles, config: DEFAULT_STRATEGY_CONFIG });
    expect(result.summary.numRoundTrips).toBe(0);
    expect(result.summary.totalBtcYieldFraction).toBe(0);
  });

  it("max drawdown is non-negative and at most 1", () => {
    const ratioCandles = makeCandles(linearRamp(30, 10, 300));
    const result = runBacktest({ ratioCandles, config: DEFAULT_STRATEGY_CONFIG });
    expect(result.summary.maxDrawdownFraction).toBeGreaterThanOrEqual(0);
    expect(result.summary.maxDrawdownFraction).toBeLessThanOrEqual(1);
  });

  it("win rate is only computed over completed round trips, not open ones", () => {
    const ratioCandles = makeCandles(linearRamp(30, 10, 300)); // sustained downtrend: may rotate out and never back in
    const result = runBacktest({ ratioCandles, config: DEFAULT_STRATEGY_CONFIG });
    expect(result.summary.numRoundTripsCompleted).toBeLessThanOrEqual(result.summary.numRoundTrips);
    expect(result.summary.winRate).toBeGreaterThanOrEqual(0);
    expect(result.summary.winRate).toBeLessThanOrEqual(1);
  });
});
