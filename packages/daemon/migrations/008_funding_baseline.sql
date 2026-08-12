-- Bug found live Aug 2026 (round 3): a pair's "funded" cost-basis baseline
-- (used to compute the "vs funded" yield/PnL line on each pair's NAV chart)
-- used to be frozen forever at that pair's very first-ever recorded NAV
-- point (see #95/#101). That correctly stopped "funded" from silently
-- drifting on every ordinary regime re-evaluation, but it broke down the
-- moment a REAL cross-pair reallocation happens (a manual override change,
-- or a regime-driven 100/0 <-> 50/50 transition): moving capital from one
-- pair to another on purpose then gets counted as if it were trading
-- loss/gain against the stale original baseline, producing wildly
-- misleading yield percentages that have nothing to do with actual trading
-- performance.
--
-- This table re-baselines a pair's funded figure to its current
-- BTC-equivalent value every time its cross-pair target_fraction actually
-- changes (compared against target_fraction_at_set, the value it was at
-- when the baseline was last set) - whether that change came from a manual
-- override or an organic regime shift. Between reallocation events, the
-- baseline stays fixed exactly like before, so ordinary regime
-- re-evaluation each tick (which usually doesn't change the target) still
-- doesn't cause drift.

CREATE TABLE IF NOT EXISTS funding_baseline (
  pair_key TEXT PRIMARY KEY,
  btc_equivalent_nav REAL NOT NULL,
  target_fraction_at_set REAL NOT NULL,
  set_at INTEGER NOT NULL
);
