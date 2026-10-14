# Payment System — Architecture

## System Overview

A payment platform in the style of Stripe: merchants call an API to charge a customer's card, capture or void the authorization, refund it, and get webhooks as the payment moves through its life, while every movement of money is recorded in a double-entry ledger. The hard part is not throughput. It is **moving money exactly once** when every network hop can fail: a merchant retries after a timeout, the card processor (PSP) never answers, two refunds race, a process dies between the processor call and the database commit. The design answers that with three mechanisms that reinforce each other: **idempotency keys stored with the payment itself**, a **guarded payment state machine**, and an **append-only ledger whose balance the database enforces**.

This document describes the production-scale design first, then — in [Implementation Notes](#implementation-notes) — what the local Express + PostgreSQL + Redis + RabbitMQ + React implementation actually does.

**Learning goals**

- Idempotency end to end: client key, server claim, processor reference, replay semantics.
- Double-entry bookkeeping as a database invariant rather than an application convention.
- A payment state machine whose transitions are compare-and-set, so races have exactly one winner.
- Treating "the processor didn't answer" as a third outcome that is reconciled, never retried blindly.
- At-least-once webhooks from a transactional outbox, with consumers that deduplicate.

## Requirements

### Functional requirements

1. **Create a payment**: authorize a card for an amount, optionally capturing immediately (`capture_method = automatic`) or later (`manual`).
2. **Capture or void** an authorization; **refund** a captured payment fully or in parts.
3. **Disputes**: record chargebacks and their outcome, with the money movement each implies.
4. **Merchant balance and reports** derived from the ledger, plus a daily reconciliation against the processor's settlement file.
5. **Webhooks** for every state change (`payment.captured`, `refund.succeeded`, ...), signed and retried.
6. **Merchant dashboard**: search payments, see a payment's timeline and ledger entries, issue refunds.

Out of scope: payouts to merchant bank accounts, multi-currency conversion, subscriptions and invoicing, card vaulting beyond tokenization, and building the card network side of the processor.

### Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Payment API availability | 99.99% (about 52 minutes a year) |
| Authorization latency | p99 < 1.5 s end to end; our own overhead p99 < 100 ms (the processor dominates) |
| Duplicate charges | Zero: at most one processor authorization per payment, whatever the client retries |
| Ledger correctness | Every journal balances, enforced at commit; account balances equal the sum of their entries |
| Durability | A payment acknowledged to the merchant survives the loss of the primary database (synchronous replica) |
| Unknown outcomes | Resolved within 5 minutes of the processor timing out |
| Webhooks | At least once; 99% delivered within 1 minute to a healthy endpoint; retried for 3 days |
| Audit | Seven-year retention of payments and ledger entries |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Payments | 50M/day → ~580/s average, ~3,000/s peak (holiday spikes ~5×) | One primary handles it today; shard by merchant later |
| API writes | ~2 per payment (create, then capture or refund for some) → ~1,200/s average | Stateless API tier, horizontal |
| Processor calls | ~750/s average | Circuit breaker and bulkhead per processor |
| Unknown outcomes | ~0.05% of calls time out → ~25,000/day | Small volume, but each is money at risk: the reconciler must be reliable, not fast |
| Ledger entries | 3 per capture plus refunds and disputes → ~155M/day ≈ 25 GB/day with indexes | ~9 TB/year; partition monthly, archive after 13 months |
| Payment rows | ~1 KB × 50M/day ≈ 50 GB/day | ~18 TB/year; 7-year retention lives mostly in cold storage |
| Webhook events | ~3 per payment → ~150M/day, ~1,700/s average | Kafka partitions keyed by merchant; dispatcher pool scales with lag |
| Hot ledger rows | Every capture credits platform revenue and debits receivables | ~3,000 updates/s on two rows at peak: shard system accounts (see [Scalability](#scalability-considerations)) |

The number that shapes the ledger design is the last one. A single PostgreSQL row can take roughly 1,000–2,000 locked updates per second, so a "platform revenue" account with a stored running balance becomes the bottleneck long before disk or CPU do.

### Local Development Scale

One Express process, a reconciler process, two optional RabbitMQ workers (webhooks, async fraud), PostgreSQL, Redis and the Vite dev server; a few hundred payments a day from the dashboard's test-payment form and `curl`. `dev:server1..3` run extra API instances against the same database to exercise the concurrency guarantees. Ports and setup are in the [README](./README.md).

## High-Level Architecture

```
  ┌───────────────────────────┐                           ┌───────────────────────────┐
  │ Merchant backend          │                           │ Merchant dashboard (SPA)  │
  │ server-side API client    │                           │ payments and refunds      │
  └─────────────┬─────────────┘                           └─────────────┬─────────────┘
                │ (1) POST /v1/payments                                 │ GET /v1/payments, refunds
                │     Idempotency-Key: K                                │
                ▼                                                       ▼
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │ API gateway · TLS · API keys and dashboard sessions · per-merchant rate limits    │
  └────────────────────────────────────────┬──────────────────────────────────────────┘
                                           ▼
  ┌────────────────┐          ┌─────────────────────────┐ authorize(ref)  ┌────────────────┐
  │ Redis          │ velocity │ Payment API             ├────────────────▶│ PSP / acquirer │
  │ rate limits,   │◀─────────┤ idempotency, state      │                 │ card networks  │
  │ fraud velocity │          │ machine, ledger posting │                 └────────────────┘
  └────────────────┘          └────────────┬────────────┘                         ▲
                                           │ 1 tx: payment, journal, outbox       │ (3) look up ref
                                           ▼                         ┌────────────┴──────────┐
                        ┌──────────────────────────────────┐         │ Reconciler            │
                        │ PostgreSQL primary               │  apply  │ stuck 'pending' rows, │
                        │ payments, ledger_entries, outbox │◀────────┤ settlement files      │
                        └────────────────┬─────────────────┘ outcome └───────────────────────┘
                                         │ (2) outbox relay publishes events
                                         ▼
                                ┌────────────────┐ consume  ┌────────────────────┐
                                │ Kafka          ├─────────▶│ Webhook dispatcher │
                                │ payment-events │          │ retries, then DLQ  │
                                └────────────────┘          └─────────┬──────────┘
                                                                      │ POST, HMAC-signed
                                                                      ▼
                                                            ┌────────────────────┐
                                                            │ Merchant's webhook │
                                                            │ endpoint (HTTPS)   │
                                                            └────────────────────┘
```

1. **Create (1).** The merchant's server calls `POST /v1/payments` with an `Idempotency-Key`. The Payment API claims the key by inserting the payment as `pending` (a unique index on merchant and key decides who owns it), scores fraud using velocity counters in Redis, and asks the processor to authorize using the payment id as the processor's idempotency reference. It then commits the new status, the ledger journal and an outbox row in one PostgreSQL transaction and answers `201`.
2. **Notify (2).** An outbox relay publishes committed outbox rows to Kafka. The webhook dispatcher signs each event with the merchant's secret and delivers it, retrying with backoff for three days before dead-lettering it.
3. **Reconcile (3).** If the processor never answers, the payment stays `pending` and the merchant gets `202`. The reconciler finds payments stuck in `pending`, asks the processor what happened to that reference, and applies the answer through the same guarded transition. Once a day it also matches the processor's settlement file against the ledger.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, API-key and session auth, per-merchant rate limits | Requests | Rejects bad keys before they reach the Payment API |
| Payment API | Idempotency claim, fraud rules, processor calls, state machine, ledger posting | Payment rate | Stateless; all state is in PostgreSQL |
| PostgreSQL | Payments, refunds, ledger journals and entries, outbox | Writes (~1,200/s) | Source of truth; synchronous replica; shard by merchant later |
| Redis | Rate-limit counters, fraud velocity windows | Requests | Not on the correctness path: losing it weakens fraud scoring, never duplicates a charge |
| PSP / acquirer | Authorizes, captures and refunds on the card networks | — | External; every call carries our reference |
| Reconciler | Resolves unknown outcomes; matches settlement files to the ledger | Stuck payments (~25K/day) | Several instances claim work with `SKIP LOCKED` |
| Kafka · payment-events | Durable, replayable event log | Event rate | Partitioned by merchant so a merchant's events stay ordered |
| Webhook dispatcher | Signs and delivers events, retries, dead-letters | Consumer lag | One slow merchant cannot block others: per-endpoint concurrency limits |

The Payment API and the reconciler are the only writers of payment state, and both go through the same transition function. That is what lets a timeout, a crash and a retry all converge on one answer.

## Core Components / Request Flows

### Payment state machine

```
 pending ──▶ authorized ──▶ captured ──▶ partially_refunded ──▶ refunded
    │             │             │                                  ▲
    ▼             ▼             └──────────────────────────────────┘
  failed        voided
```

Every status change is a compare-and-set: `UPDATE payments SET status = 'captured' ... WHERE id = $1 AND status = 'authorized'`. When two requests race — two captures, a capture and a void, the live request and the reconciler — exactly one `UPDATE` matches a row; the other sees zero rows, re-reads the payment and answers from its real state (a repeated capture returns the captured payment; a capture after a void is a `409`). No transition reads the status in one statement and writes it in another.

**Only capture writes to the ledger.** An authorization is a hold on the customer's card: no money has moved, and a voided or expired hold never will. If authorization wrote entries, the books would show revenue the platform may never receive and every abandoned pre-order would need a compensating entry. Holds also expire (typically after 7 days), so `authorized_until` is tracked and a sweeper voids stale authorizations before the processor silently releases them.

### Creating a payment

```
Merchant                      Payment API                                PostgreSQL    PSP
    │                              │                                          │         │
    │ 1 POST /v1/payments (key K)  │                                          │         │
    │─────────────────────────────▶│                                          │         │
    │                              │ 2 INSERT pending ON CONFLICT DO NOTHING  │         │
    │                              │─────────────────────────────────────────▶│         │
    │                              │ 3 1 row: this request owns K             │         │
    │                              │◀─────────────────────────────────────────│         │
    │                              │ 4 fraud score (Redis velocity)           │         │
    │                              │ 5 authorize(ref = payment id)                      │
    │                              │───────────────────────────────────────────────────▶│
    │                              │ 6 approved, psp_ref                                │
    │                              │◀───────────────────────────────────────────────────│
    │                              │ 7 1 tx: status, journal, outbox          │         │
    │                              │─────────────────────────────────────────▶│         │
    │ 8 201 {status: captured}     │                                          │         │
    │◀─────────────────────────────│                                          │         │
    │                              │                                          │         │
```

- **Step 2 is the idempotency claim.** `INSERT ... ON CONFLICT (merchant_id, idempotency_key) DO NOTHING` returns a row only to the first request. A later request with the same key reads the existing payment: same body (by SHA-256 fingerprint) → replay it with `Idempotent-Replayed: true`; different body → `422`; still `pending` → `409` with `Retry-After`.
- **Step 5 carries our payment id as the processor's idempotency key**, so even a retry of the processor call cannot create a second authorization.
- **Step 7 is one transaction**: the guarded `pending → authorized → captured` transitions, the capture journal (debit receivables for the gross, credit the merchant for the net, credit revenue for the fee) and the outbox row. If any part fails, none of it happened.
- Fraud scoring runs before the processor call; a score above 90 fails the payment without calling out, and 70–90 asks the processor for 3-D Secure.

### When the processor doesn't answer

```
Merchant                     Payment API   PostgreSQL             PSP                Reconciler
    │                             │             │                  │                      │
    │ 1 POST /v1/payments, key K  │             │                  │                      │
    │────────────────────────────▶│             │                  │                      │
    │                             │ 2 authorize(ref = payment id)  │                      │
    │                             │───────────────────────────────▶│                      │
    │                             │ 3 no answer (timeout)          │                      │
    │                             │◀───────────────────────────────│                      │
    │ 4 202 {status: pending}     │             │                  │                      │
    │◀────────────────────────────│             │                  │                      │
    ····································· 30 s later ······································
    │                             │             │ 5 claim rows (SKIP LOCKED)              │
    │                             │             │◀────────────────────────────────────────│
    │                             │             │                  │ 6 look up ref        │
    │                             │             │                  │◀─────────────────────│
    │                             │             │                  │ 7 approved, psp_ref  │
    │                             │             │                  │─────────────────────▶│
    │                             │             │ 8 guarded UPDATE + journal              │
    │                             │             │◀────────────────────────────────────────│
    ························· merchant retries with the same key ··························
    │ 9 POST /v1/payments, key K  │             │                  │                      │
    │────────────────────────────▶│             │                  │                      │
    │ 10 200 replay: captured     │             │                  │                      │
    │◀────────────────────────────│             │                  │                      │
    │                             │             │                  │                      │
```

A timeout after the request was sent is **not** a decline: the processor may have authorized the card. Marking the payment `failed` invites the merchant to retry with a new key and charge twice; retrying the call with a new reference is the same mistake made by the server. So the payment stays `pending`, the merchant gets `202`, and the reconciler asks the processor about that exact reference:

| Processor says | Reconciler does |
|----------------|-----------------|
| Approved | Apply the approval: authorize, and capture with its journal if `capture_method` is automatic |
| Declined | Fail the payment |
| Never heard of it | Resubmit under the **same** reference; the processor deduplicates, so at most one authorization can exist |
| Still no answer | Leave it for the next pass; alert if a payment stays `pending` for more than 5 minutes |

Claiming work is one statement — `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *` — that also bumps `updated_at` as a lease, so several reconcilers never pick the same payment and a live request still inside its first 30 seconds is left alone. If the circuit breaker is open, the request never left our process; that is a known non-attempt, safe to report as `failed`.

### Refunding a payment

```
 Dashboard                               Payment API                                    PostgreSQL
     │                                        │                                              │
     │ 1 POST /payments/{id}/refunds, key R   │                                              │
     │───────────────────────────────────────▶│                                              │
     │                                        │ 2 BEGIN; SELECT payment FOR UPDATE           │
     │                                        │─────────────────────────────────────────────▶│
     │                                        │ 3 captured 10,000 (later refunds wait here)  │
     │                                        │◀─────────────────────────────────────────────│
     │                                        │ 4 refund with key R exists? (replay)         │
     │                                        │─────────────────────────────────────────────▶│
     │                                        │ 5 SUM(refunds): 7,000 refundable             │
     │                                        │─────────────────────────────────────────────▶│
     │                                        │ 6 INSERT refund, journal, status, outbox     │
     │                                        │─────────────────────────────────────────────▶│
     │                                        │ 7 COMMIT (trigger: journal balances)         │
     │                                        │─────────────────────────────────────────────▶│
     │ 8 201 refund | 422 exceeds refundable  │                                              │
     │◀───────────────────────────────────────│                                              │
     │                                        │                                              │
```

- **The row lock serializes refunds of one payment.** Without it, two partial refunds both read "7,000 refundable", both pass the check and refund 14,000. With `SELECT ... FOR UPDATE`, the second waits, then sees the first refund and is rejected with `422`.
- Pending refunds count against the refundable amount; only succeeded refunds count when computing the fee to return.
- **Fee rounding is cumulative**: each partial refund returns `round(fee × refunded_after / amount) − round(fee × refunded_before / amount)`, so a series of partial refunds that adds up to the full amount returns exactly the original fee — no cent lost to rounding.
- The refund's idempotency key is checked under the same lock, so a retry finds the refund it already created.

### Delivering webhooks

```
Outbox relay                      Kafka     Dispatcher                  Merchant
      │                             │            │                          │
      │ 1 publish payment.captured  │            │                          │
      │────────────────────────────▶│            │                          │
      │ 2 ack: mark row sent        │            │                          │
      │◀────────────────────────────│            │                          │
      │                             │ 3 consume  │                          │
      │                             │◀───────────│                          │
      │                             │            │ 4 POST, signed           │
      │                             │            │─────────────────────────▶│
      │                             │            │ 5 503 or timeout         │
      │                             │            │◀─────────────────────────│
      │                             │            │ 6 backoff, up to 3 days  │
      │                             │            │ 7 POST same event_id     │
      │                             │            │─────────────────────────▶│
      │                             │            │ 8 200, dedupes event_id  │
      │                             │            │◀─────────────────────────│
      │                             │            │                          │
```

Events are written to the outbox inside the transaction that changed the payment, so an event exists if and only if the change committed. The relay marks rows sent only after Kafka acknowledges them; a crash in between republishes, and every event carries a stable `event_id` that merchants deduplicate on. Each delivery is signed with `HMAC-SHA256(secret, timestamp + "." + body)`; merchants reject signatures older than five minutes to stop replays. After three days of failures the event goes to a dead-letter store and the dashboard shows the endpoint as failing; merchants can always catch up from `GET /v1/events`.

## Database Schema

### Production schema

PostgreSQL holds everything that must be correct. Money is `BIGINT` minor units (cents) everywhere; floats never touch an amount.

```sql
CREATE TABLE accounts (
  id          UUID PRIMARY KEY,
  owner_id    UUID,                          -- merchant id; NULL for platform accounts
  kind        TEXT NOT NULL,                 -- receivable, merchant_payable, fee_revenue, ...
  shard       SMALLINT NOT NULL DEFAULT 0,   -- platform accounts are split into 64 shards
  currency    CHAR(3) NOT NULL,
  balance     BIGINT NOT NULL DEFAULT 0,     -- credit-positive; always = signed sum of entries
  UNIQUE (owner_id, kind, shard, currency)
);

CREATE TABLE payments (
  id               UUID PRIMARY KEY,         -- also the processor idempotency reference
  merchant_id      UUID NOT NULL,
  idempotency_key  TEXT,
  request_hash     CHAR(64),                 -- SHA-256 of the creating request
  amount           BIGINT NOT NULL CHECK (amount > 0),
  currency         CHAR(3) NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'authorized', 'captured',
                     'partially_refunded', 'refunded', 'voided', 'failed')),
  capture_method   TEXT NOT NULL DEFAULT 'automatic',
  psp_reference    TEXT,
  authorized_until TIMESTAMPTZ,              -- hold expiry
  reconcile_attempts INT NOT NULL DEFAULT 0,
  version          INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key)      -- the idempotency claim
);
CREATE INDEX payments_stuck ON payments (updated_at) WHERE status = 'pending';

CREATE TABLE refunds (
  id               UUID PRIMARY KEY,
  payment_id       UUID NOT NULL REFERENCES payments(id),
  merchant_id      UUID NOT NULL,
  idempotency_key  TEXT,
  request_hash     CHAR(64),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key)
);

CREATE TABLE journals (
  id          UUID PRIMARY KEY,
  payment_id  UUID NOT NULL REFERENCES payments(id),
  kind        TEXT NOT NULL,                 -- capture, refund, chargeback, chargeback_reversal
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  journal_id  UUID NOT NULL REFERENCES journals(id),
  account_id  UUID NOT NULL REFERENCES accounts(id),
  direction   TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount      BIGINT NOT NULL CHECK (amount > 0),
  currency    CHAR(3) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- Plus: a DEFERRABLE INITIALLY DEFERRED constraint trigger that rejects any journal
-- whose debits and credits differ at COMMIT, and a trigger that rejects UPDATE/DELETE.

CREATE TABLE outbox (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     UUID NOT NULL UNIQUE,
  merchant_id  UUID NOT NULL,
  type         TEXT NOT NULL,                -- payment.captured, refund.succeeded, ...
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```

Two schema decisions matter more than they look:

- **The idempotency key lives on the payment row**, not in a separate cache with a TTL. The claim, the payment and the money movement are in one database, so a key cannot be "forgotten" while its payment exists, and a retry a week later still replays instead of charging again.
- **`payments` cannot be range-partitioned by time** while `UNIQUE (merchant_id, idempotency_key)` must hold across all time: PostgreSQL requires the partition key in every unique index. Payments are sharded by `merchant_id` instead; the append-only `ledger_entries` table, which needs no business-level unique key, is the one partitioned by month.

### Local schema

The local schema is [`backend/src/db/init.sql`](./backend/src/db/init.sql); every statement is guarded, so it can be applied repeatedly to a fresh or existing database. It maps to the production design like this:

| Production | Local | Difference |
|------------|-------|------------|
| `payments` | `transactions` | Same idempotency columns (`idempotency_key`, `request_hash`, unique per merchant), `auto_capture` instead of `capture_method`, `processor_ref`, `reconcile_attempts`, a `CHECK` on status; no `authorized_until` |
| `journals` + `ledger_entries` | `ledger_entries` with a `journal_id` column | No separate journals table; the same deferred balance trigger and append-only trigger; not partitioned; entries also carry `balance_after` |
| `accounts` (sharded) | `accounts` | Three platform accounts plus one per merchant, no shards; credit-positive balances |
| `refunds` | `refunds` | Unique `(merchant_id, idempotency_key)`, `request_hash`; statuses `pending`/`completed`/`failed` |
| `outbox` | — | Not implemented: events are published to RabbitMQ after commit |
| Chargebacks, webhook deliveries, audit | `chargebacks`, `webhook_deliveries`, `audit_log` | Same idea |

## API Design

### Production API

```
POST /v1/payments                  Idempotency-Key → 201 | 202 pending | 200 replay | 409 in progress | 422 key reused
GET  /v1/payments?status&cursor    merchant's payments, newest first (keyset pagination)
GET  /v1/payments/{id}             current state, timeline, refundable amount
POST /v1/payments/{id}/capture     authorized → captured; repeat → 200; wrong state → 409
POST /v1/payments/{id}/void        authorized → voided; repeat → 200; wrong state → 409
POST /v1/payments/{id}/refunds     Idempotency-Key, amount ≤ refundable → 201 | 422
GET  /v1/events?after={event_id}   the same events webhooks deliver, for catching up
GET  /v1/balance                   merchant balance, derived from the ledger
```

- **`202 Accepted`** means "we don't know yet": the processor did not answer. The body is the `pending` payment; the client polls or waits for the webhook, and may safely retry with the same key.
- **Errors** are `application/problem+json` with a machine-readable `code` (`invalid_state`, `amount_exceeds_refundable`, `idempotency_key_reused`, `request_in_progress`).
- **Amounts** are integers in minor units with an explicit currency; the API rejects fractional or negative amounts at the boundary.

### Local routes

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/api/v1/merchants` | Public signup → `201` with the API key, shown once |
| GET, PATCH, POST | `/api/v1/merchants/me`, `/me/stats`, `/me/volume`, `/me/webhook`, `/me/rotate-key` | Profile, dashboard stats, webhook URL, key rotation |
| POST | `/api/v1/payments` | Optional `Idempotency-Key` (1–64 chars); amount 50–99,999,999 cents → `201`, `202` pending, `200` replay, `400`, `409` in progress, `422` key reused |
| GET | `/api/v1/payments`, `/:id`, `/:id/refunds`, `/:id/ledger` | List (`limit`/`offset`), detail, refunds, ledger entries; owner only (`403` otherwise) |
| POST | `/api/v1/payments/:id/capture`, `/:id/void` | Guarded transition → `200` (also on repeat), `404`, `409` |
| POST | `/api/v1/payments/:id/refund` | Optional key; amount defaults to the remainder → `201`, `200` replay, `404`, `409`, `422` |
| GET, POST | `/api/v1/refunds`, `/api/v1/chargebacks`, `/:id/respond` | Lists and details; dispute response is a stub |
| GET | `/api/v1/ledger/verify`, `/summary` | Debit/credit totals, unbalanced journals, account drift |
| GET | `/health`, `/health/live`, `/health/ready`, `/metrics` | Operations |

## Key Design Decisions

### 1. Idempotency lives in PostgreSQL, next to the money

A payment API's worst failure is charging a customer twice, and the classic cause is a client retrying after a timeout. The idempotency record must therefore be at least as durable as the payment it protects, and it must be claimed atomically. A Redis cache with a 24-hour TTL fails on both counts: an `appendonly everysec` Redis can lose the last second of claims in a crash, and a key that expires while its payment lives means a retry next week charges again. Putting the key on the payment row turns the claim into a unique-index insert in the same database as the money movement — exactly one of N concurrent requests wins, with no second system to keep consistent. The cost is a database round trip on every create (about 1 ms, against a 300–800 ms processor call) and a unique index that grows with the payments table, which is why payments are sharded by merchant rather than range-partitioned by time.

### 2. The ledger's balance is a database invariant

Every movement of money is a journal: entries that sum to zero. Checking that in application code works until someone adds a new journal type or a hand-written migration posts one entry of a pair — and an unbalanced ledger is discovered weeks later at month-end close, when nobody remembers why. A deferred constraint trigger checks each journal at `COMMIT`, after all its entries exist, and aborts the whole transaction if debits and credits differ; a second trigger makes entries append-only, so corrections are reversing journals and history is never edited. The alternative — a single mutable `balance` column per account — is cheaper to write but has no audit trail and cannot be reconciled after a bug. What we give up is write amplification (three entries and three balance updates per capture instead of one `UPDATE`) and a hot-row problem on platform accounts, addressed in [Scalability](#scalability-considerations).

### 3. Timeouts are a third outcome, resolved by reconciliation

Treating a processor timeout as a decline is the most common way payment systems double-charge. The processor may have approved the card; we just never heard. If we mark the payment failed, the merchant retries under a new key and the customer has two holds. If the server retries the processor call under a new reference, the same thing happens one layer down. So the processor call carries our payment id as its idempotency reference, a timeout leaves the payment `pending` with a `202`, and the reconciler resolves it by asking the processor about that reference — resubmitting under the same reference only if the processor has never heard of it. What we give up is a clean synchronous answer: the merchant must handle `202` and wait for a webhook, and a small fraction of customers see "processing" for up to a few minutes.

### 4. Compare-and-set transitions instead of read-then-write

The original failure mode is easy to write: read the payment, check `status = 'authorized'`, then post the capture journal and update the status. Two concurrent captures both pass the check and post two journals — the merchant is credited twice for one payment. Wrapping the read in `SELECT ... FOR UPDATE` would work but holds a row lock across the processor call. A guarded `UPDATE ... WHERE status = 'authorized' RETURNING *` inside the ledger transaction makes the transition itself the check: one request matches the row and posts the journal; the other matches nothing and answers from the current state. Refunds are the exception, because their guard is an amount ("refunded so far + this ≤ captured") rather than a status, so they take the row lock — briefly, and never across a network call.

### 5. A transactional outbox for events, at-least-once webhooks

Publishing an event to the broker after the database commit is a dual write: a crash between the two loses the event, and publishing before the commit can announce a payment that then rolls back. Writing the event into an outbox table in the same transaction as the state change, and relaying it to Kafka afterwards, makes the event exist exactly when the change does. Delivery is then at least once — the relay or the dispatcher may send an event twice — so every event carries a stable `event_id` and the contract tells merchants to deduplicate on it. The cost is a relay process to operate and a few hundred milliseconds of extra latency on webhooks.

### 6. A circuit breaker on the processor, designed with idempotency

When the processor degrades, a plain timeout means every in-flight payment holds a connection for the full timeout; the pool drains, and unrelated endpoints (dashboard reads, refunds) start failing. A breaker that opens after five consecutive failures rejects new authorizations in microseconds, keeping the blast radius on the payment path; a half-open probe after 30 seconds recovers automatically. The two designs depend on each other: fail-fast rejection makes client retries more likely, and the idempotency key is what makes those retries safe. A rejection by the open breaker is a known non-attempt, so it is the one processor failure that may be reported as `failed`.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Create payment | At most one payment and one processor authorization per (merchant, key) | Unique-index claim on the payment row; payment id as the processor reference |
| Retry with the same key | Replays the payment's current state; `409` while pending; `422` for a different body | `request_hash` fingerprint compared on conflict |
| Capture / void | Exactly one transition and one capture journal under any concurrency | Compare-and-set `UPDATE ... WHERE status = ...` inside the ledger transaction |
| Refund | Refunded total never exceeds the captured amount | `SELECT ... FOR UPDATE` on the payment; key checked under the lock |
| Ledger | Every journal balances; entries are never edited | Deferred constraint trigger; append-only trigger |
| Account balances | Equal the signed sum of their entries | Updated in the journal's transaction; nightly drift check |
| Unknown outcome | Converges to the processor's answer exactly once | Reconciler with `SKIP LOCKED` leases and the same guarded transitions |
| Events and webhooks | Emitted if and only if the change committed; delivered at least once | Transactional outbox; stable `event_id`; consumer deduplication |

Reads are strongly consistent on the primary for anything that feeds a money decision (the refundable amount, the current status). Dashboards and reports may read replicas, which lag by well under a second.

## Security / Auth

- **Merchant API keys** are high-entropy random secrets of the form `sk_live_<key_id>_<secret>`. The `key_id` is indexed, so authentication is one lookup, and the secret is stored as SHA-256 — sufficient for 256-bit random secrets; slow hashes like bcrypt exist for low-entropy passwords. Publishable keys (`pk_`) can only tokenize cards from the browser.
- **The dashboard** uses a session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`) and role-based permissions (support can read, operations can refund, admins manage merchants). Secret API keys never reach the browser.
- **Authorization:** every payment, refund and ledger read is scoped to the authenticated merchant; platform-wide ledger reports are an internal role only.
- **Card data** is entered in an iframe served from the platform's domain and tokenized there, so raw card numbers never touch the merchant's servers or the Payment API (PCI scope stays in the vault).
- **Webhooks** are signed with a per-merchant secret over timestamp and body; merchants verify the signature and reject stale timestamps.
- **Audit:** every money-moving action is written to an append-only audit log with actor, IP and before/after state.
- **Rate limits** per merchant and per key at the gateway, backed by Redis; they fail open, because they protect capacity, not correctness.

## Observability

- **Payments:** outcomes by status and processor, authorization latency (ours vs the processor's), processor timeout rate, breaker state.
- **Unknown outcomes:** count and age of `pending` payments (alert when any is older than 5 minutes), reconciler results (`authorized`, `failed`, `still_pending`, `needs_review`).
- **Idempotency:** new claims, replays, in-progress conflicts and body mismatches per merchant; a spike in mismatches usually means a client bug reusing keys.
- **Ledger:** journal-balance trigger violations (must be zero; any is a page), nightly account-drift results, settlement-file differences.
- **Events:** outbox lag (oldest unpublished row), Kafka consumer lag, webhook success rate and retry depth per endpoint, dead-letter count.
- Structured logs carry the request id, merchant id and payment id; traces span gateway → Payment API → PostgreSQL → processor.

## Failure Handling

| Failure | What happens | Mitigation |
|---------|--------------|------------|
| Processor times out | Payment stays `pending`; merchant gets `202` | Reconciler looks up the reference; resubmits only under the same reference |
| Processor down | Breaker opens; new payments fail fast as not attempted | Half-open probe after 30 s; optional failover to a second processor for new payments only |
| Payment API crashes mid-request | Payment stays `pending` (or `authorized`) | Reconciler resolves it; a client retry with the same key gets `409`, then the result |
| Concurrent duplicate requests | One claim wins | Others get `409` while in flight, then replays |
| PostgreSQL primary lost | Writes fail with `503` for the failover window | Synchronous replica promoted; nothing acknowledged is lost |
| Redis down | Fraud scoring loses velocity signals; rate limits open | Payments continue; the risk team is alerted |
| Kafka down | Outbox grows; webhooks are delayed, not lost | Relay resumes from the oldest unpublished row |
| Merchant endpoint failing | Retries with backoff for 3 days | Dead-letter store, dashboard alert, `GET /v1/events` to catch up |
| Ledger bug posts an unbalanced journal | The transaction aborts; nothing is written | Trigger violation alert; fix forward with a reversing journal if ever needed |

## Scalability Considerations

1. **Hot platform accounts break first.** Every capture updates the receivables and revenue balances; at ~3,000 captures/s that is more than one row lock can serialize. Platform accounts are split into 64 shards (`shard = hash(payment_id) % 64`), each a row of its own, and reports sum the shards. Large merchants get the same treatment for their payable account.
2. **Shard by merchant.** A payment, its refunds, journals and outbox rows share a `merchant_id`, so a hash-sharded cluster keeps every transaction on one shard; each shard has its own platform sub-accounts, consolidated in reporting. Cross-merchant queries (risk, finance) read from a warehouse fed by the event stream.
3. **Read replicas for dashboards**, with money decisions (refundable amount, capture) always on the primary.
4. **Ledger storage:** monthly partitions; partitions older than 13 months are exported to columnar files in object storage and detached, keeping the hot ledger around 10 TB.
5. **Webhooks** scale by Kafka partitions and dispatcher instances, with per-endpoint concurrency caps so one slow merchant cannot consume the pool.
6. **Multiple processors**: routing by card network or region, each with its own breaker; a payment's processor is fixed at creation so reconciliation always asks the right one.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Idempotency store | Key on the payment row in PostgreSQL | Redis with 24 h TTL | Same durability and transaction as the money; never expires |
| Ledger invariant | Deferred trigger + append-only entries | Application checks, mutable balances | Bugs abort at commit instead of surfacing at month-end |
| Processor timeouts | `pending` + reconcile by reference | Treat as decline, or retry | Never a second authorization; costs a `202` path |
| State changes | Compare-and-set transitions | Read-then-write, or long row locks | One winner per race; no locks across network calls |
| Refund limits | Row lock on the payment | Optimistic retry | The guard is an amount, not a status; lock is short |
| Events | Transactional outbox → Kafka | Publish after commit | No lost or phantom events |
| Webhook delivery | At least once + `event_id` dedupe | Exactly once | Exactly once across the internet is not achievable |
| Processor isolation | Circuit breaker + idempotency | Timeouts only | Keeps the pool alive; retries stay safe |
| Scaling the ledger | Sharded platform accounts | One global revenue row | One row cannot take thousands of locked updates per second |

## Implementation Notes

The local project runs the payment lifecycle on a single-node stack: one Express process ([`backend/src/index.ts`](./backend/src/index.ts)), a reconciler worker, PostgreSQL 16 and Redis from [`docker-compose.yml`](./docker-compose.yml) (plus RabbitMQ for the optional webhook and fraud workers), and a React 19 + TanStack Router + Zustand dashboard. This section maps the production design to the code as of the 2026-10-10 review.

### Production design → local implementation

| Production design | Local implementation | Where |
|-------------------|----------------------|-------|
| Gateway auth and rate limits | API-key bearer auth in Express; no rate limiting | [middleware/auth.ts](./backend/src/middleware/auth.ts) |
| Idempotency on the payment row | Implemented: unique `(merchant_id, idempotency_key)`, request fingerprint, replay / `409` / `422` | [transaction.ts](./backend/src/services/payment/transaction.ts), [authorize.ts](./backend/src/services/payment/authorize.ts) |
| Guarded state machine | Implemented for every transition | [state-machine.ts](./backend/src/services/payment/state-machine.ts) |
| Journals with a deferred balance trigger | Implemented (`journal_id` column, deferred trigger, append-only trigger) | [init.sql](./backend/src/db/init.sql), [ledger.service.ts](./backend/src/services/ledger.service.ts) |
| Processor with reference idempotency | Simulated processor that keeps its own records in Redis | [processor.ts](./backend/src/services/payment/processor.ts) |
| Reconciler | Implemented for unknown authorization outcomes; no settlement-file matching | [reconcile.ts](./backend/src/services/payment/reconcile.ts), [workers/reconciler.ts](./backend/src/workers/reconciler.ts) |
| Refund under a row lock | Implemented, with per-merchant keys and cumulative fee rounding | [refund.service.ts](./backend/src/services/refund.service.ts) |
| Outbox → Kafka → dispatcher | Best-effort publish to RabbitMQ after commit; worker with retries | [capture.ts](./backend/src/services/payment/capture.ts), [queue.ts](./backend/src/shared/queue.ts), [webhook-worker.ts](./backend/src/workers/webhook-worker.ts) |
| Circuit breaker | cockatiel, opens after 5 consecutive failures, half-open after 30 s | [circuit-breaker.ts](./backend/src/shared/circuit-breaker.ts) |

### Ledger enforced by PostgreSQL

Captures, refunds and chargebacks are built as journals by pure functions (`buildCaptureJournal`, `buildRefundJournal`, `buildChargebackJournal`, `buildChargebackReversalJournal`) and posted by `postJournal()`, which refuses an unbalanced set before touching the database and updates accounts in id order so two journals can never deadlock on each other's rows. `balance = balance + delta` under the row lock is what keeps `balance_after` exact, so `READ COMMITTED` is sufficient. The database re-checks every journal at commit:

```sql
-- backend/src/db/init.sql (abridged)
SELECT COALESCE(SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE -amount END), 0), COUNT(*), COUNT(DISTINCT currency)
  INTO imbalance, entry_count, currencies
  FROM ledger_entries WHERE journal_id = NEW.journal_id;
IF imbalance <> 0 OR entry_count < 2 OR currencies <> 1 THEN
    RAISE EXCEPTION 'ledger journal % is unbalanced ...', NEW.journal_id USING ERRCODE = 'check_violation';
END IF;
-- CREATE CONSTRAINT TRIGGER ledger_journal_balanced AFTER INSERT ON ledger_entries
--   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ledger_journal_balanced();
```

- `ledger_entries` rejects `UPDATE` and `DELETE`. Balances are credit-positive for every account, so receivables reads negative and all balances sum to zero.
- `GET /api/v1/ledger/verify` reports window totals, unbalanced journals and per-account drift (stored balance vs the sum of entries).
- Refund and chargeback entries reference the original payment (`transaction_id`) and their own `journal_id`. Before the 2026-10 review they used the refund or chargeback id as `transaction_id`, which violates the foreign key, so every refund failed; a won dispute also changed the merchant's balance without any ledger entry.
- The seed's balances equal the sum of its entries, and it now includes the journals for its partial refund and its chargeback.

### Payment state machine and idempotency

`transitionStatus()` is the only writer of `transactions.status`. It validates the transition against a table, accepts only whitelisted extra columns, and issues `UPDATE ... WHERE id = $1 AND status = ANY($3) RETURNING *`. Capture runs the transition and the capture journal in one transaction; void is a single guarded `UPDATE`. A repeated capture or void returns the payment unchanged (`200`); any other state is `409`.

Payment creation inserts the row as `pending` with `ON CONFLICT (merchant_id, idempotency_key) DO NOTHING`. The request fingerprint is a SHA-256 of the canonical JSON body (sorted keys, idempotency key excluded). Replays return the payment's current state with `Idempotent-Replayed: true` rather than a stored copy of the first response, so a retry after reconciliation shows the final outcome. Without a key, every request creates a payment. Keys are limited to 64 characters (the column width).

### Unknown processor outcomes

The simulated processor stores each decision in Redis under `psp-sim:payment:{reference}` with `SET NX`, so the same reference always gets the same answer. `authorizeWithProcessor()` never throws; it classifies every call as `approved`, `declined`, `not_attempted` (breaker open) or `unknown` (timeout, error). Test cards:

| `last_four` | Behavior |
|-------------|----------|
| `0000` | Declined |
| `0001` | Approved at the processor, response lost: `202`, then the reconciler captures it |
| `0002` | First attempt lost before the processor records it: `202`, then the reconciler resubmits under the same reference |
| anything else | Approved, except `PSP_DECLINE_RATE` (default 5%, 30% above $10,000) random declines |

`npm run dev:reconciler` runs a pass every `RECONCILE_INTERVAL_MS` (15 s) over payments pending for `RECONCILE_AFTER_SECONDS` (30 s); `npm run reconcile:once` runs one pass. After 10 attempts a payment is logged for manual review and left `pending`.

### Refunds, chargebacks and webhooks

- Refunds lock the payment row, replay by key under the lock, count pending and completed refunds against the refundable amount, default to the remainder, and complete synchronously — there is no processor refund call or `pending` refund lifecycle.
- Chargebacks are written by `ChargebackService` (with balanced journals) but no route creates one; the seed contains one. `POST /chargebacks/:id/respond` is a stub.
- Webhooks are published to RabbitMQ after the commit, best effort: a crash or broker outage between commit and publish loses the event (the production outbox closes that gap). The webhook worker signs `timestamp.payload` with HMAC-SHA256 (`X-Signature-256`, `X-Webhook-Timestamp`, `X-Webhook-Id`) and retries five times with exponential backoff capped at 60 s.

### Authentication and known security limits

- Merchants authenticate with a bearer API key (`pk_...`) stored as a bcrypt hash; authentication bcrypt-compares against every active merchant, which is O(merchants) per request. The production `key_id` lookup is not implemented.
- The dashboard logs in with the same secret API key and keeps it in `localStorage` (Zustand `persist`), so any XSS would expose a full-access key. The production design uses a session cookie instead.
- `GET /api/v1/ledger/verify` and `/summary` return platform-wide totals to any authenticated merchant.
- There is no rate limiting and no admin RBAC.

### Operations

Prometheus metrics in [metrics.ts](./backend/src/shared/metrics.ts) include payment outcomes and latency, fraud scores, breaker state, `idempotency_requests_total{outcome}` and `payment_reconcile_total{result}`. Pino writes structured logs with a request id; money-moving actions are also written to the `audit_log` table, which `init.sql` now creates. `/health` checks PostgreSQL, Redis and breaker state; `/health/ready` checks PostgreSQL and Redis. Shutdown closes the HTTP server, then PostgreSQL and Redis, with a forced exit after 30 seconds.

### Verification (2026-10-10)

- `npm test` in `backend/` runs 22 offline vitest tests (journal builders and fee rounding, `postJournal` ordering, the state machine's guarded SQL, request fingerprints, reconciler decisions). Backend `tsc` and lint, and frontend `tsc`, lint and build, are clean.
- Against PostgreSQL 16 and Redis (RabbitMQ absent): `init.sql` loads three times, including on a populated database; 20 concurrent creates with one key produce one `201`, three `409` and sixteen `200` replays, one payment and one journal; a different body gets `422`; another merchant can use the same key; 10 concurrent captures post one journal; a capture-vs-void race has one winner; 10 concurrent 30% refunds produce three refunds and seven `422`; four partial refunds return the fee exactly; cards `0001` and `0002` return `202` and the reconciler captures each with one journal and one processor record; an unbalanced journal inserted by hand fails at `COMMIT`; `UPDATE ledger_entries` is rejected; the final ledger check reports no drift and balances summing to zero.
- Not exercised: the RabbitMQ webhook and fraud workers.

### Simplified or omitted

There is no API gateway, outbox, Kafka, hold-expiry sweeper, 3-D Secure, settlement-file reconciliation, payouts, multi-currency conversion, sharding, read replicas or PCI vault (payment methods are stored as JSON with the last four digits). List endpoints use `limit`/`offset` pagination, and `GET` responses return `BIGINT` amounts as strings (the `pg` default). Five Playwright smoke tests (`tests/smoke.spec.ts`) check page rendering only.
