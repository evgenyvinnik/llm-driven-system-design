# Payment System - Architecture Design

## System Overview

A transaction processing and payment platform that handles payment authorization, capture, refunds, and multi-currency conversions with built-in fraud detection. The system implements double-entry bookkeeping for financial integrity, idempotent payment processing, and webhook delivery for merchant notifications. Learning goals: financial transaction atomicity, ledger consistency, idempotency patterns, fraud scoring, and webhook reliability.

## Requirements

### Functional Requirements

- **Payment processing**: Authorize, capture, and settle payments via card networks and bank transfers
- **Refunds**: Full and partial refunds with proper ledger accounting
- **Multi-currency**: Support 10+ currencies with real-time exchange rate lookups
- **Fraud detection**: Rule-based scoring with velocity checks and device fingerprinting
- **Merchant management**: Onboarding, API key management, and webhook configuration
- **Reconciliation**: Daily settlement reports and dispute handling
- **Chargeback handling**: Dispute management with evidence tracking and resolution workflow

### Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Availability | 99.9% uptime (8.7 hours downtime/year) |
| Authorization latency | p50 < 200ms, p99 < 800ms |
| Throughput | 500 RPS sustained, burst to 2,000 RPS |
| Consistency | Strong consistency for ledger writes; eventual consistency for analytics |
| Idempotency | Every payment mutation must be safely retryable |
| Durability | Zero lost transactions, complete audit trail for PCI-DSS compliance |

## Capacity Estimation

### Production Scale

| Metric | Value | Sizing Implication |
|--------|-------|-------------------|
| Daily transactions | 2M | ~23 RPS average, 500 RPS peak |
| Average payload | 2 KB | 4 GB/day ingress |
| Transaction records | 60M/month | ~15 GB/month PostgreSQL growth |
| Ledger entries | 180M/month (3x transactions) | ~25 GB/month |
| Active merchants | 10,000 | Negligible metadata storage |
| Webhook events | 4M/day | 100 RPS to webhook workers |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Concurrent users | 2-5 |
| Transactions/day | 100-500 |
| API servers | 3 instances on ports 3001-3003 |
| PostgreSQL | Single instance, 50 GB disk |
| Valkey/Redis | 512 MB (rate limits, idempotency, sessions) |
| RabbitMQ | 256 MB, 10K messages in flight max |

## High-Level Architecture

```
┌──────────────────┐
│   Merchant App   │
│   / React SPA    │
└────────┬─────────┘
         │ HTTPS
         ▼
┌──────────────────────────────────────────────────┐
│                  API Gateway / CDN                │
│       (TLS Termination, Rate Limiting, WAF)       │
└────────────────────────┬─────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐
   │ Payment    │ │ Payment    │ │ Payment    │
   │ API Server │ │ API Server │ │ API Server │
   │ (Node.js)  │ │ (Node.js)  │ │ (Node.js)  │
   └──────┬─────┘ └──────┬─────┘ └──────┬─────┘
          │              │              │
          └──────────────┼──────────────┘
                         │
    ┌────────┬───────────┼───────────┬────────────┐
    ▼        ▼           ▼           ▼            ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────────┐
│Postgres│ │ Valkey  │ │RabbitMQ│ │ Fraud    │ │  Prometheus  │
│(Primary│ │(Cache + │ │(Async  │ │ Service  │ │  + Grafana   │
│+ Read  │ │ Locks)  │ │ Queue) │ │(Scoring) │ │              │
│Replica)│ │         │ │        │ │          │ │              │
└────────┘ └────────┘ └────┬───┘ └──────────┘ └──────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────────┐
        │ Webhook  │ │  Fraud   │ │  Settlement  │
        │ Worker   │ │  Worker  │ │  Worker      │
        └──────────┘ └──────────┘ └──────────────┘
```

## Core Components

### 1. API Gateway

The API gateway is the single entry point for all merchant traffic. In production, this is a managed gateway (AWS API Gateway, Kong, or Nginx Plus) that handles:

- TLS termination and certificate management
- Request rate limiting per merchant API key
- Request routing to backend instances via round-robin
- Request/response logging for audit
- Web Application Firewall (WAF) rules for PCI-DSS compliance

### 2. Payment API Service (Stateless)

Handles the full payment lifecycle: authorize, capture, void, refund, and chargeback. Each instance is stateless -- all state lives in PostgreSQL and Valkey -- enabling horizontal scaling by adding instances behind the gateway.

Key responsibilities:
- Validate merchant API keys (bcrypt-hashed; the plaintext `Bearer pk_...` key is compared against stored hashes)
- Enforce idempotency: check Valkey for existing key before processing
- Acquire distributed locks to prevent concurrent processing of the same payment
- Execute payment within a PostgreSQL transaction (transaction + ledger entries + audit log)
- Publish events to RabbitMQ for async processing (webhooks, fraud scoring, settlement)

