-- Stripe-like Payment Processing Schema
-- Double-entry ledger with full audit trail

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Merchants table
CREATE TABLE merchants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(200) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE,
  webhook_url VARCHAR(500),
  webhook_secret VARCHAR(100),
  api_key VARCHAR(64) NOT NULL UNIQUE,
  api_key_hash VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_merchants_api_key ON merchants(api_key);
CREATE INDEX idx_merchants_email ON merchants(email);

-- Customers table
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  email VARCHAR(200),
  name VARCHAR(200),
  phone VARCHAR(50),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_customers_merchant ON customers(merchant_id);
CREATE INDEX idx_customers_email ON customers(email);

-- Payment Methods (tokenized cards)
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL DEFAULT 'card' CHECK (type IN ('card', 'bank_account')),
  card_token VARCHAR(100), -- Simulated tokenized card
  card_last4 VARCHAR(4),
  card_brand VARCHAR(20),
  card_exp_month INTEGER CHECK (card_exp_month >= 1 AND card_exp_month <= 12),
  card_exp_year INTEGER CHECK (card_exp_year >= 2024),
  card_country VARCHAR(2) DEFAULT 'US',
  card_bin VARCHAR(6),
  billing_details JSONB DEFAULT '{}',
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_payment_methods_customer ON payment_methods(customer_id);
CREATE INDEX idx_payment_methods_merchant ON payment_methods(merchant_id);

-- Payment Intents (core payment lifecycle)
CREATE TABLE payment_intents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL CHECK (amount > 0), -- In cents
  currency VARCHAR(3) NOT NULL DEFAULT 'usd',
  status VARCHAR(30) NOT NULL DEFAULT 'requires_payment_method' CHECK (status IN (
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'requires_capture',
    'canceled',
    'succeeded',
    'failed'
  )),
  payment_method_id UUID REFERENCES payment_methods(id),
  capture_method VARCHAR(20) DEFAULT 'automatic' CHECK (capture_method IN ('automatic', 'manual')),
  auth_code VARCHAR(50),
  decline_code VARCHAR(50),
  error_message TEXT,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  idempotency_key VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_payment_intents_merchant ON payment_intents(merchant_id);
CREATE INDEX idx_payment_intents_customer ON payment_intents(customer_id);
CREATE INDEX idx_payment_intents_status ON payment_intents(status);
CREATE UNIQUE INDEX idx_payment_intents_idempotency ON payment_intents(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Charges (successful payment records)
CREATE TABLE charges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  amount_refunded INTEGER DEFAULT 0 CHECK (amount_refunded >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'usd',
  status VARCHAR(20) NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
  payment_method_id UUID REFERENCES payment_methods(id),
  fee INTEGER DEFAULT 0, -- Platform fee in cents
  net INTEGER DEFAULT 0, -- Amount after fee
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_charges_merchant ON charges(merchant_id);
CREATE INDEX idx_charges_payment_intent ON charges(payment_intent_id);

-- Refunds
CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  charge_id UUID NOT NULL REFERENCES charges(id) ON DELETE CASCADE,
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_refunds_charge ON refunds(charge_id);
CREATE INDEX idx_refunds_payment_intent ON refunds(payment_intent_id);

-- Ledger Entries (double-entry bookkeeping)
CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL, -- Groups related entries
  account VARCHAR(100) NOT NULL,
  debit INTEGER DEFAULT 0 CHECK (debit >= 0),
  credit INTEGER DEFAULT 0 CHECK (credit >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'usd',
  payment_intent_id UUID REFERENCES payment_intents(id),
  charge_id UUID REFERENCES charges(id),
  refund_id UUID REFERENCES refunds(id),
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  CONSTRAINT positive_entry CHECK (debit > 0 OR credit > 0),
  CONSTRAINT single_direction CHECK (NOT (debit > 0 AND credit > 0))
);

CREATE INDEX idx_ledger_account ON ledger_entries(account);
CREATE INDEX idx_ledger_transaction ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_payment_intent ON ledger_entries(payment_intent_id);
CREATE INDEX idx_ledger_created ON ledger_entries(created_at);

-- Webhook Events
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  type VARCHAR(100) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_webhook_events_merchant ON webhook_events(merchant_id);
CREATE INDEX idx_webhook_events_type ON webhook_events(type);

-- Webhook Deliveries
CREATE TABLE webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  url VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER DEFAULT 0,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  response_status INTEGER,
  delivered_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_event ON webhook_deliveries(event_id);
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries(status, next_retry_at) WHERE status = 'pending';

-- Disputes (chargebacks)
CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  charge_id UUID NOT NULL REFERENCES charges(id) ON DELETE CASCADE,
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason VARCHAR(100),
  status VARCHAR(30) DEFAULT 'needs_response' CHECK (status IN (
    'needs_response',
    'under_review',
    'won',
    'lost',
    'warning_closed'
  )),
  evidence JSONB DEFAULT '{}',
  evidence_due_by TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_disputes_charge ON disputes(charge_id);
CREATE INDEX idx_disputes_status ON disputes(status);

-- Idempotency Keys tracking
CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  request_path VARCHAR(255) NOT NULL,
  request_body_hash VARCHAR(64),
  response_status INTEGER,
  response_body JSONB,
  locked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '24 hours',

  UNIQUE(merchant_id, key)
);

CREATE INDEX idx_idempotency_keys_lookup ON idempotency_keys(merchant_id, key);
CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys(expires_at);

-- Risk Assessments (fraud detection logs)
CREATE TABLE risk_assessments (
  id BIGSERIAL PRIMARY KEY,
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  risk_score DECIMAL(5,4) NOT NULL CHECK (risk_score >= 0 AND risk_score <= 1),
  risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  signals JSONB NOT NULL DEFAULT '[]',
  decision VARCHAR(20) NOT NULL CHECK (decision IN ('allow', 'review', 'block')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_risk_assessments_payment_intent ON risk_assessments(payment_intent_id);
CREATE INDEX idx_risk_assessments_level ON risk_assessments(risk_level);

-- Helper function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers
CREATE TRIGGER update_merchants_updated_at BEFORE UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payment_intents_updated_at BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_disputes_updated_at BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Ledger balance view
CREATE OR REPLACE VIEW account_balances AS
SELECT
  account,
  currency,
  SUM(debit) as total_debit,
  SUM(credit) as total_credit,
  SUM(debit) - SUM(credit) as balance
FROM ledger_entries
GROUP BY account, currency;

-- Merchant balance view
CREATE OR REPLACE VIEW merchant_balances AS
SELECT
  m.id as merchant_id,
  m.name as merchant_name,
  COALESCE(l.currency, 'usd') as currency,
  COALESCE(SUM(l.credit) - SUM(l.debit), 0) as available_balance,
  COUNT(DISTINCT l.payment_intent_id) as transaction_count
FROM merchants m
LEFT JOIN ledger_entries l ON l.account = 'merchant:' || m.id || ':payable'
GROUP BY m.id, m.name, l.currency;
