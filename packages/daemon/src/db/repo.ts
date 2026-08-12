import type { ExecutionLogEntry, NavPoint, RunMode, StrategyDecision, Trade } from "@autopilot/shared";
import type { LarssonDayResult, RotationDayResult } from "@autopilot/strategy";
import type { DatabaseSyncLike } from "./types.js";

/** Legacy single-pair rows (predating multi-pair support) are implicitly this pair. */
const DEFAULT_PAIR_KEY = "xaut";

export class Repo {
  constructor(private readonly db: DatabaseSyncLike) {}

  // ---- run mode (live-editable, "no rebuild to tune") ----

  getRunMode(defaultMode: RunMode = "DRY_RUN"): RunMode {
    const row = this.db.prepare("SELECT mode FROM run_mode_state WHERE id = 1").get() as
      | { mode: RunMode }
      | undefined;
    return row?.mode ?? defaultMode;
  }

  setRunMode(mode: RunMode): void {
    this.db
      .prepare(
        `INSERT INTO run_mode_state (id, mode, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`
      )
      .run(mode, Date.now());
  }

  // ---- decisions ----

  insertDecision(decision: StrategyDecision): void {
    this.db
      .prepare(
        `INSERT INTO decisions (timestamp, regime, target, confidence, reason, confluence_json, confirmation_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decision.timestamp,
        decision.regime,
        decision.target,
        decision.confidence,
        decision.reason,
        decision.confluenceZone ? JSON.stringify(decision.confluenceZone) : null,
        decision.confirmation ? JSON.stringify(decision.confirmation) : null
      );
  }

  /**
   * Active decision source (see StrategyConfig.rotation in @autopilot/shared).
   * Separate table from the legacy `decisions` table above - see
   * migrations/002_rotation_decisions.sql for why.
   */
  insertRotationDecision(day: RotationDayResult): void {
    this.db
      .prepare(
        `INSERT INTO rotation_decisions (timestamp, r, sma, rsi, position, switched, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(day.timestamp, day.r, day.sma, day.rsi, day.position, day.switched ? 1 : 0, day.reason);
  }

  getLatestRotationDecision(): RotationDayResult | undefined {
    const row = this.db
      .prepare("SELECT * FROM rotation_decisions ORDER BY timestamp DESC LIMIT 1")
      .get();
    return row ? rowToRotationDayResult(row) : undefined;
  }

  /**
   * Active decision source (see StrategyConfig.larsson in @autopilot/shared).
   * Scoped per pair - see migrations/003_pair_state.sql.
   */
  insertLarssonDecision(pairKey: string, day: LarssonDayResult): void {
    this.db
      .prepare(
        `INSERT INTO larsson_decisions (pair_key, timestamp, r, v1, m1, m2, v2, regime, dist_from_baseline, position, switched, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        pairKey,
        day.timestamp,
        day.r,
        day.v1,
        day.m1,
        day.m2,
        day.v2,
        day.regime,
        day.distFromBaseline,
        day.position,
        day.switched ? 1 : 0,
        day.reason
      );
  }

  getLatestLarssonDecision(pairKey: string): LarssonDayResult | undefined {
    const row = this.db
      .prepare("SELECT * FROM larsson_decisions WHERE pair_key = ? ORDER BY timestamp DESC LIMIT 1")
      .get(pairKey);
    return row ? rowToLarssonDayResult(row) : undefined;
  }

  /** Most recent decisions for this pair, newest first - powers the dashboard's history/timeline view. */
  getRecentLarssonDecisions(pairKey: string, limit = 50): LarssonDayResult[] {
    const rows = this.db
      .prepare("SELECT * FROM larsson_decisions WHERE pair_key = ? ORDER BY timestamp DESC LIMIT ?")
      .all(pairKey, limit);
    return rows.map(rowToLarssonDayResult);
  }

  // ---- trades ----
  // Every method below is scoped by pairKey (PairConfig.key, e.g. "xaut"/
  // "xmr") so the daemon can track independent open positions per rotation
  // instance. Defaults to "xaut" for callers that predate multi-pair.

  insertTrade(trade: Trade): void {
    this.db
      .prepare(
        `INSERT INTO trades (id, run_mode, pair_key, opened_at, closed_at, target_position, btc_capital_at_open,
           risk_fraction_of_capital, stop_loss_ratio, first_target_ratio, status, realized_btc_pnl, notes,
           entry_price, exit_price)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        trade.id,
        trade.runMode,
        trade.pairKey ?? DEFAULT_PAIR_KEY,
        trade.openedAt,
        trade.closedAt ?? null,
        trade.targetPosition,
        trade.btcCapitalAtOpen,
        trade.riskFractionOfCapital,
        trade.stopLossRatio,
        trade.firstTargetRatio,
        trade.status,
        trade.realizedBtcPnl ?? null,
        trade.notes ?? null,
        trade.entryPrice ?? null,
        trade.exitPrice ?? null
      );
  }

  closeTrade(
    id: string,
    status: "closed_win" | "closed_loss" | "cancelled",
    realizedBtcPnl: number,
    exitPrice?: number
  ): void {
    this.db
      .prepare("UPDATE trades SET status = ?, closed_at = ?, realized_btc_pnl = ?, exit_price = ? WHERE id = ?")
      .run(status, Date.now(), realizedBtcPnl, exitPrice ?? null, id);
  }

  getOpenTrade(pairKey: string = DEFAULT_PAIR_KEY): Trade | undefined {
    const row = this.db
      .prepare("SELECT * FROM trades WHERE status = 'open' AND pair_key = ? LIMIT 1")
      .get(pairKey);
    return row ? rowToTrade(row) : undefined;
  }

  /** Most recent trades for this pair (any status), newest first - powers the dashboard's Timeline tab. */
  getRecentTrades(pairKey: string = DEFAULT_PAIR_KEY, limit = 50): Trade[] {
    const rows = this.db
      .prepare("SELECT * FROM trades WHERE pair_key = ? ORDER BY opened_at DESC LIMIT ?")
      .all(pairKey, limit);
    return rows.map(rowToTrade);
  }

  getLastStopOutAt(pairKey: string = DEFAULT_PAIR_KEY): number | undefined {
    const row = this.db
      .prepare(
        "SELECT closed_at FROM trades WHERE status = 'closed_loss' AND pair_key = ? ORDER BY closed_at DESC LIMIT 1"
      )
      .get(pairKey) as { closed_at: number } | undefined;
    return row?.closed_at;
  }

  /**
   * True if this pair has ever had a trade opened while run mode was LIVE.
   * Used by loop.ts's needsLiveBootstrapCheck to tell a genuinely-filled LIVE
   * position apart from a DRY_RUN/PAPER simulation that never actually
   * reached the exchange but was written into the same trades table.
   */
  hasLiveTrade(pairKey: string = DEFAULT_PAIR_KEY): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM trades WHERE pair_key = ? AND run_mode = 'LIVE' LIMIT 1")
      .get(pairKey);
    return row !== undefined;
  }

  /**
   * Backfill entry_price for any currently-OPEN trade that predates the
   * entry/exit price columns (migration 006, task #86) - without this, a
   * trade opened before that migration deployed shows "-" for Entry/Exit/PnL
   * indefinitely, since it's only ever set at insertTrade() time and this
   * trade already exists. Uses the earliest NAV point at or after the
   * trade's openedAt as a real historical approximation of the ratio price
   * at entry (nav_points.btc_xaut_ratio is the same asset-per-BTC convention
   * as entry_price/exit_price - see loop.ts's PnL formula), rather than
   * leaving it blank until the trade closes and a new one opens, which for a
   * regime-driven strategy can be weeks away. Safe to call on every daemon
   * startup: only touches rows where entry_price IS NULL, so it's a no-op
   * once backfilled, and self-corrects if a pair genuinely has no NAV
   * history yet at the moment this runs (no matching row, nothing updated).
   */
  backfillMissingEntryPrices(): void {
    const openTradesMissingEntry = (
      this.db.prepare("SELECT * FROM trades WHERE status = 'open' AND entry_price IS NULL").all()
    ).map(rowToTrade);
    for (const trade of openTradesMissingEntry) {
      const navRow = this.db
        .prepare(
          "SELECT btc_xaut_ratio FROM nav_points WHERE pair_key = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 1"
        )
        .get(trade.pairKey ?? DEFAULT_PAIR_KEY, trade.openedAt) as { btc_xaut_ratio: number } | undefined;
      if (navRow) {
        this.db.prepare("UPDATE trades SET entry_price = ? WHERE id = ?").run(navRow.btc_xaut_ratio, trade.id);
        console.log(
          `[autopilot] backfilled entry_price=${navRow.btc_xaut_ratio} for pre-existing open trade ${trade.id} (${trade.pairKey ?? DEFAULT_PAIR_KEY}).`
        );
      }
    }
  }

  // ---- execution log ----
  // Separate from `trades`: this records every real executeRotation() call -
  // flip entry/exit, cross-pair resizes, and idle-capital top-ups - so the
  // Timeline tab can show everything that actually moved capital on the
  // exchange, while the Status tab's trade table stays focused on just
  // entry/exit round-trip PnL (explicit user direction, Aug 2026).

  insertExecutionLog(entry: ExecutionLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO execution_log (id, pair_key, timestamp, kind, side, requested_btc, moved_btc, status, routes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.pairKey,
        entry.timestamp,
        entry.kind,
        entry.side,
        entry.requestedBtc,
        entry.movedBtc,
        entry.status,
        entry.routes
      );
  }

  /** Most recent execution attempts for this pair, newest first - powers the Timeline tab. */
  getRecentExecutions(pairKey: string = DEFAULT_PAIR_KEY, limit = 100): ExecutionLogEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM execution_log WHERE pair_key = ? ORDER BY timestamp DESC LIMIT ?")
      .all(pairKey, limit);
    return rows.map(rowToExecutionLogEntry);
  }

