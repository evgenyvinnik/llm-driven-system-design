# Design Venmo - Architecture

## System Overview

Venmo is a peer-to-peer payment platform with social features. Core challenges involve balance management, instant transfers, and social feed scalability.

**Learning Goals:**
- Build consistent wallet/balance systems
- Design real-time P2P transfer flows
- Implement social transaction feeds
- Handle multi-source funding

---

## Requirements

### Functional Requirements

1. **Send**: Transfer money to other users
2. **Request**: Ask others for payment
3. **Feed**: View social transaction activity
4. **Balance**: Manage Venmo wallet
5. **Cashout**: Transfer to bank account

### Non-Functional Requirements

- **Latency**: < 500ms for P2P transfers
- **Consistency**: Accurate balances always
- **Availability**: 99.99% for transfers
- **Scale**: 80M+ users, high volume on weekends

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│                 Mobile App │ Web App                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│               (Auth, Rate Limiting)                             │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Transfer Service│    │  Feed Service │    │ Wallet Service│
│               │    │               │    │               │
│ - Send/Request│    │ - Timeline    │    │ - Balance     │
│ - Split bills │    │ - Social graph│    │ - Funding     │
│ - History     │    │ - Visibility  │    │ - Cashout     │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│          PostgreSQL           │      Redis                │
│  - Wallets, Transfers, Users  │      - Balance cache      │
│  - Feed items, Social graph   │      - Sessions           │
│  - Activity history           │      - Rate limits        │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Wallet & Balance Management

**Atomic Balance Updates:**
```javascript
async function transfer(senderId, receiverId, amount, note, visibility) {
  // Validate amount
  if (amount <= 0 || amount > 5000) {
    throw new Error('Invalid amount')
  }

  // Atomic transfer using database transaction
  const transfer = await db.transaction(async (tx) => {
    // Lock sender's wallet row to prevent race conditions
    const senderWallet = await tx.query(`
      SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE
    `, [senderId])

    // Check balance
    const available = await getAvailableBalance(tx, senderId, senderWallet.rows[0])
    if (available < amount) {
      throw new Error('Insufficient funds')
    }

    // Determine funding source (waterfall)
    const fundingPlan = await determineFunding(tx, senderId, amount, senderWallet.rows[0])

    // Debit sender
    await tx.query(`
      UPDATE wallets SET balance = balance - $2 WHERE user_id = $1
    `, [senderId, fundingPlan.fromBalance])

    // If funding from external source, create pending charge
    if (fundingPlan.fromExternal > 0) {
      await createExternalCharge(tx, senderId, fundingPlan.fromExternal, fundingPlan.source)
    }

    // Credit receiver
    await tx.query(`
      UPDATE wallets SET balance = balance + $2 WHERE user_id = $1
    `, [receiverId, amount])

    // Create transfer record
    const transferRecord = await tx.query(`
      INSERT INTO transfers (sender_id, receiver_id, amount, note, visibility, status)
      VALUES ($1, $2, $3, $4, $5, 'completed')
      RETURNING *
    `, [senderId, receiverId, amount, note, visibility])

    return transferRecord.rows[0]
  })

  // Update cached balances
  await invalidateBalanceCache(senderId)
  await invalidateBalanceCache(receiverId)

  // Publish to feed (async)
  await publishToFeed(transfer)

  // Send notifications
  await notifyTransfer(transfer)

  return transfer
}

async function determineFunding(tx, userId, amount, wallet) {
  let remaining = amount
  const plan = { fromBalance: 0, fromExternal: 0, source: null }

  // Priority 1: Use Venmo balance
  if (wallet.balance >= remaining) {
    plan.fromBalance = remaining
    return plan
  }

  plan.fromBalance = wallet.balance
  remaining -= wallet.balance

  // Priority 2: Use linked bank account (free)
  const bankAccount = await tx.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'bank' AND is_default = true
  `, [userId])

  if (bankAccount.rows.length > 0) {
    plan.fromExternal = remaining
    plan.source = { type: 'bank', id: bankAccount.rows[0].id }
    return plan
  }

  // Priority 3: Use linked card (with fee)
  const card = await tx.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'card' AND is_default = true
  `, [userId])

  if (card.rows.length > 0) {
    plan.fromExternal = remaining
    plan.source = { type: 'card', id: card.rows[0].id }
    return plan
  }

  throw new Error('No funding source available')
}
```

### 2. Social Feed

**Feed Generation:**
```javascript
// Write path: Fan-out on write
async function publishToFeed(transfer) {
  if (transfer.visibility === 'private') {
    // Only show to sender and receiver
    await addToFeed(transfer.sender_id, transfer)
    await addToFeed(transfer.receiver_id, transfer)
    return
  }

  // Get friends of both participants
  const friends = await getFriendsUnion(transfer.sender_id, transfer.receiver_id)

  // Fan out to all friends' feeds
  for (const friendId of friends) {
    await addToFeed(friendId, transfer)
  }
}

async function addToFeed(userId, transfer) {
  await db.query(`
    INSERT INTO feed_items (user_id, created_at, transfer_id, sender_id, receiver_id, amount, note)
    VALUES ($1, NOW(), $2, $3, $4, $5, $6)
  `, [userId, Date.now(), transfer.id, transfer.sender_id, transfer.receiver_id,
      transfer.amount, transfer.note])
}

// Read path: Simple timeline query
async function getFeed(userId, limit = 20, before = null) {
  let query = `
    SELECT * FROM feed_items
    WHERE user_id = $1
  `
  const params = [userId]

  if (before) {
    query += ` AND created_at < $2`
    params.push(before)
  }

  query += ` ORDER BY created_at DESC LIMIT $3`
  params.push(limit)

  const result = await db.query(query, params)

  // Hydrate with user info
  return hydrateWithUsers(result.rows)
}
```

