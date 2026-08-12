import { describe, expect, it } from "vitest";
import { compareExecutionRoutes } from "../src/routeSelection.js";

const btcUsdtPrice = 60000; // USDT per BTC
const assetUsdtPrice = 4000; // USDT per XAUT, e.g.
// directPrice=1 + zero minimums keeps the pre-existing tests below numerically
// identical to their pre-task-#94 behavior (btcAmount passes through
// unconverted, no feasibility constraint) - the unit-conversion and
// minimum-size behaviors get their own dedicated tests further down.
const noMinimums = { directMinOrderSize: 0, btcUsdtMinOrderSize: 0, assetUsdtMinOrderSize: 0 };

describe("compareExecutionRoutes", () => {
  it("picks the direct route when the direct pair is deep and the USDT legs are thin", () => {
    const result = compareExecutionRoutes({
      side: "sell_btc_for_xaut",
      btcAmount: 0.5,
      directDepth: { timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 100, askDepth: 100 },
      btcUsdtDepth: { timestamp: 0, symbol: "tBTCUST", bidDepth: 0.1, askDepth: 0.1 },
      assetUsdtDepth: { timestamp: 0, symbol: "tXAUT:UST", bidDepth: 1, askDepth: 1 },
      btcUsdtPrice,
      assetUsdtPrice,
      directPrice: 1,
      ...noMinimums,
    });
    expect(result.route).toBe("direct");
    expect(result.directSlippageBtc).toBeLessThan(result.usdtSlippageBtc);
  });

  it("picks the USDT route when the direct pair is thin and both USDT legs are deep", () => {
    const result = compareExecutionRoutes({
      side: "sell_btc_for_xaut",
      btcAmount: 0.5,
      directDepth: { timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 0.1, askDepth: 0.1 },
      btcUsdtDepth: { timestamp: 0, symbol: "tBTCUST", bidDepth: 100, askDepth: 100 },
      assetUsdtDepth: { timestamp: 0, symbol: "tXAUT:UST", bidDepth: 1000, askDepth: 1000 },
      btcUsdtPrice,
      assetUsdtPrice,
      directPrice: 1,
      ...noMinimums,
    });
    expect(result.route).toBe("usdt");
    expect(result.usdtSlippageBtc).toBeLessThan(result.directSlippageBtc);
  });

  it("sums both legs' slippage (converted to BTC terms) for the USDT route", () => {
    const result = compareExecutionRoutes({
      side: "sell_btc_for_xaut",
      btcAmount: 0.5,
      directDepth: { timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 1000, askDepth: 1000 },
      btcUsdtDepth: { timestamp: 0, symbol: "tBTCUST", bidDepth: 50, askDepth: 50 },
      assetUsdtDepth: { timestamp: 0, symbol: "tXAUT:UST", bidDepth: 500, askDepth: 500 },
      btcUsdtPrice,
      assetUsdtPrice,
      directPrice: 1,
      ...noMinimums,
    });
    const { btcLegSlippageBtc, assetLegSlippageBtc } = result.usdtLegBreakdown;
    expect(result.usdtSlippageBtc).toBeCloseTo(btcLegSlippageBtc + assetLegSlippageBtc, 10);
    expect(btcLegSlippageBtc).toBeGreaterThan(0);
    expect(assetLegSlippageBtc).toBeGreaterThan(0);
  });

  it("works symmetrically for the asset -> BTC direction", () => {
    const result = compareExecutionRoutes({
      side: "buy_btc_with_xaut",
      btcAmount: 0.5,
      directDepth: { timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 0.1, askDepth: 0.1 },
      btcUsdtDepth: { timestamp: 0, symbol: "tBTCUST", bidDepth: 100, askDepth: 100 },
      assetUsdtDepth: { timestamp: 0, symbol: "tXAUT:UST", bidDepth: 1000, askDepth: 1000 },
      btcUsdtPrice,
      assetUsdtPrice,
      directPrice: 1,
      ...noMinimums,
    });
    expect(result.route).toBe("usdt");
  });

  it("converts btcAmount into the direct pair's asset-denominated units before comparing against depth (unit-mismatch fix)", () => {
    // directPrice = 0.0637 BTC/XAUT (real-ish). 0.5 BTC -> ~7.85 XAUT against
    // a depth of 10 XAUT is genuinely tight; the pre-fix comparison (raw 0.5
    // against the same depth=10) looked artificially deep and understated
    // slippage. directPrice=1 below reproduces the old (buggy) behavior for
    // comparison, since dividing by 1 is a no-op conversion.
    const withConversion = compareExecutionRoutes({
      side: "sell_btc_for_xaut",
      btcAmount: 0.5,
      directDepth: { timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 10, askDepth: 10 },
      btcUsdtDepth: { timestamp: 0, symbol: "tBTCUST", bidDepth: 0, askDepth: 0 },
      assetUsdtDepth: { timestamp: 0, symbol: "tXAUT:UST", bidDepth: 0, askDepth: 0 },
      btcUsdtPrice,
      assetUsdtPrice,
      directPrice: 0.0637,
      ...noMinimums,
    });
    const withoutConversion = compareExecutionRoutes({
      side: "sell_btc_for_xaut",
      btcAmount: 0.5,
      directDepth: { timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 10, askDepth: 10 },
      btcUsdtDepth: { timestamp: 0, symbol: "tBTCUST", bidDepth: 0, askDepth: 0 },
      assetUsdtDepth: { timestamp: 0, symbol: "tXAUT:UST", bidDepth: 0, askDepth: 0 },
      btcUsdtPrice,
      assetUsdtPrice,
      directPrice: 1,
      ...noMinimums,
    });
    expect(withConversion.directSlippageBtc).toBeGreaterThan(withoutConversion.directSlippageBtc);
  });

  it("excludes the direct route when its converted amount is below the exchange minimum, even if it looks cheaper", () => {
    const result = compareExecutionRoutes({
      side: "sell_btc_for_xaut",
      btcAmount: 0.0001,
      directDepth: { timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 1000, askDepth: 1000 },
      btcUsdtDepth: { timestamp: 0, symbol: "tBTCUST", bidDepth: 1000, askDepth: 1000 },
      assetUsdtDepth: { timestamp: 0, symbol: "tXAUT:UST", bidDepth: 1000, askDepth: 1000 },
      btcUsdtPrice,
      assetUsdtPrice,
      directPrice: 0.0637,
      directMinOrderSize: 0.002, // XAUT
      btcUsdtMinOrderSize: 0.00004, // BTC
      assetUsdtMinOrderSize: 0.002, // XAUT
    });
    // 0.0001 BTC / 0.0637 ~= 0.00157 XAUT < 0.002 minimum -> infeasible
    expect(result.directFeasible).toBe(false);
    // asset leg: (0.0001 * 60000) / 4000 = 0.0015 XAUT < 0.002 minimum -> infeasible
    expect(result.usdtFeasible).toBe(false);
    expect(result.route).toBe("none");
  });

  it("prefers the usdt route when direct is infeasible but usdt clears both legs' minimums", () => {
    const result = compareExecutionRoutes({
      side: "sell_btc_for_xaut",
      btcAmount: 0.001,
      directDepth: { timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 1000, askDepth: 1000 },
      btcUsdtDepth: { timestamp: 0, symbol: "tBTCUST", bidDepth: 1000, askDepth: 1000 },
      assetUsdtDepth: { timestamp: 0, symbol: "tXAUT:UST", bidDepth: 1000, askDepth: 1000 },
      btcUsdtPrice,
      assetUsdtPrice,
      directPrice: 0.0637,
      directMinOrderSize: 0.1, // artificially high so direct never clears it
      btcUsdtMinOrderSize: 0.00004,
      assetUsdtMinOrderSize: 0.002,
    });
    expect(result.directFeasible).toBe(false);
    expect(result.usdtFeasible).toBe(true);
    expect(result.route).toBe("usdt");
  });
});