### 3. PostgreSQL (Primary Data Store)

Stores all financial data with ACID guarantees:
- **Transactions**: Payment records with status tracking
- **Ledger entries**: Double-entry bookkeeping for every balance change
- **Merchants**: Account configuration, API key hashes, webhook URLs
- **Audit log**: Immutable record of every action for PCI-DSS Requirement 10

Uses SERIALIZABLE isolation for ledger writes to prevent phantom reads and ensure balance consistency.

### 4. Valkey/Redis (Cache + Coordination)

- **Idempotency keys**: `SET idempotency:{merchant}:{key} {response} EX 86400` -- 24-hour TTL prevents duplicate charges
- **Rate limit counters**: Sliding window using sorted sets with `ZRANGEBYSCORE`
- **Distributed locks**: `SET lock:payment:{key} 1 NX EX 30` -- prevents concurrent processing
- **Merchant config cache**: 5-minute TTL avoids DB round-trip on every request
- **Exchange rate cache**: 5-minute TTL for FX lookups

### 5. RabbitMQ (Async Processing)

Topic exchange (`payment.events`) with routing keys:

| Queue | Routing Key | Consumer | Purpose |
|-------|-------------|----------|---------|
| `webhook.delivery` | `payment.*`, `refund.*` | Webhook Worker | Deliver events to merchant endpoints |
| `fraud.scoring` | `payment.authorized` | Fraud Worker | Async deep fraud analysis |
| `settlement.batch` | `payment.captured` | Settlement Worker | Batch for daily settlement |

Dead-letter queues (DLQ) handle messages that fail after 5 retries. DLQ messages are reviewed manually or re-queued after root cause fix.

### 6. Background Workers

- **Webhook Worker**: Delivers payment events to merchant endpoints with HMAC-SHA256 signatures. Exponential backoff retry: 1s, 5s, 30s, 2min, 10min, then DLQ.
- **Fraud Worker**: Deep fraud analysis post-authorization. Checks velocity patterns, device fingerprints, geolocation anomalies. Can trigger auto-void if score exceeds threshold.
- **Settlement Worker**: Batches captured transactions by merchant and currency for daily settlement file generation.

## Database Schema

```sql
CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    api_key_hash VARCHAR(255) NOT NULL,  -- bcrypt hash of the pk_ API key
    webhook_url TEXT,
    webhook_secret VARCHAR(64),
    status VARCHAR(20) DEFAULT 'active',  -- active, suspended, closed
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    external_id VARCHAR(255),  -- Merchant's customer ID
    email VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(merchant_id, external_id)
);

CREATE TABLE payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id),
    type VARCHAR(20) NOT NULL,  -- card, bank_account
    last_four VARCHAR(4),
    brand VARCHAR(20),  -- visa, mastercard, amex
    exp_month INTEGER,
    exp_year INTEGER,
    token_vault_ref VARCHAR(255),  -- Reference to secure vault
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    customer_id UUID REFERENCES customers(id),
    payment_method_id UUID REFERENCES payment_methods(id),

    -- Idempotency
    idempotency_key VARCHAR(255),

    -- Amounts (stored in smallest currency unit, e.g., cents)
    amount BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL,  -- ISO 4217
    captured_amount BIGINT DEFAULT 0,
    refunded_amount BIGINT DEFAULT 0,

    -- Status tracking
    status VARCHAR(20) NOT NULL,  -- pending, authorized, captured, voided, failed, refunded
    failure_code VARCHAR(50),
    failure_message TEXT,

    -- External references
    processor_ref VARCHAR(255),  -- Payment processor transaction ID

    -- Fraud scoring
    fraud_score INTEGER,  -- 0-100
    fraud_flags JSONB DEFAULT '[]',

    -- Metadata
    description TEXT,
    metadata JSONB DEFAULT '{}',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(merchant_id, idempotency_key)
);

CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES transactions(id),

    -- Double-entry bookkeeping
    entry_type VARCHAR(20) NOT NULL,  -- debit, credit
    account_type VARCHAR(30) NOT NULL,  -- merchant_balance, platform_fee, processor_cost, customer_refund

    amount BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL,

    -- Running balance for account
    balance_after BIGINT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_ledger_transaction ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_account ON ledger_entries(account_type, created_at);

CREATE TABLE webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    transaction_id UUID NOT NULL REFERENCES transactions(id),

    event_type VARCHAR(50) NOT NULL,  -- payment.authorized, payment.captured, payment.failed, refund.created
    payload JSONB NOT NULL,

    -- Delivery tracking
    status VARCHAR(20) DEFAULT 'pending',  -- pending, delivered, failed
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ,
    last_response_code INTEGER,
    last_error TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_webhooks_pending ON webhooks(status, next_retry_at) WHERE status != 'delivered';

CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    entity_type VARCHAR(50) NOT NULL,  -- transaction, merchant, refund
    entity_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,  -- created, status_changed, refunded
    actor_type VARCHAR(20),  -- api_key, admin, system
    actor_id VARCHAR(255),
    changes JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_time ON audit_log(created_at);

-- Indexes for common queries
CREATE INDEX idx_transactions_merchant ON transactions(merchant_id, created_at DESC);
CREATE INDEX idx_transactions_status ON transactions(status, created_at DESC);
CREATE INDEX idx_transactions_idempotency ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

### Storage Strategy

| Data Type | Storage | Rationale |
|-----------|---------|-----------|
| Transactions & Ledger | PostgreSQL | ACID compliance, complex queries for reconciliation |
| Idempotency keys | Valkey (24h TTL) | Fast lookups, auto-expiry |
| Rate limit counters | Valkey | Atomic increments, sliding window support |
| Session data | Valkey (1h TTL) | Fast access, ephemeral |
| Webhook payloads | PostgreSQL + RabbitMQ | Durability for retry; queue for delivery |
| Audit logs | PostgreSQL | Queryable, long-term retention |

## API Design

### Authentication

API key in `Authorization: Bearer pk_xxx` header. Keys are generated with a `pk_` prefix at merchant creation and hashed with bcrypt before storage -- the plaintext key is shown to the merchant only once. Authentication compares the presented key against stored bcrypt hashes of active merchants. (A production system would add `sk_live_*`/`sk_test_*` environment prefixes and an indexed key-id lookup rather than scanning; the local build keeps the single `pk_` scheme.)

### Core Endpoints

```
POST   /v1/payments              # Create and authorize a payment
POST   /v1/payments/:id/capture  # Capture an authorized payment
POST   /v1/payments/:id/void     # Void an authorized payment
POST   /v1/payments/:id/refund   # Refund a captured payment
GET    /v1/payments/:id          # Get payment details
GET    /v1/payments              # List payments (paginated)

