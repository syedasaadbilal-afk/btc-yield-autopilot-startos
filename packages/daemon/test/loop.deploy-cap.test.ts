import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";
import { runControlLoopIteration } from "../src/loop.js";

const XAUT_SYMBOL = "tXAUT:BTC";
const XMR_SYMBOL = "tXMRBTC";
const BTC_USD_SYMBOL = "tBTCUST";

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

const CAP_CONFIG = { ...DEFAULT_STRATEGY_CONFIG, execution: { ...DEFAULT_STRATEGY_CONFIG.execution, maxDeployUsdPerDay: 10_000 } };
const ORANGE = [...new Array(60).fill(100), ...linearRamp(100, 102, 40)];
const NAVY = new Array(100).fill(100);

/**
 * Daily deployment cap (Oct 2026): idle BTC beyond the rolling-24h USD cap
 * must be drip-fed, not deployed at once. BTC/USD is mocked at 50,000 so a
 * $10,000 cap = 0.2 BTC/day; the synthetic asset price (102 BTC/unit) is
 * irrelevant to the cap, which is denominated in BTC at the BTC/USD price.
 */
describe("daily deployment cap on capital moved into rotation assets", () => {
  let repo: Repo;
  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("LIVE");
  });

  function client(): BitfinexRestClient {
    return {
      getCandles: async (symbol: string) => {
        if (symbol === BTC_USD_SYMBOL) return makeCandles([50_000]);
        if (symbol === XMR_SYMBOL) return makeCandles(ORANGE);
        if (symbol === XAUT_SYMBOL) return makeCandles(NAVY); // XAUT stays in BTC
        return makeCandles(NAVY);
      },
      getBookDepth: async (symbol: string) => ({ timestamp: 0, symbol, bidDepth: 5000, askDepth: 5000 }),
      submitOrder: async () => ({ submitted: false, dryRun: true }),
      getMinOrderSize: async () => 0,
      getWallets: async () => [
        { walletType: "exchange", currency: "BTC", balance: 1, availableBalance: 1 },
        { walletType: "exchange", currency: "XAUT", balance: 0, availableBalance: 0 },
        // 0.005 units * 102 BTC/unit (synthetic price) = 0.51 BTC held.
        { walletType: "exchange", currency: "XMR", balance: 0.005, availableBalance: 0.005 },
      ],
    } as unknown as BitfinexRestClient;
  }

  it("limits an idle top-up to the remaining daily cap, then defers once exhausted", async () => {
    repo.setAllocationFraction("xaut", 0);
    repo.setAllocationFraction("xmr", 1);

    const t0 = Date.UTC(2026, 9, 6, 12);
    const r1 = await runControlLoopIteration({ client: client(), repo, config: CAP_CONFIG, now: t0 });
    const xmr1 = r1.find((r) => r.pairKey === "xmr")!;
    expect(xmr1.rotated).toBe(true);
    const topup1 = repo.getRecentExecutions("xmr", 10).find((e) => e.kind === "topup")!;
    // $10,000 / $50,000 = 0.2 BTC, well under the ~1 BTC idle / deficit.
    expect(topup1.requestedBtc).toBeCloseTo(0.2, 6);

    // Same day: cap exhausted, nothing more deploys.
    const r2 = await runControlLoopIteration({
      client: client(),
      repo,
      config: CAP_CONFIG,
      now: t0 + 4 * 60 * 60 * 1000,
    });
    expect(r2.find((r) => r.pairKey === "xmr")!.rotated).toBe(false);
    expect(repo.getRecentExecutions("xmr", 10).filter((e) => e.kind === "topup")).toHaveLength(1);

    // 25h later the rolling window has cleared: deploys again.
    const r3 = await runControlLoopIteration({
      client: client(),
      repo,
      config: CAP_CONFIG,
      now: t0 + 25 * 60 * 60 * 1000,
    });
    expect(r3.find((r) => r.pairKey === "xmr")!.rotated).toBe(true);
    expect(repo.getRecentExecutions("xmr", 10).filter((e) => e.kind === "topup")).toHaveLength(2);
  });

  it("uses the operator-set cap from the Config tab (stored value overrides the config default), and can be disabled", async () => {
    repo.setAllocationFraction("xaut", 0);
    repo.setAllocationFraction("xmr", 1);
    const t0 = Date.UTC(2026, 9, 6, 12);

    // $20,000 / $50,000 = 0.4 BTC (config default would have been 0.2).
    repo.setDeployCap(true, 20_000);
    await runControlLoopIteration({ client: client(), repo, config: CAP_CONFIG, now: t0 });
    expect(repo.getRecentExecutions("xmr", 10).find((e) => e.kind === "topup")!.requestedBtc).toBeCloseTo(0.4, 6);

    // Disabled: next day deploys the whole idle balance (0.6 BTC left of 1).
    repo.setDeployCap(false, 20_000);
    await runControlLoopIteration({
      client: client(),
      repo,
      config: CAP_CONFIG,
      now: t0 + 25 * 60 * 60 * 1000,
    });
    const topups = repo.getRecentExecutions("xmr", 10).filter((e) => e.kind === "topup");
    expect(topups).toHaveLength(2);
    expect(topups[0]!.requestedBtc).toBeGreaterThan(0.5);
  });

  it("getDeployCap falls back to the config default when nothing is stored", () => {
    expect(repo.getDeployCap(10_000)).toEqual({ enabled: true, maxUsd: 10_000 });
    expect(repo.getDeployCap(undefined)).toEqual({ enabled: false, maxUsd: undefined });
    repo.setDeployCap(true, 5_000);
    expect(repo.getDeployCap(10_000)).toEqual({ enabled: true, maxUsd: 5_000 });
    repo.setDeployCap(false, 5_000);
    expect(repo.getDeployCap(10_000)).toEqual({ enabled: false, maxUsd: undefined });
  });
});
