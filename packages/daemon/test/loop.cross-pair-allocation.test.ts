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

// Proven shapes, reused verbatim from larssonRotation.test.ts / loop.resize.test.ts
// so this file introduces zero new untested candle magnitudes.
const STAYS_NAVY_CLOSES = new Array(100).fill(100); // never enters - flat baseline forever
const ENTRY_CLOSES = [...new Array(60).fill(100), ...linearRamp(100, 102, 40)]; // clean orange entry
const ENTRY_THEN_REVERSAL_CLOSES = [...ENTRY_CLOSES, ...linearRamp(102, 90, 30)]; // entry, then hard reversal -> exit

// Nothing held yet (pure BTC) - correct starting wallet for pairs that haven't
// entered anything. deriveBootstrapPosition (loop.ts) infers "long" from this
// on a pair's first tick regardless of regime, which is what we want here:
// currentPosition reflects the pre-tick state, decisionTarget reflects what
// this tick's Larsson replay decided to do about it.
const FRESH_BTC_ONLY_WALLET = [
  { walletType: "exchange", currency: "BTC", balance: 10, availableBalance: 10 },
  { walletType: "exchange", currency: "XAUT", balance: 0, availableBalance: 0 },
  { walletType: "exchange", currency: "XMR", balance: 0, availableBalance: 0 },
];

// Already holding meaningful balances on both sides - used for later ticks
// where positions are already established and we don't want any resize/exit
// zero-capped by capBtcCapitalToAvailableBalance (same fixture loop.resize.test.ts uses).
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
    getWallets: async () => wallets,
  } as unknown as BitfinexRestClient;
}

