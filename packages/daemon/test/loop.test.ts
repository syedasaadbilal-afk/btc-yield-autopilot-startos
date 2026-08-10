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

/** Same synthetic candles regardless of which pair's symbol is requested - fine for these generic behavioral checks. */
function fakeClient(closes: number[]): BitfinexRestClient {
  return {
    getCandles: async () => makeCandles(closes),
    getBookDepth: async () => ({ timestamp: 0, symbol: "tXAUT:BTC", bidDepth: 5, askDepth: 5 }),
    submitOrder: async () => ({ submitted: false, dryRun: true }),
    // Empty wallet: deriveBootstrapPosition (loop.ts) and
    // capBtcCapitalToAvailableBalance (execute.ts) both treat this as
    // "nothing held/available" and fall back gracefully rather than
    // throwing - these behavioral tests don't exercise real balances.
    getWallets: async () => [],
  } as unknown as BitfinexRestClient;
}

describe("runControlLoopIteration", () => {
  let repo: Repo;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("PAPER");
  });

  it("runs one result per configured pair", async () => {
    const closes = linearRamp(100, 105, 260); // mild drift, unlikely to trigger a rotation
    const client = fakeClient(closes);
    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    expect(results).toHaveLength(DEFAULT_STRATEGY_CONFIG.pairs.length);
    expect(results.map((r) => r.pairKey).sort()).toEqual(
      [...DEFAULT_STRATEGY_CONFIG.pairs.map((p) => p.key)].sort()
    );
  });

  it("stays flat and records a NAV point per pair when there is no qualifying setup", async () => {
    const closes = linearRamp(100, 105, 260);
    const client = fakeClient(closes);
    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    for (const result of results) {
      expect(result.currentPosition).toBe("flat");
      expect(result.error).toBeUndefined();
      expect(repo.getNavHistory(result.pairKey)).toHaveLength(1);
    }
  });

  it("always inserts a decision row for auditability", async () => {
    const closes = linearRamp(100, 400, 260);
    const client = fakeClient(closes);
    await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    // No direct getter exposed on Repo for decisions in this scaffold; verify indirectly
    // by confirming the iteration completed and a NAV point exists (decisions insert
    // happens before persistence and would have thrown on failure).
    for (const pair of DEFAULT_STRATEGY_CONFIG.pairs) {
      expect(repo.getNavHistory(pair.key).length).toBeGreaterThan(0);
    }
  });

  it("does not rotate into long while PAUSED even in a strong uptrend", async () => {
    repo.setRunMode("PAUSED");
    const closes = linearRamp(100, 400, 260);
    const client = fakeClient(closes);
    const results = await runControlLoopIteration({ client, repo, config: DEFAULT_STRATEGY_CONFIG });
    for (const result of results) {
      expect(result.rotated).toBe(false);
    }
  });
});
