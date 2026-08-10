/**
 * One rotation instance's asset + how to read its Bitfinex candles. Bitfinex
 * lists ratio pairs in whichever direction happens to exist - confirmed via
 * https://api-pub.bitfinex.com/v2/conf/pub:list:pair:exchange - and it's not
 * consistent per asset: XAUT has BOTH "BTC:XAUT" (XAUT per BTC) and
 * "XAUT:BTC" (BTC per XAUT) listed, but XMR only has "XMRBTC" (BTC per XMR;
 * there is no "BTC:XMR"). `ratioConvention` records which one `ratioSymbol`
 * actually returns so callers can invert exactly where needed instead of
 * assuming a direction: the NAV/execution layer (nav.ts, execute.ts) always
 * wants asset-per-BTC (design doc Section 0's btcXautRatio convention), and
 * the Larsson regime engine (larssonRotation.ts, ported directly from a
 * script written against BTC-per-asset TradingView symbols like XAUTBTC/
 * XMRBTC) always wants the opposite - btc-per-asset.
 */
export interface PairConfig {
  /** Stable identifier, used as the DB partition key for per-pair state. */
  key: string;
  displayName: string;
  /**
   * Bitfinex wallet currency code for the rotation asset (e.g. "XAUT",
   * "XMR") - the same string getWallets() returns per balance row. Used to
   * look up this pair's real held-asset balance for bootstrap position
   * reconciliation (loop.ts) and order-size capping (execute.ts); kept
   * explicit here rather than parsed out of ratioSymbol/assetUsdtSymbol
   * since Bitfinex's symbol formatting isn't uniform enough to parse safely
   * (e.g. "tXAUT:UST" vs "tXMRUST").
   */
  assetCurrency: string;
  /** Bitfinex symbol to fetch (with the "t" trading prefix), e.g. "tXAUT:BTC" or "tXMRBTC". */
  ratioSymbol: string;
  /** What ratioSymbol's raw `close` represents. */
  ratioConvention: "assetPerBtc" | "btcPerAsset";
  /** Fraction of total starting BTC capital allocated to this pair's rotation. */
  capitalFractionBtc: number;
  /**
   * USDT leg symbols ("UST" is Bitfinex's ticker for Tether, confirmed via
   * pub:list:pair:exchange: "BTCUST", "XAUT:UST", "XMRUST"). Execution always
   * routes rotations through these two legs (BTC<->USDT, asset<->USDT)
   * instead of the direct cross pair (ratioSymbol) - Bitfinex charges zero
   * trading fees, and the USDT pairs for BTC/XAUT/XMR are each individually
   * more liquid than their direct cross, so two liquid legs beats one thin
   * one for minimizing slippage. See daemon/src/execute.ts.
   */
  btcUsdtSymbol: string;
  assetUsdtSymbol: string;
  /** Legacy USD leg symbols - kept for the old thin-liquidity fallback path, not used by default execution anymore. */
  btcUsdSymbol: string;
  assetUsdSymbol: string;
  minRatioDepthUsd: number;
}

/**
 * Strategy + risk configuration, live-editable (design doc: "no rebuild to tune").
 * Defaults below encode the locked design doc; treat as starting values, not gospel.
 */
