# PayPal - P2P Payment Platform Architecture

## System Overview

A peer-to-peer payment platform enabling users to send money, request payments, and manage digital wallets. The system implements double-entry bookkeeping for financial integrity, idempotent payment processing, and optimistic locking for concurrent wallet access. Learning goals: financial transaction atomicity, ledger consistency, idempotency patterns, and wallet management.

## Requirements

### Functional Requirements

- User registration and authentication
- Digital wallet with deposit, withdrawal, and balance inquiry
- P2P money transfers between users
- Money request flow (request, pay, decline, cancel)
- Payment method management (bank accounts, cards)
- Transaction history with filtering
- User search for sending/requesting money

### Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Consistency | All money transfers must be ACID -- no partial transfers, no double-spending |
| Availability | 99.99% uptime for payment processing |
| Latency | p99 < 200ms for balance queries, p99 < 500ms for transfers |
| Idempotency | Every payment operation must be safely retryable |
| Auditability | Complete ledger trail for every balance change |
| Throughput | 10K transfers/second at peak |

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Registered users | 400 million |
| Monthly active users | 50 million |
| Daily P2P transfers | 30 million |
| Average transfer size | $75 |
| Daily volume | $2.25 billion |
| Peak transfers/second | 10,000 |
| Ledger entries/day | 60 million (2x transfers) |
| DB write throughput | ~700 RPS average |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Users | 2-10 |
| Transfers/day | 50-200 |
| Single PostgreSQL instance | Handles all data |
| Single Valkey instance | Sessions + rate limits |

## High-Level Architecture

```
┌──────────────────┐
│   React SPA      │
│   (Vite)         │
└────────┬─────────┘
         │ HTTPS
         ▼
┌──────────────────────────────────────────────────────┐
│                 API Gateway / CDN                      │
│         (TLS, Rate Limiting, DDoS Protection)          │
└──────────────────────────┬───────────────────────────┘
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
      ┌────────────┬───────┼───────┬────────────┐
      ▼            ▼       ▼       ▼            ▼
┌──────────┐ ┌──────────┐ ┌───┐ ┌──────────┐ ┌──────────┐
│PostgreSQL│ │PostgreSQL│ │   │ │  Valkey   │ │Prometheus│
│ Primary  │ │ Replica  │ │   │ │ (Cache +  │ │+ Grafana │
│ (Writes) │ │ (Reads)  │ │   │ │ Sessions) │ │          │
└──────────┘ └──────────┘ │   │ └──────────┘ └──────────┘
                           │   │
                     ┌─────┘   │
                     ▼         ▼
              ┌──────────┐ ┌──────────────┐
              │  Kafka   │ │ Notification │
              │ (Events) │ │   Service    │
              └──────────┘ └──────────────┘
```

## Core Components

### 1. Transfer Engine (Double-Entry Bookkeeping)

Every balance change creates exactly two ledger entries -- a debit and a credit. For P2P transfers, the sender's wallet is debited and the recipient's wallet is credited within a single database transaction. This ensures the total money in the system is always conserved.

```
Transfer Flow:
┌──────────┐     ┌────────────┐     ┌───────────┐     ┌──────────────┐
│  Client   │────▶│ Idempotency│────▶│   Lock    │────▶│  Execute     │
│  Request  │     │   Check    │     │  Wallets  │     │  Transfer    │
└──────────┘     └────────────┘     └───────────┘     └──────┬───────┘
                                                              │
                      ┌───────────────────────────────────────┘
                      │
                      ▼
               ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
               │ Debit Sender │────▶│Credit Recip. │────▶│   Create     │
               │   Wallet     │     │   Wallet     │     │ Ledger Entries│
               └──────────────┘     └──────────────┘     └──────────────┘
```

For a $50 transfer from Alice to Bob:
1. **Debit entry**: Alice's wallet -$50, `balance_after = previous - 50`
2. **Credit entry**: Bob's wallet +$50, `balance_after = previous + 50`
3. Both entries reference the same `transaction_id`
4. Sum of all debits always equals sum of all credits

