/**
 * One row per real execution attempt (executeRotation call) - distinct from
 * `Trade`, which only tracks a pair's own flat<->long flip. This captures
 * everything ELSE that moves real capital on the exchange: cross-pair
 * allocation resizes (Case 2a in loop.ts), idle-capital top-ups (Case 2b),
 * and the flip itself, including which route (direct vs USDT legs) each
 * attempt used and whether it actually moved anything or got blocked by an
 * exchange minimum. Added per explicit user request (Aug 2026): the
 * Status tab's trade table should show only entry/exit round-trip PnL, and
 * everything else - resizes, USDT-leg trades - belongs in the Timeline tab.
 */
export interface ExecutionLogEntry {
  id: string;
  pairKey: string;
  timestamp: number;
  /** Which loop.ts branch produced this attempt. */
  kind: "flip_entry" | "flip_exit" | "resize" | "topup";
  side: "buy_btc_with_xaut" | "sell_btc_for_xaut";
  requestedBtc: number;
  /** Real BTC actually moved (executeRotation's totalBtcMoved) - 0 if blocked. */
  movedBtc: number;
  status: "executed" | "blocked";
  /** Comma-joined route per tranche/leg, e.g. "direct,direct,usdt" - quick visibility without a separate table. */
  routes: string;
}
