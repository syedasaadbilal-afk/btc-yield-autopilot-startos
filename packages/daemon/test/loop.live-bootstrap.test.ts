import { describe, expect, it, beforeEach, vi } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";
import { runControlLoopIteration } from "../src/loop.js";

/**
 * Reproduces and verifies the fix for the bug this session chased for a
 * while in production: a DRY_RUN/PAPER "trade" is simulated (never actually
 * reaches the exchange - see execute.ts) but gets written into the same
 * trades/openTrade bookkeeping LIVE mode reads as ground truth. Before the
 * fix, switching to LIVE never re-verified against the real wallet once any
 * position already existed in the DB, so the daemon silently did nothing
 * while the real wallet sat unrotated (the "full balance still sits in gold
 * despite multiple decision runs" report).
 */

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

// A strong, sustained uptrend - confirmed elsewhere in this suite (see
// loop.test.ts's "always inserts a decision row" case) to make the Larsson
// replay settle on position "long" (i.e. rotated into BTC, out of the
// asset - this codebase's position naming, not a market direction call).
const LONG_TRIGGERING_CLOSES = linearRamp(100, 400, 260);

/**
 * Wallet is 100% in the rotation asset (XAUT/XMR) and 0 BTC - i.e. the real
 * exchange never moved, regardless of what the DB's trades table claims.
 * getWallets is a vi.fn() so tests can assert exactly when it is (and isn't)
 * called.
 */
function makeFlatWalletClient(closes: number[]) {
  const getWallets = vi.fn(async () => [
    { walletType: "exchange", currency: "BTC", balance: 0, availableBalance: 0 },
    { walletType: "exchange", currency: "XAUT", balance: 1000, availableBalance: 1000 },
    { walletType: "exchange", currency: "XMR", balance: 1000, availableBalance: 1000 },
  ]);
  const client = {
    getCandles: async () => makeCandles(closes),
    getBookDepth: async () => ({ timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 50, askDepth: 50 }),
    submitOrder: async () => ({ submitted: false, dryRun: true }),
    getWallets,
  } as unknown as BitfinexRestClient;
  return { client, getWallets };
}

describe("LIVE-mode bootstrap trust bug (repo.hasLiveTrade / needsLiveBootstrapCheck)", () => {
  let repo: Repo;
  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
  });

  it("reconciles a stale PAPER-simulated position against the real wallet on the first LIVE tick, and actually executes the correction", async () => {
    repo.setRunMode("PAPER");
    const { client } = makeFlatWalletClient(LONG_TRIGGERING_CLOSES);

    // Tick 1 (PAPER): wallet is flat/asset-only, decision fires "long" ->
    // PAPER simulates an entry (writes an open trade) without ever touching
    // the real exchange.
    const tick1 = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    const xmr1 = tick1.find((r) => r.pairKey === "xmr")!;
    expect(xmr1.currentPosition).toBe("flat");
    expect(xmr1.decisionTarget).toBe("long");
    expect(xmr1.rotated).toBe(true);
    const paperTrade = repo.getOpenTrade("xmr");
    expect(paperTrade?.runMode).toBe("PAPER");
    expect(repo.hasLiveTrade("xmr")).toBe(false);

    // Switch to LIVE. Wallet is unchanged (still 100% asset, 0 BTC) because
    // the PAPER trade never actually filled.
    repo.setRunMode("LIVE");
    const tick2 = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    const xmr2 = tick2.find((r) => r.pairKey === "xmr")!;

    // Before the fix: currentPosition would trust the DB ("long"), match
    // decision.target ("long"), and rotated would be false - a silent no-op
    // even though the real wallet never moved. After the fix: the real
    // wallet is re-checked, currentPosition comes back "flat", disagrees
    // with decision.target ("long"), and a real rotation fires this tick.
    expect(xmr2.currentPosition).toBe("flat");
    expect(xmr2.decisionTarget).toBe("long");
    expect(xmr2.rotated).toBe(true);

    // The stale PAPER trade was closed as cancelled, not left dangling.
    const recentTrades = repo.getRecentTrades("xmr", 10);
    const cancelledPaperTrade = recentTrades.find((t) => t.id === paperTrade!.id);
    expect(cancelledPaperTrade?.status).toBe("cancelled");

    // A new, genuinely-LIVE trade now exists.
    expect(repo.hasLiveTrade("xmr")).toBe(true);
    const liveTrade = repo.getOpenTrade("xmr");
    expect(liveTrade?.runMode).toBe("LIVE");
    expect(liveTrade?.id).not.toBe(paperTrade!.id);
  });

  it("does not re-query the wallet on later LIVE ticks once a genuine LIVE trade is on file", async () => {
    repo.setRunMode("PAPER");
    const { client, getWallets } = makeFlatWalletClient(LONG_TRIGGERING_CLOSES);

    // Tick 1 (PAPER, simulated entry) + tick 2 (LIVE, reconciles and
    // genuinely rotates) - same sequence as the previous test.
    await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    repo.setRunMode("LIVE");
    await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    expect(repo.hasLiveTrade("xmr")).toBe(true);

    const callsBeforeTick3 = getWallets.mock.calls.length;

    // Tick 3 (still LIVE, same regime - no flip). Since this pair now has a
    // genuine LIVE trade on file, the daemon should trust the DB instead of
    // re-querying the wallet every tick.
    const tick3 = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    const xmr3 = tick3.find((r) => r.pairKey === "xmr")!;

    // +1 here is the new unconditional per-tick wallet-basis read (real-wallet-based sizing), not a bootstrap re-check regression.
    expect(getWallets.mock.calls.length).toBe(callsBeforeTick3 + 1);
    expect(xmr3.currentPosition).toBe("long");
    expect(xmr3.decisionTarget).toBe("long");
    expect(xmr3.rotated).toBe(false);
  });
});
