# Stripe - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thank you for the opportunity. Today I'll design Stripe, a payment processing platform. As a backend engineer, I'm particularly excited about the unique challenges that financial systems present:

1. **Idempotency at scale** - preventing duplicate charges across distributed systems with network failures
2. **Double-entry ledger** - maintaining financial accuracy with ACID guarantees
3. **Circuit breakers** - gracefully handling card network outages
4. **Audit logging** - PCI DSS compliance requires complete transaction trails

Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

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

## High-Level Design (8 minutes)

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

```sql
-- Merchants with API credentials
CREATE TABLE merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  email VARCHAR(200) NOT NULL UNIQUE,
  api_key_hash VARCHAR(100) NOT NULL,      -- bcrypt hashed
  webhook_url VARCHAR(500),
  webhook_secret VARCHAR(100),              -- For HMAC signatures
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_merchants_api_key ON merchants(api_key_hash);

-- Payment Intents (two-phase payment state machine)
CREATE TABLE payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id),
  amount INTEGER NOT NULL,                   -- In cents
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(30) NOT NULL,               -- State machine
  payment_method_id UUID,
  auth_code VARCHAR(50),                     -- From card network
  decline_code VARCHAR(50),
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Status values: requires_payment_method, requires_confirmation,
--                requires_action, processing, succeeded, failed, canceled

CREATE INDEX idx_intents_merchant ON payment_intents(merchant_id);
CREATE INDEX idx_intents_status ON payment_intents(status);
CREATE INDEX idx_intents_created ON payment_intents(created_at DESC);

-- Tokenized payment methods
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID,
  card_token VARCHAR(100) NOT NULL,          -- Encrypted
  card_last4 VARCHAR(4) NOT NULL,
  card_brand VARCHAR(20) NOT NULL,
  card_exp_month INTEGER NOT NULL,
  card_exp_year INTEGER NOT NULL,
  card_country VARCHAR(2),
  card_bin VARCHAR(6),                       -- For fraud detection
  created_at TIMESTAMP DEFAULT NOW()
);

-- Double-entry ledger (the heart of financial accuracy)
CREATE TABLE ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  account VARCHAR(100) NOT NULL,             -- Account identifier
  debit INTEGER DEFAULT 0,                   -- Money going in
  credit INTEGER DEFAULT 0,                  -- Money going out
  intent_id UUID REFERENCES payment_intents(id),
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT positive_amounts CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT single_direction CHECK (
    (debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)
  )
);

CREATE INDEX idx_ledger_account ON ledger_entries(account);
CREATE INDEX idx_ledger_intent ON ledger_entries(intent_id);
CREATE INDEX idx_ledger_created ON ledger_entries(created_at);

-- Refunds
CREATE TABLE refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id UUID REFERENCES payment_intents(id),
  amount INTEGER NOT NULL,
  reason VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit log for PCI compliance
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  actor_type VARCHAR(20) NOT NULL,           -- merchant, admin, system
  actor_id VARCHAR(100) NOT NULL,
  action VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  ip_address VARCHAR(45),
  trace_id VARCHAR(100),
  metadata JSONB
);

-- Append-only: No UPDATE or DELETE allowed
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_actor ON audit_log(actor_type, actor_id);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
```

---

## Deep Dive: Idempotency System (10 minutes)

### Why Idempotency is Critical

"In distributed systems with network failures, clients must retry requests. Without idempotency, a retry could duplicate a charge. For a $1000 payment, that's catastrophic.

```
Customer clicks 'Pay' -> Request sent -> Network timeout -> Did charge succeed?
                                                          -> Customer retries
                                                          -> DOUBLE CHARGE!
```

Idempotency keys ensure: 'No matter how many times you call me with this key, the side effect happens exactly once.'"

### Implementation with Redis Locking