### 3. Payment Requests

**Request & Reminder Flow:**
```javascript
async function createRequest(requesterId, requesteeId, amount, note) {
  const request = await db.query(`
    INSERT INTO payment_requests (requester_id, requestee_id, amount, note, status)
    VALUES ($1, $2, $3, $4, 'pending')
    RETURNING *
  `, [requesterId, requesteeId, amount, note])

  // Notify requestee
  await pushNotification(requesteeId, {
    type: 'payment_request',
    title: `${requesterName} requested $${amount}`,
    body: note,
    data: { requestId: request.rows[0].id }
  })

  return request.rows[0]
}

async function payRequest(requestId, payerId) {
  const request = await db.query(`
    SELECT * FROM payment_requests WHERE id = $1 AND status = 'pending'
  `, [requestId])

  if (!request.rows.length) {
    throw new Error('Request not found or already paid')
  }

  const req = request.rows[0]

  // Verify payer is the requestee
  if (req.requestee_id !== payerId) {
    throw new Error('Unauthorized')
  }

  // Process as normal transfer
  const transfer = await transfer(
    payerId,
    req.requester_id,
    req.amount,
    req.note,
    'public'
  )

  // Mark request as paid
  await db.query(`
    UPDATE payment_requests SET status = 'paid', paid_at = NOW(), transfer_id = $2
    WHERE id = $1
  `, [requestId, transfer.id])

  return transfer
}

// Scheduled job: Send reminders
async function sendRequestReminders() {
  const pendingRequests = await db.query(`
    SELECT * FROM payment_requests
    WHERE status = 'pending'
    AND created_at < NOW() - INTERVAL '3 days'
    AND reminder_sent_at IS NULL
  `)

  for (const request of pendingRequests.rows) {
    await pushNotification(request.requestee_id, {
      type: 'request_reminder',
      title: `Reminder: ${requesterName} requested $${request.amount}`,
      body: 'Tap to pay or decline'
    })

    await db.query(`
      UPDATE payment_requests SET reminder_sent_at = NOW() WHERE id = $1
    `, [request.id])
  }
}
```

### 4. Instant Cashout

**Bank Transfer Options:**
```javascript
async function cashout(userId, amount, speed) {
  const wallet = await db.query(`
    SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE
  `, [userId])

  if (wallet.rows[0].balance < amount) {
    throw new Error('Insufficient balance')
  }

  const defaultBank = await db.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'bank' AND is_default = true
  `, [userId])

  if (!defaultBank.rows.length) {
    throw new Error('No bank account linked')
  }

  let fee = 0
  let deliveryDate

  if (speed === 'instant') {
    // Instant transfer via debit card push
    fee = Math.min(Math.round(amount * 0.015), 1500) // 1.5%, max $15
    deliveryDate = new Date()

    // Process immediately
    await processInstantCashout(userId, amount, defaultBank.rows[0])
  } else {
    // Standard ACH (1-3 business days)
    fee = 0
    deliveryDate = getNextBusinessDay(3)

    // Queue for batch processing
    await queueACHCashout(userId, amount, defaultBank.rows[0])
  }

  // Debit balance
  await db.query(`
    UPDATE wallets SET balance = balance - $2 WHERE user_id = $1
  `, [userId, amount])

  // Record cashout
  const cashout = await db.query(`
    INSERT INTO cashouts (user_id, amount, fee, speed, status, estimated_arrival)
    VALUES ($1, $2, $3, $4, 'processing', $5)
    RETURNING *
  `, [userId, amount, fee, speed, deliveryDate])

  return cashout.rows[0]
}

async function processInstantCashout(userId, amount, bankAccount) {
  // Use debit card push-to-card for instant delivery
  const debitCard = await db.query(`
    SELECT * FROM payment_methods
    WHERE user_id = $1 AND type = 'debit_card' AND bank_id = $2
  `, [userId, bankAccount.id])

  if (debitCard.rows.length) {
    // Push to debit card (instant)
    await cardNetwork.pushToCard({
      cardToken: debitCard.rows[0].token,
      amount,
      reference: `venmo_cashout_${userId}`
    })
  } else {
    // RTP (Real-Time Payments) to bank
    await rtpNetwork.send({
      routingNumber: bankAccount.routing_number,
      accountNumber: bankAccount.account_number,
      amount,
      reference: `venmo_cashout_${userId}`
    })
  }
}
```

### 5. Bill Splitting

**Group Payment Splits:**
```javascript
async function createSplit(creatorId, totalAmount, participants, note) {
  // Calculate per-person amount
  const splitAmount = Math.floor(totalAmount / participants.length)
  const remainder = totalAmount - (splitAmount * participants.length)

  const split = await db.transaction(async (tx) => {
    // Create split record
    const split = await tx.query(`
      INSERT INTO splits (creator_id, total_amount, note, status)
      VALUES ($1, $2, $3, 'pending')
      RETURNING *
    `, [creatorId, totalAmount, note])

    // Create participant records
    for (let i = 0; i < participants.length; i++) {
      const userId = participants[i]
      // First person pays remainder
      const amount = i === 0 ? splitAmount + remainder : splitAmount

      await tx.query(`
        INSERT INTO split_participants (split_id, user_id, amount, status)
        VALUES ($1, $2, $3, $4)
      `, [split.rows[0].id, userId, amount, userId === creatorId ? 'paid' : 'pending'])
    }

    return split.rows[0]
  })

  // Send requests to all participants (except creator)
  for (const userId of participants) {
    if (userId !== creatorId) {
      await createRequest(creatorId, userId, splitAmount, `Split: ${note}`)
    }
  }

  return split
}

