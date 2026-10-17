-- Real average-fill prices (asset-per-BTC, same convention as entry_price /
-- exit_price) so trade PnL can be computed from what was actually paid/received
-- rather than the signal bar's close. Nullable: older rows have none.
ALTER TABLE trades ADD COLUMN actual_entry_price REAL;
ALTER TABLE trades ADD COLUMN actual_exit_price REAL;
