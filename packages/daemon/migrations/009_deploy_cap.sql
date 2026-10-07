-- Operator-editable daily deployment cap (Oct 2026). Limits capital moved INTO
-- rotation assets (flip entries, allocation increases, idle top-ups; all
-- pairs combined) over a rolling 24h, so a large deposit is drip-fed instead
-- of hitting a thin order book at once. Exits to BTC are never capped. No row
-- = fall back to config.execution.maxDeployUsdPerDay.
CREATE TABLE IF NOT EXISTS deploy_cap (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row
  enabled INTEGER NOT NULL DEFAULT 1,
  max_usd_per_day REAL NOT NULL DEFAULT 10000 CHECK (max_usd_per_day > 0),
  updated_at INTEGER NOT NULL
);
