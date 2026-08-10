import type { NavPoint, RunMode, StrategyDecision, Trade } from "@autopilot/shared";
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
           risk_fraction_of_capital, stop_loss_ratio, first_target_ratio, status, realized_btc_pnl, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        trade.notes ?? null
      );
  }

  closeTrade(id: string, status: "closed_win" | "closed_loss" | "cancelled", realizedBtcPnl: number): void {
    this.db
      .prepare("UPDATE trades SET status = ?, closed_at = ?, realized_btc_pnl = ? WHERE id = ?")
      .run(status, Date.now(), realizedBtcPnl, id);
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
}

function rowToTrade(row: unknown): Trade {
  const r = row as Record<string, unknown>;
  const closedAt = r.closed_at as number | null;
  const realizedBtcPnl = r.realized_btc_pnl as number | null;
  const notes = r.notes as string | null;
  const pairKey = r.pair_key as string | null;

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
