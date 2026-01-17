# Design Stripe - System Design Interview Answer

## Introduction (2 minutes)

"Thank you for the opportunity. Today I'll design Stripe, a payment processing platform. Stripe is a fascinating system design problem because financial systems have unique requirements:

1. Zero tolerance for errors - a duplicate charge or lost payment is unacceptable
2. Idempotency is essential when network failures can cause retries
3. Double-entry accounting for complete financial accuracy
4. Security and compliance (PCI DSS) are non-negotiable

Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our core payment platform:

1. **Charge**: Process credit card payments through a simple API
2. **Refund**: Return funds to customers with proper accounting
3. **Merchants**: Onboard businesses, manage API keys, configure settings
4. **Webhooks**: Notify merchants of payment events reliably
5. **Disputes**: Handle chargebacks from card networks

I'll focus on the payment flow, idempotency, and ledger design since those are the most technically interesting."

### Non-Functional Requirements

"Financial systems have strict requirements:

- **Latency**: Under 500ms for payment authorization
- **Availability**: 99.999% (five nines) for payment processing
- **Accuracy**: Zero tolerance for financial errors - every cent must be accounted for
- **Security**: PCI DSS Level 1 compliance, end-to-end encryption

The accuracy requirement is absolute. Unlike social media where losing a post is annoying, losing a payment or creating a duplicate charge can destroy a business relationship."

---

## High-Level Design (10 minutes)

### Architecture Overview

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

### Key Services

**Payment Service**: Handles the payment lifecycle - creating intents, confirming payments, processing refunds. Orchestrates calls to fraud service and card networks.

**Fraud Service**: Real-time risk assessment. Evaluates each payment for fraud signals and returns a risk score.

**Webhook Service**: Reliable event delivery to merchant endpoints with retry logic and cryptographic signatures.

**Ledger Service**: The financial brain - maintains double-entry accounting records for every money movement."

---

## Deep Dive: Payment Flow (12 minutes)

### Two-Phase Payment (Payment Intents)

"Modern payment APIs use a two-phase approach:

**Phase 1: Create Payment Intent**
```javascript
async function createPaymentIntent(merchantId, amount, currency, idempotencyKey) {
  // Check idempotency - have we seen this request before?
  const existing = await redis.get(`idempotency:${idempotencyKey}`)
  if (existing) {
    return JSON.parse(existing)
  }

  const intent = await db.transaction(async (tx) => {
    const intent = await tx.query(`
      INSERT INTO payment_intents (merchant_id, amount, currency, status)
      VALUES ($1, $2, $3, 'requires_payment_method')
      RETURNING *
    `, [merchantId, amount, currency])

    return intent.rows[0]
  })

  // Cache for idempotency (24 hours)
  await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify(intent))

  return intent
}
```

This creates the intent but doesn't charge yet. The merchant collects payment details on their frontend."

### Phase 2: Confirm Payment

