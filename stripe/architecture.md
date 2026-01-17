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

- **Latency**: < 500ms for payment authorization
- **Availability**: 99.999% for payment processing
- **Accuracy**: Zero tolerance for financial errors
- **Security**: PCI DSS Level 1 compliance

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
│            (Rate limiting, Auth, Idempotency)                   │
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
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │              Card Networks                    │
│   - Ledger      │              - Visa, MC, Amex                 │
│   - Merchants   │              - Authorization                  │
│   - Accounts    │              - Settlement                     │
└─────────────────┴───────────────────────────────────────────────┘
```

---

## Core Components

### 1. Payment Intent Flow

**Two-Phase Payment:**
```javascript
// Step 1: Create Payment Intent
async function createPaymentIntent(merchantId, amount, currency, idempotencyKey) {
  // Check idempotency
  const existing = await redis.get(`idempotency:${idempotencyKey}`)
  if (existing) {
    return JSON.parse(existing)
  }

  const intent = await db.transaction(async (tx) => {
    // Create intent record
    const intent = await tx.query(`
      INSERT INTO payment_intents (merchant_id, amount, currency, status)
      VALUES ($1, $2, $3, 'requires_payment_method')
      RETURNING *
    `, [merchantId, amount, currency])

    return intent.rows[0]
  })

  // Store for idempotency (24 hours)
  await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify(intent))

  return intent
}