POST   /v1/customers             # Create customer
GET    /v1/customers/:id         # Get customer
POST   /v1/customers/:id/payment_methods  # Add payment method

GET    /v1/merchants/me          # Current merchant profile
PATCH  /v1/merchants/me          # Update webhook URL, etc.

# Admin endpoints (session auth)
GET    /v1/admin/transactions    # Search/filter transactions
GET    /v1/admin/merchants       # List merchants
POST   /v1/admin/merchants/:id/suspend  # Suspend merchant
GET    /v1/admin/reconciliation  # Daily settlement reports
```

## Request Flows

### Payment Authorization Flow

```
1. Client ──▶ API Server: POST /v1/payments (with Idempotency-Key header)

2. API Server:
   a. Validate API key ──▶ fetch merchant from cache or DB
   b. Check Valkey for existing idempotency key
      - If exists: return cached response (no processing)
   c. Acquire distributed lock: SET lock:payment:{key} 1 NX EX 30
   d. Validate request payload
   e. Rate limit check (Valkey sliding window)

3. API Server ──▶ Fraud Service (inline, <50ms budget):
   a. Calculate fraud score based on:
      - Velocity (transactions per hour for this card)
      - Device fingerprint match
      - Geolocation vs billing address
   b. If score > 80: auto-decline

4. API Server ──▶ PostgreSQL (single transaction):
   BEGIN;
   INSERT INTO transactions (...) VALUES (...);
   INSERT INTO ledger_entries (...) VALUES (...);  -- Hold funds
   INSERT INTO audit_log (...) VALUES (...);
   COMMIT;

5. API Server ──▶ Valkey:
   SET idempotency:{merchant}:{key} {response} EX 86400

6. API Server ──▶ RabbitMQ:
   Publish to webhook.delivery queue
   Publish to fraud.scoring queue (async deep analysis)

7. API Server ──▶ Client: 201 Created with payment object

8. Release distributed lock
```

### Refund Flow

```
1. Client ──▶ API Server: POST /v1/payments/:id/refund { amount: 2500 }

2. API Server:
   a. Validate API key and ownership of transaction
   b. Acquire lock: SET lock:refund:{transaction_id} 1 NX EX 30
   c. Validate: captured_amount - refunded_amount >= requested_amount

3. API Server ──▶ PostgreSQL (single transaction):
   BEGIN;
   UPDATE transactions SET refunded_amount = refunded_amount + 2500;
   INSERT INTO ledger_entries (...);  -- Credit customer, debit merchant
   INSERT INTO audit_log (...);
   COMMIT;

4. API Server ──▶ RabbitMQ:
   Publish refund.created webhook event

