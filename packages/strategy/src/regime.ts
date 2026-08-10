import type { Candle, Regime } from "@autopilot/shared";
import { ema } from "./indicators.js";

/**
 * Regime filter (design doc Section 1): 50/200 EMA on the daily BTC/XAUT ratio.
 * Bullish = fast EMA above slow EMA and rising; bearish = fast below slow and
 * falling; anything else (crossed but flattening) reads neutral rather than
 * forcing a call - the contrarian layer only engages on neutral reads.
 */
export function detectRegime(
  candles: Candle[],
  fastPeriod: number,
  slowPeriod: number
): Regime {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const i = candles.length - 1;
  const prevI = i - 1;

  const fastNow = fast[i];
  const slowNow = slow[i];
  const fastPrev = prevI >= 0 ? fast[prevI] : undefined;

  if (fastNow === undefined || slowNow === undefined || Number.isNaN(fastNow) || Number.isNaN(slowNow)) {
    return "neutral";
  }

  const rising = fastPrev !== undefined && !Number.isNaN(fastPrev) ? fastNow > fastPrev : true;

  if (fastNow > slowNow && rising) return "bullish";
  if (fastNow < slowNow && !rising) return "bearish";
  return "neutral";
}