async function getSplitStatus(splitId) {
  const participants = await db.query(`
    SELECT sp.*, u.name, u.avatar_url
    FROM split_participants sp
    JOIN users u ON sp.user_id = u.id
    WHERE sp.split_id = $1
  `, [splitId])

  const total = participants.rows.length
  const paid = participants.rows.filter(p => p.status === 'paid').length

  return {
    participants: participants.rows,
    progress: `${paid}/${total} paid`,
    isComplete: paid === total
  }
}
```

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(200) UNIQUE NOT NULL,
  phone VARCHAR(20),
  name VARCHAR(100),
  avatar_url VARCHAR(500),
  pin_hash VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Wallets (one per user)
CREATE TABLE wallets (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  balance INTEGER DEFAULT 0, -- In cents
  pending_balance INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Payment Methods
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  type VARCHAR(20) NOT NULL, -- 'bank', 'card', 'debit_card'
  is_default BOOLEAN DEFAULT FALSE,
  last4 VARCHAR(4),
  bank_name VARCHAR(100),
  routing_number VARCHAR(20),
  account_number_encrypted BYTEA,
  card_token VARCHAR(100),
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Transfers
CREATE TABLE transfers (
  id UUID PRIMARY KEY,
  sender_id UUID REFERENCES users(id),
  receiver_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  note TEXT,
  visibility VARCHAR(20) DEFAULT 'public', -- 'public', 'friends', 'private'
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_transfers_sender ON transfers(sender_id, created_at DESC);
CREATE INDEX idx_transfers_receiver ON transfers(receiver_id, created_at DESC);

-- Payment Requests
CREATE TABLE payment_requests (
  id UUID PRIMARY KEY,
  requester_id UUID REFERENCES users(id),
  requestee_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  transfer_id UUID REFERENCES transfers(id),
  reminder_sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Cashouts
CREATE TABLE cashouts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  fee INTEGER DEFAULT 0,
  speed VARCHAR(20) NOT NULL, -- 'instant', 'standard'
  status VARCHAR(20) NOT NULL,
  estimated_arrival TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Bill Splits
CREATE TABLE splits (
  id UUID PRIMARY KEY,
  creator_id UUID REFERENCES users(id),
  total_amount INTEGER NOT NULL,
  note TEXT,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE split_participants (
  split_id UUID REFERENCES splits(id),
  user_id UUID REFERENCES users(id),
  amount INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  paid_at TIMESTAMP,
  PRIMARY KEY (split_id, user_id)
);

-- Friendships
CREATE TABLE friendships (
  user_id UUID REFERENCES users(id),
  friend_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id)
);
```

---

## Key Design Decisions

### 1. Balance as Source of Truth

**Decision**: Use PostgreSQL balance column with row-level locking

**Rationale**:
- Strong consistency required
- Simple atomic updates
- FOR UPDATE prevents race conditions

### 2. Fan-Out on Write for Feed

**Decision**: Pre-compute feeds, don't query on read

**Rationale**:
- Fast read times
- Predictable performance
- Scales with write capacity

### 3. Funding Waterfall

**Decision**: Automatic source selection (balance → bank → card)

