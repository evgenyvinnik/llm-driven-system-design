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

Every balance change creates exactly two ledger entries -- a debit and a credit. For P2P transfers, the sender's wallet is debited and the recipient's wallet is credited within a single database transaction. Deposits and withdrawals have no internal counterparty, so they post against the platform's own **cash account** (see below). This ensures the total money in the system is always conserved.

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

**Deposits and withdrawals: the platform cash account.** A single `wallets` row with `account_type = 'platform_cash'` represents the money the platform holds at its bank:

```
Deposit $100:     debit  platform cash   +100   credit customer wallet +100
Withdrawal $40:   debit  customer wallet  -40   credit platform cash    -40
```

Customer wallets are liabilities and credit-normal (balance = credits - debits). Platform cash is an asset and debit-normal (balance = debits - credits), so its balance stays non-negative and the existing `CHECK (balance_cents >= 0)` applies to it too. Three invariants follow, and `GET /api/admin/reconciliation` checks them in one REPEATABLE READ snapshot:

1. Every transaction's entries net to zero.
2. Every wallet's stored balance equals its ledger balance.
3. The sum of customer balances equals platform cash -- the figure reconciled against the bank statement.

An earlier version posted deposits as a lone credit and only checked invariant 2, which cannot detect a bug that credits a wallet out of thin air.

### 2. Wallet Service (Optimistic Locking)

Deposits and withdrawals use optimistic locking via a `version` column. Each update includes `WHERE version = $expectedVersion` in the UPDATE statement. If another transaction has modified the wallet between our read and write, the update affects zero rows; the whole attempt (including its idempotency claim) rolls back and is retried up to three times, then the API returns 409. This prevents lost updates without holding long-lived locks. The platform cash row is updated last with an atomic increment (`balance_cents = balance_cents + $1`): every deposit touches it, so taking its lock at the end keeps the hold short, and since transfers never lock it, the lock order cannot form a cycle.

For P2P transfers specifically, both wallets are locked by one `SELECT ... WHERE user_id IN (a, b) ORDER BY user_id FOR UPDATE` (Postgres sorts before it locks, so the lower user_id is always locked first) to prevent deadlocks. Balance arithmetic happens in SQL on BIGINT; the application only validates that amounts are positive integers. The lock ordering is critical: without it, Transfer A (Alice to Bob) and Transfer B (Bob to Alice) executing simultaneously could each hold one lock and wait for the other indefinitely.

### 3. Idempotency Service

Transfers, deposits and withdrawals accept an `Idempotency-Key` header. Keys are scoped per user: the primary key is `(user_id, key)`, so one user's key can never replay another user's response. The first statement of the payment's transaction *claims* the key by inserting `(user_id, key, request_hash)`:

- New key: the insert succeeds and holds the primary-key slot until commit. A concurrent request with the same key blocks on that slot instead of executing a second payment.
- Committed key, same request hash: the stored response is replayed (with an `Idempotent-Replayed: true` header) and nothing executes.
- Committed key, different request hash (another amount, recipient or operation): 422.
- Expired key: overwritten and reused.

The response is written onto the claimed row before COMMIT, so the key and the payment commit or roll back together. An earlier version checked the key before opening the transaction and stored it at the end; two simultaneous retries then both executed, and the second failed on a unique index with a 500.

This design choice -- storing idempotency keys in PostgreSQL rather than Redis -- guarantees that the idempotency record and the payment are always consistent. If the transaction rolls back, the idempotency key is also rolled back, allowing a clean retry.

Keys expire after 24 hours; each API instance deletes expired keys hourly.

### 4. Request Flow

Money requests create a `transfer_requests` record with status `pending`. The payer can pay (which triggers a transfer) or decline. The requester can cancel. Status transitions:

```
pending ──▶ paid       (payer pays)
pending ──▶ declined   (payer declines)
pending ──▶ cancelled  (requester cancels)
```

Authorization checks ensure only the payer can pay/decline and only the requester can cancel; anyone who is neither party gets 404, so request IDs reveal nothing. Each action locks the request row with `SELECT ... FOR UPDATE` and runs in one transaction. Paying runs the transfer on the same connection and records its `transaction_id` on the request, so a double-click (or Pay racing Decline) resolves to exactly one outcome: the second request waits on the row lock, then sees a non-pending status and gets 409 without touching any wallet.

## Database Schema

