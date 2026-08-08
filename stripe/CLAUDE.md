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

---

## Iteration & Repair Log

- **2026-08-07 — the dashboard had never been screenshotted logged in.** All five screenshots were the API-key sign-in page. Two causes:
  1. **The seed crashed partway through on invalid UUIDs.** `db-seed/seed.sql` used Stripe-style prefixed identifiers — `pi-11111111-…`, `ch-…`, `pm-…`, `we-…` — as values for `uuid` columns. Postgres rejects `pi-11111111-1111-1111-1111-111111111111` with `invalid input syntax for type uuid`, so the merchant rows landed but everything after the payment-methods insert did not. Rewrote 59 identifiers to encode the type in the leading hex nibble instead (`pi`→`e`, `ch`→`c`, `pm`→`d`, `we`→`f`), which keeps them valid UUIDs, keeps them unique, and keeps them readable at a glance. The prefixed form belongs on the *API-facing* object id (`pi_abc123`), not on the database primary key — conflating the two is what broke it.
  2. **The screenshot config had `auth.enabled: false`.** This app authenticates with a single merchant API key rather than email + password, so the harness's default two-field login didn't apply and had simply been switched off. The harness already supports `passwordSelector: false` for single-credential forms; the config now uses it with the seeded `sk_test_demo_merchant_key_12345`.
- **Harness false negative worth knowing about:** the run still prints "Login form still present after submit — login may have failed" and writes `debug-login-failed.png`. That debug capture shows a fully authenticated dashboard. The warning is wrong for this app, and the run is reported as successful, so treat that message as advisory here rather than as a failure signal.
- **Screenshots:** 5 (all sign-in pages) → 5 real ones — dashboard with balance and fee breakdown, payments with mixed statuses (succeeded / failed / requires-payment), customers, balance, and webhooks.
- **2026-08-07 (answer doc):** `system-design-answer-backend.md` was 299 lines, under the repo's 350–550 band, and had **no failure-handling section at all** — a conspicuous gap for a payments system, where the defining case is the in-doubt transaction rather than the happy path. Added a Failure Handling and Reconciliation deep dive covering the network timeout that may or may not have authorized, retrying with a persisted network reference, settlement-file reconciliation with append-only compensating entries, and a failure matrix noting that the idempotency store fails *closed*. Also added emoji section headers and renamed "Trade-offs and Alternatives" to the repo-standard "Trade-offs Summary" → 384 lines.

**Note on this file's format:** the checklist sections above predate the repo's current CLAUDE.md convention (prose covering architecture, key design decisions with trade-offs, current state, and this log). They are also partly stale — "Audit logging" is listed unchecked under Phase 4 while the answer docs describe it as implemented. Worth a rewrite in the style of `slack/CLAUDE.md` or `spotlight/CLAUDE.md`.
