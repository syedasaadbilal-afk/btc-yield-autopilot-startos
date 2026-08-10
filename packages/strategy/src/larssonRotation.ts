import type { Candle, PairConfig, PositionState } from "@autopilot/shared";
import { smma } from "./indicators.js";

/**
 * Flips a candle series between asset-per-BTC and btc-per-asset (1/close,
 * with high/low swapped since inverting a positive series flips which side
 * is larger). See PairConfig.ratioConvention in @autopilot/shared for why
 * this is needed: Bitfinex doesn't consistently list both directions for
 * every pair, and this engine specifically needs btc-per-asset regardless
 * of which direction the fetched symbol happens to return.
 */
export function invertRatioCandles(candles: Candle[]): Candle[] {
  return candles.map((c) => ({
    timestamp: c.timestamp,
    open: 1 / c.open,
    close: 1 / c.close,
    high: 1 / c.low,
    low: 1 / c.high,
    volume: c.volume,
  }));
}

/**
 * Returns `candles` re-expressed in btc-per-asset terms - the convention
 * this engine's regime/overextension math expects - regardless of which
 * direction `pair.ratioSymbol` natively returns.
 */
export function toLarssonInputCandles(candles: Candle[], pair: Pick<PairConfig, "ratioConvention">): Candle[] {
  return pair.ratioConvention === "btcPerAsset" ? candles : invertRatioCandles(candles);
}

/**
 * Returns `candles` re-expressed in asset-per-BTC terms - the convention
 * the NAV/execution layer expects (design doc Section 0's btcXautRatio) -
 * regardless of which direction `pair.ratioSymbol` natively returns.
 */
export function toAccountingCandles(candles: Candle[], pair: Pick<PairConfig, "ratioConvention">): Candle[] {
  return pair.ratioConvention === "assetPerBtc" ? candles : invertRatioCandles(candles);
}

/**
 * Config for the "Larsson Baseline + Overextension Rotation" strategy,
 * ported faithfully from the user-supplied Pine Script v5 reference. This
 * supersedes the earlier SMA200/RSI rotation.ts as the active strategy -
 * that file (and its config.rotation section) is kept only for backward
 * compatibility/tests, not used by the backtest or daemon anymore.
 *
 * Regime engine: four SMMA (Wilder-smoothed) lines on hl2 - v1 (fast), m1,
 * m2, v2 (baseline/slow) - classify each bar as:
 *   - "gray": v1 and m1/m2 disagree on which side of v2 they're on (a
 *     transition/ambiguous zone - acts as a natural whipsaw buffer, since
 *     neither a fresh entry nor most exits fire here except regime-reversal).
 *   - "orange": not gray, and v1 > v2 (the rotation asset - XAUT or XMR -
 *     is the stronger side; eligible to hold it).
 *   - "navy": not gray, and v1 < v2 (BTC is the stronger side; forces an
 *     exit back to BTC if currently holding the rotation asset).
 */
export interface LarssonConfig {
  /** SMMA period for the fast line (v1). 15 in the reference. */
  fastPeriod: number;
  /** SMMA period for the first mid line (m1). 19 in the reference. */
  midPeriod1: number;
  /** SMMA period for the second mid line (m2). 25 in the reference. */
  midPeriod2: number;
  /** SMMA period for the baseline/slow line (v2). 29 in the reference. */
  baselinePeriod: number;
  /**
   * Take profit once price is this fraction above the baseline (regardless
   * of regime). 0.12 in the reference ("Overextension Take Profit %").
   */
  overextensionFraction: number;
  /**
   * Only enter the rotation asset if price is within this fraction above
   * the baseline - avoids chasing an already-extended move. 0.04 in the
   * reference ("Max Entry Distance % Above Baseline"). Only checked at
   * entry, never gates an exit.
   */
  entryMaxDistFraction: number;
}

export const DEFAULT_LARSSON_CONFIG: LarssonConfig = {
  fastPeriod: 15,
  midPeriod1: 19,
  midPeriod2: 25,
  baselinePeriod: 29,
  overextensionFraction: 0.12,
  entryMaxDistFraction: 0.04,
};