```sql
-- Users table with role-based access ('user', 'admin', or 'system')
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

-- Wallets with optimistic locking (version column). One 'platform_cash'
-- wallet is the counterparty of every deposit and withdrawal.
CREATE TABLE wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL UNIQUE,
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  currency VARCHAR(3) DEFAULT 'USD',
  account_type VARCHAR(20) NOT NULL DEFAULT 'customer'
    CHECK (account_type IN ('customer', 'platform_cash')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_wallets_one_platform_cash
  ON wallets(account_type) WHERE account_type = 'platform_cash';

-- Linked funding sources (bank accounts and cards)
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) NOT NULL,
  type VARCHAR(20) NOT NULL,  -- 'bank' or 'card'
  label VARCHAR(100) NOT NULL,
  last_four VARCHAR(4),
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transactions (the business event)
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key VARCHAR(255),          -- audit only; uniqueness lives in idempotency_keys
  sender_id UUID REFERENCES users(id),   -- NULL for deposits
  recipient_id UUID REFERENCES users(id) NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency VARCHAR(3) DEFAULT 'USD',
  type VARCHAR(20) NOT NULL,             -- 'transfer', 'deposit', 'withdrawal'
  status VARCHAR(20) DEFAULT 'completed',
  note TEXT,
  payment_method_id UUID REFERENCES payment_methods(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Double-entry ledger (the accounting record)
CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) NOT NULL,
  wallet_id UUID REFERENCES wallets(id) NOT NULL,
  entry_type VARCHAR(10) NOT NULL CHECK (entry_type IN ('debit', 'credit')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
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
  transaction_id UUID REFERENCES transactions(id),  -- the transfer that paid it
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency keys, scoped per user, in the same DB as the payments
CREATE TABLE idempotency_keys (
  user_id UUID NOT NULL REFERENCES users(id),
  key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,  -- SHA-256 of operation + parameters
  response JSONB,                  -- written before the claiming transaction commits
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
  PRIMARY KEY (user_id, key)
);

-- At most one default payment method per user
CREATE UNIQUE INDEX idx_payment_methods_one_default
  ON payment_methods(user_id) WHERE is_default;
```

Key indexes: `(sender_id, created_at DESC)`, `(recipient_id, created_at DESC)`, `(wallet_id, created_at DESC)` for efficient history queries, and `ledger_entries(transaction_id)` for the per-transaction balance check. The full schema, including the `ALTER ... IF NOT EXISTS` upgrades for older volumes and the platform account rows, is `backend/src/db/init.sql`.

## API Design

### Authentication

```
POST /api/auth/register     Register new user + create wallet
POST /api/auth/login        Login with session (session ID regenerated)
POST /api/auth/logout       Destroy session
GET  /api/auth/me           Current user info
```

### Wallet

```
GET  /api/wallet             Get balance and wallet info
POST /api/wallet/deposit     Deposit from a linked method (debit platform cash, credit wallet)
POST /api/wallet/withdraw    Withdraw to a linked method (debit wallet, credit platform cash)
```

Deposit and withdrawal take `{ amountCents, paymentMethodId, note? }` and an optional `Idempotency-Key` header. `amountCents` must be a JSON integer from 1 to 1,000,000 ($10,000); a string such as `"100"` is rejected with 400 rather than coerced. A payment method that isn't the caller's returns 404, the same as a missing one.

```
POST /api/wallet/deposit
Idempotency-Key: 6f1c...            (optional)
{ "amountCents": 2500, "paymentMethodId": "b000...0001" }

200 { "transaction": { "id": "...", "type": "deposit", "amountCents": 2500, ... },
      "wallet": { "balanceCents": 263250, "version": 12, ... } }
```

### Transfers

```
POST /api/transfers          Send money (P2P transfer, Idempotency-Key header)
GET  /api/transfers          Caller's transaction history (type filter, limit 1-100, offset)
```

Transfers take `{ recipientId, amountCents, note? }` with `amountCents` from 1 to 5,000,000 ($50,000). Errors: 400 `INVALID_AMOUNT` / `AMOUNT_OVER_LIMIT` / `SELF_TRANSFER` / `INSUFFICIENT_FUNDS`, 404 `RECIPIENT_NOT_FOUND` (also for malformed IDs and the platform account), 422 `IDEMPOTENCY_KEY_REUSED`, 429 over the per-user money limit. A replay returns the original body with `Idempotent-Replayed: true`.

### Requests

