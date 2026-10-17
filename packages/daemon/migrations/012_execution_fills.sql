-- Per-execution order summary: how many asset-leg orders filled, how much of
-- the asset they bought/sold, the USDT value, and the true average fill price
-- (from Bitfinex's order average price). `orders` holds every filled order as
-- JSON for audit. All nullable: rows logged before this migration have none.
ALTER TABLE execution_log ADD COLUMN order_count INTEGER;
ALTER TABLE execution_log ADD COLUMN asset_amount REAL;
ALTER TABLE execution_log ADD COLUMN quote_usd REAL;
ALTER TABLE execution_log ADD COLUMN avg_price REAL;
ALTER TABLE execution_log ADD COLUMN orders TEXT;
