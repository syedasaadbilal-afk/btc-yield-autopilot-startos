import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";
import { runControlLoopIteration } from "../src/loop.js";

const XAUT_SYMBOL = "tXAUT:BTC";
const XMR_SYMBOL = "tXMRBTC";

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

/**
 * Regression test for "BTC balance not deploying despite both pairs on
 * target" (bug found live Aug 2026, round 6): the idle/top-up sweep used to
 * only recognize two allocation shapes - exact 50/50 dual-gold and exact
 * 100/0 single-gold. A manual override split that is neither (e.g. the
 * operator setting XAUT 45% / XMR 55% from the Config tab, exactly as
 * reported live) matched neither shape, so idle BTC sitting in the wallet
 * was silently never routed to either pair - forever, every tick, for as
 * long as the override stayed active. Confirms that with a 45/55 override
 * and both pairs already flat/on-target, idle BTC beyond the dust threshold
 * gets swept into the more underweight pair (XAUT here, holding far less
 * than its 45% target).
 */
describe("idle top-up routing under a non-50/50, non-100/0 allocation override", () => {
  let repo: Repo;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("LIVE");
  });

  it("routes idle BTC to the pair furthest below its own override target, not just exact 50/50 or 100/0", async () => {
    const client: BitfinexRestClient = {
      getCandles: async (symbol: string) => {
        if (symbol === XAUT_SYMBOL) return makeCandles(orangeFlatCloses(102));
        if (symbol === XMR_SYMBOL) return makeCandles(orangeFlatCloses(102));
        return makeCandles(new Array(100).fill(100));
      },
      getBookDepth: async (symbol: string) => ({ timestamp: 0, symbol, bidDepth: 50, askDepth: 50 }),
      submitOrder: async () => ({ submitted: false, dryRun: true }),
      getMinOrderSize: async () => 0,
      getWallets: async () => [
        // Meaningful idle BTC beyond any plausible dust threshold.
        { walletType: "exchange", currency: "BTC", balance: 1, availableBalance: 1 },
        // XAUT holds a small, but non-dust, position - clearly underweight
        // relative to a 45% target once the pooled idle BTC is counted.
        { walletType: "exchange", currency: "XAUT", balance: 2, availableBalance: 2 },
        // XMR already holds a much larger position - at/above its 55% target.
        { walletType: "exchange", currency: "XMR", balance: 6, availableBalance: 6 },
      ],
    } as unknown as BitfinexRestClient;

    // Both pairs already gold/flat and their applied fractions already match
    // the override exactly, so this tick takes the idle-top-up branch
    // (Case 2b), not a resize (Case 2a) - isolates the bug from any resize
    // path.
    repo.setAllocationOverride(true, 0.45);
    repo.setAllocationFraction("xaut", 0.45);
    repo.setAllocationFraction("xmr", 0.55);

    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    const xaut = results.find((r) => r.pairKey === "xaut")!;
    const xmr = results.find((r) => r.pairKey === "xmr")!;

    expect(xaut.currentPosition).toBe("flat");
    expect(xmr.currentPosition).toBe("flat");

    // The actual bug: before the fix, neither pair ever received the idle
    // BTC under a 45/55 override - both would read rotated: false here.
    expect(xaut.rotated).toBe(true);
    expect(xmr.rotated).toBe(false);

    const executionLog = repo.getRecentExecutions("xaut", 10);
    const topup = executionLog.find((e) => e.kind === "topup");
    expect(topup).toBeDefined();
    expect(topup!.status).toBe("executed");
    expect(topup!.movedBtc).toBeGreaterThan(0);
  });

  /**
   * Round 8 (live Oct 2026): XAUT's regime said BTC while XMR was underweight.
   * The old sweep assigned ALL idle BTC to XAUT (largest deficit, but it can't
   * deploy while in BTC), so 0.043 BTC sat idle with XMR at 37% vs a 55%
   * target. It also deployed the full idle amount rather than just the
   * deficit, overshooting the target (0.15 BTC top-up trimmed back a day later).
   */
  it("skips a pair whose regime says BTC and caps the top-up at the receiving pair's deficit", async () => {
    const client: BitfinexRestClient = {
      getCandles: async (symbol: string) =>
        symbol === XAUT_SYMBOL ? makeCandles(new Array(100).fill(100)) : makeCandles(orangeFlatCloses(102)),
      getBookDepth: async (symbol: string) => ({ timestamp: 0, symbol, bidDepth: 50, askDepth: 50 }),
      submitOrder: async () => ({ submitted: false, dryRun: true }),
      getMinOrderSize: async () => 0,
      getWallets: async () => [
        { walletType: "exchange", currency: "BTC", balance: 100, availableBalance: 100 },
        { walletType: "exchange", currency: "XAUT", balance: 0, availableBalance: 0 },
        { walletType: "exchange", currency: "XMR", balance: 1, availableBalance: 1 },
      ],
    } as unknown as BitfinexRestClient;

    repo.setAllocationOverride(true, 0.45);
    repo.setAllocationFraction("xaut", 0.45);
    repo.setAllocationFraction("xmr", 0.55);

    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    const xaut = results.find((r) => r.pairKey === "xaut")!;
    const xmr = results.find((r) => r.pairKey === "xmr")!;

    expect(xaut.rotated).toBe(false);
    expect(xmr.rotated).toBe(true);

    const topup = repo.getRecentExecutions("xmr", 10).find((e) => e.kind === "topup");
    expect(topup).toBeDefined();
    // Deficit is ~9 BTC of 100 idle; must not deploy the whole 100.
    expect(topup!.requestedBtc).toBeGreaterThan(0);
    expect(topup!.requestedBtc).toBeLessThan(20);
  });
});
