import type { LarssonRegime } from "./larssonRotation.js";

/**
 * Cross-pair capital allocation between the two Larsson rotation instances
 * (XAUT, XMR), layered ON TOP OF each pair's own independent Pine-script
 * entry/exit logic - this does NOT change when a pair enters or exits (that
 * stays exactly as replayLarssonRotation already computes it, gated by
 * entryMaxDistFraction/overextensionFraction). This only changes HOW MUCH of
 * the total portfolio each pair's slot is sized against.
 *
 * User's rule (session 2026-08-09), using "gold"/"blue" as the user's own
 * names for the regime colors:
 *   - one pair gold (orange), the other blue (navy or gray) -> 100% to the
 *     gold one, 0% to the blue one.
 *   - both gold -> 50% each.
 *   - both blue -> 0% to both, i.e. 100% effectively sits in BTC.
 *
 * "gray" is not a color the user named explicitly - treated as "blue" (not
 * strong enough to hold), matching how larssonRotation.ts's own exit logic
 * already lumps navy and gray together as reasons to rotate back to BTC.
 * Flagged to the user; open to being told this is wrong.
 */
export interface PortfolioAllocation {
  xaut: number;
  xmr: number;
}

function isGold(regime: LarssonRegime): boolean {
  return regime === "orange";
}

export function computePortfolioAllocation(params: {
  xautRegime: LarssonRegime;
  xmrRegime: LarssonRegime;
}): PortfolioAllocation {
  const xautGold = isGold(params.xautRegime);
  const xmrGold = isGold(params.xmrRegime);

  if (xautGold && xmrGold) return { xaut: 0.5, xmr: 0.5 };
  if (xautGold && !xmrGold) return { xaut: 1, xmr: 0 };
  if (!xautGold && xmrGold) return { xaut: 0, xmr: 1 };
  return { xaut: 0, xmr: 0 }; // both blue - 100% BTC
}
