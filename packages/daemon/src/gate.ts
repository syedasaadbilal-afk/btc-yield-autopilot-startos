import type { NavPoint, PositionState, RunMode, StrategyConfig } from "@autopilot/shared";

/**
 * Only the field gate() actually reads. Both the legacy StrategyDecision and
 * the active RotationDayResult (via a `{ target: day.position }` adapter in
 * loop.ts) satisfy this, so gate.ts doesn't need to know which decision
 * source produced it.
 */
export interface GateDecision {
  target: PositionState;
}

export interface GateInput {
  runMode: RunMode;
  currentPosition: PositionState;
  decision: GateDecision;
  now: number;
  lastStopOutAt?: number;
  navHistory: NavPoint[]; // ascending by timestamp, used for the drawdown circuit breaker
  config: StrategyConfig;
}

export interface GateResult {
  allow: boolean;
  reason: string;
}

/**
 * Risk + safety gate between decide() and execute() (design doc: "observe ->
 * decide -> gate -> execute -> persist"). Pure function, no I/O - everything
 * it needs is passed in, everything it needs to know is read from BTC-
 * denominated state per design doc Section 0.
 */
export function gate(input: GateInput): GateResult {
  const { runMode, currentPosition, decision, now, lastStopOutAt, navHistory, config } = input;
  const isEntering = decision.target === "long" && currentPosition === "flat";
  const isExiting = decision.target === "flat" && currentPosition === "long";

  if (!isEntering && !isExiting) {
    return { allow: true, reason: "No position change requested." };
  }

  // PAUSED: exits/stops still run, new entries are blocked.
  if (runMode === "PAUSED" && isEntering) {
    return { allow: false, reason: "Run mode is PAUSED; new entries are blocked." };
  }

  // Cooldown after a stop-out (design doc Section 4).
  if (isEntering && lastStopOutAt !== undefined) {
    const cooldownMs = config.risk.cooldownDaysAfterStop * 24 * 60 * 60 * 1000;
    const elapsed = now - lastStopOutAt;
    if (elapsed < cooldownMs) {
      return {
        allow: false,
        reason: `Cooldown active: ${Math.ceil((cooldownMs - elapsed) / (60 * 60 * 1000))}h remaining after last stop-out.`,
      };
    }
  }

  // Drawdown circuit breaker, computed on the BTC-equivalent NAV curve (design doc Section 0).
  if (isEntering) {
    const drawdown = currentBtcDrawdownFraction(navHistory);
    if (drawdown >= config.risk.drawdownCircuitBreakerFraction) {
      return {
        allow: false,
        reason: `BTC drawdown circuit breaker tripped: ${(drawdown * 100).toFixed(1)}% from peak BTC NAV.`,
      };
    }
  }

  return { allow: true, reason: "Gate checks passed." };
}

/** Fraction below the running peak of btcEquivalentNav. 0 if no history or at/above peak. */
export function currentBtcDrawdownFraction(navHistory: NavPoint[]): number {
  if (navHistory.length === 0) return 0;
  let peak = navHistory[0]!.btcEquivalentNav;
  for (const point of navHistory) {
    if (point.btcEquivalentNav > peak) peak = point.btcEquivalentNav;
  }
  const latest = navHistory[navHistory.length - 1]!.btcEquivalentNav;
  if (peak <= 0) return 0;
  return Math.max(0, (peak - latest) / peak);
}