5. Return updated payment object
```

## Key Design Decisions

### Transaction Consistency (Double-Entry Ledger)

**Problem**: Payment operations must be atomic -- we cannot have partial state where money is debited but the transaction record is missing.

**Chosen: Double-entry bookkeeping within PostgreSQL transactions.** Every balance change creates paired debit/credit entries in the `ledger_entries` table. The transaction record captures the business event; the ledger entries capture the accounting impact. If the ledger ever disagrees with the expected balance, we know something went wrong.

**Why not event sourcing?** Event sourcing would provide a complete replay log, but adds significant complexity: event store, projection rebuilding, eventual consistency between views. For a payment system where we need immediate balance consistency, a relational ledger within ACID transactions is simpler and equally correct. Event sourcing makes more sense when the domain has complex state transitions (e.g., order management with many status changes) rather than the straightforward debit/credit pattern of payments.

### Idempotency Storage in Valkey

**Problem**: Network timeouts, client retries, and load balancer retries can cause duplicate payment processing. A customer charged twice is the worst possible payment system failure.

**Chosen: Valkey with 24-hour TTL for idempotency keys.** The server checks Valkey before beginning any processing. If the key exists, the cached response is returned immediately. Keys are scoped per merchant (`idempotency:{merchant_id}:{key}`) to prevent cross-merchant collisions.

**Why Valkey instead of PostgreSQL?** Idempotency checks happen on every mutation request, before the business logic begins. A Valkey GET is sub-millisecond; a PostgreSQL query adds 1-5ms. Since idempotency keys are ephemeral (24h TTL), they do not warrant permanent storage. The trade-off: if Valkey loses data (restart without persistence), a small window of duplicate risk exists. We mitigate this by also storing the idempotency key in the transactions table (`UNIQUE(merchant_id, idempotency_key)`) as a database-level fallback.

### Sync Fraud Scoring with Async Deep Analysis

**Problem**: Fraud checks must be fast enough to fit within the authorization latency budget, but thorough enough to catch sophisticated attacks.

**Chosen: Two-phase approach.** Phase 1 runs inline during authorization with a 50ms budget -- velocity checks, device fingerprint matching, geolocation comparison. If the score exceeds 80, the payment is auto-declined. Phase 2 runs asynchronously via the fraud worker, performing deeper analysis (cross-merchant velocity, network graph analysis) that can take seconds.

**Why not fully async?** Allowing a fraudulent payment through and reversing it later damages merchant trust and creates chargeback costs. The inline check catches 90%+ of fraud at minimal latency cost. The async check catches the remaining sophisticated attacks within minutes, enabling manual review or auto-void before settlement.

### Webhook Delivery via Message Queue

**Problem**: Merchants need real-time notification of payment events, but webhook delivery is inherently unreliable (merchant servers may be down, slow, or returning errors).

**Chosen: RabbitMQ with dedicated webhook workers.** Payment events are published to the `webhook.delivery` queue immediately after the payment transaction commits. The webhook worker delivers events with exponential backoff (1s, 5s, 30s, 2min, 10min) and moves permanently failed events to a DLQ.

**Why not deliver webhooks inline during the payment request?** If the merchant's webhook endpoint is slow (5+ seconds) or down, the payment authorization would either timeout or fail. By decoupling via a queue, the payment response returns in <800ms regardless of webhook endpoint health. The trade-off is eventual delivery -- merchants may receive the webhook seconds after the payment, not simultaneously.

## Consistency and Idempotency

### Idempotency Semantics

- Keys are scoped per merchant (same key from different merchants = different operations)
- Keys expire after 24 hours (Valkey TTL)
- Subsequent requests with the same key return the cached response without reprocessing
- If the original request failed, the key is not cached (failure is not idempotent -- the client can retry)
- A distributed lock prevents concurrent processing of the same idempotency key

### Multi-Currency Handling

- All amounts stored in smallest currency unit (cents, pence, yen)
- Exchange rates fetched from external service and cached in Valkey for 5 minutes
- Merchant settles in their configured currency
- FX conversion happens at capture time; the locked rate is stored on the transaction record

## Security

### Authentication and Authorization

| Endpoint Type | Auth Method | Details |
|--------------|-------------|---------|
| Merchant API | API Key (Bearer token) | `sk_live_*` / `sk_test_*` prefixes |
| Admin Dashboard | Session cookie | Express-session + Valkey store |
| Webhook verification | HMAC-SHA256 signature | Shared secret per merchant |

### API Key Management

API keys are generated with `crypto.randomBytes(24).toString('base64url')` and prefixed with `sk_live_` or `sk_test_`. Only the SHA-256 hash is stored. The plaintext key is returned to the merchant once at creation and never stored.

### RBAC for Admin Operations

```
support:    read:transactions, read:merchants
operations: read:transactions, read:merchants, write:refunds
admin:      read:*, write:*, manage:merchants
```

### Data Protection

- Card numbers never stored; tokenized via payment processor reference
- PII encrypted at rest (PostgreSQL pgcrypto for email/name)
- TLS 1.3 for all external communication
- API keys hashed with SHA-256 before storage

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `payment_request_duration_seconds` | Histogram | method, endpoint, status | Latency SLO tracking |
| `payment_total` | Counter | status, currency | Volume and success rate |
| `webhook_delivery_total` | Counter | status | Webhook reliability |
| `rabbitmq_queue_depth` | Gauge | queue | Queue health |
| `fraud_score_distribution` | Histogram | - | Risk distribution |
| `db_active_connections` | Gauge | - | Pool utilization |

### Alert Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | Error rate > 1% for 5 min | Critical |
| High latency | p99 > 2s for 5 min | Warning |
| Queue backup | Queue depth > 1000 for 10 min | Warning |
| Webhook failures | Failure rate > 5% for 15 min | Warning |
| DB connections exhausted | Active connections > 80% pool | Critical |

### Structured Logging

JSON-structured logging with Pino, including contextual fields: `event`, `transaction_id`, `merchant_id`, `amount`, `currency`, `status`, `duration_ms`, `fraud_score`, `trace_id`. Trace IDs are generated at the API gateway and propagated through all service calls via headers.

### Distributed Tracing

- Generate `trace_id` at load balancer or first API server
- Pass through all service calls and queue messages in headers
- Store on `audit_log` entries for correlation
- OpenTelemetry SDK for span creation across async boundaries

## Failure Handling

### Retry Strategy with Idempotency

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Payment authorization | 0 (client retries with same key) | N/A | Required |
| Webhook delivery | 5 | Exponential (1s to 10min) | Webhook ID in header |
| Settlement batch | 3 | Fixed 5min | Date-based batch ID |
| Fraud scoring | 2 | 1s, 5s | Transaction ID |

### Circuit Breaker Pattern

Circuit breakers wrap calls to external payment processors and the fraud scoring service. Configuration:
- **Failure threshold**: 5 consecutive failures opens the circuit
- **Recovery timeout**: 30 seconds in open state before allowing a test request
- **Half-open**: 2 successful requests needed to close the circuit

When the processor circuit breaker is open, payment requests receive a `503 Service Unavailable` immediately instead of waiting for a 30-second timeout. This prevents connection pool exhaustion and cascading failures.

### Graceful Degradation

- **Fraud service down**: Approve payments with `fraud_score=50`, flag for manual review
- **Webhook queue full**: Store in PostgreSQL overflow table, process later via polling
- **Valkey down**: Fall back to DB-based rate limiting and idempotency checks (slower but functional)
- **RabbitMQ down**: Store events in PostgreSQL for later replay

## Scalability Considerations

### Horizontal Scaling

- **API servers**: Stateless; add instances behind load balancer. No session affinity needed for API key auth.
- **Workers**: Scale independently based on queue depth. Webhook workers scale with merchant count; fraud workers scale with transaction volume.
- **Database**: Read replicas for reporting queries (admin dashboard, reconciliation). Primary handles all writes.

### Sharding Strategy

If transaction volume exceeds single-node PostgreSQL capacity:
- Shard by `merchant_id` (hash-based, 5 initial shards)
- Each shard handles ~20% of traffic
- Cross-shard queries (admin search) via application-level aggregation
- Ledger entries co-located with their transaction (same shard key)

### Connection Pooling

With 3 API servers each holding 20 connections, total pool is 60. PostgreSQL `max_connections` set to 100, leaving headroom for admin connections and workers. At higher scale, use PgBouncer for connection multiplexing.

### Storage Tiering

| Data Age | Storage | Cost Tier |
|----------|---------|-----------|
| 0-30 days | PostgreSQL (hot, SSD) | High |
| 30-365 days | PostgreSQL (archive partition) | Medium |
| 365+ days | S3/MinIO (Parquet exports) | Low |

Transactions table partitioned by `created_at` month for efficient archival:

```sql
CREATE TABLE transactions (
    -- columns as above
) PARTITION BY RANGE (created_at);

