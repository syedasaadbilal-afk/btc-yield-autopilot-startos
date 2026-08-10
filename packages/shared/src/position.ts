/**
 * Spot, long-only, no exceptions (design doc Section 3).
 *
 * "short" is intentionally NOT a member of this union. This is a type-level
 * enforcement of the hard constraint: the strategy's decide() function is
 * structurally incapable of producing a short target, not just runtime-filtered.
 *
 * - "flat" = holding XAUT (the gold leg). This is the rotation-out state, not cash.
 * - "long" = holding BTC.
 */
export type PositionState = "flat" | "long";

export const POSITION_STATES: readonly PositionState[] = ["flat", "long"];

/** Regime read off the daily BTC/XAUT ratio (design doc Section 1). */
export type Regime = "bullish" | "bearish" | "neutral";

/**
 * Which asset the position is denominated in for a given PositionState.
 * Used by execution/persistence to know what's actually being held.
 */
export function heldAsset(position: PositionState): "BTC" | "XAUT" {
  return position === "long" ? "BTC" : "XAUT";
}
