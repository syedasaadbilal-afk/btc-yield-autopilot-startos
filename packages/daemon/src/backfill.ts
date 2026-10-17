import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import type { Candle, ExecutionLogEntry, StrategyConfig } from "@autopilot/shared";
import type { Repo } from "./db/repo.js";
import { summarizeFills, type OrderFill } from "./execute.js";

export const BACKFILL_NAME = "execution-fills-v2";
/** Executions logged live with order data (v0.1.7+) are newer than this; everything older is reconstructed. */
export const LIVE_FILLS_SINCE = Date.UTC(2026, 9, 17, 0, 0, 0);
/** A reconstructed match is rejected if its USDT value is off from the logged BTC moved by more than this factor. */
const SANITY_FACTOR = 1.5;
const PRE_MS = 2 * 60_000;
const MAX_WINDOW_MS = 3 * 3_600_000;

/** BTC/USDT at time t from 1-minute candles: midpoint of the minute containing t (nearest minute otherwise). */
function btcPriceAt(candles: Candle[], t: number): number | undefined {
  if (candles.length === 0) return undefined;
  let best = candles[0]!;
  for (const c of candles) {
    if (c.timestamp <= t) best = c;
    else break;
  }
  const px = (best.open + best.close) / 2;
  return px > 0 ? px : undefined;
}

type HistOrder = Awaited<ReturnType<BitfinexRestClient["getTradeFills"]>>[number];

/**
 * One-time reconstruction of per-order data for executions logged before
 * v0.1.7, from Bitfinex's order history: fills each execution's order summary
 * (count, asset amount, USDT value, true average price) and the real
 * average-fill entry/exit price of the trades. Read-only against the exchange.
 * An execution's orders are those of the matching side on the pair's asset/USDT
 * market created between its timestamp and the next same-side execution (max
 * 3h). Anything that can't be matched cleanly is left untouched.
 */
