# Payment System - System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this challenge. I'll be designing a payment processing system similar to Stripe or Square. This is a high-stakes domain where consistency and reliability are paramount. Let me start by clarifying the requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Payment Processing** - Accept and process credit card, debit card, and bank transfers
2. **Refunds** - Full and partial refunds with proper accounting
3. **Multi-Currency Support** - Process transactions in different currencies with real-time conversion
4. **Fraud Detection** - Real-time risk scoring and blocking suspicious transactions
5. **Merchant Dashboard** - View transactions, settlements, and analytics
6. **Webhooks** - Notify merchants of payment status changes

### Non-Functional Requirements

- **Consistency** - Absolutely critical. Double-charging or lost payments are unacceptable
- **Availability** - 99.99% uptime. Payment failures directly impact merchant revenue
- **Latency** - Payment authorization under 2 seconds
- **Security** - PCI-DSS compliance, encryption at rest and in transit
- **Idempotency** - Retry-safe operations to handle network failures

### Out of Scope

"For this discussion, I'll set aside: physical card terminals, cryptocurrency payments, and complex invoicing systems."

---

## 2. Scale Estimation (3 minutes)

### Assumptions
- 500,000 merchants
- 50 million transactions per day
- Average transaction: $75
- Peak: 3x average during Black Friday/holidays

### Traffic Estimates
- **Average TPS**: 600 transactions per second
- **Peak TPS**: 2,000 transactions per second
- **Read requests**: 3,000 RPS (dashboard, status checks)
- **Webhook deliveries**: 1,000 per second

### Storage Estimates
- Transaction record: ~2 KB per transaction
- 50M transactions/day = 100 GB/day
- **7-year retention** (regulatory requirement): ~250 TB

### Financial Estimates
- $75 average x 50M transactions = $3.75 billion daily volume
- At 2.9% + $0.30 fee: ~$120M daily revenue

---

## 3. High-Level Architecture (8 minutes)

```
┌────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  Merchant  │────▶│   API Gateway   │────▶│  Payment         │
│   Client   │     │  (Auth, TLS)    │     │  Orchestrator    │
└────────────┘     └─────────────────┘     └────────┬─────────┘
                                                    │
                   ┌────────────────────────────────┼─────────────────┐
                   │                                │                 │
           ┌───────▼───────┐   ┌───────────────┐   │   ┌─────────────▼─────┐
           │    Fraud      │   │   Currency    │   │   │    Card Network   │
           │    Service    │   │   Service     │   │   │    Gateway        │
           └───────┬───────┘   └───────────────┘   │   └─────────┬─────────┘
                   │                               │             │
                   └───────────────────────────────┘             │
                                                                 │
┌──────────────────────────────────────────────────────────────┐ │
│                     Message Queue (Kafka)                    │◀┘
└───────────────────────┬──────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        │               │               │
┌───────▼───────┐ ┌─────▼─────┐ ┌───────▼───────┐
│   Ledger      │ │  Webhook  │ │  Settlement   │
│   Service     │ │  Service  │ │  Service      │
└───────┬───────┘ └───────────┘ └───────────────┘
        │
┌───────▼───────────────────────────────────────┐
│              PostgreSQL (Primary)              │
│         + Read Replicas for Reporting         │
└───────────────────────────────────────────────┘
```

### Core Components

1. **API Gateway** - TLS termination, API key authentication, rate limiting
2. **Payment Orchestrator** - Coordinates the payment flow across services
3. **Fraud Service** - ML-based risk scoring, rule engine
4. **Currency Service** - Real-time exchange rates, conversion logic
5. **Card Network Gateway** - Integration with Visa, Mastercard, banks
6. **Ledger Service** - Double-entry bookkeeping, balance tracking
7. **Webhook Service** - Reliable delivery of payment events to merchants
8. **Settlement Service** - Daily/weekly fund transfers to merchants

---

## 4. Data Model (5 minutes)

### Core Entities

```sql
-- Merchants (our customers)
CREATE TABLE merchants (
    id              UUID PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    api_key_hash    VARCHAR(64) NOT NULL,
    webhook_url     VARCHAR(512),
    default_currency VARCHAR(3) DEFAULT 'USD',
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Payment transactions
CREATE TABLE transactions (
    id              UUID PRIMARY KEY,
    idempotency_key VARCHAR(64) UNIQUE,  -- Critical for retry safety
    merchant_id     UUID NOT NULL,
    amount          BIGINT NOT NULL,      -- Cents to avoid floating point
    currency        VARCHAR(3) NOT NULL,
    status          VARCHAR(20) NOT NULL, -- pending, authorized, captured, failed, refunded
    payment_method  JSONB NOT NULL,       -- Encrypted card details reference
    risk_score      INTEGER,
    processor_ref   VARCHAR(64),          -- External processor's reference
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    version         INTEGER DEFAULT 0
);

-- Ledger entries (double-entry bookkeeping)
CREATE TABLE ledger_entries (
    id              UUID PRIMARY KEY,
    transaction_id  UUID NOT NULL,
    account_id      UUID NOT NULL,        -- Merchant or system account
    entry_type      VARCHAR(10) NOT NULL, -- 'debit' or 'credit'
    amount          BIGINT NOT NULL,
    currency        VARCHAR(3) NOT NULL,
    balance_after   BIGINT NOT NULL,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Refunds (linked to original transaction)
CREATE TABLE refunds (
    id                  UUID PRIMARY KEY,
    original_tx_id      UUID NOT NULL,
    amount              BIGINT NOT NULL,
    reason              VARCHAR(255),
    status              VARCHAR(20) NOT NULL,
    created_at          TIMESTAMP DEFAULT NOW()
);
```

