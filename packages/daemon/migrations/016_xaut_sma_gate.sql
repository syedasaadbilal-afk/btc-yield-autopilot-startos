-- Optional XAUT entry block by BTC 4-year SMA multiple (Oct 2026). No row = disabled, threshold 1.5.
CREATE TABLE IF NOT EXISTS xaut_sma_gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL,
  threshold REAL NOT NULL CHECK (threshold > 0),
  updated_at INTEGER NOT NULL
);
