CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user', -- 'user', 'admin', or 'system' (bookkeeping account, cannot log in)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL UNIQUE,
  -- NOT NULL matters: a NULL balance passes the CHECK below.
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  currency VARCHAR(3) DEFAULT 'USD',
  -- 'customer' wallets are what the platform owes each user (credit-normal:
  -- balance = credits - debits). The single 'platform_cash' wallet is the
  -- money the platform holds at its bank (debit-normal: balance = debits -
  -- credits). It is the other side of every deposit and withdrawal, so those
  -- are two-sided in the ledger like transfers, and the sum of all customer
  -- balances always equals platform cash.
  account_type VARCHAR(20) NOT NULL DEFAULT 'customer'
    CHECK (account_type IN ('customer', 'platform_cash')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  type VARCHAR(20) NOT NULL, -- 'bank' or 'card'
  label VARCHAR(100) NOT NULL,
  last_four VARCHAR(4),
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The client key that created this row, for audit. Not unique on its own:
  -- keys are scoped per user, and idempotency_keys enforces (user_id, key).
  idempotency_key VARCHAR(255),
  sender_id UUID REFERENCES users(id),
  recipient_id UUID REFERENCES users(id) NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency VARCHAR(3) DEFAULT 'USD',
  type VARCHAR(20) NOT NULL, -- 'transfer', 'deposit', 'withdrawal'
  status VARCHAR(20) DEFAULT 'completed',
  note TEXT,
  -- Funding source of a deposit or destination of a withdrawal. SET NULL so
  -- removing a card later doesn't rewrite or block history.
  payment_method_id UUID REFERENCES payment_methods(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) NOT NULL,
  wallet_id UUID REFERENCES wallets(id) NOT NULL,
  entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('debit', 'credit')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  balance_after_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfer_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID REFERENCES users(id) NOT NULL,
  payer_id UUID REFERENCES users(id) NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency VARCHAR(3) DEFAULT 'USD',
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'paid', 'declined', 'cancelled'
  -- The transfer that settled this request (set when status becomes 'paid').
  transaction_id UUID REFERENCES transactions(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Databases created before idempotency keys were scoped per user had a global
-- `key` primary key, so one user's key could replay another user's response.
-- The rows are only a 24-hour replay cache, so the old table is dropped and
-- recreated rather than migrated.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'idempotency_keys')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'idempotency_keys'
                       AND column_name = 'user_id') THEN
    DROP TABLE idempotency_keys;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id UUID NOT NULL REFERENCES users(id),
  key VARCHAR(255) NOT NULL,
  -- SHA-256 of the operation name and its parameters. Reusing a key for a
  -- different request is rejected instead of replaying an unrelated response.
  request_hash CHAR(64) NOT NULL,
  -- Written in the same transaction that claims the key, so other sessions
  -- never see it NULL: they wait on the primary key until that commit.
  response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
  PRIMARY KEY (user_id, key)
);

-- Upgrades for databases created before these columns and constraints existed.
ALTER TABLE wallets ALTER COLUMN balance_cents SET NOT NULL;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) NOT NULL DEFAULT 'customer'
  CHECK (account_type IN ('customer', 'platform_cash'));
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_idempotency_key_key;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method_id UUID
  REFERENCES payment_methods(id) ON DELETE SET NULL;
ALTER TABLE transfer_requests ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES transactions(id);

CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_recipient ON transactions(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_payer ON transfer_requests(payer_id, status);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_requester ON transfer_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
-- Exactly one platform cash account; deposits and withdrawals update it by type.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_one_platform_cash
  ON wallets(account_type) WHERE account_type = 'platform_cash';
-- At most one default payment method per user, even under concurrent updates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_one_default
  ON payment_methods(user_id) WHERE is_default;

-- The platform's own bookkeeping account. Its password hash is not a bcrypt
-- hash, so nobody can log in as it; user search and transfers exclude it.
INSERT INTO users (id, username, email, password_hash, display_name, role)
VALUES ('00000000-0000-0000-0000-000000000000', 'paypal-platform', 'platform@paypal.internal',
        '!', 'PayPal Platform Cash', 'system')
ON CONFLICT (id) DO NOTHING;

-- Starts at the sum of existing customer balances, so a database upgraded from
-- the single-sided ledger can still pay out withdrawals (0 on a fresh install).
INSERT INTO wallets (id, user_id, balance_cents, account_type)
SELECT '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
       COALESCE(SUM(balance_cents), 0), 'platform_cash'
FROM wallets WHERE account_type = 'customer'
ON CONFLICT DO NOTHING;