### Critical Invariants

- Every transaction must have balanced ledger entries (debits = credits)
- Amounts stored in smallest currency unit (cents) as integers
- Idempotency key prevents duplicate charges on retry

---

## 5. Deep Dive: Payment Processing Flow (10 minutes)

"Let me walk through the lifecycle of a payment, which is the core of the system."

### Payment States

```
┌─────────┐     ┌────────────┐     ┌──────────┐     ┌───────────┐
│ Created │────▶│ Authorized │────▶│ Captured │────▶│ Settled   │
└─────────┘     └────────────┘     └──────────┘     └───────────┘
     │               │                   │
     │               │                   │
     ▼               ▼                   ▼
┌─────────┐     ┌────────────┐     ┌──────────┐
│ Failed  │     │  Voided    │     │ Refunded │
└─────────┘     └────────────┘     └──────────┘
```

### The Authorization Flow

```python
async def process_payment(request):
    # 1. Idempotency check - critical for retry safety
    existing = await db.get_by_idempotency_key(request.idempotency_key)
    if existing:
        return existing  # Return same result for duplicate request

    # 2. Create transaction record (status: pending)
    tx = await db.create_transaction(
        idempotency_key=request.idempotency_key,
        merchant_id=request.merchant_id,
        amount=request.amount,
        currency=request.currency,
        status='pending'
    )

    try:
        # 3. Fraud check
        risk_score = await fraud_service.evaluate(
            amount=request.amount,
            card_fingerprint=request.card.fingerprint,
            ip_address=request.ip,
            merchant_id=request.merchant_id
        )

        if risk_score > BLOCK_THRESHOLD:
            await db.update_transaction(tx.id, status='failed', risk_score=risk_score)
            raise PaymentBlockedError("Transaction flagged for fraud")

        # 4. Currency conversion if needed
        if request.currency != 'USD':
            conversion = await currency_service.convert(
                amount=request.amount,
                from_currency=request.currency,
                to_currency='USD'
            )

        # 5. Route to appropriate card network
        processor = select_processor(request.card.network)
        auth_result = await processor.authorize(
            amount=request.amount,
            card_token=request.card.token,
            merchant_ref=tx.id
        )

        # 6. Update transaction with result
        if auth_result.approved:
            await db.update_transaction(
                tx.id,
                status='authorized',
                processor_ref=auth_result.reference
            )
            # 7. Publish event for async processing
            await kafka.publish('payment.authorized', tx)
            return PaymentResult(status='authorized', tx_id=tx.id)
        else:
            await db.update_transaction(tx.id, status='failed')
            return PaymentResult(status='failed', reason=auth_result.decline_reason)

    except Exception as e:
        await db.update_transaction(tx.id, status='failed')
        raise
```

### Why Idempotency Matters

"Imagine a customer clicks 'Pay' and their network times out. Did the payment go through? The client will retry, and without idempotency, we'd charge them twice. The idempotency key (provided by the client) ensures the same request always returns the same result."

```python
# Client generates unique key for each intended payment
idempotency_key = f"{order_id}:{attempt_number}"
```

### Two-Phase Capture

"Most e-commerce uses authorize-then-capture:
1. **Authorization** - Verifies card and places a hold (funds reserved)
2. **Capture** - Actually moves the money (happens when item ships)

This protects merchants from charging for items they can't deliver."

---

## 6. Deep Dive: Ledger and Reconciliation (5 minutes)

"Every payment system needs bulletproof accounting. We use double-entry bookkeeping."

### Double-Entry Principle

Every transaction creates two ledger entries that must balance:

```python
async def record_payment_capture(transaction):
    async with db.transaction():  # Database transaction for atomicity
        # Debit customer's payment (money coming in)
        await create_ledger_entry(
            transaction_id=transaction.id,
            account_id=ACCOUNTS_RECEIVABLE,
            entry_type='debit',
            amount=transaction.amount
        )

        # Credit merchant's balance (money owed to them)
        await create_ledger_entry(
            transaction_id=transaction.id,
            account_id=transaction.merchant_id,
            entry_type='credit',
            amount=transaction.amount - calculate_fee(transaction)
        )

        # Credit our revenue account (the fee)
        await create_ledger_entry(
            transaction_id=transaction.id,
            account_id=REVENUE_ACCOUNT,
            entry_type='credit',
            amount=calculate_fee(transaction)
        )
```

### Daily Reconciliation