This invariant enables reconciliation: `SUM(credits) - SUM(debits)` per wallet should equal `wallet.balance_cents`. Any discrepancy indicates a bug or data corruption.

### 2. Wallet Service (Optimistic Locking)

Wallet balances use optimistic locking via a `version` column. Each update includes `WHERE version = $expectedVersion` in the UPDATE statement. If another transaction has modified the wallet between our read and write, the update affects zero rows and we detect the conflict immediately. This prevents double-spending without holding long-lived locks.

For P2P transfers specifically, both wallets are locked using `SELECT ... FOR UPDATE` with consistent lock ordering by `user_id` to prevent deadlocks. The lock ordering is critical: without it, Transfer A (Alice to Bob) and Transfer B (Bob to Alice) executing simultaneously could each hold one lock and wait for the other indefinitely.

### 3. Idempotency Service

Payment operations accept an `idempotency_key`. Before executing a transfer, the system checks the `idempotency_keys` table. If the key exists and has not expired, the cached response is returned without re-executing the payment. The key is stored within the same database transaction as the transfer, ensuring atomicity between the payment and the idempotency record.

This design choice -- storing idempotency keys in PostgreSQL rather than Redis -- guarantees that the idempotency record and the payment are always consistent. If the transaction rolls back, the idempotency key is also rolled back, allowing a clean retry.

Keys expire after 24 hours to prevent unbounded table growth.

### 4. Request Flow

Money requests create a `transfer_requests` record with status `pending`. The payer can pay (which triggers a transfer) or decline. The requester can cancel. Status transitions:

```
pending ──▶ paid       (payer pays)
pending ──▶ declined   (payer declines)
pending ──▶ cancelled  (requester cancels)
```

Authorization checks ensure only the payer can pay/decline and only the requester can cancel.

## Database Schema

```sql
-- Users table with role-based access
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Wallets with optimistic locking (version column)
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL UNIQUE,
  balance_cents BIGINT DEFAULT 0 CHECK (balance_cents >= 0),
  currency VARCHAR(3) DEFAULT 'USD',
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions (the business event)
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(255) UNIQUE,
  sender_id UUID REFERENCES users(id),
  recipient_id UUID REFERENCES users(id) NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency VARCHAR(3) DEFAULT 'USD',
  type VARCHAR(20) NOT NULL,  -- 'transfer', 'deposit', 'withdrawal'
  status VARCHAR(20) DEFAULT 'completed',
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Double-entry ledger (the accounting record)
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) NOT NULL,
  wallet_id UUID REFERENCES wallets(id) NOT NULL,
  entry_type VARCHAR(10) NOT NULL,  -- 'debit' or 'credit'
  amount_cents BIGINT NOT NULL,
  balance_after_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Money request flow
CREATE TABLE transfer_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID REFERENCES users(id) NOT NULL,
  payer_id UUID REFERENCES users(id) NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency VARCHAR(3) DEFAULT 'USD',
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency key storage (same DB as transfers for atomic consistency)
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);
```

Key indexes: `(sender_id, created_at DESC)`, `(recipient_id, created_at DESC)`, `(wallet_id, created_at DESC)` for efficient history queries.

## API Design

### Authentication

```
POST /api/auth/register     Register new user + create wallet
POST /api/auth/login        Login with session
POST /api/auth/logout       Destroy session
GET  /api/auth/me           Current user info
```

### Wallet

```
GET  /api/wallet             Get balance and wallet info
POST /api/wallet/deposit     Deposit funds (creates credit entry)
POST /api/wallet/withdraw    Withdraw funds (creates debit entry)
```

### Transfers

```
POST /api/transfers          Send money (P2P transfer with idempotency key)
GET  /api/transfers          Transaction history with type filter
```

### Requests

```
POST /api/requests           Request money from another user
GET  /api/requests           List incoming/outgoing requests
POST /api/requests/:id/pay   Pay a pending request
POST /api/requests/:id/decline  Decline or cancel a request
```

### Payment Methods

```
GET    /api/payment-methods          List payment methods
POST   /api/payment-methods          Add a payment method
DELETE /api/payment-methods/:id      Remove a payment method
PUT    /api/payment-methods/:id/default  Set as default
```

