# BTC Yield Autopilot

Spot-only, long/flat swing-trading daemon + dashboard that rotates BTC into
whichever of a set of BTC-quoted assets is strong (currently XAUT/gold and
XMR/Monero) and back, on Bitfinex. Objective: maximize BTC yield (see
`../btc-xaut-strategy-design.md` for the original locked design doc this was
built from - the rotation logic itself has since evolved past what that doc
describes; this README is the source of truth for the current strategy).

Hard constraints, enforced at the type level, not just by convention:

- Spot wallet only. No margin, no shorting - `PositionState` is `"flat" | "long"`.
- `"flat"` means holding that pair's rotation asset, not cash.
- Every metric (P&L, drawdown, risk-per-trade, NAV) is BTC-denominated.

## Strategy: Larsson Baseline + Overextension Rotation

Ported from a user-supplied, TradingView-backtested Pine Script v5 reference.
Runs **independently per pair** (`packages/strategy/src/larssonRotation.ts`):

- Four SMMA (Wilder-smoothed) lines on hl2 - fast (15), mid1 (19), mid2 (25),
  baseline/slow (29) - classify each bar as:
  - **gray**: the lines disagree on which side of the baseline they're on (a
    transition zone - also the regime-reversal exit trigger, not just "no
    signal").
  - **orange**: the rotation asset is the stronger side of the pair.
  - **navy**: BTC is the stronger side.
- **Entry** (BTC -> asset): regime is orange AND price is within 4% above the
  baseline (`entryMaxDistFraction`) - avoids chasing an already-extended move.
- **Exit** (asset -> BTC): regime turns navy or gray (reversal), OR price is
  12%+ above the baseline (`overextensionFraction`, take-profit).

This superseded an earlier SMA200/RSI rotation (`packages/strategy/src/
rotation.ts`, still present and tested but unused) after backtesting showed
that approach could hold a single position for 20+ months - not genuine swing
trading. `rotation.ts`'s anti-whipsaw additions (minimum hold period, exit
confirmation band) don't apply to the Larsson engine - the gray-zone buffer
and overextension target serve a similar role natively. Watch for whipsaw in
sideways markets on the first live runs; nothing has been added preemptively
here since it wasn't in the reference script.

### Multi-pair, independent capital

`StrategyConfig.pairs` (default: XAUT 50% / XMR 50% of total BTC capital) -
each pair runs the full observe -> decide -> gate -> execute -> persist cycle
on its own, with its own open position, NAV curve, and cooldown state. A bad
tick on one pair doesn't block the others (see `daemon/src/loop.ts`).

**Ratio direction matters and isn't consistent across pairs** - confirmed
directly against Bitfinex (both the public API's pair list and the app's own
tickers): `XAUT:BTC` and `XMRBTC` both quote **BTC as the denominator** (price
= BTC per 1 unit of asset, e.g. XAUT:BTC ~0.0637). `PairConfig.ratioConvention`
records this per pair; `toLarssonInputCandles`/`toAccountingCandles` in
`larssonRotation.ts` convert to whichever direction each part of the system
needs (the regime engine wants btc-per-asset; NAV/trade accounting wants
asset-per-BTC, the original design doc convention). Don't assume a new pair
follows the same native direction as an existing one - check
`pub:list:pair:exchange` first.

### Execution routing: direct pair vs. USDT legs, chosen per trade

Bitfinex charges zero trading fees, so extra trades cost nothing - only
slippage matters. Rather than assuming one route is always better, every
tranche measures **estimated slippage on both options** and executes via
whichever is actually cheaper for that size, at that moment:

