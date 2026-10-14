-- Payment System Database Schema
-- Double-entry bookkeeping with idempotency support.
--
-- Re-runnable: every statement is guarded (IF NOT EXISTS, DROP ... IF EXISTS
-- before re-creating triggers, duplicate_object handlers for constraints), so
-- `psql -f init.sql` can be applied to a fresh or an existing database.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- System accounts (for double-entry bookkeeping).
-- Balances are stored credit-positive for every account type: a credit adds,
-- a debit subtracts. Liabilities and revenue therefore read positive and
-- assets (accounts_receivable) read negative, and the sum of all balances is 0.
CREATE TABLE IF NOT EXISTS accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL UNIQUE,
    account_type    VARCHAR(50) NOT NULL, -- 'asset', 'liability', 'revenue', 'expense', 'merchant'
    currency        VARCHAR(3) DEFAULT 'USD',
    balance         BIGINT DEFAULT 0, -- In cents
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Merchants (our customers)
CREATE TABLE IF NOT EXISTS merchants (
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

-- Payment transactions. The row doubles as the idempotency record for
-- POST /payments: (merchant_id, idempotency_key) is unique, and request_hash
-- lets a retry with a different body be rejected instead of replayed.
CREATE TABLE IF NOT EXISTS transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    idempotency_key VARCHAR(64),          -- Unique per merchant (index below)
    merchant_id     UUID NOT NULL REFERENCES merchants(id),
    amount          BIGINT NOT NULL,      -- Cents to avoid floating point
    currency        VARCHAR(3) NOT NULL,
    status          VARCHAR(20) NOT NULL, -- pending, authorized, captured, partially_refunded, refunded, voided, failed
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

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS auto_capture BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0;

-- Idempotency keys were globally unique, so two merchants choosing the same
-- key collided. They are scoped per merchant now.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_idempotency_key_key;
DROP INDEX IF EXISTS idx_transactions_idempotency_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_merchant_idempotency
    ON transactions (merchant_id, idempotency_key);

DO $$ BEGIN
    ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (status IN
        ('pending', 'authorized', 'captured', 'partially_refunded', 'refunded', 'voided', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE transactions ADD CONSTRAINT transactions_amount_positive CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ledger entries (double-entry bookkeeping). Entries posted together share a
-- journal_id (one capture, one refund, one chargeback); every journal must
-- balance, which the constraint trigger below checks at COMMIT.
CREATE TABLE IF NOT EXISTS ledger_entries (
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

ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS journal_id UUID;
-- Backfill for databases created before journals existed: those entries were
-- grouped by payment, and each payment's entries balance.
UPDATE ledger_entries SET journal_id = transaction_id WHERE journal_id IS NULL;
ALTER TABLE ledger_entries ALTER COLUMN journal_id SET NOT NULL;

-- Refunds (linked to original transaction)
CREATE TABLE IF NOT EXISTS refunds (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    idempotency_key     VARCHAR(64),
    original_tx_id      UUID NOT NULL REFERENCES transactions(id),
    merchant_id         UUID NOT NULL REFERENCES merchants(id),
    amount              BIGINT NOT NULL,
    reason              VARCHAR(255),
    status              VARCHAR(20) NOT NULL, -- pending, completed, failed
    processor_ref       VARCHAR(64),
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE refunds ADD COLUMN IF NOT EXISTS request_hash VARCHAR(64);
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_refunds_merchant_idempotency
    ON refunds (merchant_id, idempotency_key);

DO $$ BEGIN
    ALTER TABLE refunds ADD CONSTRAINT refunds_amount_positive CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Chargebacks
CREATE TABLE IF NOT EXISTS chargebacks (
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
CREATE TABLE IF NOT EXISTS webhook_deliveries (
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

-- The webhook worker records the merchant endpoint's HTTP status.
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS http_status INTEGER;

-- Audit log (written by shared/audit.ts for every money-moving action)
CREATE TABLE IF NOT EXISTS audit_log (
    id              BIGSERIAL PRIMARY KEY,
    entity_type     VARCHAR(50) NOT NULL,
    entity_id       VARCHAR(64) NOT NULL,
    action          VARCHAR(50) NOT NULL,
    actor_type      VARCHAR(20) NOT NULL,
    actor_id        VARCHAR(64),
    changes         JSONB,
    ip_address      VARCHAR(64),
    user_agent      TEXT,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_transactions_merchant_id ON transactions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
-- The reconciler scans for payments stuck in 'pending'.
CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(updated_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction_id ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_created_at ON ledger_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_journal_id ON ledger_entries(journal_id);

CREATE INDEX IF NOT EXISTS idx_refunds_original_tx_id ON refunds(original_tx_id);
CREATE INDEX IF NOT EXISTS idx_refunds_merchant_id ON refunds(merchant_id);

CREATE INDEX IF NOT EXISTS idx_chargebacks_transaction_id ON chargebacks(transaction_id);
CREATE INDEX IF NOT EXISTS idx_chargebacks_merchant_id ON chargebacks(merchant_id);
CREATE INDEX IF NOT EXISTS idx_chargebacks_status ON chargebacks(status);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_merchant_id ON webhook_deliveries(merchant_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next_retry_at ON webhook_deliveries(next_retry_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Ledger invariants enforced by the database, not just by application code.
-- ---------------------------------------------------------------------------

-- 1. Every journal balances: sum(debits) = sum(credits), at least two entries,
--    one currency. A DEFERRABLE INITIALLY DEFERRED constraint trigger runs at
--    COMMIT, after all entries of the journal have been inserted, so a bug that
--    posts an unbalanced journal aborts the whole database transaction.
CREATE OR REPLACE FUNCTION check_ledger_journal_balanced() RETURNS trigger AS $$
DECLARE
    imbalance    BIGINT;
    entry_count  INTEGER;
    currencies   INTEGER;
BEGIN
    SELECT COALESCE(SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE -amount END), 0),
           COUNT(*),
           COUNT(DISTINCT currency)
      INTO imbalance, entry_count, currencies
      FROM ledger_entries
     WHERE journal_id = NEW.journal_id;

    IF imbalance <> 0 OR entry_count < 2 OR currencies <> 1 THEN
        RAISE EXCEPTION 'ledger journal % is unbalanced (debits - credits = %, entries = %, currencies = %)',
            NEW.journal_id, imbalance, entry_count, currencies
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_journal_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER ledger_journal_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_ledger_journal_balanced();

-- 2. The ledger is append-only. Mistakes are corrected with a reversing
--    journal, never by editing history.
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries is append-only; post a reversing journal instead'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- Seed data is in db-seed/seed.sql
