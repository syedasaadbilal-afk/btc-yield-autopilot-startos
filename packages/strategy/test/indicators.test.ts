import { describe, expect, it } from "vitest";
import { ema, rsi, atr } from "../src/indicators.js";
import { makeCandles, linearRamp } from "./testUtils.js";

describe("ema", () => {
  it("returns NaN before the period is filled", () => {
    const out = ema([1, 2, 3], 5);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("seeds with SMA and converges toward a constant series", () => {
    const values = new Array(20).fill(10);
    const out = ema(values, 5);
    expect(out[4]).toBeCloseTo(10, 6);
    expect(out[19]).toBeCloseTo(10, 6);
  });

  it("tracks a rising series above a slow EMA of the same series after enough bars", () => {
    const values = linearRamp(100, 300, 300);
    const fast = ema(values, 10);
    const slow = ema(values, 50);
    expect(fast[299]!).toBeGreaterThan(slow[299]!);
  });
});

describe("rsi", () => {
  it("approaches 100 on a strictly increasing series", () => {
    const values = linearRamp(100, 200, 30);
    const out = rsi(values, 14);
    expect(out[out.length - 1]).toBeGreaterThan(90);
  });

  it("approaches 0 on a strictly decreasing series", () => {
    const values = linearRamp(200, 100, 30);
    const out = rsi(values, 14);
    expect(out[out.length - 1]).toBeLessThan(10);
  });
});

describe("atr", () => {
  it("is positive for candles with any range", () => {
    const candles = makeCandles(linearRamp(100, 120, 30));
    const out = atr(candles, 14);
    expect(out[out.length - 1]).toBeGreaterThan(0);
  });
});
