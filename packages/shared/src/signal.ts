import type { PositionState, Regime } from "./position.js";
import type { ConfluenceZone } from "./marketData.js";

export type Confirmation =
  | { kind: "reversal_candle"; pattern: "engulfing" | "hammer" | "shooting_star" }
  | { kind: "volume_breakout"; volumeMultipleOfAverage: number }
  | { kind: "rsi_extreme"; rsi: number; direction: "overbought" | "oversold" };

/**
 * Output of the pure decide() function in @autopilot/strategy.
 * target is the *desired* position; the gate/execute stages are responsible
 * for getting there via layered orders (design doc Section 8), not this type.
 */
export interface StrategyDecision {
  timestamp: number;
  regime: Regime;
  target: PositionState;
  /** Present only when target changes and there's a specific zone driving it. */
  confluenceZone?: ConfluenceZone;
  confirmation?: Confirmation;
  /** 0-1 confidence heuristic, informational only, not sized directly. */
  confidence: number;
  reason: string;
}
