import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";
import { runControlLoopIteration } from "../src/loop.js";

function makeCandles(closes: number[]) {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2024, 0, 1);
  return closes.map((close, i) => ({
    timestamp: start + i * dayMs,
    open: i === 0 ? close : closes[i - 1]!,
    close,
    high: close * 1.001,
    low: close * 0.999,
    volume: 100,
  }));
}

function linearRamp(start: number, end: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + ((end - start) * i) / (n - 1));
}

function orangeFlatCloses(finalRampEnd: number): number[] {
  return [...new Array(60).fill(100), ...linearRamp(100, finalRampEnd, 40)];
}

function clientWithXautBalance(closes: number[], xautBalance: number): BitfinexRestClient {
  return {
    getCandles: async () => makeCandles(closes),
    getBookDepth: async () => ({ timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 50, askDepth: 50 }),
    submitOrder: async () => ({ submitted: false, dryRun: true }),
    getMinOrderSize: async () => 0,
    getWallets: async () => [
      { walletType: "exchange", currency: "BTC", balance: 10, availableBalance: 10 },
      { walletType: "exchange", currency: "XAUT", balance: xautBalance, availableBalance: xautBalance },
      { walletType: "exchange", currency: "XMR", balance: 1000, availableBalance: 1000 },
    ],
  } as unknown as BitfinexRestClient;
}

/**
 * Regression test for "new deposit not being recognized" (bug found live Aug
 * 2026, round 4): a manual deposit landing directly in a flat pair's asset
 * wallet - not via a daemon-executed trade - used to be invisible to the
 * internal NAV ledger forever, since the non-rotating-tick NAV path just
 * carried forward the previous tick's asset-unit count unchanged. Confirms
 * the very next tick after a deposit (with no rotation/resize involved at
 * all) picks up the new real balance.
 */
describe("deposit recognition (no rotation involved)", () => {
  let repo: Repo;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("PAPER");
  });

  it("picks up a deposit into an already-flat pair's wallet on the very next tick, with no trade involved", async () => {
    const closes = orangeFlatCloses(102);
    const tick1 = await runControlLoopIteration({
      client: clientWithXautBalance(closes, 1000),
      repo,
      config: DEFAULT_STRATEGY_CONFIG,
    });
    const xaut1 = tick1.find((r) => r.pairKey === "xaut")!;
    expect(xaut1.currentPosition).toBe("flat");
    const navAfterTick1 = repo.getLatestNavPoint("xaut")!;
    expect(navAfterTick1.xautHeld).toBeCloseTo(1000, 0);

    // Same closes (target fraction unchanged, no regime shift, no resize
    // trigger) - only the wallet balance grew, simulating a manual deposit.
    const tick2 = await runControlLoopIteration({
      client: clientWithXautBalance(closes, 1500),
      repo,
      config: DEFAULT_STRATEGY_CONFIG,
    });
    const xaut2 = tick2.find((r) => r.pairKey === "xaut")!;
    // The deposit alone must not be mistaken for a rotation/resize.
    expect(xaut2.rotated).toBe(false);

    const navAfterTick2 = repo.getLatestNavPoint("xaut")!;
    expect(navAfterTick2.xautHeld).toBeCloseTo(1500, 0);
    expect(navAfterTick2.btcEquivalentNav).toBeGreaterThan(navAfterTick1.btcEquivalentNav);
  });
});
