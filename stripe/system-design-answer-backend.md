# Stripe - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 🎯 Introduction (2 minutes)

"Thank you for the opportunity. Today I'll design Stripe, a payment processing platform. As a backend engineer, I'm particularly excited about the unique challenges that financial systems present:

1. **Idempotency at scale** - preventing duplicate charges across distributed systems with network failures
2. **Double-entry ledger** - maintaining financial accuracy with ACID guarantees
3. **Circuit breakers** - gracefully handling card network outages
4. **Audit logging** - PCI DSS compliance requires complete transaction trails

Let me clarify the requirements."

---

## ✅ Requirements Clarification (5 minutes)

### Functional Requirements

"For our core payment platform:

1. **Charge**: Process credit card payments through a REST API
2. **Refund**: Return funds to customers with proper ledger entries
3. **Merchants**: Onboard businesses, manage API keys and webhooks
4. **Webhooks**: Notify merchants of payment events with guaranteed delivery
5. **Disputes**: Handle chargebacks from card networks

I'll focus on the payment flow, idempotency, and ledger design since those are the most backend-intensive."

### Non-Functional Requirements

"Financial systems have strict requirements:

- **Latency**: Under 500ms for payment authorization (card network round-trip)
- **Availability**: 99.999% for payment processing (5 nines)
- **Accuracy**: Zero tolerance for financial errors - debits must equal credits
- **Security**: PCI DSS Level 1 compliance, end-to-end encryption

The accuracy requirement is absolute. Unlike social media where losing a post is annoying, losing a payment or creating a duplicate charge destroys trust."

---

## 🏗️ High-Level Design (8 minutes)

### Architecture Overview

```
                              ┌─────────────────────────────┐
                              │      Load Balancer          │
                              │   (Health checks, TLS)      │
                              └─────────────┬───────────────┘
                                            │
                              ┌─────────────▼───────────────┐
                              │       API Gateway           │
                              │  - Rate limiting            │
                              │  - API key auth             │
                              │  - Idempotency middleware   │
                              └─────────────┬───────────────┘
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                                   │                                   │
        ▼                                   ▼                                   ▼
┌───────────────┐                   ┌───────────────┐                   ┌───────────────┐
│Payment Service│                   │ Fraud Service │                   │Webhook Service│
│               │                   │               │                   │               │
│ - Intents API │                   │ - Risk scoring│                   │ - Event queue │
│ - Charges     │                   │ - Velocity    │                   │ - Delivery    │
│ - Refunds     │                   │ - ML models   │                   │ - Retry logic │
│ - Card auth   │                   │ - Rules engine│                   │ - Signatures  │
└───────┬───────┘                   └───────────────┘                   └───────┬───────┘
        │                                                                       │
        │                   ┌─────────────────────────────┐                     │
        └──────────────────►│       Ledger Service        │◄────────────────────┘
                            │  (Double-entry bookkeeping) │
                            └─────────────┬───────────────┘
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        │                                 │                                 │
        ▼                                 ▼                                 ▼
┌───────────────┐                 ┌───────────────┐                 ┌───────────────┐
│  PostgreSQL   │                 │     Redis     │                 │  Card Network │
│               │                 │               │                 │    Gateway    │
│ - Ledger      │                 │ - Idempotency │                 │               │
│ - Merchants   │                 │ - Rate limits │                 │ - Visa        │
│ - Intents     │                 │ - Sessions    │                 │ - Mastercard  │
│ - Audit log   │                 │ - Circuit     │                 │ - Amex        │
└───────────────┘                 └───────────────┘                 └───────────────┘
```

### Database Schema

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| **merchants** | id (UUID PK), name, email (unique), api_key_hash (bcrypt), webhook_url, webhook_secret (HMAC), status, created_at | idx_merchants_api_key (api_key_hash) | API key is hashed; webhook secret used for HMAC signatures |
| **payment_intents** | id (UUID PK), merchant_id (FK), amount (cents), currency (3-char), status (state machine), payment_method_id (FK), auth_code, decline_code, metadata (JSONB), created_at, updated_at | idx_intents_merchant, idx_intents_status, idx_intents_created (DESC) | Status values: requires_payment_method, requires_confirmation, requires_action, processing, succeeded, failed, canceled |
| **payment_methods** | id (UUID PK), customer_id, card_token (encrypted), card_last4, card_brand, card_exp_month/year, card_country, card_bin (for fraud), created_at | PK index | BIN stored for fraud velocity checks |
| **ledger_entries** | id (BIGSERIAL PK), account, debit (>= 0), credit (>= 0), intent_id (FK), description, created_at | idx_ledger_account, idx_ledger_intent, idx_ledger_created | Constraints: amounts non-negative; exactly one of debit/credit must be > 0 (single_direction check). This is the heart of financial accuracy |
| **refunds** | id (UUID PK), payment_intent_id (FK), amount (cents), reason, status, created_at | By payment_intent_id | Tracks partial and full refunds |
| **audit_log** | id (BIGSERIAL PK), timestamp, actor_type (merchant/admin/system), actor_id, action, resource_type, resource_id, old_value (JSONB), new_value (JSONB), ip_address, trace_id, metadata (JSONB) | idx_audit_timestamp, idx_audit_actor (type + id), idx_audit_resource (type + id) | Append-only table - no UPDATE or DELETE allowed. Required for PCI DSS compliance |

