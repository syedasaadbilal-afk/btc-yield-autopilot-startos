import type { Candle, NavPoint, PairConfig } from "@autopilot/shared";
import { computeBtcEquivalentNav } from "@autopilot/shared";
import {
  replayLarssonRotation,
  toAccountingCandles,
  toLarssonInputCandles,
  type LarssonConfig,
  type LarssonDayResult,
} from "@autopilot/strategy";
import type { RoundTrip } from "./runBacktest.js";

export interface PairBacktestResult {
  pairKey: string;
  navHistory: NavPoint[];
  /** Full day-by-day Larsson replay, in btc-per-asset terms (see toLarssonInputCandles). */
  decisions: LarssonDayResult[];
  roundTrips: RoundTrip[];
  summary: {
    startingBtc: number;
    endingBtcEquivalentNav: number;
    totalBtcYieldFraction: number;
    numRoundTrips: number;
    numRoundTripsCompleted: number;
    winRate: number;
    maxDrawdownFraction: number;
  };
}

/**
 * Runs the Larsson Baseline + Overextension strategy (packages/strategy/src/
 * larssonRotation.ts) forward over one pair's historical candles, with no
 * slippage/fees (backtest baseline - see runBacktest.ts's equivalent note).
 * Starts holding BTC, using `startingBtc` = this pair's slice of total
 * capital (PairConfig.capitalFractionBtc), matching how the daemon allocates
 * capital per independent rotation instance.
 *
 * `rawCandles` must be exactly what pair.ratioSymbol returns (whichever
 * direction Bitfinex natively lists it in) - this function does both
 * conversions itself: btc-per-asset for the regime engine, asset-per-BTC for
 * the NAV/trade accounting below, via toLarssonInputCandles/toAccountingCandles.
 */
export function runPairBacktest(params: {
  rawCandles: Candle[];
  pair: PairConfig;
  larssonConfig: LarssonConfig;
  startingBtc: number;
}): PairBacktestResult {
  const { rawCandles, pair, larssonConfig, startingBtc } = params;

  const larssonInputCandles = toLarssonInputCandles(rawCandles, pair);
  const accountingCandles = toAccountingCandles(rawCandles, pair);
  const decisions = replayLarssonRotation(larssonInputCandles, larssonConfig, "long");

  let btcHeld = startingBtc;
  let xautHeld = 0; // this pair's rotation asset, see NavPoint.xautHeld doc comment

  const navHistory: NavPoint[] = [];
  const roundTrips: RoundTrip[] = [];
  let openRoundTrip: RoundTrip | undefined;

  for (let i = 0; i < accountingCandles.length; i++) {
    const candle = accountingCandles[i]!;
    const ratio = candle.close; // asset-per-BTC
    const day = decisions[i]!;

    if (day.switched) {
      if (day.position === "flat") {
        // long -> flat: sell BTC for the rotation asset at today's ratio.
        xautHeld = btcHeld * ratio;
        openRoundTrip = { exitedLongAtIndex: i, btcBefore: btcHeld };
        btcHeld = 0;
      } else {
        // flat -> long: buy BTC with the rotation asset at today's ratio.
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
      pairKey: pair.key,
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
    pairKey: pair.key,
    navHistory,
    decisions,
    roundTrips,
    summary: {
      startingBtc,
      endingBtcEquivalentNav,
      totalBtcYieldFraction: startingBtc > 0 ? (endingBtcEquivalentNav - startingBtc) / startingBtc : 0,
      numRoundTrips: roundTrips.length,
      numRoundTripsCompleted: completed.length,
      winRate: completed.length > 0 ? wins / completed.length : 0,
      maxDrawdownFraction: maxDrawdown(navHistory),
    },
  };
}

export interface PortfolioBacktestResult {
  totalStartingBtc: number;
  endingBtcEquivalentNav: number;
  totalBtcYieldFraction: number;
  perPair: PairBacktestResult[];
}

/**
 * Runs runPairBacktest() independently for every configured pair (each
 * getting its own slice of totalStartingBtc per capitalFractionBtc) and
 * sums the resulting BTC-equivalent NAVs into a single portfolio figure -
 * the actual headline number for "did this maximize BTC yield" across both
 * rotation instances combined.
 */
export function runPortfolioBacktest(params: {
  /** Raw candles per pair key, each exactly as pair.ratioSymbol returned them. */
  rawCandlesByPairKey: Record<string, Candle[]>;
  pairs: readonly PairConfig[];
  larssonConfig: LarssonConfig;
  totalStartingBtc: number;
}): PortfolioBacktestResult {
  const { rawCandlesByPairKey, pairs, larssonConfig, totalStartingBtc } = params;

  const perPair = pairs.map((pair) => {
    const rawCandles = rawCandlesByPairKey[pair.key];
    if (!rawCandles || rawCandles.length === 0) {
      throw new Error(`No candles supplied for pair "${pair.key}" (${pair.ratioSymbol}).`);
    }
    return runPairBacktest({
      rawCandles,
      pair,
      larssonConfig,
      startingBtc: totalStartingBtc * pair.capitalFractionBtc,
    });
  });

  const endingBtcEquivalentNav = perPair.reduce((sum, p) => sum + p.summary.endingBtcEquivalentNav, 0);

  return {
    totalStartingBtc,
    endingBtcEquivalentNav,
    totalBtcYieldFraction:
      totalStartingBtc > 0 ? (endingBtcEquivalentNav - totalStartingBtc) / totalStartingBtc : 0,
    perPair,
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
