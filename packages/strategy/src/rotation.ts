import type { Candle, PositionState } from "@autopilot/shared";
import { sma, rsi } from "./indicators.js";

/**
 * Config for the BTC/XAUT rotation system (ported from a working Pine Script
 * reference: "Larsson + BTC/Gold Rotation"). Replaces the earlier Fibonacci/
 * trendline confluence approach in decide.ts, which required ALL of
 * regime + confluence + confirmation to reverse before exiting a position -
 * on the 50/200 EMA regime filter that meant positions could sit unchanged
 * for years. This system gives the flat (XAUT) leg three independent exit
 * paths, which is what actually produces swing-length holds.
 */
export interface RotationConfig {
  /** SMA period on r = XAUT per BTC. 200 in the reference implementation. */
  smaPeriod: number;
  /** Enter XAUT when r < sma * (1 - entryBandFraction). 0.05 in the reference. */
  entryBandFraction: number;
  /** Minimum days since the last switch before a new entry is allowed. 90 in the reference. */
  cooldownDays: number;
  /** Exit XAUT back to BTC if r has risen this fraction above the entry r. 0.20 in the reference. */
  momentumTakeProfitFraction: number;
  /** RSI period on r. 14 in the reference. */
  rsiPeriod: number;
  /** Exit XAUT back to BTC (capitulation re-entry) if RSI(r) drops below this. 25 in the reference. */
  rsiCapitulationThreshold: number;
  /**
   * Anti-whipsaw: minimum days the flat (XAUT) leg must be held before ANY
   * exit path (trend recovery, momentum, RSI capitulation) becomes eligible.
   * Not in the original Pine Script - added because the reference logic has
   * no cooldown on the flat->long direction, so in sideways/choppy markets a
   * bounce the very next bar after entry flips straight back to BTC. On the
   * thin BTC/XAUT pair each flip costs real slippage, so this is a direct
   * cost control, not just a cosmetic smoothing knob. 0 reproduces the
   * original Pine Script behavior exactly.
   */
  minFlatHoldDays: number;
  /**
   * Anti-whipsaw: trend-recovery exit requires r to close this fraction
   * ABOVE the SMA, not just cross it (r > sma * (1 + exitConfirmBandFraction)).
   * A bare cross is exactly what noise around a flat SMA produces repeatedly
   * in sideways markets. 0 reproduces the original Pine Script's bare cross.
   */
  exitConfirmBandFraction: number;
}

export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  smaPeriod: 200,
  entryBandFraction: 0.05,
  cooldownDays: 90,
  momentumTakeProfitFraction: 0.2,
  rsiPeriod: 14,
  rsiCapitulationThreshold: 25,
  minFlatHoldDays: 10,
  exitConfirmBandFraction: 0.02,
};

export interface RotationDayResult {
  timestamp: number;
  /** r = XAUT per BTC (design doc's btcXautRatio convention). */
  r: number;
  sma: number;
  rsi: number;
  /** Position AFTER applying today's rule. */
  position: PositionState;
  switched: boolean;
  reason: string;
}

/**
 * Pure, deterministic replay of the rotation rules across a full candle
 * history. Because the system is path-dependent (cooldown days since last
 * switch, entry price for the momentum take-profit), it's implemented as a
 * full replay rather than a single-bar decision function - given the same
 * candles and config it always reproduces the same day-by-day state, so a
 * live caller can just replay all available history each tick and read the
 * last entry rather than persisting entryR/cooldown state separately.
 *
 * `ratioCandles.close` must already be r = XAUT per BTC (e.g. from the
 * `tBTC:XAUT` pair directly - base BTC, quote XAUT - which is exactly that
 * convention, no inversion needed).
 */
export function replayRotation(
  ratioCandles: Candle[],
  config: RotationConfig,
  startPosition: PositionState = "long"
): RotationDayResult[] {
  const closes = ratioCandles.map((c) => c.close);
  const smaSeries = sma(closes, config.smaPeriod);
  const rsiSeries = rsi(closes, config.rsiPeriod);

  let position: PositionState = startPosition;
  let entryR: number | undefined;
  let lastSwitchIndex = -Infinity;
  const out: RotationDayResult[] = [];

  for (let i = 0; i < ratioCandles.length; i++) {
    const r = closes[i]!;
    const smaVal = smaSeries[i]!;
    const rsiVal = rsiSeries[i]!;
    let switched = false;
    let reason = `Holding ${position}; insufficient history for SMA${config.smaPeriod}.`;

    if (!Number.isNaN(smaVal)) {
      reason = `Holding ${position}.`;

      if (position === "long") {
        const daysSinceSwitch = i - lastSwitchIndex;
        const entryBand = smaVal * (1 - config.entryBandFraction);
        if (r < entryBand && daysSinceSwitch >= config.cooldownDays) {
          position = "flat";
          entryR = r;
          lastSwitchIndex = i;
          switched = true;
          reason = `r ${r.toFixed(4)} below SMA${config.smaPeriod} entry band ${entryBand.toFixed(4)} (cooldown satisfied: ${daysSinceSwitch}d since last switch). Rotating BTC -> XAUT.`;
        } else if (r < entryBand) {
          reason = `r ${r.toFixed(4)} below entry band but cooldown not satisfied (${daysSinceSwitch}/${config.cooldownDays}d). Holding long.`;
        }
      } else {
        const daysSinceEntry = i - lastSwitchIndex;
        const holdSatisfied = daysSinceEntry >= config.minFlatHoldDays;

        if (!holdSatisfied) {
          reason = `Holding flat; minimum hold (${daysSinceEntry}/${config.minFlatHoldDays}d) not yet satisfied.`;
        } else {
          const exitBand = smaVal * (1 + config.exitConfirmBandFraction);
          const trendHit = r > exitBand;
          const momentumHit = entryR !== undefined && r / entryR - 1 > config.momentumTakeProfitFraction;
          const rsiHit = !Number.isNaN(rsiVal) && rsiVal < config.rsiCapitulationThreshold;

          if (trendHit || momentumHit || rsiHit) {
            position = "long";
            lastSwitchIndex = i;
            switched = true;
            reason = trendHit
              ? `r ${r.toFixed(4)} back above SMA${config.smaPeriod} exit-confirm band ${exitBand.toFixed(4)}. Rotating XAUT -> BTC (trend recovery).`
              : momentumHit
                ? `r up ${(((r / entryR!) - 1) * 100).toFixed(1)}% from entry ${entryR!.toFixed(4)}. Rotating XAUT -> BTC (momentum take-profit).`
                : `RSI${config.rsiPeriod}(r) ${rsiVal.toFixed(1)} < ${config.rsiCapitulationThreshold}. Rotating XAUT -> BTC (capitulation re-entry).`;
            entryR = undefined;
          }
        }
      }
    }

    out.push({
      timestamp: ratioCandles[i]!.timestamp,
      r,
      sma: smaVal,
      rsi: rsiVal,
      position,
      switched,
      reason,
    });
  }

  return out;
}