// Step 2: Confirm Payment Intent
async function confirmPaymentIntent(intentId, paymentMethodId) {
  const intent = await getPaymentIntent(intentId)

  if (intent.status !== 'requires_payment_method') {
    throw new Error('Invalid intent state')
  }

  // Get payment method (tokenized card)
  const paymentMethod = await getPaymentMethod(paymentMethodId)

  // Risk assessment
  const riskScore = await fraudService.assessRisk({
    intent,
    paymentMethod,
    merchantId: intent.merchant_id
  })

  if (riskScore > 0.8) {
    await updateIntent(intentId, 'requires_action') // 3D Secure
    return { status: 'requires_action', action: '3ds_redirect' }
  }

  // Authorize with card network
  const authResult = await cardNetwork.authorize({
    amount: intent.amount,
    currency: intent.currency,
    cardToken: paymentMethod.card_token,
    merchantId: intent.merchant_id
  })

  if (authResult.approved) {
    await db.transaction(async (tx) => {
      // Update intent
      await tx.query(`
        UPDATE payment_intents
        SET status = 'succeeded', auth_code = $2
        WHERE id = $1
      `, [intentId, authResult.authCode])

      // Create ledger entries
      await createLedgerEntries(tx, {
        type: 'charge',
        amount: intent.amount,
        merchantId: intent.merchant_id,
        intentId
      })
    })

    // Send webhook
    await webhookService.send(intent.merchant_id, 'payment_intent.succeeded', intent)

    return { status: 'succeeded' }
  }

  await updateIntent(intentId, 'failed', authResult.declineCode)
  return { status: 'failed', declineCode: authResult.declineCode }
}
```

### 2. Double-Entry Ledger

**Accounting Entries:**
```javascript
async function createLedgerEntries(tx, { type, amount, merchantId, intentId }) {
  const entries = []

  if (type === 'charge') {
    // Debit customer funds receivable
    entries.push({
      account: 'funds_receivable',
      debit: amount,
      credit: 0
    })

    // Credit merchant payable (minus fees)
    const fee = Math.round(amount * 0.029 + 30) // 2.9% + 30¢
    entries.push({
      account: `merchant:${merchantId}:payable`,
      debit: 0,
      credit: amount - fee
    })

    // Credit revenue (fees)
    entries.push({
      account: 'revenue:transaction_fees',
      debit: 0,
      credit: fee
    })
  }

  // Insert all entries atomically
  for (const entry of entries) {
    await tx.query(`
      INSERT INTO ledger_entries
        (account, debit, credit, intent_id, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [entry.account, entry.debit, entry.credit, intentId])
  }

  // Verify debits = credits (invariant)
  const totals = entries.reduce((acc, e) => ({
    debit: acc.debit + e.debit,
    credit: acc.credit + e.credit
  }), { debit: 0, credit: 0 })

  if (totals.debit !== totals.credit) {
    throw new Error('Ledger imbalance detected')
  }
}
```

### 3. Idempotency Handling

**Preventing Duplicate Charges:**
```javascript
class IdempotencyMiddleware {
  async handle(req, res, next) {
    const idempotencyKey = req.headers['idempotency-key']

    if (!idempotencyKey) {
      return next()
    }

    const cacheKey = `idempotency:${req.merchantId}:${idempotencyKey}`

    // Try to acquire lock
    const acquired = await redis.set(cacheKey + ':lock', '1', 'NX', 'EX', 60)

    if (!acquired) {
      // Another request is processing
      return res.status(409).json({ error: 'Request in progress' })
    }

    try {
      // Check for cached response
      const cached = await redis.get(cacheKey)
      if (cached) {
        const { statusCode, body } = JSON.parse(cached)
        return res.status(statusCode).json(body)
      }

      // Capture response
      const originalJson = res.json.bind(res)
      res.json = (body) => {
        // Cache successful responses for 24 hours
        if (res.statusCode >= 200 && res.statusCode < 300) {
          redis.setex(cacheKey, 86400, JSON.stringify({
            statusCode: res.statusCode,
            body
          }))
        }
        return originalJson(body)
      }

      next()
    } finally {
      // Release lock
      await redis.del(cacheKey + ':lock')
    }
  }
}
```

### 4. Fraud Detection

**Risk Scoring:**
```javascript
class FraudService {
  async assessRisk(context) {
    const { intent, paymentMethod, merchantId } = context
    const scores = []

    // Velocity checks
    const recentCharges = await this.getRecentCharges(paymentMethod.id, '1 hour')
    if (recentCharges > 3) {
      scores.push({ rule: 'velocity_1h', score: 0.4 })
    }

    // Geographic checks
    const cardCountry = paymentMethod.card_country
    const ipCountry = await geoip.lookup(context.ipAddress)
    if (cardCountry !== ipCountry) {
      scores.push({ rule: 'geo_mismatch', score: 0.3 })
    }

    // Amount checks
    const avgAmount = await this.getMerchantAvgAmount(merchantId)
    if (intent.amount > avgAmount * 5) {
      scores.push({ rule: 'high_amount', score: 0.2 })
    }

    // Device fingerprint
    const deviceRisk = await this.checkDeviceReputation(context.deviceFingerprint)
    scores.push({ rule: 'device', score: deviceRisk })

    // ML model
    const mlScore = await this.mlPredict({
      amount: intent.amount,
      merchantCategory: context.merchantCategory,
      cardBin: paymentMethod.card_bin,
      hourOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay()
    })
    scores.push({ rule: 'ml_model', score: mlScore * 0.5 })

    // Combine scores
    const totalScore = scores.reduce((sum, s) => sum + s.score, 0)
    const normalizedScore = Math.min(totalScore, 1)

    // Log for analysis
    await this.logRiskAssessment(intent.id, scores, normalizedScore)

    return normalizedScore
  }
}
```

### 5. Webhook Delivery

**Reliable Event Delivery:**
```javascript
class WebhookService {
  async send(merchantId, eventType, data) {
    const merchant = await getMerchant(merchantId)
    if (!merchant.webhook_url) return

    const event = {
      id: `evt_${uuid()}`,
      type: eventType,
      data,
      created: Date.now()
    }

    // Sign payload
    const signature = this.signPayload(event, merchant.webhook_secret)

    // Queue for delivery with retries
    await queue.add('webhook_delivery', {
      merchantId,
      url: merchant.webhook_url,
      event,
      signature
    }, {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 1000 // 1s, 2s, 4s, 8s, 16s
      }
    })
  }

  async deliverWebhook(job) {
    const { url, event, signature } = job.data

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signature
      },
      body: JSON.stringify(event),
      timeout: 30000
    })

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`)
    }

    // Log successful delivery
    await db.query(`
      INSERT INTO webhook_deliveries (event_id, merchant_id, status, delivered_at)
      VALUES ($1, $2, 'delivered', NOW())
    `, [event.id, job.data.merchantId])
  }

  signPayload(payload, secret) {
    const timestamp = Math.floor(Date.now() / 1000)
    const signedPayload = `${timestamp}.${JSON.stringify(payload)}`
    const signature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex')

    return `t=${timestamp},v1=${signature}`
  }
}
```

---

## Database Schema

```sql
-- Merchants
CREATE TABLE merchants (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  email VARCHAR(200) NOT NULL,
  webhook_url VARCHAR(500),
  webhook_secret VARCHAR(100),
  api_key_hash VARCHAR(100),
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Payment Intents
CREATE TABLE payment_intents (
  id UUID PRIMARY KEY,
  merchant_id UUID REFERENCES merchants(id),
  amount INTEGER NOT NULL, -- In cents
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(30) NOT NULL,
  payment_method_id UUID,
  auth_code VARCHAR(50),
  decline_code VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Payment Methods (tokenized cards)
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY,
  customer_id UUID,
  card_token VARCHAR(100), -- Encrypted
  card_last4 VARCHAR(4),
  card_brand VARCHAR(20),
  card_exp_month INTEGER,
  card_exp_year INTEGER,
  card_country VARCHAR(2),
  card_bin VARCHAR(6),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Ledger Entries (double-entry)
CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  account VARCHAR(100) NOT NULL,
  debit INTEGER DEFAULT 0,
  credit INTEGER DEFAULT 0,
  intent_id UUID REFERENCES payment_intents(id),
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT positive_amounts CHECK (debit >= 0 AND credit >= 0)
);

CREATE INDEX idx_ledger_account ON ledger_entries(account);
CREATE INDEX idx_ledger_intent ON ledger_entries(intent_id);

-- Refunds
CREATE TABLE refunds (
  id UUID PRIMARY KEY,
  payment_intent_id UUID REFERENCES payment_intents(id),
  amount INTEGER NOT NULL,
  reason VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Disputes (chargebacks)
CREATE TABLE disputes (
  id UUID PRIMARY KEY,
  payment_intent_id UUID REFERENCES payment_intents(id),
  amount INTEGER NOT NULL,
  reason VARCHAR(100),
  status VARCHAR(20) DEFAULT 'needs_response',
  evidence_due_by TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Webhook Deliveries
CREATE TABLE webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  event_id VARCHAR(100) NOT NULL,
  merchant_id UUID REFERENCES merchants(id),
  status VARCHAR(20) NOT NULL,
  attempts INTEGER DEFAULT 1,
  last_error TEXT,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Idempotency Keys

**Decision**: Require idempotency keys for all mutating operations

**Rationale**:
- Prevents duplicate charges from network retries
- Allows safe retry logic in client SDKs
- Critical for financial accuracy

### 2. Double-Entry Ledger

**Decision**: Use double-entry bookkeeping for all financial movements

**Rationale**:
- Every transaction balances (debits = credits)
- Complete audit trail
- Easy reconciliation

### 3. Webhook Signatures

**Decision**: Sign all webhook payloads with HMAC

**Rationale**:
- Merchants can verify authenticity
- Prevents replay attacks (timestamp in signature)
- Industry standard pattern

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Idempotency | Per-request key | Database constraints | Flexibility, reliability |
| Ledger | Double-entry | Single-entry | Accuracy, auditability |
| Webhooks | Async with retry | Sync callbacks | Reliability, decoupling |
| Card storage | Tokenization | Encryption | PCI scope reduction |

---

## Capacity Planning and Traffic Sizing

### Target Scale (Local Development Simulation)

For learning purposes, we simulate a mid-sized payment processor:

| Metric | Local Dev Target | Notes |
|--------|------------------|-------|
| DAU (Daily Active Users) | 1,000 merchants | Simulated via load testing |
| MAU (Monthly Active Users) | 5,000 merchants | Includes dormant accounts |
| Peak Payment RPS | 50 req/s | Represents busy checkout period |
| Sustained Payment RPS | 10 req/s | Normal business hours |
| Webhook Delivery RPS | 100 req/s | 2x payment rate (multiple events per payment) |
| Average Payload Size | 2 KB | Payment intent request/response |
| Max Payload Size | 50 KB | Webhook with full event data |

### Component Sizing

**PostgreSQL (Primary Database):**
```
Daily Transactions: 50 RPS * 3600 * 8 peak hours = 1.44M/day
Ledger Entries: 3 entries per transaction = 4.32M entries/day
Storage Growth: ~500 MB/day (with indexes)

Local Dev Config:
- Connection pool: 10 connections (3 instances = 30 total)
- shared_buffers: 256 MB
- work_mem: 64 MB
- Vacuum: Daily at 3 AM local time
```

**Redis (Idempotency + Cache):**
```
Idempotency Keys: 50 RPS * 86400 sec = 4.32M keys/day
Key Size: ~200 bytes (key + cached response)
Memory: 4.32M * 200 bytes = ~864 MB (with 24h TTL, keys expire)
Peak Memory: ~1 GB

Local Dev Config:
- maxmemory: 1GB
- maxmemory-policy: volatile-lru
- Eviction: Keys with TTL evicted first
```

**Message Queue (BullMQ/Redis):**
```
Webhook Jobs: 100 events/s peak
Job Size: ~5 KB per job (event payload + metadata)
Retry Queue Depth: 1000 jobs max (with exponential backoff)
Queue Memory: ~50 MB

Local Dev Config:
- Concurrency: 10 workers per instance
- Rate limit: 50 jobs/s (prevent overwhelming merchant endpoints)
- Stalled job check: every 30 seconds
```

### Sharding Strategy (Production Simulation)

For local development, we simulate sharding concepts without actual distribution:

```javascript
// Merchant-based sharding simulation
function getShardId(merchantId) {
  // 4 logical shards for local dev
  const hash = crypto.createHash('md5').update(merchantId).digest('hex')
  return parseInt(hash.substring(0, 8), 16) % 4
}

// Shard distribution for 1000 merchants:
// Shard 0: ~250 merchants, ~12.5 RPS
// Shard 1: ~250 merchants, ~12.5 RPS
// Shard 2: ~250 merchants, ~12.5 RPS
// Shard 3: ~250 merchants, ~12.5 RPS
```

---

## Observability

### Metrics (Prometheus)

**Key Metrics to Collect:**

```javascript
// Payment Service Metrics
const metrics = {
  // Request metrics
  payment_requests_total: new Counter({
    name: 'payment_requests_total',
    help: 'Total payment requests',
    labelNames: ['method', 'status', 'merchant_id']
  }),

  payment_request_duration_seconds: new Histogram({
    name: 'payment_request_duration_seconds',
    help: 'Payment request duration',
    labelNames: ['method', 'status'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
  }),

  // Business metrics
  payment_amount_cents: new Histogram({
    name: 'payment_amount_cents',
    help: 'Payment amounts in cents',
    buckets: [100, 500, 1000, 5000, 10000, 50000, 100000]
  }),

  active_payment_intents: new Gauge({
    name: 'active_payment_intents',
    help: 'Currently active payment intents',
    labelNames: ['status']
  }),

  // Fraud metrics
  fraud_score_distribution: new Histogram({
    name: 'fraud_score_distribution',
    help: 'Fraud score distribution',
    buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
  }),

  fraud_blocked_total: new Counter({
    name: 'fraud_blocked_total',
    help: 'Payments blocked by fraud detection',
    labelNames: ['rule']
  }),

  // Webhook metrics
  webhook_deliveries_total: new Counter({
    name: 'webhook_deliveries_total',
    help: 'Webhook delivery attempts',
    labelNames: ['status', 'attempt']
  }),

  webhook_queue_depth: new Gauge({
    name: 'webhook_queue_depth',
    help: 'Current webhook queue size'
  }),

  // Infrastructure metrics
  db_connection_pool_size: new Gauge({
    name: 'db_connection_pool_size',
    help: 'Database connection pool size',
    labelNames: ['state'] // active, idle, waiting
  }),

  redis_memory_bytes: new Gauge({
    name: 'redis_memory_bytes',
    help: 'Redis memory usage'
  }),

  idempotency_cache_hits_total: new Counter({
    name: 'idempotency_cache_hits_total',
    help: 'Idempotency key cache hits'
  })
}
```

### SLI Dashboards

**Service Level Indicators:**

| SLI | Target | Measurement | Alert Threshold |
|-----|--------|-------------|-----------------|
| Availability | 99.99% | Successful responses / Total requests | < 99.9% over 5 min |
| Latency (p50) | < 100ms | payment_request_duration_seconds | > 150ms over 5 min |
| Latency (p99) | < 500ms | payment_request_duration_seconds | > 750ms over 5 min |
| Error Rate | < 0.1% | 5xx responses / Total requests | > 0.5% over 5 min |
| Webhook Delivery | 99.9% | Delivered / Total within 1 hour | < 99% over 15 min |
| Ledger Balance | 100% | Sum(debits) = Sum(credits) | Any imbalance |

**Grafana Dashboard Panels:**

```json
{
  "dashboard": "Stripe Payment System",
  "panels": [
    {
      "title": "Payment Request Rate",
      "query": "rate(payment_requests_total[5m])",
      "type": "graph"
    },
    {
      "title": "Payment Latency (p99)",
      "query": "histogram_quantile(0.99, rate(payment_request_duration_seconds_bucket[5m]))",
      "type": "graph",
      "alert": { "threshold": 0.5, "for": "5m" }
    },
    {
      "title": "Error Rate",
      "query": "rate(payment_requests_total{status=~'5..'}[5m]) / rate(payment_requests_total[5m])",
      "type": "graph",
      "alert": { "threshold": 0.005, "for": "5m" }
    },
    {
      "title": "Fraud Block Rate",
      "query": "rate(fraud_blocked_total[1h])",
      "type": "graph"
    },
    {
      "title": "Webhook Queue Depth",
      "query": "webhook_queue_depth",
      "type": "graph",
      "alert": { "threshold": 500, "for": "10m" }
    },
    {
      "title": "Idempotency Cache Hit Rate",
      "query": "rate(idempotency_cache_hits_total[5m]) / rate(payment_requests_total[5m])",
      "type": "stat"
    }
  ]
}
```

### Structured Logging

**Log Format (JSON):**

```javascript
const logger = pino({
  level: 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  base: {
    service: 'payment-service',
    version: process.env.APP_VERSION,
    environment: process.env.NODE_ENV
  }
})

// Payment request logging
function logPaymentRequest(req, result, duration) {
  logger.info({
    event: 'payment_request',
    trace_id: req.headers['x-trace-id'],
    span_id: generateSpanId(),
    merchant_id: req.merchantId,
    intent_id: result.intentId,
    amount: req.body.amount,
    currency: req.body.currency,
    status: result.status,
    duration_ms: duration,
    idempotency_key: req.headers['idempotency-key'],
    ip_address: hashIp(req.ip), // Hashed for privacy
    user_agent: req.headers['user-agent']
  })
}

// Error logging with context
function logPaymentError(req, error, context) {
  logger.error({
    event: 'payment_error',
    trace_id: req.headers['x-trace-id'],
    merchant_id: req.merchantId,
    error_type: error.constructor.name,
    error_message: error.message,
    error_code: error.code,
    stack: error.stack,
    context
  })
}
```

### Distributed Tracing (OpenTelemetry)

```javascript
const { trace, context, SpanStatusCode } = require('@opentelemetry/api')
const tracer = trace.getTracer('payment-service')

async function confirmPaymentIntent(intentId, paymentMethodId, parentContext) {
  const span = tracer.startSpan('confirmPaymentIntent', {
    attributes: {
      'payment.intent_id': intentId,
      'payment.method_id': paymentMethodId
    }
  }, parentContext)

  try {
    // Fraud check span
    const fraudSpan = tracer.startSpan('fraudService.assessRisk', {}, trace.setSpan(context.active(), span))
    const riskScore = await fraudService.assessRisk({ intentId, paymentMethodId })
    fraudSpan.setAttribute('fraud.score', riskScore)
    fraudSpan.end()

    // Card network authorization span
    const authSpan = tracer.startSpan('cardNetwork.authorize', {}, trace.setSpan(context.active(), span))
    const authResult = await cardNetwork.authorize({ intentId })
    authSpan.setAttribute('auth.approved', authResult.approved)
    authSpan.setAttribute('auth.code', authResult.authCode)
    authSpan.end()

    // Ledger update span
    const ledgerSpan = tracer.startSpan('ledger.createEntries', {}, trace.setSpan(context.active(), span))
    await createLedgerEntries(intentId)
    ledgerSpan.end()

    span.setStatus({ code: SpanStatusCode.OK })
    return { status: 'succeeded' }
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
    span.recordException(error)
    throw error
  } finally {
    span.end()
  }
}
```

### Audit Logging

**Financial Audit Trail:**

```sql
-- Audit log table for compliance
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_type VARCHAR(20) NOT NULL, -- 'merchant', 'admin', 'system'
  actor_id VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  trace_id VARCHAR(100),
  metadata JSONB
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_actor ON audit_log(actor_type, actor_id);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_action ON audit_log(action);
```

```javascript
// Audit logging service
class AuditLogger {
  async log(event) {
    await db.query(`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id,
        old_value, new_value, ip_address, user_agent, trace_id, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      event.actorType,
      event.actorId,
      event.action,
      event.resourceType,
      event.resourceId,
      JSON.stringify(event.oldValue),
      JSON.stringify(event.newValue),
      event.ipAddress,
      event.userAgent,
      event.traceId,
      JSON.stringify(event.metadata)
    ])
  }

  // Required audit events for payment systems
  async logPaymentCreated(intent, context) {
    await this.log({
      actorType: 'merchant',
      actorId: intent.merchant_id,
      action: 'payment_intent.created',
      resourceType: 'payment_intent',
      resourceId: intent.id,
      newValue: { amount: intent.amount, currency: intent.currency },
      ...context
    })
  }

  async logPaymentConfirmed(intent, context) {
    await this.log({
      actorType: 'system',
      actorId: 'payment-service',
      action: 'payment_intent.confirmed',
      resourceType: 'payment_intent',
      resourceId: intent.id,
      oldValue: { status: 'requires_payment_method' },
      newValue: { status: intent.status, auth_code: intent.auth_code },
      ...context
    })
  }

  async logRefundIssued(refund, context) {
    await this.log({
      actorType: 'merchant',
      actorId: refund.merchant_id,
      action: 'refund.created',
      resourceType: 'refund',
      resourceId: refund.id,
      newValue: { amount: refund.amount, reason: refund.reason },
      ...context
    })
  }

  async logApiKeyRotated(merchantId, context) {
    await this.log({
      actorType: 'merchant',
      actorId: merchantId,
      action: 'api_key.rotated',
      resourceType: 'merchant',
      resourceId: merchantId,
      metadata: { key_prefix: context.newKeyPrefix },
      ...context
    })
  }
}
```

### Alert Thresholds

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High Error Rate | > 1% 5xx for 5 min | Critical | Page on-call |
| Payment Latency Spike | p99 > 1s for 5 min | Warning | Investigate |
| Ledger Imbalance | Any debit != credit | Critical | Halt payments, investigate |
| Webhook Queue Backup | > 1000 pending for 10 min | Warning | Scale workers |
| Webhook Delivery Failure | > 5% failed for 15 min | Warning | Check merchant endpoints |
| Redis Memory High | > 80% maxmemory | Warning | Review TTLs |
| DB Connection Pool Exhausted | 0 idle connections for 1 min | Critical | Scale DB or reduce load |
| Fraud Block Rate Spike | > 10% blocked for 5 min | Warning | Review fraud rules |
| Idempotency Lock Contention | > 100 409s per minute | Warning | Check for retry storms |

---

## Failure Handling

### Retry Strategy with Idempotency Keys

**Client-Side Retry Logic:**

```javascript
class StripeClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey
    this.maxRetries = options.maxRetries || 3
    this.baseDelay = options.baseDelay || 500 // ms
  }

  async createPaymentIntent(params) {
    // Generate idempotency key if not provided
    const idempotencyKey = params.idempotencyKey || `pi_${Date.now()}_${randomBytes(8).toString('hex')}`

    return this.requestWithRetry('POST', '/v1/payment_intents', params, idempotencyKey)
  }

  async requestWithRetry(method, path, body, idempotencyKey) {
    let lastError
    let attempt = 0

    while (attempt < this.maxRetries) {
      attempt++

      try {
        const response = await this.makeRequest(method, path, body, idempotencyKey)

        // Success
        return response

      } catch (error) {
        lastError = error

        // Don't retry on client errors (4xx except 409, 429)
        if (error.statusCode >= 400 && error.statusCode < 500) {
          if (error.statusCode === 409) {
            // Request in progress, wait and retry
            await this.delay(this.baseDelay * attempt)
            continue
          }
          if (error.statusCode === 429) {
            // Rate limited, use Retry-After header
            const retryAfter = error.headers['retry-after'] || attempt * 2
            await this.delay(retryAfter * 1000)
            continue
          }
          // Other 4xx errors are not retryable
          throw error
        }

        // Retry on network errors and 5xx
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.statusCode >= 500) {
          const delay = this.baseDelay * Math.pow(2, attempt - 1) + Math.random() * 100
          await this.delay(delay)
          continue
        }

        throw error
      }
    }

    throw lastError
  }

  async makeRequest(method, path, body, idempotencyKey) {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(body),
      timeout: 30000
    })
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
```

**Server-Side Idempotency with Replay Protection:**

```javascript
class IdempotencyService {
  constructor(redis, options = {}) {
    this.redis = redis
    this.lockTTL = options.lockTTL || 60 // seconds
    this.responseTTL = options.responseTTL || 86400 // 24 hours
  }

