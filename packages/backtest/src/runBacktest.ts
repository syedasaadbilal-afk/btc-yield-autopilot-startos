import type { Candle, NavPoint, StrategyConfig } from "@autopilot/shared";
import { computeBtcEquivalentNav } from "@autopilot/shared";
import { replayRotation, type RotationDayResult } from "@autopilot/strategy";

export interface RoundTrip {
  /** Index into ratioCandles where the strategy rotated BTC -> XAUT. */
  exitedLongAtIndex: number;
  /** Index where it rotated back XAUT -> BTC. undefined if still flat at the end of history. */
  reenteredLongAtIndex?: number;
  btcBefore: number;
  btcAfter?: number;
  btcPnl?: number;
}

export interface BacktestResult {
  navHistory: NavPoint[];
  /** Full day-by-day rotation replay (see @autopilot/strategy/rotation.ts). */
  decisions: RotationDayResult[];
  roundTrips: RoundTrip[];
  summary: {
    startingBtc: number;
    endingBtcEquivalentNav: number;
    /** (ending - starting) / starting - the headline number per design doc Section 0. */
    totalBtcYieldFraction: number;
    numRoundTrips: number;
    numRoundTripsCompleted: number;
    winRate: number;
    maxDrawdownFraction: number;
  };
}

/**
 * Runs the BTC/XAUT rotation strategy (packages/strategy/src/rotation.ts,
 * ported from the "Larsson + BTC/Gold Rotation" reference, with added
 * anti-whipsaw dampening) forward over historical ratio candles, simulating
 * the flat<->long rotation with no slippage/fees (backtest baseline - the
 * layered-execution slippage model in @autopilot/execution is a separate,
 * additive cost applied at the paper/live stage, not here). Starts holding
 * BTC (design doc: capital is 3 BTC already held), matching how the daemon
 * would actually be deployed.
 *
 * replayRotation() has no lookahead bias built in - each day's decision only
 * depends on the SMA/RSI computed up to and including that day - so it's
 * safe to replay the whole series in one call rather than re-slicing per day
 * as the legacy decide()-based backtest did.
 */
export function runBacktest(params: {
  ratioCandles: Candle[];
  config: StrategyConfig;
}): BacktestResult {
  const { ratioCandles, config } = params;
  const startingBtc = config.capital.startingBtc;

  const decisions = replayRotation(ratioCandles, config.rotation, "long");

  let btcHeld = startingBtc;
  let xautHeld = 0;

  const navHistory: NavPoint[] = [];
  const roundTrips: RoundTrip[] = [];
  let openRoundTrip: RoundTrip | undefined;

  for (let i = 0; i < ratioCandles.length; i++) {
    const candle = ratioCandles[i]!;
    const ratio = candle.close;
    const day = decisions[i]!;

    if (day.switched) {
      if (day.position === "flat") {
        // long -> flat: sell BTC for XAUT at today's ratio.
        xautHeld = btcHeld * ratio;
        openRoundTrip = { exitedLongAtIndex: i, btcBefore: btcHeld };
        btcHeld = 0;
      } else {
        // flat -> long: buy BTC with XAUT at today's ratio.
        const newBtc = xautHeld / ratio;
        if (openRoundTrip) {
          openRoundTrip.reenteredLongAtIndex = i;
          openRoundTrip.btcAfter = newBtc;
          openRoundTrip.btcPnl = newBtc - openRoundTrip.btcBefore;
          roundTrips.push(openRoundTrip);
          openRoundTrip = undefined;
        }
        btcHeld = newBtc;
        xautHeld = 0;
      }
    }

    navHistory.push({
      timestamp: candle.timestamp,
      btcHeld,
      xautHeld,
      btcXautRatio: ratio,
      btcEquivalentNav: computeBtcEquivalentNav(btcHeld, xautHeld, ratio),
    });
  }

  if (openRoundTrip) roundTrips.push(openRoundTrip);

  const endingBtcEquivalentNav = navHistory[navHistory.length - 1]?.btcEquivalentNav ?? startingBtc;
  const completed = roundTrips.filter((r) => r.btcPnl !== undefined);
  const wins = completed.filter((r) => (r.btcPnl ?? 0) > 0).length;

  return {
    navHistory,
    decisions,
    roundTrips,
    summary: {
      startingBtc,
      endingBtcEquivalentNav,
      totalBtcYieldFraction: (endingBtcEquivalentNav - startingBtc) / startingBtc,
      numRoundTrips: roundTrips.length,
      numRoundTripsCompleted: completed.length,
      winRate: completed.length > 0 ? wins / completed.length : 0,
      maxDrawdownFraction: maxDrawdown(navHistory),
    },
  };
}

function maxDrawdown(navHistory: NavPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const point of navHistory) {
    if (point.btcEquivalentNav > peak) peak = point.btcEquivalentNav;
    if (peak > 0) {
      const dd = (peak - point.btcEquivalentNav) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}
