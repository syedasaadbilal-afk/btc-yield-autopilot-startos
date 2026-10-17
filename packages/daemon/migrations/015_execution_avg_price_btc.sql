-- Average fill price expressed in BTC per asset unit: each filled order's USDT
-- price converted at the BTC/USDT price of that moment, volume-weighted. This is
-- the number comparable to the TradingView XMR/BTC (or XAUT/BTC) price.
ALTER TABLE execution_log ADD COLUMN avg_price_btc REAL;