CREATE TABLE transactions_2025_01 PARTITION OF transactions
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Sync fraud check | Inline (<50ms) | Async only | Decline bad payments immediately |
| Idempotency storage | Valkey with DB fallback | PostgreSQL only | Sub-ms lookups; DB as safety net |
| Ledger model | Double-entry in SQL | Event sourcing | Simpler; sufficient for debit/credit pattern |
| Webhook delivery | RabbitMQ + worker | Direct HTTP in request | Decouples merchant latency from payment response |
| Multi-currency | FX at capture time | FX at authorization | Locked rate prevents merchant surprise |
| Auth model | API keys (hashed) | OAuth2 / JWT | Simpler for M2M; immediate revocation via DB |

---

## Frontend Architecture

### Component Hierarchy

The frontend is a React SPA built with Vite, TypeScript, and Tailwind CSS. It serves as a merchant dashboard for managing payments, refunds, and viewing transaction analytics.

```
__root.tsx (RootLayout)
├── Nav bar with auth-aware links (Dashboard, Transactions, Refunds, Test Payment)
├── Merchant name display + logout
└── <Outlet /> renders child routes:
    ├── /login ─────────── Login (API key entry + merchant creation)
    ├── / ──────────────── Dashboard (balance card, stats grid: volume, txns, fees, success rate, refund rate, avg txn)
    ├── /transactions ──── Transactions (paginated table with status filter dropdown, links to detail)
    ├── /transactions/$id ─ Transaction Detail (single transaction view with capture/void/refund actions)
    ├── /refunds ────────── Refunds (paginated table of refund records)
    └── /test-payment ──── Test Payment (form to simulate payment creation with card details)
```