```javascript
class IdempotencyService {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.lockTTL = options.lockTTL || 60;       // 60 second lock
    this.responseTTL = options.responseTTL || 86400; // 24 hour cache
  }

  async executeWithIdempotency(key, merchantId, operation) {
    const fullKey = `idempotency:${merchantId}:${key}`;
    const lockKey = `${fullKey}:lock`;

    // 1. Try to acquire lock (prevents concurrent duplicate requests)
    const lockAcquired = await this.redis.set(
      lockKey,
      process.pid.toString(),
      'NX',  // Only set if not exists
      'EX',
      this.lockTTL
    );

    if (!lockAcquired) {
      // Check for cached response from previous attempt
      const cached = await this.redis.get(fullKey);
      if (cached) {
        const { response, createdAt } = JSON.parse(cached);
        return { cached: true, response, createdAt };
      }
      // Still processing - tell client to retry
      throw new IdempotencyConflictError(
        'Request with this idempotency key is currently being processed'
      );
    }

    try {
      // 2. Check for cached response (in case lock expired and reacquired)
      const cached = await this.redis.get(fullKey);
      if (cached) {
        return { cached: true, ...JSON.parse(cached) };
      }

      // 3. Execute the actual operation
      const response = await operation();

      // 4. Cache successful response for replay
      await this.redis.setex(fullKey, this.responseTTL, JSON.stringify({
        response,
        createdAt: Date.now()
      }));

      return { cached: false, response };

    } finally {
      // 5. Always release lock
      await this.redis.del(lockKey);
    }
  }
}
```

### Express Middleware Integration

```javascript
function idempotencyMiddleware(idempotencyService) {
  return async (req, res, next) => {
    const idempotencyKey = req.headers['idempotency-key'];

    if (!idempotencyKey) {
      // No key provided - process normally (for GET requests, etc.)
      return next();
    }

    // Validate key format
    if (idempotencyKey.length > 255) {
      return res.status(400).json({
        error: 'idempotency_key_too_long',
        message: 'Idempotency key must be 255 characters or less'
      });
    }

    const cacheKey = `${req.merchantId}:${idempotencyKey}`;

    try {
      // Check for cached response
      const cached = await redis.get(`idempotency:${cacheKey}`);
      if (cached) {
        const { statusCode, body, headers } = JSON.parse(cached);
        res.set(headers);
        res.set('Idempotency-Replayed', 'true');
        return res.status(statusCode).json(body);
      }

      // Acquire lock
      const lockAcquired = await redis.set(
        `idempotency:${cacheKey}:lock`,
        '1',
        'NX',
        'EX',
        60
      );

      if (!lockAcquired) {
        return res.status(409).json({
          error: 'idempotency_conflict',
          message: 'A request with this idempotency key is in progress'
        });
      }

      // Capture response for caching
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          redis.setex(`idempotency:${cacheKey}`, 86400, JSON.stringify({
            statusCode: res.statusCode,
            body,
            headers: res.getHeaders()
          }));
        }
        // Release lock
        redis.del(`idempotency:${cacheKey}:lock`);
        return originalJson(body);
      };

      next();

    } catch (error) {
      // Release lock on error
      await redis.del(`idempotency:${cacheKey}:lock`);
      next(error);
    }
  };
}
```

---

## Deep Dive: Double-Entry Ledger (10 minutes)

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

