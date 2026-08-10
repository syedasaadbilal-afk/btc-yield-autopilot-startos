import { describe, expect, it } from "vitest";
import { detectRegime } from "../src/regime.js";
import { makeCandles, linearRamp } from "./testUtils.js";

describe("detectRegime", () => {
  it("reads bullish on a sustained, rising ramp", () => {
    const candles = makeCandles(linearRamp(100, 400, 260));
    expect(detectRegime(candles, 50, 200)).toBe("bullish");
  });

  it("reads bearish on a sustained, falling ramp", () => {
    const candles = makeCandles(linearRamp(400, 100, 260));
    expect(detectRegime(candles, 50, 200)).toBe("bearish");
  });

  it("reads neutral when there isn't enough history for the slow EMA", () => {
    const candles = makeCandles(linearRamp(100, 120, 50));
    expect(detectRegime(candles, 50, 200)).toBe("neutral");
  });
});
