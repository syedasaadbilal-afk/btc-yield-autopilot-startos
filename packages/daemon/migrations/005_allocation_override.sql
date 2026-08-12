-- Manual allocation override for the XAUT/XMR cross-pair split (task #89).
-- computePortfolioAllocation() in packages/strategy computes the XAUT/XMR
-- split dynamically every tick from each pair's own Larsson regime; this
-- table lets the operator pin that split to a fixed value instead. It only
-- ever supplies the SIZING fraction used when a pair is eligible to hold its
-- gold asset - each pair's own regime signal still independently decides
-- whether that pair holds its asset or BTC at all (see loop.ts
-- observeAndDecide), so an override can never force a pair into holding an
-- asset its own signal says to exit.
CREATE TABLE IF NOT EXISTS allocation_override (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row
  enabled INTEGER NOT NULL DEFAULT 0,
  xaut_fraction REAL NOT NULL DEFAULT 0.5 CHECK (xaut_fraction >= 0 AND xaut_fraction <= 1),
  updated_at INTEGER NOT NULL
);
