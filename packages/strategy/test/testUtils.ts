import type { Candle } from "@autopilot/shared";

/** Builds simple OHLCV candles from a close-price series. Daily spacing, UTC. */
export function makeCandles(closes: number[], volumes?: number[]): Candle[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2024, 0, 1);
  const out: Candle[] = [];
  for (let i = 0; i < closes.length; i++) {
    const open = i === 0 ? closes[i]! : closes[i - 1]!;
    const close = closes[i]!;
    out.push({
      timestamp: start + i * dayMs,
      open,
      close,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      volume: volumes?.[i] ?? 100,
    });
  }
  return out;
}

/** Linear ramp from `start` to `end` over `n` points. */
export function linearRamp(start: number, end: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(start + ((end - start) * i) / (n - 1));
  }
  return out;
}