export type LarssonRegime = "gray" | "orange" | "navy";

export interface LarssonDayResult {
  timestamp: number;
  /** r = rotation-asset-per-BTC (e.g. XAUT per BTC, or XMR per BTC). */
  r: number;
  v1: number;
  m1: number;
  m2: number;
  v2: number;
  regime: LarssonRegime;
  /** (close - v2) / v2. */
  distFromBaseline: number;
  /** Position AFTER applying today's rule. "long" = BTC, "flat" = rotation asset. */
  position: PositionState;
  switched: boolean;
  reason: string;
}

/**
 * Pure, deterministic replay of the Larsson baseline + overextension rules
 * across a full candle history, mirroring the Pine Script's single
 * if/else-if per confirmed bar (entry only evaluated while long, exit only
 * evaluated while flat - the two can't both fire on the same bar). No
 * lookahead: each day's regime/distance only depends on SMMA values
 * computable from that day and earlier.
 */
export function replayLarssonRotation(
  ratioCandles: Candle[],
  config: LarssonConfig,
  startPosition: PositionState = "long"
): LarssonDayResult[] {
  const hl2 = ratioCandles.map((c) => (c.high + c.low) / 2);
  const v1Series = smma(hl2, config.fastPeriod);
  const m1Series = smma(hl2, config.midPeriod1);
  const m2Series = smma(hl2, config.midPeriod2);
  const v2Series = smma(hl2, config.baselinePeriod);

  let position: PositionState = startPosition;
  const out: LarssonDayResult[] = [];

  for (let i = 0; i < ratioCandles.length; i++) {
    const candle = ratioCandles[i]!;
    const v1 = v1Series[i]!;
    const m1 = m1Series[i]!;
    const m2 = m2Series[i]!;
    const v2 = v2Series[i]!;
    let switched = false;
    let regime: LarssonRegime = "gray";
    let distFromBaseline = NaN;
    let reason = `Holding ${position}; insufficient history for the baseline SMMA${config.baselinePeriod}.`;

    if (!Number.isNaN(v1) && !Number.isNaN(m1) && !Number.isNaN(m2) && !Number.isNaN(v2)) {
      const isGray = (v1 < m1 !== v1 < v2) || (m2 < v2 !== v1 < v2);
      regime = isGray ? "gray" : v1 > v2 ? "orange" : "navy";
      distFromBaseline = (candle.close - v2) / v2;
      reason = `Holding ${position}.`;

      if (position === "long") {
        if (regime === "orange" && distFromBaseline <= config.entryMaxDistFraction) {
          position = "flat";
          switched = true;
          reason = `Regime orange (v1 ${v1.toFixed(4)} > baseline ${v2.toFixed(4)}), ${(distFromBaseline * 100).toFixed(1)}% above baseline (<= ${(config.entryMaxDistFraction * 100).toFixed(1)}% max entry distance). Rotating BTC -> asset.`;
        } else if (regime === "orange") {
          reason = `Regime orange but ${(distFromBaseline * 100).toFixed(1)}% above baseline exceeds the ${(config.entryMaxDistFraction * 100).toFixed(1)}% max entry distance - not chasing. Holding long.`;
        }
      } else {
        if (regime === "navy" || regime === "gray") {
          position = "long";
          switched = true;
          reason = `Regime ${regime} (reversal/transition away from orange). Rotating asset -> BTC.`;
        } else if (distFromBaseline >= config.overextensionFraction) {
          position = "long";
          switched = true;
          reason = `${(distFromBaseline * 100).toFixed(1)}% above baseline >= ${(config.overextensionFraction * 100).toFixed(1)}% overextension target. Rotating asset -> BTC (take profit, overextended).`;
        }
      }
    }

    out.push({
      timestamp: candle.timestamp,
      r: candle.close,
      v1,
      m1,
      m2,
      v2,
      regime,
      distFromBaseline,
      position,
      switched,
      reason,
    });
  }

  return out;
}
