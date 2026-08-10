import type {
  Candle,
  Confirmation,
  PositionState,
  StrategyConfig,
  StrategyDecision,
} from "@autopilot/shared";
import { detectRegime } from "./regime.js";
import { findConfluenceZones, priceAtConfirmedConfluence } from "./confluence.js";
import { findReversalConfirmation, findVolumeBreakoutConfirmation } from "./confirmation.js";
import { rsi } from "./indicators.js";

export interface DecideInput {
  /** Daily candles, oldest first, enough history for the slow EMA (>= slowEmaPeriod + swing lookback). */
  dailyCandles: Candle[];
  /** 4H candles for entry refinement. Not required for this decision to run, reserved for future use. */
  fourHourCandles?: Candle[];
  currentPosition: PositionState;
  config: StrategyConfig;
}

/**
 * Pure decision function - no I/O, no side effects, fully unit-testable.
 * target is always PositionState ("flat" | "long"); short is unrepresentable
 * by construction (design doc Section 3).
 */
export function decide(input: DecideInput): StrategyDecision {
  const { dailyCandles, currentPosition, config } = input;
  const last = dailyCandles[dailyCandles.length - 1];

  if (!last || dailyCandles.length < config.regime.slowEmaPeriod + 5) {
    return {
      timestamp: last?.timestamp ?? Date.now(),
      regime: "neutral",
      target: currentPosition,
      confidence: 0,
      reason: "Insufficient history for regime detection; holding current position.",
    };
  }

  const regime = detectRegime(dailyCandles, config.regime.fastEmaPeriod, config.regime.slowEmaPeriod);
  const zones = findConfluenceZones(
    dailyCandles,
    3,
    config.confluence.toleranceFraction
  );
  const confirmedZone = priceAtConfirmedConfluence(last.close, zones);

  const closes = dailyCandles.map((c) => c.close);
  const rsiSeries = rsi(closes, config.contrarian.rsiPeriod);
  const lastRsi = rsiSeries[rsiSeries.length - 1];

  let confirmation: Confirmation | undefined;
  let target: PositionState = currentPosition;
  let reason = `Regime ${regime}; no qualifying setup, holding ${currentPosition}.`;

  if (currentPosition === "flat") {
    if (regime === "bullish" && confirmedZone) {
      confirmation =
        findReversalConfirmation(dailyCandles, "bullish") ??
        findVolumeBreakoutConfirmation(dailyCandles, 20, 1.5);
      if (confirmation) {
        target = "long";
        reason = `Bullish regime, price at confirmed confluence zone (fib ${confirmedZone.fib.level}), confirmation: ${confirmation.kind}. Rotating XAUT -> BTC.`;
      }
    } else if (
      regime === "neutral" &&
      config.contrarian.enabled &&
      lastRsi !== undefined &&
      !Number.isNaN(lastRsi) &&
      lastRsi <= config.contrarian.rsiOversold &&
      confirmedZone
    ) {
      confirmation = { kind: "rsi_extreme", rsi: lastRsi, direction: "oversold" };
      target = "long";
      reason = `Neutral regime, RSI oversold (${lastRsi.toFixed(1)}) at confluence support - contrarian long.`;
    }
  } else {
    // currentPosition === "long"
    if (regime === "bearish" && confirmedZone) {
      confirmation =
        findReversalConfirmation(dailyCandles, "bearish") ??
        findVolumeBreakoutConfirmation(dailyCandles, 20, 1.5);
      if (confirmation) {
        target = "flat";
        reason = `Bearish regime, price at confirmed confluence zone (fib ${confirmedZone.fib.level}), confirmation: ${confirmation.kind}. Rotating BTC -> XAUT.`;
      }
    } else if (
      regime === "neutral" &&
      config.contrarian.enabled &&
      lastRsi !== undefined &&
      !Number.isNaN(lastRsi) &&
      lastRsi >= config.contrarian.rsiOverbought &&
      confirmedZone
    ) {
      confirmation = { kind: "rsi_extreme", rsi: lastRsi, direction: "overbought" };
      target = "flat";
      reason = `Neutral regime, RSI overbought (${lastRsi.toFixed(1)}) at confluence resistance - contrarian exit to XAUT.`;
    }
  }

  const confidence =
    (regime !== "neutral" ? 0.4 : 0.15) +
    (confirmedZone ? 0.35 : 0) +
    (confirmation ? 0.25 : 0);

  const decision: StrategyDecision = {
    timestamp: last.timestamp,
    regime,
    target,
    confidence: Math.min(1, confidence),
    reason,
  };
  if (confirmedZone) decision.confluenceZone = confirmedZone;
  if (confirmation) decision.confirmation = confirmation;
  return decision;
}
