-- Rotation strategy decisions (packages/strategy/src/rotation.ts), replacing
-- the legacy Fibonacci/trendline confluence decide() as the daemon's live
-- decision source (see StrategyConfig.rotation comment in @autopilot/shared).
-- Kept as its own table rather than migrating the old `decisions` table
-- in place, since the two decision shapes don't overlap (regime/confluence/
-- confirmation vs sma/rsi/switched) and the old table is left untouched so
-- any existing rows and the legacy decide() path both still work unmodified.

CREATE TABLE IF NOT EXISTS rotation_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  r REAL NOT NULL,
  sma REAL NOT NULL,
  rsi REAL NOT NULL,
  position TEXT NOT NULL CHECK (position IN ('flat', 'long')),
  switched INTEGER NOT NULL CHECK (switched IN (0, 1)),
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rotation_decisions_timestamp ON rotation_decisions(timestamp);
