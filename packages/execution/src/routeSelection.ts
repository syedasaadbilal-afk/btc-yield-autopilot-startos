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
 *
 * Also factors in each route's exchange minimum order size (task #94): a
 * route that looks cheaper on slippage alone is worthless if Bitfinex will
 * reject the order outright for being under the pair's minimum, so a route
 * that can't clear its minimum is excluded from consideration rather than
 * just losing the slippage comparison.
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
  /**
   * Current btc-per-asset price for the direct pair (PairConfig's
   * ratioConvention is "btcPerAsset" for both XAUT and XMR). Bitfinex quotes
   * the direct pair's order book depth AND its minimum order size in the
   * pair's BASE currency - the asset (XAUT/XMR), not BTC - so btcAmount must
   * be converted through this price before comparing against either. Bug
   * found live Aug 2026: this conversion was missing, so a raw BTC amount
   * was compared directly against asset-denominated depth, silently biasing
   * route selection toward "direct" (BTC magnitudes are roughly 15x smaller
   * than XAUT-equivalent ones at typical prices, so the mismatch made
   * direct look artificially deep/cheap).
   */
  directPrice: number;
  /** Exchange minimum order size for the direct pair symbol, asset-denominated. */
  directMinOrderSize: number;
  /** Exchange minimum order size for the BTC/USDT leg symbol, BTC-denominated. */
  btcUsdtMinOrderSize: number;
  /** Exchange minimum order size for the asset/USDT leg symbol, asset-denominated. */
  assetUsdtMinOrderSize: number;
}

export interface RouteSlippageComparison {
  /** "none" means neither route can clear its minimum order size for this amount - the caller should skip trading it rather than submit a doomed order. */
  route: "direct" | "usdt" | "none";
  directSlippageBtc: number;
  usdtSlippageBtc: number;
  usdtLegBreakdown: {
    btcLegSlippageBtc: number;
    assetLegSlippageBtc: number;
  };
  directFeasible: boolean;
  usdtFeasible: boolean;
}

export function compareExecutionRoutes(input: RouteSlippageInputs): RouteSlippageComparison {
  const {
    side,
    btcAmount,
    directDepth,
    btcUsdtDepth,
    assetUsdtDepth,
    btcUsdtPrice,
    assetUsdtPrice,
    directPrice,
    directMinOrderSize,
    btcUsdtMinOrderSize,
    assetUsdtMinOrderSize,
  } = input;
  const enteringAsset = side === "sell_btc_for_xaut"; // BTC -> asset

  // Direct route: convert btcAmount into the direct pair's own
  // asset-denominated units (see directPrice's doc comment) before
  // comparing against depth or the exchange minimum, both of which Bitfinex
  // quotes in that same base currency. estimateClipSlippageBtc's return
  // value is in whatever unit its `amount` argument was in, despite the
  // "Btc" in its name - here that's the asset, so convert the result back
  // to BTC via directPrice (btc-per-asset) before returning it, matching
  // how the USDT route's asset leg already converts its own asset-unit
  // slippage back to BTC below.
  const directAssetAmount = directPrice > 0 ? btcAmount / directPrice : 0;
  const directFeasible = directAssetAmount >= directMinOrderSize;
  const directSlippageAsset = estimateClipSlippageBtc(directAssetAmount, directDepth, side);
  const directSlippageBtc = directSlippageAsset * directPrice;

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
  const usdtFeasible = btcAmount >= btcUsdtMinOrderSize && assetAmount >= assetUsdtMinOrderSize;

  let route: "direct" | "usdt" | "none";
  if (!directFeasible && !usdtFeasible) {
    route = "none";
  } else if (!usdtFeasible) {
    route = "direct";
  } else if (!directFeasible) {
    route = "usdt";
  } else {
    route = directSlippageBtc <= usdtSlippageBtc ? "direct" : "usdt";
  }

  return {
    route,
    directSlippageBtc,
    usdtSlippageBtc,
    usdtLegBreakdown: { btcLegSlippageBtc, assetLegSlippageBtc },
    directFeasible,
    usdtFeasible,
  };
}
