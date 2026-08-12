-- Entry/exit ratio prices for trades (task #86), enabling real realized PnL
-- computation instead of the previous hardcoded 0. entry_price/exit_price
-- are the pair's accounting-candle close (asset priced in BTC) at trade
-- open/close, matching the existing stop_loss_ratio/first_target_ratio
-- convention already used for "long" (BTC-holding) trades. For a "long"
-- trade, realized PnL is the opportunity-cost capture versus staying in the
-- asset: btcCapitalAtOpen * (1 - exitPrice / entryPrice).
ALTER TABLE trades ADD COLUMN entry_price REAL;
ALTER TABLE trades ADD COLUMN exit_price REAL;
