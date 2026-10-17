import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";
import { backfillExecutionFills } from "../src/backfill.js";

describe("backfillExecutionFills", () => {
  it("fills order summaries and trade actual prices from order history, and is deterministic", async () => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    const repo = new Repo(db);
    const pair = DEFAULT_STRATEGY_CONFIG.pairs.find((p) => p.key === "xmr")!;
    const t0 = Date.UTC(2026, 8, 1, 12, 0, 0);
    // Exit (opens a BTC-holding trade) then re-entry (closes it).
    repo.insertExecutionLog({ id: `xmr-${t0}-flip`, pairKey: "xmr", timestamp: t0, kind: "flip_exit", side: "buy_btc_with_xaut", requestedBtc: 0.03, movedBtc: 0.03, status: "executed", routes: "usdt" });
    repo.insertExecutionLog({ id: `xmr-${t0 + 86_400_000}-flip`, pairKey: "xmr", timestamp: t0 + 86_400_000, kind: "flip_entry", side: "sell_btc_for_xaut", requestedBtc: 0.0287, movedBtc: 0.0287, status: "executed", routes: "usdt" });
    // A blocked dust top-up that the migration cleanup would have removed (inserted directly to prove backfill ignores it).
    repo.insertTrade({ id: `xmr-${t0}`, runMode: "LIVE", pairKey: "xmr", openedAt: t0, targetPosition: "long", btcCapitalAtOpen: 1, riskFractionOfCapital: 0.01, stopLossRatio: 0, firstTargetRatio: 0, entryPrice: 150, status: "open", trancheExecutionPlanIds: [] });
    repo.closeTrade(`xmr-${t0}`, "closed_win", 0.1, 140, t0 + 86_400_000);

    const hist: Record<string, Array<{ orderId: string; firstAt: number; side: "buy" | "sell"; filled: number; avgPrice: number }>> = {
      [pair.assetUsdtSymbol]: [
        { orderId: "1", firstAt: t0 + 1000, side: "sell", filled: 10, avgPrice: 300 },
        { orderId: "2", firstAt: t0 + 86_400_000 + 1000, side: "buy", filled: 5, avgPrice: 280 },
        { orderId: "3", firstAt: t0 + 86_400_000 + 2000, side: "buy", filled: 5, avgPrice: 282 },
      ],
      [pair.btcUsdtSymbol]: [
        { orderId: "9", firstAt: t0 + 1500, side: "buy", filled: 0.03, avgPrice: 100_000 },
        { orderId: "10", firstAt: t0 + 86_400_000 + 1500, side: "sell", filled: 0.03, avgPrice: 98_000 },
      ],
    };
    // BTC/USDT 1m candles: 100k around the exit, 98k around the re-entry a day later.
    const candleAt = (t: number, px: number) => ({ timestamp: t, open: px, close: px, high: px, low: px, volume: 1 });
    const allCandles = [candleAt(t0, 100_000), candleAt(t0 + 86_400_000, 98_000)];
    const client = {
      getTradeFills: async (sym: string) => hist[sym] ?? [],
      getCandlesBetween: async (_s: string, _tf: string, a: number, b: number) => allCandles.filter((c) => c.timestamp >= a - 3_600_000 && c.timestamp <= b),
    } as unknown as BitfinexRestClient;

    const r = await backfillExecutionFills({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    expect(r.executionsUpdated).toBe(2);
    const rows = repo.getRecentExecutions("xmr", 10);
    const entry = rows.find((x) => x.kind === "flip_entry")!;
    expect(entry.orderCount).toBe(2);
    expect(entry.assetAmount).toBeCloseTo(10);
    expect(entry.avgPrice).toBeCloseTo((5 * 280 + 5 * 282) / 10);
    const exit = rows.find((x) => x.kind === "flip_exit")!;
    expect(exit.orderCount).toBe(1);
    expect(entry.avgPriceBtc).toBeCloseTo(2810 / 98_000 / 10); // BTC per asset unit, converted per fill
    expect(exit.avgPriceBtc).toBeCloseTo(300 / 100_000);

    const trade = repo.getRecentTrades("xmr", 5)[0]!;
    expect(trade.actualEntryPrice).toBeCloseTo(100_000 / 300);
    expect(trade.actualExitPrice).toBeCloseTo(98_000 / 281);

    // Re-running rebuilds deterministically (the boot job itself only runs once).
    const again = await backfillExecutionFills({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    expect(again.executionsUpdated).toBe(2);
    expect(repo.getRecentExecutions("xmr", 10).find((x) => x.kind === "flip_entry")!.orderCount).toBe(2);
  });

  it("refuses to attribute orders whose USDT value is wildly different from what the log says moved", async () => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    const repo = new Repo(db);
    const pair = DEFAULT_STRATEGY_CONFIG.pairs.find((p) => p.key === "xmr")!;
    const t0 = Date.UTC(2026, 9, 8, 6, 20, 0);
    repo.insertExecutionLog({ id: `xmr-${t0}-topup`, pairKey: "xmr", timestamp: t0, kind: "topup", side: "sell_btc_for_xaut", requestedBtc: 0.000151, movedBtc: 0.000149, status: "executed", routes: "usdt" });
    const hist = {
      [pair.assetUsdtSymbol]: [{ orderId: "1", firstAt: t0 + 1000, side: "buy" as const, filled: 110, avgPrice: 560 }],
      [pair.btcUsdtSymbol]: [{ orderId: "2", firstAt: t0 + 1000, side: "sell" as const, filled: 0.7, avgPrice: 82_000 }],
    } as Record<string, Array<{ orderId: string; firstAt: number; side: "buy" | "sell"; filled: number; avgPrice: number }>>;
    const client = {
      getTradeFills: async (sym: string) => hist[sym] ?? [],
      getCandlesBetween: async () => [{ timestamp: t0, open: 82_000, close: 82_000, high: 82_000, low: 82_000, volume: 1 }],
    } as unknown as BitfinexRestClient;
    const r = await backfillExecutionFills({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    expect(r.executionsUpdated).toBe(0);
    expect(repo.getRecentExecutions("xmr", 5)[0]!.orderCount).toBeUndefined();
  });
});

describe("per-fill BTC conversion", () => {
  it("converts each order at the BTC price of its own moment, not one window average", async () => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    const repo = new Repo(db);
    const pair = DEFAULT_STRATEGY_CONFIG.pairs.find((p) => p.key === "xmr")!;
    const t0 = Date.UTC(2026, 8, 28, 4, 59, 0);
    repo.insertExecutionLog({ id: `xmr-${t0}-flip`, pairKey: "xmr", timestamp: t0, kind: "flip_entry", side: "sell_btc_for_xaut", requestedBtc: 0.0286, movedBtc: 0.0286, status: "executed", routes: "usdt" });
    const hist = {
      [pair.assetUsdtSymbol]: [
        { orderId: "1", firstAt: t0 + 10_000, side: "buy" as const, filled: 5, avgPrice: 300 },
        { orderId: "2", firstAt: t0 + 20 * 60_000, side: "buy" as const, filled: 5, avgPrice: 300 },
      ],
    } as Record<string, Array<{ orderId: string; firstAt: number; side: "buy" | "sell"; filled: number; avgPrice: number }>>;
    // BTC moves from 100k to 110k between the two fills.
    const candles = [
      { timestamp: t0, open: 100_000, close: 100_000, high: 100_000, low: 100_000, volume: 1 },
      { timestamp: t0 + 20 * 60_000, open: 110_000, close: 110_000, high: 110_000, low: 110_000, volume: 1 },
    ];
    const client = { getTradeFills: async (sym: string) => hist[sym] ?? [], getCandlesBetween: async () => candles } as unknown as BitfinexRestClient;
    await backfillExecutionFills({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    const row = repo.getRecentExecutions("xmr", 5)[0]!;
    const expectedBtc = (5 * 300) / 100_000 + (5 * 300) / 110_000; // 0.015 + 0.013636
    expect(row.avgPriceBtc).toBeCloseTo(expectedBtc / 10, 8);
  });
});
