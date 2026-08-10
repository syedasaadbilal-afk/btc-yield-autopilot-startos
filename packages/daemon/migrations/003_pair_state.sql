-- Multi-pair support: the daemon now runs independent rotation instances
-- per PairConfig (default: xaut + xmr), each with its own open position and
-- BTC-equivalent NAV curve. Existing rows predate multi-pair and are all
-- implicitly the original "xaut" pair, hence DEFAULT 'xaut' below rather
-- than leaving pair_key nullable.

ALTER TABLE trades ADD COLUMN pair_key TEXT NOT NULL DEFAULT 'xaut';
ALTER TABLE nav_points ADD COLUMN pair_key TEXT NOT NULL DEFAULT 'xaut';

CREATE INDEX IF NOT EXISTS idx_trades_pair_key_status ON trades(pair_key, status);
CREATE INDEX IF NOT EXISTS idx_nav_points_pair_key_timestamp ON nav_points(pair_key, timestamp);

-- Active decision source for the Larsson Baseline + Overextension strategy
-- (packages/strategy/src/larssonRotation.ts), which superseded the
-- SMA200/RSI rotation_decisions table from migration 002. Kept as its own
-- table for the same reason 002 didn't reuse 001's `decisions` table: the
-- shapes don't overlap (sma/rsi/switched vs v1/m1/m2/v2/regime/distFromBaseline).
CREATE TABLE IF NOT EXISTS larsson_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_key TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  r REAL NOT NULL,
  v1 REAL NOT NULL,
  m1 REAL NOT NULL,
  m2 REAL NOT NULL,
  v2 REAL NOT NULL,
  regime TEXT NOT NULL CHECK (regime IN ('gray', 'orange', 'navy')),
  dist_from_baseline REAL NOT NULL,
  position TEXT NOT NULL CHECK (position IN ('flat', 'long')),
  switched INTEGER NOT NULL CHECK (switched IN (0, 1)),
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_larsson_decisions_pair_key_timestamp ON larsson_decisions(pair_key, timestamp);
