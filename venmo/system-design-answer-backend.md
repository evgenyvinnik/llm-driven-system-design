# Design Venmo - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thank you for having me. Today I'll design Venmo, a peer-to-peer payment platform with social features. From a backend perspective, the core challenges are:

1. **Balance Consistency**: Preventing negative balances and double-spends with atomic transactions
2. **Funding Waterfall**: Automatically selecting the best payment source (balance, bank, card)
3. **Social Feed Scalability**: Fan-out-on-write architecture for millions of users
4. **External API Integration**: Circuit breakers and idempotency for bank/card network calls

I'll focus on the database design, transaction handling, and the distributed systems patterns that make a payment platform reliable."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our core product:

1. **Send Money**: Transfer funds to another user instantly with atomic balance updates
2. **Request Money**: Create payment requests with notification flow
3. **Social Feed**: Transaction feed with privacy controls (public/friends/private)
4. **Wallet Balance**: Maintain accurate balance with multi-source funding
5. **Cashout**: Transfer to bank account (instant via push-to-card, standard via ACH)

I'll focus on the wallet consistency and feed generation since those are the most backend-intensive."

### Non-Functional Requirements

"Key constraints:

- **Transfer Latency**: Under 500ms for P2P transfers
- **Balance Consistency**: ACID guarantees - no negative balances, no double-spends
- **Availability**: 99.99% for transfers
- **Scale**: 80+ million users, high volume on weekends

The consistency requirement is absolute. Unlike social features where eventual consistency works, financial balances must be immediately consistent."

---

## High-Level Architecture (5 minutes)

```
                        ┌─────────────────────────────┐
                        │        API Gateway          │
                        │   (Rate Limiting, Auth)     │
                        └──────────────┬──────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        ▼                              ▼                              ▼
┌───────────────┐            ┌───────────────┐            ┌───────────────┐
│   Transfer    │            │     Feed      │            │    Wallet     │
│   Service     │◄──────────►│   Service     │            │   Service     │
│               │            │               │            │               │
│ - Send/Request│            │ - Timeline    │            │ - Balance     │
│ - Idempotency │            │ - Fan-out     │            │ - Funding     │
│ - History     │            │ - Visibility  │            │ - Cashout     │
└───────┬───────┘            └───────┬───────┘            └───────┬───────┘
        │                            │                            │
        └────────────────────────────┼────────────────────────────┘
                                     │
                        ┌────────────┴────────────┐
                        │                         │
                        ▼                         ▼
               ┌───────────────┐         ┌───────────────┐
               │  PostgreSQL   │         │    Redis      │
               │               │         │               │
               │ - Wallets     │         │ - Balance     │
               │ - Transfers   │         │   cache       │
               │ - Feed items  │         │ - Sessions    │
               │ - Audit log   │         │ - Rate limits │
               └───────────────┘         │ - Idempotency │
                                         └───────────────┘
```

---

## Deep Dive: Balance Consistency (10 minutes)

### The Core Challenge

"The fundamental challenge is preventing race conditions in concurrent transfers:

- **Double-spend**: User has $100, simultaneously sends $80 to Alice and $70 to Bob
- **Negative balance**: Spending more than available before balance check completes
- **Lost updates**: Two concurrent balance modifications overwriting each other

We solve this with PostgreSQL row-level locking."

### Transfer Implementation with SELECT FOR UPDATE

```javascript
async function transfer(senderId, receiverId, amount, note, visibility) {
  // Validate amount
  if (amount <= 0 || amount > 500000) { // $5000 limit
    throw new Error('Invalid amount');
  }

  // Atomic transfer using database transaction
  const transfer = await db.transaction(async (tx) => {
    // Lock sender's wallet row to prevent race conditions
    // Any concurrent transaction will WAIT here
    const senderWallet = await tx.query(`
      SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE
    `, [senderId]);

    // Check available balance (includes pending external charges)
    const available = await getAvailableBalance(tx, senderId, senderWallet.rows[0]);
    if (available < amount) {
      throw new Error('Insufficient funds');
    }

    // Determine funding source (waterfall logic)
    const fundingPlan = await determineFunding(tx, senderId, amount, senderWallet.rows[0]);

    // Debit sender (only balance portion)
    await tx.query(`
      UPDATE wallets SET balance = balance - $2, updated_at = NOW()
      WHERE user_id = $1
    `, [senderId, fundingPlan.fromBalance]);

    // If funding from external source, create pending charge
    if (fundingPlan.fromExternal > 0) {
      await createExternalCharge(tx, senderId, fundingPlan.fromExternal, fundingPlan.source);
    }

    // Credit receiver - lock their row too for consistency
    await tx.query(`
      UPDATE wallets SET balance = balance + $2, updated_at = NOW()
      WHERE user_id = $1
    `, [receiverId, amount]);

    // Create transfer record with idempotency key
    const transferRecord = await tx.query(`
      INSERT INTO transfers (sender_id, receiver_id, amount, note, visibility, status, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, 'completed', $6)
      RETURNING *
    `, [senderId, receiverId, amount, note, visibility, idempotencyKey]);

    return transferRecord.rows[0];
  });

  // Post-commit operations (can fail without rolling back transfer)
  await invalidateBalanceCache(senderId);
  await invalidateBalanceCache(receiverId);
  await publishToFeed(transfer);  // Async via RabbitMQ
  await notifyTransfer(transfer);  // Push notification

  return transfer;
}
```