---

## 🔑 Deep Dive 1: Idempotency System (10 minutes)

### Why Idempotency is Critical

"In distributed systems with network failures, clients must retry requests. Without idempotency, a retry could duplicate a charge. For a $1000 payment, that's catastrophic.

```
Customer clicks 'Pay' -> Request sent -> Network timeout -> Did charge succeed?
                                                          -> Customer retries
                                                          -> DOUBLE CHARGE!
```

Idempotency keys ensure: 'No matter how many times you call me with this key, the side effect happens exactly once.'"

### Implementation with Redis Locking

The idempotency service manages three concerns: preventing concurrent duplicate requests, caching successful responses, and replaying cached responses on retry.

**Execution flow:**

1. **Acquire lock** - Use Redis SET NX EX to atomically acquire a lock key (`idempotency:{merchantId}:{key}:lock`) with a 60-second TTL. If the lock is not acquired, check for a cached response from a previous attempt. If no cached response exists either, return a 409 conflict telling the client to retry.
2. **Check cache** - Even after acquiring the lock, check for a cached response in case the lock expired and was reacquired by another process.
3. **Execute operation** - Run the actual payment operation.
4. **Cache response** - Store the successful response in Redis with a 24-hour TTL for future replays.
5. **Release lock** - Always release the lock in a finally block, regardless of success or failure.

This guarantees that no matter how many times a client retries with the same idempotency key, the side effect (e.g., charging a card) happens exactly once.

### Express Middleware Integration

The idempotency middleware intercepts requests that include an `Idempotency-Key` header:

1. **Validate the key** - Reject keys longer than 255 characters
2. **Check cache** - Look up `idempotency:{merchantId}:{key}` in Redis. If found, replay the cached response with the original status code, body, and headers, plus an `Idempotency-Replayed: true` header
3. **Acquire lock** - Use SET NX EX with a 60-second TTL. If the lock is not acquired (another request with the same key is in progress), return 409 Conflict
4. **Capture response** - Override the response's JSON method to intercept the outgoing body. For successful responses (2xx), cache the status code, body, and headers in Redis with a 24-hour TTL
5. **Release lock** - Delete the lock key after the response is sent or on error

Requests without an idempotency key pass through normally (for GET requests, etc.).

---

## 📒 Deep Dive 2: Double-Entry Ledger (10 minutes)

### Why Double-Entry Accounting?

"In double-entry accounting, every transaction creates entries that sum to zero. This provides built-in error detection - if debits don't equal credits, something is wrong.

```
For a $100.00 charge with 2.9% + $0.30 fee:
Fee = $100 * 0.029 + $0.30 = $3.20

Ledger entries:
  DEBIT  funds_receivable    $100.00  (We'll receive from card network)
  CREDIT merchant:xyz:payable  $96.80  (We owe the merchant)
  CREDIT revenue:fees          $3.20   (Our revenue)

  Sum: $100 - $96.80 - $3.20 = $0.00 ✓
```"

### Ledger Service Implementation

The ledger service enforces double-entry bookkeeping invariants:

**Charge entries** (for a payment of amount A with 2.9% + 30c fee):

| Account | Debit | Credit | Description |
|---------|-------|--------|-------------|
| funds_receivable | A | 0 | Card network receivable |
| merchant:{id}:payable | 0 | A - fee | Merchant payout pending |
| revenue:transaction_fees | 0 | fee | Transaction fee revenue |

Before inserting, the service programmatically verifies that total debits equal total credits. If they don't match, a LedgerImbalanceError is thrown and no entries are written. All entries for a single charge are inserted atomically within a database transaction.

