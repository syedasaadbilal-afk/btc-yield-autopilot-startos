import type { PairConfig, StrategyConfig, TrancheExecutionPlan } from "@autopilot/shared";
import { computeTrancheBtcAmounts } from "@autopilot/strategy";
import {
  capClipCountToMinOrderSize,
  compareExecutionRoutes,
  planTrancheExecution,
  sizeClipAgainstDepth,
} from "@autopilot/execution";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";

/**
 * Marketable limit price (design doc: "prefer limit"), derived from the last
 * daily close already fetched for routing/comparison purposes - not a true
 * best-bid/ask (bitfinex-client's getBookDepth only returns aggregated depth,
 * not price levels), but close enough on a liquid pair over a short window,
 * and crucially a real positive price rather than the "0" placeholder this
 * replaces (which Bitfinex rejects outright: error 10001 "price: invalid").
 * Buffered 0.5% in the fill direction so it's marketable against normal
 * intra-day movement without chasing an unbounded market order.
 */
function marketableLimitPrice(referencePrice: number, side: "buy" | "sell", bufferFraction = 0.005): string {
  const adjusted = side === "buy" ? referencePrice * (1 + bufferFraction) : referencePrice * (1 - bufferFraction);
  // Bitfinex prices >= 1 conventionally use 2 decimal places (e.g. BTCUST); smaller quote prices (e.g. the direct
  // XAUT:BTC/XMRBTC pairs, priced well under 1) need more precision to avoid rounding the price to 0.
  return adjusted >= 1 ? adjusted.toFixed(2) : adjusted.toFixed(8);
}

/**
 * Clamps a requested BTC-denominated rotation size to what's actually
 * spendable right now, per side:
 *   - "sell_btc_for_xaut" (BTC -> asset): spending BTC directly, so cap
 *     against the BTC wallet's available balance.
 *   - "buy_btc_with_xaut" (asset -> BTC): spending the rotation asset, so
 *     cap against the asset wallet's available balance converted to BTC via
 *     the current direct-pair price (pair.ratioSymbol, btc-per-asset).
 * Leaves a 1% buffer below the raw available balance so this doesn't itself
 * trigger a rejection from rounding/fee-reserve differences between what
 * Bitfinex reports as "available" and what it'll actually let a limit order
 * use. Never throws - if the wallet/price read fails, falls back to the
 * originally requested amount (logged) rather than blocking the tick, since
 * a failed safety check shouldn't be worse than no safety check.
 */
async function capBtcCapitalToAvailableBalance(params: {
  client: BitfinexRestClient;
  pair: PairConfig;
  side: "buy_btc_with_xaut" | "sell_btc_for_xaut";
  requestedBtcCapital: number;
}): Promise<number> {
  const { client, pair, side, requestedBtcCapital } = params;
  const BUFFER_FRACTION = 0.01;
  try {
    const wallets = await client.getWallets();

    let availableBtc: number;
    if (side === "sell_btc_for_xaut") {
      availableBtc = wallets.find((w) => w.currency === "BTC")?.availableBalance ?? 0;
    } else {
      const availableAsset = wallets.find((w) => w.currency === pair.assetCurrency)?.availableBalance ?? 0;
      const directCandle = await client.getCandles(pair.ratioSymbol, "1D", 1);
      const btcPerAsset = directCandle[0]?.close ?? 0; // pair.ratioSymbol is btc-per-asset for both current pairs
      availableBtc = availableAsset * btcPerAsset;
    }

    const cappedBtcCapital = Math.min(requestedBtcCapital, availableBtc * (1 - BUFFER_FRACTION));
    if (cappedBtcCapital < requestedBtcCapital) {
      console.warn(
        `[${pair.key}] rotation size capped: requested ${requestedBtcCapital.toFixed(8)} BTC, only ${availableBtc.toFixed(8)} BTC-equivalent available (side ${side}) - using ${cappedBtcCapital.toFixed(8)} BTC.`
      );
    }
    return Math.max(0, cappedBtcCapital);
  } catch (err) {
    console.warn(
      `[${pair.key}] balance cap check failed, proceeding with requested ${requestedBtcCapital.toFixed(8)} BTC uncapped: ${err instanceof Error ? err.message : String(err)}`
    );
    return requestedBtcCapital;
  }
}

export interface RouteDecision {
  trancheIndex: number;
  route: "direct" | "usdt" | "none";
  directSlippageBtc: number;
  usdtSlippageBtc: number;
}

export interface ExecuteRotationResult {
  plans: TrancheExecutionPlan[];
  totalBtcMoved: number;
  /** Which route each tranche actually used, and why (design doc Section 8 + per-trade slippage comparison). */
  routeDecisions: RouteDecision[];
}

