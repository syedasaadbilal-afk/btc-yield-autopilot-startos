import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { executeRotation } from "../src/execute.js";

const XAUT_PAIR = DEFAULT_STRATEGY_CONFIG.pairs.find((p) => p.key === "xaut")!;

/**
 * Regression test for the live bug found Aug 2026: computeTrancheBtcAmounts
 * (packages/strategy/src/risk.ts) used to scale EVERY rotation's requested
 * btcCapital down by config.risk.riskFractionPerTrade (1.5%) before
 * tranching, even though callers already pass the exact full amount that
 * needs to move (a full position exit, a cross-pair resize delta, etc). That
 * silently shrunk every rotation to ~1.5% of what was requested, which then
 * routinely failed Bitfinex's real minimum order size - even for a full
 * exit that should be far above it.
 *
 * No prior test caught this because every other daemon-level test fixture
 * stubs getMinOrderSize to 0 (see loop.resize.test.ts /
 * loop.cross-pair-allocation.test.ts), which makes capClipCountToMinOrderSize
 * bypass the check entirely (`if (minOrderSize <= 0) return
 * requestedClipCount;`) regardless of how tiny the tranche amount actually
 * is. This test uses REALISTIC live numbers instead: a full ~0.0038 BTC
 * XAUT position (matching the live-reported stuck balance), Bitfinex's real
 * XAUT:BTC minimum order size (0.002 XAUT), and a realistic direct price
 * (~0.0637 BTC/XAUT, matching config.ts's own documented comment) - so a
 * regression of the 1.5% scaling bug would make this test fail with
 * totalBtcMoved === 0, the same as what happened live.
 */
function fakeClient(): BitfinexRestClient {
  const DIRECT_PRICE = 0.0637; // BTC per XAUT (config.ts's own documented real value)
  return {
    getCandles: async (symbol: string) => {
      const close =
        symbol === XAUT_PAIR.ratioSymbol ? DIRECT_PRICE : symbol === XAUT_PAIR.btcUsdtSymbol ? 100000 : 2800; // btc/usdt, xaut/usdt (irrelevant here since direct route should win)
      return [{ timestamp: 0, open: close, close, high: close, low: close, volume: 100 }];
    },
    getBookDepth: async () => ({ timestamp: 0, symbol: XAUT_PAIR.ratioSymbol, bidDepth: 5, askDepth: 5 }),
    submitOrder: async () => ({ submitted: false, dryRun: true }),
    // Bitfinex's real documented minimum for tXAUT:BTC.
    getMinOrderSize: async (symbol: string) => (symbol === XAUT_PAIR.ratioSymbol ? 0.002 : 0.0002),
    getWallets: async () => [
      { walletType: "exchange", currency: "BTC", balance: 0, availableBalance: 0 },
      // ~0.0038 BTC worth at DIRECT_PRICE - matches the live-reported stuck
      // full XAUT position.
      { walletType: "exchange", currency: "XAUT", balance: 0.0038 / DIRECT_PRICE, availableBalance: 0.0038 / DIRECT_PRICE },
      { walletType: "exchange", currency: "XMR", balance: 0, availableBalance: 0 },
    ],
  } as unknown as BitfinexRestClient;
}

describe("executeRotation - full-position exit against realistic Bitfinex minimums", () => {
  it("actually moves real capital on a full XAUT->BTC exit, not silently skipping every tranche", async () => {
    const client = fakeClient();
    const result = await executeRotation({
      client,
      side: "buy_btc_with_xaut", // exiting XAUT back into BTC
      btcCapital: 0.0038,
      pair: XAUT_PAIR,
      config: DEFAULT_STRATEGY_CONFIG,
    });

    // The core regression check: before the fix, totalBtcMoved was always 0
    // here (every tranche computed as ~1.5% of 0.0038 BTC, well under the
    // 0.002 XAUT minimum once converted and split into clips).
    expect(result.totalBtcMoved).toBeGreaterThan(0);
    // Should move close to the full requested capital (allowing for
    // depth-capped clip sizing), not a token sliver of it.
    expect(result.totalBtcMoved).toBeGreaterThan(0.0038 * 0.5);
    expect(result.routeDecisions.some((rd) => rd.route !== "none")).toBe(true);
  });
});