**Refund entries** reverse the original charge with debits and credits swapped: credit funds_receivable, debit the merchant payable, and debit the fee revenue. The same balance verification runs before insertion.

**Account balance query**: The balance for any account is computed as SUM(debit) - SUM(credit) across all ledger entries for that account.

**Integrity verification** (run daily): Query the global SUM of all debits and all credits across the entire ledger. If they don't match, trigger a FATAL alert immediately - this indicates a critical data integrity issue.

---

## ⚡ Deep Dive 3: Circuit Breaker for Card Networks (5 minutes)

### Protecting Against Card Network Outages

"Payment systems depend on external card networks that can fail. Without circuit breakers, slowdowns cascade:

```
Card Network Slow -> All requests queue -> Thread pool exhausted
                  -> Database connections exhaust -> Entire API down
```"

### Implementation

The circuit breaker implements a three-state machine: CLOSED (normal), OPEN (failing fast), and HALF_OPEN (testing recovery).

**State transitions:**

- **CLOSED to OPEN**: After 5 consecutive failures, the breaker opens and records the timestamp. All subsequent calls fail immediately without contacting the card network, preventing cascade failures.
- **OPEN to HALF_OPEN**: After 30 seconds (the reset timeout), the breaker allows a single test request through.
- **HALF_OPEN to CLOSED**: After 3 consecutive successes in the half-open state, the breaker resets to closed.
- **HALF_OPEN to OPEN**: Any failure in half-open immediately reopens the breaker.

Each call includes a 10-second timeout using Promise.race - if the card network doesn't respond within 10 seconds, it counts as a failure.

**Per-network isolation**: We maintain separate circuit breaker instances for each card network (Visa, Mastercard, Amex). This way, if Visa's network is experiencing issues, Mastercard and Amex payments continue processing normally. The card network is determined from the card's BIN (first 6 digits).

---

## 🔔 Deep Dive 4: Webhook Delivery System (5 minutes)

### Guaranteed Delivery with Retry

The webhook service handles event delivery with guaranteed at-least-once semantics:

**Event creation:**
1. Build the event payload with a unique ID (`evt_{uuid}`), event type, data, timestamp, and API version
2. Generate an HMAC-SHA256 signature over `{timestamp}.{event_json}` using the merchant's webhook secret
3. Enqueue the delivery job with 5 retry attempts and exponential backoff (1s, 2s, 4s, 8s, 16s)
4. Record the delivery attempt in the database for audit tracking

**Delivery worker:**
1. POST the event JSON to the merchant's webhook URL with headers including Content-Type, the Stripe-Signature (format: `t={timestamp},v1={signature}`), and User-Agent
2. Apply a 30-second timeout using an AbortController
3. On success (2xx response), update delivery status to "delivered" with timestamp
4. On failure (non-2xx, timeout, or network error), update the failure status and error message, then re-throw to let the queue handle retry with backoff

This ensures merchants eventually receive every event, even if their endpoint is temporarily unavailable.

---

## 🛡️ Failure Handling and Reconciliation (6 minutes)

Everything above describes the happy path and the retry path. The case that
actually defines a payments system is the one where we don't know what happened.

### The in-doubt transaction

We send an authorization to the card network and the connection times out. The
network may have authorized the card and lost the response, or never received
the request at all. We cannot tell the difference, and the two outcomes differ
by real money on a real cardholder's statement.

```
   our side                          card network
   ────────                          ────────────
   authorize ─────────────────────▶  [ authorized? ]
        │                                   │
        │        ✗ timeout / reset          │
        ◀───────── (no response) ───────────┘

   state = requires_action, NOT failed
        │
        ├──▶ retry with the SAME network reference
        │      network replies "already authorized" → adopt that result
        │
        └──▶ no answer after N attempts → mark for reconciliation,
               settle against the network's daily file
```

> "The wrong move here is to treat a timeout as a decline. If the network did
> authorize, the customer has a hold on their funds, and telling them the
> payment failed invites them to try again — now you've authorized twice.
> Equally wrong is treating it as a success, because you'd be shipping goods
> against money that may not exist. So a timeout gets its own state. The
> payment is neither succeeded nor failed; it's *unresolved*, and it stays that
> way until something authoritative resolves it."

Retries carry the same network-level reference we sent originally, which is what
lets the network recognize the retry as the same authorization rather than a new
one. This is the same idempotency principle as our own API keys, applied one hop
downstream — and it's why the reference has to be generated and persisted
*before* the first attempt, not derived from the response.

### Reconciliation is the backstop, not the exception

