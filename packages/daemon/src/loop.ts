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

    // BUG (found live, Aug 2026): this used to compare assetBalanceInBtc
    // against the RAW WALLET BTC BALANCE. That's wrong whenever more than
    // one pair is configured, because the BTC wallet is POOLED across every
    // pair, not attributable to any single one - when both pairs are near a
    // 50/50 dual-gold split, this pair's own asset value and the OTHER
    // pair's BTC allocation sitting in the shared wallet are nearly equal,
    // making the comparison a coin flip on tiny price movement. Confirmed
    // live: XAUT genuinely held 0.05626682 XAUT (0.00383188 BTC-equiv) while
    // the pooled wallet held 0.00383618 BTC (actually XMR's allocation) -
    // the old formula inferred "long" (wrong), triggering a needless real
    // rotation attempt that then failed on the exchange's minimum order
    // size, blocking every subsequent tick.
    //
    // Correct rule: THIS pair is "flat" (holding its own rotation asset) if
    // and only if it holds a meaningful (non-dust) amount of that asset -
    // full stop. The pooled BTC balance is irrelevant to which pair
    // "currently holds" it; it only matters for sizing, handled elsewhere.
    const ASSET_DUST_THRESHOLD_BTC = 0.0001; // ~$6-7 - below this, treat as no real holding (rounding/fee dust)
    const inferred: PositionState = assetBalanceInBtc > ASSET_DUST_THRESHOLD_BTC ? "flat" : "long";
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
        entryPrice: bootstrapEntryPrice,
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
 *   1. A flat<->long flip (this pair's own Larsson decision changed).
 *   2a. Still flat, no flip, target fraction CHANGED since last established
 *       (repo.getAllocationFraction) - a REAL reallocation. Fires on every
 *       regime-driven transition: 100% splitting into 50/50, 50/50
 *       collapsing back to 100%, moving between the two single-gold 100/0
 *       states, or this pair's first-ever allocation. Sized against this
 *       pair's real wallet-derived current value.
 *   2b. Still flat, no flip, target fraction UNCHANGED (a stable 50/50 or a
 *       stable 100/0 state) - never resize an existing held position off
 *       allocator noise; only ever deploy pre-assigned idle/top-up BTC (new
 *       money) into this pair if it's the one that should receive it.
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
    repo.insertExecutionLog({
      id: `${pair.key}-${now}-flip`,
      pairKey: pair.key,
      timestamp: now,
      kind: decision.target === "long" ? "flip_entry" : "flip_exit",
      side,
      requestedBtc: btcCapital,
      movedBtc: executeResult.totalBtcMoved,
      status: executeResult.totalBtcMoved > 0 ? "executed" : "blocked",
      routes: executeResult.routeDecisions.map((rd) => rd.route).join(","),
    });

    // Bug found live Aug 2026 (same class as the #100 resize fix): this used
    // to unconditionally mark the flip as executed - inserting/closing a
    // trade row and persisting the new allocation fraction - even when every
    // tranche got skipped (executeResult.totalBtcMoved === 0, e.g. below
    // Bitfinex's minimum order size). That recorded a flip that never
    // actually happened. Only commit the flip's bookkeeping when real
    // capital moved; otherwise leave everything as-is so the position/trade
    // state stays consistent with reality and this tick's decision is
    // naturally retried next tick.
    if (executeResult.totalBtcMoved <= 0) {
      console.warn(
        `[${pair.key}] flip to "${decision.target}" could not execute - every tranche was below Bitfinex's minimum order size or unroutable. NOT recording a trade/allocation change; will retry next tick.`
      );
    } else {
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
          entryPrice,
          stopLossRatio: stopAndTarget.stopPrice,
          firstTargetRatio: stopAndTarget.firstTargetPrice,
          status: "open",
          trancheExecutionPlanIds: [],
        });
      } else if (openTrade) {
        // Realized PnL for a "long" (BTC-holding) trade is the opportunity-cost
        // capture versus staying in the asset the whole time: btcCapitalAtOpen
        // stays fixed in BTC terms while held (holding BTC can't itself produce
        // a BTC-denominated gain), so the real signal is how the ratio moved.
        // btcXautRatio/entryPrice/exitPrice are ASSET-per-BTC (see nav.ts,
        // larssonRotation.ts's "r = XAUT per BTC" convention) - counterfactual
        // asset units if we'd stayed in the asset = btcCapitalAtOpen *
        // entryPrice; converting that back to BTC at exitPrice gives
        // (btcCapitalAtOpen * entryPrice) / exitPrice, so PnL = actual BTC held
        // minus that counterfactual = btcCapitalAtOpen * (1 - entryPrice /
        // exitPrice). A rising ratio (BTC buys more asset over time) while long
        // BTC means the bet paid off -> positive PnL, confirmed by hand.
        const exitPrice = accountingCandles[accountingCandles.length - 1]?.close;
        const pnl =
          exitPrice !== undefined && exitPrice > 0 && openTrade.entryPrice !== undefined
            ? openTrade.btcCapitalAtOpen * (1 - openTrade.entryPrice / exitPrice)
            : 0;
        repo.closeTrade(openTrade.id, pnl >= 0 ? "closed_win" : "closed_loss", pnl, exitPrice);
      }
      repo.setAllocationFraction(pair.key, targetFraction);
    }
  } else if (gateResult.allow && currentPosition === "flat") {
    const lastAppliedFraction = repo.getAllocationFraction(pair.key);
    const fractionChanged =
      lastAppliedFraction === undefined || Math.abs(lastAppliedFraction - targetFraction) > 1e-9;

    if (fractionChanged) {
      // Case 2a: a REAL reallocation. Fires on ANY change to this pair's
      // target fraction - the first-ever allocation for this pair, a 100%
      // regime splitting into the 50/50 dual-gold state, 50/50 collapsing
      // back into a 100% regime, or moving between the two single-gold
      // 100/0 states. isDualGoldState is not used to gate this anymore - it
      // is purely informational in the log line below - since a target that
      // just changed must be traded into regardless of whether the new (or
      // old) state happens to be dual-gold.
      const targetBtc = totalPortfolioBtc * targetFraction;
      const delta = targetBtc - currentRealValueBtc;
      const DUST_FRACTION_OF_PORTFOLIO = 0.001;
      const dustThresholdBtc = totalPortfolioBtc * DUST_FRACTION_OF_PORTFOLIO;

      // Tracks whether a real resize was attempted but every tranche got
      // skipped for being below Bitfinex's minimum order size (bug found
      // live, Aug 2026): repo.setAllocationFraction used to run unconditionally
      // after this block, so a resize that moved ZERO real capital still got
      // marked as "applied" - the dashboard then showed the new target as
      // "on target" even though nothing actually happened on the exchange,
      // and the daemon would never retry since fractionChanged would read
      // false on the next tick. Only skip the persist when a resize was
      // genuinely attempted and failed to move anything; the PAUSED branch
      // and the "within dust threshold, nothing to do" case both still mark
      // the fraction as applied, matching prior behavior.
      let resizeBlocked = false;
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
            `[${pair.key}] resizing allocation ${lastAppliedFraction !== undefined ? (lastAppliedFraction * 100).toFixed(0) + "%" : "unset"} -> ${(targetFraction * 100).toFixed(0)}% (${resizeBtcCapital.toFixed(8)} BTC, side ${side}, dual-gold target: ${isDualGoldState})`
          );
          const executeResult = await executeRotation({ client, side, btcCapital: resizeBtcCapital, pair, config });
          for (const rd of executeResult.routeDecisions) {
            console.log(
              `[${pair.key}] resize tranche ${rd.trancheIndex} routed via "${rd.route}" (direct ${rd.directSlippageBtc.toFixed(6)} BTC vs usdt ${rd.usdtSlippageBtc.toFixed(6)} BTC estimated slippage)`
            );
          }
          repo.insertExecutionLog({
            id: `${pair.key}-${now}-resize`,
            pairKey: pair.key,
            timestamp: now,
            kind: "resize",
            side,
            requestedBtc: resizeBtcCapital,
            movedBtc: executeResult.totalBtcMoved,
            status: executeResult.totalBtcMoved > 0 ? "executed" : "blocked",
            routes: executeResult.routeDecisions.map((rd) => rd.route).join(","),
          });
          if (executeResult.totalBtcMoved <= 0) {
            resizeBlocked = true;
            console.warn(
              `[${pair.key}] resize to ${(targetFraction * 100).toFixed(0)}% could not execute - every tranche was below Bitfinex's minimum order size. NOT marking as applied; will retry next tick.`
            );
          } else {
            rotated = true;
            executedBtcCapital = resizeBtcCapital;
            executedDirection = increasing ? "into_asset" : "into_btc";
          }
        }
      }
      if (!resizeBlocked) {
        repo.setAllocationFraction(pair.key, targetFraction);
      }
    } else if (idleTopUpBtc > 0) {
      // Case 2b: steady state - this pair's target fraction hasn't changed
      // since it was last established (a stable 50/50 split or a stable
      // 100/0 state). Never resize an existing held position off allocator
      // noise; only ever deploy pre-assigned idle/top-up BTC (new money,
      // computed once per tick in runControlLoopIteration) into this pair
      // if it's the one that should receive it.
      if (runMode === "PAUSED") {
        console.log(
          `[${pair.key}] skipping idle-capital top-up of ${idleTopUpBtc.toFixed(8)} BTC: run mode is PAUSED (treated the same as a fresh entry).`
        );
      } else {
        console.log(
          `[${pair.key}] deploying idle/top-up capital: ${idleTopUpBtc.toFixed(8)} BTC into ${pair.assetCurrency}.`
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
        repo.insertExecutionLog({
          id: `${pair.key}-${now}-topup`,
          pairKey: pair.key,
          timestamp: now,
          kind: "topup",
          side: "sell_btc_for_xaut",
          requestedBtc: idleTopUpBtc,
          movedBtc: executeResult.totalBtcMoved,
          status: executeResult.totalBtcMoved > 0 ? "executed" : "blocked",
          routes: executeResult.routeDecisions.map((rd) => rd.route).join(","),
        });
        rotated = true;
        executedBtcCapital = idleTopUpBtc;
        executedDirection = "into_asset";
      }
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
      // Bug found live Aug 2026: this used to carry forward prevNav.btcHeld
      // UNCHANGED for every non-rotating tick, regardless of position. That's
      // correct for a "flat" pair (it genuinely still holds the exact same
      // number of gold coins until a real trade changes that - only the
      // price used to value them should move). It's wrong for a "long" pair:
      // "long" means holding no distinct asset of its own, just a notional
      // share of the shared/pooled BTC wallet - that share should track the
      // CURRENT totalPortfolioBtc * targetFraction every tick, the same
      // formula the very-first-tick fallback below already uses. Freezing it
      // meant a pair that has never once rotated (e.g. XMR, still waiting
      // for its own regime to go gold) displayed a stale "deployed" figure
      // from whatever its first-ever tick happened to compute, never
      // updating again even as the real portfolio and other pairs' resizes
      // changed around it - looked like real capital sitting in XMR when the
      // live wallet showed XMR holding nothing at all.
      btcHeld = positionAfter === "long" ? totalPortfolioBtc * targetFraction : 0;
      assetHeld = positionAfter === "flat" ? prevNav.xautHeld : 0;
    } else {
      const fallbackBtc = totalPortfolioBtc * targetFraction;
      btcHeld = positionAfter === "long" ? fallbackBtc : 0;
      assetHeld = positionAfter === "flat" ? fallbackBtc * lastCandle.close : 0;
    }

    const btcEquivalentNav = computeBtcEquivalentNav(btcHeld, assetHeld, lastCandle.close);
    repo.insertNavPoint({
      timestamp: now,
      pairKey: pair.key,
      btcHeld,
      xautHeld: assetHeld,
      btcXautRatio: lastCandle.close,
      btcEquivalentNav,
    });

    // Bug found live Aug 2026 (round 3): the dashboard's "vs funded" per-pair
    // yield/PnL line used to be measured against this pair's very
    // first-ever recorded NAV point, frozen forever (#95/#101 - to stop it
    // drifting on ordinary regime re-evaluation). That broke down the moment
    // a REAL cross-pair reallocation happens (manual override change, or a
    // regime-driven 100/0 <-> 50/50 transition): capital deliberately moved
    // between pairs then reads as trading loss/gain against the stale
    // baseline, producing misleading percentages. Re-baseline here to this
    // pair's CURRENT value exactly when its target fraction actually
    // changes since the last time the baseline was set (or hasn't been set
    // yet) - ordinary ticks where the target is unchanged leave it alone,
    // exactly like before, so this only resets on genuine reallocation
    // events, not every tick.
    const priorBaseline = repo.getFundingBaseline(pair.key);
    const targetFractionChanged =
      priorBaseline === undefined || Math.abs(priorBaseline.targetFractionAtSet - targetFraction) > 1e-9;
    if (targetFractionChanged) {
      repo.setFundingBaseline(pair.key, btcEquivalentNav, targetFraction, now);
    }
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
    const regimeAllocation = computePortfolioAllocation({ xautRegime, xmrRegime });
    // Manual override (task #89/#93): operator-set split from the dashboard
    // Config tab, persisted in allocation_override. When enabled, this
    // REPLACES the regime-driven split above wholesale for SIZING purposes
    // only - it can never force a pair to hold an asset its own Larsson
    // regime says to exit, since that flip is decided independently a few
    // lines below in gateAndExecute by comparing decision.target (=
    // today.position, driven solely by replayLarssonRotation) against
    // currentPosition, with zero dependency on targetFraction. A pair whose
    // own regime says "exit to BTC" still exits regardless of the
    // override's split; the override only changes how a pair that's
    // currently eligible to hold its asset gets sized/resized.
    const override = deps.repo.getAllocationOverride();
    allocation = override.enabled
      ? { xaut: override.xautFraction, xmr: 1 - override.xautFraction }
      : regimeAllocation;
  }

  // Both pairs gold this tick <=> computePortfolioAllocation's exact 50/50
  // rule fired (the only combination that ever produces 0.5/0.5) - used to
  // steer idle/top-up capital below, and for logging.
  const isDualGoldState =
    allocation !== undefined && Math.abs(allocation.xaut - 0.5) < 1e-9 && Math.abs(allocation.xmr - 0.5) < 1e-9;

  const walletBasis = await computeWalletBasis(deps.client, observations, deps.repo, deps.config);

  // Steer any idle/top-up BTC sitting in the wallet (a fresh deposit, manual
  // funding, leftover dust, etc.) toward whichever pair should receive it -
  // never by selling the other pair's existing holding, only by buying with
  // capital that wasn't invested anywhere yet. In a dual-gold 50/50 state,
  // that's whichever pair currently holds less BTC-equivalent value; in a
  // single-gold 100/0 state, that's the one pair currently at 100%. Only
  // computed off a real wallet read, since the internal-NAV fallback can't
  // tell idle capital apart from ordinary price drift.
  const idleTopUpByPairKey: Record<string, number> = {};
  if (allocation !== undefined && walletBasis.source === "wallet") {
    const DUST_FRACTION_OF_PORTFOLIO = 0.001;
    const dustThresholdBtc = walletBasis.totalPortfolioBtc * DUST_FRACTION_OF_PORTFOLIO;
    const idleBtc = walletBasis.btcBalance;
    if (idleBtc > dustThresholdBtc) {
      if (isDualGoldState) {
        const xautValue = walletBasis.currentValueByPairKey["xaut"] ?? 0;
        const xmrValue = walletBasis.currentValueByPairKey["xmr"] ?? 0;
        const underrepresentedKey = xautValue <= xmrValue ? "xaut" : "xmr";
        idleTopUpByPairKey[underrepresentedKey] = idleBtc;
      } else {
        const fullTargetKey =
          allocation.xaut >= 1 - 1e-9 ? "xaut" : allocation.xmr >= 1 - 1e-9 ? "xmr" : undefined;
        if (fullTargetKey) {
          idleTopUpByPairKey[fullTargetKey] = idleBtc;
        }
      }
    }
  }

  for (const obs of observations) {
    // Hoisted out of the try block (bug found live, Aug 2026) so the catch
    // path reports the real intended target instead of falling back to the
    // static capitalFractionBtc default when gate/execute throws.
    const targetFraction = allocation
      ? ((allocation as Record<string, number>)[obs.pair.key] ?? obs.pair.capitalFractionBtc)
      : obs.pair.capitalFractionBtc;
    try {
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
        targetFraction,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
