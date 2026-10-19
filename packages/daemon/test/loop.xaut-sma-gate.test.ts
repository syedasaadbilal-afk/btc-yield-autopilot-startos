import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { openDatabase } from "../src/db/connection.js";
import { applyMigrations } from "../src/db/migrate.js";
import { Repo } from "../src/db/repo.js";
import { runControlLoopIteration } from "../src/loop.js";
import { computeBtcSmaMultiple } from "../src/btcSmaGate.js";

const CONFIG = {
  ...DEFAULT_STRATEGY_CONFIG,
  execution: { ...DEFAULT_STRATEGY_CONFIG.execution, maxDeployUsdPerDay: Infinity },
};
const DAY = 24 * 60 * 60 * 1000;

function makeCandles(closes: number[], start = Date.UTC(2024, 0, 1)) {
  return closes.map((close, i) => ({
    timestamp: start + i * DAY,
    open: i === 0 ? close : closes[i - 1]!,
    close,
    high: close * 1.001,
    low: close * 0.999,
    volume: 100,
  }));
}
const ramp = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const ENTRY = [...new Array(60).fill(100), ...ramp(100, 102, 40)];
const WALLET = [
  { walletType: "exchange", currency: "BTC", balance: 10, availableBalance: 10 },
  { walletType: "exchange", currency: "XAUT", balance: 0, availableBalance: 0 },
  { walletType: "exchange", currency: "XMR", balance: 0, availableBalance: 0 },
];

// BTC far below its 4-year average: 1500 days at 200, then 400 days at 100 -> multiple ~0.6.
// Start so that the series ends yesterday (closed bars).
function btcSeries(now: number, closes: number[]) {
  return makeCandles(closes, now - closes.length * DAY);
}

function client(btc: number[], now: number): BitfinexRestClient {
  return {
    getCandles: async (symbol: string) => (symbol === "tBTCUSD" ? btcSeries(now, btc) : makeCandles(ENTRY)),
    getBookDepth: async () => ({ timestamp: 0, symbol: "x", bidDepth: 50, askDepth: 50 }),
    submitOrder: async () => ({ submitted: false, dryRun: true }),
    getMinOrderSize: async () => 0,
    getWallets: async () => WALLET,
  } as unknown as BitfinexRestClient;
}

describe("computeBtcSmaMultiple", () => {
  it("is price over the 1458-day mean of closed bars, undefined with short history", () => {
    const now = Date.UTC(2026, 9, 1);
    const closes = [...new Array(1000).fill(200), ...new Array(458).fill(100), 150];
    const r = computeBtcSmaMultiple(btcSeries(now, closes), now)!;
    // last bar (150) is closed (timestamp + day <= now), window = last 1458 closes
    expect(r.btcUsd).toBe(150);
    // closes has 1459 entries; the window is the last 1458 (999 x 200, 458 x 100, 1 x 150)
    expect(r.sma).toBeCloseTo((999 * 200 + 458 * 100 + 150) / 1458, 6);
    expect(computeBtcSmaMultiple(btcSeries(now, closes.slice(0, 500)), now)).toBeUndefined();
  });
});

describe("XAUT entry block by BTC SMA multiple", () => {
  let repo: Repo;
  beforeEach(() => {
    const db = openDatabase(":memory:");
    applyMigrations(db);
    repo = new Repo(db);
    repo.setRunMode("PAPER");
  });

  const LOW = [...new Array(1500).fill(200), ...new Array(100).fill(100)]; // ~0.55x
  const HIGH = [...new Array(1500).fill(100), ...new Array(100).fill(200)]; // ~1.9x

  it("is off by default: XAUT enters even when BTC is cheap", async () => {
    const now = Date.now();
    const res = await runControlLoopIteration({ client: client(LOW, now), repo, config: CONFIG, now });
    expect(res.find((r) => r.pairKey === "xaut")!.rotated).toBe(true);
  });

  it("blocks the XAUT entry below the threshold and gives XMR the capital", async () => {
    repo.setXautSmaGate(true, 1.5);
    const now = Date.now();
    const res = await runControlLoopIteration({ client: client(LOW, now), repo, config: CONFIG, now });
    const xaut = res.find((r) => r.pairKey === "xaut")!;
    const xmr = res.find((r) => r.pairKey === "xmr")!;
    expect(xaut.rotated).toBe(false);
    expect(xaut.decisionTarget).toBe("long");
    expect(xmr.rotated).toBe(true);
    expect(xmr.targetFraction).toBeCloseTo(1);
  });

  it("allows the entry once the multiple is at or above the threshold", async () => {
    repo.setXautSmaGate(true, 1.5);
    const now = Date.now();
    const res = await runControlLoopIteration({ client: client(HIGH, now), repo, config: CONFIG, now });
    expect(res.find((r) => r.pairKey === "xaut")!.rotated).toBe(true);
  });

  it("persists the switch and threshold", () => {
    expect(repo.getXautSmaGate()).toEqual({ enabled: false, threshold: 1.5 });
    repo.setXautSmaGate(true, 1.75);
    expect(repo.getXautSmaGate()).toEqual({ enabled: true, threshold: 1.75 });
  });
});
