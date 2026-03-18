# Design Stripe - Architecture

## System Overview

Stripe is a payment processing platform with APIs for accepting payments. Core challenges involve transaction integrity, fraud prevention, and financial accuracy.

**Learning Goals:**
- Build idempotent payment APIs
- Design double-entry ledger systems
- Implement real-time fraud detection
- Handle settlement and reconciliation

---

## Requirements

### Functional Requirements

1. **Charge**: Process credit card payments
2. **Refund**: Return funds to customers
3. **Merchants**: Onboard and manage merchants
4. **Webhooks**: Notify merchants of events
5. **Disputes**: Handle chargebacks

### Non-Functional Requirements

- **Latency**: < 500ms for payment authorization (p99)
- **Availability**: 99.999% for payment processing
- **Accuracy**: Zero tolerance for financial errors (debits = credits invariant)
- **Security**: PCI DSS Level 1 compliance
- **Durability**: No financial data loss under any failure scenario

---

## Capacity Estimation

### Production Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| Daily Payment Volume | 1.44M transactions/day | 50 RPS peak * 3600s * 8 peak hours |
| Ledger Entries/Day | 4.32M | 3 entries per transaction (receivable, payable, fee) |
| Storage Growth | ~500 MB/day | Transactions + ledger + audit log with indexes |
| Idempotency Keys/Day | 4.32M | 1 key per transaction, 200 bytes each, 24h TTL |
| Webhook Events/Day | 2.88M | ~2 events per payment (created + succeeded/failed) |
| Peak Redis Memory | ~1 GB | Idempotency keys + BullMQ webhook queue |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Merchants | 1-10 seeded |
| Concurrent API Requests | 5-20 |
| Storage | < 100 MB total |
| Redis Memory | < 50 MB |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│        Merchant Server │ Mobile SDK │ Web Integration           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│       (Rate Limiting, Auth, TLS Termination, Routing)           │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Payment Service│    │ Fraud Service │    │Webhook Service│
│               │    │               │    │               │
│ - Intents     │    │ - Risk score  │    │ - Delivery    │
│ - Charges     │    │ - Rules       │    │ - Retry       │
│ - Refunds     │    │ - ML models   │    │ - Signatures  │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Ledger Service                               │
│              (Double-entry bookkeeping)                         │
└─────────────────────────────────────────────────────────────────┘
        │                                     │
        ▼                                     ▼
┌───────────────────┐              ┌───────────────────┐
│    PostgreSQL     │              │   Redis / Valkey   │
│  - Ledger         │              │  - Idempotency     │
│  - Merchants      │              │  - Sessions        │
│  - Audit log      │              │  - Rate limiting   │
│  - Risk data      │              │  - Webhook queue   │
└───────────────────┘              └───────────────────┘
        │
        ▼
┌───────────────────┐
│  Card Networks    │
│  - Visa, MC, Amex │
│  - Authorization  │
│  - Settlement     │
└───────────────────┘
```

---

## Core Components

### 1. Payment Intent Flow

The Payment Intent is the central abstraction. It follows a two-phase flow: create (reserve), then confirm (authorize + capture).

**State Machine:**
```
requires_payment_method ──▶ requires_confirmation ──▶ processing
        │                                                  │
        ▼                                          ┌───────┴──────┐
    canceled                                       ▼              ▼
                                            requires_capture   succeeded
                                                  │               │
                                                  ▼               ▼
                                              succeeded        failed
