# Payment System - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design the backend infrastructure for a payment processing system that:
- Processes credit card, debit card, and bank transfer transactions
- Handles refunds with proper double-entry accounting
- Detects fraud in real-time
- Scales to handle 2,000+ transactions per second

## Requirements Clarification

### Functional Requirements
1. **Payment Processing**: Authorize, capture, void, and settle payments
2. **Idempotency**: Retry-safe operations preventing double-charges
3. **Refunds**: Full and partial refunds with ledger reconciliation
4. **Multi-Currency**: Real-time conversion with locked exchange rates
5. **Fraud Detection**: Rule-based and ML-based risk scoring
6. **Webhooks**: Reliable delivery of payment events to merchants

### Non-Functional Requirements
1. **Consistency**: Strong consistency for all ledger operations - no accounting discrepancies
2. **Availability**: 99.99% uptime for payment authorization
3. **Latency**: Authorization < 2 seconds at p99
4. **Durability**: Zero data loss for transaction records
5. **Security**: PCI-DSS compliance, encryption at rest and in transit

### Scale Estimates
- 50M transactions/day = 600 TPS average, 2,000 TPS peak
- Transaction record: ~2 KB per transaction
- 7-year retention (regulatory) = 250 TB
- Read:Write ratio = 3:1 (dashboard queries vs new transactions)

## High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          Load Balancer (nginx)                              │
└────────────────────────────────────────────────────────────────────────────┘
                                     │
                  ┌──────────────────┼──────────────────┐
                  ▼                  ▼                  ▼
          ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
          │ API Server  │    │ API Server  │    │ API Server  │
          │  (Node.js)  │    │  (Node.js)  │    │  (Node.js)  │
          └──────┬──────┘    └──────┬──────┘    └──────┬──────┘
                 │                  │                  │
                 └──────────────────┼──────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│     Valkey      │       │   PostgreSQL    │       │    RabbitMQ     │
│  (Cache/Locks)  │       │   (Primary +    │       │   (Webhooks,    │
│                 │       │   Replicas)     │       │   Settlement)   │
└─────────────────┘       └─────────────────┘       └─────────────────┘
                                                             │
                          ┌──────────────────────────────────┤
                          ▼                                  ▼
                 ┌─────────────────┐              ┌─────────────────┐
                 │ Webhook Worker  │              │Settlement Worker│
                 └─────────────────┘              └─────────────────┘
