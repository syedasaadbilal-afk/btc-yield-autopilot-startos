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
  const { runMode, currentPosition, decision, now, lastStopOutAt, config } = input;
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

  // Drawdown circuit breaker: REMOVED (bug found live Sep 2026, round 8) -
  // "isEntering" in this bot means flipping OUT of the rotation asset and
  // INTO pooled BTC, i.e. exiting the losing position, not chasing a new
  // risky one. Gating that transition on a NAV decline doesn't protect
  // against anything - it does the opposite, trapping the account in
  // whichever asset already dropped instead of letting the regime signal
  // rotate it to safety. Confirmed live: XAUT's regime correctly called for
  // an exit to BTC and was blocked here at up to 69% "drawdown" (partly a
  // stale-peak accounting bug, fixed separately via funding_baseline
  // filtering - but even the TRUE post-fix ~31% reading kept blocking a
  // real exit). Per explicit instruction: the live daemon must match the
  // backtested Larsson Baseline + Overextension Rotation strategy on
  // TradingView exactly, which has no such gate and already executed this
  // exit. currentBtcDrawdownFraction is kept below (still config-displayed
  // on the Config tab, and available for future read-only reporting) but no
  // longer blocks any gate decision.

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
