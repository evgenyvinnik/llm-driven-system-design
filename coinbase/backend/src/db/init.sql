CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  is_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS currencies (
  id VARCHAR(10) PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  symbol VARCHAR(10) NOT NULL,
  icon_url TEXT,
  decimals INT DEFAULT 8,
  is_fiat BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS trading_pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(20) UNIQUE NOT NULL,
  base_currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  quote_currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  min_order_size DECIMAL(28,18) DEFAULT 0.00000001,
  max_order_size DECIMAL(28,18) DEFAULT 1000000,
  price_precision INT DEFAULT 2,
  quantity_precision INT DEFAULT 8,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  balance DECIMAL(28,18) DEFAULT 0,
  reserved_balance DECIMAL(28,18) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, currency_id),
  CHECK (balance >= 0),
  CHECK (reserved_balance >= 0),
  CHECK (balance >= reserved_balance)
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  trading_pair_id UUID NOT NULL REFERENCES trading_pairs(id),
  side VARCHAR(4) NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type VARCHAR(10) NOT NULL CHECK (order_type IN ('market', 'limit', 'stop')),
  quantity DECIMAL(28,18) NOT NULL,
  price DECIMAL(28,18),
  stop_price DECIMAL(28,18),
  filled_quantity DECIMAL(28,18) DEFAULT 0,
  avg_fill_price DECIMAL(28,18),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected')),
  idempotency_key VARCHAR(64),
  -- Funds still held for this order (quote for buys, base for sells). Fills
  -- spend from it; finishing or cancelling releases the rest. Kept per order so
  -- a release returns exactly what was held instead of recomputing it.
  hold_remaining DECIMAL(28,18) NOT NULL DEFAULT 0,
  -- Arrival order, assigned by Postgres. The in-memory book uses it for time
  -- priority, so rebuilding from this table reproduces the same book.
  arrival_seq BIGSERIAL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trading_pair_id UUID NOT NULL REFERENCES trading_pairs(id),
  buy_order_id UUID NOT NULL REFERENCES orders(id),
  sell_order_id UUID NOT NULL REFERENCES orders(id),
  price DECIMAL(28,18) NOT NULL,
  quantity DECIMAL(28,18) NOT NULL,
  buyer_fee DECIMAL(28,18) DEFAULT 0,
  seller_fee DECIMAL(28,18) DEFAULT 0,
  taker_side VARCHAR(4) CHECK (taker_side IN ('buy', 'sell')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_candles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol VARCHAR(20) NOT NULL,
  interval VARCHAR(5) NOT NULL CHECK (interval IN ('1m', '5m', '15m', '1h', '4h', '1d')),
  open_time TIMESTAMPTZ NOT NULL,
  open DECIMAL(28,18) NOT NULL,
  high DECIMAL(28,18) NOT NULL,
  low DECIMAL(28,18) NOT NULL,
  close DECIMAL(28,18) NOT NULL,
  volume DECIMAL(28,18) DEFAULT 0,
  UNIQUE(symbol, interval, open_time)
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  total_value_usd DECIMAL(28,18) NOT NULL,
  breakdown JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type VARCHAR(20) NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'trade', 'fee')),
  currency_id VARCHAR(10) NOT NULL REFERENCES currencies(id),
  amount DECIMAL(28,18) NOT NULL,
  fee DECIMAL(28,18) DEFAULT 0,
  reference_id UUID,
  status VARCHAR(20) DEFAULT 'completed',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed currencies
INSERT INTO currencies (id, name, symbol, decimals, is_fiat) VALUES
  ('BTC', 'Bitcoin', '₿', 8, false),
  ('ETH', 'Ethereum', 'Ξ', 18, false),
  ('SOL', 'Solana', 'SOL', 9, false),
  ('DOGE', 'Dogecoin', 'Ð', 8, false),
  ('ADA', 'Cardano', 'ADA', 6, false),
  ('DOT', 'Polkadot', 'DOT', 10, false),
  ('AVAX', 'Avalanche', 'AVAX', 18, false),
  ('LINK', 'Chainlink', 'LINK', 18, false),
  ('MATIC', 'Polygon', 'MATIC', 18, false),
  ('XRP', 'Ripple', 'XRP', 6, false),
  ('USD', 'US Dollar', '$', 2, true),
  ('USDT', 'Tether', 'USDT', 6, false),
  ('USDC', 'USD Coin', 'USDC', 6, false)
ON CONFLICT (id) DO NOTHING;

-- Seed trading pairs
INSERT INTO trading_pairs (symbol, base_currency_id, quote_currency_id, price_precision, quantity_precision) VALUES
  ('BTC-USD', 'BTC', 'USD', 2, 8),
  ('ETH-USD', 'ETH', 'USD', 2, 8),
  ('SOL-USD', 'SOL', 'USD', 2, 4),
  ('DOGE-USD', 'DOGE', 'USD', 6, 0),
  ('ADA-USD', 'ADA', 'USD', 4, 2),
  ('DOT-USD', 'DOT', 'USD', 2, 4),
  ('AVAX-USD', 'AVAX', 'USD', 2, 4),
  ('LINK-USD', 'LINK', 'USD', 2, 4),
  ('MATIC-USD', 'MATIC', 'USD', 4, 2),
  ('XRP-USD', 'XRP', 'USD', 4, 2),
  ('ETH-BTC', 'ETH', 'BTC', 6, 4),
  ('SOL-ETH', 'SOL', 'ETH', 6, 4)
ON CONFLICT (symbol) DO NOTHING;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_pair_status ON orders(trading_pair_id, status);
CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(trading_pair_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_candles_lookup ON price_candles(symbol, interval, open_time DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_user ON portfolio_snapshots(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);

-- Upgrades for databases created before the order-hold and arrival-sequence
-- columns existed. Every statement is safe to re-run (`npm run db:migrate`
-- executes this whole file against an already-initialized database).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_remaining DECIMAL(28,18) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS arrival_seq BIGSERIAL;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS taker_side VARCHAR(4);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_hold_remaining_check;
ALTER TABLE orders ADD CONSTRAINT orders_hold_remaining_check CHECK (hold_remaining >= 0);

-- Idempotency keys are scoped per user, not global: two users picking the same
-- key must not collide (or see each other's order).
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_idempotency
  ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_live ON orders(trading_pair_id, arrival_seq)
  WHERE status IN ('open', 'partially_filled');

-- Backfill holds for orders that were live before hold_remaining existed, using
-- the reservation the old code made (remaining quantity at the order's price).
UPDATE orders
SET hold_remaining = CASE
      WHEN side = 'sell' THEN quantity - filled_quantity
      ELSE (quantity - filled_quantity) * COALESCE(price, stop_price, 0)
    END
WHERE status IN ('open', 'partially_filled') AND hold_remaining = 0;
