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
