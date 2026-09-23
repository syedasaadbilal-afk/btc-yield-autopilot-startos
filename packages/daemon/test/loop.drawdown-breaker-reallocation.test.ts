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
 * Regression test for "real money stuck" (bug found live Aug 2026, round 7):
 * the drawdown circuit breaker (gate.ts's currentBtcDrawdownFraction) used a
 * pair's FULL, unfiltered nav history to find its "peak" - so a deliberate
 * cross-pair reallocation that shrank a pair's allocation (e.g. XAUT going
 * from ~100% down to 45% under a manual override) left its historical peak
 * far above its new, legitimately-smaller NAV. That reads identically to a
 * real ~55%+ trading loss and permanently trips the circuit breaker,
 * blocking every future real exit signal for that pair - confirmed live:
 * XAUT's Larsson regime correctly flipped to exit-to-BTC, but the breaker
 * blocked it every tick for days, tripping at "64% from peak BTC NAV" that
 * was actually just the reallocation to XMR, not a loss.
 *
 * Confirms: after a real reallocation resets funding_baseline (see
 * loop.funding-baseline.test.ts), the drawdown breaker's view of nav history
 * is confined to points since that reset - so it can never again treat a
 * pre-reallocation peak as this pair's current drawdown reference - and a
 * genuine post-reallocation exit signal is allowed through.
 */
describe("drawdown circuit breaker ignores nav history from before the last real reallocation", () => {
  let repo: Repo;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("PAPER");
  });

  it("does not block a real exit signal after a deliberate reallocation shrank this pair's NAV", async () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.UTC(2026, 0, 1);

    // Settle: both navy, BTC-only wallet - clean bootstrap.
    const settleClient = clientForSymbols(
      { [XAUT_SYMBOL]: STAYS_NAVY_CLOSES, [XMR_SYMBOL]: STAYS_NAVY_CLOSES },
      FRESH_BTC_ONLY_WALLET
    );
    await runControlLoopIteration({ client: settleClient, repo, config: DEFAULT_STRATEGY_CONFIG, now: t0 });

    // Tick 1: XAUT alone goes orange -> single-gold 100% XAUT (its NAV peaks
    // high here - this is the stale peak that must NOT poison the breaker
    // later). Well-separated `now` values throughout (real calendar gaps,
    // not same-instant ticks) so an incidental bootstrap-trade close from
    // the settle/entry transition can never leave a same-tick cooldown
    // contaminating the actual scenario under test three ticks later.
    const XAUT_ENTER_CLOSES = [...STAYS_NAVY_CLOSES, ...linearRamp(100, 102, 40)];
    const tick1Client = clientForSymbols(
      { [XAUT_SYMBOL]: XAUT_ENTER_CLOSES, [XMR_SYMBOL]: STAYS_NAVY_CLOSES },
      ESTABLISHED_WALLET
    );
    const tick1 = await runControlLoopIteration({ client: tick1Client, repo, config: DEFAULT_STRATEGY_CONFIG, now: t0 + day });
    expect(tick1.find((r) => r.pairKey === "xaut")!.targetFraction).toBeCloseTo(1);

    // Tick 2: XMR also goes orange -> collapses to 50/50 dual-gold. XAUT's
    // OWN regime hasn't changed, but its allocation - and therefore its
    // BTC-equivalent NAV - is deliberately cut roughly in half. This is a
    // real reallocation, not a loss, and must reset funding_baseline.
    const tick2Client = clientForSymbols(
      { [XAUT_SYMBOL]: XAUT_ENTER_CLOSES, [XMR_SYMBOL]: XAUT_ENTER_CLOSES },
      ESTABLISHED_WALLET
    );
    const tick2 = await runControlLoopIteration({
      client: tick2Client,
      repo,
      config: DEFAULT_STRATEGY_CONFIG,
      now: t0 + 2 * day,
    });
    const xaut2 = tick2.find((r) => r.pairKey === "xaut")!;
    expect(xaut2.targetFraction).toBeCloseTo(0.5);
    expect(xaut2.rotated).toBe(true); // real resize actually executed

    const baseline = repo.getFundingBaseline("xaut");
    expect(baseline).toBeDefined();

    // Tick 3: XAUT's OWN regime now reverses hard (gray/navy) - a real exit
    // signal, completely independent of the earlier reallocation, and well
    // past any post-stop-out cooldown window. Before the fix, the breaker
    // would see XAUT's pre-reallocation ~100%-allocation peak nav point
    // still sitting in its full history and treat the post-reallocation NAV
    // as a ~50%+ "drawdown", blocking this exit regardless of cooldown.
    const XAUT_REVERSE_CLOSES = [...XAUT_ENTER_CLOSES, ...linearRamp(102, 90, 30)];
    const tick3Client = clientForSymbols(
      { [XAUT_SYMBOL]: XAUT_REVERSE_CLOSES, [XMR_SYMBOL]: XAUT_ENTER_CLOSES },
      ESTABLISHED_WALLET
    );
    const tick3 = await runControlLoopIteration({
      client: tick3Client,
      repo,
      config: DEFAULT_STRATEGY_CONFIG,
      now: t0 + 30 * day,
    });
    const xaut3 = tick3.find((r) => r.pairKey === "xaut")!;

    expect(xaut3.decisionTarget).toBe("long"); // Larsson genuinely called for an exit
    expect(xaut3.gateAllowed).toBe(true); // the actual bug: this used to be false
    expect(xaut3.gateReason).not.toMatch(/drawdown/i);
    expect(xaut3.rotated).toBe(true); // the real exit actually executed
  });
});
