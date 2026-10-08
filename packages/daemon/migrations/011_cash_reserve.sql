-- Operator-set required cash (USDT) to keep in the wallet (Oct 2026). No row/0 = none.
CREATE TABLE IF NOT EXISTS cash_reserve (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  usdt REAL NOT NULL CHECK (usdt >= 0),
  updated_at INTEGER NOT NULL
);
