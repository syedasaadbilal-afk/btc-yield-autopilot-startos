import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import type { ExecutionLogEntry, StrategyConfig } from "@autopilot/shared";
import type { Repo } from "./db/repo.js";
import { summarizeFills, type OrderFill } from "./execute.js";

export const BACKFILL_NAME = "execution-fills-v1";
const PRE_MS = 2 * 60_000;
const MAX_WINDOW_MS = 3 * 3_600_000;

type HistOrder = Awaited<ReturnType<BitfinexRestClient["getOrderHistory"]>>[number];

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

  for (const pair of config.pairs) {
    const all = repo.getRecentExecutions(pair.key, 2000).sort((a, b) => a.timestamp - b.timestamp);
    const used = new Set<string>();
    // execution id -> weighted BTC/USDT average price of the BTC-leg orders around it
    const btcAvgByExec = new Map<string, number>();
    const assetAvgByExec = new Map<string, number>();

    const candidates = all.filter((e) => e.status === "executed" && e.routes !== "usdt-cash" && e.orderCount === undefined);
    for (const e of candidates) {
      const sideBuy = e.side === "sell_btc_for_xaut"; // entering the asset = buying it
      const nextSame = all.find((x) => x.timestamp > e.timestamp && x.side === e.side);
      const end = Math.min(e.timestamp + MAX_WINDOW_MS, nextSame ? nextSame.timestamp - 1000 : Infinity);
      const start = e.timestamp - PRE_MS;
      let assetOrders: HistOrder[] = [];
      let btcOrders: HistOrder[] = [];
      try {
        [assetOrders, btcOrders] = await Promise.all([
          client.getOrderHistory(pair.assetUsdtSymbol, start, end),
          client.getOrderHistory(pair.btcUsdtSymbol, start, end),
        ]);
      } catch (err) {
        console.warn(`[backfill] ${pair.key} ${e.id}: order history unavailable (${err instanceof Error ? err.message : String(err)}); skipping.`);
        continue;
      }
      const mine = assetOrders.filter(
        (o) => o.filled > 0 && o.avgPrice > 0 && (o.side === "buy") === sideBuy && !used.has(o.id)
      );
      if (mine.length === 0) continue;
      mine.forEach((o) => used.add(o.id));
      const fills: OrderFill[] = mine.map((o) => ({
        symbol: pair.assetUsdtSymbol,
        action: o.side,
        base: o.filled,
        price: o.avgPrice,
      }));
      const s = summarizeFills(fills, pair.assetUsdtSymbol);
      if (!s) continue;
      repo.setExecutionFills(e.id, {
        orderCount: s.orderCount,
        assetAmount: s.assetAmount,
        quoteUsd: s.quoteUsd,
        avgPrice: s.avgPrice,
        orders: JSON.stringify(fills),
      });
      executionsUpdated++;
      assetAvgByExec.set(e.id, s.avgPrice);
      const btc = btcOrders.filter((o) => o.filled > 0 && o.avgPrice > 0);
      const btcBase = btc.reduce((sum, o) => sum + o.filled, 0);
      if (btcBase > 0) btcAvgByExec.set(e.id, btc.reduce((sum, o) => sum + o.filled * o.avgPrice, 0) / btcBase);
    }

    // Trades: actual price = BTC/USDT avg over asset/USDT avg (asset per BTC), only when
    // a BTC-leg order was filled in the same window (no guessing a BTC price otherwise).
    const flipExec = (ts: number | undefined): ExecutionLogEntry | undefined =>
      ts === undefined ? undefined : all.find((x) => x.id === `${pair.key}-${ts}-flip`);
    const ratioFor = (x: ExecutionLogEntry | undefined): number | undefined => {
      if (!x) return undefined;
      const a = assetAvgByExec.get(x.id) ?? x.avgPrice;
      const b = btcAvgByExec.get(x.id);
      return a && b ? b / a : undefined;
    };
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