```

**Confirm Flow:**
1. Attach payment method (tokenized card)
2. Run fraud risk assessment (rule-based + ML)
3. If risk > 0.8, require 3D Secure (requires_action state)
4. Authorize with card network via circuit breaker
5. On approval: create ledger entries atomically, fire webhook
6. On decline: record decline code, fire webhook

### 2. Double-Entry Ledger

Every payment creates balanced ledger entries within a single database transaction. The fundamental invariant is that the sum of all debits must equal the sum of all credits.

**Charge entry set (2.9% + 30 cents fee on $100):**

| Account | Debit | Credit |
|---------|-------|--------|
| `funds_receivable` | $100.00 | -- |
| `merchant:{id}:payable` | -- | $97.01 |
| `revenue:transaction_fees` | -- | $2.99 |

**Refund entry set (full refund):**

| Account | Debit | Credit |
|---------|-------|--------|
| `merchant:{id}:payable` | $97.01 | -- |
| `revenue:transaction_fees` | $2.99 | -- |
| `funds_receivable` | -- | $100.00 |

The ledger service verifies balance after each transaction and raises a critical alert on any imbalance.

### 3. Idempotency Handling

Idempotency prevents duplicate charges from network retries, client double-clicks, and load balancer retries.

**Flow:**
1. Client sends `Idempotency-Key` header with each request
2. Server acquires Redis lock via `SET NX` (prevents concurrent duplicates)
3. If key exists with `completed` status, return cached response
4. If key exists with `pending` status, return 409 Conflict
5. Process request, cache result with 24-hour TTL
6. Release lock

Keys are namespaced per-merchant (`idempotency:{merchantId}:{key}`) to prevent cross-merchant conflicts.

### 4. Fraud Detection

Risk scoring combines rule-based checks with signal aggregation:

| Signal | Weight | Description |
|--------|--------|-------------|
| Velocity (1hr) | 0.4 | > 3 charges on same card in 1 hour |
| Geo mismatch | 0.3 | Card country differs from IP country |
| High amount | 0.2 | > 5x merchant average transaction |
| Device reputation | Variable | Known fraud device fingerprint |
| ML model | 0.5x | Trained on amount, BIN, time patterns |

Scores are normalized to 0-1. Decisions: allow (< 0.5), review (0.5-0.8), block (> 0.8).

### 5. Webhook Delivery

Webhooks use reliable async delivery via a job queue:

1. Payment event occurs (e.g., `payment_intent.succeeded`)
2. Event stored in `webhook_events` table
3. Delivery job enqueued with exponential backoff (5 attempts: 1s, 2s, 4s, 8s, 16s)
4. Payload signed with HMAC-SHA256: `t={timestamp},v1={hmac(timestamp.payload, secret)}`
5. Delivery status tracked in `webhook_deliveries` table
6. Failed deliveries retry with per-merchant circuit breaker

---

## Database Schema

```sql
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
  card_token VARCHAR(100),
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
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'usd',
  status VARCHAR(30) NOT NULL DEFAULT 'requires_payment_method' CHECK (status IN (
    'requires_payment_method', 'requires_confirmation', 'requires_action',
    'processing', 'requires_capture', 'canceled', 'succeeded', 'failed'
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
CREATE UNIQUE INDEX idx_payment_intents_idempotency ON payment_intents(merchant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Charges (successful payment records)
CREATE TABLE charges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  amount_refunded INTEGER DEFAULT 0 CHECK (amount_refunded >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'usd',
  status VARCHAR(20) NOT NULL DEFAULT 'succeeded'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
  payment_method_id UUID REFERENCES payment_methods(id),
  fee INTEGER DEFAULT 0,
  net INTEGER DEFAULT 0,
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

-- Ledger Entries (double-entry bookkeeping)
CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL,
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

-- Webhook Events and Deliveries
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  type VARCHAR(100) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  url VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER DEFAULT 0,
  next_retry_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  response_status INTEGER,
  delivered_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries(status, next_retry_at)
  WHERE status = 'pending';

-- Disputes (chargebacks)
CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  charge_id UUID NOT NULL REFERENCES charges(id) ON DELETE CASCADE,
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason VARCHAR(100),
  status VARCHAR(30) DEFAULT 'needs_response'
    CHECK (status IN ('needs_response', 'under_review', 'won', 'lost', 'warning_closed')),
  evidence JSONB DEFAULT '{}',
  evidence_due_by TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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

-- Risk Assessments
CREATE TABLE risk_assessments (
  id BIGSERIAL PRIMARY KEY,
  payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
  risk_score DECIMAL(5,4) NOT NULL CHECK (risk_score >= 0 AND risk_score <= 1),
  risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  signals JSONB NOT NULL DEFAULT '[]',
  decision VARCHAR(20) NOT NULL CHECK (decision IN ('allow', 'review', 'block')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Audit Log (PCI DSS Requirement 10, SOX compliance)
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  actor_type VARCHAR(20) NOT NULL CHECK (actor_type IN ('merchant', 'admin', 'system', 'api')),
  actor_id VARCHAR(100) NOT NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  trace_id VARCHAR(100),
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_type, actor_id);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_trace ON audit_log(trace_id) WHERE trace_id IS NOT NULL;

-- Ledger balance views
CREATE OR REPLACE VIEW account_balances AS
SELECT account, currency,
  SUM(debit) as total_debit, SUM(credit) as total_credit,
  SUM(debit) - SUM(credit) as balance
FROM ledger_entries
GROUP BY account, currency;

CREATE OR REPLACE VIEW merchant_balances AS
SELECT m.id as merchant_id, m.name as merchant_name,
  COALESCE(l.currency, 'usd') as currency,
  COALESCE(SUM(l.credit) - SUM(l.debit), 0) as available_balance,
  COUNT(DISTINCT l.payment_intent_id) as transaction_count
FROM merchants m
LEFT JOIN ledger_entries l ON l.account = 'merchant:' || m.id || ':payable'
GROUP BY m.id, m.name, l.currency;

CREATE OR REPLACE VIEW daily_revenue AS
SELECT DATE(created_at) as date,
  SUM(credit) as revenue,
  COUNT(DISTINCT payment_intent_id) as transaction_count
FROM ledger_entries
WHERE account = 'revenue:transaction_fees'
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

---

## API Design

### REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/v1/merchants` | Admin | Create merchant account |
| POST | `/v1/merchants/:id/rotate-key` | Merchant | Rotate API key |
| POST | `/v1/customers` | Merchant | Create customer |
| GET | `/v1/customers` | Merchant | List customers |
| POST | `/v1/payment_methods` | Merchant | Tokenize a card |
| POST | `/v1/payment_intents` | Merchant | Create payment intent |
| POST | `/v1/payment_intents/:id/confirm` | Merchant | Confirm with payment method |
| POST | `/v1/payment_intents/:id/capture` | Merchant | Capture authorized amount |
| POST | `/v1/payment_intents/:id/cancel` | Merchant | Cancel intent |
| GET | `/v1/payment_intents/:id` | Merchant | Retrieve intent |
| PATCH | `/v1/payment_intents/:id` | Merchant | Update intent metadata |
| POST | `/v1/refunds` | Merchant | Create refund |
| GET | `/v1/charges` | Merchant | List charges |
| GET | `/v1/balance` | Merchant | Get merchant balance |
| POST | `/v1/webhooks` | Merchant | Configure webhook endpoint |
| GET | `/metrics` | Internal | Prometheus metrics |
| GET | `/health` | None | Health check |

**Authentication:** API key in `Authorization: Bearer sk_live_...` header. Keys are hashed (SHA-256) and stored; the raw key is returned only at creation.

---

## Key Design Decisions

### 1. Idempotency Keys for All Mutating Operations

**Chosen:** Per-request idempotency keys with Redis caching and database persistence.
**Alternative:** Database unique constraints only.
**Rationale:** Network retries are inevitable in payment systems. A client timeout does not mean the charge failed -- the server may have succeeded. Without idempotency, retries produce duplicate charges. Redis provides sub-millisecond duplicate detection, while the database constraint serves as a durability fallback if Redis is unavailable. The 24-hour TTL balances storage cost against realistic retry windows.

### 2. Double-Entry Ledger Over Single-Entry

**Chosen:** Double-entry bookkeeping where every transaction creates balanced entries.
**Alternative:** Single-entry accounting with running balance columns.
**Rationale:** Single-entry systems hide errors. If a balance column is corrupted, there is no way to detect or reconcile it. Double-entry provides a self-verifying invariant (debits = credits) that catches bugs, data corruption, and fraud. The cost is 3x more rows in the ledger table, but for a payment system where accuracy outweighs storage cost, this is a clear win. The `account_balances` view provides fast balance lookups without materializing totals.

### 3. Webhook Queue with Exponential Backoff

**Chosen:** Async delivery via BullMQ with 5 retry attempts and HMAC signatures.
**Alternative:** Synchronous HTTP callbacks during payment processing.
**Rationale:** Synchronous callbacks would block payment confirmation on merchant endpoint availability. If a merchant's server is down, the payment would fail or timeout -- unacceptable for a payment platform. Async delivery with retries decouples payment success from notification delivery. HMAC signatures prevent forged webhooks, and timestamps prevent replay attacks.

---

## Consistency and Idempotency

**Transaction Boundaries:** All payment state transitions and ledger entries are wrapped in a single PostgreSQL transaction. If the ledger entry fails, the payment intent status is rolled back. This guarantees that the financial record always matches the payment state.

**Idempotency Key Lifecycle:**
1. Client generates key (should be tied to the logical operation, e.g., `order_12345_payment`)
2. Server checks Redis for existing key via `SET NX` (atomic lock acquisition)
3. On cache miss, process request and store result
4. On cache hit, return stored result without reprocessing
5. Keys expire after 24 hours

**Consistency Guarantees:**
- Ledger: Strong consistency (PostgreSQL ACID transactions)
- Idempotency: Strong (Redis lock + database fallback)
- Webhooks: Eventual (async delivery with at-least-once semantics)

---

## Security / Auth

| Control | Implementation |
|---------|---------------|
| API Authentication | API key hash comparison per request |
| Key Rotation | New key generated, old key invalidated atomically |
| Card Tokenization | Cards stored as tokens, raw PANs never persisted |
| Webhook Verification | HMAC-SHA256 signatures with timestamp |
| Audit Trail | Append-only `audit_log` table for all financial operations |
| Input Validation | Amount > 0, valid currency, valid status transitions |
| Rate Limiting | Per-merchant, per-endpoint (via Redis counters) |

---

## Observability

### Metrics (Prometheus)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `payment_requests_total` | Counter | method, endpoint, status_code, merchant_id | Request volume |
| `payment_request_duration_seconds` | Histogram | method, endpoint, status | Latency distribution |
| `payment_amount_cents` | Histogram | currency, status | Payment amount distribution |
| `payment_success_total` | Counter | currency, payment_method_type | Success rate tracking |
| `payment_failure_total` | Counter | decline_code, currency | Decline analysis |
| `fraud_score_distribution` | Histogram | decision | Risk score distribution |
| `fraud_blocked_total` | Counter | rule, risk_level | Fraud block rate |
| `webhook_deliveries_total` | Counter | event_type, status, attempt | Webhook reliability |
| `webhook_queue_depth` | Gauge | -- | Queue backlog |
| `idempotency_cache_hits_total` | Counter | -- | Duplicate detection rate |
| `circuit_breaker_state` | Gauge | service | Dependency health |
| `ledger_imbalances_total` | Counter | -- | Financial integrity |
| `db_connection_pool_size` | Gauge | state | Database health |

### SLI Targets

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Availability | 99.99% | < 99.9% over 5 min |
| Latency (p50) | < 100ms | > 150ms over 5 min |
| Latency (p99) | < 500ms | > 750ms over 5 min |
| Error Rate | < 0.1% | > 0.5% over 5 min |
| Webhook Delivery | 99.9% within 1 hour | < 99% over 15 min |
| Ledger Balance | 100% balanced | Any imbalance |

### Structured Logging

JSON logs via Pino with consistent fields: `service`, `trace_id`, `span_id`, `merchant_id`, `event`, `duration_ms`. IP addresses are hashed for privacy compliance. Sensitive fields (API keys, card data) are never logged.

---

## Failure Handling

### Circuit Breakers

| Service | Failure Threshold | Reset Timeout | Fallback |
|---------|-------------------|---------------|----------|
| Card Network | 5 consecutive | 30 seconds | Return 503, merchant retries |
| Fraud ML Service | 3 consecutive | 15 seconds | Rule-based scoring only |
| Webhook Delivery | 10 consecutive | 60 seconds | Queue for later |
| GeoIP Service | 5 consecutive | 60 seconds | Skip geo checks |

### Retry Strategy

| Operation | Retries | Backoff | Notes |
|-----------|---------|---------|-------|
| Card authorization | 2 | Exponential (200ms base) | Idempotency key prevents duplicates |
| Fraud check | 3 | Exponential (100ms base) | Falls back to rules on exhaustion |
| Webhook delivery | 5 | Exponential (1s, 2s, 4s, 8s, 16s) | Per-event idempotency |
| Database write | 0 | -- | Transactions should not retry |

### Failure Mode Summary

| Failure | Detection | Mitigation | Recovery |
|---------|-----------|------------|----------|
| Network timeout | Request timeout | Retry with idempotency key | Automatic |
| Duplicate request | Idempotency key match | Return cached response | Automatic |
| Database down | Health check failure | Return 503, alert on-call | Manual failover |
| Redis down | Connection error | Fall back to DB-based locking | Auto-reconnect |
| Card network down | Circuit breaker open | Return decline with 503 | Auto after reset timeout |
| Ledger imbalance | Balance check failure | Halt writes, alert critical | Manual investigation |

---

## Scalability Considerations

### Scaling Path

| Component | Current | Next Step | Production Scale |
|-----------|---------|-----------|-----------------|
| API Servers | 1 process | 3 instances on ports 3001-3003 | Stateless, behind ALB, auto-scale |
| PostgreSQL | Single instance | Primary + sync replica | Sharded by merchant_id |
| Redis | Single instance | Sentinel for HA | Cluster mode, 3+ nodes |
| Webhook Workers | BullMQ in-process | Dedicated worker processes | Separate worker fleet, rate-limited per merchant |

### Sharding Strategy

Merchant-based sharding is the natural partition key because:
- All queries are scoped to a single merchant (API key auth)
- No cross-merchant joins needed
- Even distribution with consistent hashing
- Merchant isolation prevents noisy-neighbor problems

### What Breaks First

1. **PostgreSQL write throughput** -- the ledger table grows fastest. Solution: partition by `created_at`, archive entries older than 90 days.
2. **Webhook delivery** -- high-volume merchants generate webhook storms. Solution: per-merchant rate limiting and dedicated worker pools.
3. **Redis memory** -- idempotency keys accumulate. Solution: tune TTL, use cluster mode.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Idempotency storage | Redis + DB fallback | DB-only constraints | Sub-ms lookups, graceful Redis failure |
| Ledger model | Double-entry | Single-entry balance | Self-verifying invariant, audit trail |
| Webhook delivery | Async queue (BullMQ) | Sync callbacks | Decouple payment success from merchant uptime |
| Card storage | Tokenization | Encryption at rest | Minimizes PCI scope |
| Fraud scoring | Rules + signals | ML-only | Rules provide baseline when ML is unavailable |
| Circuit breaker | Cockatiel library | Custom implementation | Battle-tested, supports retry + breaker composition |

---

## Implementation Notes

### Local Architecture

```
┌─────────────┐     ┌─────────────────────────────────────┐
│  Frontend    │     │  Backend (Express)  :3000            │
│  React+Vite  │────▶│                                     │
│  :5173       │     │  Routes: paymentIntents, charges,   │
└─────────────┘     │  refunds, webhooks, merchants,      │
                     │  customers, paymentMethods, balance │
                     │                                     │
                     │  Services: cardNetwork (simulated), │
                     │  fraud, ledger, webhooks (BullMQ)   │
                     │                                     │
                     │  Shared: logger, metrics, audit,    │
                     │  circuitBreaker, idempotency        │
                     └──────────┬──────────┬──────────────┘
                                │          │
                     ┌──────────▼──┐  ┌────▼──────────┐
                     │ PostgreSQL  │  │ Valkey/Redis   │
                     │ :5432       │  │ :6379          │
                     │ stripe_db   │  │ Idempotency,   │
                     │             │  │ BullMQ queues  │
                     └─────────────┘  └───────────────┘
```

### Production Patterns Actually Implemented

| Pattern | File(s) | Why It Matters |
|---------|---------|---------------|
| **Idempotency** | `backend/src/middleware/idempotency.ts`, `backend/src/db/redis.ts` | Prevents duplicate charges from retries. Uses Redis `SET NX` for atomic lock acquisition with 24h TTL. |
| **Double-entry ledger** | `backend/src/services/ledger.ts`, `backend/src/db/init.sql` | Guarantees financial accuracy. Every charge creates balanced debit/credit entries with invariant verification. |
| **Circuit breakers** | `backend/src/shared/circuitBreaker.ts` | Uses Cockatiel library. Pre-configured breakers for card network, fraud service, webhooks, and GeoIP. Metrics-integrated state tracking. |
| **Prometheus metrics** | `backend/src/shared/metrics.ts` | 25+ metrics covering payments, fraud, webhooks, infrastructure, idempotency, circuit breakers, and ledger operations. Exposed at `/metrics`. |
| **Structured logging** | `backend/src/shared/logger.ts` | Pino with JSON output, trace/span IDs, privacy-aware IP hashing, and child loggers for request context. |
| **Audit logging** | `backend/src/shared/audit.ts`, `backend/src/db/init.sql` | Append-only `audit_log` table. Logs payment intents, charges, refunds, fraud checks, ledger entries, API key rotations. |
| **Webhook queue** | `backend/src/services/webhooks.ts` | BullMQ with exponential backoff, HMAC-SHA256 signatures, and delivery tracking. |
| **Fraud scoring** | `backend/src/services/fraud.ts` | Rule-based risk assessment with velocity, amount, and geographic signals. Stores assessments in `risk_assessments` table. |
| **Health checks** | `backend/src/index.ts` | `/health` (basic), `/health/detailed` (PostgreSQL + Redis checks with latency). |

### What Was Simplified or Substituted

| Production Component | Local Substitute | Notes |
|---------------------|-----------------|-------|
| Real card networks (Visa, MC) | Simulated card network service | `backend/src/services/cardNetwork.ts` uses random delays and configurable decline rates |
| PCI-compliant card vault | In-database tokenization | Cards stored as simulated tokens, no actual encryption HSM |
| Multi-region deployment | Single-process, multi-port (`dev:server1/2/3`) | Stateless design supports horizontal scaling |
| ML fraud model | Rule-based scoring only | Velocity, amount, and geo-mismatch signals |
| OAuth/JWT | API key authentication | Simple hash comparison per request |
| Rate limiting (WAF/CDN) | Not implemented | Would use `express-rate-limit` or Redis counters |

### What Was Omitted

- CDN / WAF / DDoS protection
- Multi-region failover and replication
- Kubernetes orchestration
- 3D Secure redirect flow
- Settlement batching and payout scheduling
- Dispute lifecycle management (table exists, workflow not implemented)
- Multi-currency support and FX conversion
- PCI DSS network segmentation
- Data archival and cold storage tiering