### Zustand Store

**`authStore`** (persisted to localStorage under `payment-auth`): Stores the merchant API key, merchant ID, merchant name, and `isAuthenticated` flag. The API key is used as a Bearer token in all requests. Persistence means the merchant stays logged in across browser sessions. The store exposes `setApiKey`, `setMerchant`, and `logout` actions.

This project uses API key auth rather than session cookies, so the store reads the key from localStorage on every request via the `getAuthHeaders()` helper in the API service.

### Routing

Uses TanStack Router with file-based routing. Routes are defined in `frontend/src/routes/` and auto-generated into `routeTree.gen.ts`. Each route component checks `isAuthenticated` from the auth store and redirects to `/login` if not authenticated. There is no route guard middleware; authentication is checked inline at the top of each route component.

### Data Fetching

All API calls go through a centralized `fetchApi<T>()` wrapper in `frontend/src/services/api.ts`. This wrapper automatically attaches the Bearer token from localStorage, parses JSON responses, and throws errors with the server's error message. Data fetching is done with `useEffect` + `useState` in each route component (no React Query or SWR). Each route manages its own loading, error, and data states locally.

The API service is organized by domain: merchants, payments (create, get, list, capture, void, refund), refunds (list), chargebacks (list), and ledger (verify, summary). Idempotency keys are auto-generated client-side for payment and refund creation using `Date.now()` + random string.

### Key UI Patterns

- **Merchant balance card**: Gradient banner at top of dashboard showing available balance, merchant name, and email
- **Stats grid**: Six metric cards (volume, transactions, fees, success rate, refund rate, avg transaction) with colored icons
- **Paginated table**: Used for both transactions and refunds lists with Previous/Next buttons and result count
- **Status filter**: Dropdown on transactions page to filter by payment status (pending, authorized, captured, etc.)
- **Status badges**: Color-coded pill badges for transaction statuses using a `getStatusColor()` utility
- **Currency formatting**: Centralized `formatCurrency()` and `formatPercent()` utilities in `frontend/src/utils/format.ts`
- **Inline auth guard**: Each authenticated route returns `<Navigate to="/login" />` if not authenticated, rather than using a wrapper

## Deep Pattern Explanations

This section explains each production-grade pattern used in this project. Each explanation assumes no prior familiarity with the pattern.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of granting individual permissions to each user (which becomes unmanageable at scale), you define a set of roles like "support", "operations", and "admin", each with a specific set of allowed actions. When a user makes a request, the system checks their role against the required permission for that endpoint.

In this project, admin operations use three roles: `support` (read-only access to transactions and merchants), `operations` (read access plus the ability to issue refunds), and `admin` (full read/write access plus merchant management). This prevents a support agent from accidentally suspending a merchant or issuing an unauthorized refund. The role is stored on the user record and checked by middleware before the route handler executes.

The alternative -- checking individual user IDs against an access list -- does not scale. With 50 support agents, you would need to update 50 records every time a new endpoint is added. With RBAC, you update the role definition once.

File: `backend/src/shared/auth.ts` (RBAC middleware)

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. If the data is in the cache (a "hit"), it is returned immediately. If not (a "miss"), the application queries the database, stores the result in the cache with a TTL (time-to-live), and then returns it. The cache is never populated proactively -- it is filled on demand as requests arrive.

In this project, merchant configuration is cached in Valkey with a 5-minute TTL. Every API request must validate the merchant's API key, which requires looking up the merchant record. Without caching, every request would hit PostgreSQL. With cache-aside, the first request for a given merchant hits the database and populates the cache; subsequent requests for the next 5 minutes are served from Valkey in sub-millisecond time. Exchange rates are also cached with a 5-minute TTL.

The trade-off is staleness: if a merchant's status is changed to "suspended" in the database, the cache may serve the old "active" status for up to 5 minutes. For merchant config this is acceptable. For idempotency keys, where correctness is critical, the system uses Valkey as the primary store (not as a cache-aside layer).

### Circuit Breaker

A circuit breaker is a stability pattern borrowed from electrical engineering. It wraps calls to an external service (like a payment processor or fraud service) and monitors failure rates. When failures exceed a threshold, the circuit "opens" and immediately rejects all subsequent calls without actually making the request. After a cooldown period, it enters a "half-open" state where it allows one test request through. If that succeeds, the circuit closes and normal traffic resumes. If it fails, the circuit opens again.

