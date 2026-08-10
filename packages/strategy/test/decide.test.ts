import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG, POSITION_STATES } from "@autopilot/shared";
import { decide } from "../src/decide.js";
import { makeCandles, linearRamp } from "./testUtils.js";

describe("decide", () => {
  it("holds the current position and returns zero confidence with insufficient history", () => {
    const candles = makeCandles(linearRamp(100, 110, 20));
    const result = decide({
      dailyCandles: candles,
      currentPosition: "flat",
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(result.target).toBe("flat");
    expect(result.confidence).toBe(0);
  });

  it("never targets anything outside the PositionState union", () => {
    const candles = makeCandles(linearRamp(100, 400, 260));
    const result = decide({
      dailyCandles: candles,
      currentPosition: "flat",
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(POSITION_STATES).toContain(result.target);
  });

  it("reads a sustained uptrend as bullish regime", () => {
    const candles = makeCandles(linearRamp(100, 400, 260));
    const result = decide({
      dailyCandles: candles,
      currentPosition: "flat",
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(result.regime).toBe("bullish");
  });

  it("reads a sustained downtrend as bearish regime and does not open a long from flat", () => {
    const candles = makeCandles(linearRamp(400, 100, 260));
    const result = decide({
      dailyCandles: candles,
      currentPosition: "flat",
      config: DEFAULT_STRATEGY_CONFIG,
    });
    expect(result.regime).toBe("bearish");
    expect(result.target).toBe("flat");
  });

  it("is deterministic given identical input", () => {
    const candles = makeCandles(linearRamp(100, 250, 260));
    const a = decide({ dailyCandles: candles, currentPosition: "flat", config: DEFAULT_STRATEGY_CONFIG });
    const b = decide({ dailyCandles: candles, currentPosition: "flat", config: DEFAULT_STRATEGY_CONFIG });
    expect(a).toEqual(b);
  });
});
