import type { Candle, PairConfig, PositionState, StrategyConfig } from "@autopilot/shared";
import { computeBtcEquivalentNav } from "@autopilot/shared";
import {
  computePortfolioAllocation,
  computeStopAndTarget,
  replayLarssonRotation,
  toAccountingCandles,
  toLarssonInputCandles,
  type LarssonDayResult,
  type LarssonRegime,
} from "@autopilot/strategy";
import type { BitfinexRestClient } from "@autopilot/bitfinex-client";
import type { Repo } from "./db/repo.js";
import { gate } from "./gate.js";
import { executeRotation } from "./execute.js";

export interface LoopDeps {
  client: BitfinexRestClient;
  repo: Repo;
  config: StrategyConfig;
  now?: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bitfinex's candles/hist endpoint includes the still-forming "today" bar as
 * its last row (confirmed empirically: fetching live returns a row whose
 * timestamp is today's UTC midnight, with OHLC that keeps changing as the
 * day progresses) - it does NOT stop at the last fully-closed daily bar.
 * TradingView's own Pine Script only fires strategy.entry()/exit() markers on
 * a confirmed (barstate.isconfirmed) bar close, specifically to avoid
 * repainting a signal off intraday noise that can still reverse before
 * midnight UTC. Feeding the unclosed bar into replayLarssonRotation()
 * without this guard let the daemon call/flip a regime mid-day that
 * TradingView wouldn't act on until the bar actually closes - e.g. a
 * navy->orange flip sitting a hair over the entry threshold that's still
 * live and could tick back under before end of day. Dropping it here makes
 * the regime/decision path match TradingView's confirmed-bar behavior;
 * accounting/execution pricing (accountingCandles, below) intentionally
 * keeps the live bar since mark-to-market and entry price should reflect
 * the current price, not yesterday's close.
 */
function dropUnclosedDailyCandle<T extends { timestamp: number }>(candles: T[], now: number): T[] {
  if (candles.length === 0) return candles;
  const last = candles[candles.length - 1]!;
  return last.timestamp + ONE_DAY_MS > now ? candles.slice(0, -1) : candles;
}

/**
 * On every tick after the first, `currentPosition = openTrade ? "long" :
 * "flat"` (below) is trustworthy - the daemon's own trades table is the
 * ground truth once it's been seeded correctly, since every rotation this
 * process makes updates it. But on a pair's very first-ever tick (no NAV
 * point recorded yet), an empty trades table just means "no trade opened
 * BY THIS DAEMON" - it says nothing about what's actually sitting in the
 * exchange wallet right now (funded manually, left over from a prior
 * manual reconciliation, etc.). Defaulting blindly to "flat" there is
 * exactly the class of bug this session already had to fix by hand once
 * (see the manual XAUT/XMR reconciliation earlier this session) - this
 * makes that check automatic instead of relying on a human to notice.
 *
 * Only used for the bootstrap case; falls back to the DB-derived value (and
 * logs why) if the wallet read fails, rather than blocking the tick.
 */
async function deriveBootstrapPosition(params: {
  client: BitfinexRestClient;
  pair: PairConfig;
  /** btc-per-asset price (Larsson convention) for converting the asset balance to BTC terms. */
  btcPerAsset: number;
  dbDerivedPosition: PositionState;
}): Promise<PositionState> {
  const { client, pair, btcPerAsset, dbDerivedPosition } = params;
  try {
    const wallets = await client.getWallets();
    const btcBalance = wallets.find((w) => w.currency === "BTC")?.balance ?? 0;
    const assetBalance = wallets.find((w) => w.currency === pair.assetCurrency)?.balance ?? 0;
    const assetBalanceInBtc = btcPerAsset > 0 ? assetBalance * btcPerAsset : 0;

    // Nothing in either wallet (unfunded account, or - in tests - a mock
    // with no balances at all): there's no real signal to infer from, so
    // trust the DB default rather than forcing a guess ("long" would be
    // wrong here just as often as "flat").
    if (btcBalance <= 0 && assetBalanceInBtc <= 0) {
      console.log(`[${pair.key}] bootstrap position check: both wallets empty, keeping DB-derived "${dbDerivedPosition}".`);
      return dbDerivedPosition;
    }

    // Otherwise, whichever side actually holds more BTC-equivalent value
    // wins - a small dust balance on the "wrong" side (e.g. leftover BTC
    // after a partial fill) shouldn't flip the inferred position.
    const inferred: PositionState = assetBalanceInBtc > btcBalance ? "flat" : "long";
    console.log(
      `[${pair.key}] bootstrap position check: BTC=${btcBalance.toFixed(8)}, ${pair.assetCurrency}=${assetBalance.toFixed(8)} (${assetBalanceInBtc.toFixed(8)} BTC-equiv) -> inferred "${inferred}" (DB-derived default was "${dbDerivedPosition}").`
    );
    return inferred;
  } catch (err) {
    console.warn(
      `[${pair.key}] bootstrap wallet check failed, falling back to DB-derived position "${dbDerivedPosition}": ${err instanceof Error ? err.message : String(err)}`
    );
    return dbDerivedPosition;
  }
}

export interface PairLoopResult {
  pairKey: string;
  currentPosition: PositionState;
  decisionTarget: PositionState;
  gateAllowed: boolean;
  gateReason: string;
  rotated: boolean;
  /** This pair's applied capital-allocation fraction this tick (see computePortfolioAllocation). */
  targetFraction: number;
  /** Present if this pair's tick threw (e.g. a symbol/network error) - see runControlLoopIteration. */
  error?: string;
}

interface PairObservation {
  pair: PairConfig;
  today: LarssonDayResult;
  accountingCandles: Candle[];
  currentPosition: PositionState;
  openTrade: ReturnType<Repo["getOpenTrade"]>;
}

/**
 * observe + decide for one pair (design doc: "observe -> decide -> gate ->
 * execute -> persist"). Split out from the old single runPairLoopIteration
 * so runControlLoopIteration can gather every configured pair's regime
 * BEFORE any pair's gate/execute step runs - computePortfolioAllocation
 * needs both XAUT's and XMR's regime at once to size either one (see
 * portfolioAllocation.ts).
 */
async function observeAndDecide(deps: LoopDeps & { pair: PairConfig }): Promise<PairObservation> {
  const { client, repo, config, pair } = deps;
  const now = deps.now ?? Date.now();
  // Only used as a last-resort fallback (this pair's very first NAV point,
  // with nothing traded yet this tick) - see the persist step below.
  const pairStartingBtcFallback = config.capital.startingBtc * pair.capitalFractionBtc;

  const openTrade = repo.getOpenTrade(pair.key);
  const dbDerivedPosition: PositionState = openTrade ? "long" : "flat";
  const lookback = Number(process.env.LARSSON_LOOKBACK_CANDLES ?? 2000);
  const rawCandles = await client.getCandles(pair.ratioSymbol, "1D", lookback);
  // Regime/decision math only ever looks at confirmed closed bars (see
  // dropUnclosedDailyCandle above) - matches TradingView's own strategy
  // behavior and avoids acting on a signal that's still moving intraday.
  const closedRawCandles = dropUnclosedDailyCandle(rawCandles, now);
  const larssonInputCandles = toLarssonInputCandles(closedRawCandles, pair);
  // Accounting/execution pricing keeps the live bar - NAV mark-to-market and
  // any entry price taken today should use the current price, not
  // yesterday's stale close.
  const accountingCandles = toAccountingCandles(rawCandles, pair);

  // Bootstrap: only on this pair's very first-ever tick (no NAV point
  // recorded yet) does an empty trades table need real-wallet verification -
  // see deriveBootstrapPosition. Every later tick trusts the DB, since by
  // then it's this daemon's own authoritative bookkeeping.
  const isFirstTickForPair = repo.getLatestNavPoint(pair.key) === undefined;
  const currentPosition: PositionState = isFirstTickForPair
    ? await deriveBootstrapPosition({
        client,
        pair,
        btcPerAsset: larssonInputCandles[larssonInputCandles.length - 1]?.close ?? 0,
        dbDerivedPosition,
      })
    : dbDerivedPosition;

  // Persist the bootstrap correction: if wallet balances say "long" (holding
  // BTC) but no open trade row exists yet, every later tick's DB-derived
  // position (openTrade ? "long" : "flat") would silently revert to "flat"
  // without this - the wallet check above only runs on tick 1
  // (isFirstTickForPair), so the DB needs to actually reflect reality once,
  // here, for tick 2+ to stay correct on its own.
  if (isFirstTickForPair && currentPosition === "long" && !openTrade) {
    const bootstrapEntryPrice = accountingCandles[accountingCandles.length - 1]?.close ?? 0;
    repo.insertTrade({
      id: `${pair.key}-bootstrap-${now}`,
      runMode: repo.getRunMode(),
      pairKey: pair.key,
      openedAt: now,
      targetPosition: "long",
      btcCapitalAtOpen: pairStartingBtcFallback,
      riskFractionOfCapital: config.risk.riskFractionPerTrade,
      stopLossRatio: bootstrapEntryPrice,
      firstTargetRatio: bootstrapEntryPrice,
      status: "open",
      trancheExecutionPlanIds: [],
      notes: "Bootstrap-inferred from real wallet balances on this pair's first tick, not opened by this daemon.",
    });
  }

  // decide (pure) - strictly this pair's own Larsson replay. Cross-pair
  // allocation (computePortfolioAllocation, applied in gateAndExecute below)
  // only changes HOW MUCH capital this decision is sized against, never
  // WHETHER/WHEN it fires - that stays entirely driven by this pair's own
  // regime/baseline-distance rules, matching the user's explicit
  // instruction that "actual entry and exit will still follow the pine
  // script."
  const rotationHistory = replayLarssonRotation(larssonInputCandles, config.larsson, "long");
  const today = rotationHistory[rotationHistory.length - 1]!;
  repo.insertLarssonDecision(pair.key, today);

  if (today.position !== currentPosition && !today.switched) {
    // The replay's own tracked position disagrees with the daemon's ground
    // truth (repo.getOpenTrade(pair.key)) on a day where it didn't think a
    // switch happened - most likely the fetched window doesn't reach back
    // far enough. Trust the replay's verdict but surface it.
    console.warn(
      `[${pair.key}] Larsson replay position (${today.position}) disagrees with daemon ground truth (${currentPosition}) without a switch today - consider increasing LARSSON_LOOKBACK_CANDLES.`
    );
  }

  return { pair, today, accountingCandles, currentPosition, openTrade };
}

/**
 * gate + execute + persist for one pair, given its own observation plus the
 * dynamic capital-allocation fraction computePortfolioAllocation assigned it
 * this tick (see runControlLoopIteration). Handles three distinct cases:
 *   1. A flat<->long flip (this pair's own Larsson decision changed) - sized
 *      against the dynamic target fraction on entry, against the full
 *      currently-held value on exit (same as before this feature).
 *   2. A resize (still flat/holding the asset, no flip, but the cross-pair
 *      target fraction shifted since it was last applied) - a NEW case this
 *      feature adds, since replayLarssonRotation only ever models flat<->long
 *      and has no notion of resizing within an already-held position.
 *   3. Neither - just mark-to-market and persist a NAV point.
 */
async function gateAndExecute(
  deps: LoopDeps,
  obs: PairObservation,
  targetFraction: number,
  totalPortfolioBtc: number
): Promise<PairLoopResult> {
  const { client, repo, config } = deps;
  const now = deps.now ?? Date.now();
  const { pair, today, accountingCandles, currentPosition, openTrade } = obs;
  const decision = { target: today.position };

  const runMode = repo.getRunMode();
  const navHistory = repo.getNavHistory(pair.key);
  const lastStopOutAt = repo.getLastStopOutAt(pair.key);
  const gateResult = gate({
    runMode,
    currentPosition,
    decision,
    now,
    navHistory,
    config,
    ...(lastStopOutAt !== undefined ? { lastStopOutAt } : {}),
  });

  let rotated = false;
  // BTC-denominated size of whatever trade actually executed this tick
  // (entry, exit, or resize) - used below to update this pair's held units
  // for NAV mark-to-market without re-querying the exchange.
  let executedBtcCapital = 0;
  let executedDirection: "into_asset" | "into_btc" | null = null;

  // Case 1: entry/exit flip, exactly as before this feature - only the
  // entry-sizing basis is new (dynamic targetFraction * totalPortfolioBtc
  // instead of the old static pairStartingBtc).
  if (gateResult.allow && decision.target !== currentPosition) {
    const latestNav = repo.getLatestNavPoint(pair.key);
    const targetBtc = totalPortfolioBtc * targetFraction;
    // Exiting rotates out the full currently-held value, same as before.
    // Entering sizes against this tick's dynamic target fraction.
    const btcCapital = decision.target === "long" ? (latestNav?.btcEquivalentNav ?? targetBtc) : targetBtc;
    const side = decision.target === "long" ? "buy_btc_with_xaut" : "sell_btc_for_xaut";

    const executeResult = await executeRotation({ client, side, btcCapital, pair, config });
    for (const rd of executeResult.routeDecisions) {
      console.log(
        `[${pair.key}] tranche ${rd.trancheIndex} routed via "${rd.route}" (direct ${rd.directSlippageBtc.toFixed(6)} BTC vs usdt ${rd.usdtSlippageBtc.toFixed(6)} BTC estimated slippage)`
      );
    }
    rotated = true;
    executedBtcCapital = btcCapital;
    executedDirection = decision.target === "long" ? "into_btc" : "into_asset";

    if (decision.target === "long") {
      const entryPrice = accountingCandles[accountingCandles.length - 1]!.close;
      const stopAndTarget = computeStopAndTarget(accountingCandles, entryPrice, "long", config);
      repo.insertTrade({
        id: `${pair.key}-${now}`,
        runMode,
        pairKey: pair.key,
        openedAt: now,
        targetPosition: "long",
        btcCapitalAtOpen: btcCapital,
        riskFractionOfCapital: config.risk.riskFractionPerTrade,
        stopLossRatio: stopAndTarget.stopPrice,
        firstTargetRatio: stopAndTarget.firstTargetPrice,
        status: "open",
        trancheExecutionPlanIds: [],
      });
    } else if (openTrade) {
      // TODO: compute realized BTC P&L from actual fills once PAPER-mode fill
      // data is available; this scaffold doesn't yet reconcile exact clip
      // fills against the opening tranche, so it can't mark win/loss precisely.
      repo.closeTrade(openTrade.id, "closed_win", 0);
    }
    repo.setAllocationFraction(pair.key, targetFraction);
  } else if (gateResult.allow && currentPosition === "flat") {
    // Case 2: resize while already flat (holding the asset). This pair's own
    // Larsson decision did NOT change (decision.target === currentPosition
    // here, or the flip branch above would have run) - only the cross-pair
    // target fraction did. Compare against the last-APPLIED fraction
    // (allocation_state), not against NAV drift, so ordinary price movement
    // in the held asset never triggers a trade - only a genuine regime-driven
    // reallocation does.
    const lastAppliedFraction = repo.getAllocationFraction(pair.key);
    const fractionChanged =
      lastAppliedFraction === undefined || Math.abs(lastAppliedFraction - targetFraction) > 1e-9;

    if (fractionChanged) {
      const targetBtc = totalPortfolioBtc * targetFraction;
      const currentNav = repo.getLatestNavPoint(pair.key)?.btcEquivalentNav ?? 0;
      const delta = targetBtc - currentNav; // positive = need to buy more asset; negative = sell some back to BTC
      const DUST_FRACTION_OF_PORTFOLIO = 0.001; // ignore resizes smaller than 0.1% of total portfolio (fee/rounding noise)
      const dustThresholdBtc = totalPortfolioBtc * DUST_FRACTION_OF_PORTFOLIO;

      if (Math.abs(delta) > dustThresholdBtc) {
        const increasing = delta > 0;
        // Increasing this pair's allocation while already flat is
        // economically the same as a fresh entry (deploying more BTC
        // capital into a rotation asset) - it should respect the same
        // PAUSED protection gate() already applies to entries. Decreasing
        // (returning capital toward BTC) is treated like an exit, which
        // gate() always allows even when PAUSED - see gate.ts.
        if (increasing && runMode === "PAUSED") {
          console.log(
            `[${pair.key}] resize to ${(targetFraction * 100).toFixed(0)}% blocked: run mode is PAUSED (an allocation increase is gated the same as a fresh entry).`
          );
        } else {
          const side = increasing ? "sell_btc_for_xaut" : "buy_btc_with_xaut";
          const resizeBtcCapital = Math.abs(delta);
          console.log(
            `[${pair.key}] resizing allocation ${lastAppliedFraction !== undefined ? (lastAppliedFraction * 100).toFixed(0) + "%" : "unset"} -> ${(targetFraction * 100).toFixed(0)}% (${resizeBtcCapital.toFixed(8)} BTC, side ${side})`
          );
          const executeResult = await executeRotation({ client, side, btcCapital: resizeBtcCapital, pair, config });
          for (const rd of executeResult.routeDecisions) {
            console.log(
              `[${pair.key}] resize tranche ${rd.trancheIndex} routed via "${rd.route}" (direct ${rd.directSlippageBtc.toFixed(6)} BTC vs usdt ${rd.usdtSlippageBtc.toFixed(6)} BTC estimated slippage)`
            );
          }
          rotated = true;
          executedBtcCapital = resizeBtcCapital;
          executedDirection = increasing ? "into_asset" : "into_btc";
        }
      }
      repo.setAllocationFraction(pair.key, targetFraction);
    }
  }

  // Persist a NAV point every tick regardless of whether a rotation
  // happened, so this pair's BTC-equivalent equity curve has continuous
  // coverage. Units actually held (btcHeld/xautHeld) are carried forward
  // UNCHANGED from the previous tick when nothing traded - only today's
  // price (lastCandle.close) is refreshed, so the position properly marks
  // to market instead of freezing at whatever btcEquivalentNav it had the
  // day it was last traded (a pre-existing bug fixed as part of this
  // change: previously this derived held units by re-pricing yesterday's
  // total BTC-equivalent VALUE at today's rate, which mathematically
  // reproduces that same value every day and never actually moves with
  // price while flat).
  const lastCandle = accountingCandles[accountingCandles.length - 1];
  if (lastCandle) {
    const positionAfter: PositionState = rotated && decision.target !== currentPosition ? decision.target : currentPosition;
    const prevNav = repo.getLatestNavPoint(pair.key);

    let btcHeld: number;
    let assetHeld: number;

    if (rotated && executedDirection !== null) {
      // A trade executed this tick (entry, exit, or resize) - approximate
      // the resulting held units from the requested/executed trade size
      // (same fills-not-yet-reconciled approximation the rest of this
      // codebase already makes - see the realized-P&L TODO above).
      if (decision.target !== currentPosition) {
        // full entry/exit flip: the pair ends up entirely on one side
        if (decision.target === "long") {
          btcHeld = executedBtcCapital;
          assetHeld = 0;
        } else {
          btcHeld = 0;
          assetHeld = executedBtcCapital * lastCandle.close; // BTC -> asset units at today's asset-per-BTC rate
        }
      } else {
        // resize: still flat, adjust the previously-held asset units by the traded delta
        const prevAssetHeld = prevNav?.xautHeld ?? 0;
        const deltaAssetUnits = executedBtcCapital * lastCandle.close; // magnitude only
        assetHeld = Math.max(0, executedDirection === "into_asset" ? prevAssetHeld + deltaAssetUnits : prevAssetHeld - deltaAssetUnits);
        btcHeld = 0;
      }
    } else if (prevNav) {
      // No trade this tick - units held are unchanged from last tick; only
      // the mark (btcEquivalentNav below, via lastCandle.close) moves.
      btcHeld = prevNav.btcHeld;
      assetHeld = prevNav.xautHeld;
    } else {
      // Absolute first NAV point for this pair with nothing executed this
      // tick (e.g. bootstrap inferred a position from real wallet balances
      // but the exact unit count wasn't captured here) - fall back to the
      // target-fraction estimate.
      const fallbackBtc = totalPortfolioBtc * targetFraction;
      btcHeld = positionAfter === "long" ? fallbackBtc : 0;
      assetHeld = positionAfter === "flat" ? fallbackBtc * lastCandle.close : 0;
    }

    repo.insertNavPoint({
      timestamp: now,
      pairKey: pair.key,
      btcHeld,
      xautHeld: assetHeld,
      btcXautRatio: lastCandle.close,
      btcEquivalentNav: computeBtcEquivalentNav(btcHeld, assetHeld, lastCandle.close),
    });
  }

  return {
    pairKey: pair.key,
    currentPosition,
    decisionTarget: decision.target,
    gateAllowed: gateResult.allow,
    gateReason: gateResult.reason,
    rotated,
    targetFraction,
  };
}

/** True cross-pair allocation only applies to exactly the {xaut, xmr} pair set the user specified the rule for. */
function isXautXmrPairSet(pairs: readonly PairConfig[]): boolean {
  const keys = new Set(pairs.map((p) => p.key));
  return keys.size === 2 && keys.has("xaut") && keys.has("xmr");
}

/**
 * One tick across every configured pair (config.pairs - default XAUT + XMR).
 * Unlike the old fully-independent per-pair loop, this now runs in two
 * passes: first observe+decide for every pair (each pair's own Larsson
 * regime/entry/exit decision, entirely unchanged logic), THEN compute each
 * pair's dynamic capital-allocation fraction by comparing both pairs'
 * regimes (computePortfolioAllocation - see the user's rule in
 * portfolioAllocation.ts), THEN gate+execute+persist each pair against that
 * fraction. This two-pass split is required because sizing either pair
 * needs to know BOTH pairs' regimes at once.
 *
 * A failure on one pair doesn't block the others - each observe+decide call
 * is caught and reported individually (via PairLoopResult.error), and a
 * pair that failed to observe is excluded from the allocation calculation
 * for this tick (falling back to its static capitalFractionBtc) rather than
 * silently treating its regime as anything in particular.
 */
export async function runControlLoopIteration(deps: LoopDeps): Promise<PairLoopResult[]> {
  const results: PairLoopResult[] = [];
  const observations: PairObservation[] = [];

  for (const pair of deps.config.pairs) {
    try {
      observations.push(await observeAndDecide({ ...deps, pair }));
    } catch (err) {
      console.error(`[${pair.key}] observe/decide failed:`, err);
      results.push({
        pairKey: pair.key,
        currentPosition: "flat",
        decisionTarget: "flat",
        gateAllowed: false,
        gateReason: "Tick threw before a decision could be made.",
        rotated: false,
        targetFraction: pair.capitalFractionBtc,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const pairKeys = deps.config.pairs.map((p) => p.key);
  const totalPortfolioBtc = deps.repo.getPortfolioBtcEquivalentNav(pairKeys) || deps.config.capital.startingBtc;
  const useCrossPairAllocation = isXautXmrPairSet(deps.config.pairs) && observations.length === deps.config.pairs.length;

  let allocation: { xaut: number; xmr: number } | undefined;
  if (useCrossPairAllocation) {
    const xautRegime = observations.find((o) => o.pair.key === "xaut")?.today.regime as LarssonRegime;
    const xmrRegime = observations.find((o) => o.pair.key === "xmr")?.today.regime as LarssonRegime;
    allocation = computePortfolioAllocation({ xautRegime, xmrRegime });
  }

  for (const obs of observations) {
    try {
      const targetFraction = allocation
        ? ((allocation as Record<string, number>)[obs.pair.key] ?? obs.pair.capitalFractionBtc)
        : obs.pair.capitalFractionBtc;
      results.push(await gateAndExecute(deps, obs, targetFraction, totalPortfolioBtc));
    } catch (err) {
      console.error(`[${obs.pair.key}] gate/execute failed:`, err);
      results.push({
        pairKey: obs.pair.key,
        currentPosition: obs.currentPosition,
        decisionTarget: obs.today.position,
        gateAllowed: false,
        gateReason: "Tick threw during gate/execute.",
        rotated: false,
        targetFraction: obs.pair.capitalFractionBtc,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