### Why SELECT FOR UPDATE Works

"The key insight is that `SELECT FOR UPDATE` acquires a row-level lock:

1. Transaction A locks sender's wallet row
2. Transaction B tries to lock the same row - it WAITS
3. Transaction A completes, releases lock
4. Transaction B proceeds with updated balance

This serializes concurrent transfers from the same sender, preventing double-spends."

### Funding Waterfall

```javascript
async function determineFunding(tx, userId, amount, wallet) {
  let remaining = amount;
  const plan = { fromBalance: 0, fromExternal: 0, source: null };

  // Priority 1: Use Venmo balance (free, instant)
  if (wallet.balance >= remaining) {
    plan.fromBalance = remaining;
    return plan;
  }

  plan.fromBalance = wallet.balance;
  remaining -= wallet.balance;

  // Priority 2: Use linked bank account (free, but ACH delay for funding)
  const bankAccount = await tx.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'bank' AND is_default = true AND verified = true
  `, [userId]);

  if (bankAccount.rows.length > 0) {
    plan.fromExternal = remaining;
    plan.source = { type: 'bank', id: bankAccount.rows[0].id };
    return plan;
  }

  // Priority 3: Use linked card (3% fee)
  const card = await tx.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'card' AND is_default = true
  `, [userId]);

  if (card.rows.length > 0) {
    plan.fromExternal = remaining;
    plan.source = { type: 'card', id: card.rows[0].id };
    return plan;
  }

  throw new Error('No funding source available');
}
```

---

## Deep Dive: Idempotency for Safe Retries (8 minutes)

### Why Idempotency is Critical

"Money transfers are dangerous to retry. Consider:

1. **Network timeout**: Request succeeds server-side, response lost. User retries = double payment
2. **Mobile retries**: Client auto-retries on timeout. Each retry could charge the user
3. **Double-click**: Two identical POST requests milliseconds apart

We implement idempotency at two levels: Redis (fast) and PostgreSQL (durable)."

### Idempotency Implementation

```javascript
// Idempotency middleware
async function checkIdempotency(userId, key, operation) {
  const cacheKey = `idempotency:${userId}:${operation}:${key}`;

  // Check Redis first (fast path)
  const cached = await redis.get(cacheKey);
  if (cached) {
    const result = JSON.parse(cached);
    return { isNew: false, existingResponse: result };
  }

  // Check PostgreSQL (durable storage)
  const existing = await db.query(`
    SELECT * FROM idempotency_keys
    WHERE user_id = $1 AND key = $2 AND operation = $3
  `, [userId, key, operation]);

  if (existing.rows.length > 0) {
    const record = existing.rows[0];
    // Re-populate Redis cache
    await redis.setex(cacheKey, 86400, JSON.stringify(record.response));
    return { isNew: false, existingResponse: record.response };
  }

  return { isNew: true, existingResponse: null };
}

async function storeIdempotencyResult(userId, key, operation, status, response) {
  const cacheKey = `idempotency:${userId}:${operation}:${key}`;

  // Store in both Redis (24hr TTL) and PostgreSQL (permanent)
  await Promise.all([
    redis.setex(cacheKey, 86400, JSON.stringify(response)),
    db.query(`
      INSERT INTO idempotency_keys (user_id, key, operation, status, response, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id, key, operation) DO NOTHING
    `, [userId, key, operation, status, JSON.stringify(response)])
  ]);
}

// Transfer endpoint with idempotency
app.post('/transfers', async (req, res) => {
  const { senderId, receiverId, amount, note, idempotencyKey } = req.body;

  // Check for existing transfer
  const { isNew, existingResponse } = await checkIdempotency(
    senderId, idempotencyKey, 'transfer'
  );

  if (!isNew) {
    return res.json(existingResponse); // Return cached result
  }

  try {
    const transfer = await processTransfer(senderId, receiverId, amount, note);
    await storeIdempotencyResult(senderId, idempotencyKey, 'transfer', 'completed', transfer);
    return res.json(transfer);
  } catch (error) {
    await storeIdempotencyResult(senderId, idempotencyKey, 'transfer', 'failed', {
      error: error.message
    });
    throw error;
  }
});
```