export async function backfillExecutionFills(params: {
  client: BitfinexRestClient;
  repo: Repo;
  config: StrategyConfig;
}): Promise<{ executionsUpdated: number; tradesUpdated: number }> {
  const { client, repo, config } = params;
  let executionsUpdated = 0;
  let tradesUpdated = 0;
  // v1 matched too loosely (order history is short-lived and swept in unrelated orders): redo from scratch.
  repo.clearExecutionFillsBefore(LIVE_FILLS_SINCE);

  for (const pair of config.pairs) {
    const all = repo.getRecentExecutions(pair.key, 2000).sort((a, b) => a.timestamp - b.timestamp);
    const used = new Set<string>();
    // execution id -> weighted BTC/USDT average price of the BTC-leg orders around it
    const ratioByExec = new Map<string, number>();

    const candidates = all.filter((e) => e.status === "executed" && e.routes !== "usdt-cash" && e.orderCount === undefined);
    if (candidates.length === 0) continue;
    // One request per symbol covering every candidate (trades history is rate-limited).
    let assetAll: HistOrder[] = [];
    let btcAll: HistOrder[] = [];
    try {
      const from = candidates[0]!.timestamp - PRE_MS;
      const to = candidates[candidates.length - 1]!.timestamp + MAX_WINDOW_MS;
      [assetAll, btcAll] = await Promise.all([
        client.getTradeFills(pair.assetUsdtSymbol, from, to),
        client.getTradeFills(pair.btcUsdtSymbol, from, to),
      ]);
    } catch (err) {
      throw new Error(`${pair.key}: trade history unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
    console.log(`[backfill] ${pair.key}: ${assetAll.length} asset orders, ${btcAll.length} BTC orders in history for ${candidates.length} executions.`);
    for (const e of candidates) {
      const sideBuy = e.side === "sell_btc_for_xaut"; // entering the asset = buying it
      const nextSame = all.find((x) => x.timestamp > e.timestamp && x.side === e.side);
      const end = Math.min(e.timestamp + MAX_WINDOW_MS, nextSame ? nextSame.timestamp - 1000 : Infinity);
      const start = e.timestamp - PRE_MS;
      const inWindow = (o: HistOrder) => o.firstAt >= start && o.firstAt <= end;
      const assetOrders = assetAll.filter(inWindow);
      const btcOrders = btcAll.filter(inWindow);
      const mine = assetOrders.filter(
        (o) => o.filled > 0 && o.avgPrice > 0 && (o.side === "buy") === sideBuy && !used.has(o.orderId)
      );
      if (mine.length === 0) continue;

      // BTC/USDT at the time of each fill, from 1-minute candles (fallback: BTC orders' average in the window).
      let candles: Candle[] = [];
      try {
        candles = await client.getCandlesBetween(pair.btcUsdtSymbol, "1m", start - 60_000, Math.max(...mine.map((o) => o.firstAt)) + 60_000);
      } catch (err) {
        console.warn(`[backfill] ${pair.key} ${e.id}: BTC candles unavailable (${err instanceof Error ? err.message : String(err)}).`);
      }
      const btcFills = btcOrders.filter((o) => o.filled > 0 && o.avgPrice > 0);
      const btcFillBase = btcFills.reduce((sum, o) => sum + o.filled, 0);
      const btcFallback = btcFillBase > 0 ? btcFills.reduce((sum, o) => sum + o.filled * o.avgPrice, 0) / btcFillBase : undefined;
      const btcAt = (t: number) => btcPriceAt(candles, t) ?? btcFallback;
      if (mine.some((o) => btcAt(o.firstAt) === undefined)) {
        console.warn(`[backfill] ${pair.key} ${e.id}: no BTC price available for its fills; skipping.`);
        continue;
      }

      const fills: OrderFill[] = mine.map((o) => ({
        symbol: pair.assetUsdtSymbol,
        action: o.side,
        base: o.filled,
        price: o.avgPrice,
      }));
      const s = summarizeFills(fills, pair.assetUsdtSymbol);
      if (!s) continue;
      // Cost in BTC: each order converted at the BTC price when it filled.
      const costBtc = mine.reduce((sum, o) => sum + (o.filled * o.avgPrice) / btcAt(o.firstAt)!, 0);
      const avgPriceBtc = costBtc / s.assetAmount;

      if (e.movedBtc > 0) {
        const expectedBtc = e.movedBtc;
        if (costBtc > expectedBtc * SANITY_FACTOR || costBtc < expectedBtc / SANITY_FACTOR) {
          console.warn(
            `[backfill] ${pair.key} ${e.id}: matched orders cost ${costBtc.toFixed(6)} BTC but the log says ${expectedBtc.toFixed(6)} BTC moved; not attributing them.`
          );
          continue;
        }
      }
      mine.forEach((o) => used.add(o.orderId));
      repo.setExecutionFills(e.id, {
        orderCount: s.orderCount,
        assetAmount: s.assetAmount,
        quoteUsd: s.quoteUsd,
        avgPrice: s.avgPrice,
        avgPriceBtc,
        orders: JSON.stringify(fills),
      });
      executionsUpdated++;
      ratioByExec.set(e.id, s.assetAmount / costBtc); // asset units per BTC (trade price convention)
    }

    // Trades: actual price = asset units bought (or sold) per BTC paid (received), with every
    // fill converted at the BTC/USDT price of its own minute.
    const flipExec = (ts: number | undefined): ExecutionLogEntry | undefined =>
      ts === undefined ? undefined : all.find((x) => x.id === `${pair.key}-${ts}-flip`);
    const ratioFor = (x: ExecutionLogEntry | undefined): number | undefined => (x ? ratioByExec.get(x.id) : undefined);
    for (const t of repo.getRecentTrades(pair.key, 500)) {
      const entry = t.actualEntryPrice === undefined ? ratioFor(flipExec(t.openedAt)) : undefined;
      const exit = t.actualExitPrice === undefined && t.closedAt !== undefined ? ratioFor(flipExec(t.closedAt)) : undefined;
      if (entry !== undefined || exit !== undefined) {
        repo.setTradeActualPrices(t.id, {
          ...(entry !== undefined ? { entry } : {}),
          ...(exit !== undefined ? { exit } : {}),
        });
        tradesUpdated++;
      }
    }
  }
  return { executionsUpdated, tradesUpdated };
}
