# Payment System - Architecture Design

## System Overview

A transaction processing and payment platform that handles payment authorization, capture, refunds, and multi-currency conversions with built-in fraud detection.

## Requirements

### Functional Requirements

- **Payment processing**: Authorize, capture, and settle payments via card networks and bank transfers
- **Refunds**: Full and partial refunds with proper ledger accounting
- **Multi-currency**: Support 10+ currencies with real-time exchange rate lookups
- **Fraud detection**: Rule-based scoring with velocity checks and device fingerprinting
- **Merchant management**: Onboarding, API key management, and webhook configuration
- **Reconciliation**: Daily settlement reports and dispute handling

### Non-Functional Requirements

- **Scalability**: Handle 500 RPS peak with horizontal scaling to 2,000 RPS
- **Availability**: 99.9% uptime (8.7 hours downtime/year budget)
- **Latency**: p50 < 200ms, p99 < 800ms for payment authorization
- **Consistency**: Strong consistency for ledger writes; eventual consistency acceptable for analytics

## Capacity Estimation

**Local development target**: Simulate a mid-sized payment processor

| Metric | Value | Sizing Implication |
|--------|-------|-------------------|
| Daily transactions | 2M | ~23 RPS average, 500 RPS peak |
| Average payload | 2 KB | 4 GB/day ingress |
| Transaction records | 60M/month | ~15 GB/month PostgreSQL growth |
| Ledger entries | 180M/month (3x transactions) | ~25 GB/month |
| Active merchants | 10,000 | Negligible metadata storage |
| Webhook events | 4M/day | 100 RPS to webhook workers |

**Component sizing for local dev (3-instance setup)**:
- PostgreSQL: 50 GB disk, 2 GB RAM
- Valkey/Redis: 512 MB (rate limits, idempotency keys, session cache)
- RabbitMQ: 256 MB, 10K messages in flight max
- API servers: 3 instances on ports 3001, 3002, 3003

## High-Level Architecture

```
                                    [Load Balancer :3000]
                                           |
                    +----------------------+----------------------+
                    |                      |                      |
              [API Server :3001]    [API Server :3002]    [API Server :3003]
                    |                      |                      |
                    +----------------------+----------------------+
                                           |
                    +----------------------+----------------------+
                    |                      |                      |
              [PostgreSQL]           [Valkey/Redis]         [RabbitMQ]
              (Primary DB)           (Cache + Locks)     (Async Processing)

                              +------------+------------+
                              |            |            |
                        [Webhook      [Fraud        [Settlement
                         Worker]       Worker]        Worker]
```

### Core Components

1. **API Gateway/Load Balancer** (nginx on :3000)
   - Routes requests round-robin to API servers
   - Terminates TLS in production
   - Rate limiting enforcement point

2. **Payment API Service** (Node.js + Express on :3001-3003)
   - Handles payment lifecycle: authorize, capture, void, refund
   - Validates idempotency keys before processing
   - Publishes events to RabbitMQ for async processing

3. **PostgreSQL** (Primary data store on :5432)
   - Transactions, ledger entries, merchants, customers
   - Uses row-level locking for balance updates
   - Stores audit trail for compliance

4. **Valkey/Redis** (:6379)
   - Idempotency key storage (TTL: 24 hours)
   - Rate limit counters (sliding window)
   - Distributed locks for concurrent payment handling
   - Session cache for admin dashboard

5. **RabbitMQ** (:5672)
   - Queues: `webhook.delivery`, `fraud.scoring`, `settlement.batch`, `notifications`
   - Dead-letter queues for failed message retry

6. **Background Workers**
   - **Webhook Worker**: Delivers payment events to merchant endpoints with exponential backoff
   - **Fraud Worker**: Async fraud scoring for post-authorization review
   - **Settlement Worker**: Batches transactions for daily settlement files

## Data Model

### Database Schema

```sql
-- Core tables with PostgreSQL

CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    api_key_hash VARCHAR(64) NOT NULL,  -- SHA-256 of API key
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

### Core Endpoints

**Authentication**: API key in `Authorization: Bearer sk_live_xxx` header

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

**Request/Response Example**:

```json
// POST /v1/payments
// Headers: Authorization: Bearer sk_live_xxx, Idempotency-Key: order_12345
{
  "amount": 5000,
  "currency": "usd",
  "payment_method_id": "pm_abc123",
  "description": "Order #12345",
  "capture": true,
  "metadata": { "order_id": "12345" }
}

