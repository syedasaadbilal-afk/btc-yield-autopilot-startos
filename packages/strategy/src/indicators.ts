import type { Candle } from "@autopilot/shared";

/** Plain simple moving average. Index < period-1 is NaN. */
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  let windowSum = 0;
  for (let i = 0; i < values.length; i++) {
    windowSum += values[i]!;
    if (i >= period) windowSum -= values[i - period]!;
    if (i >= period - 1) out[i] = windowSum / period;
  }
  return out;
}

/**
 * Smoothed moving average (Pine Script's `smma`/Wilder's RMA form used by
 * the Larsson line engine): seeded with a plain SMA of the first `period`
 * values, then recursively `(prev*(period-1)+value)/period` from there.
 * Index < period-1 is NaN, matching Pine's `ta.sma` seed behavior exactly
 * (na(s[1]) is true, so s falls back to ta.sma, until index period-1).
 */
export function smma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = (out[i - 1]! * (period - 1) + values[i]!) / period;
  }
  return out;
}

/** Standard EMA, seeded with an SMA of the first `period` values. Index < period-1 is NaN. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i]! * k + out[i - 1]! * (1 - k);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average True Range over `period`, Wilder-smoothed. */
export function atr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return out;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trueRanges.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      )
    );
  }

  let seed = 0;
  for (let i = 0; i < period; i++) seed += trueRanges[i]!;
  seed /= period;
  out[period] = seed;

  for (let i = period + 1; i < candles.length; i++) {
    const tr = trueRanges[i - 1]!;
    out[i] = (out[i - 1]! * (period - 1) + tr) / period;
  }
  return out;
}