```
POST /api/requests           Request money from another user
GET  /api/requests           List incoming/outgoing requests
POST /api/requests/:id/pay      Payer pays (one transaction: lock request, transfer, mark paid)
POST /api/requests/:id/decline  Payer declines
POST /api/requests/:id/cancel   Requester cancels
```

Outsiders get 404 on all three actions; the wrong party gets 403; a request that is no longer pending gets 409. Request amounts share the $50,000 transfer cap.

### Payment Methods

```
GET    /api/payment-methods          List payment methods
POST   /api/payment-methods          Add a payment method
DELETE /api/payment-methods/:id      Remove a payment method
PUT    /api/payment-methods/:id/default  Set as default
```

### Users

```
GET /api/users/search?q=    Search by username/display name (substring) or exact email; emails never returned
```

### Admin

```
GET /api/admin/reconciliation   Ledger invariants + per-wallet stored vs ledger balance (admin only)
```

## Key Design Decisions

### Double-Entry vs. Single-Entry Bookkeeping

**Chosen: Double-entry bookkeeping.** Every balance change creates paired debit/credit ledger entries. This provides a complete audit trail and enables balance verification by summing all ledger entries for a wallet. If `wallet.balance_cents` ever disagrees with `SUM(credits) - SUM(debits)`, we know something went wrong.

The alternative -- directly updating a balance column without ledger entries -- is simpler but loses auditability and makes reconciliation impossible. In a payment system handling real money, the ability to trace every cent through the ledger is non-negotiable. When regulators ask "where did this $10,000 go?", the ledger provides a complete, verifiable answer. A single balance column can only say "the balance is now X."

The write amplification cost (2 ledger entries per transfer instead of 1 balance update) is justified by the reconciliation capability and audit trail.

### Platform Cash Account vs. Single-Sided Deposits

**Chosen: post deposits and withdrawals against a platform cash account.** The alternative -- a deposit is a lone credit because the counterparty is an outside bank -- is simpler, but it forces the reconciliation check down to "each wallet matches its own entries". That check passes for a bug that credits a wallet with no money behind it, because a lone credit is a legal shape. With a cash account every posting is balanced, and "sum of customer balances = platform cash" catches money created or destroyed anywhere inside the system. It is also the number that gets reconciled against the bank statement.

The cost is a hot row: every deposit and withdrawal updates platform cash. Locally it is one row, locked last with an atomic increment so the hold covers only the end of the transaction. At production volume it would be split into N cash sub-accounts chosen at random (summed for reporting), or the cash leg would be posted in batches.

### Optimistic Locking vs. Pessimistic Locking

**Chosen: Optimistic locking with version numbers for general wallet operations.** We use `WHERE version = $expected` to detect concurrent modifications. In a P2P payment app, contention on a single wallet is relatively low -- a user does not send hundreds of payments per second.

Pessimistic locking (`SELECT ... FOR UPDATE`) would work but holds row-level locks longer, reducing throughput under moderate concurrency. However, we still use `FOR UPDATE` for the specific case of P2P transfers where we must lock both sender and receiver wallets atomically. The locks are acquired in consistent `user_id` order to prevent deadlocks.

The trade-off: optimistic locking requires retry logic when version conflicts occur. But at typical P2P payment rates (a user sends 1-10 payments per day), conflicts are rare. If a user's wallet becomes "hot" (e.g., a merchant receiving many payments), the retry rate increases and we would need to consider queue-based serialization.

### Idempotency Keys in PostgreSQL (Not Redis)

**Chosen: PostgreSQL-stored idempotency keys in the same transaction as the payment.** This guarantees atomicity: it is impossible to have the idempotency key stored without the payment completing, or vice versa. If the transaction rolls back, the key is also rolled back, allowing a clean retry.

Redis-based idempotency is faster (sub-ms vs. 1-5ms for PostgreSQL) but introduces a consistency gap: if the payment commits but the Redis write fails, the next retry will re-execute the payment because the key was not stored. For a financial system, this consistency guarantee outweighs the latency difference.

Two details make the Postgres approach actually hold under retries. First, the key is *claimed* (inserted) as the transaction's first statement rather than looked up beforehand, so the primary key serializes concurrent duplicates. Second, the key is scoped per user and bound to a hash of the request, so a key can only ever replay its own request for its own owner.

### Integer Cents vs. Decimal

