# PayPal - System Design Answer (Backend Focus)

## 🎯 Problem Statement

> "Design a peer-to-peer payment platform like PayPal where users can send money to each other, request payments, and manage digital wallets."

I'd approach this as a financial system where **correctness beats performance** -- we can never lose money or double-charge a user. The three hardest problems are: (1) ensuring transfer atomicity with double-entry bookkeeping, (2) preventing double-spending under concurrent access, and (3) making payments safely retryable through idempotency.

## 📋 Requirements Clarification

Before diving in, I'd confirm scope with the interviewer:

**Functional:**
- Users register, link payment methods, and hold a wallet balance
- Send money P2P (instant transfers between wallets)
- Request money from other users (pending until paid/declined)
- Deposit/withdraw between wallet and linked payment methods
- View transaction history with filtering

**Non-Functional:**
- Strong consistency for all money movement -- no eventual consistency for balances
- 99.99% availability for payment processing
- p99 < 500ms for transfers, p99 < 200ms for balance reads
- Every payment operation must be idempotent
- Full audit trail for compliance and dispute resolution

**Scale Assumptions:**
- 50M registered users, 5M DAU
- 10M transactions/day (~115 TPS average, 500 TPS peak)
- Average transaction: $45, total daily volume: $450M

## 🏗️ High-Level Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐
│              │     │              │     │   Payment Service    │
│   Clients    │────▶│   API GW     │────▶│                      │
│  (Web/Mobile)│     │  + Auth      │     │  Transfer Engine     │
│              │     │  + Rate Limit│     │  Wallet Service      │
└──────────────┘     └──────────────┘     │  Idempotency Svc     │
                                          └──────────┬───────────┘
                                                     │
                          ┌──────────────────────────┼────────────────┐
                          │                          │                │
                          ▼                          ▼                ▼
                ┌──────────────────┐       ┌──────────────┐  ┌──────────────┐
                │   PostgreSQL     │       │    Redis      │  │    Kafka     │
                │  (Primary store) │       │  (Sessions,   │  │ (Events,     │
                │  Users, Wallets, │       │   Cache)      │  │  Notifs)     │
                │  Txns, Ledger    │       │               │  │              │
                └──────────────────┘       └──────────────┘  └──────────────┘