/**
 * Executes a flat<->long rotation for one pair using the layered/tranche
 * approach from the design doc (Section 4: 25/25/50 tranches; Section 8:
 * sliced clips sized against live book depth).
 *
 * Per tranche, this measures estimated slippage on both possible routes -
 * trading pair.ratioSymbol directly (one leg, possibly thin), versus routing
 * through BTC/USDT then asset/USDT or the reverse (two legs, each
 * individually more liquid, and free since Bitfinex charges zero trading
 * fees) - and executes via whichever is actually cheaper for that tranche's
 * size, rather than assuming one route is always better. See
 * @autopilot/execution's compareExecutionRoutes for the estimation itself.
 *
 * v1 note: this places all clips for a tranche back-to-back rather than truly
 * spreading them across `layeringWindowMs` with a scheduler - the daemon's
 * tick interval (hours) is coarser than the layering window (minutes). A
 * persistent clip queue processed on a faster sub-tick is the natural next
 * step once this is running in PAPER; tracked as a follow-up, not blocking
 * the initial build.
 */
export async function executeRotation(params: {
  client: BitfinexRestClient;
  side: "buy_btc_with_xaut" | "sell_btc_for_xaut";
  btcCapital: number;
  pair: PairConfig;
  config: StrategyConfig;
}): Promise<ExecuteRotationResult> {
  const { client, side, pair, config } = params;
  const enteringAsset = side === "sell_btc_for_xaut"; // BTC -> asset

  // Cap against what's actually sitting in the wallet before sizing tranches.
  // btcCapital normally comes from the NAV curve (repo.getLatestNavPoint),
  // which can drift from the real account balance - a manual withdrawal, a
  // fill that came in smaller than planned, dust left over from a prior
  // rotation, etc. Submitting tranches sized off a stale/optimistic NAV
  // risks a rejected order (insufficient balance) mid-rotation, or worse,
  // one leg of a USDT-route pair filling while the other gets rejected.
  // This is a read-only wallet call (getWallets works in every run mode,
  // see restClient.ts), so the cap applies in DRY_RUN/PAPER too - useful for
  // catching a NAV/wallet mismatch before it ever matters in LIVE.
  const btcCapital = await capBtcCapitalToAvailableBalance({
    client,
    pair,
    side,
    requestedBtcCapital: params.btcCapital,
  });

  const [directMinOrderSize, btcUsdtMinOrderSize, assetUsdtMinOrderSize] = await Promise.all([
    client.getMinOrderSize(pair.ratioSymbol),
    client.getMinOrderSize(pair.btcUsdtSymbol),
    client.getMinOrderSize(pair.assetUsdtSymbol),
  ]);
  const trancheAmounts = computeTrancheBtcAmounts(btcCapital, config);
  const plans: TrancheExecutionPlan[] = [];
  const routeDecisions: RouteDecision[] = [];
  let totalBtcMoved = 0;

  for (let i = 0; i < config.risk.trancheWeights.length; i++) {
    const trancheWeight = config.risk.trancheWeights[i]!;
    const trancheBtcAmount = trancheAmounts[i]!;

    const [directDepth, btcUsdtDepth, assetUsdtDepth, directCandle, btcUsdtCandle, assetUsdtCandle] =
      await Promise.all([
        client.getBookDepth(pair.ratioSymbol),
        client.getBookDepth(pair.btcUsdtSymbol),
        client.getBookDepth(pair.assetUsdtSymbol),
        client.getCandles(pair.ratioSymbol, "1D", 1),
        client.getCandles(pair.btcUsdtSymbol, "1D", 1),
        client.getCandles(pair.assetUsdtSymbol, "1D", 1),
      ]);
    const btcUsdtPrice = btcUsdtCandle[0]?.close ?? 0;
    const assetUsdtPrice = assetUsdtCandle[0]?.close ?? 0;
    // pair.ratioSymbol quotes btc-per-asset (see PairConfig.ratioConvention) -
    // TODO: this assumes that convention rather than reading it from `pair`,
    // since both current pairs (XAUT, XMR) happen to be btc-per-asset; if a
    // future pair is asset-per-BTC this needs to invert here too.
    const directPrice = directCandle[0]?.close ?? 0;

    const comparison = compareExecutionRoutes({
      side,
      btcAmount: trancheBtcAmount,
      directDepth,
      btcUsdtDepth,
      assetUsdtDepth,
      btcUsdtPrice,
      assetUsdtPrice,
      directPrice,
      directMinOrderSize,
      btcUsdtMinOrderSize,
      assetUsdtMinOrderSize,
    });
    routeDecisions.push({
      trancheIndex: i,
      route: comparison.route,
      directSlippageBtc: comparison.directSlippageBtc,
      usdtSlippageBtc: comparison.usdtSlippageBtc,
    });
    if (comparison.route === "none") {
      console.warn(`[${pair.key}] tranche ${i} skipped: below Bitfinex minimum order size on every route.`);
      continue;
    }

    if (comparison.route === "direct") {
      const trancheAssetAmount = directPrice > 0 ? trancheBtcAmount / directPrice : 0;
      const cappedClipCount = capClipCountToMinOrderSize(trancheAssetAmount, config.execution.numClipsPerTranche, directMinOrderSize);
      if (cappedClipCount <= 0) {
        console.warn(`[${pair.key}] tranche ${i} skipped: below direct minimum order size.`);
        continue;
      }
      const plan = planTrancheExecution({
        trancheId: `${Date.now()}-${pair.key}-direct-${i}`,
        trancheWeight,
        side,
        scheduledStart: Date.now(),
        config: { ...config.execution, numClipsPerTranche: cappedClipCount },
      });
      const evenSlice = trancheAssetAmount / plan.numClips;
      let remaining = trancheAssetAmount;
      for (const clip of plan.clips) {
        const clipAmount = sizeClipAgainstDepth(
          remaining,
          evenSlice,
          directDepth,
          side,
          clip.maxFractionOfBookDepth
        );
        if (clipAmount <= 0) continue;

        const result = await client.submitOrder({
          symbol: pair.ratioSymbol,
          amount: enteringAsset ? clipAmount : -clipAmount,
          price: marketableLimitPrice(directPrice, enteringAsset ? "buy" : "sell"),
          type: "EXCHANGE LIMIT",
        });

        clip.status = result.dryRun ? "pending" : "placed";
        remaining -= clipAmount;
        totalBtcMoved += clipAmount * directPrice;
        if (remaining <= 0) break;
      }
      plans.push(plan);
      continue;
    }

    // usdt route: two legs, each executed with the same tranche/clip layering.
    const legs = enteringAsset
      ? [
          { symbol: pair.btcUsdtSymbol, action: "sell" as const, depth: btcUsdtDepth, price: btcUsdtPrice },
          { symbol: pair.assetUsdtSymbol, action: "buy" as const, depth: assetUsdtDepth, price: assetUsdtPrice },
        ]
      : [
          { symbol: pair.assetUsdtSymbol, action: "sell" as const, depth: assetUsdtDepth, price: assetUsdtPrice },
          { symbol: pair.btcUsdtSymbol, action: "buy" as const, depth: btcUsdtDepth, price: btcUsdtPrice },
        ];

    for (const leg of legs) {
      // Both legs are sized off the same fixed BTC-equivalent tranche amount
      // (not off the prior leg's actual fill) - correct once in DRY_RUN,
      // since there's no real fill data yet. Needs real fill reconciliation
      // between legs once PAPER mode provides actual amounts (same caveat as
      // the direct route's placeholder limit price below).
      const legAmount =
        leg.symbol === pair.btcUsdtSymbol
          ? trancheBtcAmount
          : btcUsdtPrice > 0 && assetUsdtPrice > 0
            ? (trancheBtcAmount * btcUsdtPrice) / assetUsdtPrice
            : 0;
      const legSideLabel: "buy_btc_with_xaut" | "sell_btc_for_xaut" =
        leg.action === "buy" ? "buy_btc_with_xaut" : "sell_btc_for_xaut";
      const legMinOrderSize = leg.symbol === pair.btcUsdtSymbol ? btcUsdtMinOrderSize : assetUsdtMinOrderSize;
      const cappedClipCount = capClipCountToMinOrderSize(legAmount, config.execution.numClipsPerTranche, legMinOrderSize);
      if (cappedClipCount <= 0) {
        console.warn(`[${pair.key}] tranche ${i} leg ${leg.symbol} skipped: below minimum order size.`);
        continue;
      }
      const plan = planTrancheExecution({
        trancheId: `${Date.now()}-${pair.key}-usdt-${leg.symbol}-${i}`,
        trancheWeight,
        side: legSideLabel,
        scheduledStart: Date.now(),
        config: { ...config.execution, numClipsPerTranche: cappedClipCount },
      });
      const evenSlice = legAmount / plan.numClips;
      let remaining = legAmount;
      for (const clip of plan.clips) {
        const clipAmount = sizeClipAgainstDepth(
          remaining,
          evenSlice,
          leg.depth,
          legSideLabel,
          clip.maxFractionOfBookDepth
        );
        if (clipAmount <= 0) continue;

        const result = await client.submitOrder({
          symbol: leg.symbol,
          amount: leg.action === "buy" ? clipAmount : -clipAmount,
          price: marketableLimitPrice(leg.price, leg.action),
          type: "EXCHANGE LIMIT",
        });

        clip.status = result.dryRun ? "pending" : "placed";
        remaining -= clipAmount;
        if (leg.symbol === pair.btcUsdtSymbol) totalBtcMoved += clipAmount;
        if (remaining <= 0) break;
      }
      plans.push(plan);
    }
  }

  return { plans, totalBtcMoved, routeDecisions };
}