  async executeWithIdempotency(key, merchantId, operation) {
    const fullKey = `idempotency:${merchantId}:${key}`
    const lockKey = `${fullKey}:lock`

    // Try to acquire lock
    const lockAcquired = await this.redis.set(lockKey, process.pid, 'NX', 'EX', this.lockTTL)

    if (!lockAcquired) {
      // Check if there's already a cached response
      const cached = await this.redis.get(fullKey)
      if (cached) {
        const { response, createdAt } = JSON.parse(cached)
        return { cached: true, response, createdAt }
      }
      // Still processing, tell client to wait
      throw new IdempotencyConflictError('Request with this idempotency key is currently being processed')
    }

    try {
      // Check for cached response (in case lock expired and reacquired)
      const cached = await this.redis.get(fullKey)
      if (cached) {
        return { cached: true, ...JSON.parse(cached) }
      }

      // Execute the operation
      const response = await operation()

      // Cache the response
      await this.redis.setex(fullKey, this.responseTTL, JSON.stringify({
        response,
        createdAt: Date.now()
      }))

      return { cached: false, response }

    } finally {
      // Release lock
      await this.redis.del(lockKey)
    }
  }
}
```

### Circuit Breaker Pattern

**Implementation for External Services:**

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.successThreshold = options.successThreshold || 3
    this.timeout = options.timeout || 30000 // 30 seconds
    this.resetTimeout = options.resetTimeout || 60000 // 1 minute

    this.state = 'CLOSED' // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureTime = null
    this.nextAttempt = null
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new CircuitBreakerOpenError('Circuit breaker is open')
      }
      // Transition to half-open
      this.state = 'HALF_OPEN'
    }

    try {
      const result = await this.withTimeout(operation)
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  async withTimeout(operation) {
    return Promise.race([
      operation(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Operation timed out')), this.timeout)
      )
    ])
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successCount++
      if (this.successCount >= this.successThreshold) {
        this.reset()
      }
    } else {
      this.failureCount = 0
    }
  }

  onFailure() {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN'
      this.nextAttempt = Date.now() + this.resetTimeout
      this.successCount = 0
    }
  }

  reset() {
    this.state = 'CLOSED'
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureTime = null
    this.nextAttempt = null
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt
    }
  }
}

// Usage for card network calls
const cardNetworkBreaker = new CircuitBreaker({
  failureThreshold: 5,
  successThreshold: 3,
  timeout: 10000, // 10 second timeout for card authorization
  resetTimeout: 30000 // Try again after 30 seconds
})

async function authorizePayment(params) {
  return cardNetworkBreaker.execute(async () => {
    return cardNetwork.authorize(params)
  })
}
```