The purpose is to prevent cascading failures. Without a circuit breaker, if the payment processor is down, every incoming payment request would wait for a 30-second TCP timeout before failing. With 500 concurrent requests, this exhausts the connection pool and causes the entire API to become unresponsive -- even for endpoints that do not call the processor. The circuit breaker detects the failure pattern and fails fast (milliseconds instead of 30 seconds), preserving system resources for healthy operations.

In this project, circuit breakers wrap the payment processor and fraud scoring service using the `cockatiel` library. Configuration: 5 consecutive failures opens the circuit, 30-second recovery timeout, 2 successful requests needed to close. When the processor circuit is open, clients receive `503 Service Unavailable` immediately.

File: `backend/src/shared/circuit-breaker.ts`

### Structured Logging

Structured logging means emitting log entries as machine-parseable JSON objects rather than free-form text strings. Instead of `"Payment 123 authorized for $50.00 in 45ms"`, the system emits `{"event": "payment.authorized", "transaction_id": "123", "amount": 5000, "currency": "USD", "duration_ms": 45, "trace_id": "abc-def"}`. Each field is a named key-value pair.

The benefit is searchability and aggregation. With free-form text, finding all failed payments over $1000 requires regex parsing across millions of log lines. With structured JSON, a log aggregator (Elasticsearch, Datadog, Splunk) can index each field and answer the query in seconds: `status:failed AND amount:>100000`. Structured logs also enable automated alerting -- you can trigger an alert when `error_rate > 0.01` without writing custom parsers.

In this project, Pino produces JSON logs with contextual fields: `event`, `transaction_id`, `merchant_id`, `amount`, `currency`, `status`, `duration_ms`, `fraud_score`, and `trace_id`. The audit logger additionally writes to the PostgreSQL `audit_log` table for PCI-DSS compliance.

Files: `backend/src/shared/logger.ts`, `backend/src/shared/audit.ts`

### Prometheus Metrics

Prometheus is a time-series monitoring system. The application exposes an HTTP endpoint (`GET /metrics`) that returns numeric measurements in a specific text format. A Prometheus server scrapes this endpoint at regular intervals (typically every 15 seconds) and stores the data points over time. Grafana then visualizes these time series as dashboards and graphs.

There are four metric types: **Counter** (monotonically increasing, e.g., total payments processed), **Gauge** (goes up and down, e.g., current database connections), **Histogram** (measures distribution of values, e.g., request latency percentiles), and **Summary** (similar to histogram but calculated client-side).

In this project, key metrics include: `payment_request_duration_seconds` (histogram for latency SLO tracking), `payment_total` (counter by status and currency for volume monitoring), `webhook_delivery_total` (counter for webhook reliability), `fraud_score_distribution` (histogram for risk analysis), and `db_active_connections` (gauge for pool health). Alert rules trigger when error rate exceeds 1% for 5 minutes or p99 latency exceeds 2 seconds.

File: `backend/src/shared/metrics.ts`

### Rate Limiting

Rate limiting restricts the number of requests a client can make within a time window. It prevents abuse (a single client flooding the API with thousands of requests per second), protects against denial-of-service attacks, and ensures fair resource sharing among merchants.

The most common algorithm is the **sliding window**: track timestamps of recent requests in a sorted set, remove entries older than the window, and check if the count exceeds the limit. If it does, return `429 Too Many Requests`.

In this project, rate limits are enforced per merchant API key using Valkey sorted sets with `ZRANGEBYSCORE`. Each merchant has a configured limit (e.g., 100 requests per second). The rate limiter runs as Express middleware before any business logic. When Valkey is unavailable, the system degrades to no rate limiting rather than rejecting all requests -- availability is prioritized over strict enforcement during infrastructure failures.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. In a payment system, this is critical because network failures cause ambiguity: the client sends a payment request, the connection drops, and the client does not know if the payment was processed. Without idempotency, retrying the request could charge the customer twice.

The implementation works as follows: the client generates a unique key (e.g., UUID) and sends it with the request in the `Idempotency-Key` header. Before processing, the server checks Valkey for this key. If found, the server returns the cached response from the original request without re-executing any logic. If not found, the server processes the request, stores the result in Valkey keyed by the idempotency key with a 24-hour TTL, and returns the response. A distributed lock (`SET key NX EX 30`) prevents concurrent processing of the same key.

The database also has a `UNIQUE(merchant_id, idempotency_key)` constraint as a fallback. If Valkey is restarted and loses data, this constraint prevents duplicate payments at the database level (the insert fails with a constraint violation rather than creating a duplicate charge).

File: `backend/src/shared/idempotency.ts`

### Health Checks

Health checks are HTTP endpoints that report whether the service is functioning correctly. They serve two purposes: load balancers use them to route traffic away from unhealthy instances, and orchestration systems (Kubernetes, ECS) use them to restart failed containers.

