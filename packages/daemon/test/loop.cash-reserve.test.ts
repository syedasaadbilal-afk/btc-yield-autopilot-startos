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
const ramp = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const ORANGE = [...new Array(60).fill(100), ...ramp(100, 102, 40)];
const NAVY = new Array(100).fill(100);

describe("required cash (USDT)", () => {
  let repo: Repo;
  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("LIVE");
    repo.setAllocationFraction("xaut", 0);
    repo.setAllocationFraction("xmr", 1);
  });

  function client(orders: { symbol: string; amount: number }[], usdt: number): BitfinexRestClient {
    return {
      getCandles: async (symbol: string) =>
        symbol === "tBTCUST" ? makeCandles([50_000]) : symbol === "tXMRUST" ? makeCandles([5_100_000]) : symbol === XMR_SYMBOL ? makeCandles(ORANGE) : makeCandles(NAVY),
      getBookDepth: async (symbol: string) => ({ timestamp: 0, symbol, bidDepth: 5000, askDepth: 5000 }),
      submitOrder: async (o: { symbol: string; amount: number }) => {
        orders.push({ symbol: o.symbol, amount: o.amount });
        return { submitted: false, dryRun: true };
      },
      getMinOrderSize: async () => 0,
      getWallets: async () => [
        { walletType: "exchange", currency: "BTC", balance: 1, availableBalance: 1 },
        { walletType: "exchange", currency: "XAUT", balance: 0, availableBalance: 0 },
        { walletType: "exchange", currency: "XMR", balance: 0.005, availableBalance: 0.005 }, // 0.005 units * 102 BTC/unit = 0.51 BTC
        { walletType: "exchange", currency: "UST", balance: usdt, availableBalance: usdt },
      ],
    } as unknown as BitfinexRestClient;
  }

  it("sells every holding down by the same percentage when USDT is below the target", async () => {
    repo.setCashReserveUsd(5_000);
    const orders: { symbol: string; amount: number }[] = [];
    await runControlLoopIteration({ client: client(orders, 0), repo, config: DEFAULT_STRATEGY_CONFIG, now: Date.UTC(2026, 9, 8, 12) });
    // The cash step runs first, so the first sell on each pair is the cash raise (later orders are the idle top-up).
    const btcSold = -orders.find((o) => o.symbol === "tBTCUST" && o.amount < 0)!.amount;
    const xmrSoldUnits = -orders.find((o) => o.symbol === "tXMRUST" && o.amount < 0)!.amount;
    expect(btcSold).toBeGreaterThan(0);
    expect(xmrSoldUnits).toBeGreaterThan(0);
    // Same fraction of each holding: BTC 1 held, XMR 0.005 units held.
    expect(btcSold / 1).toBeCloseTo(xmrSoldUnits / 0.005, 2);
  });

  it("does nothing when USDT already covers the target, and reserves it from deployment", async () => {
    repo.setCashReserveUsd(5_000);
    const orders: { symbol: string; amount: number }[] = [];
    await runControlLoopIteration({ client: client(orders, 5_000), repo, config: DEFAULT_STRATEGY_CONFIG, now: Date.UTC(2026, 9, 8, 12) });
    expect(orders.filter((o) => o.amount < 0 && o.symbol === "tXMRUST")).toHaveLength(0);
    expect(repo.getCashReserveUsd()).toBe(5_000);
  });

  it("with no required cash set, nothing is sold", async () => {
    const orders: { symbol: string; amount: number }[] = [];
    await runControlLoopIteration({ client: client(orders, 0), repo, config: DEFAULT_STRATEGY_CONFIG, now: Date.UTC(2026, 9, 8, 12) });
    expect(orders.filter((o) => o.amount < 0 && o.symbol === "tXMRUST")).toHaveLength(0);
  });
});
