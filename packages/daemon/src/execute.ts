import type { PairConfig, StrategyConfig, TrancheExecutionPlan } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";

/**
 * Marketable limit price, derived from the last daily close - buffered 0.5%
 * in the fill direction so it's marketable against normal intra-day movement
 * without chasing an unbounded market order.
 */
function marketableLimitPrice(referencePrice: number, side: "buy" | "sell", bufferFraction = 0.005): string {
  const adjusted = side === "buy" ? referencePrice * (1 + bufferFraction) : referencePrice * (1 - bufferFraction);
  return adjusted >= 1 ? adjusted.toFixed(2) : adjusted.toFixed(8);
}

/** Bitfinex's wallet ticker for Tether is "UST" (older docs/tests may say "USDT"). */
export const USDT_WALLET_CURRENCIES = ["UST", "USDT"] as const;

export function usdtAvailable(wallets: { currency: string; availableBalance: number }[]): number {
  return wallets
    .filter((w) => (USDT_WALLET_CURRENCIES as readonly string[]).includes(w.currency))
    .reduce((sum, w) => sum + (w.availableBalance ?? 0), 0);
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
  /** Always "usdt" now (routing is mandated through USDT pairs). */
  routeDecisions: RouteDecision[];
  /** Exit only: BTC-equivalent of proceeds routed toward the destination asset (bought, or left as USDT for its entry). */
  destinationRoutedBtc?: number;
}


interface OrderWaitOpts {
  pairKey: string;
  fillTimeoutMs: number;
  pollIntervalMs: number;
}