### Users

```
GET /api/users/search?q=    Search users by name/email
```

## Key Design Decisions

### Double-Entry vs. Single-Entry Bookkeeping

**Chosen: Double-entry bookkeeping.** Every balance change creates paired debit/credit ledger entries. This provides a complete audit trail and enables balance verification by summing all ledger entries for a wallet. If `wallet.balance_cents` ever disagrees with `SUM(credits) - SUM(debits)`, we know something went wrong.

The alternative -- directly updating a balance column without ledger entries -- is simpler but loses auditability and makes reconciliation impossible. In a payment system handling real money, the ability to trace every cent through the ledger is non-negotiable. When regulators ask "where did this $10,000 go?", the ledger provides a complete, verifiable answer. A single balance column can only say "the balance is now X."

The write amplification cost (2 ledger entries per transfer instead of 1 balance update) is justified by the reconciliation capability and audit trail.

### Optimistic Locking vs. Pessimistic Locking

**Chosen: Optimistic locking with version numbers for general wallet operations.** We use `WHERE version = $expected` to detect concurrent modifications. In a P2P payment app, contention on a single wallet is relatively low -- a user does not send hundreds of payments per second.

Pessimistic locking (`SELECT ... FOR UPDATE`) would work but holds row-level locks longer, reducing throughput under moderate concurrency. However, we still use `FOR UPDATE` for the specific case of P2P transfers where we must lock both sender and receiver wallets atomically. The locks are acquired in consistent `user_id` order to prevent deadlocks.

The trade-off: optimistic locking requires retry logic when version conflicts occur. But at typical P2P payment rates (a user sends 1-10 payments per day), conflicts are rare. If a user's wallet becomes "hot" (e.g., a merchant receiving many payments), the retry rate increases and we would need to consider queue-based serialization.

### Idempotency Keys in PostgreSQL (Not Redis)

**Chosen: PostgreSQL-stored idempotency keys in the same transaction as the payment.** This guarantees atomicity: it is impossible to have the idempotency key stored without the payment completing, or vice versa. If the transaction rolls back, the key is also rolled back, allowing a clean retry.

Redis-based idempotency is faster (sub-ms vs. 1-5ms for PostgreSQL) but introduces a consistency gap: if the payment commits but the Redis write fails, the next retry will re-execute the payment because the key was not stored. For a financial system, this consistency guarantee outweighs the latency difference.

### Integer Cents vs. Decimal

**Chosen: BIGINT cents.** Storing amounts as integer cents avoids floating-point rounding errors. `$10.50` is stored as `1050`. The database enforces `CHECK (balance_cents >= 0)` to prevent negative balances at the schema level. Application code never performs decimal arithmetic on monetary values.

## Consistency and Idempotency

### Idempotency Pattern

Clients generate an idempotency key for each transfer attempt. The backend:
1. Checks `idempotency_keys` table for existing key
2. If found and not expired, returns the cached response (no re-execution)
3. If not found, executes the transfer within a database transaction
4. Stores the idempotency key and response in the same transaction
5. Returns the result

This guarantees exactly-once semantics even if the client retries due to network timeouts.

### Wallet Consistency

The `CHECK (balance_cents >= 0)` constraint ensures the database rejects any update that would make a balance negative. Combined with optimistic locking and transaction isolation, this prevents double-spending even under concurrent access. The database constraint is the last line of defense -- application logic checks the balance first, but the CHECK constraint catches any edge case the application missed.

## Security

- **Session-based auth** with Redis-backed sessions (express-session + connect-redis)
- **bcrypt** password hashing (10 rounds)
- **Rate limiting** on auth endpoints (50/15min) and transfer endpoints (30/min)
- **CSRF protection** via sameSite cookie attribute
- **Input validation** on all amounts (positive integers, maximum limits)
- **Authorization checks** on request pay/decline (only payer or requester)

### Why Session Auth Over JWT