- **Direct**: trade `pair.ratioSymbol` (e.g. `tXAUT:BTC`) in one leg.
- **USDT**: trade `pair.btcUsdtSymbol` (`tBTCUST`) then `pair.assetUsdtSymbol`
  (`tXAUT:UST`/`tXMRUST`), or the reverse order depending on direction - two
  legs, each individually more liquid than the direct cross (confirmed via
  `pub:list:pair:exchange`: `BTCUST`, `XAUT:UST`, `XMRUST` all exist - "UST"
  is Bitfinex's Tether ticker).

`compareExecutionRoutes()` (`packages/execution/src/routeSelection.ts`, pure/
unit-tested) estimates each route's BTC-denominated slippage using live order
book depth (`estimateClipSlippageBtc`, the same book-depth-scaled model
already used for clip sizing) and picks the lower one. The USDT route's two
legs are summed after converting the asset-leg's slippage back to BTC terms
via current BTC/USDT and asset/USDT prices, so the two routes are directly
comparable. `daemon/src/execute.ts` fetches the live depths/prices per
tranche and logs which route won and by how much (see `RouteDecision` in
`ExecuteRotationResult`).

Caveat: since DRY_RUN never produces real fills, the USDT route's second leg
is sized off the *planned* first-leg amount (converted through current
prices), not the first leg's actual fill - needs reconciliation once PAPER
mode provides real fill data, same class of gap as the placeholder limit
price noted below.

## Structure

```
packages/
  shared/            Types shared across every package: RunMode, PositionState,
                      StrategyConfig (incl. `larsson` config + `pairs` array),
                      PairConfig, NavPoint, Trade, execution/order types.
  strategy/          larssonRotation.ts (ACTIVE strategy) + indicators
                      (sma/ema/rsi/atr/smma) + risk sizing. rotation.ts and
                      decide.ts (Fibonacci/trendline/RSI) are LEGACY - kept
                      for tests/history, not wired into backtest or daemon.
  execution/         Layered/sliced order planning: tranche -> clip scheduling,
                      depth-based clip sizing, slippage budget checks, and
                      routeSelection.ts (per-trade direct-vs-USDT-legs slippage
                      comparison - see "Execution routing" above). Legacy USD
                      leg-fallback (thin-liquidity threshold) also still present,
                      unused by default execution now.
  bitfinex-client/   Bitfinex API v2 REST client: HMAC-SHA384 auth, monotonic
                      nonce, rate limiter, candles/book/order endpoints.
                      Refuses to hit the network for order submission in
                      DRY_RUN mode (defense in depth beyond the daemon's gate).
  daemon/            observe -> decide -> gate -> execute -> persist control
                      loop, run independently per pair every tick. SQLite
                      (Node's built-in node:sqlite) persistence with
                      migrations, all pair-scoped (pair_key column/param).
                      Risk/safety gate: PAUSED blocks new entries only,
                      post-stop-out cooldown, BTC-drawdown circuit breaker.
  backtest/          Fetches each pair's native ratio candles and runs
                      runPairBacktest() independently per pair
                      (runLarssonBacktest.ts), then combines into a single
                      portfolio BTC yield (runPortfolioBacktest()). No
                      lookahead bias. Legacy runBacktest.ts (SMA/RSI, single
                      pair) still present/tested, not used by cli.ts/inspect.ts.
  dashboard/         React + Tailwind + Vite skeleton: BTC-equivalent NAV
                      chart, run-mode toggle, open-position table. Currently
                      reads mock data (see dashboard/src/api.ts) - the daemon
                      doesn't expose an HTTP API yet. Not multi-pair aware yet.
```

## Setup

```bash
npm install
npm run typecheck
npm test
```

## Running the backtest

Fetches each configured pair's historical daily candles from Bitfinex's
public endpoint (no API key needed) and runs the Larsson strategy against
each independently:

```bash
npm run backtest
```

To see exactly what triggered each rotation (date, r, the four SMMA lines,
regime, distance from baseline, reason) per pair, plus the combined portfolio
number:

```bash
npm run backtest:inspect
```

## Running the daemon (DRY_RUN by default)

```bash
cd packages/daemon
BFX_API_KEY=... BFX_API_SECRET=... AUTOPILOT_RUN_MODE=DRY_RUN npm run start
```

Run mode is stored in SQLite and re-read every tick - no rebuild needed to
change `DRY_RUN` / `PAPER` / `LIVE` / `PAUSED`. Applies to all pairs at once
(no per-pair run mode yet - see gaps below).

`LARSSON_LOOKBACK_CANDLES` (default 2000) controls how much history is
re-fetched and replayed each tick per pair - see the comment in `loop.ts` for
why this needs to be a large, fixed window rather than anchored to the
daemon's current position.

## Known gaps / next steps

- **Fastify HTTP API** for the daemon isn't built yet - the dashboard reads
  mock data until `/api/nav`, `/api/trades`, `/api/run-mode` exist, and none
  of them are pair-aware yet.
- **Dashboard is not multi-pair aware** - built against the original
  single-pair NAV/trade shape; needs updating to show per-pair + combined
  portfolio views.
- **Realized P&L on trade close** in `daemon/src/loop.ts` is a placeholder
  (`0`) - needs to reconcile against actual clip fills once running in PAPER.
- **True time-spread clip execution**: `daemon/src/execute.ts` currently
  places all clips for a tranche back-to-back rather than spread across
  `layeringWindowMs` with a scheduler, since the daemon's tick interval
  (hours) is coarser than the layering window (minutes). Needs a persistent
  clip queue processed on a faster sub-tick.
- **USDT route's second leg is sized off the plan, not the first leg's real
  fill** - see the caveat under "Execution routing" above; needs real fill
  reconciliation once PAPER mode provides actual fills.
- **Limit price selection**: orders are currently submitted with a placeholder
  price; needs to derive a real limit price from the current book.
- **Old USD leg-fallback (threshold-based, single fallback path) is now
  superseded** by always-compare-both-routes (`routeSelection.ts`) - the
  `PairConfig.btcUsdSymbol`/`assetUsdSymbol`/`minRatioDepthUsd` fields and
  `applyLegFallbackIfNeeded` are unused dead code at this point, kept only
  because `execution/test/planTranche.test.ts` still exercises them.
- **Backtest doesn't fall back to synthesized-from-legs candles** if a pair's
  direct ratio symbol comes back with a short history (see the note in
  `backtest/src/cli.ts`) - the old single-pair cli.ts had this, the new
  multi-pair version doesn't yet.
- **Run mode is global, not per-pair** - PAUSED/DRY_RUN/PAPER/LIVE applies to
  every pair at once; pausing just XMR while running XAUT live isn't possible
  yet.
- Dashboard package dependencies (React/Vite/Tailwind) haven't been installed
  or build-verified in this environment - typecheck/test were run for every
  other package but not this one.