```javascript
class LedgerService {
  constructor(pool) {
    this.pool = pool;
  }

  // Create ledger entries within a transaction
  async createChargeEntries(tx, { intentId, amount, merchantId }) {
    // Calculate fee: 2.9% + 30 cents
    const feeAmount = Math.round(amount * 0.029 + 30);
    const merchantAmount = amount - feeAmount;

    const entries = [
      {
        account: 'funds_receivable',
        debit: amount,
        credit: 0,
        description: 'Card network receivable'
      },
      {
        account: `merchant:${merchantId}:payable`,
        debit: 0,
        credit: merchantAmount,
        description: 'Merchant payout pending'
      },
      {
        account: 'revenue:transaction_fees',
        debit: 0,
        credit: feeAmount,
        description: 'Transaction fee revenue'
      }
    ];

    // Verify balance before insert (defensive programming)
    const totalDebit = entries.reduce((sum, e) => sum + e.debit, 0);
    const totalCredit = entries.reduce((sum, e) => sum + e.credit, 0);

    if (totalDebit !== totalCredit) {
      throw new LedgerImbalanceError(
        `Ledger entries don't balance: debit=${totalDebit}, credit=${totalCredit}`
      );
    }

    // Insert all entries atomically
    for (const entry of entries) {
      await tx.query(`
        INSERT INTO ledger_entries
          (account, debit, credit, intent_id, description, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [entry.account, entry.debit, entry.credit, intentId, entry.description]);
    }

    return { feeAmount, merchantAmount };
  }

  // Create refund entries (reverse of charge)
  async createRefundEntries(tx, { refundId, intentId, amount, merchantId }) {
    const feeRefund = Math.round(amount * 0.029 + 30);
    const merchantRefund = amount - feeRefund;

    const entries = [
      // Reverse the original entries
      {
        account: 'funds_receivable',
        debit: 0,
        credit: amount,
        description: 'Refund to customer'
      },
      {
        account: `merchant:${merchantId}:payable`,
        debit: merchantRefund,
        credit: 0,
        description: 'Refund deduction from merchant'
      },
      {
        account: 'revenue:transaction_fees',
        debit: feeRefund,
        credit: 0,
        description: 'Fee reversal on refund'
      }
    ];

    // Same balance check
    const totalDebit = entries.reduce((sum, e) => sum + e.debit, 0);
    const totalCredit = entries.reduce((sum, e) => sum + e.credit, 0);

    if (totalDebit !== totalCredit) {
      throw new LedgerImbalanceError('Refund entries imbalance');
    }

    for (const entry of entries) {
      await tx.query(`
        INSERT INTO ledger_entries
          (account, debit, credit, intent_id, description)
        VALUES ($1, $2, $3, $4, $5)
      `, [entry.account, entry.debit, entry.credit, intentId, entry.description]);
    }
  }

  // Get account balance
  async getAccountBalance(account) {
    const result = await this.pool.query(`
      SELECT
        COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0) as balance
      FROM ledger_entries
      WHERE account = $1
    `, [account]);

    return result.rows[0].balance;
  }

  // Verify entire ledger balances (run daily)
  async verifyLedgerIntegrity() {
    const result = await this.pool.query(`
      SELECT
        SUM(debit) as total_debit,
        SUM(credit) as total_credit
      FROM ledger_entries
    `);

    const { total_debit, total_credit } = result.rows[0];

    if (total_debit !== total_credit) {
      // CRITICAL: Alert immediately
      logger.fatal({
        event: 'LEDGER_IMBALANCE',
        total_debit,
        total_credit,
        difference: total_debit - total_credit
      });
      throw new LedgerImbalanceError('Global ledger imbalance detected');
    }

    return { balanced: true, total_debit, total_credit };
  }
}
```

---

## Deep Dive: Circuit Breaker for Card Networks (5 minutes)

### Protecting Against Card Network Outages

"Payment systems depend on external card networks that can fail. Without circuit breakers, slowdowns cascade:

```
Card Network Slow -> All requests queue -> Thread pool exhausted
                  -> Database connections exhaust -> Entire API down
```"

### Implementation

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 3;
    this.timeout = options.timeout || 10000;        // 10 second call timeout
    this.resetTimeout = options.resetTimeout || 30000; // 30 second reset

    this.state = 'CLOSED';  // CLOSED -> OPEN -> HALF_OPEN -> CLOSED
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = null;
  }

  async execute(operation) {
    // OPEN state - fail fast
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new CircuitBreakerOpenError(
          `Circuit breaker is open, retry after ${this.nextAttempt - Date.now()}ms`
        );
      }
      // Transition to HALF_OPEN to test
      this.state = 'HALF_OPEN';
    }

    try {
      // Execute with timeout
      const result = await Promise.race([
        operation(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Operation timed out')), this.timeout)
        )
      ]);

      this.onSuccess();
      return result;

    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.reset(); // Back to CLOSED
      }
    } else {
      this.failureCount = 0;
    }
  }

  onFailure() {
    this.failureCount++;

    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeout;
      this.successCount = 0;
    }
  }

  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
  }
}

