-- Execution log (task: separate "Recent trades" on Status tab, which should
-- only show entry/exit round-trip PnL, from the full record of everything
-- that actually moves capital on the exchange - cross-pair resizes, idle
-- top-ups, and the flip itself - which belongs on the Timeline tab.

CREATE TABLE IF NOT EXISTS execution_log (
  id TEXT PRIMARY KEY,
  pair_key TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('flip_entry', 'flip_exit', 'resize', 'topup')),
  side TEXT NOT NULL CHECK (side IN ('buy_btc_with_xaut', 'sell_btc_for_xaut')),
  requested_btc REAL NOT NULL,
  moved_btc REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('executed', 'blocked')),
  routes TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_log_pair_key_timestamp ON execution_log(pair_key, timestamp);
