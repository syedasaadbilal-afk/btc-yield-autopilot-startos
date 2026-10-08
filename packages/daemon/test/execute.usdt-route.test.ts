import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { executeRotation } from "../src/execute.js";

const XAUT = DEFAULT_STRATEGY_CONFIG.pairs.find((p) => p.key === "xaut")!;
const XMR = DEFAULT_STRATEGY_CONFIG.pairs.find((p) => p.key === "xmr")!;
const BTC_USD = 100_000;
const XMR_USD = 300;

interface Order {
  symbol: string;
  amount: number;
}

/** Stateful fake: marketable orders fill instantly into the fake wallets. */
function fake(initial: Record<string, number>, opts: { dry?: boolean; partial?: boolean } = {}) {
  const bal = { ...initial };
  const orders: Order[] = [];
  const fills: Record<string, number> = {};
  const px: Record<string, number> = { [XMR.btcUsdtSymbol]: BTC_USD, [XMR.assetUsdtSymbol]: XMR_USD, [XMR.ratioSymbol]: XMR_USD / BTC_USD, [XAUT.assetUsdtSymbol]: 4_000 };
  const client = {
    getCandles: async (s: string) => [{ timestamp: 0, open: px[s]!, close: px[s]!, high: px[s]!, low: px[s]!, volume: 1 }],
    getBookDepth: async (s: string) => ({ timestamp: 0, symbol: s, bidDepth: 1e6, askDepth: 1e6 }),
    getMinOrderSize: async () => 0,
    getWallets: async () =>
      Object.entries(bal).map(([currency, b]) => ({ walletType: "exchange", currency, balance: b, availableBalance: b })),
    submitOrder: async (o: { symbol: string; amount: number }) => {
      orders.push({ symbol: o.symbol, amount: o.amount });
      if (opts.dry) return { submitted: false, dryRun: true };
      const p = px[o.symbol]!;
      const amt = o.amount * (opts.partial ? 0.5 : 1);
      if (o.symbol === XMR.btcUsdtSymbol) bal.BTC = (bal.BTC ?? 0) + amt;
      else if (o.symbol === XAUT.assetUsdtSymbol) bal.XAUT = (bal.XAUT ?? 0) + amt;
      else bal.XMR = (bal.XMR ?? 0) + amt;
      bal.UST = (bal.UST ?? 0) - amt * p;
      const id = String(orders.length);
      fills[id] = Math.abs(o.amount) * (opts.partial ? 0.5 : 1);
      return { submitted: true, dryRun: false, exchangeOrderId: id };
    },
    getOrderFill: async (_s: string, id: string) => ({ active: false, filled: fills[id]!, original: 0 }),
    cancelOrder: async () => {},
  } as unknown as BitfinexRestClient;
  return { client, bal, orders };
}

const fillWait = { pollIntervalMs: 0, fillTimeoutMs: 1000 };