**Rationale**:
- Best UX (user doesn't choose each time)
- Minimizes fees (bank is free)
- Matches user expectation

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Balance storage | PostgreSQL | Ledger/Event sourcing | Simplicity, consistency |
| Feed architecture | Fan-out on write | Fan-in on read | Read performance |
| Transfer speed | Instant (in-app) | Batch processing | User experience |
| Funding | Automatic waterfall | User selects each time | UX simplicity |

---

## Observability

### Metrics

Key metrics to expose via Prometheus (or similar) for a payment platform:

**Business Metrics:**
- `venmo_transfers_total{status,funding_source}` - Counter of completed/failed transfers
- `venmo_transfer_amount_cents` - Histogram of transfer amounts (buckets: 100, 500, 1000, 5000, 10000, 50000 cents)
- `venmo_cashout_total{speed,status}` - Instant vs standard cashout counts
- `venmo_payment_requests_total{status}` - Pending, paid, declined, expired

**System Metrics:**
- `venmo_api_request_duration_seconds{endpoint,method}` - Request latency histogram
- `venmo_db_query_duration_seconds{query_type}` - Database query times
- `venmo_balance_cache_hit_ratio` - Redis cache effectiveness
- `venmo_feed_fanout_duration_seconds` - Time to fan out to friends' feeds

**Infrastructure Metrics:**
- `venmo_postgres_connections_active` - Connection pool usage
- `venmo_redis_memory_used_bytes` - Cache memory consumption
- `venmo_feed_read_latency_seconds` - Feed query performance
- `venmo_queue_depth{queue_name}` - Pending jobs in RabbitMQ

### Logging Strategy

Structured JSON logs with correlation IDs for request tracing:

```javascript
// Log format for transfers
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "service": "transfer-service",
  "correlation_id": "req-abc123",
  "user_id": "user-456",
  "event": "transfer_completed",
  "transfer_id": "txn-789",
  "amount_cents": 5000,
  "funding_source": "balance",
  "duration_ms": 45
}
```

**Log Levels:**
- `ERROR`: Failed transfers, insufficient funds, external API failures
- `WARN`: Retry attempts, rate limit approaches, slow queries (>200ms)
- `INFO`: Successful transfers, cashouts, login events
- `DEBUG`: Full request/response payloads (local dev only)

**Sensitive Data Handling:**
- Never log full account numbers - mask to last 4 digits
- Redact session tokens and API keys
- Log user_id but not PII (names, emails) at INFO level

### Distributed Tracing

Trace spans for a typical transfer request:

```
[transfer-api] POST /transfers (parent span)
  ├── [auth] validate_session (5ms)
  ├── [postgres] SELECT wallet FOR UPDATE (12ms)
  ├── [postgres] check_funding_sources (8ms)
  ├── [postgres] UPDATE wallets (debit) (6ms)
  ├── [postgres] UPDATE wallets (credit) (6ms)
  ├── [postgres] INSERT transfer (4ms)
  ├── [redis] invalidate_balance_cache (2ms)
  ├── [rabbitmq] publish_feed_fanout (3ms)
  └── [push-service] send_notification (async, 50ms)
```

For local development, use Jaeger with Docker:
```yaml
# docker-compose.yml addition
jaeger:
  image: jaegertracing/all-in-one:1.50
  ports:
    - "16686:16686"  # UI
    - "6831:6831/udp"  # Thrift
```

### SLI Dashboards

**Transfer Service SLIs:**

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Transfer success rate | 99.9% | < 99.5% for 5 min |
| Transfer latency p50 | < 100ms | > 150ms for 5 min |
| Transfer latency p99 | < 500ms | > 800ms for 2 min |
| Balance cache hit rate | > 90% | < 80% for 10 min |

**Feed Service SLIs:**

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Feed load latency p95 | < 200ms | > 400ms for 5 min |
| Fan-out completion rate | 99.9% | < 99% for 5 min |
| Feed item lag | < 5 sec | > 30 sec for 2 min |

**Infrastructure SLIs:**

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| PostgreSQL connection pool usage | < 80% | > 90% for 5 min |
| Redis memory usage | < 75% | > 85% for 10 min |
| Feed query latency p99 | < 50ms | > 100ms for 5 min |

### Audit Logging

Financial systems require immutable audit trails. Store audit logs separately from application logs:

```sql
-- Audit log table (append-only, no updates/deletes)
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_id UUID,                    -- User or system performing action
  actor_type VARCHAR(20),           -- 'user', 'admin', 'system'
  action VARCHAR(50) NOT NULL,      -- 'transfer', 'cashout', 'link_bank', 'login'
  resource_type VARCHAR(30),        -- 'wallet', 'transfer', 'payment_method'
  resource_id UUID,
  ip_address INET,
  user_agent TEXT,
  request_id VARCHAR(50),           -- Correlation ID
  details JSONB,                    -- Action-specific data
  outcome VARCHAR(20) NOT NULL      -- 'success', 'failure', 'denied'
);

CREATE INDEX idx_audit_actor ON audit_log(actor_id, timestamp DESC);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_action ON audit_log(action, timestamp DESC);
```

**Audited Events:**
- All money movements (transfers, cashouts, charges)
- Payment method changes (add/remove bank, card)
- Authentication events (login, logout, failed attempts)
- Administrative actions (account freezes, limit changes)
- Privacy setting changes

---

## Failure Handling

### Idempotency Keys

Prevent duplicate transfers when clients retry:

```javascript
async function transferWithIdempotency(idempotencyKey, senderId, receiverId, amount, note) {
  // Check for existing transfer with this key
  const existing = await db.query(`
    SELECT * FROM transfers WHERE idempotency_key = $1 AND sender_id = $2
  `, [idempotencyKey, senderId])

  if (existing.rows.length > 0) {
    const transfer = existing.rows[0]
    // Return cached result (success or failure)
    if (transfer.status === 'completed') {
      return { success: true, transfer, cached: true }
    }
    if (transfer.status === 'failed') {
      throw new Error(transfer.failure_reason)
    }
  }

  // No existing transfer - create new one
  try {
    const transfer = await processTransfer(senderId, receiverId, amount, note)
    await db.query(`
      UPDATE transfers SET idempotency_key = $2 WHERE id = $1
    `, [transfer.id, idempotencyKey])
    return { success: true, transfer, cached: false }
  } catch (error) {
    // Record failure for idempotency
    await db.query(`
      INSERT INTO transfer_attempts (idempotency_key, sender_id, status, failure_reason)
      VALUES ($1, $2, 'failed', $3)
    `, [idempotencyKey, senderId, error.message])
    throw error
  }
}
```

**Idempotency Key Schema:**
```sql
ALTER TABLE transfers ADD COLUMN idempotency_key VARCHAR(64);
CREATE UNIQUE INDEX idx_transfers_idempotency ON transfers(sender_id, idempotency_key);

-- Track failed attempts too
CREATE TABLE transfer_attempts (
  id SERIAL PRIMARY KEY,
  idempotency_key VARCHAR(64) NOT NULL,
  sender_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL,
  failure_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(sender_id, idempotency_key)
);
```

**Key Format:** Client generates `{userId}-{timestamp}-{random}` or UUID v4

### Retry Strategy

```javascript
const RETRY_CONFIG = {
  transfer: {
    maxRetries: 3,
    initialDelay: 100,      // ms
    maxDelay: 2000,         // ms
    backoffMultiplier: 2,
    retryableErrors: ['ETIMEDOUT', 'ECONNRESET', 'DATABASE_UNAVAILABLE']
  },
  externalPayment: {
    maxRetries: 5,
    initialDelay: 500,
    maxDelay: 30000,
    backoffMultiplier: 2,
    retryableErrors: ['NETWORK_ERROR', 'RATE_LIMITED', 'TEMPORARY_FAILURE']
  }
}

async function retryWithBackoff(operation, config) {
  let lastError
  let delay = config.initialDelay

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      const isRetryable = config.retryableErrors.some(e =>
        error.code === e || error.message.includes(e)
      )

      if (!isRetryable || attempt === config.maxRetries) {
        throw error
      }

      console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`, {
        error: error.message,
        operation: operation.name
      })

      await sleep(delay + Math.random() * 100)  // Add jitter
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelay)
    }
  }
  throw lastError
}
```

### Circuit Breakers

Protect the system when external services fail:

```javascript
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeout = options.resetTimeout || 30000  // 30 seconds
    this.halfOpenRequests = options.halfOpenRequests || 3

    this.state = 'CLOSED'  // CLOSED, OPEN, HALF_OPEN
    this.failures = 0
    this.successes = 0
    this.lastFailureTime = null
    this.halfOpenAttempts = 0
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = 'HALF_OPEN'
        this.halfOpenAttempts = 0
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`)
      }
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    this.failures = 0
    if (this.state === 'HALF_OPEN') {
      this.halfOpenAttempts++
      if (this.halfOpenAttempts >= this.halfOpenRequests) {
        this.state = 'CLOSED'
        console.info(`Circuit breaker ${this.name} closed`)
      }
    }
  }

  onFailure() {
    this.failures++
    this.lastFailureTime = Date.now()
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
      console.error(`Circuit breaker ${this.name} opened after ${this.failures} failures`)
    }
  }
}

// Usage for external payment providers
const bankAPICircuit = new CircuitBreaker('bank-api', {
  failureThreshold: 3,
  resetTimeout: 60000
})

const cardNetworkCircuit = new CircuitBreaker('card-network', {
  failureThreshold: 5,
  resetTimeout: 30000
})
```