**Circuit Breakers by Service:**

| Service | Failure Threshold | Reset Timeout | Fallback |
|---------|-------------------|---------------|----------|
| Card Network (Visa) | 5 failures in 1 min | 30 seconds | Try alternate processor |
| Card Network (Mastercard) | 5 failures in 1 min | 30 seconds | Try alternate processor |
| Fraud ML Service | 3 failures in 1 min | 15 seconds | Use rule-based scoring only |
| Webhook Delivery | Per-merchant, 10 failures | 5 minutes | Queue for later retry |
| GeoIP Service | 5 failures in 1 min | 1 minute | Skip geo check, log warning |

### Multi-Region Disaster Recovery (Production Simulation)

For local development, we simulate multi-region concepts with multiple instances:

```javascript
// Simulated region configuration
const regions = {
  primary: {
    id: 'us-east-1',
    dbHost: 'localhost:5432',
    redisHost: 'localhost:6379',
    apiPort: 3001
  },
  secondary: {
    id: 'us-west-2',
    dbHost: 'localhost:5433', // Replica
    redisHost: 'localhost:6380',
    apiPort: 3002
  }
}

// Health check for region failover
class RegionHealthChecker {
  async checkRegionHealth(region) {
    const checks = await Promise.all([
      this.checkDatabase(region),
      this.checkRedis(region),
      this.checkCardNetwork()
    ])

    return {
      region: region.id,
      healthy: checks.every(c => c.healthy),
      checks
    }
  }

  async checkDatabase(region) {
    try {
      const start = Date.now()
      await db.query('SELECT 1')
      return { service: 'database', healthy: true, latency: Date.now() - start }
    } catch (error) {
      return { service: 'database', healthy: false, error: error.message }
    }
  }
}

// Failover coordinator
class FailoverCoordinator {
  constructor() {
    this.currentRegion = 'primary'
    this.healthChecker = new RegionHealthChecker()
  }

  async evaluateFailover() {
    const primaryHealth = await this.healthChecker.checkRegionHealth(regions.primary)
    const secondaryHealth = await this.healthChecker.checkRegionHealth(regions.secondary)

    if (!primaryHealth.healthy && secondaryHealth.healthy) {
      await this.initiateFailover('secondary')
    }
  }

  async initiateFailover(targetRegion) {
    logger.warn({ event: 'failover_initiated', from: this.currentRegion, to: targetRegion })

    // Drain in-flight requests (wait up to 30 seconds)
    await this.drainRequests(30000)

    // Switch traffic
    this.currentRegion = targetRegion

    // Verify new region is serving traffic
    await this.verifyFailover()

    logger.info({ event: 'failover_complete', region: targetRegion })
  }
}
```