// Response 201
{
  "id": "txn_xyz789",
  "status": "captured",
  "amount": 5000,
  "currency": "usd",
  "captured_amount": 5000,
  "refunded_amount": 0,
  "fraud_score": 12,
  "created_at": "2025-01-15T10:30:00Z"
}
```

## Request Flow

### Payment Authorization Flow

```
1. Client -> API Server: POST /v1/payments (with Idempotency-Key header)

2. API Server:
   a. Validate API key -> fetch merchant from cache or DB
   b. Check Valkey for existing idempotency key
      - If exists: return cached response (no processing)
   c. Acquire distributed lock: LOCK payment:{idempotency_key}
   d. Validate request payload
   e. Rate limit check (Valkey sliding window)

3. API Server -> Fraud Service (inline, <50ms budget):
   a. Calculate fraud score based on:
      - Velocity (transactions per hour for this card)
      - Device fingerprint match
      - Geolocation vs billing address
   b. If score > 80: auto-decline

4. API Server -> PostgreSQL (transaction):
   BEGIN;
   INSERT INTO transactions (...) VALUES (...);
   INSERT INTO ledger_entries (...) VALUES (...);  -- Hold funds
   INSERT INTO audit_log (...) VALUES (...);
   COMMIT;

5. API Server -> Valkey:
   SET idempotency:{merchant}:{key} {response} EX 86400

6. API Server -> RabbitMQ:
   Publish to webhook.delivery queue
   Publish to fraud.scoring queue (async deep analysis)

7. API Server -> Client: 201 Created with payment object

8. Release distributed lock
```

### Refund Flow

```
1. Client -> API Server: POST /v1/payments/:id/refund { amount: 2500 }

2. API Server:
   a. Validate API key and ownership of transaction
   b. Acquire lock: LOCK refund:{transaction_id}
   c. Validate: captured_amount - refunded_amount >= requested_amount

3. API Server -> PostgreSQL (transaction):
   BEGIN;
   UPDATE transactions SET refunded_amount = refunded_amount + 2500;
   INSERT INTO ledger_entries (...);  -- Credit customer, debit merchant
   INSERT INTO audit_log (...);
   COMMIT;

4. API Server -> RabbitMQ:
   Publish refund.created webhook event

