-- Seed users (passwords are 'password123' hashed with bcrypt)
INSERT INTO users (id, username, email, password_hash, display_name, is_verified)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Trader', true),
  ('b0000000-0000-0000-0000-000000000002', 'bob', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Investor', true)
ON CONFLICT (username) DO NOTHING;

-- Seed wallets for alice
INSERT INTO wallets (user_id, currency_id, balance) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'USD', 100000),
  ('a0000000-0000-0000-0000-000000000001', 'BTC', 1.5),
  ('a0000000-0000-0000-0000-000000000001', 'ETH', 10),
  ('a0000000-0000-0000-0000-000000000001', 'SOL', 100),
  ('a0000000-0000-0000-0000-000000000001', 'DOGE', 50000),
  ('a0000000-0000-0000-0000-000000000001', 'ADA', 5000),
  ('a0000000-0000-0000-0000-000000000001', 'DOT', 200),
  ('a0000000-0000-0000-0000-000000000001', 'AVAX', 100),
  ('a0000000-0000-0000-0000-000000000001', 'LINK', 300)
ON CONFLICT (user_id, currency_id) DO NOTHING;

-- Seed wallets for bob
INSERT INTO wallets (user_id, currency_id, balance) VALUES
  ('b0000000-0000-0000-0000-000000000002', 'USD', 100000),
  ('b0000000-0000-0000-0000-000000000002', 'BTC', 0.5),
  ('b0000000-0000-0000-0000-000000000002', 'ETH', 5),
  ('b0000000-0000-0000-0000-000000000002', 'SOL', 50),
  ('b0000000-0000-0000-0000-000000000002', 'DOGE', 25000),
  ('b0000000-0000-0000-0000-000000000002', 'XRP', 10000)
ON CONFLICT (user_id, currency_id) DO NOTHING;

-- Seed historical candle data for BTC-USD (last 60 1-minute candles)
DO $$
DECLARE
  i INT;
  base_price DECIMAL(28,18) := 65000;
  price DECIMAL(28,18);
  open_price DECIMAL(28,18);
  high_price DECIMAL(28,18);
  low_price DECIMAL(28,18);
  close_price DECIMAL(28,18);
  vol DECIMAL(28,18);
  candle_time TIMESTAMPTZ;
BEGIN
  FOR i IN 1..60 LOOP
    candle_time := NOW() - (i || ' minutes')::INTERVAL;
    price := base_price + (random() * 2000 - 1000);
    open_price := price + (random() * 200 - 100);
    close_price := price + (random() * 200 - 100);
    high_price := GREATEST(open_price, close_price) + random() * 150;
    low_price := LEAST(open_price, close_price) - random() * 150;
    vol := random() * 500000 + 100000;

    INSERT INTO price_candles (symbol, interval, open_time, open, high, low, close, volume)
    VALUES ('BTC-USD', '1m', date_trunc('minute', candle_time), open_price, high_price, low_price, close_price, vol)
    ON CONFLICT (symbol, interval, open_time) DO NOTHING;
  END LOOP;
END $$;

-- Seed historical candle data for ETH-USD
DO $$
DECLARE
  i INT;
  base_price DECIMAL(28,18) := 3500;
  price DECIMAL(28,18);
  open_price DECIMAL(28,18);
  high_price DECIMAL(28,18);
  low_price DECIMAL(28,18);
  close_price DECIMAL(28,18);
  vol DECIMAL(28,18);
  candle_time TIMESTAMPTZ;
BEGIN
  FOR i IN 1..60 LOOP
    candle_time := NOW() - (i || ' minutes')::INTERVAL;
    price := base_price + (random() * 200 - 100);
    open_price := price + (random() * 20 - 10);
    close_price := price + (random() * 20 - 10);
    high_price := GREATEST(open_price, close_price) + random() * 15;
    low_price := LEAST(open_price, close_price) - random() * 15;
    vol := random() * 2000000 + 500000;

    INSERT INTO price_candles (symbol, interval, open_time, open, high, low, close, volume)
    VALUES ('ETH-USD', '1m', date_trunc('minute', candle_time), open_price, high_price, low_price, close_price, vol)
    ON CONFLICT (symbol, interval, open_time) DO NOTHING;
  END LOOP;
END $$;

-- Seed historical candle data for SOL-USD
DO $$
DECLARE
  i INT;
  base_price DECIMAL(28,18) := 150;
  price DECIMAL(28,18);
  open_price DECIMAL(28,18);
  high_price DECIMAL(28,18);
  low_price DECIMAL(28,18);
  close_price DECIMAL(28,18);
  vol DECIMAL(28,18);
  candle_time TIMESTAMPTZ;