There are typically three levels: **Liveness** (`/health/live`) reports whether the process is running -- if this fails, the process should be restarted. **Readiness** (`/health/ready`) reports whether the service can accept traffic -- it may be alive but not ready (e.g., still connecting to the database). **Deep health** (`/health`) checks all dependencies (database, cache, external services) and reports individual status.

In this project, the health endpoint tests PostgreSQL connectivity (runs a `SELECT 1` query), Valkey connectivity (runs a `PING`), and reports circuit breaker states. The load balancer removes instances that fail readiness checks, preventing users from hitting a server that cannot process payments. During graceful shutdown, the readiness check returns unhealthy immediately so the load balancer drains traffic before the process exits.

File: `backend/src/index.ts`

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker Compose.

### Local Setup Diagram

```
┌────────────────────┐
│   React SPA        │
│   (Vite :5173)     │
└─────────┬──────────┘
          │ HTTP
          ▼
┌────────────────────┐
│   API Server       │
│   (Express :3000)  │
│   or 3 instances   │
│   (:3001-3003)     │
├────────────────────┤
│  /health           │
│  /metrics          │
│  /api/v1/payments  │
│  /api/v1/merchants │
│  /api/v1/refunds   │
│  /api/v1/ledger    │
└──┬──────┬──────┬───┘
   │      │      │
   ▼      ▼      ▼
┌──────┐┌──────┐┌────────┐
│Postgr││Valkey││RabbitMQ│
│:5432 ││:6379 ││:5672   │
│      ││      ││:15672  │
└──────┘└──────┘└───┬────┘
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
    ┌──────────┐┌──────────┐  (Settlement
    │ Webhook  ││  Fraud   │   worker not
    │ Worker   ││  Worker  │   implemented)
    └──────────┘└──────────┘
```

### Production-Grade Patterns Actually Implemented

**1. Idempotency** -- Every payment mutation checks Valkey for an existing idempotency key before processing. Keys are scoped per merchant with 24-hour TTL. The distributed lock prevents concurrent processing of the same key.

File: `backend/src/shared/idempotency.ts`

**2. Double-Entry Ledger** -- Payment, capture, and refund operations create paired debit/credit entries in the `ledger_entries` table within a single PostgreSQL transaction.

Files: `backend/src/services/ledger.service.ts`, `backend/src/services/payment/`

**3. Circuit Breaker** -- Uses `cockatiel` library for circuit breakers on external processor and fraud service calls. Separate breakers for processor and fraud with configurable thresholds.

File: `backend/src/shared/circuit-breaker.ts`

**4. Prometheus Metrics** -- HTTP request duration histograms, payment counters by status/currency, fraud score distributions, circuit breaker state gauges, and DB connection metrics. Exposed at `GET /metrics`.

File: `backend/src/shared/metrics.ts`

**5. Structured Logging** -- Pino JSON logger with request context. Audit logger writes to both PostgreSQL `audit_log` table and structured log output.

Files: `backend/src/shared/logger.ts`, `backend/src/shared/audit.ts`

**6. Health Check** -- Full dependency health check at `GET /health` (PostgreSQL, Valkey, circuit breaker states), liveness probe at `/health/live`, readiness probe at `/health/ready`.

File: `backend/src/index.ts`

**7. Graceful Shutdown** -- SIGTERM/SIGINT handlers stop accepting new connections, drain in-flight requests, close database and Redis connections, with a 30-second forced exit timeout.

File: `backend/src/index.ts`

**8. Webhook Delivery Workers** -- Separate processes consume from RabbitMQ with exponential backoff retry.

File: `backend/src/workers/webhook-worker.ts`

### What Was Simplified or Substituted

| Production Component | Local Substitute | Reason |
|---------------------|-----------------|--------|
| API Gateway (Kong, AWS) | Direct Express access on :3000 | No need for managed gateway locally |
| Payment processor integration | Simulated processor responses | No real card network connection |
| HSM / PCI-compliant vault | `token_vault_ref` column (placeholder) | Hardware security modules out of scope |
| PostgreSQL sharding (Citus) | Single PostgreSQL instance | Sufficient for dev scale |
| Read replicas | Single instance handles reads/writes | No replication needed locally |
| Multi-region deployment | Single Docker Compose stack | Local development only |
| Managed queue (Amazon MQ) | Local RabbitMQ container | Same AMQP protocol |

### What Was Omitted

- **CDN** for frontend static assets
- **WAF** (Web Application Firewall) for PCI-DSS network requirements
- **Multi-region** active-passive deployment
- **Kubernetes** orchestration and auto-scaling
- **PgBouncer** connection pooling proxy
- **Settlement worker** (queue and schema exist but worker is not implemented)
- **Notification service** (email/SMS for payment receipts)
- **Full PCI-DSS compliance** (encryption at rest, network segmentation, penetration testing)
- **Real FX rate service** integration
- **Grafana dashboards** (Prometheus metrics are collected but no dashboards configured)