**Chosen: BIGINT cents.** Storing amounts as integer cents avoids floating-point rounding errors. `$10.50` is stored as `1050`. The database enforces `CHECK (balance_cents >= 0)` to prevent negative balances at the schema level. Application code never performs decimal arithmetic on monetary values.

## Consistency and Idempotency

### Idempotency Pattern

Clients generate an idempotency key per payment attempt and reuse it on every retry of that attempt. The backend, inside one database transaction:
1. Claims `(user_id, key)` with the request hash (`INSERT ... ON CONFLICT DO UPDATE ... WHERE expired`)
2. If the key was already committed: replays the stored response (same hash) or returns 422 (different hash); a concurrent duplicate waits on the primary key and then takes this branch
3. Otherwise executes the payment
4. Writes the response onto the claimed key
5. Commits, so the key and the payment become visible together

This guarantees exactly-once semantics even if the client retries due to network timeouts.

### Wallet Consistency

The `CHECK (balance_cents >= 0)` constraint ensures the database rejects any update that would make a balance negative. Combined with optimistic locking and transaction isolation, this prevents double-spending even under concurrent access. The database constraint is the last line of defense -- application logic checks the balance first, but the CHECK constraint catches any edge case the application missed.

## Security

- **Session-based auth** with Redis-backed sessions (express-session + connect-redis); the session ID is regenerated on login and registration (no session fixation)
- **bcrypt** password hashing (10 rounds)
- **Rate limiting** in Redis, shared by all instances: auth endpoints 50/15 min per IP; one budget of 30/min **per user** across every money endpoint (transfers, request payments, deposits, withdrawals)
- **CSRF protection** via sameSite cookie attribute
- **Input validation**: amounts must be JSON integers within the caps (strings are rejected, never coerced); IDs are UUID-checked before they reach SQL; notes capped at 200 characters
- **Authorization**: users only touch their own wallets, payment methods and history; request actions return 404 to outsiders and 403 to the wrong party; deposits and withdrawals require a payment method the caller owns
- **Privacy**: user search never returns emails and matches email only exactly
- **No internal errors leak**: expected failures carry a code (`INSUFFICIENT_FUNDS`, ...), everything else is a generic 500

### Why Session Auth Over JWT

HTTP-only session cookies prevent XSS-based session theft, which is critical for a financial application. If a user's browser is compromised via XSS, the attacker cannot extract the session token because it is not accessible to JavaScript. With JWT stored in localStorage, the attacker can steal the token and use it from any device.

Redis session store enables immediate revocation: when a user logs out, the session is deleted from Redis and becomes invalid instantly. JWT requires either short expiry times (poor UX) or a token blacklist (which effectively re-implements session storage).

## Observability

- **Prometheus metrics**: HTTP request duration/count (labelled by route pattern, not raw URL), transfer duration/count, wallet operations, idempotency cache hits. Exposed at `GET /metrics`.
- **Reconciliation report**: `GET /api/admin/reconciliation` (admin page at `/admin`) checks the three ledger invariants in one snapshot
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

- **Circuit breaker** (Opossum) helper for external service calls with 50% error threshold and 30-second recovery timeout. Locally there are no external calls (deposits and withdrawals are simulated), so nothing is wrapped yet; a real bank or card processor call would be.
- **Optimistic-lock conflicts** on deposits/withdrawals are retried three times with jitter, then reported as 409
- **Database transaction rollback** on any error during transfer -- ensures no partial state
- **Graceful shutdown** with SIGTERM/SIGINT handlers
- **Connection pool** with configurable timeouts and max connections
- **Redis retry strategy** with exponential backoff

### What Happens When Things Go Wrong

| Failure | Impact | Mitigation |
|---------|--------|-----------|
| PostgreSQL down | All transfers fail | Circuit breaker fails fast; health check reports unhealthy |
| Redis down | Sessions lost | Users must re-login; rate limiting fails open (`passOnStoreError`) |
| Version conflict | Deposit/withdrawal retried server-side | 409 after 3 attempts; client retries with the same key |
| Duplicate pay click | Second request waits on the request row lock | 409 "already paid"; payer charged once |
| Network partition | Timeout on transfer | Idempotency key ensures retry safety |

## Scalability Considerations

### What Breaks First