HTTP-only session cookies prevent XSS-based session theft, which is critical for a financial application. If a user's browser is compromised via XSS, the attacker cannot extract the session token because it is not accessible to JavaScript. With JWT stored in localStorage, the attacker can steal the token and use it from any device.

Redis session store enables immediate revocation: when a user logs out, the session is deleted from Redis and becomes invalid instantly. JWT requires either short expiry times (poor UX) or a token blacklist (which effectively re-implements session storage).

## Observability

- **Prometheus metrics**: HTTP request duration/count, transfer duration/count, wallet operations, idempotency cache hits. Exposed at `GET /metrics`.
- **Structured logging**: Pino JSON logger with request context (userId, transferId, amount)
- **Health check**: `GET /api/health` tests database connectivity and returns status
- **Metrics endpoint**: `GET /metrics` for Prometheus scraping

### Key Metrics for Financial Systems

| Metric | Type | Why It Matters |
|--------|------|---------------|
| `transfer_duration_seconds` | Histogram | SLO compliance; detects DB contention |
| `transfer_total{status}` | Counter | Success rate; detects payment failures |
| `wallet_operation_total{type}` | Counter | Volume tracking per operation type |
| `idempotency_hit_total` | Counter | Retry rate; indicates client-side issues |
| `http_request_duration_seconds` | Histogram | Overall API latency |

## Failure Handling

- **Circuit breaker** (Opossum) for external service calls with 50% error threshold and 30-second recovery timeout
- **Database transaction rollback** on any error during transfer -- ensures no partial state
- **Graceful shutdown** with SIGTERM/SIGINT handlers
- **Connection pool** with configurable timeouts and max connections
- **Redis retry strategy** with exponential backoff

### What Happens When Things Go Wrong

| Failure | Impact | Mitigation |
|---------|--------|-----------|
| PostgreSQL down | All transfers fail | Circuit breaker fails fast; health check reports unhealthy |
| Redis down | Sessions lost | Users must re-login; rate limiting degrades to no-limit |
| Version conflict | Single transfer retries | Client generates new idempotency key and retries |
| Network partition | Timeout on transfer | Idempotency key ensures retry safety |

## Scalability Considerations

### What Breaks First

1. **Single PostgreSQL** -- partition transactions and ledger by date range; read replicas for balance queries
2. **Hot wallet contention** -- users with high transaction volume (merchants). Solution: queue-based processing or wallet sharding (multiple sub-wallets per user)
3. **Idempotency table growth** -- periodic cleanup of expired keys (24-hour TTL). A background job runs `DELETE FROM idempotency_keys WHERE expires_at < NOW()`

### Scaling Strategy

- Horizontal API scaling behind load balancer (stateless with Redis sessions)
- PostgreSQL read replicas for transaction history queries
- Wallet sharding by `user_id` hash for high-throughput users
- Event-driven architecture (Kafka) for notification and analytics pipelines
- CDN for frontend static assets

### Connection Pooling

Each API server maintains a pool of 20 PostgreSQL connections. With 3 servers, total pool is 60 connections. PostgreSQL `max_connections` set to 100. At higher scale, PgBouncer provides connection multiplexing, allowing hundreds of API server instances to share a fixed number of database connections.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Bookkeeping | Double-entry ledger | Direct balance update | Complete audit trail, reconciliation |
| Concurrency control | Optimistic locking | Pessimistic locks | Lower contention for P2P workload |
| Amount storage | BIGINT cents | DECIMAL | No floating-point errors in app code |
| Session storage | Redis + cookie | JWT | Immediate revocation, XSS-safe |
| Idempotency | DB-stored keys | Redis-stored keys | Atomicity with transfer in same txn |
| Auth | Session-based | OAuth/JWT | Simpler for learning, immediate revocation |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker Compose.

### Local Setup Diagram