const sleepMs = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Places ONE limit order and waits for it; returns base-currency amount filled (0 on any failure to confirm). */
export async function placeLimitAndWait(
  client: BitfinexRestClient,
  opts: OrderWaitOpts,
  symbol: string,
  action: "buy" | "sell",
  baseAmount: number,
  limitPx: number
): Promise<{ filled: number; dry: boolean }> {
  const result = await client.submitOrder({
    symbol,
    amount: action === "buy" ? baseAmount : -baseAmount,
    price: limitPx >= 1 ? limitPx.toFixed(2) : limitPx.toFixed(8),
    type: "EXCHANGE LIMIT",
  });
  if (result.dryRun) return { filled: baseAmount, dry: true };
  const id = result.exchangeOrderId;
  if (!id) {
    console.error(`[${opts.pairKey}] ${symbol} order submitted but no order id returned - stopping for safety.`);
    return { filled: 0, dry: false };
  }
  const deadline = Date.now() + opts.fillTimeoutMs;
  let state = { active: true, filled: 0, original: 0 };
  for (;;) {
    await sleepMs(opts.pollIntervalMs);
    try {
      state = await client.getOrderFill(symbol, id);
    } catch (err) {
      console.warn(`[${opts.pairKey}] order status read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!state.active) return { filled: state.filled, dry: false };
    if (Date.now() >= deadline) break;
  }
  // Timed out: cancel the resting remainder, keep whatever filled.
  try {
    await client.cancelOrder(id);
    await sleepMs(opts.pollIntervalMs);
    state = await client.getOrderFill(symbol, id);
  } catch (err) {
    console.warn(`[${opts.pairKey}] cancel/final-fill read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.warn(`[${opts.pairKey}] ${symbol} order not fully filled in time: ${state.filled.toFixed(8)} filled, remainder cancelled.`);
  return { filled: state.filled, dry: false };
}

/**
 * Sells up to `usdTarget` worth of a holding for USDT, in chunks of `chunkUsd`,
 * one limit order at a time (each must fill before the next). `symbol` is the
 * holding's USDT pair (e.g. tXMRUST, tBTCUST); `baseAvailable` caps the amount
 * in the holding's own units. Returns USD actually raised (lower-bounded by the
 * sell limit price). Never throws; stops on any partial fill or error.
 */
export async function sellHoldingForUsdt(params: {
  client: BitfinexRestClient;
  pairKey: string;
  symbol: string;
  usdTarget: number;
  baseAvailable: number;
  chunkUsd: number;
  fillTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<number> {
  const { client, symbol, chunkUsd } = params;
  const opts = { pairKey: params.pairKey, fillTimeoutMs: params.fillTimeoutMs ?? 15 * 60_000, pollIntervalMs: params.pollIntervalMs ?? 5_000 };
  let raised = 0;
  try {
    const candle = await client.getCandles(symbol, "1D", 1);
    const price = candle[0]?.close ?? 0;
    if (price <= 0) return 0;
    const minOrder = await client.getMinOrderSize(symbol);
    const sellPx = Number(marketableLimitPrice(price, "sell", 0.005));
    let remainingUsd = params.usdTarget;
    let baseLeft = params.baseAvailable * 0.998;
    while (remainingUsd > 1) {
      const baseAmt = Math.min(Math.min(chunkUsd, remainingUsd) / price, baseLeft);
      if (baseAmt <= 0 || baseAmt < minOrder) break;
      const r = await placeLimitAndWait(client, opts, symbol, "sell", Number(baseAmt.toFixed(8)), sellPx);
      raised += r.filled * sellPx;
      baseLeft -= r.filled;
      remainingUsd -= r.filled * sellPx;
      if (r.filled < baseAmt * 0.999) break;
    }
  } catch (err) {
    console.error(`[${params.pairKey}] cash raise via ${symbol} interrupted: ${err instanceof Error ? err.message : String(err)}`);
  }
  return raised;
}

const BUFFER_FRACTION = 0.01;
const BUFFER_LIMIT = 0.005;

export const DEFAULT_CHUNK_USD = 10_000;

/**
 * Executes a flat<->long rotation for one pair, ALWAYS through USDT pairs and
 * phased in USD chunks (default $10,000, operator-editable): exactly ONE limit
 * order is open at any time; the next chunk is only placed once the previous
 * one has filled (an order that doesn't fill within `fillTimeoutMs` is
 * cancelled, its partial fill kept, and the rest is retried on a later tick).
 *
 *   ENTER asset: per chunk, spend idle USDT first (asset/USDT buy); only a
 *     shortfall is raised by one BTC/USDT sell order.
 *   EXIT asset:  per chunk, sell asset for USDT, then buy BTC with exactly
 *     the proceeds (lower-bounded by the sell limit price).
 *
 * Dry-run orders count as instantly filled. Unspent USDT stays in the wallet
 * and is treated as idle capital on the next tick.
 */
export async function executeRotation(params: {
  client: BitfinexRestClient;
  side: "buy_btc_with_xaut" | "sell_btc_for_xaut";
  btcCapital: number;
  pair: PairConfig;
  config: StrategyConfig;
  /** USD size of each phased limit order. Defaults to config.execution.chunkUsd, then $10,000. */
  chunkUsd?: number;
  /** How long one chunk order may rest before it is cancelled. Default 15 min. */
  fillTimeoutMs?: number;
  pollIntervalMs?: number;
  /** USDT the operator wants kept as cash: never spent by entries. */
  reserveUsd?: number;
  /**
   * Exit only: send up to `btcAmount` (BTC-equivalent) of the proceeds toward
   * another pair's asset instead of BTC. mode "buy": buy that asset directly
   * with the USDT (destination already holds its asset). mode "hold": leave the
   * USDT idle for the destination pair's own entry later this tick (entries
   * spend idle USDT first). Anything beyond btcAmount goes to BTC.
   */
  destination?: { pair: PairConfig; btcAmount: number; mode: "buy" | "hold" };
}): Promise<ExecuteRotationResult> {
  const { client, side, pair, config, destination } = params;
  const reserveUsd = params.reserveUsd ?? 0;
  const enteringAsset = side === "sell_btc_for_xaut";
  const chunkUsd = params.chunkUsd ?? config.execution.chunkUsd ?? DEFAULT_CHUNK_USD;
  const fillTimeoutMs = params.fillTimeoutMs ?? 15 * 60_000;
  const pollIntervalMs = params.pollIntervalMs ?? 5_000;
  const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const routeDecisions: RouteDecision[] = [{ trancheIndex: 0, route: "usdt", directSlippageBtc: 0, usdtSlippageBtc: 0 }];

  const [btcUsdtCandle, assetUsdtCandle] = await Promise.all([
    client.getCandles(pair.btcUsdtSymbol, "1D", 1),
    client.getCandles(pair.assetUsdtSymbol, "1D", 1),
  ]);
  const btcUsdtPrice = btcUsdtCandle[0]?.close ?? 0;
  const assetUsdtPrice = assetUsdtCandle[0]?.close ?? 0;
  if (btcUsdtPrice <= 0 || assetUsdtPrice <= 0 || !(chunkUsd > 0)) {
    console.warn(`[${pair.key}] rotation skipped: USDT prices unavailable or bad chunk size (BTC/USDT ${btcUsdtPrice}, asset/USDT ${assetUsdtPrice}, chunk ${chunkUsd}).`);
    return { plans: [], totalBtcMoved: 0, routeDecisions };
  }

  // Cap to what is really spendable now, BTC-equivalent.
  let btcCapital = params.btcCapital;
  let usdtPool = 0; // idle USDT we may spend (entries)
  let btcPool = 0; // BTC we may sell for a shortfall (entries)
  try {
    const wallets = await client.getWallets();
    const btcAvail = wallets.find((w) => w.currency === "BTC")?.availableBalance ?? 0;
    const ustAvail = Math.max(0, usdtAvailable(wallets) - reserveUsd);
    usdtPool = enteringAsset ? ustAvail * (1 - BUFFER_FRACTION) : 0;
    btcPool = enteringAsset ? btcAvail * (1 - BUFFER_FRACTION) : 0;
    const availableBtc = enteringAsset
      ? btcAvail + ustAvail / btcUsdtPrice
      : ((wallets.find((w) => w.currency === pair.assetCurrency)?.availableBalance ?? 0) * assetUsdtPrice) / btcUsdtPrice;
    const capped = Math.min(btcCapital, availableBtc * (1 - BUFFER_FRACTION));
    if (capped < btcCapital) {
      console.warn(
        `[${pair.key}] rotation size capped: requested ${btcCapital.toFixed(8)} BTC, only ${availableBtc.toFixed(8)} BTC-equivalent available (side ${side}) - using ${Math.max(0, capped).toFixed(8)} BTC.`
      );
    }
    btcCapital = Math.max(0, capped);
  } catch (err) {
    console.warn(
      `[${pair.key}] balance cap check failed, proceeding with requested ${btcCapital.toFixed(8)} BTC uncapped: ${err instanceof Error ? err.message : String(err)}`
    );
    usdtPool = 0;
  }

  const [btcMin, assetMin] = await Promise.all([
    client.getMinOrderSize(pair.btcUsdtSymbol),
    client.getMinOrderSize(pair.assetUsdtSymbol),
  ]);

  const px = (price: number, side: "buy" | "sell") => Number(marketableLimitPrice(price, side, BUFFER_LIMIT));
  const fmt = (n: number) => n.toFixed(8);
  const buyBtcPx = px(btcUsdtPrice, "buy");
  const sellBtcPx = px(btcUsdtPrice, "sell");
  const buyAssetPx = px(assetUsdtPrice, "buy");
  const sellAssetPx = px(assetUsdtPrice, "sell");

  let isLive = false; // becomes true once a real (non-dry-run) order has been placed
  const orderOpts = { pairKey: pair.key, fillTimeoutMs, pollIntervalMs };
  const placeAndWait = async (symbol: string, action: "buy" | "sell", baseAmount: number, limitPx: number): Promise<number> => {
    const r = await placeLimitAndWait(client, orderOpts, symbol, action, baseAmount, limitPx);
    if (!r.dry) isLive = true;
    return r.filled;
  };

  // Destination asset market (exit with a direct asset destination).
  let destBuyPx = 0;
  let destAssetMin = 0;
  if (destination && destination.mode === "buy") {
    const c = await client.getCandles(destination.pair.assetUsdtSymbol, "1D", 1);
    const dp = c[0]?.close ?? 0;
    destBuyPx = px(dp, "buy");
    destAssetMin = await client.getMinOrderSize(destination.pair.assetUsdtSymbol);
    if (destBuyPx <= 0) destination.btcAmount = 0;
  }
  let destUsdLeft = destination ? destination.btcAmount * btcUsdtPrice : 0;
  let destinationRoutedBtc = 0;

  /** Buys `symbol` with up to `usdt`, retrying the unfilled remainder (max 3 orders). */
  async function convertUsdt(
    symbol: string,
    buyPx: number,
    usdt: number,
    minOrder: number,
    onFilled?: (base: number) => void
  ): Promise<{ ok: boolean; spentUsd: number }> {
    let left = usdt;
    for (let attempt = 0; attempt < 3; attempt++) {
      const amt = left / buyPx;
      if (amt < minOrder || amt <= 0) return { ok: true, spentUsd: usdt - left }; // dust
      const got = await placeAndWait(symbol, "buy", Number(fmt(amt)), buyPx);
      onFilled?.(got);
      left -= got * buyPx;
      if (got >= amt * 0.999) return { ok: true, spentUsd: usdt - left };
    }
    return { ok: false, spentUsd: usdt - left };
  }

  let remainingUsd = btcCapital * btcUsdtPrice;
  let totalBtcMoved = 0;
  const minUsd = Math.max(1, chunkUsd * 0.001);

  try {
  while (remainingUsd > minUsd) {
    const c = Math.min(chunkUsd, remainingUsd);
    if (enteringAsset) {
      // Re-sync spendable USDT/BTC from the real wallet each chunk so local
      // accounting drift (limit-price buffers, fees, partials) can never make
      // us over-spend or try to sell BTC we don't have.
      if (isLive) {
        try {
          const w = await client.getWallets();
          usdtPool = Math.max(0, usdtAvailable(w) - reserveUsd) * (1 - 0.002);
          btcPool = (w.find((x) => x.currency === "BTC")?.availableBalance ?? 0) * (1 - 0.002);
        } catch {
          // keep local accounting
        }
      }
      let partial = false;
      if (usdtPool < c) {
        const needUsd = c - usdtPool;
        const sellBtc = Math.min(needUsd / sellBtcPx, btcPool);
        if (sellBtc >= btcMin && sellBtc * sellBtcPx >= minUsd) {
          const f = await placeAndWait(pair.btcUsdtSymbol, "sell", Number(fmt(sellBtc)), sellBtcPx);
          usdtPool += f * sellBtcPx;
          btcPool -= f;
          if (f < sellBtc * 0.999) partial = true;
        }
      }
      const spend = Math.min(c, usdtPool);
      const assetAmt = spend / buyAssetPx;
      if (assetAmt < assetMin || assetAmt <= 0 || spend < minUsd) break; // nothing more spendable: done
      const g = await placeAndWait(pair.assetUsdtSymbol, "buy", Number(fmt(assetAmt)), buyAssetPx);
      usdtPool -= g * buyAssetPx;
      // Progress is measured at what it actually cost (limit price), so the
      // loop ends when the money is spent, not 0.5% short of it.
      remainingUsd -= g * buyAssetPx;
      totalBtcMoved += (g * buyAssetPx) / btcUsdtPrice;
      if (g < assetAmt * 0.999 || partial) break;
    } else {
      const sellAmt = c / assetUsdtPrice;
      if (sellAmt < assetMin) break;
      const f = await placeAndWait(pair.assetUsdtSymbol, "sell", Number(fmt(sellAmt)), sellAssetPx);
      if (f <= 0) break;
      remainingUsd -= f * assetUsdtPrice;
      // The USDT from this chunk MUST be put to work (BTC, or the destination
      // asset) before the next chunk of the asset is sold: each buy retries up
      // to 3 orders on whatever USDT is still unspent, and the whole exit stops
      // if it can't complete.
      const proceeds = f * sellAssetPx; // lower bound of real USDT received
      const toDestUsd = Math.min(proceeds, destUsdLeft);
      destUsdLeft -= toDestUsd;
      let converted = true;
      if (destination && toDestUsd > 0) {
        if (destination.mode === "hold") {
          destinationRoutedBtc += toDestUsd / btcUsdtPrice; // USDT left in wallet for the destination's own entry
        } else {
          const r = await convertUsdt(destination.pair.assetUsdtSymbol, destBuyPx, toDestUsd, destAssetMin);
          destinationRoutedBtc += r.spentUsd / btcUsdtPrice;
          destUsdLeft += toDestUsd - r.spentUsd; // anything unspent falls back to BTC below
          if (!r.ok) converted = false;
        }
      }
      const btcUsd = proceeds - toDestUsd;
      if (converted && btcUsd > 0) {
        const r = await convertUsdt(pair.btcUsdtSymbol, buyBtcPx, btcUsd, btcMin, (b) => (totalBtcMoved += b));
        if (!r.ok) converted = false;
      }
      if (!converted || f < sellAmt * 0.999) break; // USDT stays idle; retried next tick
    }
  }
  } catch (err) {
    // Never throw away bookkeeping for orders that already filled: log, keep
    // what moved, and let the next tick pick up the remainder.
    console.error(
      `[${pair.key}] rotation interrupted by an error after moving ${totalBtcMoved.toFixed(8)} BTC-equiv; remainder retried next tick: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Proceeds routed to a destination asset (or held as USDT for it) count as moved capital too.
  return { plans: [], totalBtcMoved: totalBtcMoved + destinationRoutedBtc, routeDecisions, destinationRoutedBtc };
}