```

> "I'm putting PostgreSQL at the center because financial transactions demand ACID guarantees. Redis handles sessions and caching. Kafka decouples notification and analytics from the critical payment path -- we never want a slow email service to block a transfer."

## 💾 Data Model

### Core Tables

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), username (unique), email (unique), password_hash, role | email, username | One wallet per user |
| wallets | id (UUID PK), user_id (FK unique), balance_cents (BIGINT), account_type, version | user_id | Optimistic locking via version; one 'platform_cash' account |
| transactions | id (UUID PK), sender_id (FK), recipient_id (FK), amount_cents, type, status, payment_method_id | (sender_id, created_at DESC), (recipient_id, created_at DESC) | Type: transfer/deposit/withdrawal |
| ledger_entries | id (UUID PK), transaction_id (FK), wallet_id (FK), entry_type, amount_cents, balance_after_cents | (wallet_id, created_at DESC) | entry_type: debit or credit |
| transfer_requests | id (UUID PK), requester_id (FK), payer_id (FK), amount_cents, status, transaction_id | (payer_id, status), requester_id | Paid requests point at the transfer that settled them |
| idempotency_keys | (user_id, key) PK, request_hash, response (JSONB), expires_at | expires_at | Scoped per user, 24-hour TTL, cleaned hourly |
| payment_methods | id (UUID PK), user_id (FK), type, label, last_four, is_default | user_id | Type: bank or card |

> "I store amounts as BIGINT cents, not DECIMAL. This eliminates floating-point rounding errors in application code -- $10.50 is stored as 1050. The CHECK constraint `balance_cents >= 0` prevents negative balances at the database level, which is our last line of defense against bugs in application logic."

### Why a Separate Ledger Table?

The `transactions` table records the business event ("Alice sent $50 to Bob"). The `ledger_entries` table records the accounting impact ("Alice's wallet was debited $50; Bob's wallet was credited $50"). This separation enables:

- **Reconciliation**: SUM of all credits minus debits for a wallet should equal `wallet.balance_cents`. If they disagree, we know something went wrong and can investigate the specific divergent entries.
- **Audit trail**: Every balance change is traceable to a specific ledger entry with a timestamp and the balance snapshot after the change.
- **Extensibility**: Multi-currency support, fees, and refunds each become additional ledger entries without changing the core transfer logic. A transfer with a 2.9% fee would create three entries: debit sender, credit recipient, credit platform (fee).

### Wallet Version Column

The `version` integer on wallets is the key to optimistic concurrency control. Every read captures the current version. Every write includes `WHERE version = $capturedVersion` and increments it. If the version changed between read and write, zero rows are updated, signaling a concurrent modification.

## 🔧 Deep Dive 1: Consistency in Money Transfers

This is the hardest problem in the system. A P2P transfer must atomically:
1. Verify sender has sufficient funds
2. Debit sender's wallet
3. Credit recipient's wallet
4. Create the transaction record
5. Create two ledger entries (debit + credit)

If any step fails, none should persist.

**The double-entry bookkeeping pattern:**

For every transfer, we create exactly two ledger entries within a single database transaction. The debit entry records the amount leaving the sender's wallet. The credit entry records the amount entering the recipient's wallet. Both reference the same transaction_id. The sum of all debits in the system must equal the sum of all credits -- if they diverge, we have a bug.

This invariant is powerful. We can write a reconciliation query that runs periodically: for each wallet, compare `wallet.balance_cents` against `SUM(credit entries) - SUM(debit entries)`. Any mismatch triggers an alert. In traditional single-entry systems, there's no such verification mechanism -- you just trust the balance column.

**Preventing double-spending with optimistic locking:**

Each wallet has a `version` column. When we update a balance, the UPDATE includes `WHERE version = $expectedVersion`. If another concurrent transaction has already modified this wallet, our UPDATE affects zero rows, and we detect the conflict immediately.

> "I chose optimistic locking over pessimistic locking because P2P payments have relatively low contention per wallet -- a single user doesn't send hundreds of payments per second. With pessimistic locks (`SELECT ... FOR UPDATE`), we'd hold row-level locks for the entire transaction duration, reducing throughput when multiple transfers touch the same wallet. Optimistic locking lets reads proceed in parallel and only fails at write time. The trade-off: we must handle version conflicts with retries. But conflict rates are low enough (< 0.1% for typical users) that retry overhead is negligible."

**Deadlock prevention:**

When locking both sender and recipient wallets, we always lock in user_id order. Without consistent lock ordering, two simultaneous transfers (Alice-to-Bob and Bob-to-Alice) could deadlock -- each holding one lock and waiting for the other. By sorting the user IDs and locking in ascending order, we guarantee at least one transaction makes progress.

**The complete transfer algorithm:**

1. BEGIN transaction
2. Claim the idempotency key: insert (sender, key, hash of the request). If the row already exists, replay its stored response when the hash matches, or reject with 422 when it doesn't
3. Lock both wallets (ordered by user_id) with SELECT ... FOR UPDATE
4. Verify sender balance >= amount
5. UPDATE sender wallet: decrement balance in SQL, increment version
6. UPDATE recipient wallet: increment balance in SQL, increment version
7. INSERT transaction record
8. INSERT debit ledger entry (sender wallet, amount, new balance after)
9. INSERT credit ledger entry (recipient wallet, amount, new balance after)
10. Write the serialized response onto the claimed key
11. COMMIT

If any step fails, ROLLBACK undoes everything, the key included, so a failed payment can be retried cleanly.

> "The order of steps 1 and 2 is the subtle part. An earlier version checked for the key *before* opening the transaction and stored it at the end. Two retries arriving together both saw 'no key', both moved money, and the second only failed afterwards on a unique index -- with a 500 instead of the original response. Claiming the key first, inside the transaction, turns the primary key into a lock: the duplicate blocks on it until the first commits, then reads and replays the stored result. Keys are scoped per user, so one customer's key can never return another customer's receipt."

**Why not use database triggers?**

We could use PostgreSQL triggers to auto-create ledger entries on wallet balance changes. But explicit ledger creation in application code is preferable for three reasons: (1) triggers are invisible and hard to debug, (2) the application needs the ledger entry IDs for the API response, and (3) different transaction types (transfer vs deposit vs refund) need different ledger metadata.

## 🔧 Deep Dive 2: Scaling the Ledger

At 10M transactions/day, the ledger_entries table grows by 20M rows/day (two entries per transfer, plus deposits and withdrawals). In a year, that's ~7.3B rows. Query performance degrades rapidly without a scaling strategy.

**Partitioning strategy:**

Range-partition `ledger_entries` and `transactions` by `created_at` (monthly partitions). Recent queries hit only the current partition. Historical queries for compliance scan specific month partitions. PostgreSQL's partition pruning ensures the query planner only touches relevant partitions.

Monthly partitions at our scale would contain ~600M ledger entries each. This is manageable for PostgreSQL -- each partition is essentially an independent table with its own indexes. Creating new partitions can be automated with pg_partman.

**Read replica separation:**

Balance queries and transaction history go to read replicas. The primary handles only writes (transfers, deposits, withdrawals). Since we're using session-level consistency (the user sees their own balance after their own transfer), we need the application to route post-write reads to the primary for a short window (~1 second) before falling back to replicas.

This "read-your-own-writes" pattern is implemented with a per-user timestamp cache in Redis. After a write, we store `user_id -> last_write_timestamp` in Redis with a 2-second TTL. Read queries check this cache; if the entry exists, they hit the primary instead of a replica.

| Approach | Pros | Cons |
|----------|------|------|
| Partitioned PostgreSQL | Strong consistency, familiar tooling, partition pruning | Schema complexity, partition management overhead |
| ❌ Separate OLAP database | Fast analytics, no impact on OLTP | Sync delay, eventual consistency for ledger queries |

> "I'd start with partitioned PostgreSQL because ledger queries need to be consistent with the current balance. If analytics workloads grow, I'd add a Kafka-based pipeline to replicate ledger events into ClickHouse for dashboards and fraud analysis, while keeping the source-of-truth ledger in PostgreSQL."

**Archival:**

Ledger entries older than 7 years (regulatory requirement) can be moved to cold storage (S3 in Parquet format) with an index in a metadata table. The application checks cold storage if a query spans beyond the active partition range. This keeps the active dataset manageable while maintaining compliance with financial record retention requirements.

**Index strategy at scale:**

The composite indexes `(sender_id, created_at DESC)` and `(recipient_id, created_at DESC)` on transactions are critical. Without them, a user's transaction history query would scan the entire table. With partitioning, these indexes exist per-partition, keeping each index tree small enough for efficient B-tree traversal.

For the ledger, `(wallet_id, created_at DESC)` enables efficient balance reconstruction and statement generation. We also maintain a GIN index on the idempotency_keys response column for operational debugging.

## 🔧 Deep Dive 3: Fraud Detection Considerations

While we're not building a full fraud system, the architecture must support it:

**Velocity checks:** Before executing a transfer, check recent activity:
- Number of transfers in the last hour from this sender
- Total amount sent in the last 24 hours
- Transfers to new recipients (first-time contact)
- Geographic anomalies (transfer from unusual IP)

These checks query Redis counters (incremented on each transfer) rather than the database, keeping latency low. Redis INCR with TTL gives us sliding window counters with minimal overhead.

**Risk scoring:** Each transfer can be scored based on:
- Amount relative to user's typical transaction size (a $5,000 transfer from a user whose average is $30 is suspicious)
- Time of day (unusual hours increase risk)
- Device fingerprint and IP geolocation changes
- Account age and verification level
- Recipient account characteristics (new accounts, high inflow from many users)

High-risk transactions are held for manual review rather than rejected outright. The transaction is created with `status = 'pending_review'` and a background worker processes the review queue. This avoids blocking legitimate large transfers while catching actual fraud.

| Approach | Pros | Cons |
|----------|------|------|
| Synchronous risk check | Blocks fraudulent transfers immediately | Adds latency to every transfer |
| ❌ Asynchronous risk check | Zero latency impact | Fraud detected after money moves |

> "I'd use synchronous checks with a strict latency budget (< 50ms). Redis-based velocity counters and a pre-computed risk model can evaluate within 10ms. If the risk service is down, the circuit breaker falls back to allowing the transfer (fail-open for availability) while logging for retroactive review. For a payment platform, blocking legitimate users is worse than catching fraud slightly later -- most fraud losses can be recovered through chargebacks."

**Chargeback handling:**

When a fraudulent transfer is identified after completion, the system needs a reversal flow. This creates a new transaction of type 'reversal' with its own double-entry ledger entries -- credit the victim's wallet, debit the fraudster's wallet (or a platform loss account if the fraudster's balance is zero). The original transaction's status is updated to 'reversed' for audit trail purposes.

## 📊 API Design

```
POST /api/auth/register         Create account + wallet
POST /api/auth/login            Session-based login
POST /api/auth/logout           Destroy session