1. **Single PostgreSQL** -- partition transactions and ledger by date range; read replicas for balance queries
2. **Platform cash row** -- every deposit and withdrawal updates it. Split into N sub-accounts or batch the cash leg
3. **Hot wallet contention** -- users with high transaction volume (merchants). Solution: queue-based processing or wallet sharding (multiple sub-wallets per user)
4. **Idempotency table growth** -- periodic cleanup of expired keys (24-hour TTL). Each API instance runs `DELETE FROM idempotency_keys WHERE expires_at < NOW()` hourly

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
| Idempotency scope | Per user + request hash, claimed first | Global key, checked up front | No cross-user replay; duplicates can't both execute |
| Deposit counterparty | Platform cash account | Single-sided credit | Every posting nets to zero; customers = cash |
| Request payment | Row lock + transfer in one txn | Check, transfer, update separately | Double click can't pay twice |
| Rate-limit key | Per user, Redis store | Per IP, in-memory | Shared across instances; NAT-friendly |
| Auth | Session-based | OAuth/JWT | Simpler for learning, immediate revocation |

---

## Frontend Architecture

### Component Hierarchy

The frontend is a React SPA built with Vite, TypeScript, and Tailwind CSS, styled with PayPal brand colors. It provides a consumer-facing P2P payment experience with send, request, and wallet management flows.

```
__root.tsx (RootComponent)
├── Header (PayPal-branded nav: Dashboard, Send, Request, Activity, Wallet, Admin for admins)
├── checkAuth() on mount to restore session
└── <Outlet /> renders child routes:
    ├── /login ──────────── Login (username + password)
    ├── /register ────────── Register (username, email, password)
    ├── / ──────────────── Dashboard
    │   ├── WalletCard (balance + Add money / Withdraw → WalletActionModal)
    │   ├── QuickActions (Send/Request shortcut buttons)
    │   ├── RequestCard (pending incoming/outgoing requests with Pay/Decline actions)
    │   └── TransactionList → TransactionItem (recent activity)
    ├── /send ──────────── Send Money
    │   ├── UserSearch (debounced search by name/email)
    │   └── SendMoneyForm (amount, note, idempotency key generation)
    ├── /request ────────── Request Money
    │   ├── UserSearch
    │   ├── RequestMoneyForm (amount, note)
    │   └── OutgoingRequests (your requests: status badges, Cancel while pending)
    ├── /activity ────────── Activity
    │   ├── ActivityFilters (type filter: all/transfer/deposit/withdrawal)
    │   └── TransactionList → TransactionItem
    ├── /payment-methods ─── Payment Methods
    │   ├── PaymentMethodCard (card/bank display with delete + set default)
    │   └── AddPaymentMethodModal (modal form for adding new methods)
    └── /admin ──────────── Ledger Reconciliation (admin only)
```

### Zustand Store

**`authStore`**: Manages the current user session. Stores the `User` object (or null), loading state, and error messages. Actions: `login()`, `register()`, `logout()`, `checkAuth()`, `clearError()`. The `checkAuth()` action calls `GET /api/auth/me` on app mount (triggered in `__root.tsx` via `useEffect`) to restore the session from the HTTP-only cookie. Unlike the payment-system project, this store is not persisted to localStorage because session state lives in the server-side cookie.

### Routing

Uses TanStack Router with file-based routing. Routes: `/` (dashboard), `/send`, `/request`, `/activity`, `/payment-methods`, `/admin`, `/login`, `/register`. All routes are flat siblings under `__root.tsx`, which renders `<Outlet />` inside a `<main>` landmark. The root component calls `checkAuth()` on mount to verify the session. Individual routes check `user` from the auth store and redirect to login if null.

### Data Fetching

API calls use a centralized `request<T>()` function in `frontend/src/services/api.ts` that sets `credentials: 'include'` (for cookie-based session auth), adds JSON content type, and throws errors with the server message. The API service is organized into domain-specific objects: `authApi`, `walletApi`, `transfersApi`, `requestsApi`, `paymentMethodsApi`, and `usersApi`.

Data fetching is done with `useEffect` + `useState` in route components. The send form and the deposit/withdraw modal keep one random idempotency key per payment attempt in a ref and send it as an `Idempotency-Key` header. A retry after a timeout reuses it, so the server replays instead of charging twice; editing the payment or a successful send starts a new attempt. (The old key was built from `Date.now()` at click time, so every retry got a new key.) Dollar amounts are parsed from the input string into integer cents (`utils/money.ts`), never through floating point, and more than two decimals is rejected.

### Key UI Patterns

