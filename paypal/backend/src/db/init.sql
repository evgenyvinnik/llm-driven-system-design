CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL UNIQUE,
  balance_cents BIGINT DEFAULT 0 CHECK (balance_cents >= 0),
  currency VARCHAR(3) DEFAULT 'USD',
  version INTEGER DEFAULT 1,
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
  idempotency_key VARCHAR(255) UNIQUE,
  sender_id UUID REFERENCES users(id),
  recipient_id UUID REFERENCES users(id) NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency VARCHAR(3) DEFAULT 'USD',
  type VARCHAR(20) NOT NULL, -- 'transfer', 'deposit', 'withdrawal'
  status VARCHAR(20) DEFAULT 'completed',
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) NOT NULL,
  wallet_id UUID REFERENCES wallets(id) NOT NULL,
  entry_type VARCHAR(10) NOT NULL, -- 'debit' or 'credit'
  amount_cents BIGINT NOT NULL,
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_recipient ON transactions(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_payer ON transfer_requests(payer_id, status);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_requester ON transfer_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