GET  /api/wallet                Get wallet balance
POST /api/wallet/deposit        Add funds to wallet
POST /api/wallet/withdraw       Remove funds from wallet

POST /api/transfers             Send money (with idempotency key)
GET  /api/transfers             Transaction history (filterable by type)

POST /api/requests              Request money from user
GET  /api/requests              List pending/all requests
POST /api/requests/:id/pay      Fulfill a money request
POST /api/requests/:id/decline  Decline or cancel

GET    /api/payment-methods     List linked methods
POST   /api/payment-methods     Link new bank/card
DELETE /api/payment-methods/:id Unlink method

GET /api/users/search?q=        Find users by name/email
```

> "Every money endpoint -- transfer, deposit, withdrawal -- takes an `Idempotency-Key` header. A retry with the same key and the same body gets the original response back, marked as a replay; the same key with a different amount gets a 422 rather than an unrelated receipt. This is critical for mobile clients that retry on network timeouts -- without it, a user could accidentally send $50 twice."

**Registration creates a wallet atomically:**

When a user registers, the backend creates both the user record and their wallet within a single database transaction. This ensures every user has exactly one wallet from the moment they join. No orphaned users, no wallets without users.

**Request lifecycle:**

The money request flow uses a simple state machine. A request is created as 'pending'. The payer can pay it (which triggers a full transfer through the transfer engine) or decline it. The requester can cancel their own request. Once a request transitions out of 'pending', it's immutable -- no further state changes allowed.

```
pending ──▶ paid       (payer pays -- triggers transfer)
pending ──▶ declined   (payer declines)
pending ──▶ cancelled  (requester cancels)
```

**Transfer request paying flow:**

When a payer pays a request, the backend runs one database transaction:
1. Locks the request row with SELECT ... FOR UPDATE
2. Returns 404 if the caller is neither party (outsiders can't learn the request exists), 403 if they're the requester, 409 if it's no longer 'pending'
3. Runs the transfer engine on the same connection
4. Marks the request 'paid' and records the transfer's ID on it
5. COMMIT

> "The row lock is what makes a double-tap safe. Without it, two Pay requests both read 'pending' and both run a transfer -- the payer is charged twice. With it, the second request waits, then sees 'paid' and gets a 409 without touching any wallet. Decline and cancel take the same lock, so Pay racing Decline also resolves to exactly one outcome. Because the status change and the money move commit together, there's no window where money moved but the request still says pending."

**User search for send/request:**

The search endpoint matches username and display name by substring (with LIKE wildcards escaped), but email only by the exact address, and it never returns emails. Substring email search would let any signed-in user page through everyone's address. Results are limited to 10 and exclude the current user and the platform's own bookkeeping account.

## 📈 Observability

- **Prometheus metrics**: Transfer duration histogram (with completed/failed labels), wallet operation counters by type (deposit/withdraw/transfer), idempotency cache hit counter, HTTP request duration/count
- **Structured logging**: Pino JSON logger with transaction IDs, user IDs, and amounts for every financial operation. Error logs include full stack traces.
- **Health check**: `/api/health` tests PostgreSQL connectivity, returns 503 if unreachable
- **Circuit breaker**: Opossum-based breaker for any external service calls. Logs state transitions (open/half-open/close) for operational awareness.
- **Reconciliation job**: Periodic check comparing wallet balances against ledger entry sums. Alerts on any divergence.

## 🔐 Security

- Passwords hashed with bcrypt (cost factor 10) -- chosen over Argon2 for library maturity and well-understood security properties
- Session-based authentication with Redis-backed session store (HTTP-only, sameSite cookies)
- Rate limiting: 50 auth attempts/15min, 30 transfers/min per user, 1000 general API calls/15min
- Amount validation: positive integers only, configurable maximum per transaction ($50,000 for transfers, $10,000 for deposits)
- Authorization: only the payer can pay a request, only the requester or payer can cancel/decline
- Database constraint: `CHECK (balance_cents >= 0)` prevents negative balances even if application logic has bugs
- Input sanitization: all user-provided text (notes, labels) is parameterized in SQL queries to prevent injection
- Session expiration: 24-hour TTL with automatic Redis cleanup

| Approach | Pros | Cons |
|----------|------|------|
| Session-based auth (HTTP-only cookies) | XSS-proof, immediate revocation, server-controlled | Requires Redis, not stateless |
| ❌ JWT in localStorage | Stateless, no Redis needed | XSS-vulnerable, no immediate revocation, token bloat |

> "For a financial application, the ability to immediately revoke sessions is non-negotiable. If a user reports their account compromised, we delete their Redis session keys and they're logged out everywhere instantly. With JWT, we'd need a token blacklist -- which is effectively a session store, negating the statelessness benefit."

## 🔄 Failure Handling

**Database transaction failures:** Every financial operation is wrapped in a PostgreSQL transaction. On any error, ROLLBACK ensures no partial updates persist. The application catches the error, logs it with full context (user ID, amount, counterparty), and returns an appropriate HTTP status.

**Connection pool exhaustion:** The pg Pool is configured with max 20 connections and a 5-second connection timeout. If all connections are in use, new requests queue for up to 5 seconds before failing. The pool emits error events that we log for monitoring.

**Redis unavailability:** Since Redis stores sessions, a Redis outage prevents authentication. The circuit breaker detects repeated failures and opens, returning 503 immediately instead of waiting for timeouts. When Redis recovers, the half-open state allows test requests through.

**Idempotency key cleanup:** Expired keys (>24 hours) are cleaned by a periodic background task. Without cleanup, the idempotency_keys table would grow indefinitely. The cleanup query uses the `idx_idempotency_expires` index for efficient deletion.

**Graceful shutdown:** SIGTERM and SIGINT handlers close the HTTP server (stop accepting new connections), wait for in-flight requests to complete, then close database and Redis connections. This prevents data corruption during deployments.

## 📈 Scalability Path

**Phase 1 (Current):** Single PostgreSQL, single API server, Redis for sessions. Handles ~100 TPS.

**Phase 2 (1M users):** Read replicas for balance/history queries. Horizontal API scaling behind load balancer (stateless with Redis sessions). Kafka for event-driven notifications. Handles ~1,000 TPS.

**Phase 3 (50M users):** Partition transactions/ledger by date. Wallet sharding by user_id hash across multiple PostgreSQL clusters. Dedicated fraud service with ML pipeline. Multi-region deployment with regional PostgreSQL clusters. Handles ~10,000 TPS.

**Phase 4 (500M users):** Multi-currency support with exchange rate service. Merchant payment API. Compliance engine for cross-border transfers. Real-time fraud ML pipeline consuming from Kafka streams. CQRS pattern with separate read/write databases. Handles ~100,000 TPS.

**What breaks first:**

The first bottleneck is the single PostgreSQL instance. At ~500 TPS, write contention on the wallets table becomes noticeable. The solution is read replicas first (offloading balance queries and history reads), then wallet sharding (distributing writes across multiple database instances based on user_id hash).

The second bottleneck is the idempotency_keys table. Every transfer writes to it, and every transfer checks it. The check is a primary key lookup (fast), but the cleanup of expired keys creates write amplification. Moving to a TTL-based cache (Redis) for the hot path while keeping PostgreSQL as the authoritative store reduces this pressure.

The third bottleneck is transaction history queries. The `OR` clause (`sender_id = $1 OR recipient_id = $1`) prevents the query planner from using a single index efficiently. At scale, we'd split this into two queries (one for sent, one for received) and merge the results in the application layer, or maintain a denormalized activity feed table indexed by `user_id`.

**Cross-shard transfers:**

When sender and recipient are on different database shards, we need a two-phase commit or saga pattern. The coordinator service debit the sender on shard A, then credits the recipient on shard B. If the credit fails, a compensating transaction re-credits the sender. This adds complexity but is necessary at extreme scale. For Phase 2-3, keeping frequently-transacting user pairs on the same shard (via consistent hashing with social graph awareness) minimizes cross-shard transfers.

## 🗂️ Capacity Estimation

**Storage:**
- Transactions: 10M/day * 200 bytes/row = 2 GB/day, 730 GB/year
- Ledger entries: 20M/day * 150 bytes/row = 3 GB/day, 1.1 TB/year
- Wallets: 50M users * 100 bytes = 5 GB (static)
- Idempotency keys: 10M/day, cleaned after 24h = ~200 MB active

**Network:**
- Balance queries: 15M/day (3x per DAU) * 200 bytes = 3 GB/day
- Transfer requests: 10M/day * 500 bytes = 5 GB/day
- Total API throughput: ~10 GB/day, easily handled by a single load balancer

**Database connections:**
- 20 connections per API server * 3 servers = 60 connections to PostgreSQL
- PostgreSQL default max_connections is 100, sufficient for Phase 1-2
- Phase 3+ uses PgBouncer for connection pooling across multiple API servers

## 💰 Deposits and Withdrawals Need a Counterparty

A transfer debits one wallet and credits another, so its entries sum to zero. A deposit has no internal counterparty -- money arrives from a bank we don't control. Posting it as a lone credit is tempting, and an earlier version did exactly that, but then "every transaction nets to zero" is false and the books can't prove that money only enters through real deposits.

So the platform has its own **cash account**: a wallet row that represents the money we hold at our bank. A deposit debits platform cash and credits the customer; a withdrawal does the reverse. Customer wallets are credit-normal (balance = credits − debits) because they are what we owe; platform cash is debit-normal (balance = debits − credits) because it is what we hold. That gives three invariants an admin reconciliation report checks in one snapshot:

| Invariant | What a violation means |
|-----------|------------------------|
| Every transaction's entries net to zero | A code path wrote half a posting |
| Each wallet's balance equals its ledger | A balance was updated without an entry |
| Sum of customer balances = platform cash | Money was created or destroyed inside the system |

> "The third invariant is the one that matters to finance: it's the number you reconcile against the bank statement. The cost is a hot row -- every deposit and withdrawal updates platform cash. I take that lock last, with an atomic increment, so it's held only for the tail of the transaction, and transfers never touch it. At production volume I'd split it into N sub-accounts chosen at random and sum them in the report."

The status field matters more here too. An internal transfer is atomic: it committed or it didn't. A withdrawal sits `pending` until an external system confirms, so the API has to expose a state that isn't yet final, and the client has to render it as such rather than optimistically showing the money as gone.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Bookkeeping | Double-entry ledger | Direct balance updates | Audit trail, reconciliation, extensibility |
| Concurrency | Optimistic locking | Pessimistic row locks | Lower contention for P2P workloads |
| Amount storage | BIGINT cents | DECIMAL | Eliminates floating-point errors in app code |
| Idempotency storage | Same DB transaction | Redis cache | Atomicity with payment -- can't have key without payment |
| Event processing | Kafka (async) | Synchronous webhook | Decouples notifications from payment path |
| Fraud checks | Synchronous with budget | Async post-transfer | Blocks fraud before money moves |
| Session management | Redis sessions | JWT tokens | Immediate revocation for financial app |

## 📝 Key Takeaways

This is a system where **correctness is the feature**. Users trust PayPal because their money is handled reliably. Every architectural decision -- double-entry bookkeeping, optimistic locking, idempotency keys in the same transaction, database-level balance constraints -- serves that trust. The trade-off is operational complexity: we're running more database operations per transfer than a naive implementation, maintaining a ledger table that doubles our write volume, and storing idempotency keys that need periodic cleanup. But for a financial system, this complexity is the cost of correctness, and it's worth paying.