// Per-network circuit breakers
const cardNetworkBreakers = {
  visa: new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 }),
  mastercard: new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 }),
  amex: new CircuitBreaker({ failureThreshold: 5, resetTimeout: 30000 })
};

async function authorizeCard(paymentMethod, amount, currency) {
  const network = getCardNetwork(paymentMethod.card_bin);
  const breaker = cardNetworkBreakers[network];

  return breaker.execute(async () => {
    return await cardNetworkGateway.authorize({
      token: paymentMethod.card_token,
      amount,
      currency
    });
  });
}
```

---

## Deep Dive: Webhook Delivery System (5 minutes)

### Guaranteed Delivery with Retry

```javascript
class WebhookService {
  constructor(queue, redis) {
    this.queue = queue;
    this.redis = redis;
  }

  async send(merchantId, eventType, data) {
    const merchant = await getMerchant(merchantId);
    if (!merchant.webhook_url) return;

    const event = {
      id: `evt_${crypto.randomUUID()}`,
      type: eventType,
      data,
      created: Date.now(),
      api_version: '2024-01-01'
    };

    // Generate HMAC signature
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${JSON.stringify(event)}`;
    const signature = crypto
      .createHmac('sha256', merchant.webhook_secret)
      .update(signedPayload)
      .digest('hex');

    // Queue for delivery with exponential backoff
    await this.queue.add('webhook_delivery', {
      merchantId,
      url: merchant.webhook_url,
      event,
      signature: `t=${timestamp},v1=${signature}`
    }, {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 1000  // 1s, 2s, 4s, 8s, 16s
      }
    });

    // Log for audit
    await db.query(`
      INSERT INTO webhook_deliveries (event_id, merchant_id, status)
      VALUES ($1, $2, 'pending')
    `, [event.id, merchantId]);
  }
}

// Webhook delivery worker
webhookQueue.process('webhook_delivery', async (job) => {
  const { url, event, signature, merchantId } = job.data;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': signature,
        'User-Agent': 'Stripe/1.0'
      },
      body: JSON.stringify(event),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Webhook failed with status ${response.status}`);
    }

    // Update delivery status
    await db.query(`
      UPDATE webhook_deliveries
      SET status = 'delivered', delivered_at = NOW()
      WHERE event_id = $1
    `, [event.id]);

  } catch (error) {
    clearTimeout(timeout);

    // Update failure status
    await db.query(`
      UPDATE webhook_deliveries
      SET status = 'failed', last_error = $2, attempts = attempts + 1
      WHERE event_id = $1
    `, [event.id, error.message]);

    throw error; // Let BullMQ handle retry
  }
});
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| **Idempotency store** | Redis with locking | PostgreSQL UPSERT | Sub-ms latency, automatic TTL expiration |
| **Ledger database** | PostgreSQL | Event sourcing | ACID guarantees essential for financial data |
| **Ledger format** | Double-entry | Single-entry | Built-in error detection, audit trail |
| **Webhook queue** | BullMQ (Redis) | RabbitMQ | Simpler setup, built-in exponential backoff |
| **Circuit breaker** | Per-network | Global | Isolate failures to specific card networks |
| **Card storage** | Tokenization | Direct encryption | PCI scope reduction |

---

## Capacity Planning

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

## Future Enhancements

1. **Multi-currency support**: FX rate service, settlement in local currency
2. **3D Secure flow**: Redirect-based authentication for high-risk payments
3. **Settlement batching**: Daily payout processing with reconciliation
4. **Dispute handling**: Full chargeback lifecycle with evidence submission
5. **Sharding**: Merchant-based partitioning for horizontal scale
6. **Read replicas**: Separate read path for dashboard queries

---

## Summary

"I've designed Stripe's backend with:

1. **Idempotency middleware** with Redis locking to prevent duplicate charges
2. **Double-entry ledger** in PostgreSQL with balance invariant checking
3. **Circuit breakers** per card network to prevent cascade failures
4. **Webhook delivery** with BullMQ, exponential backoff, and HMAC signatures
5. **Audit logging** for PCI DSS compliance

The design prioritizes financial accuracy above all else - every cent is tracked, every operation is idempotent, and the ledger always balances."
