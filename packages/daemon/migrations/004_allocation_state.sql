-- Cross-pair portfolio allocation (session 2026-08-09): each pair's slice of
-- total capital is no longer a fixed PairConfig.capitalFractionBtc - it's
-- computed every tick from comparing XAUT's and XMR's regimes (see
-- packages/strategy/src/portfolioAllocation.ts). This table tracks the
-- fraction actually applied last, per pair, so the daemon can tell "the
-- target changed since last tick, a resize trade is needed" apart from
-- ordinary price drift in an already-held asset's value (which should NOT
-- trigger a resize - see loop.ts).

CREATE TABLE IF NOT EXISTS allocation_state (
  pair_key TEXT PRIMARY KEY,
  target_fraction REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