describe("cross-pair rotation & allocation (asymmetric regimes, daemon-level)", () => {
  let repo: Repo;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("PAPER");
  });

  it("allocates 100% to the gold pair and 0% to the blue pair when regimes diverge on the same tick", async () => {
    const client = clientForSymbols(
      { [XAUT_SYMBOL]: ENTRY_CLOSES, [XMR_SYMBOL]: STAYS_NAVY_CLOSES },
      FRESH_BTC_ONLY_WALLET
    );
    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });

    const xaut = results.find((r) => r.pairKey === "xaut")!;
    const xmr = results.find((r) => r.pairKey === "xmr")!;

    // Pre-tick state for both: nothing held yet (BTC-only wallet) -> "long".
    expect(xaut.currentPosition).toBe("long");
    expect(xaut.decisionTarget).toBe("flat"); // this tick's Larsson decision: rotate into XAUT
    expect(xaut.targetFraction).toBeCloseTo(1); // sized at 100%, not the static 50%
    expect(xaut.rotated).toBe(true);
    expect(repo.getAllocationFraction("xaut")).toBeCloseTo(1);

    expect(xmr.currentPosition).toBe("long");
    expect(xmr.decisionTarget).toBe("long"); // regime never turns orange, no entry
    expect(xmr.targetFraction).toBeCloseTo(0);
    expect(xmr.rotated).toBe(false);
  });

  it("keeps both pairs fully in BTC (0/0) when both regimes are blue - no capital misallocated to either", async () => {
    const client = clientForSymbols(
      { [XAUT_SYMBOL]: STAYS_NAVY_CLOSES, [XMR_SYMBOL]: STAYS_NAVY_CLOSES },
      FRESH_BTC_ONLY_WALLET
    );
    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    for (const r of results) {
      expect(r.currentPosition).toBe("long");
      expect(r.decisionTarget).toBe("long");
      expect(r.targetFraction).toBeCloseTo(0);
      expect(r.rotated).toBe(false);
    }
  });

  it("rebalances 50/50 -> 100/0 across ticks when one pair's own regime flips to blue: the flipping pair exits via ITS OWN decision, the other resizes up via the allocator", async () => {
    // Tick 0: a "settle" tick where both pairs stay navy (never enter) with a
    // BTC-only wallet - bootstrap infers "long" for both, which matches that
    // tick's own Larsson decision ("long", never entered), so there's no
    // decision/bootstrap conflict on this first tick. This sidesteps a real
    // quirk found while writing this test: observeAndDecide captures
    // `openTrade` BEFORE the bootstrap reconciliation backfill runs, so if
    // bootstrap corrects to "long" (writing a trade row) AND that same tick's
    // Larsson decision ALSO wants to immediately flip to "flat", the flip's
    // closeTrade call uses the stale pre-bootstrap `openTrade` (still
    // undefined) and never closes the just-backfilled row - leaving the DB
    // stuck thinking the pair is still long BTC on every later tick. Settling
    // first, then entering on a later tick (below), avoids that collision
    // entirely and lets this test isolate cross-pair allocation behavior
    // specifically. Flagging the underlying quirk back to you separately.
    const settleClient = clientForSymbols(
      { [XAUT_SYMBOL]: STAYS_NAVY_CLOSES, [XMR_SYMBOL]: STAYS_NAVY_CLOSES },
      FRESH_BTC_ONLY_WALLET
    );
    await runControlLoopIteration({ client: settleClient, repo, config: DEFAULT_STRATEGY_CONFIG });

    // Tick 1: both pairs enter orange together -> 50/50 (same shape proven in
    // loop.resize.test.ts, just appended after the settle prefix so history is continuous).
    const TICK1_ENTRY_CLOSES = [...STAYS_NAVY_CLOSES, ...linearRamp(100, 102, 40)];
    const tick1Client = clientForSymbols(
      { [XAUT_SYMBOL]: TICK1_ENTRY_CLOSES, [XMR_SYMBOL]: TICK1_ENTRY_CLOSES },
      ESTABLISHED_WALLET
    );
    const tick1 = await runControlLoopIteration({ client: tick1Client, repo, config: DEFAULT_STRATEGY_CONFIG });
    for (const r of tick1) {
      expect(r.targetFraction).toBeCloseTo(0.5);
      expect(r.decisionTarget).toBe("flat"); // both entering this tick
      expect(r.rotated).toBe(true);
    }

    // Tick 2: XAUT candles unchanged (still orange, no flip in its OWN decision
    // - pure Case 2 resize). XMR reverses hard through baseline (its OWN
    // Larsson decision flips flat -> long - Case 1 exit), same reversal shape
    // proven in larssonRotation.test.ts, appended after the same prefix.
    const TICK2_XMR_CLOSES = [...TICK1_ENTRY_CLOSES, ...linearRamp(102, 90, 30)];
    const tick2Client = clientForSymbols(
      { [XAUT_SYMBOL]: TICK1_ENTRY_CLOSES, [XMR_SYMBOL]: TICK2_XMR_CLOSES },
      ESTABLISHED_WALLET
    );
    const tick2 = await runControlLoopIteration({ client: tick2Client, repo, config: DEFAULT_STRATEGY_CONFIG });

    const xaut2 = tick2.find((r) => r.pairKey === "xaut")!;
    const xmr2 = tick2.find((r) => r.pairKey === "xmr")!;

    // XMR: own decision flipped flat -> long (exited on the regime reversal itself, not because of the allocator).
    expect(xmr2.decisionTarget).toBe("long");
    expect(xmr2.rotated).toBe(true);
    expect(xmr2.targetFraction).toBeCloseTo(0);
    expect(repo.getAllocationFraction("xmr")).toBeCloseTo(0);

    // XAUT: own decision did NOT flip (still flat/orange) - only the cross-pair
    // fraction moved (0.5 -> 1.0), so this must be the Case 2 resize path.
    expect(xaut2.decisionTarget).toBe("flat");
    expect(xaut2.currentPosition).toBe("flat");
    expect(xaut2.rotated).toBe(true); // resized up
    expect(xaut2.targetFraction).toBeCloseTo(1);
    expect(repo.getAllocationFraction("xaut")).toBeCloseTo(1);
  });

  it("falls back to each pair's static capitalFractionBtc (not cross-pair reallocation) when one pair's observe/decide step fails", async () => {
    const brokenClient: BitfinexRestClient = {
      getCandles: async (symbol: string) => {
        if (symbol === XMR_SYMBOL) throw new Error("simulated network failure fetching XMR candles");
        return makeCandles(ENTRY_CLOSES);
      },
      getBookDepth: async () => ({ timestamp: 0, symbol: XAUT_SYMBOL, bidDepth: 50, askDepth: 50 }),
      submitOrder: async () => ({ submitted: false, dryRun: true }),
      getWallets: async () => FRESH_BTC_ONLY_WALLET,
    } as unknown as BitfinexRestClient;

    const results = await runControlLoopIteration({ client: brokenClient, repo, config: DEFAULT_STRATEGY_CONFIG });

    const xaut = results.find((r) => r.pairKey === "xaut")!;
    const xmr = results.find((r) => r.pairKey === "xmr")!;

    expect(xmr.error).toBeDefined();
    // Cross-pair allocation requires BOTH pairs to have observed successfully
    // this tick - with XMR's observe/decide having thrown, XAUT must fall back
    // to its own static capitalFractionBtc (0.5), not be sized as if it had
    // the whole portfolio to itself.
    expect(xaut.targetFraction).toBeCloseTo(0.5);
  });
});