**DR Runbook for Local Testing:**

```markdown
## Disaster Recovery Test Procedure

### Scenario 1: Primary Database Failure
1. Stop primary PostgreSQL: `docker stop stripe-postgres-primary`
2. Verify API returns 503 for new payments
3. Promote replica: `docker exec stripe-postgres-replica pg_ctl promote`
4. Update connection string in environment
5. Verify payments resume
6. Expected RTO: < 5 minutes

### Scenario 2: Redis Failure
1. Stop Redis: `docker stop stripe-redis`
2. Verify idempotency falls back to database-based locking
3. Verify webhook queue persisted and resumes on restart
4. Restart Redis: `docker start stripe-redis`
5. Expected RTO: < 2 minutes (degraded mode), < 5 minutes (full recovery)

### Scenario 3: Card Network Outage
1. Enable card network mock failure mode
2. Verify circuit breaker opens after 5 failures
3. Verify payments return appropriate error to merchants
4. Verify automatic recovery when mock is disabled
```

### Backup and Restore Testing

**Backup Configuration:**

```yaml
# docker-compose.yml backup configuration
services:
  postgres-backup:
    image: prodrigestivill/postgres-backup-local
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_DB: stripe
      POSTGRES_USER: stripe
      POSTGRES_PASSWORD: stripe_password
      SCHEDULE: "@hourly"
      BACKUP_KEEP_HOURS: 24
      BACKUP_KEEP_DAYS: 7
    volumes:
      - ./backups:/backups
```

