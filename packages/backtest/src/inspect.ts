import { DEFAULT_STRATEGY_CONFIG } from "@autopilot/shared";
import { BitfinexRestClient } from "@autopilot/bitfinex-client";
import { runPortfolioBacktest } from "./runLarssonBacktest.js";

/**
 * Prints exactly what fired around each rotation the backtest made, per
 * pair: the date, r, the four Larsson SMMA lines, the regime, the
 * distance-from-baseline, and the human-readable reason
 * replayLarssonRotation() logged. Run with:
 *   npm run inspect --workspace packages/backtest
 *
 * This exists to sanity-check that a rotation happened because the Larsson
 * rules actually triggered, not by coincidence of how the backtest happens
 * to walk the data.
 */
async function main() {
  const client = new BitfinexRestClient({
    apiKey: "",
    apiSecret: "",
    baseUrl: process.env.BFX_BASE_URL ?? "https://api-pub.bitfinex.com",
    runMode: "DRY_RUN",
  });

  const config = DEFAULT_STRATEGY_CONFIG;
  const limit = Number(process.env.BACKTEST_CANDLE_LIMIT ?? 1500);

  const rawCandlesByPairKey: Record<string, Awaited<ReturnType<typeof client.getCandles>>> = {};
  for (const pair of config.pairs) {
    rawCandlesByPairKey[pair.key] = await client.getCandles(pair.ratioSymbol, "1D", limit);
  }

  const result = runPortfolioBacktest({
    rawCandlesByPairKey,
    pairs: config.pairs,
    larssonConfig: config.larsson,
    totalStartingBtc: config.capital.startingBtc,
  });

  for (const p of result.perPair) {
    const pair = config.pairs.find((cfg) => cfg.key === p.pairKey)!;
    console.log(`\n########## ${pair.displayName} (${pair.ratioSymbol}) ##########`);

    if (p.roundTrips.length === 0) {
      console.log("No rotations occurred - stayed in the starting position (long BTC) the whole period.");
      continue;
    }

    console.log(`${p.roundTrips.length} rotation(s) found:\n`);

    for (const rt of p.roundTrips) {
      const exitDecision = p.decisions[rt.exitedLongAtIndex]!;

      console.log(`=== Exit: BTC -> ${pair.displayName} ===`);
      console.log(`Date:           ${new Date(exitDecision.timestamp).toISOString().slice(0, 10)}`);
      console.log(`r:              ${exitDecision.r.toFixed(6)}`);
      console.log(
        `v1/m1/m2/v2:    ${exitDecision.v1.toFixed(6)} / ${exitDecision.m1.toFixed(6)} / ${exitDecision.m2.toFixed(6)} / ${exitDecision.v2.toFixed(6)}`
      );
      console.log(`Regime:         ${exitDecision.regime}`);
      console.log(`Dist. baseline: ${(exitDecision.distFromBaseline * 100).toFixed(2)}%`);
      console.log(`Reason:         ${exitDecision.reason}`);
      console.log(`BTC held before: ${rt.btcBefore.toFixed(6)}`);

      if (rt.reenteredLongAtIndex !== undefined) {
        const reDecision = p.decisions[rt.reenteredLongAtIndex]!;
        const daysHeld = rt.reenteredLongAtIndex - rt.exitedLongAtIndex;
        console.log(`\n=== Re-entry: ${pair.displayName} -> BTC ===`);
        console.log(`Date:           ${new Date(reDecision.timestamp).toISOString().slice(0, 10)}`);
        console.log(`r:              ${reDecision.r.toFixed(6)}`);
        console.log(`Regime:         ${reDecision.regime}`);
        console.log(`Dist. baseline: ${(reDecision.distFromBaseline * 100).toFixed(2)}%`);
        console.log(`Reason:         ${reDecision.reason}`);
        console.log(`Days held:      ${daysHeld}`);
        console.log(`BTC held after: ${rt.btcAfter?.toFixed(6)}`);
        console.log(`BTC P&L:        ${rt.btcPnl?.toFixed(6)}`);
      } else {
        const last = p.decisions[p.decisions.length - 1]!;
        console.log(
          `\nStill holding ${pair.displayName} as of ${new Date(last.timestamp).toISOString().slice(0, 10)}, r ${last.r.toFixed(6)}.`
        );
      }
      console.log();
    }
  }

  console.log("\n########## Portfolio ##########");
  console.log(`Starting BTC:          ${result.totalStartingBtc}`);
  console.log(`Ending BTC-equiv NAV:  ${result.endingBtcEquivalentNav.toFixed(6)}`);
  console.log(`Total BTC yield:       ${(result.totalBtcYieldFraction * 100).toFixed(2)}%`);
}

main().catch((err) => {
  console.error("Inspect failed:", err);
  process.exit(1);
});
