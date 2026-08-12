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

// Same proven shapes as loop.cross-pair-allocation.test.ts.
const STAYS_NAVY_CLOSES = new Array(100).fill(100);

const FRESH_BTC_ONLY_WALLET = [
  { walletType: "exchange", currency: "BTC", balance: 10, availableBalance: 10 },
  { walletType: "exchange", currency: "XAUT", balance: 0, availableBalance: 0 },
  { walletType: "exchange", currency: "XMR", balance: 0, availableBalance: 0 },
];
const ESTABLISHED_WALLET = [
  { walletType: "exchange", currency: "BTC", balance: 10, availableBalance: 10 },
  { walletType: "exchange", currency: "XAUT", balance: 1000, availableBalance: 1000 },
  { walletType: "exchange", currency: "XMR", balance: 1000, availableBalance: 1000 },
];

function clientForSymbols(closesBySymbol: Record<string, number[]>, wallets = ESTABLISHED_WALLET): BitfinexRestClient {
  return {
    getCandles: async (symbol: string) => makeCandles(closesBySymbol[symbol] ?? closesBySymbol[XAUT_SYMBOL]!),
    getBookDepth: async () => ({ timestamp: 0, symbol: XAUT_SYMBOL, bidDepth: 50, askDepth: 50 }),
    submitOrder: async () => ({ submitted: false, dryRun: true }),
    getMinOrderSize: async () => 0,
    getWallets: async () => wallets,
  } as unknown as BitfinexRestClient;
}

/**
 * Regression test for the "these % make no sense" bug found live Aug 2026
 * (round 3): a pair's "funded" cost-basis baseline used to be frozen forever
 * at its very first-ever NAV point, so a deliberate cross-pair capital
 * reallocation (manual override, or a regime-driven split change) got
 * counted as trading loss/gain against the stale baseline. Confirms
 * funding_baseline resets exactly when a pair's target fraction actually
 * changes, and stays untouched on an ordinary tick where it doesn't.
 */
describe("funding baseline reset on real cross-pair reallocation", () => {
  let repo: Repo;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("PAPER");
  });

  it("resets when a pair's target fraction changes, and stays fixed across a tick where it doesn't", async () => {
    // Settle tick: both blue, BTC-only wallet - clean bootstrap, no entries yet.
    const settleClient = clientForSymbols(
      { [XAUT_SYMBOL]: STAYS_NAVY_CLOSES, [XMR_SYMBOL]: STAYS_NAVY_CLOSES },
      FRESH_BTC_ONLY_WALLET
    );
    await runControlLoopIteration({ client: settleClient, repo, config: DEFAULT_STRATEGY_CONFIG });

    // Tick 1: both pairs enter orange together -> 50/50 dual-gold split.
    const TICK1_ENTRY_CLOSES = [...STAYS_NAVY_CLOSES, ...linearRamp(100, 102, 40)];
    const tick1Client = clientForSymbols(
      { [XAUT_SYMBOL]: TICK1_ENTRY_CLOSES, [XMR_SYMBOL]: TICK1_ENTRY_CLOSES },
      ESTABLISHED_WALLET
    );
    const tick1 = await runControlLoopIteration({ client: tick1Client, repo, config: DEFAULT_STRATEGY_CONFIG });
    expect(tick1.find((r) => r.pairKey === "xaut")!.targetFraction).toBeCloseTo(0.5);

    const baselineAfterTick1 = repo.getFundingBaseline("xaut");
    expect(baselineAfterTick1).toBeDefined();
    expect(baselineAfterTick1!.targetFractionAtSet).toBeCloseTo(0.5);
    const navAfterTick1 = baselineAfterTick1!.btcEquivalentNav;

    // Tick 2 (same closes, nothing changes): an ordinary re-evaluation where
    // the target fraction stays 0.5 - baseline must NOT move.
    const tick2 = await runControlLoopIteration({ client: tick1Client, repo, config: DEFAULT_STRATEGY_CONFIG });
    expect(tick2.find((r) => r.pairKey === "xaut")!.targetFraction).toBeCloseTo(0.5);
    const baselineAfterTick2 = repo.getFundingBaseline("xaut");
    expect(baselineAfterTick2!.btcEquivalentNav).toBeCloseTo(navAfterTick1);
    expect(baselineAfterTick2!.setAt).toBe(baselineAfterTick1!.setAt);

    // Tick 3: XMR's OWN regime reverses hard and exits -> cross-pair
    // allocation collapses to XAUT 100% / XMR 0%. XAUT's own decision didn't
    // flip - this is a pure Case 2 resize, exactly the "moved capital
    // between pairs on purpose" scenario the bug report was about.
    const TICK3_XMR_CLOSES = [...TICK1_ENTRY_CLOSES, ...linearRamp(102, 90, 30)];
    const tick3Client = clientForSymbols(
      { [XAUT_SYMBOL]: TICK1_ENTRY_CLOSES, [XMR_SYMBOL]: TICK3_XMR_CLOSES },
      ESTABLISHED_WALLET
    );
    const tick3 = await runControlLoopIteration({ client: tick3Client, repo, config: DEFAULT_STRATEGY_CONFIG });
    const xaut3 = tick3.find((r) => r.pairKey === "xaut")!;
    expect(xaut3.targetFraction).toBeCloseTo(1);
    expect(xaut3.rotated).toBe(true);

    const baselineAfterTick3 = repo.getFundingBaseline("xaut");
    expect(baselineAfterTick3!.targetFractionAtSet).toBeCloseTo(1);
    // Real reallocation happened - baseline must have moved off tick 1's
    // frozen value (this is exactly what stayed broken before the fix).
    expect(baselineAfterTick3!.setAt).not.toBe(baselineAfterTick1!.setAt);
  });
});