export interface StrategyConfig {
  /**
   * LEGACY - superseded by `rotation` below. The original Fibonacci/trendline
   * confluence approach required regime + confluence + confirmation to ALL
   * reverse before exiting a position; on a 50/200 EMA regime filter that
   * meant a single trade could sit unchanged for 20+ months with no
   * independent stop or profit-take. Kept only so the original decide.ts
   * (packages/strategy/src/decide.ts) still typechecks/tests; not used by
   * the backtest or daemon anymore - see `rotation`.
   */
  regime: {
    fastEmaPeriod: number; // default 50
    slowEmaPeriod: number; // default 200
    timeframe: "1D";
  };
  /** LEGACY - see `regime` above. */
  confluence: {
    fibLevels: readonly number[]; // [0.382, 0.5, 0.618]
    toleranceFraction: number; // how tightly fib/trendline/swing must agree
    refinementTimeframe: "4H";
  };
  /** LEGACY - see `regime` above. */
  contrarian: {
    enabled: boolean;
    rsiOverbought: number; // default 70
    rsiOversold: number; // default 30
    rsiPeriod: number; // default 14
  };
  /**
   * LEGACY - superseded by `larsson` below. Mean-reversion/momentum rotation
   * (SMA200 entry band + RSI capitulation/momentum/trend-recovery exits).
   * Worked, but had no natural whipsaw buffer of its own (hence the
   * minFlatHoldDays/exitConfirmBandFraction bolted on) and doesn't match the
   * newer reference implementation the strategy is now ported from. Kept
   * only so packages/strategy/src/rotation.ts still typechecks/tests.
   */
  rotation: {
    smaPeriod: number; // 200
    entryBandFraction: number; // 0.05
    cooldownDays: number; // 90
    momentumTakeProfitFraction: number; // 0.20
    rsiPeriod: number; // 14
    rsiCapitulationThreshold: number; // 25
    minFlatHoldDays: number;
    exitConfirmBandFraction: number;
  };
  /**
   * ACTIVE strategy: "Larsson Baseline + Overextension Rotation", ported
   * faithfully from a user-supplied, TradingView-backtested Pine Script v5
   * reference. Four SMMA lines (fast/mid1/mid2/baseline) on hl2 classify
   * each bar as gray (transition)/orange (rotation asset strong)/navy (BTC
   * strong); entry requires orange AND price close to baseline (not
   * chasing); exit fires on regime reversal (navy or gray) OR an
   * overextension take-profit. See packages/strategy/src/larssonRotation.ts.
   */
  larsson: {
    fastPeriod: number; // 15
    midPeriod1: number; // 19
    midPeriod2: number; // 25
    baselinePeriod: number; // 29
    overextensionFraction: number; // 0.12
    entryMaxDistFraction: number; // 0.04
  };
  /**
   * Independent rotation instances, each running the SAME `larsson` rules
   * against a different BTC-quoted asset, each with its own slice of the
   * total BTC capital and its own position/state (design doc Section 0
   * still applies per pair: yield is measured in BTC). Two by default -
   * XAUT (gold) and XMR (Monero) - per the user's "two pairs to maximize
   * BTC returns" direction. capitalFractionBtc across all pairs should sum
   * to 1 (validated at daemon startup, not enforced by the type system).
   */
  pairs: readonly PairConfig[];
  risk: {
    /** Fraction of BTC capital risked per trade at the stop. 0.01-0.02. */
    riskFractionPerTrade: number;
    atrPeriod: number;
    atrStopMultiplier: number;
    /** Minimum reward:risk required to take a setup. */
    minRewardRiskRatio: number; // default 2
    /** Tranche weights for staggered entry, must sum to 1. */
    trancheWeights: readonly [number, number, number]; // [0.25, 0.25, 0.5]
    cooldownDaysAfterStop: number;
    drawdownCircuitBreakerFraction: number; // pause new entries beyond this BTC drawdown
  };
  execution: {
    numClipsPerTranche: number;
    layeringWindowMs: number;
    maxFractionOfBookDepthPerClip: number;
    maxSlippageBtcFractionOfTrade: number;
    legFallback: {
      enabled: boolean;
      btcUsdSymbol: string; // "tBTCUSD"
      xautUsdSymbol: string; // "tXAUT:USD"
      minRatioDepthUsd: number; // below this, use legs instead of tBTC:XAUT
    };
  };
  capital: {
    startingBtc: number; // 3
    wallet: "exchange"; // spot only, margin excluded by design
  };
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  regime: { fastEmaPeriod: 50, slowEmaPeriod: 200, timeframe: "1D" },
  confluence: {
    fibLevels: [0.382, 0.5, 0.618],
    toleranceFraction: 0.01,
    refinementTimeframe: "4H",
  },
  contrarian: {
    enabled: true,
    rsiOverbought: 70,
    rsiOversold: 30,
    rsiPeriod: 14,
  },
  rotation: {
    smaPeriod: 200,
    entryBandFraction: 0.05,
    cooldownDays: 90,
    momentumTakeProfitFraction: 0.2,
    rsiPeriod: 14,
    rsiCapitulationThreshold: 25,
    minFlatHoldDays: 10,
    exitConfirmBandFraction: 0.02,
  },
  larsson: {
    fastPeriod: 15,
    midPeriod1: 19,
    midPeriod2: 25,
    baselinePeriod: 29,
    overextensionFraction: 0.12,
    entryMaxDistFraction: 0.04,
  },
  // capitalFractionBtc below is now just the STARTING/fallback value used
  // before the first tick has computed a real target - actual sizing every
  // tick comes from computePortfolioAllocation() comparing XAUT's and XMR's
  // regimes (see loop.ts), not this static field. Kept at the "both gold"
  // 50/50 split as the least-surprising fallback.
  pairs: [
    {
      key: "xaut",
      displayName: "XAUT (Gold)",
      assetCurrency: "XAUT",
      // Confirmed against the Bitfinex app's own ticker list: "XAUt/BTC" and
      // "XMR/BTC" both quote BTC as the denominator (price = BTC per 1 unit
      // of asset, e.g. ~0.0637 BTC/XAUT) - not asset-per-BTC. Using XAUT:BTC
      // here (rather than the also-listed BTC:XAUT) keeps both pairs on the
      // exact same native convention the app displays, so a manual check
      // against the app matches this config symbol-for-symbol.
      ratioSymbol: "tXAUT:BTC",
      ratioConvention: "btcPerAsset",
      capitalFractionBtc: 0.5,
      btcUsdtSymbol: "tBTCUST",
      assetUsdtSymbol: "tXAUT:UST",
      btcUsdSymbol: "tBTCUSD",
      assetUsdSymbol: "tXAUT:USD",
      minRatioDepthUsd: 25000,
    },
    {
      key: "xmr",
      displayName: "XMR (Monero)",
      assetCurrency: "XMR",
      ratioSymbol: "tXMRBTC",
      ratioConvention: "btcPerAsset",
      capitalFractionBtc: 0.5,
      btcUsdtSymbol: "tBTCUST",
      assetUsdtSymbol: "tXMRUST",
      btcUsdSymbol: "tBTCUSD",
      assetUsdSymbol: "tXMRUSD",
      minRatioDepthUsd: 25000,
    },
  ],
  risk: {
    riskFractionPerTrade: 0.015,
    atrPeriod: 14,
    atrStopMultiplier: 1.5,
    minRewardRiskRatio: 2,
    trancheWeights: [0.25, 0.25, 0.5],
    cooldownDaysAfterStop: 5,
    drawdownCircuitBreakerFraction: 0.1,
  },
  execution: {
    numClipsPerTranche: 4,
    layeringWindowMs: 30 * 60 * 1000,
    maxFractionOfBookDepthPerClip: 0.15,
    maxSlippageBtcFractionOfTrade: 0.003,
    legFallback: {
      enabled: true,
      btcUsdSymbol: "tBTCUSD",
      xautUsdSymbol: "tXAUT:USD",
      minRatioDepthUsd: 25000,
    },
  },
  capital: {
    // 750,000 sats funded to the live account (2026-08-08). This is the
    // ACTUAL capital the sizing logic bases every clip/tranche on - loop.ts
    // falls back to config.capital.startingBtc * pair.capitalFractionBtc
    // whenever a pair has no NAV point yet (i.e. its very first trade), so
    // this MUST track real funded capital or the daemon will size orders
    // against a phantom balance and every order will fail/reject.
    startingBtc: 0.0075,
    wallet: "exchange",
  },
};
