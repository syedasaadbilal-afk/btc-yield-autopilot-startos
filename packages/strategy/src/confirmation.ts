import type { Candle, Confirmation } from "@autopilot/shared";

function isBullishEngulfing(prev: Candle, cur: Candle): boolean {
  const prevBearish = prev.close < prev.open;
  const curBullish = cur.close > cur.open;
  return prevBearish && curBullish && cur.close >= prev.open && cur.open <= prev.close;
}

function isBearishEngulfing(prev: Candle, cur: Candle): boolean {
  const prevBullish = prev.close > prev.open;
  const curBearish = cur.close < cur.open;
  return prevBullish && curBearish && cur.open >= prev.close && cur.close <= prev.open;
}

function isHammer(c: Candle): boolean {
  const body = Math.abs(c.close - c.open);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  return body > 0 && lowerWick >= body * 2 && upperWick <= body * 0.5;
}

function isShootingStar(c: Candle): boolean {
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return body > 0 && upperWick >= body * 2 && lowerWick <= body * 0.5;
}

/** Reversal-candle confirmation at a support (bullish) or resistance (bearish) zone. */
export function findReversalConfirmation(
  candles: Candle[],
  direction: "bullish" | "bearish"
): Confirmation | undefined {
  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  if (!cur || !prev) return undefined;

  if (direction === "bullish") {
    if (isBullishEngulfing(prev, cur)) return { kind: "reversal_candle", pattern: "engulfing" };
    if (isHammer(cur)) return { kind: "reversal_candle", pattern: "hammer" };
  } else {
    if (isBearishEngulfing(prev, cur)) return { kind: "reversal_candle", pattern: "engulfing" };
    if (isShootingStar(cur)) return { kind: "reversal_candle", pattern: "shooting_star" };
  }
  return undefined;
}

/** Volume-breakout confirmation: latest candle's volume vs trailing average. */
export function findVolumeBreakoutConfirmation(
  candles: Candle[],
  lookback: number,
  minMultiple: number
): Confirmation | undefined {
  if (candles.length <= lookback) return undefined;
  const recent = candles.slice(-lookback - 1, -1);
  const avgVolume = recent.reduce((sum, c) => sum + c.volume, 0) / recent.length;
  const cur = candles[candles.length - 1]!;
  if (avgVolume <= 0) return undefined;
  const multiple = cur.volume / avgVolume;
  if (multiple >= minMultiple) {
    return { kind: "volume_breakout", volumeMultipleOfAverage: multiple };
  }
  return undefined;
}
