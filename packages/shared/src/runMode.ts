/**
 * Run-mode ladder for the daemon's execute stage.
 *
 * DRY_RUN  - logs "would trade", never touches the exchange.
 * PAPER    - real order mechanics against Bitfinex's paper-trading subaccount,
 *            no real funds at risk. Exercises the actual order-placement code path.
 * LIVE     - real orders against the real spot wallet, 3 BTC capital.
 * PAUSED   - no new entries; existing position management (stops/exits) still runs.
 *
 * Sequencing per the design doc: backtest -> DRY_RUN -> PAPER -> LIVE.
 */
export type RunMode = "DRY_RUN" | "PAPER" | "LIVE" | "PAUSED";

export const RUN_MODES: readonly RunMode[] = ["DRY_RUN", "PAPER", "LIVE", "PAUSED"];

export function isLiveCapital(mode: RunMode): boolean {
  return mode === "LIVE";
}
