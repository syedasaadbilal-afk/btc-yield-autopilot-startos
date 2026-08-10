import type { OrderBookDepthSnapshot, SlippageBudgetCheck } from "@autopilot/shared";

/**
 * Sizes a single clip against live order-book depth at placement time
 * (design doc Section 8: "no more than ~10-20% of top-of-book size").
 * Never sizes above what's actually left to fill for the tranche.
 */
export function sizeClipAgainstDepth(
  remainingTrancheAmount: number,
  evenSliceAmount: number,
  depth: OrderBookDepthSnapshot,
  side: "buy_btc_with_xaut" | "sell_btc_for_xaut",
  maxFractionOfBookDepth: number
): number {
  const relevantDepth = side === "buy_btc_with_xaut" ? depth.askDepth : depth.bidDepth;
  const depthCap = relevantDepth * maxFractionOfBookDepth;
  return Math.max(0, Math.min(remainingTrancheAmount, evenSliceAmount, depthCap));
}

/**
 * Gate-stage slippage budget check (design doc Section 8). Since P&L is
 * BTC-denominated, the budget is expressed in BTC, not a percentage of a USD
 * notional.
 */
export function checkSlippageBudget(
  estimatedSlippageBtc: number,
  maxAllowedSlippageBtc: number
): SlippageBudgetCheck {
  return {
    estimatedSlippageBtc,
    maxAllowedSlippageBtc,
    passes: estimatedSlippageBtc <= maxAllowedSlippageBtc,
  };
}

/**
 * Rough slippage estimate: how far the clip is expected to walk the book,
 * scaled by how large the clip is relative to visible depth. This is a
 * placeholder model - replace with a real book-walk simulation once live
 * order-book snapshots are wired up in @autopilot/bitfinex-client.
 */
export function estimateClipSlippageBtc(
  clipBtcAmount: number,
  depth: OrderBookDepthSnapshot,
  side: "buy_btc_with_xaut" | "sell_btc_for_xaut"
): number {
  const relevantDepth = side === "buy_btc_with_xaut" ? depth.askDepth : depth.bidDepth;
  if (relevantDepth <= 0) return clipBtcAmount; // no visible depth: assume worst case
  const depthFraction = clipBtcAmount / relevantDepth;
  // Simple convex penalty: slippage grows faster as the clip consumes more of visible depth.
  const slippageFraction = Math.min(1, depthFraction ** 1.5 * 0.02);
  return clipBtcAmount * slippageFraction;
}
