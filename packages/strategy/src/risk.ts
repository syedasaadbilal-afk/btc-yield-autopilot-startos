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
 * BTC amount risked at the stop and the staggered tranche sizes to deploy it in
 * (design doc Section 4: 25/25/50; Section 0: BTC-denominated, not USD).
 */
export function computeTrancheBtcAmounts(
  btcCapital: number,
  config: StrategyConfig
): number[] {
  const riskBtc = btcCapital * config.risk.riskFractionPerTrade;
  return config.risk.trancheWeights.map((w) => riskBtc * w);
}