Networks publish a settlement file on a daily cycle. That file is the
authoritative record, and reconciliation compares it against our ledger:

| Discrepancy | Meaning | Resolution |
|-------------|---------|------------|
| In our ledger, not in the file | We recorded an authorization the network never took | Reverse the ledger entries; the customer was never charged |
| In the file, not in our ledger | A timed-out request did authorize | Write the missing entries; the money is real |
| Amounts differ | Partial capture, or an FX or fee adjustment | Post an adjusting entry; never edit the original |

The key discipline is the last one: **ledger entries are append-only**. A wrong
entry is corrected by a compensating entry, not an `UPDATE`. That's what keeps
the audit trail truthful — an auditor can see that we got it wrong and when we
fixed it, which is exactly what an overwrite destroys.

### Failure matrix

| Failure | Behavior | Money at risk? |
|---------|----------|----------------|
| **Redis (idempotency) down** | Fail closed — reject new payments rather than process without duplicate protection | No, but availability drops |
| **PostgreSQL down** | Reject; nothing can be authorized without a durable ledger write | No |
| **Card network down** | Circuit breaker opens, fail fast with a retryable error | No |
| **Network timeout mid-auth** | `requires_action`, retry with the same reference, then reconcile | Yes — this is the dangerous one |
| **Webhook endpoint down** | Queue retries with exponential backoff; events survive in the queue | No |
| **Process crash after auth, before ledger write** | Reconciliation catches it against the settlement file | Yes, until the daily cycle |

> "Note that Redis being down fails *closed*. That's unusual — a cache outage
> normally means degraded performance, not rejected requests. Here the
> idempotency store isn't a cache, it's a correctness mechanism, and processing
> payments without it means a client retry becomes a second charge. Rejecting
> the payment costs a lost sale; processing it costs a duplicate charge, a
> chargeback, and a customer who no longer trusts the merchant. Refusing to
> operate is the cheaper failure."

The theme across all of these: for a payments system, **losing availability is
recoverable and losing correctness is not**. Every one of these choices spends
uptime to protect the ledger.

---


## ⚖️ Trade-offs Summary (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| **Idempotency store** | Redis with locking | PostgreSQL UPSERT | Sub-ms latency, automatic TTL expiration |
| **Ledger database** | PostgreSQL | Event sourcing | ACID guarantees essential for financial data |
| **Ledger format** | Double-entry | Single-entry | Built-in error detection, audit trail |
| **Webhook queue** | BullMQ (Redis) | RabbitMQ | Simpler setup, built-in exponential backoff |
| **Circuit breaker** | Per-network | Global | Isolate failures to specific card networks |
| **Card storage** | Tokenization | Direct encryption | PCI scope reduction |

---

## 🧮 Capacity Planning

### Traffic Estimates

| Metric | Value | Notes |
|--------|-------|-------|
| Peak payment RPS | 50 req/s | Busy checkout period |
| Sustained RPS | 10 req/s | Normal hours |
| Daily transactions | 1.44M | 50 RPS x 8 peak hours |
| Ledger entries/day | 4.32M | 3 entries per transaction |

### Redis Sizing

```
Idempotency keys: 50 RPS x 86400 sec = 4.32M keys/day
Key size: ~200 bytes (key + cached response)
Peak memory: ~1 GB (with 24h TTL, keys expire)
```

### PostgreSQL Sizing

```
Ledger storage growth: ~500 MB/day (with indexes)
Connection pool: 10 connections per instance
Vacuum: Daily at 3 AM for ledger_entries table
```

---

## 🚀 Future Enhancements

1. **Multi-currency support**: FX rate service, settlement in local currency
2. **3D Secure flow**: Redirect-based authentication for high-risk payments
3. **Settlement batching**: Daily payout processing with reconciliation
4. **Dispute handling**: Full chargeback lifecycle with evidence submission
5. **Sharding**: Merchant-based partitioning for horizontal scale
6. **Read replicas**: Separate read path for dashboard queries

---

## 📌 Summary

"I've designed Stripe's backend with:

1. **Idempotency middleware** with Redis locking to prevent duplicate charges
2. **Double-entry ledger** in PostgreSQL with balance invariant checking
3. **Circuit breakers** per card network to prevent cascade failures
4. **Webhook delivery** with BullMQ, exponential backoff, and HMAC signatures
5. **Audit logging** for PCI DSS compliance

The design prioritizes financial accuracy above all else - every cent is tracked, every operation is idempotent, and the ledger always balances."