```python
async def daily_reconciliation():
    # Sum all debits and credits - they must match
    totals = await db.query("""
        SELECT entry_type, SUM(amount) as total
        FROM ledger_entries
        WHERE created_at >= :start AND created_at < :end
        GROUP BY entry_type
    """)

    if totals['debit'] != totals['credit']:
        alert_oncall("CRITICAL: Ledger imbalance detected!")

    # Compare with card network settlements
    processor_totals = await processor.get_daily_settlement()
    if processor_totals != our_totals:
        create_reconciliation_exception(processor_totals, our_totals)
```

---

## 7. Fraud Detection (3 minutes)

### Real-Time Risk Scoring

```python
def calculate_risk_score(transaction, user_history, device_info):
    score = 0

    # Velocity checks
    if transactions_last_hour(user) > 10:
        score += 30

    # Amount anomaly
    if amount > user_average * 3:
        score += 20

    # Geographic anomaly
    if distance_from_usual_location > 1000:  # km
        score += 25

    # Device fingerprint
    if device_not_seen_before:
        score += 15

    # ML model prediction
    ml_score = fraud_model.predict(features)
    score += ml_score * 40

    return min(score, 100)  # Cap at 100
```

### Decision Thresholds
- Score < 30: Auto-approve
- Score 30-70: Approve with logging
- Score 70-90: Require 3D Secure / additional verification
- Score > 90: Block and alert

---

## 8. Webhook Delivery (3 minutes)

"Merchants need to know when payments succeed, fail, or get refunded. Reliable webhook delivery is crucial."

### Guaranteed Delivery Pattern

```python
async def deliver_webhook(event):
    webhook = await db.create_webhook_delivery(
        merchant_id=event.merchant_id,
        event_type=event.type,
        payload=event.to_json(),
        status='pending'
    )

    for attempt in range(MAX_RETRIES):
        try:
            response = await http.post(
                merchant.webhook_url,
                json=event.payload,
                headers={'X-Signature': sign(event.payload)},
                timeout=30
            )

            if response.status_code == 200:
                await db.update_webhook(webhook.id, status='delivered')
                return

        except Exception as e:
            pass

        # Exponential backoff: 1s, 2s, 4s, 8s, 16s...
        await sleep(2 ** attempt)

    await db.update_webhook(webhook.id, status='failed')
    await alert_merchant_webhook_failure(merchant)
```

### Webhook Security

```python
# Merchants verify our webhooks using HMAC signature
signature = hmac.new(
    merchant.webhook_secret.encode(),
    payload.encode(),
    hashlib.sha256
).hexdigest()

# Header: X-Signature: sha256=abc123...
```

---

## 9. Trade-offs and Alternatives (3 minutes)

### Trade-off 1: Synchronous vs. Asynchronous Processing

**Chose**: Synchronous for authorization, async for capture/settlement
**Rationale**: Customers need immediate feedback on auth; settlement can be batched
**Alternative**: Fully async (faster response, but customer sees "pending" longer)

### Trade-off 2: Single Database vs. Event Sourcing

**Chose**: Traditional database with audit log
**Trade-off**: Simpler to implement and query; less flexible for replaying history
**Alternative**: Full event sourcing (better audit trail, but significant complexity)

### Trade-off 3: In-House vs. Third-Party Fraud Detection

**Chose**: Hybrid - basic rules in-house, ML model from third party
**Rationale**: Building fraud models requires massive data; rules give us control
**Alternative**: Fully in-house (more control, but needs data science team)

---

## 10. Security Considerations (2 minutes)

### PCI-DSS Compliance

- **Never store full card numbers** - Use tokenization service
- **Encryption at rest** - AES-256 for sensitive data
- **Network segmentation** - Payment processing in isolated network
- **Audit logging** - Every access to sensitive data is logged

### Key Management

```
┌────────────┐     ┌─────────────┐     ┌──────────────┐
│ Application│────▶│   AWS KMS   │────▶│ Encrypted    │
│            │     │   / Vault   │     │ Card Tokens  │
└────────────┘     └─────────────┘     └──────────────┘
```

- API keys hashed with bcrypt
- Card data encrypted with merchant-specific keys
- Key rotation every 90 days

---

## Summary

"To summarize, I've designed a payment system with:

1. **Idempotent API** ensuring retry safety for all payment operations
2. **Double-entry ledger** maintaining perfect accounting balance
3. **Multi-stage payment flow** (auth, capture, settle) for e-commerce flexibility
4. **Real-time fraud detection** combining rules and ML
5. **Reliable webhook delivery** with exponential backoff
6. **Strong security** with tokenization and encryption

The key insight is that payment systems prioritize consistency over availability - it's better to decline a payment than to create accounting discrepancies."

---

## Questions I'd Expect

**Q: How do you handle chargebacks?**
A: Chargebacks come from the card network as events. We create a dispute record, debit the merchant's balance, and provide an API for merchants to submit evidence. The dispute resolution happens outside our system.

**Q: What happens if the database goes down mid-transaction?**
A: We use write-ahead logging and synchronous replication. If primary fails, the replica has committed data. The idempotency key ensures the client can safely retry.

**Q: How do you handle multi-currency settlement?**
A: We convert to merchant's preferred currency at capture time, locking in the rate. Settlement happens in that currency. Merchants can also choose to receive in multiple currencies.
