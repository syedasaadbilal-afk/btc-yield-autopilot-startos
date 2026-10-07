-- Operator-editable USD size of each phased limit order (Oct 2026). One order
-- of this size is open at a time; no row = config.execution.chunkUsd (10,000).
CREATE TABLE IF NOT EXISTS chunk_size (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chunk_usd REAL NOT NULL CHECK (chunk_usd > 0),
  updated_at INTEGER NOT NULL
);
