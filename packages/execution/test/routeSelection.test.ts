import { describe, expect, it } from "vitest";
import { compareExecutionRoutes } from "../src/routeSelection.js";

const btcUsdtPrice = 60000; // USDT per BTC
const assetUsdtPrice = 4000; // USDT per XAUT, e.g.

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
    });
    expect(result.route).toBe("usdt");
  });
});
