import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";
import { backfillExecutionFills } from "../src/backfill.js";

describe("backfillExecutionFills", () => {
  it("fills order summaries and trade actual prices from order history, and is idempotent", async () => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    const repo = new Repo(db);
    const pair = DEFAULT_STRATEGY_CONFIG.pairs.find((p) => p.key === "xmr")!;
    const t0 = 1_000_000_000_000;
    // Exit (opens a BTC-holding trade) then re-entry (closes it).
    repo.insertExecutionLog({ id: `xmr-${t0}-flip`, pairKey: "xmr", timestamp: t0, kind: "flip_exit", side: "buy_btc_with_xaut", requestedBtc: 1, movedBtc: 1, status: "executed", routes: "usdt" });
    repo.insertExecutionLog({ id: `xmr-${t0 + 86_400_000}-flip`, pairKey: "xmr", timestamp: t0 + 86_400_000, kind: "flip_entry", side: "sell_btc_for_xaut", requestedBtc: 1, movedBtc: 1, status: "executed", routes: "usdt" });
    // A blocked dust top-up that the migration cleanup would have removed (inserted directly to prove backfill ignores it).
    repo.insertTrade({ id: `xmr-${t0}`, runMode: "LIVE", pairKey: "xmr", openedAt: t0, targetPosition: "long", btcCapitalAtOpen: 1, riskFractionOfCapital: 0.01, stopLossRatio: 0, firstTargetRatio: 0, entryPrice: 150, status: "open", trancheExecutionPlanIds: [] });
    repo.closeTrade(`xmr-${t0}`, "closed_win", 0.1, 140, t0 + 86_400_000);

    const hist: Record<string, Array<{ id: string; createdAt: number; side: "buy" | "sell"; filled: number; avgPrice: number }>> = {
      [pair.assetUsdtSymbol]: [
        { id: "1", createdAt: t0 + 1000, side: "sell", filled: 10, avgPrice: 300 },
        { id: "2", createdAt: t0 + 86_400_000 + 1000, side: "buy", filled: 5, avgPrice: 280 },
        { id: "3", createdAt: t0 + 86_400_000 + 2000, side: "buy", filled: 5, avgPrice: 282 },
      ],
      [pair.btcUsdtSymbol]: [
        { id: "9", createdAt: t0 + 1500, side: "buy", filled: 0.03, avgPrice: 100_000 },
        { id: "10", createdAt: t0 + 86_400_000 + 1500, side: "sell", filled: 0.03, avgPrice: 98_000 },
      ],
    };
    const client = { getOrderHistory: async (sym: string, a: number, b: number) => (hist[sym] ?? []).filter((o) => o.createdAt >= a && o.createdAt <= b) } as unknown as BitfinexRestClient;

    const r = await backfillExecutionFills({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    expect(r.executionsUpdated).toBe(2);
    const rows = repo.getRecentExecutions("xmr", 10);
    const entry = rows.find((x) => x.kind === "flip_entry")!;
    expect(entry.orderCount).toBe(2);
    expect(entry.assetAmount).toBeCloseTo(10);
    expect(entry.avgPrice).toBeCloseTo((5 * 280 + 5 * 282) / 10);
    const exit = rows.find((x) => x.kind === "flip_exit")!;
    expect(exit.orderCount).toBe(1);

    const trade = repo.getRecentTrades("xmr", 5)[0]!;
    expect(trade.actualEntryPrice).toBeCloseTo(100_000 / 300);
    expect(trade.actualExitPrice).toBeCloseTo(98_000 / 281);

    // Re-running must not touch already-filled rows.
    const again = await backfillExecutionFills({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    expect(again.executionsUpdated).toBe(0);
  });
});
