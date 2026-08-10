import type { Candle } from "@autopilot/shared";

/**
 * Synthesizes BTC/XAUT ratio candles from separately-fetched BTC/USD and
 * XAUT/USD candles (design doc Section 6: "compute the ratio yourself if
 * tBTC:XAUT liquidity is thin" - applies just as much to backtesting since
 * tBTC:XAUT's own history is likely too sparse to backtest against directly).
 *
 * Aligns on exact timestamp match; days present in only one series are
 * dropped rather than guessed at, since a wrong ratio candle would corrupt
 * every subsequent swing/fib calculation for that stretch of history.
 */
export function synthesizeRatioCandles(btcUsd: Candle[], xautUsd: Candle[]): Candle[] {
  const xautByTs = new Map(xautUsd.map((c) => [c.timestamp, c]));
  const out: Candle[] = [];

  for (const btc of btcUsd) {
    const xaut = xautByTs.get(btc.timestamp);
    if (!xaut || xaut.close <= 0 || xaut.open <= 0) continue;
    out.push({
      timestamp: btc.timestamp,
      open: btc.open / xaut.open,
      close: btc.close / xaut.close,
      high: Math.max(btc.high / xaut.low, btc.high / xaut.high),
      low: Math.min(btc.low / xaut.high, btc.low / xaut.low),
      // BTC/USD volume is the closest available liquidity proxy for the
      // synthetic ratio series; not a true tBTC:XAUT volume figure.
      volume: btc.volume,
    });
  }

  return out.sort((a, b) => a.timestamp - b.timestamp);
}