5. Return updated payment object
```

## Key Design Decisions

### Transaction Consistency

**Problem**: Payment operations must be atomic - we cannot have partial state where money is debited but transaction record is missing.

**Solution**:
- Use PostgreSQL transactions with SERIALIZABLE isolation for ledger writes
- Idempotency keys prevent duplicate charges on retry
- Two-phase approach: authorize (hold funds) then capture (settle)

```javascript
// Idempotency implementation
async function processPayment(merchantId, idempotencyKey, payload) {
  const cacheKey = `idempotency:${merchantId}:${idempotencyKey}`;

  // Check cache first
  const cached = await valkey.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Acquire distributed lock
  const lock = await valkey.set(`lock:${cacheKey}`, '1', 'NX', 'EX', 30);
  if (!lock) throw new ConflictError('Request in progress');

  try {
    const result = await db.transaction(async (tx) => {
      // Process payment within transaction
      const txn = await tx.insert(transactions).values({...}).returning();
      await tx.insert(ledgerEntries).values([...]);
      return txn;
    });

    // Cache response for 24 hours
    await valkey.setex(cacheKey, 86400, JSON.stringify(result));
    return result;
  } finally {
    await valkey.del(`lock:${cacheKey}`);
  }
}
```

### Idempotency Semantics

- Idempotency keys are scoped per merchant (same key from different merchants = different operations)
- Keys expire after 24 hours
- Subsequent requests with same key return cached response without reprocessing
- If original request failed, retry will attempt processing again (failure is not cached)

### Multi-Currency Handling

- All amounts stored in smallest currency unit (cents, pence)
- Exchange rates fetched from external service and cached for 5 minutes
- Merchant settles in their configured currency
- FX conversion happens at capture time, locked rate stored on transaction

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Application** | Node.js + Express + TypeScript | Fast iteration, good async I/O for payment APIs |
| **Data** | PostgreSQL 16 | ACID compliance critical for financial data |
| **Cache** | Valkey (Redis-compatible) | Idempotency, rate limits, distributed locks |
| **Queue** | RabbitMQ | Reliable delivery, DLQ support, good for webhook retry |
| **Load Balancer** | nginx | Simple local setup, sticky sessions for admin |
| **Monitoring** | Prometheus + Grafana | Metrics collection and visualization |

## Caching Strategy

### Cache-Aside Pattern

| Data | Cache Location | TTL | Invalidation |
|------|---------------|-----|--------------|
| Merchant config | Valkey | 5 min | On update via API |
| Exchange rates | Valkey | 5 min | TTL expiry |
| Idempotency responses | Valkey | 24 hours | TTL expiry |
| Rate limit counters | Valkey | 1 min sliding | Automatic |

### Rate Limiting (Valkey)

```javascript
// Sliding window rate limiter
async function checkRateLimit(merchantId, limit = 100, windowSecs = 60) {
  const key = `ratelimit:${merchantId}`;
  const now = Date.now();
  const windowStart = now - (windowSecs * 1000);

  // Remove old entries, add current, count
  const multi = valkey.multi();
  multi.zremrangebyscore(key, 0, windowStart);
  multi.zadd(key, now, `${now}-${Math.random()}`);
  multi.zcard(key);
  multi.expire(key, windowSecs);

  const results = await multi.exec();
  const count = results[2][1];

  if (count > limit) {
    throw new RateLimitError(`Rate limit exceeded: ${count}/${limit}`);
  }
  return { remaining: limit - count, reset: windowStart + (windowSecs * 1000) };
}
```

## Message Queue Design (RabbitMQ)

### Queue Topology

```
Exchange: payment.events (topic)
  |
  +-- Queue: webhook.delivery
  |     Routing key: payment.*, refund.*
  |     DLQ: webhook.delivery.dlq (after 5 retries)
  |
  +-- Queue: fraud.scoring
  |     Routing key: payment.authorized
  |
  +-- Queue: settlement.batch
        Routing key: payment.captured
```

### Delivery Semantics

- **At-least-once delivery**: Workers must be idempotent
- **Retry with backoff**: 1s, 5s, 30s, 2min, 10min, then DLQ
- **Prefetch limit**: 10 messages per worker to prevent memory bloat

### Webhook Delivery Worker

```javascript
// Exponential backoff for webhook retries
const RETRY_DELAYS = [1000, 5000, 30000, 120000, 600000]; // ms

async function processWebhook(webhook) {
  try {
    const signature = generateSignature(webhook.payload, merchant.webhookSecret);
    const response = await fetch(merchant.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Webhook-ID': webhook.id,
      },
      body: JSON.stringify(webhook.payload),
      timeout: 10000,
    });

    if (response.ok) {
      await db.update(webhooks).set({ status: 'delivered' }).where(eq(webhooks.id, webhook.id));
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    const nextDelay = RETRY_DELAYS[webhook.attempts] || null;
    if (nextDelay) {
      await db.update(webhooks).set({
        attempts: webhook.attempts + 1,
        next_retry_at: new Date(Date.now() + nextDelay),
        last_error: error.message,
      }).where(eq(webhooks.id, webhook.id));
      // Re-queue with delay
      channel.sendToQueue('webhook.delivery', Buffer.from(JSON.stringify(webhook)), {
        headers: { 'x-delay': nextDelay },
      });
    } else {
      await db.update(webhooks).set({ status: 'failed' }).where(eq(webhooks.id, webhook.id));
    }
  }
}
```

## Security Considerations

### Authentication and Authorization

| Endpoint Type | Auth Method | Details |
|--------------|-------------|---------|
| Merchant API | API Key (Bearer token) | `sk_live_*` / `sk_test_*` prefixes |
| Admin Dashboard | Session cookie | Express-session + Valkey store |
| Webhook verification | HMAC-SHA256 signature | Shared secret per merchant |

### API Key Management

```javascript
// API key generation and validation
function generateApiKey(environment = 'live') {
  const prefix = environment === 'live' ? 'sk_live_' : 'sk_test_';
  const key = prefix + crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { key, hash };  // Store hash, return key to merchant once
}