**Backup Test Script:**

```bash
#!/bin/bash
# backup-test.sh - Run weekly to verify backup integrity

set -e

BACKUP_DIR="./backups"
TEST_DB="stripe_restore_test"
LATEST_BACKUP=$(ls -t $BACKUP_DIR/*.sql.gz | head -1)

echo "Testing backup: $LATEST_BACKUP"

# Create test database
docker exec stripe-postgres createdb -U stripe $TEST_DB

# Restore backup
gunzip -c $LATEST_BACKUP | docker exec -i stripe-postgres psql -U stripe -d $TEST_DB

# Verify data integrity
MERCHANT_COUNT=$(docker exec stripe-postgres psql -U stripe -d $TEST_DB -t -c "SELECT COUNT(*) FROM merchants")
LEDGER_BALANCE=$(docker exec stripe-postgres psql -U stripe -d $TEST_DB -t -c "SELECT SUM(debit) - SUM(credit) FROM ledger_entries")

echo "Merchants restored: $MERCHANT_COUNT"
echo "Ledger balance check: $LEDGER_BALANCE"

if [ "$LEDGER_BALANCE" != "0" ]; then
  echo "ERROR: Ledger imbalance detected in backup!"
  exit 1
fi

# Cleanup
docker exec stripe-postgres dropdb -U stripe $TEST_DB

echo "Backup verification passed!"
```