```

## Deep Dive: Data Model Design

### Core Database Schema

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| **merchants** | id (UUID PK), account_id (FK→accounts), name, email (unique), api_key_hash (bcrypt), webhook_url, webhook_secret, default_currency, status, created_at | Primary key on id, unique on email | API key stored as a bcrypt hash, never in plaintext. Each merchant owns an `accounts` row — the ledger credits *that* account, so sharing one with a system account would make the books incoherent |
| **transactions** | id (UUID PK), merchant_id (FK→merchants), idempotency_key, amount (BIGINT, smallest currency unit), currency, captured_amount, refunded_amount, status, failure_code, processor_ref, fraud_score, fraud_flags (JSONB), version (optimistic lock), created_at, updated_at | UNIQUE(merchant_id, idempotency_key) | Status values: pending, authorized, captured, voided, failed, refunded. Amount in cents avoids floating-point issues |
| **ledger_entries** | id (UUID PK), transaction_id (FK→transactions), entry_type (debit/credit), account_type, amount (BIGINT), currency, balance_after, created_at | Primary key on id | Account types: merchant_balance, platform_fee, processor_cost. Every transaction must have balanced entries |
| **audit_log** | id (BIGSERIAL PK), entity_type, entity_id, action, actor_type, actor_id, changes (JSONB), ip_address (INET), created_at | Primary key on id | PCI compliance requirement; immutable append-only log |

### Index Strategy

| Index | Target Column(s) | Purpose |
|-------|-------------------|---------|
| idx_transactions_idempotency | transactions(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL | Fast idempotency lookups; partial index excludes null keys |
| idx_transactions_merchant_time | transactions(merchant_id, created_at DESC) | Dashboard queries filtered by merchant |
| idx_transactions_status | transactions(status, created_at) WHERE status IN ('authorized', 'captured') | Partial index for pending settlement processing |
| idx_ledger_account_time | ledger_entries(account_type, created_at) | Ledger reconciliation queries by account type |
| idx_audit_entity | audit_log(entity_type, entity_id, created_at DESC) | Audit trail lookups for specific entities |

> "One consequence of bcrypt worth flagging: bcrypt hashes are salted, so they aren't reversible *or* indexable. You cannot look a merchant up by hashing the presented key — you have to load candidate merchants and `bcrypt.compare` against each. That's fine at a handful of merchants and O(n) bcrypt operations per request at scale, which is a denial-of-service waiting to happen. The fix is a structured key, `pk_<key_id>_<secret>`: index on `key_id` for an O(1) lookup, then run exactly one bcrypt comparison against that row's hash. You keep the property that a database leak doesn't yield usable keys, and you stop paying for it linearly."

### Why PostgreSQL Over Alternatives?

| Consideration | PostgreSQL | Cassandra | MongoDB |
|---------------|------------|-----------|---------|
| ACID transactions | Full | Limited | Limited |
| Ledger consistency | Excellent | Poor | Moderate |
| Complex queries | Excellent | Poor | Moderate |
| Partitioning | Native | Excellent | Good |
| Operational complexity | Low | High | Moderate |

**Decision**: PostgreSQL is ideal for payment systems because:
1. Double-entry accounting requires ACID transactions
2. Reconciliation needs complex aggregate queries
3. Regulatory audits require precise data integrity
4. Read replicas handle dashboard query load

## Deep Dive: Idempotency Implementation

### The Double-Charge Problem

Without idempotency, retries cause duplicate charges:

```
1. Client sends payment request
2. Server processes, charges card successfully
3. Network timeout - client never receives response
4. Client retries with same request
5. Server processes again - customer charged twice!
```

### Idempotency Key Flow

The payment processing function prevents double-charges through a five-step flow:

1. **Check cache**: Look up `idempotency:{merchantId}:{idempotencyKey}` in Valkey. If a cached response exists, return it immediately (same response the client would have received originally)
2. **Acquire distributed lock**: Set a lock key in Valkey with NX (only if not exists) and a 30-second TTL. If the lock is already held, another server is processing the same request -- return a 409 Conflict
3. **Process in database transaction**: Within a single PostgreSQL transaction, insert the transaction record and create balanced ledger entries atomically (debit customer, credit merchant balance, credit platform fee)
4. **Cache response**: Store the successful response in Valkey with a 24-hour TTL so future retries hit the cache
5. **Release lock**: Delete the lock key in the finally block to ensure cleanup even on errors

> "The distributed lock prevents a subtle race: two retries arriving simultaneously could both pass the cache check (empty), then both attempt to insert into PostgreSQL. The UNIQUE constraint on (merchant_id, idempotency_key) would catch the second insert, but by then we may have already called the payment processor. The lock serializes processing for the same idempotency key."

### Idempotency Design Decisions

| Decision | Choice | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Key scope | Per-merchant | Global | Same key from different merchants = different operations |
| Storage | Valkey (24h TTL) | PostgreSQL | Faster lookups, automatic expiry |
| Lock mechanism | Distributed lock | Optimistic locking | Prevents concurrent processing |
| Failure handling | Don't cache failures | Cache all | Allows retry on transient failures |

## Deep Dive: Double-Entry Ledger

### Accounting Principle

Every transaction must have balanced ledger entries (debits = credits):

```
Customer Payment of $100:
┌──────────────────────────────────────────────────────────────┐
│  Account            │  Debit    │  Credit   │  Balance       │
├──────────────────────────────────────────────────────────────┤
│  Customer Card      │  $100.00  │           │  -$100.00      │
│  Merchant Balance   │           │  $97.10   │  +$97.10       │
│  Platform Fee       │           │  $2.90    │  +$2.90        │
└──────────────────────────────────────────────────────────────┘
  Total:                 $100.00     $100.00   (BALANCED)
