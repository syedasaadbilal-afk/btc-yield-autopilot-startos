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

function fundedFakeClient(closes: number[]): BitfinexRestClient {
  return {
    getCandles: async () => makeCandles(closes),
    getBookDepth: async () => ({ timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 50, askDepth: 50 }),
    submitOrder: async () => ({ submitted: false, dryRun: true }),
    getWallets: async () => [
      { walletType: "exchange", currency: "BTC", balance: 10, availableBalance: 10 },
      { walletType: "exchange", currency: "XAUT", balance: 1000, availableBalance: 1000 },
      { walletType: "exchange", currency: "XMR", balance: 1000, availableBalance: 1000 },
    ],
  } as unknown as BitfinexRestClient;
}

function lopsidedFakeClient(closes: number[]): BitfinexRestClient {
  return {
    getCandles: async () => makeCandles(closes),
    getBookDepth: async () => ({ timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 50, askDepth: 50 }),
    submitOrder: async () => ({ submitted: false, dryRun: true }),
    getWallets: async () => [
      { walletType: "exchange", currency: "BTC", balance: 0, availableBalance: 0 },
      { walletType: "exchange", currency: "XAUT", balance: 2000, availableBalance: 2000 },
      { walletType: "exchange", currency: "XMR", balance: 0, availableBalance: 0 },
    ],
  } as unknown as BitfinexRestClient;
}

describe("cross-pair allocation resize + NAV mark-to-market", () => {
  let repo: Repo;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("PAPER");
  });

  it("does not fire a reallocation trade when the real wallet is already within dust-threshold of the 50/50 target on the tick both regimes turn gold", async () => {
    const client = fundedFakeClient(orangeFlatCloses(102));
    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });

    for (const result of results) {
      expect(result.currentPosition).toBe("flat");
      expect(result.decisionTarget).toBe("flat");
      expect(result.targetFraction).toBeCloseTo(0.5);
      expect(result.rotated).toBe(false);
    }
    expect(repo.getAllocationFraction("xaut")).toBeCloseTo(0.5);
    expect(repo.getAllocationFraction("xmr")).toBeCloseTo(0.5);
  });

  it("resizes a lopsided real wallet toward 50/50 when both regimes newly turn gold on the same tick - fractionChanged fires a real reallocation, it is not silently skipped just because the new target happens to be the 50/50 dual-gold split", async () => {
    const client = lopsidedFakeClient(orangeFlatCloses(102));
    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });

    const xautResult = results.find((r) => r.pairKey === "xaut")!;
    const xmrResult = results.find((r) => r.pairKey === "xmr")!;

    expect(xautResult.targetFraction).toBeCloseTo(0.5);
    expect(xmrResult.targetFraction).toBeCloseTo(0.5);
    expect(xautResult.rotated).toBe(true);
    expect(xmrResult.rotated).toBe(true);

    expect(repo.getAllocationFraction("xaut")).toBeCloseTo(0.5);
    expect(repo.getAllocationFraction("xmr")).toBeCloseTo(0.5);
  });

  it("does not re-resize on a second tick when the target fraction hasn't changed, but NAV still marks to market with price", async () => {
    const clientTick1 = fundedFakeClient(orangeFlatCloses(102));
    await runControlLoopIteration({ client: clientTick1, repo, config: DEFAULT_STRATEGY_CONFIG });

    const navAfterTick1 = repo.getLatestNavPoint("xaut");
    expect(navAfterTick1).toBeDefined();

    const clientTick2 = fundedFakeClient(orangeFlatCloses(104));
    const resultsTick2 = await runControlLoopIteration({ client: clientTick2, repo, config: DEFAULT_STRATEGY_CONFIG });

    const xautResultTick2 = resultsTick2.find((r) => r.pairKey === "xaut")!;
    expect(xautResultTick2.rotated).toBe(false);

    const navAfterTick2 = repo.getLatestNavPoint("xaut")!;
    expect(navAfterTick2.xautHeld).toBeCloseTo(navAfterTick1!.xautHeld);
    expect(navAfterTick2.btcEquivalentNav).not.toBeCloseTo(navAfterTick1!.btcEquivalentNav, 6);
  });
});