**Point-in-Time Recovery Testing:**

```javascript
// PITR test helper
async function testPointInTimeRecovery() {
  const testTimestamp = new Date()

  // Create a test payment
  const testPayment = await createPaymentIntent({
    amount: 1000,
    currency: 'usd',
    merchantId: 'test_merchant',
    idempotencyKey: `pitr_test_${testTimestamp.getTime()}`
  })

  console.log(`Created test payment: ${testPayment.id} at ${testTimestamp.toISOString()}`)

  // Simulate waiting for WAL archival
  await delay(5000)

  // Create another payment we want to "lose"
  const afterPayment = await createPaymentIntent({
    amount: 2000,
    currency: 'usd',
    merchantId: 'test_merchant',
    idempotencyKey: `pitr_after_${Date.now()}`
  })

  console.log(`Created after payment: ${afterPayment.id}`)

  // Instructions for PITR recovery
  console.log(`
    To test PITR recovery:
    1. Stop the database
    2. Restore to timestamp: ${testTimestamp.toISOString()}
    3. Verify payment ${testPayment.id} exists
    4. Verify payment ${afterPayment.id} does NOT exist
  `)
}
```

### Failure Mode Summary

| Failure | Detection | Mitigation | Recovery |
|---------|-----------|------------|----------|
| Network timeout | Request timeout | Retry with idempotency key | Automatic |
| Duplicate request | Idempotency key match | Return cached response | Automatic |
| Database down | Health check failure | Return 503, alert on-call | Manual failover |
| Redis down | Connection error | Fall back to DB locking | Auto-reconnect |
| Card network down | Circuit breaker open | Return decline, try alternate | Auto after reset timeout |
| Webhook endpoint down | HTTP error | Exponential backoff retry | Manual merchant fix |
| Ledger imbalance | Balance check failure | Halt writes, alert critical | Manual investigation |
| Fraud service down | Circuit breaker | Rule-based fallback | Auto after reset |

---

## Implementation Notes

This section documents the critical observability and reliability implementations added to the codebase.

### WHY Idempotency is CRITICAL for Payment Systems

Idempotency is the single most important concept in payment system design. Here's why:

**The Problem: Network Unreliability**
```
Customer clicks "Pay" -> Request sent -> Network timeout -> Did the charge happen?
                                                          -> Customer retries
                                                          -> DOUBLE CHARGE!
```

**The Solution: Idempotency Keys**
```javascript
// Client sends unique key with each logical payment attempt
POST /v1/payment_intents
Headers: {
  'Idempotency-Key': 'order_12345_payment_attempt_1'
}

// Server behavior:
// 1. First request: Process payment, cache result with key
// 2. Retry (same key): Return cached result without reprocessing
// 3. Different key: Process as new payment
```

**Implementation Details:**
- Keys are namespaced per-merchant to prevent cross-merchant conflicts
- Redis provides sub-millisecond lookup with automatic TTL expiration (24 hours)
- Lock acquisition prevents concurrent duplicate requests (returns 409 Conflict)
- Response caching includes status code and body for exact replay
- Keys are validated (max 255 chars) to prevent abuse

**Files:**
- `/backend/src/middleware/idempotency.js` - Express middleware
- `/backend/src/db/redis.js` - Redis helpers for key storage and locking

---

### WHY Audit Logging is Required for Financial Compliance

Audit logging isn't optional for payment systems - it's a legal and regulatory requirement.

**Regulatory Requirements:**
1. **PCI DSS Requirement 10**: "Track and monitor all access to network resources and cardholder data"
2. **SOX Compliance**: Financial records must be immutable and auditable
3. **GDPR Article 30**: Processing activities must be documented
4. **Dispute Resolution**: Evidence for chargeback disputes

**What We Log:**
```javascript
// Every financial operation creates an immutable audit record
{
  id: 'uuid',
  timestamp: '2024-01-15T10:30:00Z',
  actor_type: 'merchant',           // Who performed the action
  actor_id: 'merch_abc123',
  action: 'payment_intent.confirmed', // What action was taken
  resource_type: 'payment_intent',
  resource_id: 'pi_xyz789',
  old_value: { status: 'requires_confirmation' },
  new_value: { status: 'succeeded', auth_code: 'ABC123' },
  ip_address: '192.168.1.1',        // Where it came from
  trace_id: 'trace_123',            // For distributed tracing correlation
  metadata: { charge_id: 'ch_456' }
}
```

**Key Design Decisions:**
- **Append-only table**: No UPDATE or DELETE operations allowed
- **Separate from operational data**: Audit logs are stored in dedicated table
- **Indexed for common queries**: By timestamp, actor, resource, and action
- **Privacy-aware**: IP addresses can be hashed if needed

