# Payment System — Development with Claude

## Project Context

A merchant payment platform: merchants authenticate with an API key and drive payments through the full lifecycle — authorize, capture, void, refund, chargeback — while every balance change is recorded in a **double-entry ledger**. The core hard problem is *money correctness under retries*: a network timeout must never double-charge a customer, and the sum of debits must always equal the sum of credits. That forces two disciplines everywhere — idempotency on every mutation, and paired ledger entries inside a single database transaction.

**Learning goals:** double-entry bookkeeping as a correctness invariant, idempotency-key design, circuit-breaker isolation of an unreliable external processor, and async fan-out (webhooks, fraud scoring) without blocking the payment path.

## Architecture at a Glance (what actually runs)

Three infrastructure services in `docker-compose.yml`, each on the hot path for a different reason:

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL** (`pg`) | Transactions, `ledger_entries`, merchants, refunds, chargebacks, webhook deliveries | ACID — the ledger's debit=credit invariant only holds if paired entries commit atomically inside one transaction |
| **Valkey/Redis** (`ioredis`) | Idempotency key → cached response (24h TTL), distributed processing locks | Sub-ms GET on every mutation *before* business logic runs; DB is the durable fallback |
| **RabbitMQ** (`amqplib`) | `webhook.delivery` + `fraud.scoring` queues consumed by background workers | Decouples slow/failure-prone side effects (merchant webhook endpoints, deep fraud analysis) from the synchronous payment response |

Backend is a single Express app (`backend/src/index.ts`) plus two standalone workers (`workers/webhook-worker.ts`, `workers/fraud-worker.ts`). Routes: `payments`, `refunds`, `chargebacks`, `merchants`, `ledger`. Services: `payment/` (authorize/capture/void/refund/processor), `ledger.service`, `merchant.service`, `fraud.service`, `refund.service`. Frontend: React 19 + TanStack Router + Zustand (merchant dashboard).

## Key Design Decisions

### 1. Double-entry ledger as the source of truth
Every captured payment writes three balanced `ledger_entries` rows in one PG transaction (`ledger.service.ts` `recordPaymentCapture`): debit Accounts Receivable for the gross amount, credit the merchant account for the net, credit Platform Revenue for the fee. Refunds and chargebacks reverse the same pattern (chargebacks additionally charge a processing fee). The `transactions` row is the *business* event; the ledger rows are the *accounting* impact. `verifyLedgerBalance()` reconciles by summing debits vs credits over a window — if they ever diverge, something is wrong. Trade-off given up: writing 3 rows + a balance update per capture is more expensive than a single `UPDATE balance`, but a single mutable balance has no audit trail and can't be reconciled after a bug.

### 2. Idempotency in Redis with a PG uniqueness backstop
Mutations carry an `Idempotency-Key` header (`middleware/auth.ts` copies it into the body). `shared/idempotency.ts` checks Redis first (24h TTL, keyed per merchant); a hit returns the cached response without re-running business logic. The `transactions` and `refunds` tables also carry a `UNIQUE(idempotency_key)` constraint as the durable fallback if Redis restarts without persistence. Trade-off: two systems to keep consistent, but the Redis check keeps the common-case retry off the database, and the DB constraint guarantees correctness even if the cache is cold.

### 3. Circuit breaker around the external processor
Processor calls (`services/payment/processor.ts`) run through a **cockatiel** circuit breaker (`shared/circuit-breaker.ts`), not raw calls. After a failure threshold the breaker opens and fails fast instead of letting requests pile up against a dead processor and exhaust connection pools. The processor itself is *simulated* locally (95% approve, forced decline on card `last_four = '0000'`, higher decline over $10k). Trade-off: fail-fast means some payments are rejected during a processor blip that a longer timeout might have ridden out — acceptable because a responsive "try again" beats a hung request pool.

### 4. bcrypt API keys, linear scan (local simplification)
Merchant keys are generated as `pk_<uuid>` and stored as **bcrypt** hashes (`merchant.service.ts`). Because bcrypt hashes aren't reversible or indexable, `authenticateByApiKey` loads active merchants and `bcrypt.compare`s against each — fine for a handful of local merchants, explicitly flagged in-code as needing a key-id lookup at scale. This is the auth model to remember: **API-key merchant auth, not username/password sessions.**

### 5. Async side effects over inline processing
After a payment commits, webhook delivery and deep fraud scoring are published to RabbitMQ and handled by workers with retry/backoff, rather than run inline. Trade-off: the merchant's webhook and the final fraud verdict are eventually-consistent with the payment, but the customer-facing authorize/capture response isn't held hostage to a slow merchant endpoint.

## Current State

Implemented end to end: API-key auth, payment authorize/capture/void, full + partial refunds with proportional fee reversal, chargeback recording with ledger impact, double-entry ledger with reconciliation/summary queries, idempotency (Redis + DB backstop), circuit-breaker-wrapped simulated processor, RabbitMQ webhook + fraud workers, Prometheus metrics (`prom-client`), structured logging (`pino`), and a merchant dashboard frontend with volume/stats charts.

Intentionally omitted / simulated: real processor integration (Stripe/Adyen), a settlement/payout worker (referenced in architecture but not built as a worker), customer/payment-method vaulting tables (schema focuses on transactions), multi-currency FX conversion, and admin session auth (architecture describes it; code ships only API-key merchant auth).

## Iteration & Repair Log

- **2026-07 (CLAUDE.md rewrite):** This file was the untouched repo template — "Phase 1: Requirements *Not started*", "Decisions will be documented here". Replaced with the real architecture, decisions, and state grounded in `docker-compose.yml`, `backend/package.json`, and the service code.
- **2026-07 (architecture drift fix):** `architecture.md` claimed API keys were **SHA-256** hashed with `sk_live_*`/`sk_test_*` prefixes and `api_key_hash VARCHAR(64)`. The code uses **bcrypt** with a `pk_` prefix (`merchant.service.ts`) and `VARCHAR(255)` (`init.sql`). Corrected the auth section, the responsibilities list, and the schema comment to match.
- **2026-07 (README drift fix):** README described the Docker stack as "PostgreSQL and Redis" and never mentioned RabbitMQ, which docker-compose starts and the webhook/fraud workers consume. Added RabbitMQ (management UI + guest/guest) and clarified the core API runs without it.
- **Repo-wide:** part of the DB/Redis connection-string fallback and ESM hardening passes; the CI smoke-test workflow was removed repo-wide (no Docker in CI).

## Open Questions

1. `authenticateByApiKey` scans all active merchants per request — at what merchant count does this need a `key_id` prefix lookup (store `pk_<keyid>_<secret>`, index on `key_id`)?
2. Ledger writes use a normal PG transaction; the architecture calls for SERIALIZABLE isolation on balance updates. Is the current isolation level sufficient under concurrent captures against the same merchant account, or do we need explicit row locks?
3. Idempotency responses are cached for 24h — what's the right behavior when a retry arrives *after* expiry for a payment that did commit? (The DB `UNIQUE` catches the duplicate, but the cached response body is gone.)
4. Chargebacks are recorded but there's no evidence-submission/dispute-lifecycle worker — where should that state machine live?

## Resources

- [Double-entry bookkeeping for engineers](https://www.moderntreasury.com/journal/accounting-for-developers-part-i)
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [cockatiel (circuit breaker / resilience)](https://github.com/connor4312/cockatiel)