- **Wallet card**: Gradient card (PayPal brand colors) displaying balance in cents converted to dollars, with Add money / Withdraw buttons that open a modal to pick a linked payment method
- **User search with debounce**: The `UserSearch` component debounces input and calls `usersApi.search()` to find recipients by name, username, or email. Results are displayed as selectable cards.
- **Request flow with inline actions**: Pending requests appear on the dashboard with Pay and Decline buttons; the request page lists your own requests with Cancel. Server errors ("Insufficient funds", "Request is already paid") are shown on the card. Each action refreshes the list.
- **Activity type filters**: Tab-style filter buttons (All, Transfers, Deposits, Withdrawals) that pass the type parameter to the API and re-fetch the transaction list
- **Status badges**: `StatusBadge` component renders colored pills for request statuses (pending, paid, declined, cancelled)
- **Modal for payment methods**: `AddPaymentMethodModal` overlays the page for adding a new card or bank account without navigating away
- **Transaction list with signed amounts**: `TransactionItem` shows positive amounts (green) for credits and negative amounts (red) for debits, with the counterparty name and note

## Deep Pattern Explanations

This section explains each production-grade pattern used in this project. Each explanation assumes no prior familiarity with the pattern.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of checking individual user IDs against an access list (which becomes unmanageable as the team grows), you define roles like "user" and "admin" with specific allowed actions. When a request arrives, middleware checks the user's role against the required permission.

In this project, users have a `role` column (default `'user'`). The schema supports admin operations, though the current implementation focuses on the user role. RBAC prevents unauthorized actions -- a regular user cannot access admin endpoints, and authorization checks on the request flow ensure only the payer can pay or decline a request, and only the requester can cancel it. This per-resource ownership check is a common extension of RBAC for user-owned resources.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. On a cache miss, the application queries the database, writes the result to the cache with a TTL, and returns it. On a cache hit, the cached value is returned directly, skipping the database entirely.

In this project, Valkey (Redis-compatible) stores user sessions with a TTL. While the primary data (wallets, transactions, idempotency keys) lives in PostgreSQL for consistency, sessions are stored in Redis because they are ephemeral -- losing a session means the user re-authenticates, not that money is lost. The cache-aside pattern could be extended to wallet balances for read-heavy dashboards (a common enhancement noted in the project), but the current implementation prioritizes consistency by always reading balances from PostgreSQL.

The trade-off is that cache-aside introduces staleness risk. For financial balances, even a few seconds of stale data could lead a user to believe they have funds they have already spent. This is why wallet reads go directly to PostgreSQL.

### Circuit Breaker

A circuit breaker is a stability pattern that wraps calls to external or unreliable services. It tracks success and failure rates. When failures exceed a threshold, the circuit "opens" and all subsequent calls fail immediately without attempting the request. After a cooldown period, the circuit enters "half-open" state, allowing one test request. If it succeeds, the circuit closes and normal traffic resumes.

In this project, `createCircuitBreaker()` wraps a function in an Opossum breaker. It is not wired to anything yet: the only external dependency would be a bank or card processor, and deposits and withdrawals are simulated locally. Configuration: 50% error threshold across 5+ requests opens the circuit; 30-second recovery timeout before half-open test. The purpose is preventing cascading failures. If the database becomes slow (responding in 10 seconds instead of 5 milliseconds), without a circuit breaker every incoming request would pile up waiting for database responses. Within seconds, the connection pool is exhausted, the event loop blocks, and the entire service becomes unresponsive -- even for endpoints that do not need the database. The circuit breaker detects the slowdown, opens, and fails fast, preserving the service for healthy operations.

File: `backend/src/services/circuitBreaker.ts`

### Structured Logging

Structured logging means emitting log entries as machine-parseable JSON objects rather than human-readable text strings. Instead of logging `"User alice sent $50 to bob"`, the system emits `{"event": "transfer.completed", "senderId": "uuid-1", "recipientId": "uuid-2", "amount_cents": 5000, "duration_ms": 23}`.

The benefit is operational: when investigating a failed transfer at 3 AM, you can query `event:transfer.failed AND amount_cents:>100000` in a log aggregator rather than grepping through gigabytes of text. Each field is independently indexable and filterable. Structured logs also enable automated dashboards and alerts -- you can compute transfer failure rates directly from log data without custom parsers.