```
┌──────────────────────┐
│    React SPA         │
│    (Vite :5173)      │
│                      │
│  /              Dashboard (balance, requests, activity)
│  /send          Send money (user search, amount)
│  /request       Request money
│  /activity      Transaction history with filters
│  /payment-methods  Manage cards/banks
│  /login, /register
└──────────┬───────────┘
           │ HTTP (proxy to :3000)
           ▼
┌──────────────────────┐
│    Express API       │
│    (:3000)           │
│    or 3 instances    │
│    (:3001-3003)      │
├──────────────────────┤
│  /api/auth/*         │
│  /api/wallet/*       │
│  /api/transfers      │
│  /api/requests/*     │
│  /api/payment-methods│
│  /api/users/search   │
│  /api/health         │
│  /metrics            │
└──┬───────────────┬───┘
   │               │
   ▼               ▼
┌──────────┐  ┌──────────┐
│PostgreSQL│  │  Valkey   │
│  :5432   │  │  :6379   │
│          │  │          │
│ users    │  │ sessions │
│ wallets  │  │ rate     │
│ txns     │  │ limits   │
│ ledger   │  │          │
│ requests │  │          │
│ idempot. │  │          │
└──────────┘  └──────────┘
```

### Production-Grade Patterns Actually Implemented

**1. Double-Entry Bookkeeping** -- Every balance change creates paired debit/credit ledger entries within a single database transaction. Deposits create a credit entry; withdrawals create a debit entry; transfers create one of each. The `balance_after_cents` column provides a running balance snapshot for each entry.

File: `backend/src/services/transferService.ts`

**2. Idempotency** -- Transfer endpoint accepts idempotency keys. The key and response are stored atomically with the payment in the same PostgreSQL transaction. Subsequent requests with the same key return the cached response without re-executing.

File: `backend/src/services/idempotencyService.ts`

**3. Optimistic Locking** -- Wallet updates use `WHERE version = $expected` to detect concurrent modifications. For P2P transfers, wallets are locked with `SELECT ... FOR UPDATE` in consistent `user_id` order to prevent deadlocks.

File: `backend/src/services/transferService.ts` (lock ordering), `backend/src/services/walletService.ts` (version checks)

**4. Circuit Breaker** -- Opossum-based circuit breaker wraps external service calls with automatic failure detection. Opens at 50% error rate across 5+ requests; recovers after 30-second timeout.

File: `backend/src/services/circuitBreaker.ts`

**5. Prometheus Metrics** -- Custom metrics for transfer duration, transfer count by status, wallet operations, idempotency cache hits, and HTTP request duration. Exposed at `GET /metrics`.

File: `backend/src/services/metrics.ts`

**6. Structured Logging** -- Pino JSON logger with request context via pino-http middleware.

File: `backend/src/services/logger.ts`

**7. Rate Limiting** -- Express-rate-limit with Redis store. Separate limits for auth (50/15min) and transfers (30/min).

File: `backend/src/services/rateLimiter.ts`

**8. Health Check** -- `GET /api/health` tests PostgreSQL connectivity.

File: `backend/src/app.ts`

### What Was Simplified or Substituted

| Production Component | Local Substitute | Reason |
|---------------------|-----------------|--------|
| API Gateway (Kong, AWS) | Direct Express access on :3000 | No managed gateway needed locally |
| PostgreSQL sharding (Citus) | Single PostgreSQL instance | Sufficient for dev scale |
| Read replicas | Single instance handles reads/writes | No replication needed |
| Real payment gateway (Stripe, Plaid) | Simulated deposits/withdrawals | No real bank integration |
| Multi-currency support | Single currency (USD only) | Simplifies wallet logic |
| OAuth2 with MFA | Session cookies with bcrypt | Simpler for learning project |
| Kafka for event streaming | No event bus | Events not needed at dev scale |
| CDN for frontend assets | Vite dev server on :5173 | Local development only |

### What Was Omitted

- **CDN** for frontend static assets
- **Multi-region** deployment and geographic routing
- **Kubernetes** orchestration and auto-scaling
- **Fraud detection** ML pipeline
- **Notification service** (email/push for transfers and requests)
- **Currency conversion** service for multi-currency transfers
- **Compliance/KYC** verification (identity documents, OFAC screening)
- **Dispute resolution** and refund flows
- **Grafana dashboards** (Prometheus metrics collected but not visualized)
- **Background job scheduler** for idempotency key cleanup