async function validateApiKey(bearerToken) {
  const hash = crypto.createHash('sha256').update(bearerToken).digest('hex');
  const merchant = await db.select().from(merchants).where(eq(merchants.apiKeyHash, hash)).limit(1);
  if (!merchant.length || merchant[0].status !== 'active') {
    throw new UnauthorizedError('Invalid API key');
  }
  return merchant[0];
}
```

### RBAC for Admin Operations

```javascript
// Role definitions
const ROLES = {
  support: ['read:transactions', 'read:merchants'],
  operations: ['read:transactions', 'read:merchants', 'write:refunds'],
  admin: ['read:*', 'write:*', 'manage:merchants'],
};

// Middleware
function requirePermission(permission) {
  return (req, res, next) => {
    const userPerms = ROLES[req.session.user.role] || [];
    const hasPermission = userPerms.some(p =>
      p === permission || p === 'read:*' || p === 'write:*'
    );
    if (!hasPermission) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
```

### Data Protection

- Card numbers never stored; tokenized via payment processor
- PII encrypted at rest (PostgreSQL pgcrypto for email/name)
- TLS 1.3 for all external communication
- API keys hashed with SHA-256 before storage

## Observability

### Metrics (Prometheus)

```javascript
// Key metrics to expose at /metrics
const metrics = {
  // Latency histograms
  payment_request_duration_seconds: new Histogram({
    name: 'payment_request_duration_seconds',
    help: 'Payment API request latency',
    labelNames: ['method', 'endpoint', 'status'],
    buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  }),

  // Counters
  payment_total: new Counter({
    name: 'payment_total',
    help: 'Total payments processed',
    labelNames: ['status', 'currency'],
  }),

  webhook_delivery_total: new Counter({
    name: 'webhook_delivery_total',
    help: 'Webhook delivery attempts',
    labelNames: ['status'],
  }),

  // Gauges
  queue_depth: new Gauge({
    name: 'rabbitmq_queue_depth',
    help: 'Messages waiting in queue',
    labelNames: ['queue'],
  }),
};
```

### SLI Dashboard Queries (Grafana)

```promql
# Availability: Successful responses / Total responses
sum(rate(payment_request_duration_seconds_count{status=~"2.."}[5m]))
/ sum(rate(payment_request_duration_seconds_count[5m]))

# Latency p99
histogram_quantile(0.99, sum(rate(payment_request_duration_seconds_bucket[5m])) by (le))

# Error rate by type
sum(rate(payment_total{status="failed"}[5m])) by (currency)
```

### Alert Thresholds

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | Error rate > 1% for 5 min | Critical |
| High latency | p99 > 2s for 5 min | Warning |
| Queue backup | Queue depth > 1000 for 10 min | Warning |
| Webhook failures | Failure rate > 5% for 15 min | Warning |
| DB connection exhausted | Active connections > 80% pool | Critical |

### Structured Logging

```javascript
// Log format for payment events
logger.info({
  event: 'payment.processed',
  transaction_id: txn.id,
  merchant_id: merchant.id,
  amount: txn.amount,
  currency: txn.currency,
  status: txn.status,
  duration_ms: endTime - startTime,
  fraud_score: txn.fraudScore,
  trace_id: req.headers['x-trace-id'],
});
```

### Distributed Tracing

- Generate `trace_id` at load balancer or first API server
- Pass through all service calls in headers
- Store on audit_log entries for correlation
- Use OpenTelemetry SDK for span creation

## Failure Handling

### Retry Strategy with Idempotency

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Payment authorization | 0 (client retries with same key) | N/A | Required |
| Webhook delivery | 5 | Exponential (1s to 10min) | Webhook ID in header |
| Settlement batch | 3 | Fixed 5min | Date-based batch ID |
| Fraud scoring | 2 | 1s, 5s | Transaction ID |

### Circuit Breaker Pattern

```javascript
// Circuit breaker for external payment processor
const processorBreaker = new CircuitBreaker({
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30000,  // 30s open state
});

async function callProcessor(payload) {
  if (processorBreaker.isOpen()) {
    throw new ServiceUnavailableError('Payment processor temporarily unavailable');
  }

  try {
    const result = await processorClient.authorize(payload);
    processorBreaker.recordSuccess();
    return result;
  } catch (error) {
    processorBreaker.recordFailure();
    throw error;
  }
}
```

### Disaster Recovery (Local Dev Simulation)

For local development, simulate failure scenarios:

1. **PostgreSQL failover**: Run primary on :5432, replica on :5433
   ```bash
   # Promote replica
   docker exec postgres-replica pg_ctl promote
   ```

2. **Valkey cluster mode**: 3-node cluster for lock availability
   ```yaml
   # docker-compose.yml
   valkey-node-1:
     command: valkey-server --cluster-enabled yes --cluster-node-timeout 5000
   ```

3. **Backup/restore testing**:
   ```bash
   # Daily backup
   pg_dump -Fc payment_system > backup_$(date +%Y%m%d).dump

   # Restore
   pg_restore -d payment_system backup_20250115.dump
   ```

### Graceful Degradation

- If fraud service is down: approve payments with score=50, flag for manual review
- If webhook queue is full: store in PostgreSQL overflow table, process later
- If Valkey is down: fall back to DB-based rate limiting (slower but functional)

## Cost Tradeoffs

### Local Development Focus

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| PostgreSQL for everything | Simpler ops vs. specialized stores | Learning project; avoid operational complexity |
| Valkey vs. Redis | Open source vs. managed | No license concerns, full feature parity |
| RabbitMQ vs. Kafka | Simpler setup vs. higher throughput | Webhook delivery doesn't need Kafka's scale |
| Single-region | No geo-redundancy | Local dev; add multi-region when studying DR |

### Scaling Cost Considerations

If this were production:

| Component | Local Dev | Production Estimate |
|-----------|-----------|---------------------|
| PostgreSQL | Single instance | RDS db.r5.xlarge ($400/mo) + read replicas |
| Cache | 512 MB Valkey | ElastiCache r6g.large ($200/mo) |
| Queue | Single RabbitMQ | Amazon MQ mq.m5.large ($300/mo) |
| Compute | 3 containers | 6x c5.xlarge ECS tasks ($600/mo) |
| **Total** | ~$0 (local) | ~$1,500/mo baseline |

### Storage Tiering Strategy

| Data Age | Storage | Cost Tier |
|----------|---------|-----------|
| 0-30 days | PostgreSQL (hot) | High (SSD) |
| 30-365 days | PostgreSQL (archive partition) | Medium |
| 365+ days | S3/MinIO (Parquet exports) | Low |

```sql
-- Partition transactions by month for archival
CREATE TABLE transactions (
    -- columns as above
) PARTITION BY RANGE (created_at);

CREATE TABLE transactions_2025_01 PARTITION OF transactions
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

## Scalability Considerations

### Horizontal Scaling

- **API servers**: Stateless; add more instances behind load balancer
- **Workers**: Scale independently based on queue depth
- **Database**: Read replicas for reporting queries; primary for writes

### Sharding Strategy (Future)

If transaction volume exceeds single-node PostgreSQL:
- Shard by `merchant_id` (hash-based)
- Each shard handles ~20% of traffic (5 shards)
- Cross-shard queries via application-level aggregation

### Connection Pooling

```javascript
// PostgreSQL pool configuration
const pool = new Pool({
  max: 20,  // Per API server instance
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// With 3 API servers: 60 connections total
// PostgreSQL default max_connections: 100
// Leave headroom for admin connections and workers
```

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Why Chosen |
|----------|--------|-------------|------------|
| Sync fraud check | Inline (<50ms) | Async only | Better UX; decline bad payments immediately |
| Idempotency storage | Valkey | PostgreSQL | Faster lookups; TTL built-in |
| Ledger model | Double-entry in SQL | Event sourcing | Simpler for learning; sufficient for use case |
| Webhook delivery | RabbitMQ + worker | Direct HTTP in request | Decouples merchant latency from payment response |

## Future Optimizations

1. **Read replicas**: Route GET requests to replicas to reduce primary load
2. **Materialized views**: Pre-aggregate daily transaction summaries
3. **GraphQL**: Consider for admin dashboard to reduce over-fetching
4. **Event sourcing**: If audit requirements become complex, consider full event log
5. **Multi-region**: Active-passive setup with PostgreSQL logical replication
