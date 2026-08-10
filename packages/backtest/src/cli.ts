import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { runPortfolioBacktest } from "./runLarssonBacktest.js";

/**
 * Fetches each configured pair's native ratio candles (config.pairs -
 * default XAUT + XMR, both against BTC) and runs the Larsson Baseline +
 * Overextension backtest independently per pair, then combines the results
 * into a single portfolio BTC yield (design doc Section 0).
 *
 * KNOWN GAP: unlike the earlier single-pair cli.ts, this doesn't fall back
 * to synthesizing a ratio from BTC/USD + asset/USD legs if a pair's direct
 * symbol comes back too thin/short - each pair's ratioSymbol history is used
 * as-is. Revisit if a pair's direct history turns out to be materially
 * shorter than its USD legs' history once run against live data.
 * Run with: npm run backtest --workspace packages/backtest
 */
async function main() {
  const client = new BitfinexRestClient({
    apiKey: "",
    apiSecret: "",
    baseUrl: process.env.BFX_BASE_URL ?? "https://api-pub.bitfinex.com",
    runMode: "DRY_RUN", // irrelevant for public market data, kept explicit
  });

  const config = DEFAULT_STRATEGY_CONFIG;
  const limit = Number(process.env.BACKTEST_CANDLE_LIMIT ?? 1500); // ~4 years of daily candles

  const rawCandlesByPairKey: Record<string, Awaited<ReturnType<typeof client.getCandles>>> = {};
  for (const pair of config.pairs) {
    console.log(`Fetching ${limit} daily candles for ${pair.displayName} (${pair.ratioSymbol})...`);
    rawCandlesByPairKey[pair.key] = await client.getCandles(pair.ratioSymbol, "1D", limit);
    console.log(`  -> ${rawCandlesByPairKey[pair.key]!.length} candles.`);
  }

  const result = runPortfolioBacktest({
    rawCandlesByPairKey,
    pairs: config.pairs,
    larssonConfig: config.larsson,
    totalStartingBtc: config.capital.startingBtc,
  });

  console.log("\n--- Portfolio backtest summary (BTC-denominated, design doc Section 0) ---");
  console.log(`Starting BTC:          ${result.totalStartingBtc}`);
  console.log(`Ending BTC-equiv NAV:  ${result.endingBtcEquivalentNav.toFixed(6)}`);
  console.log(`Total BTC yield:       ${(result.totalBtcYieldFraction * 100).toFixed(2)}%`);

  for (const p of result.perPair) {
    const pair = config.pairs.find((cfg) => cfg.key === p.pairKey)!;
    console.log(`\n--- ${pair.displayName} (${(pair.capitalFractionBtc * 100).toFixed(0)}% of capital) ---`);
    console.log(`Starting BTC:          ${p.summary.startingBtc.toFixed(6)}`);
    console.log(`Ending BTC-equiv NAV:  ${p.summary.endingBtcEquivalentNav.toFixed(6)}`);
    console.log(`BTC yield:             ${(p.summary.totalBtcYieldFraction * 100).toFixed(2)}%`);
    console.log(
      `Round trips:           ${p.summary.numRoundTrips} (${p.summary.numRoundTripsCompleted} completed)`
    );
    console.log(`Win rate:              ${(p.summary.winRate * 100).toFixed(1)}%`);
    console.log(`Max BTC drawdown:      ${(p.summary.maxDrawdownFraction * 100).toFixed(2)}%`);
  }

  console.log(
    "\nPass/fail per design doc Section 6: strategy should show a positive combined BTC yield fraction across multiple regime cycles, not just a favorable USD equity curve."
  );
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