```javascript
async function confirmPaymentIntent(intentId, paymentMethodId) {
  const intent = await getPaymentIntent(intentId)

  if (intent.status !== 'requires_payment_method') {
    throw new Error('Invalid intent state')
  }

  const paymentMethod = await getPaymentMethod(paymentMethodId)

  // 1. Risk assessment
  const riskScore = await fraudService.assessRisk({
    intent,
    paymentMethod,
    merchantId: intent.merchant_id
  })

  if (riskScore > 0.8) {
    // High risk - require 3D Secure
    await updateIntent(intentId, 'requires_action')
    return { status: 'requires_action', action: '3ds_redirect' }
  }

  // 2. Authorize with card network
  const authResult = await cardNetwork.authorize({
    amount: intent.amount,
    currency: intent.currency,
    cardToken: paymentMethod.card_token,
    merchantId: intent.merchant_id
  })

  if (authResult.approved) {
    await db.transaction(async (tx) => {
      // Update intent status
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

Key points:
- Risk assessment before authorization
- Card network call for actual authorization
- Ledger entries and webhook in same transaction
- Clear state machine for intent status"

---

## Deep Dive: Idempotency (8 minutes)

### Why Idempotency Matters

"In a distributed system with network failures, clients may retry requests. Without idempotency, a retry could create a duplicate charge. For a $1000 payment, that's catastrophic.

Idempotency keys ensure: 'No matter how many times you call me with this key, the side effect happens exactly once.'"

### Implementation

```javascript
class IdempotencyMiddleware {
  async handle(req, res, next) {
    const idempotencyKey = req.headers['idempotency-key']

    if (!idempotencyKey) {
      return next()
    }

    const cacheKey = `idempotency:${req.merchantId}:${idempotencyKey}`

    // Try to acquire lock (prevents concurrent requests with same key)
    const acquired = await redis.set(cacheKey + ':lock', '1', 'NX', 'EX', 60)

    if (!acquired) {
      // Another request with same key is in progress
      return res.status(409).json({ error: 'Request in progress' })
    }

    try {
      // Check for cached response
      const cached = await redis.get(cacheKey)
      if (cached) {
        const { statusCode, body } = JSON.parse(cached)
        return res.status(statusCode).json(body)
      }

      // Capture the response to cache it
      const originalJson = res.json.bind(res)
      res.json = (body) => {
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
      await redis.del(cacheKey + ':lock')
    }
  }
}
```

Key design:
- Lock prevents race conditions with concurrent retries
- Successful responses are cached for 24 hours
- Failed responses are NOT cached (allow retry)
- Per-merchant key namespacing"

---

## Deep Dive: Double-Entry Ledger (10 minutes)

### Why Double-Entry?

"In double-entry accounting, every transaction creates at least two entries that sum to zero: a debit and a credit. This provides:
- Built-in error detection (debits must equal credits)
- Complete audit trail
- Clear money flow visualization"

### Ledger Entries for a Charge

```javascript
async function createLedgerEntries(tx, { type, amount, merchantId, intentId }) {
  const entries = []

  if (type === 'charge') {
    // Debit: We're owed money from the card network
    entries.push({
      account: 'funds_receivable',
      debit: amount,
      credit: 0
    })

    // Credit: We owe the merchant (minus our fee)
    const fee = Math.round(amount * 0.029 + 30)  // 2.9% + 30¢
    entries.push({
      account: `merchant:${merchantId}:payable`,
      debit: 0,
      credit: amount - fee
    })

    // Credit: Our revenue
    entries.push({
      account: 'revenue:transaction_fees',
      debit: 0,
      credit: fee
    })
  }

  // Insert atomically
  for (const entry of entries) {
    await tx.query(`
      INSERT INTO ledger_entries (account, debit, credit, intent_id, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [entry.account, entry.debit, entry.credit, intentId])
  }

  // Verify balance (critical invariant)
  const totals = entries.reduce((acc, e) => ({
    debit: acc.debit + e.debit,
    credit: acc.credit + e.credit
  }), { debit: 0, credit: 0 })

  if (totals.debit !== totals.credit) {
    throw new Error('Ledger imbalance detected')  // Should never happen
  }
}
```

The invariant check is defensive - if debits don't equal credits, something is deeply wrong and we should fail loudly."

### Account Balances

"To get an account balance, sum all entries:

```sql
SELECT
  account,
  SUM(debit) - SUM(credit) as balance
FROM ledger_entries
WHERE account = 'merchant:xyz:payable'
GROUP BY account;
```

For frequently accessed balances (like merchant available balance), we maintain a materialized view or cached value."

---

## Deep Dive: Fraud Detection (5 minutes)

### Real-Time Risk Scoring

```javascript
class FraudService {
  async assessRisk(context) {
    const { intent, paymentMethod, merchantId } = context
    const scores = []

    // Velocity: Too many charges recently?
    const recentCharges = await this.getRecentCharges(paymentMethod.id, '1 hour')
    if (recentCharges > 3) {
      scores.push({ rule: 'velocity_1h', score: 0.4 })
    }

    // Geography: Card country vs IP country mismatch?
    const cardCountry = paymentMethod.card_country
    const ipCountry = await geoip.lookup(context.ipAddress)
    if (cardCountry !== ipCountry) {
      scores.push({ rule: 'geo_mismatch', score: 0.3 })
    }

    // Amount: Unusually high for this merchant?
    const avgAmount = await this.getMerchantAvgAmount(merchantId)
    if (intent.amount > avgAmount * 5) {
      scores.push({ rule: 'high_amount', score: 0.2 })
    }

    // ML model prediction
    const mlScore = await this.mlPredict({
      amount: intent.amount,
      merchantCategory: context.merchantCategory,
      cardBin: paymentMethod.card_bin,
      hourOfDay: new Date().getHours()
    })
    scores.push({ rule: 'ml_model', score: mlScore * 0.5 })

    // Combine and normalize
    const totalScore = Math.min(
      scores.reduce((sum, s) => sum + s.score, 0),
      1
    )

    await this.logRiskAssessment(intent.id, scores, totalScore)

    return totalScore
  }
}
```

This combines rule-based checks with ML for comprehensive fraud detection."

---

## Deep Dive: Webhooks (5 minutes)

### Reliable Delivery

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

    // Sign the payload
    const signature = this.signPayload(event, merchant.webhook_secret)

    // Queue with exponential backoff retry
    await queue.add('webhook_delivery', {
      merchantId,
      url: merchant.webhook_url,
      event,
      signature
    }, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 }
    })
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

Key features:
- Cryptographic signatures so merchants can verify authenticity
- Exponential backoff for transient failures
- Event ID for idempotent processing on merchant side"

---

## Trade-offs and Alternatives (2 minutes)

"Key decisions:

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Idempotency | Per-request keys | Database constraints | Flexibility, network retry safety |
| Ledger | Double-entry | Single-entry | Accuracy, auditability, error detection |
| Webhooks | Async with retry | Synchronous callbacks | Reliability, decoupling |
| Card Storage | Tokenization | Direct encryption | PCI scope reduction |

If I had more time, I'd discuss:
- PCI compliance architecture (cardholder data environment)
- Settlement and payout batch processing
- Multi-currency and FX handling
- Dispute and chargeback workflow"

---

## Summary

"To summarize, I've designed Stripe with:

1. **Two-phase payment flow** with Payment Intents for clear state management
2. **Idempotency middleware** preventing duplicate charges on retries
3. **Double-entry ledger** for financial accuracy and auditability
4. **Real-time fraud detection** combining rules and ML
5. **Signed webhooks** with reliable delivery and retry

The design prioritizes financial accuracy above all else - every cent is tracked, every operation is idempotent, and the ledger always balances.

What aspects would you like me to elaborate on?"