### Backup and Restore

**PostgreSQL Backup Strategy (Local Development):**

```bash
#!/bin/bash
# backup.sh - Run daily via cron or manually

BACKUP_DIR="/backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_NAME="venmo"

# Create logical backup
pg_dump -Fc $DB_NAME > $BACKUP_DIR/venmo_$TIMESTAMP.dump

# Keep last 7 days of backups
find $BACKUP_DIR -name "*.dump" -mtime +7 -delete

# Verify backup integrity
pg_restore --list $BACKUP_DIR/venmo_$TIMESTAMP.dump > /dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "Backup verified: venmo_$TIMESTAMP.dump"
else
  echo "ERROR: Backup verification failed!"
  exit 1
fi
```

**Restore Testing Procedure:**

```bash
#!/bin/bash
# restore-test.sh - Monthly restore verification

TEST_DB="venmo_restore_test"
LATEST_BACKUP=$(ls -t /backups/postgres/*.dump | head -1)

# Create test database
createdb $TEST_DB

# Restore backup
pg_restore -d $TEST_DB $LATEST_BACKUP

# Run validation queries
psql $TEST_DB << EOF
SELECT COUNT(*) AS user_count FROM users;
SELECT COUNT(*) AS transfer_count FROM transfers;
SELECT SUM(balance) AS total_balance FROM wallets;
EOF

# Cleanup
dropdb $TEST_DB
```

**Redis Backup (Balance Cache):**

For local development, Redis data is ephemeral (cache only). On restart:
1. Cache misses hit PostgreSQL
2. Cache warms up organically with traffic
3. No explicit backup needed for cache data

**Feed Items (stored in PostgreSQL):

```bash
# Feed items are backed up as part of PostgreSQL backup
# They use the same pg_dump command shown above
```

### Disaster Recovery (Local Dev Simulation)

For learning purposes, simulate failures:

```javascript
// Chaos testing helpers for local development
const chaosConfig = {
  enabled: process.env.CHAOS_ENABLED === 'true',
  failureRate: 0.1,  // 10% of requests fail
  latencyInjection: { min: 100, max: 500 }  // Add 100-500ms delay
}

function maybeFail(serviceName) {
  if (!chaosConfig.enabled) return

  if (Math.random() < chaosConfig.failureRate) {
    throw new Error(`[CHAOS] Simulated ${serviceName} failure`)
  }
}

async function maybeDelay() {
  if (!chaosConfig.enabled) return

  const delay = chaosConfig.latencyInjection.min +
    Math.random() * (chaosConfig.latencyInjection.max - chaosConfig.latencyInjection.min)
  await sleep(delay)
}
```

---

## Cost Optimization

### Storage Tiering

**PostgreSQL (Hot Data):**
- Active wallets, recent transfers (last 90 days)
- Estimated size: ~500 bytes per transfer, ~200 bytes per user
- For 1M users with 50 transfers each: ~25 GB

**Feed Items (also in PostgreSQL):
- Feed items (last 30 days by default)
- Older items can use shorter TTL or move to cheaper storage
- For production scale, consider archiving older items

```sql
-- Periodic cleanup for old feed items
DELETE FROM feed_items WHERE created_at < NOW() - INTERVAL '30 days';
```

**Archive Strategy (Cold Data):**
- Transfers older than 1 year: export to Parquet files
- Store in MinIO/S3 with infrequent access tier
- Query via ad-hoc tools when needed (compliance, disputes)

```sql
-- Monthly archive job
INSERT INTO transfers_archive
SELECT * FROM transfers
WHERE created_at < NOW() - INTERVAL '1 year';

DELETE FROM transfers
WHERE created_at < NOW() - INTERVAL '1 year';
```

### Cache Sizing

**Redis Memory Budget (Local Dev):**

| Cache Type | Key Pattern | Estimated Size | TTL |
|------------|-------------|----------------|-----|
| Balance cache | `balance:{userId}` | 100 bytes/user | 5 min |
| Session cache | `session:{token}` | 500 bytes/session | 24 hr |
| Rate limit | `ratelimit:{userId}:{action}` | 50 bytes/key | 1 min |
| User profile | `user:{userId}` | 1 KB/user | 15 min |

**Memory Calculation for 10K active users:**
- Balance: 10K * 100 bytes = 1 MB
- Sessions: 10K * 500 bytes = 5 MB
- Rate limits: 10K * 5 actions * 50 bytes = 2.5 MB
- Profiles: 10K * 1 KB = 10 MB
- **Total: ~20 MB** (allocate 64 MB for headroom)

```bash
# redis.conf for local development
maxmemory 64mb
maxmemory-policy allkeys-lru
```

