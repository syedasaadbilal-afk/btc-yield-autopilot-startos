import { describe, expect, it } from "vitest";
import { sizeClipAgainstDepth, checkSlippageBudget, estimateClipSlippageBtc } from "../src/clipSizing.js";

const depth = { timestamp: 0, symbol: "tBTC:XAUT", bidDepth: 2, askDepth: 1 };

describe("sizeClipAgainstDepth", () => {
  it("caps the clip at maxFractionOfBookDepth of the relevant side", () => {
    const amount = sizeClipAgainstDepth(1, 1, depth, "buy_btc_with_xaut", 0.1);
    expect(amount).toBeCloseTo(0.1, 6); // 10% of askDepth=1
  });

  it("never exceeds the remaining tranche amount even if depth allows more", () => {
    const amount = sizeClipAgainstDepth(0.02, 1, depth, "sell_btc_for_xaut", 0.5);
    expect(amount).toBeCloseTo(0.02, 6);
  });

  it("uses bidDepth for sells and askDepth for buys", () => {
    const buy = sizeClipAgainstDepth(10, 10, depth, "buy_btc_with_xaut", 1);
    const sell = sizeClipAgainstDepth(10, 10, depth, "sell_btc_for_xaut", 1);
    expect(buy).toBeCloseTo(depth.askDepth, 6);
    expect(sell).toBeCloseTo(depth.bidDepth, 6);
  });
});

describe("checkSlippageBudget", () => {
  it("passes when estimated slippage is within budget", () => {
    expect(checkSlippageBudget(0.001, 0.003).passes).toBe(true);
  });

  it("fails when estimated slippage exceeds budget", () => {
    expect(checkSlippageBudget(0.01, 0.003).passes).toBe(false);
  });
});

describe("estimateClipSlippageBtc", () => {
  it("returns near-zero for a clip that is small relative to depth", () => {
    const slip = estimateClipSlippageBtc(0.001, depth, "buy_btc_with_xaut");
    expect(slip).toBeLessThan(0.0001);
  });

  it("returns the full clip amount when there is no visible depth", () => {
    const emptyDepth = { ...depth, askDepth: 0 };
    const slip = estimateClipSlippageBtc(0.5, emptyDepth, "buy_btc_with_xaut");
    expect(slip).toBe(0.5);
  });

  it("grows as the clip consumes a larger fraction of depth", () => {
    const small = estimateClipSlippageBtc(0.1, depth, "buy_btc_with_xaut");
    const large = estimateClipSlippageBtc(0.9, depth, "buy_btc_with_xaut");
    expect(large).toBeGreaterThan(small);
  });
});
