-- Payment System Database Schema
-- Double-entry bookkeeping with idempotency support

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- System accounts (for double-entry bookkeeping)
CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL UNIQUE,
    account_type    VARCHAR(50) NOT NULL, -- 'asset', 'liability', 'revenue', 'expense', 'merchant'
    currency        VARCHAR(3) DEFAULT 'USD',
    balance         BIGINT DEFAULT 0, -- In cents
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Merchants (our customers)
CREATE TABLE merchants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_id      UUID NOT NULL REFERENCES accounts(id),
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    api_key_hash    VARCHAR(255) NOT NULL,
    webhook_url     VARCHAR(512),
    webhook_secret  VARCHAR(64),
    default_currency VARCHAR(3) DEFAULT 'USD',
    status          VARCHAR(20) DEFAULT 'active', -- active, suspended, closed
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Payment transactions
CREATE TABLE transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    idempotency_key VARCHAR(64) UNIQUE,  -- Critical for retry safety
    merchant_id     UUID NOT NULL REFERENCES merchants(id),
    amount          BIGINT NOT NULL,      -- Cents to avoid floating point
    currency        VARCHAR(3) NOT NULL,
    status          VARCHAR(20) NOT NULL, -- pending, authorized, captured, failed, refunded, voided
    payment_method  JSONB NOT NULL,       -- Card type, last 4 digits, etc.
    description     VARCHAR(500),
    customer_email  VARCHAR(255),
    risk_score      INTEGER,
    processor_ref   VARCHAR(64),          -- External processor's reference
    fee_amount      BIGINT DEFAULT 0,     -- Our fee in cents
    net_amount      BIGINT DEFAULT 0,     -- Amount after fees
    metadata        JSONB DEFAULT '{}',
    captured_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    version         INTEGER DEFAULT 0
);

-- Ledger entries (double-entry bookkeeping)
CREATE TABLE ledger_entries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id  UUID NOT NULL REFERENCES transactions(id),
    account_id      UUID NOT NULL REFERENCES accounts(id),
    entry_type      VARCHAR(10) NOT NULL CHECK (entry_type IN ('debit', 'credit')),
    amount          BIGINT NOT NULL CHECK (amount > 0),
    currency        VARCHAR(3) NOT NULL,
    balance_after   BIGINT NOT NULL,
    description     VARCHAR(255),
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Refunds (linked to original transaction)
CREATE TABLE refunds (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    idempotency_key     VARCHAR(64) UNIQUE,
    original_tx_id      UUID NOT NULL REFERENCES transactions(id),
    merchant_id         UUID NOT NULL REFERENCES merchants(id),
    amount              BIGINT NOT NULL,
    reason              VARCHAR(255),
    status              VARCHAR(20) NOT NULL, -- pending, completed, failed
    processor_ref       VARCHAR(64),
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Chargebacks
CREATE TABLE chargebacks (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id      UUID NOT NULL REFERENCES transactions(id),
    merchant_id         UUID NOT NULL REFERENCES merchants(id),
    amount              BIGINT NOT NULL,
    reason_code         VARCHAR(20),
    reason_description  VARCHAR(500),
    status              VARCHAR(20) NOT NULL, -- open, won, lost, pending_response
    evidence_due_date   TIMESTAMP WITH TIME ZONE,
    processor_ref       VARCHAR(64),
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Webhook deliveries
CREATE TABLE webhook_deliveries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id     UUID NOT NULL REFERENCES merchants(id),
    event_type      VARCHAR(50) NOT NULL,
    payload         JSONB NOT NULL,
    status          VARCHAR(20) NOT NULL, -- pending, delivered, failed
    attempts        INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMP WITH TIME ZONE,
    delivered_at    TIMESTAMP WITH TIME ZONE,
    next_retry_at   TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Idempotency keys cache (for quick lookup)
CREATE TABLE idempotency_keys (
    key             VARCHAR(64) PRIMARY KEY,
    transaction_id  UUID REFERENCES transactions(id),
    response        JSONB,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '24 hours'
);

-- Indexes for performance
CREATE INDEX idx_transactions_merchant_id ON transactions(merchant_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX idx_transactions_idempotency_key ON transactions(idempotency_key);

CREATE INDEX idx_ledger_entries_transaction_id ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_entries_account_id ON ledger_entries(account_id);
CREATE INDEX idx_ledger_entries_created_at ON ledger_entries(created_at DESC);

CREATE INDEX idx_refunds_original_tx_id ON refunds(original_tx_id);
CREATE INDEX idx_refunds_merchant_id ON refunds(merchant_id);

CREATE INDEX idx_chargebacks_transaction_id ON chargebacks(transaction_id);
CREATE INDEX idx_chargebacks_merchant_id ON chargebacks(merchant_id);
CREATE INDEX idx_chargebacks_status ON chargebacks(status);

CREATE INDEX idx_webhook_deliveries_merchant_id ON webhook_deliveries(merchant_id);
CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX idx_webhook_deliveries_next_retry_at ON webhook_deliveries(next_retry_at);

CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);

-- Insert system accounts
INSERT INTO accounts (id, name, account_type, currency) VALUES
    ('00000000-0000-0000-0000-000000000001', 'accounts_receivable', 'asset', 'USD'),
    ('00000000-0000-0000-0000-000000000002', 'platform_revenue', 'revenue', 'USD'),
    ('00000000-0000-0000-0000-000000000003', 'pending_settlements', 'liability', 'USD');
