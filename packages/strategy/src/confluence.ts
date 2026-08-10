import type { Candle, ConfluenceZone, FibLevel, Trendline } from "@autopilot/shared";
import { FIB_LEVELS } from "@autopilot/shared";
import { findSwingPoints, latestLeg, type SwingPoint } from "./swings.js";

/** Build a two-point trendline from the two most recent swing points of the same kind. */
export function trendlineFromSwings(points: SwingPoint[], kind: "high" | "low"): Trendline | undefined {
  const filtered = points.filter((p) => p.kind === kind);
  if (filtered.length < 2) return undefined;
  const a = filtered[filtered.length - 2]!;
  const b = filtered[filtered.length - 1]!;
  const slopePerMs = (b.price - a.price) / (b.timestamp - a.timestamp);
  return {
    anchors: [
      { timestamp: a.timestamp, price: a.price },
      { timestamp: b.timestamp, price: b.price },
    ],
    slopePerMs,
    interceptPrice: b.price,
    interceptTimestamp: b.timestamp,
  };
}

function fibPrice(startPrice: number, endPrice: number, level: FibLevel): number {
  // Retracement back toward startPrice from endPrice.
  return endPrice - (endPrice - startPrice) * level;
}

/**
 * Find confluence zones for the most recent leg: fib retracement levels that
 * line up with the current trendline (design doc Section 1). `toleranceFraction`
 * is how close (as a fraction of price) the trendline's projected price must be
 * to a fib level for it to count as confluence.
 */
export function findConfluenceZones(
  candles: Candle[],
  swingLookback: number,
  toleranceFraction: number
): ConfluenceZone[] {
  const swings = findSwingPoints(candles, swingLookback);
  const leg = latestLeg(swings);
  if (!leg) return [];

  const uptrend = leg.end.price > leg.start.price;
  const trendline = trendlineFromSwings(swings, uptrend ? "low" : "high");
  const lastCandle = candles[candles.length - 1];
  const zones: ConfluenceZone[] = [];

  for (const level of FIB_LEVELS) {
    const price = fibPrice(leg.start.price, leg.end.price, level);
    const zone: ConfluenceZone = {
      fib: {
        legStart: { timestamp: leg.start.timestamp, price: leg.start.price },
        legEnd: { timestamp: leg.end.timestamp, price: leg.end.price },
        level,
        price,
      },
      toleranceFraction,
    };
    if (trendline && lastCandle) {
      const projected =
        trendline.interceptPrice +
        trendline.slopePerMs * (lastCandle.timestamp - trendline.interceptTimestamp);
      if (Math.abs(projected - price) / price <= toleranceFraction) {
        zone.trendline = trendline;
      }
    }
    zones.push(zone);
  }
  return zones;
}

/** Is `price` within tolerance of any confluence zone that actually has trendline agreement? */
export function priceAtConfirmedConfluence(
  price: number,
  zones: ConfluenceZone[]
): ConfluenceZone | undefined {
  return zones.find(
    (z) => !!z.trendline && Math.abs(price - z.fib.price) / z.fib.price <= z.toleranceFraction
  );
}
