import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import type { Candle, ExecutionLogEntry, StrategyConfig } from "@autopilot/shared";
import type { Repo } from "./db/repo.js";
import type { OrderFill } from "./execute.js";

export const BACKFILL_NAME = "execution-fills-v6";
/** Executions logged live with order data (v0.1.7+) are newer than this; everything older is reconstructed. */
export const LIVE_FILLS_SINCE = Date.UTC(2026, 9, 17, 0, 0, 0);
/** A reconstructed match is rejected if its BTC cost is off from the logged BTC moved by more than this factor. */
const SANITY_FACTOR = 1.5;
const PRE_MS = 2 * 60_000;
/** Buys of the asset with no matching log row are grouped into one execution when each follows the previous within this gap. */
const CLUSTER_GAP_MS = 40 * 60_000;
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
 * v0.1.7, from Bitfinex's trade history (exact fills, long retention). For each
 * execution it collects the matching-side orders on BOTH markets the bot has
 * used: the asset/USDT pair (current routing; priced in USDT and converted to
 * BTC at the BTC/USDT price of the minute each order filled) and the direct
 * asset/BTC pair (early "direct" routing; already priced in BTC). From these it
 * fills the order summary (count, amount, USDT value, average price in USDT and
 * BTC) and the real entry/exit price of the trades. Read-only against the
 * exchange. Orders are taken from the window between an execution's timestamp
 * and the next same-side execution (max 3h); a match whose BTC cost is far from
 * the logged amount is rejected rather than guessed.
 */
