import type { Candle, StrategyConfig } from "@autopilot/shared";
import { atr } from "./indicators.js";

export interface StopAndTarget {
  stopPrice: number;
  firstTargetPrice: number;
  riskPerUnit: number;
  rewardRiskRatio: number;
}

/**
 * ATR-buffered stop below/above entry, sized so first-target R:R meets the
 * config minimum (design doc Section 4: minimum 2:1).
 */
export function computeStopAndTarget(
  candles: Candle[],
  entryPrice: number,
  direction: "long" | "short_exit_reference",
  config: StrategyConfig
): StopAndTarget {
  const atrSeries = atr(candles, config.risk.atrPeriod);
  const lastAtr = atrSeries[atrSeries.length - 1] ?? 0;
  const buffer = lastAtr * config.risk.atrStopMultiplier;

  const stopPrice = direction === "long" ? entryPrice - buffer : entryPrice + buffer;
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  const rewardDistance = riskPerUnit * config.risk.minRewardRiskRatio;
  const firstTargetPrice =
    direction === "long" ? entryPrice + rewardDistance : entryPrice - rewardDistance;

  return {
    stopPrice,
    firstTargetPrice,
    riskPerUnit,
    rewardRiskRatio: config.risk.minRewardRiskRatio,
  };
}

/**
 * Splits the FULL requested BTC capital into staggered tranche sizes to
 * deploy it in (design doc Section 4: 25/25/50; Section 0: BTC-denominated,
 * not USD).
 *
 * Bug found live Aug 2026: this used to scale btcCapital down by
 * config.risk.riskFractionPerTrade (~1.5%) first, treating every rotation
 * like a single stop-bounded signal trade risking a small slice of total
 * capital. But every caller (loop.ts's Case 1 flip and Case 2a cross-pair
 * resize) already computes btcCapital as the EXACT full amount that needs to
 * move to hit a target allocation fraction or fully exit a position - so the
 * 1.5% scaling silently shrunk every single rotation to ~1.5% of what was
 * requested, which then routinely failed Bitfinex's minimum order size even
 * for a full-position exit. No test caught this because every daemon-level
 * test fixture stubs getMinOrderSize to 0, which bypasses the minimum check
 * regardless of amount. riskFractionPerTrade remains in config (still shown
 * on the Config tab) but is no longer applied here; real risk control comes
 * from the regime engine itself, the ATR stop/cooldown (gate.ts), and the
 * drawdown circuit breaker, not from capping every trade's size.
 */
export function computeTrancheBtcAmounts(
  btcCapital: number,
  config: StrategyConfig
): number[] {
  return config.risk.trancheWeights.map((w) => btcCapital * w);
}