### Idempotency Key Schema

```sql
CREATE TABLE idempotency_keys (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  key VARCHAR(64) NOT NULL,
  operation VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  response JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, key, operation)
);

CREATE INDEX idx_idempotency_cleanup ON idempotency_keys(created_at);
```

---

## Deep Dive: Social Feed Architecture (8 minutes)

### Fan-Out on Write

"Venmo shows transactions from friends. We use fan-out-on-write: when a transfer happens, we pre-compute who should see it."

```javascript
async function publishToFeed(transfer) {
  // Queue for async processing
  await rabbitMQ.publish('feed-fanout', {
    transferId: transfer.id,
    senderId: transfer.sender_id,
    receiverId: transfer.receiver_id,
    visibility: transfer.visibility,
    amount: transfer.amount,
    note: transfer.note,
    timestamp: new Date()
  });
}

// Worker consumes from queue
async function processFeedFanout(message) {
  const { transferId, senderId, receiverId, visibility } = message;

  if (visibility === 'private') {
    // Only show to sender and receiver
    await addToFeed(senderId, message);
    await addToFeed(receiverId, message);
    return;
  }

  // Get friends of both participants
  const friends = await getFriendsUnion(senderId, receiverId);

  // Batch insert for efficiency
  const feedItems = friends.map(friendId => ({
    userId: friendId,
    transferId,
    senderId,
    receiverId,
    amount: message.amount,
    note: message.note,
    createdAt: message.timestamp
  }));

  await db.query(`
    INSERT INTO feed_items (user_id, transfer_id, sender_id, receiver_id, amount, note, created_at)
    SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::integer[], $6::text[], $7::timestamp[])
  `, [
    feedItems.map(f => f.userId),
    feedItems.map(f => f.transferId),
    feedItems.map(f => f.senderId),
    feedItems.map(f => f.receiverId),
    feedItems.map(f => f.amount),
    feedItems.map(f => f.note),
    feedItems.map(f => f.createdAt)
  ]);
}
```

### Feed Query Optimization

```javascript
async function getFeed(userId, limit = 20, cursor = null) {
  let query = `
    SELECT
      fi.*,
      s.username as sender_username,
      s.avatar_url as sender_avatar,
      r.username as receiver_username,
      r.avatar_url as receiver_avatar,
      (SELECT COUNT(*) FROM feed_likes WHERE feed_item_id = fi.id) as like_count,
      (SELECT COUNT(*) FROM feed_comments WHERE feed_item_id = fi.id) as comment_count
    FROM feed_items fi
    JOIN users s ON fi.sender_id = s.id
    JOIN users r ON fi.receiver_id = r.id
    WHERE fi.user_id = $1
  `;
  const params = [userId];

  // Cursor-based pagination (more efficient than offset)
  if (cursor) {
    query += ` AND fi.created_at < $2`;
    params.push(cursor);
  }

  query += ` ORDER BY fi.created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await db.query(query, params);

  return {
    items: result.rows,
    nextCursor: result.rows.length === limit
      ? result.rows[result.rows.length - 1].created_at
      : null
  };
}
```

### Why Fan-Out on Write?

| Approach | Pros | Cons |
|----------|------|------|
| Fan-out on write | Fast reads, predictable latency | Storage overhead, write amplification |
| Fan-in on read | Less storage, fresh data | Slow reads, complex queries |

"For Venmo, reads are frequent (opening app) and writes are less frequent (sending money). Fan-out makes reads O(1) instead of O(friends)."

---

## Deep Dive: Circuit Breakers for External APIs (5 minutes)

### The Problem

"External bank and card APIs can fail. Without protection:

1. Bank API goes down with 30s timeout
2. All transfer requests queue up waiting
3. Thread pool exhausted
4. Entire system becomes unresponsive

Circuit breakers fail fast when dependencies are unhealthy."

### Implementation

```javascript
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000;
    this.halfOpenRequests = options.halfOpenRequests || 3;

    this.state = 'CLOSED';
    this.failures = 0;
    this.lastFailureTime = null;
    this.halfOpenSuccesses = 0;
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
        this.halfOpenSuccesses = 0;
      } else {
        throw new CircuitBreakerOpenError(this.name);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.halfOpenRequests) {
        this.state = 'CLOSED';
        console.info(`Circuit breaker ${this.name} closed`);
      }
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      console.error(`Circuit breaker ${this.name} opened`);
    }
  }
}