In this project, Pino produces JSON logs with request context via `pino-http` middleware. Each log entry includes the user ID, request method, URL, response status, and duration. Financial operations add transfer-specific fields (amount, sender, recipient).

File: `backend/src/services/logger.ts`

### Prometheus Metrics

Prometheus is a time-series monitoring system where the application exposes numeric measurements at an HTTP endpoint (`GET /metrics`), and a Prometheus server scrapes this endpoint at regular intervals (every 15-30 seconds). The data is stored as time series and visualized in Grafana.

Four metric types exist: **Counter** (only goes up, e.g., total transfers processed), **Gauge** (goes up and down, e.g., active database connections), **Histogram** (measures value distributions with percentile buckets, e.g., transfer latency), and **Summary** (similar to histogram, computed client-side).

In this project, key metrics include: `transfer_duration_seconds` (histogram for SLO compliance and detecting database contention), `transfer_total{status}` (counter for success rate monitoring), `wallet_operation_total{type}` (counter for volume tracking per operation), `idempotency_hit_total` (counter indicating retry rate -- a high rate suggests client-side connectivity issues), and `http_request_duration_seconds` (histogram for overall API latency).

File: `backend/src/services/metrics.ts`

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. Without rate limiting, a single user (or attacker) could send thousands of requests per second, overwhelming the server and degrading performance for everyone else.

The implementation uses `express-rate-limit` with a Redis store (`rate-limit-redis` over the shared ioredis client). Three limits are configured: all API calls (1000 per 15 minutes per IP), auth endpoints (50 per 15 minutes per IP, against password guessing) and money movement (30 per minute **per user**, one budget shared by transfers, request payments, deposits and withdrawals, against automated fund draining). Limits are configurable through `RATE_LIMIT_*` environment variables. If Redis is unavailable the limiter fails open rather than blocking payments. When a client exceeds the limit, the server returns HTTP 429 (Too Many Requests) with a `Retry-After` header indicating when the client can try again.

The Redis store ensures rate limits work correctly across multiple API server instances. If the limit were stored in-memory, each server would track its own count, and a client could circumvent the limit by hitting different servers. Redis provides a shared counter that all servers increment.

File: `backend/src/services/rateLimiter.ts`

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. For a P2P payment system, this prevents the nightmare scenario: Alice sends $50 to Bob, the network drops before the response arrives, Alice retries, and Bob receives $100.

The client generates a unique idempotency key (UUID) for each payment attempt and sends it in the `Idempotency-Key` header. The server claims `(user_id, key)` as the first statement of the payment's transaction. If the key was already used for the same request, the stored response is replayed; if it was used for a different request, the server answers 422; if another request with the key is still running, this one waits for it. The key and the response commit with the payment.

This project stores idempotency keys in PostgreSQL (not Redis) for a critical reason: atomicity. The key and the payment are committed in the same transaction. If the transaction rolls back (e.g., insufficient funds), the key is also rolled back, allowing a clean retry. With Redis, a crash between the Redis write and the database commit would leave the key stored without the payment completed -- the client would think the payment succeeded but the money never moved.

Keys expire after 24 hours via a TTL column. A cleanup timer in each API instance deletes expired keys hourly to prevent unbounded table growth.

File: `backend/src/services/idempotencyService.ts`

### Health Checks

Health checks are HTTP endpoints that report whether the service can function correctly. They are consumed by load balancers (to route traffic away from unhealthy instances) and container orchestrators (to restart failed processes).

In this project, `GET /api/health` tests PostgreSQL connectivity by running a `SELECT 1` query. If the database is unreachable, the endpoint returns a 503 status, signaling the load balancer to stop sending traffic to this instance. This is important because a server with a broken database connection can accept requests but cannot process them -- every payment would fail. The health check turns this silent failure into an explicit signal.

Production systems typically have three levels: **liveness** (is the process running?), **readiness** (can it accept traffic?), and **deep health** (are all dependencies healthy?). This project implements the readiness level.

File: `backend/src/app.ts`

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
│  /admin         Ledger reconciliation
│  /login, /register
└──────────┬───────────┘
           │ HTTP (Vite proxy to :3001)
           ▼