BEGIN
  FOR i IN 1..60 LOOP
    candle_time := NOW() - (i || ' minutes')::INTERVAL;
    price := base_price + (random() * 20 - 10);
    open_price := price + (random() * 2 - 1);
    close_price := price + (random() * 2 - 1);
    high_price := GREATEST(open_price, close_price) + random() * 3;
    low_price := LEAST(open_price, close_price) - random() * 3;
    vol := random() * 5000000 + 1000000;

    INSERT INTO price_candles (symbol, interval, open_time, open, high, low, close, volume)
    VALUES ('SOL-USD', '1m', date_trunc('minute', candle_time), open_price, high_price, low_price, close_price, vol)
    ON CONFLICT (symbol, interval, open_time) DO NOTHING;
  END LOOP;
END $$;

-- Seed some sample deposit transactions
INSERT INTO transactions (user_id, type, currency_id, amount, status) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'deposit', 'USD', 100000, 'completed'),
  ('a0000000-0000-0000-0000-000000000001', 'deposit', 'BTC', 1.5, 'completed'),
  ('a0000000-0000-0000-0000-000000000001', 'deposit', 'ETH', 10, 'completed'),
  ('b0000000-0000-0000-0000-000000000002', 'deposit', 'USD', 100000, 'completed'),
  ('b0000000-0000-0000-0000-000000000002', 'deposit', 'BTC', 0.5, 'completed');

-- Resting orders, so the order book has depth and boot-time rehydration has
-- something to rebuild. Prices sit outside the simulator's +/-2% starting band
-- so nothing crosses. Each order carries the hold it would have reserved:
-- sells hold base quantity; buys hold quantity x limit x (1 + 0.2% taker fee).
INSERT INTO orders (id, user_id, trading_pair_id, side, order_type, quantity, price, stop_price, hold_remaining, status)
SELECT o.id::uuid, o.user_id::uuid, tp.id, o.side, o.order_type, o.quantity, o.price, o.stop_price, o.hold, 'open'
FROM (VALUES
  ('5eed0000-0000-4000-8000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'BTC-USD', 'sell', 'limit', 0.05, 67500, NULL::numeric, 0.05),
  ('5eed0000-0000-4000-8000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'BTC-USD', 'sell', 'limit', 0.08, 68200, NULL, 0.08),
  ('5eed0000-0000-4000-8000-000000000003', 'b0000000-0000-0000-0000-000000000002', 'BTC-USD', 'sell', 'limit', 0.10, 69000, NULL, 0.10),
  ('5eed0000-0000-4000-8000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'BTC-USD', 'buy', 'limit', 0.04, 63200, NULL, 2533.056),
  ('5eed0000-0000-4000-8000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'BTC-USD', 'buy', 'limit', 0.06, 62500, NULL, 3757.5),
  ('5eed0000-0000-4000-8000-000000000006', 'a0000000-0000-0000-0000-000000000001', 'BTC-USD', 'buy', 'limit', 0.10, 61800, NULL, 6192.36),
  ('5eed0000-0000-4000-8000-000000000007', 'b0000000-0000-0000-0000-000000000002', 'ETH-USD', 'sell', 'limit', 1.0, 3640, NULL, 1.0),
  ('5eed0000-0000-4000-8000-000000000008', 'b0000000-0000-0000-0000-000000000002', 'ETH-USD', 'sell', 'limit', 1.5, 3700, NULL, 1.5),
  ('5eed0000-0000-4000-8000-000000000009', 'a0000000-0000-0000-0000-000000000001', 'ETH-USD', 'buy', 'limit', 1.2, 3360, NULL, 4040.064),
  ('5eed0000-0000-4000-8000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'ETH-USD', 'buy', 'limit', 0.8, 3300, NULL, 2645.28),
  -- An armed stop-loss: sells 0.1 BTC at market if BTC falls to 60,000.
  ('5eed0000-0000-4000-8000-00000000000b', 'a0000000-0000-0000-0000-000000000001', 'BTC-USD', 'sell', 'stop', 0.10, NULL, 60000, 0.10)
) AS o(id, user_id, symbol, side, order_type, quantity, price, stop_price, hold)
JOIN trading_pairs tp ON tp.symbol = o.symbol
ON CONFLICT (id) DO NOTHING;

-- Reservations are exactly the holds of live orders.
UPDATE wallets w
SET reserved_balance = h.held
FROM (
  SELECT o.user_id,
         CASE WHEN o.side = 'buy' THEN tp.quote_currency_id ELSE tp.base_currency_id END AS currency_id,
         SUM(o.hold_remaining) AS held
  FROM orders o
  JOIN trading_pairs tp ON tp.id = o.trading_pair_id
  WHERE o.status IN ('open', 'partially_filled')
  GROUP BY 1, 2
) h
WHERE w.user_id = h.user_id AND w.currency_id = h.currency_id;
