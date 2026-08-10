/**
 * BTC-denominated NAV point (design doc Section 0). This is the primary
 * objective-function series for the whole project: "if everything were
 * converted back to BTC right now, how much BTC would I have."
 */
export interface NavPoint {
  timestamp: number;
  /**
   * Which rotation instance this point belongs to (PairConfig.key, e.g.
   * "xaut" or "xmr"). Absent on rows predating multi-pair support, which are
   * all implicitly "xaut" (the original single-pair design).
   */
  pairKey?: string;
  btcHeld: number;
  /**
   * Held amount of this pair's rotation asset. Field name kept as `xautHeld`
   * for backward compatibility even though, for a non-XAUT pair (e.g. XMR),
   * it holds that pair's asset amount, not literally XAUT.
   */
  xautHeld: number;
  /**
   * Asset-per-BTC ratio for this pair (design doc Section 0's original
   * convention, e.g. XAUT per 1 BTC for the xaut pair). Field name kept for
   * backward compatibility; see PairConfig.ratioConvention in config.ts for
   * how each pair's native Bitfinex quote gets normalized to this direction.
   * Used to convert xautHeld into BTC-equivalent at this instant.
   */
  btcXautRatio: number;
  /** btcHeld + xautHeld / btcXautRatio. The number that must trend up. */
  btcEquivalentNav: number;
  /** Secondary/informational only, per design doc Section 0 - not the objective. */
  usdEquivalentNav?: number;
}

export function computeBtcEquivalentNav(
  btcHeld: number,
  xautHeld: number,
  btcXautRatio: number
): number {
  return btcHeld + xautHeld / btcXautRatio;
}
