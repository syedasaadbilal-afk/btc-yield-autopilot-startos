import { describe, expect, it } from "vitest";
import { synthesizeRatioCandles } from "../src/alignCandles.js";

function candle(timestamp: number, close: number) {
  return { timestamp, open: close, close, high: close, low: close, volume: 10 };
}

describe("synthesizeRatioCandles", () => {
  it("computes close as BTC/USD divided by XAUT/USD", () => {
    const btc = [candle(1, 50000)];
    const xaut = [candle(1, 2500)];
    const out = synthesizeRatioCandles(btc, xaut);
    expect(out).toHaveLength(1);
    expect(out[0]!.close).toBe(20); // 1 BTC = 20 XAUT
  });

  it("drops days present in only one series", () => {
    const btc = [candle(1, 50000), candle(2, 51000)];
    const xaut = [candle(1, 2500)];
    const out = synthesizeRatioCandles(btc, xaut);
    expect(out).toHaveLength(1);
    expect(out[0]!.timestamp).toBe(1);
  });

  it("returns candles sorted ascending by timestamp", () => {
    const btc = [candle(3, 100), candle(1, 100), candle(2, 100)];
    const xaut = [candle(3, 10), candle(1, 10), candle(2, 10)];
    const out = synthesizeRatioCandles(btc, xaut);
    expect(out.map((c) => c.timestamp)).toEqual([1, 2, 3]);
  });
});