```

### SQL Implementation

A PostgreSQL stored function `record_payment_capture` takes a transaction ID, amount, and fee as parameters. Within a single invocation it inserts three balanced ledger entries:

1. **Debit** accounts_receivable for the full amount (money coming in from customer)
2. **Credit** merchant_balance for (amount - fee) (money owed to merchant)
3. **Credit** platform_fee for the fee amount (our revenue)

This function is called within the same database transaction as the status update, ensuring that ledger entries and transaction status are always consistent.

### Daily Reconciliation

A reconciliation query groups ledger entries by date and sums debits vs. credits. It uses a HAVING clause to filter for dates where the discrepancy (total debits minus total credits) is non-zero. In a correctly functioning system, this query should return zero rows -- any results indicate a bug that needs immediate investigation.

## Deep Dive: Fraud Detection Service

### Real-Time Risk Scoring

The fraud scoring function evaluates five signals and combines them with weights to produce a score from 0 to 100:

| Signal | Weight | What It Measures |
|--------|--------|-----------------|
| Velocity | 25% | Number of transactions from this card in the past hour |
| Amount anomaly | 20% | Deviation from the card's typical purchase amounts |
| Geography | 20% | Distance between the transaction IP and the billing address |
| Device fingerprint | 15% | Whether the device has been seen before with this card |
| ML model | 20% | A trained model's prediction based on all available features |

The final score is `min(100, weighted sum of all signals)`.

### Decision Thresholds

| Score Range | Action | Rationale |
|-------------|--------|-----------|
| 0-30 | Auto-approve | Low risk, good user experience |
| 30-70 | Approve + log | Monitor for patterns |
| 70-90 | Require 3D Secure | Additional verification |
| 90-100 | Block | High fraud probability |

### Velocity Check with Valkey

The velocity check uses a sliding window implemented with a Redis sorted set. For each card fingerprint, the key `velocity:{cardFingerprint}` stores timestamps as scores:

1. Remove entries older than 1 hour using ZREMRANGEBYSCORE
2. Add the current timestamp with ZADD
3. Count remaining entries with ZCARD
4. Set a 1-hour TTL with EXPIRE

All four commands execute in a single MULTI/EXEC pipeline. The resulting count maps to a score: >10 transactions/hour = 50 (very high velocity), >5 = 30 (high), >2 = 15 (moderate), otherwise 0 (normal).

## Deep Dive: The Authorize/Capture Split

> "Every payment API makes you choose whether 'charge the card' is one operation or two. Splitting it is the decision that shapes the ledger."

**Authorize** places a hold on the customer's card: the funds are reserved and the available credit drops, but no money has moved. **Capture** is what actually pulls it. Between them sits **void**, which releases the hold; after capture, the only way back is a **refund**, which is a new movement of money in the opposite direction rather than an undo.

The reason to split is that the merchant usually doesn't know at authorization time whether they can fulfil. A pre-order authorizes today and captures on dispatch, possibly weeks later. Charging up front and refunding on failure looks equivalent and isn't: the customer's money genuinely left their account, refunds take days to land, and — for the platform — the transaction now carries a fee reversal and shows up in refund-rate metrics that are supposed to measure product problems, not inventory problems.

**Where this lands in the ledger is the important part: only capture writes entries.**

| State | Money moved | Ledger entries | Available actions |
|-------|-------------|----------------|-------------------|
| authorized | No — hold only | None | capture, void |
| captured | Yes | Debit AR, credit merchant (net), credit revenue (fee) | refund |
| voided | No | None, ever | — (terminal) |
| failed | No | None | — (terminal) |
| refunded | Yes, then back | Capture entries plus a mirrored reversal including the fee giveback | — |

> "An authorized payment is a business event with no accounting consequence, and that distinction is exactly what a ledger is for. If authorization wrote entries, the books would show revenue for money the platform doesn't have and may never receive — every abandoned pre-order would need a compensating entry, and the ledger would become a record of intentions rather than of movements. Keeping it to capture means the sum of the ledger is, by construction, money that actually exists."

**What the split costs.** Holds expire — typically 7 days, sometimes less — so a capture attempted too late fails against an authorization the processor has already released, and the merchant has to re-authorize a card that may now decline. That's a state machine with a *timer* in it, and nothing in this implementation currently tracks authorization expiry or sweeps stale holds. It's the most obvious missing piece, and at any real volume it would show up as a slow drip of "capture failed" errors that nobody can reproduce.

## Deep Dive: Isolating an Unreliable Processor

The external processor is the one dependency that is both on the critical path and outside our control, so it gets a circuit breaker rather than a raw call plus a timeout.

| Approach | Behaviour when the processor degrades | Cost |
|----------|---------------------------------------|------|
| ✅ Circuit breaker, fail fast once open | Requests are rejected in microseconds; the connection pool stays free for everything else | Some payments rejected during a blip a longer wait would have survived |
| ❌ Timeout only | Every request waits the full timeout before failing | N concurrent payments hold N connections for the timeout duration — the pool drains and *unrelated* endpoints start failing |
| ❌ Retry immediately on failure | Multiplies load against a processor that is already struggling | Turns a degradation into an outage, and risks double-charging without idempotency |

The failure mode the breaker prevents is not "some payments fail" — payments fail either way when the processor is down. It's the **pool exhaustion** that turns a payments outage into a total one: with a plain timeout, requests pile up holding connections, and login, dashboard reads and webhook writes start failing for a reason that has nothing to do with them. Failing fast keeps the blast radius on the payment path.

> "The trade-off I'd name explicitly is that an open breaker rejects payments the processor might actually have accepted. That's a real cost in revenue. I take it because a fast, honest 'try again' is recoverable — the merchant retries, the customer sees a clear error — whereas a hung request pool is not: it fails invisibly, in a way that looks like our system is broken rather than our processor."

The half-open probe is what keeps this from being a one-way door: after the cooldown, a single request is let through, and success closes the breaker. Recovery therefore costs one request rather than requiring an operator.

**This is also why idempotency and the breaker are designed together.** Fail-fast rejection makes client retries *more* likely, not less — and a retry against a processor that did in fact accept the original charge is exactly how double-charges happen. The idempotency key is what makes the encouraged retry safe.

## API Design

### RESTful Endpoints

```
Authentication: Bearer token (API key)
Rate Limit: 100 requests/minute per merchant