**Files:**
- `/backend/src/shared/audit.js` - Audit logging service
- `/backend/src/db/init.sql` - `audit_log` table definition

---

### WHY Circuit Breakers Protect Against Payment Processor Outages

Payment systems depend on external services (card networks, fraud services) that can fail. Circuit breakers prevent cascading failures.

**The Problem: Cascade Failure**
```
Card Network Slow -> All requests queue -> Thread pool exhausted
                  -> Database connections exhaust -> Entire API down
                  -> Other merchants affected -> Widespread outage
```

**The Solution: Circuit Breaker Pattern**
```
CLOSED (normal) ─── failures exceed threshold ──> OPEN (failing fast)
      ^                                                 │
      │                                         wait timeout
      │                                                 │
      └────── successes restore confidence ──── HALF-OPEN (testing)
```

**Implementation:**
```javascript
// Using cockatiel library for circuit breaker
const cardNetworkBreaker = createPaymentCircuitBreaker('card_network', {
  halfOpenAfterMs: 30000,        // Try again after 30 seconds
  breaker: new ConsecutiveBreaker(5), // Open after 5 consecutive failures
});

// Usage in card authorization
export async function authorize(params) {
  return cardNetworkBreaker.execute(async () => {
    return authorizeInternal(params);
  });
}
```

**Circuit Breaker Configuration by Service:**
| Service | Failure Threshold | Reset Timeout | Fallback |
|---------|-------------------|---------------|----------|
| Card Network | 5 consecutive | 30 seconds | Return 503, merchant retries |
| Fraud ML | 3 consecutive | 15 seconds | Rule-based scoring only |
| Webhook Delivery | 10 consecutive | 60 seconds | Queue for later |
| GeoIP Service | 5 consecutive | 60 seconds | Skip geo checks |

**Files:**
- `/backend/src/shared/circuitBreaker.js` - Circuit breaker implementation
- `/backend/src/services/cardNetwork.js` - Card network with circuit breaker

---

### WHY Metrics Enable Fraud Detection

Metrics aren't just for operations - they're essential for detecting and preventing fraud in real-time.

**Fraud Detection via Metrics:**
```javascript
// Key fraud indicators tracked in Prometheus
fraud_score_distribution        // Distribution shows unusual spikes
fraud_blocked_total             // Sudden increase = attack
payment_failure_total           // High decline rate = card testing
payment_amount_cents            // Unusual amounts = anomaly
```

**Alert-Based Fraud Detection:**
| Metric Pattern | Potential Fraud | Action |
|---------------|-----------------|--------|
| 10x normal decline rate in 5 min | Card testing attack | Block IP, alert |
| Fraud score spike (>50% high-risk) | Credential stuffing | Enable 3DS, review |
| Many small payments to same merchant | Carding | Velocity limits |
| Payments from unusual geographies | Account takeover | Step-up authentication |

**Key Metrics for Fraud:**
```javascript
// Collected in /backend/src/shared/metrics.js
fraud_score_distribution    // Histogram of risk scores
fraud_blocked_total         // Counter by rule and risk level
fraud_check_duration        // Latency of fraud checks
payment_failure_total       // Failures by decline code
payment_success_total       // Success by currency and method
```

**SLIs That Indicate Fraud:**
- Decline rate > 10% (normal: 2-3%)
- Fraud block rate > 5% (normal: 0.1-0.5%)
- 3DS challenge rate spike
- Unusual geographic distribution

**Files:**
- `/backend/src/shared/metrics.js` - Prometheus metrics definitions
- `/backend/src/routes/paymentIntents.js` - Metrics collection in payment flow

---

### Implemented Observability Stack

**1. Structured Logging (Pino)**
```javascript
// JSON logs with consistent fields
{
  "level": "info",
  "time": "2024-01-15T10:30:00.000Z",
  "service": "stripe-payment-api",
  "trace_id": "abc123",
  "event": "payment_succeeded",
  "intent_id": "pi_xyz",
  "amount": 2500,
  "duration_ms": 145.23
}
```

**2. Prometheus Metrics (/metrics endpoint)**
```
# Payment metrics
payment_requests_total{method="POST",endpoint="/v1/payment_intents"} 1234
payment_request_duration_seconds_bucket{le="0.5"} 980
payment_success_total{currency="usd"} 890
payment_failure_total{decline_code="insufficient_funds"} 45

# Infrastructure metrics
db_connection_pool_size{state="active"} 5
redis_memory_bytes 52428800
circuit_breaker_state{service="card_network"} 0
```

**3. Health Check Endpoints**
- `GET /health` - Basic health (for load balancer)
- `GET /health/detailed` - Full dependency checks
- `GET /ready` - Readiness probe (Kubernetes)
- `GET /live` - Liveness probe (Kubernetes)

**4. Graceful Shutdown**
- SIGTERM/SIGINT handling
- Drain in-flight requests (30 second timeout)
- Close database and Redis connections cleanly

---

### File Summary

| File | Purpose |
|------|---------|
| `/backend/src/shared/logger.js` | Pino-based structured JSON logging |
| `/backend/src/shared/metrics.js` | Prometheus metrics collection |
| `/backend/src/shared/audit.js` | Financial operation audit logging |
| `/backend/src/shared/circuitBreaker.js` | Circuit breaker and retry logic |
| `/backend/src/services/cardNetwork.js` | Card network with circuit breaker |
| `/backend/src/routes/paymentIntents.js` | Payment routes with full observability |
| `/backend/src/index.js` | Main app with health checks and metrics endpoint |
| `/backend/src/db/init.sql` | Database schema including audit_log table |
