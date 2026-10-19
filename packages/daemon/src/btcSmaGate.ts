import type { BitfinexRestClient } from "@autopilot/bitfinex-client";

export const BTC_SMA_PERIOD = 1458; // 4 years of daily closes
export const DEFAULT_XAUT_SMA_THRESHOLD = 1.5;

export interface BtcSmaReading {
  multiple: number;
  btcUsd: number;
  sma: number;
  asOf: number;
}

let last: BtcSmaReading | undefined;
export const getLastBtcSma = (): BtcSmaReading | undefined => last;

/** BTC close / SMA1458 of daily closes, from CLOSED daily bars. Undefined with too little history. */
export function computeBtcSmaMultiple(
  candles: Array<{ timestamp: number; close: number }>,
  now: number
): BtcSmaReading | undefined {
  const day = 24 * 60 * 60 * 1000;
  const closed = candles.length && candles[candles.length - 1]!.timestamp + day > now ? candles.slice(0, -1) : candles;
  if (closed.length < BTC_SMA_PERIOD) return undefined;
  const window = closed.slice(-BTC_SMA_PERIOD);
  const sma = window.reduce((s, c) => s + c.close, 0) / BTC_SMA_PERIOD;
  const btcUsd = closed[closed.length - 1]!.close;
  if (!(sma > 0)) return undefined;
  return { multiple: btcUsd / sma, btcUsd, sma, asOf: closed[closed.length - 1]!.timestamp };
}

/** Fetches tBTCUSD dailies and caches the latest reading. Never throws; keeps the previous reading on failure. */
export async function refreshBtcSma(client: BitfinexRestClient, now: number): Promise<BtcSmaReading | undefined> {
  try {
    const candles = await client.getCandles("tBTCUSD", "1D", BTC_SMA_PERIOD + 30);
    const r = computeBtcSmaMultiple(candles, now);
    if (r) last = r;
  } catch (err) {
    console.warn(`[btc-sma] could not refresh BTC SMA multiple: ${err instanceof Error ? err.message : String(err)}`);
  }
  return last;
}