describe("executeRotation - mandated USDT routing", () => {
  it("entry with enough idle USDT buys the asset directly with USDT (no BTC sold)", async () => {
    const { client, bal, orders } = fake({ BTC: 0, UST: 10_000, XMR: 0 });
    await executeRotation({ client, side: "sell_btc_for_xaut", btcCapital: 0.09, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, ...fillWait });
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.symbol === XMR.assetUsdtSymbol && o.amount > 0)).toBe(true);
    expect(bal.XMR).toBeGreaterThan(0);
  });

  it("entry with a USDT shortfall sells BTC only for the shortfall", async () => {
    // $4,500 USDT idle = 0.045 BTC; need 0.09 BTC => ~0.045 BTC sold for USDT.
    const { client, bal, orders } = fake({ BTC: 0.2, UST: 4_500, XMR: 0 });
    await executeRotation({ client, side: "sell_btc_for_xaut", btcCapital: 0.09, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, ...fillWait });
    const btcLegs = orders.filter((o) => o.symbol === XMR.btcUsdtSymbol);
    const soldBtc = -btcLegs.reduce((s, o) => s + o.amount, 0);
    expect(soldBtc).toBeGreaterThan(0.04);
    expect(soldBtc).toBeLessThan(0.05);
    expect(bal.XMR! * XMR_USD).toBeGreaterThan(0.085 * BTC_USD);
  });

  it("exit sells the asset for USDT then buys BTC with the proceeds", async () => {
    const { client, bal, orders } = fake({ BTC: 0, UST: 0, XMR: 30 }); // 30 XMR = $9,000 = 0.09 BTC
    await executeRotation({ client, side: "buy_btc_with_xaut", btcCapital: 0.09, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, ...fillWait });
    expect(orders[0]!.symbol).toBe(XMR.assetUsdtSymbol);
    expect(orders[0]!.amount).toBeLessThan(0);
    expect(orders.some((o) => o.symbol === XMR.btcUsdtSymbol && o.amount > 0)).toBe(true);
    expect(bal.BTC!).toBeGreaterThan(0.08);
    expect(bal.UST!).toBeGreaterThanOrEqual(-1e-6);
  });

  it("never submits the direct XMR/BTC symbol", async () => {
    const { client, orders } = fake({ BTC: 0.2, UST: 0, XMR: 0 });
    await executeRotation({ client, side: "sell_btc_for_xaut", btcCapital: 0.09, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, ...fillWait });
    expect(orders.some((o) => o.symbol === XMR.ratioSymbol)).toBe(false);
  });

  it("phases a large entry into chunks no bigger than chunkUsd, one order at a time", async () => {
    // 0.5 BTC = $50,000 in $10,000 chunks, all from idle USDT.
    const { client, orders } = fake({ BTC: 0, UST: 60_000, XMR: 0 });
    await executeRotation({ client, side: "sell_btc_for_xaut", btcCapital: 0.5, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, chunkUsd: 10_000, ...fillWait });
    expect(orders.length).toBeGreaterThanOrEqual(5);
    for (const o of orders) expect(Math.abs(o.amount) * XMR_USD).toBeLessThanOrEqual(10_000 * 1.01);
  });

  it("exit converts each chunk's USDT into BTC before selling the next chunk", async () => {
    const { client, orders } = fake({ BTC: 0, UST: 0, XMR: 200 }); // $60,000 of XMR
    await executeRotation({ client, side: "buy_btc_with_xaut", btcCapital: 0.6, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, chunkUsd: 10_000, ...fillWait });
    expect(orders.length).toBeGreaterThanOrEqual(10);
    orders.forEach((o, i) => {
      if (i % 2 === 0) expect(o.symbol).toBe(XMR.assetUsdtSymbol); // sell asset chunk
      else expect(o.symbol).toBe(XMR.btcUsdtSymbol); // then buy BTC before the next sell
    });
  });

  it("stops after a partially filled chunk instead of placing the next one", async () => {
    const { client, orders } = fake({ BTC: 0, UST: 60_000, XMR: 0 }, { partial: true });
    await executeRotation({ client, side: "sell_btc_for_xaut", btcCapital: 0.5, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, chunkUsd: 10_000, ...fillWait });
    expect(orders).toHaveLength(1);
  });

  it("exit can buy another pair's asset directly via USDT (no BTC leg for that portion)", async () => {
    const { client, bal, orders } = fake({ BTC: 0, UST: 0, XMR: 100 }); // $30,000 of XMR
    const r = await executeRotation({
      client, side: "buy_btc_with_xaut", btcCapital: 0.3, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, chunkUsd: 10_000, ...fillWait,
      destination: { pair: XAUT, btcAmount: 0.2, mode: "buy" }, // $20,000 into XAUT, rest to BTC
    });
    expect(bal.XAUT! * 4_000).toBeGreaterThan(19_000);
    expect(bal.BTC! * BTC_USD).toBeGreaterThan(9_000);
    expect(bal.BTC! * BTC_USD).toBeLessThan(11_000);
    expect(r.destinationRoutedBtc).toBeGreaterThan(0.19);
    expect(orders.some((o) => o.symbol === XAUT.assetUsdtSymbol && o.amount > 0)).toBe(true);
  });

  it("exit in 'hold' mode leaves the destination's share as idle USDT for its entry", async () => {
    const { client, bal } = fake({ BTC: 0, UST: 0, XMR: 100 });
    await executeRotation({
      client, side: "buy_btc_with_xaut", btcCapital: 0.3, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, chunkUsd: 10_000, ...fillWait,
      destination: { pair: XAUT, btcAmount: 0.2, mode: "hold" },
    });
    expect(bal.UST!).toBeGreaterThan(19_000);
    expect(bal.XAUT ?? 0).toBe(0);
    expect(bal.BTC! * BTC_USD).toBeGreaterThan(9_000);
  });

  it("full-USDT entry never tries to sell BTC it doesn't have (live 10/8 regression)", async () => {
    // $60,000 USDT, ~0 BTC; ask for slightly MORE than the USDT covers.
    const { client, orders, bal } = fake({ BTC: 0.00000076, UST: 60_000, XMR: 0 });
    await expect(
      executeRotation({ client, side: "sell_btc_for_xaut", btcCapital: 0.6, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, chunkUsd: 2_000, ...fillWait })
    ).resolves.toBeDefined();
    expect(orders.some((o) => o.symbol === XMR.btcUsdtSymbol)).toBe(false);
    expect(bal.XMR! * XMR_USD).toBeGreaterThan(58_000);
  });

  it("an exchange error mid-rotation keeps the progress instead of throwing it away", async () => {
    const { client, orders } = fake({ BTC: 0, UST: 60_000, XMR: 0 });
    const real = client.submitOrder.bind(client);
    let n = 0;
    (client as unknown as { submitOrder: unknown }).submitOrder = async (o: never) => {
      if (++n === 3) throw new Error("submitOrder failed: 500 not enough exchange balance");
      return real(o);
    };
    const r = await executeRotation({ client, side: "sell_btc_for_xaut", btcCapital: 0.5, pair: XMR, config: DEFAULT_STRATEGY_CONFIG, chunkUsd: 2_000, ...fillWait });
    expect(orders.length).toBe(2);
    expect(r.totalBtcMoved).toBeGreaterThan(0);
  });
});