**Cache Invalidation Strategy:**
- Balance: Invalidate on any wallet modification
- Sessions: TTL-based expiration only
- User profiles: Invalidate on profile update, TTL fallback

### Queue Retention

**RabbitMQ Settings:**

| Queue | Purpose | TTL | Max Length |
|-------|---------|-----|------------|
| `feed-fanout` | Async feed updates | 1 hour | 100K messages |
| `notifications` | Push notifications | 30 min | 50K messages |
| `cashout-batch` | Standard ACH processing | 24 hours | 10K messages |
| `audit-log` | Async audit writes | 1 hour | 200K messages |

```javascript
// Queue declaration with limits
await channel.assertQueue('feed-fanout', {
  durable: true,
  arguments: {
    'x-message-ttl': 3600000,      // 1 hour
    'x-max-length': 100000,         // 100K messages
    'x-overflow': 'reject-publish'  // Reject new messages when full
  }
})
```

**Dead Letter Handling:**
```javascript
// Failed messages go to DLQ for investigation
await channel.assertQueue('feed-fanout-dlq', { durable: true })
await channel.assertQueue('feed-fanout', {
  arguments: {
    'x-dead-letter-exchange': '',
    'x-dead-letter-routing-key': 'feed-fanout-dlq'
  }
})
```

### Compute vs Storage Tradeoffs

| Component | Compute-Heavy | Storage-Heavy | Recommendation |
|-----------|---------------|---------------|----------------|
| Feed generation | Fan-in on read (query per request) | Fan-out on write (store per friend) | **Storage**: Pre-compute feeds for fast reads |
| Balance calculation | Sum ledger entries on read | Maintain balance column | **Storage**: Single source of truth column |
| Transfer history | Query on demand | Denormalize with sender/receiver details | **Hybrid**: Store IDs, hydrate on read with cache |
| Friend suggestions | Compute graph analysis per request | Pre-compute and cache | **Compute with cache**: Weekly batch job + cache |

**Local Development Resource Allocation:**

```yaml
# docker-compose.yml resource limits
services:
  postgres:
    deploy:
      resources:
        limits:
          memory: 512M
  redis:
    deploy:
      resources:
        limits:
          memory: 64M
  rabbitmq:
    deploy:
      resources:
        limits:
          memory: 256M
```

**Total local dev footprint: ~600 MB RAM** - reasonable for development laptops.

---

## Implementation Notes

This section documents the actual implementation of key observability, failure handling, and compliance features in the `backend/src/` codebase.

### 1. Idempotency for Payment Transfers

**Location:** `backend/src/shared/idempotency.js`, `backend/src/routes/transfers.js`

**WHY idempotency prevents duplicate money transfers:**

Money transfers are inherently dangerous to retry. Consider these scenarios:

1. **Network timeout**: User clicks "Send $50 to Alice". The request succeeds on the server, but the response is lost due to network issues. The user sees an error and clicks "Send" again. Without idempotency, Alice receives $100.

2. **Double-click**: Users often double-click buttons. Two identical POST requests arrive milliseconds apart. Without idempotency, both are processed.

3. **Mobile app retry**: Mobile clients automatically retry failed requests. A timeout doesn't mean failure - the server may have succeeded. Each retry risks a duplicate transfer.

4. **Load balancer retry**: Infrastructure may retry requests that appear to have failed.

**How our implementation works:**

```javascript
// Client generates UUID when user clicks "Send" (not on page load)
const idempotencyKey = crypto.randomUUID();

// Server checks Redis first (fast path)
const { isNew, existingResponse } = await checkIdempotency(userId, key, 'transfer');

if (!isNew) {
  // Return cached result - no duplicate charge
  return existingResponse;
}

// Process transfer, then store result in both Redis (24hr TTL) and PostgreSQL
await storeIdempotencyResult(userId, key, 'transfer', 'completed', result);
```

The key insight: Idempotency is implemented at TWO levels:
- **Redis**: Fast duplicate detection, expires after 24 hours
- **PostgreSQL**: Permanent record via `idempotency_key` column with unique index

This dual approach handles both rapid retries (Redis) and delayed retries/disputes (PostgreSQL).

### 2. Audit Logging for Financial Compliance

**Location:** `backend/src/shared/audit.js`, integrated into transfer service

**WHY audit logging is required for financial regulations:**

Financial services operate under strict regulatory requirements:

1. **BSA/AML (Bank Secrecy Act / Anti-Money Laundering)**: Requires tracking all money movements to detect and report suspicious activity. Without audit logs, we cannot identify potential money laundering patterns.

2. **SOX Compliance (Sarbanes-Oxley)**: Requires accurate financial records and controls. Audit logs provide the immutable trail needed for compliance audits.

3. **PCI-DSS**: When handling payment card data, logging access and changes is mandatory.

4. **Dispute Resolution**: When users claim "I didn't make that transfer", audit logs provide:
   - Exact timestamp
   - IP address and location
   - Device/browser fingerprint
   - Session information
   - The specific actions taken

5. **Fraud Investigation**: Security teams need to trace attacker actions during account takeover incidents.

**Implementation details:**

```javascript
// Every money movement creates an audit entry
await createAuditLog({
  action: AUDIT_ACTIONS.TRANSFER_COMPLETED,
  actorId: transfer.sender_id,
  actorType: ACTOR_TYPES.USER,
  resourceType: 'transfer',
  resourceId: transfer.id,
  outcome: OUTCOMES.SUCCESS,
  details: {
    amount_cents: transfer.amount,
    receiver_id: transfer.receiver_id,
    funding_source: transfer.funding_source,
  },
  request, // Captures IP, user agent automatically
});
```

Audit logs are:
- **Append-only**: No UPDATE or DELETE allowed
- **Timestamped by server**: Cannot be backdated
- **Retained 7 years**: Per regulatory requirements
- **Separate from application logs**: Stored in dedicated `audit_log` table

