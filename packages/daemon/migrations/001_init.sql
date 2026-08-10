-- BTC/XAUT Autopilot - initial schema.
-- All monetary amounts are stored as REAL in BTC or XAUT base units (design doc
-- Section 0: BTC yield is the objective, so nav_points.btc_equivalent_nav is
-- the primary series the dashboard charts).

CREATE TABLE IF NOT EXISTS run_mode_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row
  mode TEXT NOT NULL CHECK (mode IN ('DRY_RUN', 'PAPER', 'LIVE', 'PAUSED')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  regime TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('flat', 'long')),
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  confluence_json TEXT,
  confirmation_json TEXT
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  run_mode TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  target_position TEXT NOT NULL CHECK (target_position IN ('flat', 'long')),
  btc_capital_at_open REAL NOT NULL,
  risk_fraction_of_capital REAL NOT NULL,
  stop_loss_ratio REAL NOT NULL,
  first_target_ratio REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed_win', 'closed_loss', 'cancelled')),
  realized_btc_pnl REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS tranche_execution_plans (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  tranche_weight REAL NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy_btc_with_xaut', 'sell_btc_for_xaut')),
  window_ms INTEGER NOT NULL,
  num_clips INTEGER NOT NULL,
  leg_fallback_json TEXT
);

CREATE TABLE IF NOT EXISTS order_clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL REFERENCES tranche_execution_plans(id),
  clip_index INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  max_fraction_of_book_depth REAL NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'placed', 'filled', 'partially_filled', 'cancelled', 'rejected')
  ),
  exchange_order_id TEXT,
  filled_base_amount REAL,
  avg_fill_price REAL
);

CREATE TABLE IF NOT EXISTS nav_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  btc_held REAL NOT NULL,
  xaut_held REAL NOT NULL,
  btc_xaut_ratio REAL NOT NULL,
  btc_equivalent_nav REAL NOT NULL,
  usd_equivalent_nav REAL
);

CREATE INDEX IF NOT EXISTS idx_nav_points_timestamp ON nav_points(timestamp);
CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