┌──────────────────────┐
│    Express API       │
│    (:3001)           │
│    or 3 instances    │
│    (:3001-3003)      │
├──────────────────────┤
│  /api/auth/*         │
│  /api/wallet/*       │
│  /api/transfers      │
│  /api/requests/*     │
│  /api/payment-methods│
│  /api/users/search   │
│  /api/admin/*        │
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

**1. Double-Entry Bookkeeping** -- Every balance change writes a balanced debit/credit pair in the same transaction as the wallet update. Transfers pair two customer wallets; deposits and withdrawals pair a customer wallet with the platform cash account. `balance_after_cents` gives each entry a running balance.

File: `backend/src/services/transferService.ts`, `backend/src/services/walletService.ts`, `backend/src/services/ledger.ts`

**2. Reconciliation** -- `GET /api/admin/reconciliation` checks, in one REPEATABLE READ snapshot, that every transaction nets to zero, every wallet matches its ledger, and customer balances equal platform cash. The seed satisfies all three (it includes opening-balance deposits), and the live test suite asserts them after 50 concurrent opposite transfers.

File: `backend/src/routes/admin.ts`, `frontend/src/routes/admin.tsx`

**3. Idempotency** -- Transfers, deposits and withdrawals take an `Idempotency-Key` header. The key is claimed per user with a request hash as the transaction's first statement, the response is stored before commit, and a replay is flagged with `Idempotent-Replayed: true`.

```
INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
ON CONFLICT (user_id, key) DO UPDATE SET ... WHERE idempotency_keys.expires_at <= NOW()
RETURNING key            -- row: we own the key; no row: replay or 422
```

File: `backend/src/services/idempotencyService.ts`

**4. Locking** -- Transfers lock both wallets with one ordered `SELECT ... FOR UPDATE` (deadlock-free) and keep a version check as a tripwire. Deposits and withdrawals use optimistic `WHERE version = $read` with three jittered retries, then 409. Paying a request locks the request row first, so a double click can't pay twice.

File: `backend/src/services/transferService.ts` (lock ordering), `backend/src/services/walletService.ts` (version checks), `backend/src/routes/requests.ts` (request row lock)

**5. Strict money input** -- Amounts must be JSON integers within the caps. JavaScript `balance + "100"` is string concatenation, which once let a $1 deposit inflate a balance by millions; strings are now rejected and arithmetic runs in SQL. The frontend parses dollars to cents from the string, not via floats.

File: `backend/src/services/validation.ts`, `frontend/src/utils/money.ts`

**6. Prometheus Metrics** -- Transfer duration and count by status, wallet operations, idempotency hits, and HTTP duration/count labelled by route pattern. Exposed at `GET /metrics`.

File: `backend/src/services/metrics.ts`, `backend/src/app.ts`

**7. Structured Logging** -- Pino JSON logger with request context via pino-http middleware.

File: `backend/src/services/logger.ts`

**8. Rate Limiting** -- Redis store shared by all instances; per-IP limits for the API and auth, a per-user budget across money endpoints; fails open if Redis is down. Verified live: 20 requests on :3001 plus 11 on :3002 trip the limit on the 31st.

File: `backend/src/services/rateLimiter.ts`

**9. Health Check and Cleanup** -- `GET /api/health` tests PostgreSQL connectivity; each instance purges expired idempotency keys hourly.

File: `backend/src/app.ts`, `backend/src/index.ts`

**Not wired:** the Opossum circuit breaker (`backend/src/services/circuitBreaker.ts`) has no caller, because there is no external dependency to protect locally.

**Testing:** vitest unit tests with a scripted fake `pg` client (`backend/src/test/fakeDb.ts`) cover validation, lock and posting order, idempotency claim/replay/mismatch, optimistic retries, payment-method ownership, request authorization and session regeneration. Playwright smoke tests cover each screen.

### What Was Simplified or Substituted

| Production Component | Local Substitute | Reason |
|---------------------|-----------------|--------|
| API Gateway (Kong, AWS) | Direct Express access on :3001 (Vite proxy) | No managed gateway needed locally |
| PostgreSQL sharding (Citus) | Single PostgreSQL instance | Sufficient for dev scale |
| Read replicas | Single instance handles reads/writes | No replication needed |
| Real payment gateway (Stripe, Plaid) | Simulated deposits/withdrawals that complete immediately | No real bank integration |
| Sharded platform cash sub-accounts | One platform cash wallet row | Contention is irrelevant at local scale |
| Scheduled reconciliation job with alerting | On-demand admin report | Same queries, no scheduler or pager locally |
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
- **Withdrawal settlement lifecycle** (pending → settled/returned); withdrawals debit and complete at once. The seed's one `pending` withdrawal is already debited