export async function backfillExecutionFills(params: {
  client: BitfinexRestClient;
  repo: Repo;
  config: StrategyConfig;
}): Promise<{ executionsUpdated: number; tradesUpdated: number }> {
  const { client, repo, config } = params;
  let executionsUpdated = 0;
  let tradesUpdated = 0;
  // Earlier attempts matched too loosely or missed the direct market: redo from scratch.
  repo.clearExecutionFillsBefore(LIVE_FILLS_SINCE);

  for (const pair of config.pairs) {
    const all = repo.getRecentExecutions(pair.key, 2000).sort((a, b) => a.timestamp - b.timestamp);
    const used = new Set<string>();
    const ratioByExec = new Map<string, number>(); // asset units per BTC (trade price convention)

    const candidates = all.filter((e) => e.status === "executed" && e.routes !== "usdt-cash" && e.orderCount === undefined);
    if (all.length === 0) continue;
    // One request per symbol covering every candidate (trades history is rate-limited).
    let usdtAll: HistOrder[] = [];
    let directAll: HistOrder[] = [];
    let btcAll: HistOrder[] = [];
    try {
      const from = all[0]!.timestamp - PRE_MS;
      const to = Math.max(candidates.length ? candidates[candidates.length - 1]!.timestamp + MAX_WINDOW_MS : 0, LIVE_FILLS_SINCE);
      [usdtAll, directAll, btcAll] = await Promise.all([
        client.getTradeFills(pair.assetUsdtSymbol, from, to, pair.assetCurrency),
        client.getTradeFills(pair.ratioSymbol, from, to, pair.assetCurrency),
        client.getTradeFills(pair.btcUsdtSymbol, from, to),
      ]);
    } catch (err) {
      throw new Error(`${pair.key}: trade history unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
    console.log(
      `[backfill] ${pair.key}: ${usdtAll.length} ${pair.assetUsdtSymbol} orders, ${directAll.length} ${pair.ratioSymbol} orders, ${btcAll.length} ${pair.btcUsdtSymbol} orders in history for ${candidates.length} executions.`
    );

    // Reconciliation: everything the exchange says was bought/sold on this asset since the first logged
    // execution, versus the live wallet. A gap means the history/log is incomplete (or something was
    // deposited/withdrawn). Logged only; no data is changed.
    try {
      const orders = [...usdtAll, ...directAll].filter((o) => o.filled > 0);
      const bought = orders.filter((o) => o.side === "buy").reduce((s, o) => s + o.filled, 0);
      const sold = orders.filter((o) => o.side === "sell").reduce((s, o) => s + o.filled, 0);
      const fees = orders.reduce((s, o) => s + o.feeBase, 0); // negative = paid in the asset
      const wallets = await client.getWallets();
      const held = wallets.find((w) => w.currency === pair.assetCurrency)?.balance ?? 0;
      const net = bought - sold + fees;
      console.log(
        `[backfill] ${pair.key} reconcile: bought ${bought.toFixed(4)} - sold ${sold.toFixed(4)} + fees ${fees.toFixed(4)} = ${net.toFixed(4)} ${pair.assetCurrency} from exchange history vs ${held.toFixed(4)} in wallet (difference ${(held - net).toFixed(4)}).`
      );
    } catch (err) {
      console.warn(`[backfill] ${pair.key} reconcile skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const e of candidates) {
      const sideBuy = e.side === "sell_btc_for_xaut"; // entering the asset = buying it
      const nextSame = all.find((x) => x.timestamp > e.timestamp && x.side === e.side);
      const end = Math.min(e.timestamp + MAX_WINDOW_MS, nextSame ? nextSame.timestamp - 1000 : Infinity);
      const start = e.timestamp - PRE_MS;
      const pick = (src: HistOrder[]) =>
        src.filter(
          (o) =>
            o.firstAt >= start &&
            o.firstAt <= end &&
            o.filled > 0 &&
            o.avgPrice > 0 &&
            (o.side === "buy") === sideBuy &&
            !used.has(o.orderId)
        );
      const usdtOrders = pick(usdtAll);
      const directOrders = pick(directAll);
      if (usdtOrders.length + directOrders.length === 0) continue;

      // BTC/USDT at the time of each fill, from 1-minute candles (fallback: BTC/USDT orders' average in the window).
      let candles: Candle[] = [];
      const lastAt = Math.max(...usdtOrders.map((o) => o.firstAt), ...directOrders.map((o) => o.firstAt));
      try {
        candles = await client.getCandlesBetween(pair.btcUsdtSymbol, "1m", start - 60_000, lastAt + 60_000);
      } catch (err) {
        console.warn(`[backfill] ${pair.key} ${e.id}: BTC candles unavailable (${err instanceof Error ? err.message : String(err)}).`);
      }
      const btcFills = btcAll.filter((o) => o.firstAt >= start && o.firstAt <= end && o.filled > 0 && o.avgPrice > 0);
      const btcFillBase = btcFills.reduce((sum, o) => sum + o.filled, 0);
      const btcFallback = btcFillBase > 0 ? btcFills.reduce((sum, o) => sum + o.filled * o.avgPrice, 0) / btcFillBase : undefined;
      const btcAt = (t: number) => btcPriceAt(candles, t) ?? btcFallback;
      if ([...usdtOrders, ...directOrders].some((o) => btcAt(o.firstAt) === undefined)) {
        console.warn(`[backfill] ${pair.key} ${e.id}: no BTC price available for its fills; skipping.`);
        continue;
      }

      const action = sideBuy ? "buy" : "sell";
      const fills: OrderFill[] = [];
      let base = 0;
      let costBtc = 0;
      let costUsd = 0;
      for (const o of usdtOrders) {
        const b = btcAt(o.firstAt)!;
        fills.push({ symbol: pair.assetUsdtSymbol, action, base: o.filled, price: o.avgPrice });
        base += o.filled;
        costUsd += o.filled * o.avgPrice;
        costBtc += (o.filled * o.avgPrice) / b;
      }
      for (const o of directOrders) {
        const b = btcAt(o.firstAt)!;
        fills.push({ symbol: pair.ratioSymbol, action, base: o.filled, price: o.avgPrice });
        base += o.filled;
        costBtc += o.filled * o.avgPrice; // already BTC
        costUsd += o.filled * o.avgPrice * b;
      }

      if (e.movedBtc > 0 && (costBtc > e.movedBtc * SANITY_FACTOR || costBtc < e.movedBtc / SANITY_FACTOR)) {
        console.warn(
          `[backfill] ${pair.key} ${e.id}: matched orders cost ${costBtc.toFixed(6)} BTC but the log says ${e.movedBtc.toFixed(6)} BTC moved; not attributing them.`
        );
        continue;
      }
      [...usdtOrders, ...directOrders].forEach((o) => used.add(o.orderId));
      repo.setExecutionFills(e.id, {
        orderCount: fills.length,
        assetAmount: base,
        quoteUsd: costUsd,
        avgPrice: costUsd / base,
        avgPriceBtc: costBtc / base,
        orders: JSON.stringify(fills),
      });
      executionsUpdated++;
      ratioByExec.set(e.id, base / costBtc);
    }

    // Recovery: buys of the asset that no log row accounts for (typically a long run of
    // chunk orders that was interrupted before its row was written). The exchange account is
    // used only by this bot, so every unmatched buy is the bot's. Grouped into clusters and
    // added as clearly labelled "recovered" rows. Buys only: sells are already covered by
    // exit/resize rows and cash-raise rows, and would otherwise show up twice.
    const leftovers = [
      ...usdtAll.map((o) => ({ o, symbol: pair.assetUsdtSymbol, usdt: true })),
      ...directAll.map((o) => ({ o, symbol: pair.ratioSymbol, usdt: false })),
    ]
      .filter((x) => x.o.side === "buy" && x.o.filled > 0 && x.o.avgPrice > 0 && !used.has(x.o.orderId) && x.o.firstAt < LIVE_FILLS_SINCE)
      .sort((a, b) => a.o.firstAt - b.o.firstAt);
    const recoveredRatios: Array<{ firstAt: number; lastAt: number; ratio: number }> = [];
    const clusters: (typeof leftovers)[] = [];
    for (const x of leftovers) {
      const cur = clusters[clusters.length - 1];
      if (cur && x.o.firstAt - cur[cur.length - 1]!.o.firstAt <= CLUSTER_GAP_MS) cur.push(x);
      else clusters.push([x]);
    }
    for (const cl of clusters) {
      const firstAt = cl[0]!.o.firstAt;
      const lastAt = cl[cl.length - 1]!.o.firstAt;
      let candles: Candle[] = [];
      try {
        candles = await client.getCandlesBetween(pair.btcUsdtSymbol, "1m", firstAt - 60_000, lastAt + 60_000);
      } catch (err) {
        console.warn(`[backfill] ${pair.key} recovery @${new Date(firstAt).toISOString()}: BTC candles unavailable (${err instanceof Error ? err.message : String(err)}); skipping cluster.`);
        continue;
      }
      let base = 0;
      let costBtc = 0;
      let costUsd = 0;
      const fills: OrderFill[] = [];
      let ok = true;
      for (const x of cl) {
        const b = btcPriceAt(candles, x.o.firstAt);
        if (!b) {
          ok = false;
          break;
        }
        fills.push({ symbol: x.symbol, action: "buy", base: x.o.filled, price: x.o.avgPrice });
        base += x.o.filled;
        if (x.usdt) {
          costUsd += x.o.filled * x.o.avgPrice;
          costBtc += (x.o.filled * x.o.avgPrice) / b;
        } else {
          costBtc += x.o.filled * x.o.avgPrice;
          costUsd += x.o.filled * x.o.avgPrice * b;
        }
      }
      if (!ok || base <= 0) continue;
      repo.insertExecutionLog({
        id: `${pair.key}-${firstAt}-recovered`,
        pairKey: pair.key,
        timestamp: firstAt,
        kind: "topup",
        side: "sell_btc_for_xaut",
        requestedBtc: costBtc,
        movedBtc: costBtc,
        status: "executed",
        routes: "recovered",
        orderCount: fills.length,
        assetAmount: base,
        quoteUsd: costUsd,
        avgPrice: costUsd / base,
        avgPriceBtc: costBtc / base,
        orders: JSON.stringify(fills),
      });
      executionsUpdated++;
      recoveredRatios.push({ firstAt, lastAt, ratio: base / costBtc });
      console.log(`[backfill] ${pair.key}: recovered ${fills.length} unlogged buys (${base.toFixed(4)} ${pair.assetCurrency}, $${costUsd.toFixed(0)}) at ${new Date(firstAt).toISOString()}.`);
    }

    // Trades: actual price = asset units bought (or sold) per BTC paid (received), with every
    // fill converted at the BTC/USDT price of its own minute.
    const flipExec = (ts: number | undefined): ExecutionLogEntry | undefined =>
      ts === undefined ? undefined : all.find((x) => x.id === `${pair.key}-${ts}-flip`);
    // A flip whose orders couldn't be matched to its own row (e.g. it was recovered as a separate cluster)
    // still gets its real price from the recovered cluster that starts within its window.
    const ratioFor = (x: ExecutionLogEntry | undefined, ts: number | undefined): number | undefined => {
      const direct = x ? ratioByExec.get(x.id) : undefined;
      if (direct !== undefined || ts === undefined) return direct;
      return recoveredRatios.find((r) => r.firstAt >= ts - PRE_MS && r.firstAt <= ts + MAX_WINDOW_MS)?.ratio;
    };
    // Signal prices like-for-like with TradingView: it fills a signal at the NEXT bar's open, so restate
    // each trade's signal price as the open of the UTC daily bar it executed in (asset-per-BTC convention).
    try {
      const dayOpen = new Map<number, number>();
      for (const c of await client.getCandles(pair.ratioSymbol, "1D", 400)) {
        if (c.open > 0) dayOpen.set(c.timestamp, pair.ratioConvention === "btcPerAsset" ? 1 / c.open : c.open);
      }
      const openOn = (ts: number | undefined) => (ts === undefined ? undefined : dayOpen.get(Math.floor(ts / 86_400_000) * 86_400_000));
      for (const t of repo.getRecentTrades(pair.key, 500)) {
        if (t.status === "cancelled") continue;
        const bootstrap = t.notes?.includes("Bootstrap-inferred") === true;
        const entry = bootstrap ? undefined : openOn(t.openedAt);
        const exit = openOn(t.closedAt);
        if (entry !== undefined || exit !== undefined) {
          repo.setTradeSignalPrices(t.id, { ...(entry !== undefined ? { entry } : {}), ...(exit !== undefined ? { exit } : {}) });
        }
      }
    } catch (err) {
      console.warn(`[backfill] ${pair.key}: signal price restatement skipped (${err instanceof Error ? err.message : String(err)}).`);
    }
    for (const t of repo.getRecentTrades(pair.key, 500)) {
      // A trade's entry is the flip OUT of the asset (sells, never recovered); its exit is the flip INTO it (buys).
      const entry = t.actualEntryPrice === undefined ? ratioByExec.get(flipExec(t.openedAt)?.id ?? "") : undefined;
      const exit = t.actualExitPrice === undefined && t.closedAt !== undefined ? ratioFor(flipExec(t.closedAt), t.closedAt) : undefined;
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
