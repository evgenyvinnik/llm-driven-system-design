# Design Stripe - Development with Claude

## Project Context

Building a payment processing platform to understand financial systems, idempotency, and fraud prevention.

**Key Learning Goals:**
- Build idempotent payment APIs
- Design double-entry ledger systems
- Implement real-time fraud detection
- Handle webhooks reliably

---

## Implementation Status

### Phase 1: Payment Flow - COMPLETED
- [x] Payment intents (create, confirm, capture, cancel)
- [x] Card tokenization (simulated)
- [x] Authorization flow with card network simulation
- [x] Basic refunds

### Phase 2: Merchant Platform - IN PROGRESS
- [x] Merchant onboarding
- [x] API key management
- [x] Dashboard basics
- [x] Webhook configuration
- [ ] Advanced analytics
- [ ] Multi-currency support

### Phase 3: Financial Accuracy - COMPLETED
- [x] Double-entry ledger
- [x] Fee calculation (2.9% + 30c)
- [x] Balance tracking
- [ ] Settlement batching
- [ ] Reconciliation reports
- [ ] Dispute handling

### Phase 4: Risk & Compliance - PARTIAL
- [x] Basic fraud scoring
- [x] Velocity rules
- [ ] Advanced ML models
- [ ] Audit logging
- [ ] PCI patterns

---

## Key Challenges to Explore

### 1. Idempotency at Scale

**Challenge**: Prevent duplicate charges with distributed systems

**Implementation:**
- Redis-based idempotency key caching
- Lock acquisition to prevent concurrent duplicate requests
- 24-hour TTL on idempotency keys
- Per-merchant key namespacing

### 2. Ledger Consistency

**Problem**: Financial accuracy across failures

**Implementation:**
- PostgreSQL transactions for atomicity
- Double-entry bookkeeping (debits = credits)
- Invariant checking in ledger service
- Balance views for fast queries

### 3. Webhook Reliability

**Challenge**: Guarantee delivery to merchant endpoints

**Implementation:**
- BullMQ for reliable job processing
- Exponential backoff retry (up to 5 attempts)
- HMAC-SHA256 signatures with timestamp
- Event logging for audit trail

---

## Technical Decisions

### Why PostgreSQL for Ledger?
- Strong ACID guarantees essential for financial data
- Serializable isolation available if needed
- Excellent indexing for account balance queries
- Native UUID support

### Why Redis for Idempotency?
- Sub-millisecond lookup times
- Native expiration support
- Atomic SET NX for locking
- Easy horizontal scaling

### Why BullMQ for Webhooks?
- Reliable job persistence in Redis
- Built-in exponential backoff
- Concurrency control
- Easy monitoring

---

## API Design Patterns

### Stripe-Style Object IDs
```javascript
// Prefixed UUIDs for easy identification
payment_intent: pi_abc123...
charge: ch_abc123...
customer: cus_abc123...
payment_method: pm_abc123...
```

### Idempotency Header
```javascript
// Clients provide unique key
headers: {
  'Idempotency-Key': 'order_123_payment'
}
```

### Webhook Signature Format
```javascript
// Timestamp + signature for verification
'Stripe-Signature': 't=1234567890,v1=abc123...'
```

---

## Resources

- [Stripe Engineering Blog](https://stripe.com/blog/engineering)
- [Designing Data-Intensive Applications](https://dataintensive.net/) (Ledger patterns)
- [Idempotency Keys](https://stripe.com/docs/api/idempotent_requests)

---

## Future Improvements

1. **3D Secure Flow**: Implement redirect-based authentication
2. **Disputes/Chargebacks**: Full dispute lifecycle
3. **Settlement Engine**: Batch payout processing
4. **Currency Conversion**: Real-time FX rates
5. **PCI Compliance**: Card vault isolation