POST   /v1/payments              Create and authorize payment
POST   /v1/payments/:id/capture  Capture authorized payment
POST   /v1/payments/:id/void     Void authorized payment
POST   /v1/payments/:id/refund   Refund captured payment
GET    /v1/payments/:id          Get payment details
GET    /v1/payments              List payments (paginated)

Webhooks:
POST   /v1/webhooks/endpoints    Register webhook URL
GET    /v1/webhooks/deliveries   List webhook delivery attempts

Admin (session auth):
GET    /v1/admin/transactions    Search all transactions
GET    /v1/admin/reconciliation  Daily settlement reports
```

### Request/Response Example

A payment creation request is sent as `POST /v1/payments` with Bearer token authentication and an `Idempotency-Key` header. The JSON body contains: amount (in smallest currency unit, e.g., 5000 = $50.00), currency code, payment method ID, capture flag (true for immediate capture), and optional metadata (e.g., order_id).

The response returns the transaction object with: id, status (e.g., "captured"), amount, currency, captured and refunded amounts, fraud score, processor reference, and timestamp.

## Webhook Delivery System

### Guaranteed Delivery Pattern

The webhook delivery system uses exponential backoff with 5 retry attempts at delays of 1s, 5s, 30s, 2min, and 10min.

**Delivery flow:**

1. Compute an HMAC-SHA256 signature of the payload using the merchant's webhook secret
2. POST the payload to the merchant's registered webhook URL with headers: Content-Type, X-Webhook-ID, and X-Signature (prefixed with `sha256=`)
3. Set a 10-second request timeout to prevent hanging connections
4. If the merchant returns HTTP 2xx, mark the webhook as delivered with a timestamp
5. If the request fails (network error, non-2xx status, timeout), schedule a retry

**Retry scheduling:**

The retry function checks the current attempt count against the retry delays array. If more retries are available, it increments the attempt counter, records the next retry time and last error message, and re-publishes the webhook to the RabbitMQ delivery queue with the appropriate delay. If all retries are exhausted, the webhook is marked as permanently failed.

> "The retry delays are chosen to balance timeliness with recovery time. The first retry at 1 second catches transient network blips. The 10-minute final retry gives merchants time to recover from brief outages. Beyond 5 attempts, we stop retrying -- merchants can query the deliveries endpoint to manually replay missed webhooks."

## Caching Strategy

### Cache Layers

| Data | Storage | TTL | Invalidation |
|------|---------|-----|--------------|
| Merchant config | Valkey | 5 min | On API update |
| Idempotency keys | Valkey | 24 hours | TTL expiry |
| Rate limit counters | Valkey | 1 min sliding | Automatic |
| Exchange rates | Valkey | 5 min | TTL expiry |
| Transaction cache | None | - | Always read from DB |

### Rate Limiting Implementation

The rate limiter uses a sliding window with Redis sorted sets, checking 100 requests per 60-second window per merchant. It executes four Redis commands in a pipeline: remove entries outside the window, add the current request, count entries, and set TTL. If the count exceeds the limit, a RateLimitError is thrown.

## Scalability Considerations

### Horizontal Scaling Path

| Component | Current | Scaled | Strategy |
|-----------|---------|--------|----------|
| API servers | 3 instances | 10+ instances | Stateless, add behind LB |
| PostgreSQL | 1 primary | Primary + 3 replicas | Read replicas for dashboards |
| Valkey | 1 instance | 3-node cluster | HA for distributed locks |
| RabbitMQ | 1 instance | Clustered | Mirrored queues |
| Workers | 2 instances | Auto-scale | Based on queue depth |

### Database Partitioning

Transactions are partitioned by month using PostgreSQL's native range partitioning on the created_at column. Each month gets its own partition (e.g., transactions_2025_01 covers January 2025). Old partitions can be detached and exported to cold storage (S3/MinIO in Parquet format) for long-term regulatory retention, while keeping the active table lean for query performance.

### Connection Pooling

Each API server maintains a pool of 20 PostgreSQL connections with 30-second idle timeout and 5-second connection timeout. With 10 API servers, that's 200 total connections. PostgreSQL's max_connections is set to 300, reserving 100 for admin queries, worker processes, and maintenance tasks.

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| PostgreSQL for ledger | ACID, complex queries | Single write master |
| Valkey for idempotency | Fast, TTL built-in | Additional service |
| Sync fraud check | Immediate blocking | Adds latency (~50ms) |
| Double-entry bookkeeping | Perfect audit trail | Storage overhead |
| RabbitMQ for webhooks | Reliable, DLQ support | Additional complexity |

## Future Backend Enhancements

1. **Event Sourcing**: Store all state changes as immutable events for complete audit trail
2. **Read Replicas**: Route dashboard queries to replicas
3. **Sharding**: Hash-based sharding by merchant_id when transaction volume exceeds single-node capacity
4. **Multi-Region**: Active-passive with PostgreSQL logical replication for disaster recovery
5. **Real-Time Analytics**: ClickHouse for transaction analytics and fraud pattern detection
