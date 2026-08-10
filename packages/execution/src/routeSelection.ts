import type { OrderBookDepthSnapshot } from "@autopilot/shared";
import { estimateClipSlippageBtc } from "./clipSizing.js";

/**
 * Compares the estimated BTC slippage cost of trading a rotation's amount
 * directly on the cross pair (e.g. XAUT/BTC) versus routing it through two
 * USDT legs (BTC/USDT then asset/USDT, or the reverse) - Bitfinex charges
 * zero trading fees, so the only real cost difference between "one thin leg"
 * and "two liquid legs" is slippage, not fees. Pure/no I/O: the caller
 * (daemon/src/execute.ts) fetches the live depths/prices and this just does
 * the comparison, which keeps it unit-testable with synthetic inputs.
 */
export interface RouteSlippageInputs {
  side: "buy_btc_with_xaut" | "sell_btc_for_xaut";
  /** BTC-denominated size of this tranche/clip. */
  btcAmount: number;
  directDepth: OrderBookDepthSnapshot;
  btcUsdtDepth: OrderBookDepthSnapshot;
  assetUsdtDepth: OrderBookDepthSnapshot;
  /** Current BTC/USDT price (USDT per 1 BTC). */
  btcUsdtPrice: number;
  /** Current asset/USDT price (USDT per 1 unit of the rotation asset). */
  assetUsdtPrice: number;
}

export interface RouteSlippageComparison {
  route: "direct" | "usdt";
  directSlippageBtc: number;
  usdtSlippageBtc: number;
  usdtLegBreakdown: {
    btcLegSlippageBtc: number;
    assetLegSlippageBtc: number;
  };
}

export function compareExecutionRoutes(input: RouteSlippageInputs): RouteSlippageComparison {
  const { side, btcAmount, directDepth, btcUsdtDepth, assetUsdtDepth, btcUsdtPrice, assetUsdtPrice } =
    input;
  const enteringAsset = side === "sell_btc_for_xaut"; // BTC -> asset

  const directSlippageBtc = estimateClipSlippageBtc(btcAmount, directDepth, side);

  // Leg 1 (BTC/USDT) always trades the BTC-denominated amount directly.
  // "side" here is just a buy/sell proxy for THIS leg's own book, not the
  // overall rotation direction - entering the asset means selling BTC first.
  const btcLegSide: "buy_btc_with_xaut" | "sell_btc_for_xaut" = enteringAsset
    ? "sell_btc_for_xaut"
    : "buy_btc_with_xaut";
  const btcLegSlippageBtc = estimateClipSlippageBtc(btcAmount, btcUsdtDepth, btcLegSide);

  // Leg 2 (asset/USDT) trades an asset-denominated amount - convert the BTC
  // size through both USDT prices to size it, then convert its slippage
  // (which comes back in asset units) back to BTC to make the two legs
  // comparable and summable.
  const assetLegSide: "buy_btc_with_xaut" | "sell_btc_for_xaut" = enteringAsset
    ? "buy_btc_with_xaut"
    : "sell_btc_for_xaut";
  const assetAmount =
    btcUsdtPrice > 0 && assetUsdtPrice > 0 ? (btcAmount * btcUsdtPrice) / assetUsdtPrice : 0;
  const assetLegSlippageAsset = estimateClipSlippageBtc(assetAmount, assetUsdtDepth, assetLegSide);
  const assetLegSlippageBtc =
    assetUsdtPrice > 0 && btcUsdtPrice > 0 ? (assetLegSlippageAsset * assetUsdtPrice) / btcUsdtPrice : 0;

  const usdtSlippageBtc = btcLegSlippageBtc + assetLegSlippageBtc;

  return {
    route: directSlippageBtc <= usdtSlippageBtc ? "direct" : "usdt",
    directSlippageBtc,
    usdtSlippageBtc,
    usdtLegBreakdown: { btcLegSlippageBtc, assetLegSlippageBtc },
  };
}
