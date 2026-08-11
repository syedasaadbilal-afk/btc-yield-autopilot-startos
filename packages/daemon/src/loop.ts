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
 * the current price, not yesterday's stale close.
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
  btcPerAsset: number;
  dbDerivedPosition: PositionState;
}): Promise<PositionState> {
  const { client, pair, btcPerAsset, dbDerivedPosition } = params;
  try {
    const wallets = await client.getWallets();
    const btcBalance = wallets.find((w) => w.currency === "BTC")?.balance ?? 0;
    const assetBalance = wallets.find((w) => w.currency === pair.assetCurrency)?.balance ?? 0;
    const assetBalanceInBtc = btcPerAsset > 0 ? assetBalance * btcPerAsset : 0;

    if (btcBalance <= 0 && assetBalanceInBtc <= 0) {
      console.log(`[${pair.key}] bootstrap position check: both wallets empty, keeping DB-derived "${dbDerivedPosition}".`);
      return dbDerivedPosition;
    }

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
  targetFraction: number;
  error?: string;
}

interface PairObservation {
  pair: PairConfig;
  today: LarssonDayResult;
  accountingCandles: Candle[];
  currentPosition: PositionState;
  openTrade: ReturnType<Repo["getOpenTrade"]>;
  btcPerAssetPrice: number;
}

/**
 * observe + decide for one pair (design doc: "observe -> decide -> gate ->
 * execute -> persist"). Split out so runControlLoopIteration can gather
 * every configured pair's regime BEFORE any pair's gate/execute step runs -
 * computePortfolioAllocation needs both XAUT's and XMR's regime at once to
 * size either one (see portfolioAllocation.ts).
 */
async function observeAndDecide(deps: LoopDeps & { pair: PairConfig }): Promise<PairObservation> {
  const { client, repo, config, pair } = deps;
  const now = deps.now ?? Date.now();
  const pairStartingBtcFallback = config.capital.startingBtc * pair.capitalFractionBtc;

  const openTrade = repo.getOpenTrade(pair.key);
  const dbDerivedPosition: PositionState = openTrade ? "long" : "flat";
  const runMode = repo.getRunMode();
  const lookback = Number(process.env.LARSSON_LOOKBACK_CANDLES ?? 2000);
  const rawCandles = await client.getCandles(pair.ratioSymbol, "1D", lookback);
  const closedRawCandles = dropUnclosedDailyCandle(rawCandles, now);
  const larssonInputCandles = toLarssonInputCandles(closedRawCandles, pair);
  // btc-per-asset price (Larsson convention), hoisted here so it's computed
  // once and reused below (bootstrap inference) and by the caller
  // (wallet-basis valuation) instead of being recomputed in multiple places.
  const btcPerAssetPrice = larssonInputCandles[larssonInputCandles.length - 1]?.close ?? 0;
  const accountingCandles = toAccountingCandles(rawCandles, pair);

  const isFirstTickForPair = repo.getLatestNavPoint(pair.key) === undefined;
  const needsLiveBootstrapCheck = runMode === "LIVE" && !repo.hasLiveTrade(pair.key);
  const needsBootstrapCheck = isFirstTickForPair || needsLiveBootstrapCheck;
  const currentPosition: PositionState = needsBootstrapCheck
    ? await deriveBootstrapPosition({
        client,
        pair,
        btcPerAsset: btcPerAssetPrice,
        dbDerivedPosition,
      })
    : dbDerivedPosition;

  if (needsBootstrapCheck && currentPosition !== dbDerivedPosition) {
    if (currentPosition === "long" && !openTrade) {
      const bootstrapEntryPrice = accountingCandles[accountingCandles.length - 1]?.close ?? 0;
      repo.insertTrade({
        id: `${pair.key}-bootstrap-${now}`,
        runMode,
        pairKey: pair.key,
        openedAt: now,
        targetPosition: "long",
        btcCapitalAtOpen: pairStartingBtcFallback,
        riskFractionOfCapital: config.risk.riskFractionPerTrade,
        stopLossRatio: bootstrapEntryPrice,
        firstTargetRatio: bootstrapEntryPrice,
        status: "open",
        trancheExecutionPlanIds: [],
        notes: "Bootstrap-inferred from real wallet balances, not opened by this daemon.",
      });
    } else if (currentPosition === "flat" && openTrade) {
      console.warn(
        `[${pair.key}] reconciling: DB shows an open trade (${openTrade.id}, run mode ${openTrade.runMode}) but real wallet balances say "flat" - closing it as cancelled (most likely a DRY_RUN/PAPER simulation that never actually filled).`
      );
      repo.closeTrade(openTrade.id, "cancelled", 0);
    }
  }

  // Re-fetch after the reconciliation block above, which may have just
  // inserted or closed a trade row for this pair - using the STALE
  // pre-reconciliation `openTrade` here would mean a same-tick entry/exit
  // flip below (in gateAndExecute) checks against a reference that's already
  // out of date. Concretely: bootstrap backfills a "long" row for this pair
  // AND this same tick's own Larsson decision immediately wants to flip it
  // to "flat" - the flip's repo.closeTrade(openTrade.id, ...) call would
  // silently act on the stale `undefined` instead of the just-inserted row,
  // leaving the DB permanently stuck thinking this pair is still long BTC
  // even after a real rotation into the asset.
  const openTradeAfterReconciliation = repo.getOpenTrade(pair.key);

  const rotationHistory = replayLarssonRotation(larssonInputCandles, config.larsson, "long");
  const today = rotationHistory[rotationHistory.length - 1]!;
  repo.insertLarssonDecision(pair.key, today);

  if (today.position !== currentPosition && !today.switched) {
    console.warn(
      `[${pair.key}] Larsson replay position (${today.position}) disagrees with daemon ground truth (${currentPosition}) without a switch today - consider increasing LARSSON_LOOKBACK_CANDLES.`
    );
  }

  return {
    pair,
    today,
    accountingCandles,
    currentPosition,
    openTrade: openTradeAfterReconciliation,
    btcPerAssetPrice,
  };
}

/**
 * Real-wallet-derived sizing basis for this tick, computed once per tick and
 * shared across every pair's gateAndExecute call. Rotation sizing must work
 * off the CURRENT actual account balance - regardless of whether it reflects
 * the original starting capital, a later top-up, or a partial withdrawal -
 * rather than this daemon's own internal NAV bookkeeping, which can only
 * ever reconcile against the wallet at bootstrap.
 *
 * totalPortfolioBtc = raw BTC wallet balance + each pair's own asset wallet
 * balance converted to BTC at today's price. A pair's "current real value"
 * is only unambiguous when that specific pair is currently flat (holding
 * its own asset currency directly); the pooled BTC balance can't be
 * unambiguously split between pairs when both are long, but that's fine
 * because exits/resizes only ever act on a pair that's currently flat.
 *
 * Falls back to the old internal-NAV-based computation if the wallet read
 * fails or returns an empty/zero total.
 */
export interface WalletBasis {
  totalPortfolioBtc: number;
  currentValueByPairKey: Record<string, number>;
  btcBalance: number;
  source: "wallet" | "internal_nav_fallback";
}

async function computeWalletBasis(
  client: BitfinexRestClient,
  observations: PairObservation[],
  repo: Repo,
  config: StrategyConfig
): Promise<WalletBasis> {
  try {
    const wallets = await client.getWallets();
    const btcBalance = wallets.find((w) => w.currency === "BTC")?.balance ?? 0;
    const currentValueByPairKey: Record<string, number> = {};
    let assetsTotalBtc = 0;
    for (const o of observations) {
      if (o.currentPosition === "flat") {
        const assetBalance = wallets.find((w) => w.currency === o.pair.assetCurrency)?.balance ?? 0;
        const valueBtc = assetBalance * o.btcPerAssetPrice;
        currentValueByPairKey[o.pair.key] = valueBtc;
        assetsTotalBtc += valueBtc;
      } else {
        currentValueByPairKey[o.pair.key] = 0;
      }
    }
    const totalPortfolioBtc = btcBalance + assetsTotalBtc;
    if (totalPortfolioBtc > 0) {
      return { totalPortfolioBtc, currentValueByPairKey, btcBalance, source: "wallet" };
    }
    console.warn("[walletBasis] wallet read returned a zero/empty total, falling back to internal NAV tracking.");
  } catch (err) {
    console.warn(
      `[walletBasis] wallet read failed, falling back to internal NAV tracking: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const pairKeys = observations.map((o) => o.pair.key);
  const totalPortfolioBtc = repo.getPortfolioBtcEquivalentNav(pairKeys) || config.capital.startingBtc;
  const currentValueByPairKey: Record<string, number> = {};
  for (const o of observations) {
    currentValueByPairKey[o.pair.key] = repo.getLatestNavPoint(o.pair.key)?.btcEquivalentNav ?? 0;
  }
  return { totalPortfolioBtc, currentValueByPairKey, btcBalance: 0, source: "internal_nav_fallback" };
}

/**
 * gate + execute + persist for one pair. Handles:
 *   1. A flat<->long flip (this pair's own Larsson decision changed) - sized
 *      against the dynamic target fraction on entry, against this pair's
 *      real wallet-derived current value on exit.
 *   2a. Both pairs are gold (isDualGoldState) - never resize/rebalance
 *       BETWEEN the two held gold positions just because the allocator's
 *       50/50 target flickered; only deploy pre-assigned idle/top-up BTC
 *       (new money) into this pair if it's the underrepresented one.
 *   2b. Not dual-gold, still flat, no flip - a REAL reallocation (the other
 *       pair left gold and freed up capital for this one, or vice versa).
 *   3. Neither - just mark-to-market and persist a NAV point.
 */
async function gateAndExecute(
  deps: LoopDeps,
  obs: PairObservation,
  targetFraction: number,
  totalPortfolioBtc: number,
  currentRealValueBtc: number,
  isDualGoldState: boolean,
  idleTopUpBtc: number
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
  let executedBtcCapital = 0;
  let executedDirection: "into_asset" | "into_btc" | null = null;

  if (gateResult.allow && decision.target !== currentPosition) {
    const targetBtc = totalPortfolioBtc * targetFraction;
    const btcCapital = decision.target === "long" ? (currentRealValueBtc || targetBtc) : targetBtc;
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
      repo.closeTrade(openTrade.id, "closed_win", 0);
    }
    repo.setAllocationFraction(pair.key, targetFraction);
  } else if (gateResult.allow && currentPosition === "flat") {
    const lastAppliedFraction = repo.getAllocationFraction(pair.key);
    const fractionChanged =
      lastAppliedFraction === undefined || Math.abs(lastAppliedFraction - targetFraction) > 1e-9;

    if (isDualGoldState) {
      // Case 2a: both XAUT and XMR are gold this tick. Never resize/rebalance
      // BETWEEN two already-held gold positions just because the allocator's
      // 50/50 target flickered - hold both positions exactly as-is until one
      // of them actually leaves gold (handled entirely by Case 1 above, on
      // whichever later tick that happens). Still record the fraction so it
      // isn't seen as "stale" once a real exit does happen.
      if (fractionChanged) {
        repo.setAllocationFraction(pair.key, targetFraction);
      }

      // Fresh/idle capital handling: idleTopUpBtc is pre-computed once per
      // tick in runControlLoopIteration by comparing both pairs' real
      // wallet-derived values, so only the actually-underrepresented pair
      // ever receives it. This only ever BUYS more of this pair's asset with
      // money that wasn't invested anywhere yet - never sells either pair's
      // existing holding.
      if (idleTopUpBtc > 0) {
        if (runMode === "PAUSED") {
          console.log(
            `[${pair.key}] skipping idle-capital top-up of ${idleTopUpBtc.toFixed(8)} BTC: run mode is PAUSED (treated the same as a fresh entry).`
          );
        } else {
          console.log(
            `[${pair.key}] deploying idle/top-up capital: ${idleTopUpBtc.toFixed(8)} BTC into ${pair.assetCurrency} (underrepresented side of the 50/50 gold split).`
          );
          const executeResult = await executeRotation({
            client,
            side: "sell_btc_for_xaut",
            btcCapital: idleTopUpBtc,
            pair,
            config,
          });
          for (const rd of executeResult.routeDecisions) {
            console.log(
              `[${pair.key}] top-up tranche ${rd.trancheIndex} routed via "${rd.route}" (direct ${rd.directSlippageBtc.toFixed(6)} BTC vs usdt ${rd.usdtSlippageBtc.toFixed(6)} BTC estimated slippage)`
            );
          }
          rotated = true;
          executedBtcCapital = idleTopUpBtc;
          executedDirection = "into_asset";
        }
      }
    } else if (fractionChanged) {
      // Case 2b: not a dual-gold state - a REAL reallocation (the other pair
      // just exited to BTC and freed up capital that belongs to this
      // still-gold pair). Compare against the last-APPLIED fraction, and
      // size the delta against this pair's real wallet-derived current
      // value so it's correct regardless of funding history.
      const targetBtc = totalPortfolioBtc * targetFraction;
      const delta = targetBtc - currentRealValueBtc;
      const DUST_FRACTION_OF_PORTFOLIO = 0.001;
      const dustThresholdBtc = totalPortfolioBtc * DUST_FRACTION_OF_PORTFOLIO;

      if (Math.abs(delta) > dustThresholdBtc) {
        const increasing = delta > 0;
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

  const lastCandle = accountingCandles[accountingCandles.length - 1];
  if (lastCandle) {
    const positionAfter: PositionState = rotated && decision.target !== currentPosition ? decision.target : currentPosition;
    const prevNav = repo.getLatestNavPoint(pair.key);

    let btcHeld: number;
    let assetHeld: number;

    if (rotated && executedDirection !== null) {
      if (decision.target !== currentPosition) {
        if (decision.target === "long") {
          btcHeld = executedBtcCapital;
          assetHeld = 0;
        } else {
          btcHeld = 0;
          assetHeld = executedBtcCapital * lastCandle.close;
        }
      } else {
        const prevAssetHeld = prevNav?.xautHeld ?? 0;
        const deltaAssetUnits = executedBtcCapital * lastCandle.close;
        assetHeld = Math.max(0, executedDirection === "into_asset" ? prevAssetHeld + deltaAssetUnits : prevAssetHeld - deltaAssetUnits);
        btcHeld = 0;
      }
    } else if (prevNav) {
      btcHeld = prevNav.btcHeld;
      assetHeld = prevNav.xautHeld;
    } else {
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

function isXautXmrPairSet(pairs: readonly PairConfig[]): boolean {
  const keys = new Set(pairs.map((p) => p.key));
  return keys.size === 2 && keys.has("xaut") && keys.has("xmr");
}

/**
 * One tick across every configured pair. Two-pass: observe+decide for every
 * pair first, THEN compute each pair's dynamic capital-allocation fraction
 * (computePortfolioAllocation), THEN gate+execute+persist each pair against
 * it. A failure on one pair doesn't block the others.
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

  const useCrossPairAllocation = isXautXmrPairSet(deps.config.pairs) && observations.length === deps.config.pairs.length;

  let allocation: { xaut: number; xmr: number } | undefined;
  if (useCrossPairAllocation) {
    const xautRegime = observations.find((o) => o.pair.key === "xaut")?.today.regime as LarssonRegime;
    const xmrRegime = observations.find((o) => o.pair.key === "xmr")?.today.regime as LarssonRegime;
    allocation = computePortfolioAllocation({ xautRegime, xmrRegime });
  }

  // Both pairs gold this tick <=> computePortfolioAllocation's exact 50/50
  // rule fired (the only combination that ever produces 0.5/0.5) - used to
  // gate ordinary allocator-driven resizing off entirely for this tick.
  const isDualGoldState =
    allocation !== undefined && Math.abs(allocation.xaut - 0.5) < 1e-9 && Math.abs(allocation.xmr - 0.5) < 1e-9;

  const walletBasis = await computeWalletBasis(deps.client, observations, deps.repo, deps.config);

  // While in a dual-gold 50/50 state, steer any idle/top-up BTC sitting in
  // the wallet (a fresh deposit, manual funding, leftover dust, etc.) toward
  // whichever pair currently holds less BTC-equivalent value - never by
  // selling the other pair's existing holding, only by buying with capital
  // that wasn't invested anywhere yet. Only computed off a real wallet read,
  // since the internal-NAV fallback can't tell idle capital apart from
  // ordinary price drift.
  const idleTopUpByPairKey: Record<string, number> = {};
  if (isDualGoldState && walletBasis.source === "wallet") {
    const DUST_FRACTION_OF_PORTFOLIO = 0.001;
    const dustThresholdBtc = walletBasis.totalPortfolioBtc * DUST_FRACTION_OF_PORTFOLIO;
    const idleBtc = walletBasis.btcBalance;
    if (idleBtc > dustThresholdBtc) {
      const xautValue = walletBasis.currentValueByPairKey["xaut"] ?? 0;
      const xmrValue = walletBasis.currentValueByPairKey["xmr"] ?? 0;
      const underrepresentedKey = xautValue <= xmrValue ? "xaut" : "xmr";
      idleTopUpByPairKey[underrepresentedKey] = idleBtc;
    }
  }

  for (const obs of observations) {
    try {
      const targetFraction = allocation
        ? ((allocation as Record<string, number>)[obs.pair.key] ?? obs.pair.capitalFractionBtc)
        : obs.pair.capitalFractionBtc;
      results.push(
        await gateAndExecute(
          deps,
          obs,
          targetFraction,
          walletBasis.totalPortfolioBtc,
          walletBasis.currentValueByPairKey[obs.pair.key] ?? 0,
          isDualGoldState,
          idleTopUpByPairKey[obs.pair.key] ?? 0
        )
      );
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
