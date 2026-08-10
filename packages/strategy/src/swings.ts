import type { Candle } from "@autopilot/shared";

export interface SwingPoint {
  index: number;
  timestamp: number;
  price: number;
  kind: "high" | "low";
}

/**
 * Simple pivot-based swing detection: a candle is a swing high if its high is
 * the max within [i-lookback, i+lookback], similarly for swing low.
 * Requires `lookback` candles of lookahead, so the most recent `lookback`
 * candles can never be confirmed swings yet - this is intentional (Soloway's
 * approach draws trendlines off *confirmed* swing points, not the live edge).
 */
export function findSwingPoints(candles: Candle[], lookback = 3): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i]!;
    const isHigh = window.every((w) => w.high <= c.high);
    const isLow = window.every((w) => w.low >= c.low);
    if (isHigh) {
      points.push({ index: i, timestamp: c.timestamp, price: c.high, kind: "high" });
    } else if (isLow) {
      points.push({ index: i, timestamp: c.timestamp, price: c.low, kind: "low" });
    }
  }
  return points;
}

/** Most recent completed leg: last swing low -> swing high, or high -> low, whichever is later. */
export function latestLeg(
  points: SwingPoint[]
): { start: SwingPoint; end: SwingPoint } | undefined {
  if (points.length < 2) return undefined;
  const last = points[points.length - 1]!;
  for (let i = points.length - 2; i >= 0; i--) {
    const candidate = points[i]!;
    if (candidate.kind !== last.kind) {
      return { start: candidate, end: last };
    }
  }
  return undefined;
}