### 3. Circuit Breakers for Bank API Protection

**Location:** `backend/src/shared/circuit-breaker.js`

**WHY circuit breakers protect against bank API outages:**

External dependencies fail. When they do, the impact on our system depends on how we handle those failures:

**Without circuit breaker:**
```
User Request → Our API → Bank API (down, 30s timeout)
                ↓
        All requests wait 30 seconds
                ↓
        Thread pool exhausted
                ↓
        Our entire system becomes unresponsive
                ↓
        Users cannot even check balances (cascading failure)
```

**With circuit breaker:**
```
User Request → Our API → Circuit Breaker → Bank API (down)
                              ↓
        After 3 failures: Circuit OPENS
                              ↓
        Subsequent requests fail immediately (no 30s wait)
                              ↓
        System remains responsive
                              ↓
        Users see "Bank connection temporarily unavailable"
                              ↓
        After 60s: Circuit tries HALF-OPEN (test requests)
                              ↓
        If bank recovers: Circuit CLOSES (normal operation)
```

**Implementation:**

```javascript
const bankApiCircuit = new CircuitBreaker('bank-api', {
  failureThreshold: 3,      // Open after 3 failures
  resetTimeout: 60000,      // Try recovery after 60 seconds
  halfOpenRequests: 3,      // Require 3 successes to fully close
  timeout: 15000,           // Individual request timeout
});

// Usage
try {
  await bankApiCircuit.execute(async () => {
    return await callBankAPI(request);
  });
} catch (error) {
  if (error.code === 'CIRCUIT_BREAKER_OPEN') {
    // Fail fast - bank is known to be down
    throw new Error('Bank connection temporarily unavailable. Please try again later.');
  }
  throw error;
}
```

Circuit breaker state is exposed via Prometheus metrics for alerting:
- `venmo_circuit_breaker_state{service="bank-api"}` (0=closed, 1=half-open, 2=open)

### 4. Transaction Archival and Retention

**Location:** `backend/src/shared/archival.js`, `backend/src/db/migrate.js`

**WHY transaction archival balances compliance vs storage costs:**

The core tension: Regulations require keeping transaction records for 7 years, but storing everything in PostgreSQL forever is expensive and impacts performance.

**The tradeoff matrix:**

| Storage Tier | Data Age | Cost | Query Speed | Use Case |
|-------------|----------|------|-------------|----------|
| Hot (PostgreSQL) | 0-90 days | $$$ | < 50ms | Active users, recent history |
| Warm (Archive table) | 90 days - 2 years | $$ | < 500ms | Dispute resolution, tax records |
| Cold (S3/MinIO) | 2-7 years | $ | Minutes | Regulatory audits, subpoenas |
| Deleted | > 7 years | Free | N/A | Beyond retention requirement |

**Why each tier exists:**

1. **Hot tier (90 days)**: Most user queries access recent transactions. Keeping this data in the main `transfers` table ensures fast response times. Users expect < 100ms to see their transaction history.

2. **Warm tier (2 years)**: Occasional access for disputes ("I need my records from 8 months ago for taxes") or customer support cases. Slightly slower but still queryable via SQL.

3. **Cold tier (7 years)**: Compliance-only. Rarely accessed except for legal requests, regulatory audits, or fraud investigations. Stored as compressed Parquet files in object storage.

4. **Deletion (> 7 years)**: Reduces liability. Data you don't have cannot be breached or subpoenaed.

**Implementation:**

```javascript
const RETENTION_CONFIG = {
  hotRetentionDays: 90,     // In PostgreSQL transfers table
  warmRetentionDays: 730,   // In transfers_archive table
  totalRetentionDays: 2555, // 7 years total before deletion
};

// Archival job (run daily via cron)
async function archiveOldTransfers() {
  // Move from hot to warm tier
  await pool.query(`
    WITH archived AS (
      DELETE FROM transfers
      WHERE created_at < NOW() - INTERVAL '90 days'
      RETURNING *
    )
    INSERT INTO transfers_archive
    SELECT *, NOW() as archived_at FROM archived
  `);
}
```

**Cost example for 1M users:**
- Hot tier (90 days, 5M transfers): ~50 GB PostgreSQL = ~$50/month
- Warm tier (2 years, 50M transfers): ~100 GB PostgreSQL archive = ~$30/month
- Cold tier (7 years, 175M transfers): ~500 GB S3 = ~$12/month

Without archival: ~3 TB PostgreSQL = ~$1000/month

### 5. Prometheus Metrics

**Location:** `backend/src/shared/metrics.js`, exposed at `/metrics`

**Key metrics implemented:**

| Metric | Type | Purpose |
|--------|------|---------|
| `venmo_transfers_total` | Counter | Track transfer success/failure rates |
| `venmo_transfer_amount_cents` | Histogram | Monitor transfer amount distribution |
| `venmo_http_request_duration_seconds` | Histogram | API latency SLIs |
| `venmo_circuit_breaker_state` | Gauge | Alert on external service failures |
| `venmo_postgres_connections_active` | Gauge | Connection pool health |
| `venmo_idempotency_cache_hits_total` | Counter | Monitor duplicate request prevention |

### 6. Structured Logging with Pino

**Location:** `backend/src/shared/logger.js`

**Log format:**
```json
{
  "level": 30,
  "time": 1705312200000,
  "service": "venmo-api",
  "requestId": "abc123",
  "event": "transfer_completed",
  "transferId": "uuid",
  "amount": "$50.00",
  "durationMs": 45
}
```

**Sensitive data protection:**
- Session tokens, passwords, account numbers are automatically redacted
- User IDs logged, but PII (names, emails) only at DEBUG level

### 7. Health Check Endpoints

