import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";
import { runControlLoopIteration } from "../src/loop.js";

const XAUT_SYMBOL = "tXAUT:BTC";
const XMR_SYMBOL = "tXMRBTC";

// Real numbers lifted straight from the live-bug fix comment in loop.ts's
// deriveBootstrapPosition (found live Aug 2026): XAUT genuinely held
// 0.05626682 XAUT, worth 0.00383188 BTC at the time. Using the exact live
// figures (not abstract round numbers) so this dry run reproduces the
// actual reported scenario, not just a plausible-looking stand-in.
const XAUT_BALANCE = 0.05626682;
const DIRECT_PRICE = 0.00383188 / XAUT_BALANCE; // ~0.068113 BTC per XAUT

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

// Same proven "already established gold position" shape used throughout the
// existing suite (60 flat + 40-candle ramp that crosses into orange/flat
// well before the last candle), just rescaled to XAUT's real BTC-per-asset
// magnitude instead of the abstract "100" test fixtures use elsewhere - the
// absolute price level matters here because directPrice/wallet valuation
// depend on it, not just the regime engine's relative reading of it.
const XAUT_ALREADY_GOLD_CLOSES = [
  ...new Array(60).fill(DIRECT_PRICE),
  ...linearRamp(DIRECT_PRICE, DIRECT_PRICE * 1.02, 40),
];
// XMR never enters - stays navy/BTC the whole time, matching the live report
// ("keep fully balance in BTC till XMR is overextended in gold flip").
const XMR_STAYS_NAVY_CLOSES = new Array(100).fill(0.00075);

function liveWallet() {
  return [
    // A dust-sized (not literally zero) BTC balance - deriveBootstrapPosition
    // treats "BTC=0 AND asset=0" as ambiguous and falls back to the DB
    // default rather than inferring "long"; a real pooled wallet is never
    // literally 0 BTC, so this avoids a test-fixture-only edge case without
    // being large enough to trip the idle-top-up dust threshold either.
    { walletType: "exchange", currency: "BTC", balance: 1e-7, availableBalance: 1e-7 },
    { walletType: "exchange", currency: "XAUT", balance: XAUT_BALANCE, availableBalance: XAUT_BALANCE },
    { walletType: "exchange", currency: "XMR", balance: 0, availableBalance: 0 },
  ];
}

function realisticClient(): BitfinexRestClient {
  return {
    getCandles: async (symbol: string) => {
      if (symbol === XAUT_SYMBOL) return makeCandles(XAUT_ALREADY_GOLD_CLOSES);
      if (symbol === XMR_SYMBOL) return makeCandles(XMR_STAYS_NAVY_CLOSES);
      if (symbol === "tBTCUST") return makeCandles(new Array(100).fill(100000));
      if (symbol === "tXAUT:UST") return makeCandles(new Array(100).fill(100000 * DIRECT_PRICE));
      return makeCandles(new Array(100).fill(75)); // tXMRUST
    },
    getBookDepth: async (symbol: string) => ({ timestamp: 0, symbol, bidDepth: 10, askDepth: 10 }),
    submitOrder: async () => ({ submitted: false, dryRun: true }),
    // Real Bitfinex minimums - NOT stubbed to 0 like every other test fixture
    // in this suite. That stubbing is exactly why the 1.5%-scaling bug (task
    // #102) went undetected for so long: capClipCountToMinOrderSize
    // short-circuits to "always fine" whenever minOrderSize <= 0, regardless
    // of how tiny the computed tranche actually is.
    getMinOrderSize: async (symbol: string) => (symbol === XAUT_SYMBOL ? 0.002 : symbol === XMR_SYMBOL ? 0.02 : 0.0002),
    getWallets: async () => liveWallet(),
  } as unknown as BitfinexRestClient;
}

describe("live-scenario dry run (reproduces the exact Aug 2026 live bug report)", () => {
  let repo: Repo;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("PAPER");
  });

  it("tick 1: establishes the real XAUT gold position as a NAV/allocation baseline, no override yet", async () => {
    const client = realisticClient();
    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    const xaut = results.find((r) => r.pairKey === "xaut")!;
    const xmr = results.find((r) => r.pairKey === "xmr")!;

    expect(xaut.currentPosition).toBe("flat"); // holding XAUT, matches real wallet
    expect(xaut.decisionTarget).toBe("flat"); // Larsson agrees - no flip, already-established position
    expect(xaut.targetFraction).toBeCloseTo(1); // single-gold state: XAUT regime orange, XMR not
    expect(repo.getAllocationFraction("xaut")).toBeCloseTo(1);

    expect(xmr.currentPosition).toBe("long"); // holding BTC, matches real wallet (0 XMR)
    expect(xmr.decisionTarget).toBe("long");
    expect(xmr.targetFraction).toBeCloseTo(0);

    const xautNav = repo.getLatestNavPoint("xaut")!;
    expect(xautNav.xautHeld).toBeCloseTo(XAUT_BALANCE, 3);
  });

  it("tick 2: flipping the allocation override to XMR=100% actually exits XAUT for real - the exact bug reported live", async () => {
    const client = realisticClient();
    await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG }); // tick 1, establishes baseline

    // This is the operator action the user actually took live: set the
    // Config-tab override to XMR=100% / XAUT=0%.
    repo.setAllocationOverride(true, 0);

    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    const xaut = results.find((r) => r.pairKey === "xaut")!;
    const xmr = results.find((r) => r.pairKey === "xmr")!;

    // XAUT's OWN regime hasn't changed (still orange/gold) - this must be a
    // Case 2a resize (allocator-driven), not a Case 1 flip.
    expect(xaut.currentPosition).toBe("flat");
    expect(xaut.decisionTarget).toBe("flat");
    expect(xaut.targetFraction).toBeCloseTo(0); // override now says 0%

    // The actual bug: before the #102/#103 fix, this resize's tranches were
    // scaled to ~1.5% of the real 0.00383188 BTC delta, which then failed
    // Bitfinex's real 0.002 XAUT minimum on every route - rotated stayed
    // false and getAllocationFraction stayed at 1 (never applied). With the
    // fix, the resize should actually execute.
    expect(xaut.rotated).toBe(true);
    expect(repo.getAllocationFraction("xaut")).toBeCloseTo(0);

    // Real capital actually left the XAUT position - not just bookkeeping.
    const xautNav = repo.getLatestNavPoint("xaut")!;
    expect(xautNav.xautHeld).toBeLessThan(XAUT_BALANCE * 0.05); // down from ~0.0563 to near-zero (small buffer dust allowed)

    // XMR: still "long" BTC by its own regime (never turned orange) - the
    // override only sizes a pair that's currently eligible to hold its
    // asset, so XMR correctly does NOT get bought into here. This is the
    // exact "keep fully balance in BTC till XMR is overextended in gold
    // flip" behavior the user described as correct/expected.
    expect(xmr.currentPosition).toBe("long");
    expect(xmr.decisionTarget).toBe("long");
    expect(xmr.rotated).toBe(false);
  });
});