// Usage
const bankApiCircuit = new CircuitBreaker('bank-api', {
  failureThreshold: 3,
  resetTimeout: 60000
});

async function chargeBankAccount(userId, amount, bankAccount) {
  return bankApiCircuit.execute(async () => {
    return await bankAPI.initiateACHDebit({
      routingNumber: bankAccount.routing_number,
      accountNumber: decrypt(bankAccount.account_number_encrypted),
      amount,
      reference: `venmo_${userId}_${Date.now()}`
    });
  });
}
```

---

## Database Schema (3 minutes)

```sql
-- Core tables
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  phone VARCHAR(20),
  pin_hash VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  balance INTEGER DEFAULT 0,  -- In cents, prevents floating point errors
  pending_balance INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID REFERENCES users(id),
  receiver_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  note TEXT,
  visibility VARCHAR(20) DEFAULT 'public',
  status VARCHAR(20) NOT NULL,
  idempotency_key VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_transfers_idempotency
  ON transfers(sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_transfers_sender ON transfers(sender_id, created_at DESC);
CREATE INDEX idx_transfers_receiver ON transfers(receiver_id, created_at DESC);

-- Feed storage (PostgreSQL for learning; Cassandra at scale)
CREATE TABLE feed_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  transfer_id UUID REFERENCES transfers(id),
  sender_id UUID REFERENCES users(id),
  receiver_id UUID REFERENCES users(id),
  amount INTEGER,
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_feed_items_user ON feed_items(user_id, created_at DESC);

-- Audit log (append-only for compliance)
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id UUID,
  actor_type VARCHAR(20),
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(30),
  resource_id UUID,
  ip_address INET,
  request_id VARCHAR(50),
  details JSONB,
  outcome VARCHAR(20) NOT NULL
);

CREATE INDEX idx_audit_actor ON audit_log(actor_id, timestamp DESC);
CREATE INDEX idx_audit_action ON audit_log(action, timestamp DESC);
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Balance storage | PostgreSQL + row locking | Event sourcing with ledger | Simpler, strong consistency, proven at scale |
| Concurrency control | SELECT FOR UPDATE | Optimistic locking | Pessimistic safer for money; optimistic has retry overhead |
| Feed architecture | Fan-out on write | Fan-in on read | Read-heavy workload, predictable latency |
| Feed storage | PostgreSQL | Cassandra | Learning simplicity; Cassandra better at 10M+ users |
| Idempotency | Redis + PostgreSQL | PostgreSQL only | Fast duplicate detection with durable backup |
| External APIs | Circuit breakers | Retry only | Prevents cascading failures, fails fast |

---

## Observability and Compliance (2 minutes)

### Key Metrics

```javascript
// Transfer metrics
venmo_transfers_total{status, funding_source}
venmo_transfer_amount_cents (histogram)
venmo_transfer_duration_seconds{step} // lock, debit, credit, commit

// Circuit breaker state
venmo_circuit_breaker_state{service} // 0=closed, 1=half-open, 2=open

// Database health
venmo_postgres_connections_active
venmo_db_query_duration_seconds{query_type}
```

### Audit Logging

"Financial regulations require immutable audit trails. Every money movement creates an audit entry with actor, action, resource, IP address, and outcome. These logs are append-only with 7-year retention."

---

## Summary

"To summarize the backend design:

1. **Atomic Balance Transfers**: PostgreSQL transactions with `SELECT FOR UPDATE` row-level locking prevent double-spends and negative balances

2. **Funding Waterfall**: Automatic source selection (balance, bank, card) with graceful degradation

3. **Idempotency**: Redis (fast) + PostgreSQL (durable) prevents duplicate transfers on network retries

4. **Fan-Out-on-Write Feed**: Pre-computed feed items for O(1) read latency, async write via RabbitMQ

5. **Circuit Breakers**: Fail-fast pattern protects system when bank/card APIs are unhealthy

6. **Audit Compliance**: Append-only audit log with 7-year retention for financial regulations

The design prioritizes financial consistency above all else while delivering the real-time experience users expect.

What aspects would you like me to elaborate on?"