**Location:** `backend/src/index.js`

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `/health` | Basic liveness | Server running |
| `/health/detailed` | Full dependency check | PostgreSQL, Redis, circuit breakers |
| `/health/live` | Kubernetes liveness probe | Process alive |
| `/health/ready` | Kubernetes readiness probe | Dependencies connected |

---

## Files Added/Modified

**New shared modules:**
- `backend/src/shared/logger.js` - Pino structured logging
- `backend/src/shared/metrics.js` - Prometheus metrics
- `backend/src/shared/circuit-breaker.js` - Circuit breaker pattern
- `backend/src/shared/retry.js` - Exponential backoff retry logic
- `backend/src/shared/audit.js` - Financial audit logging
- `backend/src/shared/idempotency.js` - Duplicate request prevention
- `backend/src/shared/archival.js` - Transaction retention/archival

**Modified files:**
- `backend/src/index.js` - Added metrics, health checks, structured logging
- `backend/src/routes/transfers.js` - Added idempotency middleware
- `backend/src/services/transfer.js` - Integrated audit logging and metrics
- `backend/src/db/migrate.js` - Added audit_log and archive tables

**Dependencies added:**
- `pino` - Fast structured JSON logging
- `prom-client` - Prometheus metrics client

---

## Frontend Architecture

The frontend is built with TypeScript, React, and TanStack Router. Components are organized into a modular structure that promotes reusability and maintainability.

### Directory Structure

```
frontend/src/
├── components/
│   ├── icons/                 # SVG icon components
│   │   ├── index.ts          # Barrel export
│   │   ├── ArrowIcon.tsx     # Transaction direction arrows
│   │   ├── BankIcon.tsx      # Bank account icon
│   │   ├── CardIcon.tsx      # Credit/debit card icon
│   │   ├── CloseIcon.tsx     # Close/dismiss button icon
│   │   └── SpinnerIcon.tsx   # Loading spinner
│   ├── wallet/               # Wallet feature components
│   │   ├── index.ts          # Barrel export
│   │   ├── WalletOverview.tsx    # Quick actions (deposit, cashout)
│   │   ├── TransactionHistory.tsx # Transaction list
│   │   ├── PaymentMethodsTab.tsx  # Payment methods management
│   │   ├── DepositForm.tsx        # Add money form
│   │   ├── CashoutForm.tsx        # Withdraw money form
│   │   ├── RecentCashouts.tsx     # Cashout history list
│   │   ├── PaymentMethodItem.tsx  # Single payment method display
│   │   └── AddBankForm.tsx        # Bank linking form
│   ├── request/              # Payment request components
│   │   ├── index.ts          # Barrel export
│   │   ├── CreateRequestForm.tsx  # New request form
│   │   ├── ReceivedRequests.tsx   # Incoming requests list
│   │   ├── SentRequests.tsx       # Outgoing requests list
│   │   ├── RequestCard.tsx        # Single request display
│   │   ├── RequestStatusBadge.tsx # Status indicator badge
│   │   ├── UserSearchDropdown.tsx # User autocomplete search
│   │   └── AmountInput.tsx        # Currency input field
│   ├── Avatar.tsx            # User avatar with fallback
│   ├── Button.tsx            # Reusable button component
│   ├── Input.tsx             # Form input components
│   ├── Layout.tsx            # App shell/navigation
│   ├── LoadingSpinner.tsx    # Loading state indicator
│   └── TransactionCard.tsx   # Feed transaction display
├── routes/                   # TanStack Router page components
│   ├── __root.tsx           # Root layout
│   ├── index.tsx            # Home/feed page
│   ├── login.tsx            # Login page
│   ├── register.tsx         # Registration page
│   ├── pay.tsx              # Send payment page
│   ├── request.tsx          # Request money page
│   ├── wallet.tsx           # Wallet management page
│   └── profile.tsx          # User profile page
├── services/
│   └── api.ts               # API client functions
├── stores/
│   └── index.ts             # Zustand state stores
├── types/
│   └── index.ts             # TypeScript type definitions
└── utils/
    └── index.ts             # Utility functions (formatCurrency, formatDate, etc.)
```

### Component Design Principles

1. **Feature-Based Organization**: Components are grouped by feature (wallet, request) rather than by type. This keeps related code together and makes it easier to understand the full feature.

2. **Barrel Exports**: Each feature directory has an `index.ts` that re-exports all public components. This provides clean imports:
   ```typescript
   import { WalletOverview, TransactionHistory } from '../components/wallet';
   ```

3. **Icon Components**: SVG icons are extracted into separate components rather than inlined. This improves readability and enables reuse across the application.

4. **Single Responsibility**: Each component handles one concern:
   - `DepositForm` handles deposit logic and UI
   - `CashoutForm` handles cashout logic and UI
   - `WalletOverview` orchestrates the quick actions section

5. **Props for Configuration**: Components use props for all configuration:
   - `onSuccess` callbacks for parent notification
   - `isLoading` for loading states
   - `variant` for styling variations

6. **JSDoc Documentation**: All components include JSDoc comments describing:
   - Component purpose
   - Props documentation
   - Important implementation notes

### Route Components

Route components (`/routes/*.tsx`) serve as page-level orchestrators:

- They manage tab state and navigation
- They connect to Zustand stores for data
- They compose feature components to build the page
- They remain lean by delegating to sub-components

### State Management

- **Zustand Stores**: Global state for auth, wallet, and requests
- **Local State**: Component-specific UI state (forms, tabs, loading)
- **Props Drilling**: Limited to 1-2 levels; deeper needs trigger extraction

### Styling

- **Tailwind CSS**: Utility-first styling for rapid development
- **Consistent Patterns**:
  - `rounded-lg shadow-sm` for cards
  - `bg-venmo-blue text-white` for primary actions
  - `text-gray-500` for secondary text