  // ---- nav ----

  insertNavPoint(nav: NavPoint): void {
    this.db
      .prepare(
        `INSERT INTO nav_points (timestamp, pair_key, btc_held, xaut_held, btc_xaut_ratio, btc_equivalent_nav, usd_equivalent_nav)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nav.timestamp,
        nav.pairKey ?? DEFAULT_PAIR_KEY,
        nav.btcHeld,
        nav.xautHeld,
        nav.btcXautRatio,
        nav.btcEquivalentNav,
        nav.usdEquivalentNav ?? null
      );
  }

  getLatestNavPoint(pairKey: string = DEFAULT_PAIR_KEY): NavPoint | undefined {
    const row = this.db
      .prepare("SELECT * FROM nav_points WHERE pair_key = ? ORDER BY timestamp DESC LIMIT 1")
      .get(pairKey);
    return row ? rowToNavPoint(row) : undefined;
  }

  getNavHistory(pairKey: string = DEFAULT_PAIR_KEY, sinceTimestamp = 0): NavPoint[] {
    const rows = this.db
      .prepare("SELECT * FROM nav_points WHERE pair_key = ? AND timestamp >= ? ORDER BY timestamp ASC")
      .all(pairKey, sinceTimestamp);
    return rows.map(rowToNavPoint);
  }

  /** Combined BTC-equivalent NAV across all pairs at the latest point each has reported. */
  getPortfolioBtcEquivalentNav(pairKeys: readonly string[]): number {
    return pairKeys.reduce((sum, key) => sum + (this.getLatestNavPoint(key)?.btcEquivalentNav ?? 0), 0);
  }

  // ---- cross-pair portfolio allocation (see @autopilot/strategy's computePortfolioAllocation) ----

  /** Last target fraction actually applied for this pair, or undefined if never set (first tick). */
  getAllocationFraction(pairKey: string): number | undefined {
    const row = this.db
      .prepare("SELECT target_fraction FROM allocation_state WHERE pair_key = ?")
      .get(pairKey) as { target_fraction: number } | undefined;
    return row?.target_fraction;
  }

  setAllocationFraction(pairKey: string, fraction: number): void {
    this.db
      .prepare(
        `INSERT INTO allocation_state (pair_key, target_fraction, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(pair_key) DO UPDATE SET target_fraction = excluded.target_fraction, updated_at = excluded.updated_at`
      )
      .run(pairKey, fraction, Date.now());
  }

  // ---- funding baseline (see migrations/008_funding_baseline.sql) ----
  // The BTC-equivalent value a pair's "vs funded" yield/PnL line is measured
  // against. Re-baselined to the pair's current value every time its
  // cross-pair target fraction actually changes (a real reallocation, manual
  // or regime-driven) - see loop.ts's gateAndExecute for where this is
  // detected and reset.

  getFundingBaseline(pairKey: string): { btcEquivalentNav: number; targetFractionAtSet: number; setAt: number } | undefined {
    const row = this.db
      .prepare("SELECT btc_equivalent_nav, target_fraction_at_set, set_at FROM funding_baseline WHERE pair_key = ?")
      .get(pairKey) as { btc_equivalent_nav: number; target_fraction_at_set: number; set_at: number } | undefined;
    return row
      ? { btcEquivalentNav: row.btc_equivalent_nav, targetFractionAtSet: row.target_fraction_at_set, setAt: row.set_at }
      : undefined;
  }

  setFundingBaseline(pairKey: string, btcEquivalentNav: number, targetFractionAtSet: number, setAt: number): void {
    this.db
      .prepare(
        `INSERT INTO funding_baseline (pair_key, btc_equivalent_nav, target_fraction_at_set, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(pair_key) DO UPDATE SET btc_equivalent_nav = excluded.btc_equivalent_nav, target_fraction_at_set = excluded.target_fraction_at_set, set_at = excluded.set_at`
      )
      .run(pairKey, btcEquivalentNav, targetFractionAtSet, setAt);
  }

  // ---- manual cross-pair allocation override (see @autopilot/strategy's
  // computePortfolioAllocation) ----
  // Operator-set override of the XAUT/XMR split, dashboard Config tab
  // (task #89/#93). Distinct from allocation_state above, which tracks the
  // LAST APPLIED fraction (used to detect whether a resize is needed); this
  // is the desired fraction the operator has asked for. When enabled, it
  // replaces computePortfolioAllocation()'s regime-driven split in loop.ts;
  // when disabled (default), behavior is unchanged from before this
  // feature existed. Stored as a single xautFraction (0-1) - XMR's share is
  // always 1 - xautFraction, so the two can never disagree/sum wrong.
  getAllocationOverride(): { enabled: boolean; xautFraction: number } {
    const row = this.db.prepare("SELECT enabled, xaut_fraction FROM allocation_override WHERE id = 1").get() as
      | { enabled: number; xaut_fraction: number }
      | undefined;
    return row
      ? { enabled: row.enabled === 1, xautFraction: row.xaut_fraction }
      : { enabled: false, xautFraction: 0.5 };
  }

  setAllocationOverride(enabled: boolean, xautFraction: number): void {
    this.db
      .prepare(
        `INSERT INTO allocation_override (id, enabled, xaut_fraction, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, xaut_fraction = excluded.xaut_fraction, updated_at = excluded.updated_at`
      )
      .run(enabled ? 1 : 0, xautFraction, Date.now());
  }
}

function rowToTrade(row: unknown): Trade {
  const r = row as Record<string, unknown>;
  const closedAt = r.closed_at as number | null;
  const realizedBtcPnl = r.realized_btc_pnl as number | null;
  const notes = r.notes as string | null;
  const pairKey = r.pair_key as string | null;
  const entryPrice = r.entry_price as number | null;
  const exitPrice = r.exit_price as number | null;

  return {
    id: r.id as string,
    runMode: r.run_mode as RunMode,
    openedAt: r.opened_at as number,
    targetPosition: r.target_position as Trade["targetPosition"],
    btcCapitalAtOpen: r.btc_capital_at_open as number,
    riskFractionOfCapital: r.risk_fraction_of_capital as number,
    stopLossRatio: r.stop_loss_ratio as number,
    firstTargetRatio: r.first_target_ratio as number,
    status: r.status as Trade["status"],
    trancheExecutionPlanIds: [],
    // exactOptionalPropertyTypes: only set these keys when a value is actually
    // present - `key: undefined` is not the same as omitting the key.
    ...(closedAt !== null ? { closedAt } : {}),
    ...(realizedBtcPnl !== null ? { realizedBtcPnl } : {}),
    ...(notes !== null ? { notes } : {}),
    ...(pairKey !== null ? { pairKey } : {}),
    ...(entryPrice !== null ? { entryPrice } : {}),
    ...(exitPrice !== null ? { exitPrice } : {}),
  };
}

function rowToExecutionLogEntry(row: unknown): ExecutionLogEntry {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    pairKey: r.pair_key as string,
    timestamp: r.timestamp as number,
    kind: r.kind as ExecutionLogEntry["kind"],
    side: r.side as ExecutionLogEntry["side"],
    requestedBtc: r.requested_btc as number,
    movedBtc: r.moved_btc as number,
    status: r.status as ExecutionLogEntry["status"],
    routes: r.routes as string,
  };
}

function rowToLarssonDayResult(row: unknown): LarssonDayResult {
  const r = row as Record<string, unknown>;
  return {
    timestamp: r.timestamp as number,
    r: r.r as number,
    v1: r.v1 as number,
    m1: r.m1 as number,
    m2: r.m2 as number,
    v2: r.v2 as number,
    regime: r.regime as LarssonDayResult["regime"],
    distFromBaseline: r.dist_from_baseline as number,
    position: r.position as LarssonDayResult["position"],
    switched: r.switched === 1,
    reason: r.reason as string,
  };
}

function rowToRotationDayResult(row: unknown): RotationDayResult {
  const r = row as Record<string, unknown>;
  return {
    timestamp: r.timestamp as number,
    r: r.r as number,
    sma: r.sma as number,
    rsi: r.rsi as number,
    position: r.position as RotationDayResult["position"],
    switched: r.switched === 1,
    reason: r.reason as string,
  };
}

function rowToNavPoint(row: unknown): NavPoint {
  const r = row as Record<string, unknown>;
  const usdEquivalentNav = r.usd_equivalent_nav as number | null;
  const pairKey = r.pair_key as string | null;

  return {
    timestamp: r.timestamp as number,
    btcHeld: r.btc_held as number,
    xautHeld: r.xaut_held as number,
    btcXautRatio: r.btc_xaut_ratio as number,
    btcEquivalentNav: r.btc_equivalent_nav as number,
    ...(usdEquivalentNav !== null ? { usdEquivalentNav } : {}),
    ...(pairKey !== null ? { pairKey } : {}),
  };
}
