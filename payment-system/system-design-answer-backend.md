# 💳 Payment System — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "A payment API is a thin wrapper around somebody else's card network, and the volume is modest — a few thousand payments a second at peak. What makes it hard is that money has to move exactly once while every hop can fail: the merchant retries after a timeout, the processor never answers, two refunds race, a process dies between the processor call and our commit. So I'll spend most of my time on three mechanisms — idempotency stored with the payment, a ledger the database refuses to unbalance, and a reconciler for the moments when we genuinely don't know what happened."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and why correctness beats throughput here |
| High-level architecture | 10 min | One overview diagram and the three core flows |
| Data model & API | 7 min | What lives where, and the contract merchants code against |
| Deep dive 1: exactly-once creation | 8 min | Idempotency from the merchant's retry to the processor call |
| Deep dive 2: the ledger | 7 min | Journals that must balance, enforced at commit; hot accounts |
| Deep dive 3: unknown outcomes | 6 min | Timeouts as a third outcome, resolved by reconciliation |
| Scale, failures, wrap-up | 2 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down what 'payment system' means here, because it can mean anything from a checkout button to a bank."

### Functional requirements

1. **Create a payment**: authorize a customer's card through a processor (PSP), capturing immediately or later.
2. **Capture, void and refund**: capture an authorization, release it, or refund a captured payment in full or in parts.
3. **Ledger and balances**: every movement of money is a double-entry journal; merchant balances come from the ledger.
4. **Webhooks**: merchants are notified of every state change, reliably.
5. **Disputes**: record chargebacks and their outcome, with the money movement each implies.

Out of scope: payouts to bank accounts, currency conversion, subscriptions, and the card network itself — I'll treat the PSP as an external API.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Availability | 99.99% for the payment API | A checkout that fails loses the sale outright |
| Authorization latency | p99 < 1.5 s end to end; our overhead p99 < 100 ms | The processor takes 300–800 ms; we must not add much |
| Duplicate charges | Zero | One double charge costs more trust than a thousand slow requests |
| Ledger correctness | Every journal balances, enforced at commit | Finance closes the books from this data |
| Unknown outcomes | Resolved within 5 minutes | A customer sees "processing" until then |
| Webhooks | At least once, 99% within 1 minute, retried for 3 days | Merchants fulfil orders from them |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Payments | 50M/day → ~580/s average, ~3,000/s at holiday peak | One primary database today; shard by merchant later |
| Processor calls | ~750/s | Circuit breaker per processor |
| Processor timeouts | ~0.05% → ~25,000/day | Small, but each one is money at risk |
| Ledger entries | ~3 per capture → ~155M/day, ~25 GB/day with indexes | ~9 TB/year; monthly partitions, archive after 13 months |
| Webhook events | ~3 per payment → ~150M/day, ~1,700/s | A log (Kafka), not a request path |
| Platform revenue account | Touched by every capture → ~3,000 updates/s at peak | More than one row lock can serialize — I'll come back to this |

"The throughput is ordinary. The numbers that matter are 0.05% — twenty-five thousand payments a day where we don't know whether the card was charged — and three thousand updates a second to one revenue row. Both turn into design decisions."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system, then walk the three journeys: creating a payment, notifying the merchant, and resolving a payment when the processor goes quiet."

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

1. **Create (1).** The merchant's server posts a payment with an idempotency key. The Payment API claims the key by inserting the payment as `pending`, scores fraud with velocity counters in Redis, and asks the processor to authorize — passing our payment id as the processor's own idempotency reference. It commits the new status, the ledger journal and an outbox row in one transaction and answers `201`.
2. **Notify (2).** A relay publishes committed outbox rows to Kafka; the webhook dispatcher signs each event and delivers it, retrying for up to three days.
3. **Reconcile (3).** If the processor never answers, the payment stays `pending` and the merchant gets `202`. The reconciler asks the processor what happened to that reference and applies the answer through the same guarded transition the API uses.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| API gateway | TLS, key and session auth, rate limits | Requests | Bad keys never reach the Payment API |
| Payment API | Claim, fraud rules, processor calls, state machine, ledger posting | Payment rate | Stateless |
| PostgreSQL | Payments, refunds, journals, entries, outbox | ~1,200 writes/s | Source of truth; synchronous replica |
| Redis | Rate limits, fraud velocity windows | Requests | Not on the correctness path |
| PSP | Authorize, capture, refund on card networks | — | External; every call carries our reference |
| Reconciler | Resolves unknown outcomes, matches settlement files | ~25K stuck payments/day | Claims work with `SKIP LOCKED` |
| Kafka + dispatcher | Event log and webhook delivery | Event rate | Partitioned by merchant |

"Notice what's *not* here: no Redis in the idempotency path and no distributed transaction. Everything that must agree — the claim, the payment, the journal, the event — commits together in one PostgreSQL transaction. That single decision removes most of the failure modes I'd otherwise have to discuss."

### Flow 1: creating a payment

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

"Step 2 is the idempotency claim, and I'll defend it in the first deep dive. Step 5 is the detail people miss: the processor has its own idempotency, and we feed it our payment id. Step 7 is one transaction — the `pending → authorized → captured` transitions, a three-entry capture journal, and the outbox row. Only capture writes to the ledger: an authorization is a hold on the card, no money has moved, and a voided hold never will."

### Flow 2: refunding a payment

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

"Refunds are the one place I take a row lock. Two partial refunds that both read '7,000 refundable' would both pass and refund 14,000; with the lock, the second waits, sees the first, and gets `422`. The lock is held for a few milliseconds and never across a network call."

### Flow 3: delivering a webhook

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

"The outbox row was written in the same transaction as the payment change, so the event exists exactly when the change does — no lost events if we crash after commit, no phantom events for a rolled-back payment. Delivery is at least once, and I say so in the contract: merchants deduplicate on `event_id`. Each delivery is signed with HMAC-SHA256 over timestamp and body, and merchants reject anything older than five minutes so a captured request can't be replayed."

---

## 💾 Data Model (4 min)

"PostgreSQL holds everything that must be correct. Amounts are integers in minor units — cents — with an explicit currency; floats never touch money."

| Table | Key columns | Indexes and notes |
|-------|-------------|-------------------|
| `payments` | `id` (also the processor reference), `merchant_id`, `idempotency_key`, `request_hash`, `amount`, `currency`, `status`, `capture_method`, `psp_reference`, `authorized_until`, `reconcile_attempts`, `version` | Unique `(merchant_id, idempotency_key)` is the claim; partial index on `updated_at` where status is `pending` feeds the reconciler |
| `refunds` | `id`, `payment_id`, `merchant_id`, `idempotency_key`, `request_hash`, `amount`, `status` | Unique `(merchant_id, idempotency_key)`; index on `payment_id` |
| `accounts` | `id`, `owner_id`, `kind` (receivable, merchant payable, fee revenue), `shard`, `currency`, `balance` | Balance is credit-positive and always equals the signed sum of its entries |
| `journals` | `id`, `payment_id`, `kind` (capture, refund, chargeback, reversal) | One per movement of money |
| `ledger_entries` | `journal_id`, `account_id`, `direction`, `amount`, `currency`, `created_at` | Append-only; partitioned by month; deferred trigger checks each journal balances |
| `outbox` | `event_id` (unique), `merchant_id`, `type`, `payload`, `published_at` | Partial index on unpublished rows for the relay |

Two choices worth saying out loud:

- **The idempotency key lives on the payment row**, not in a cache with a TTL. A retry a week later still finds the payment it created.
- **I shard by `merchant_id`, not by time.** PostgreSQL only enforces a unique index that includes the partition key, so a time-partitioned `payments` table can't guarantee `(merchant_id, idempotency_key)` across partitions. Every table a payment touches carries `merchant_id`, so a hash-sharded cluster keeps each transaction on one shard. The append-only ledger, which needs no business-level unique key, is the table partitioned by month.

"Why not a document store or Cassandra? Because the core of this system is multi-row atomicity — a payment, its journal and its event commit together or not at all — and conditional updates (`WHERE status = 'authorized'`). Those are one-line primitives in PostgreSQL and multi-step protocols elsewhere."

---

## 🔌 API Design (3 min)

```
POST /v1/payments                  Idempotency-Key → 201 | 202 pending | 200 replay | 409 | 422
GET  /v1/payments?status&cursor    merchant's payments, newest first (keyset pagination)
GET  /v1/payments/{id}             current state, timeline, refundable amount
POST /v1/payments/{id}/capture     authorized → captured; repeat → 200; wrong state → 409
POST /v1/payments/{id}/void        authorized → voided; repeat → 200; wrong state → 409
POST /v1/payments/{id}/refunds     Idempotency-Key, amount ≤ refundable → 201 | 422
GET  /v1/events?after={event_id}   the same events webhooks deliver, for catching up
GET  /v1/balance                   merchant balance from the ledger
```

- **`202 Accepted` means "we don't know yet."** The processor didn't answer; the body is the `pending` payment. The merchant waits for the webhook or polls, and may retry with the same key at no risk.
- **Status codes carry meaning a client can act on**: `409` with `Retry-After` for "same key, still in flight", `422` for "same key, different body" or "amount exceeds refundable", `409` for "wrong state" (capturing a voided payment).
- **Capture and void are idempotent by state**, not by key: capturing a captured payment returns it with `200`.
- **Errors are `application/problem+json`** with a stable `code`, and amounts are rejected at the boundary unless they are positive integers.

---

## 🔧 Deep Dive 1: Exactly-Once Payment Creation (8 min)

"The scenario that keeps payment engineers up at night: the merchant's server posts a payment, the connection drops after we charged the card but before they saw `201`, and their retry logic posts again. Every layer between their retry and the card network needs a reason not to charge twice."

**The decision.** I store the idempotency record *as the payment row* in PostgreSQL. `INSERT ... ON CONFLICT (merchant_id, idempotency_key) DO NOTHING` is the claim: of twenty concurrent requests with the same key, exactly one gets a row back and goes on to call the processor. The others read the existing payment and compare a SHA-256 fingerprint of the request body:

1. **Same body, payment finished** → replay it with `200` and `Idempotent-Replayed: true`. I return the payment's *current* state rather than a byte copy of the first response — after a reconciliation, a retry should see the final outcome.
2. **Same body, still `pending`** → `409` with `Retry-After: 2`. Something is in flight; come back shortly.
3. **Different body** → `422`. A client reusing keys across different orders has a bug, and silently replaying another order's result would hide it.

**Why it works.** The claim and the money live in the same database and the same commit history. There's no window where the key exists but the payment doesn't, no TTL after which a retry charges again, and no second system to fail independently.

**The second half is the processor call.** Our payment id is the processor's idempotency reference. If our own retry logic — or the reconciler — calls the processor again for the same payment, the processor returns the original decision instead of authorizing twice. That's the line between a retry and a *blind* retry: a retry is only safe if it carries the same reference.

| Approach | Where it breaks |
|----------|-----------------|
| ❌ Redis `SET NX` + cached response, 24 h TTL | Not durable with the payment: `appendonly everysec` loses the last second of claims in a crash; a retry after the TTL charges again; Redis and PostgreSQL can disagree |
| ❌ Deduplicate on the request body | Silently merges two genuinely identical orders — a customer buying the same item twice gets one charge and one confused support ticket |
| ❌ Unique key, but treat a conflict as an error | Correct but hostile: the merchant gets a `500` for a payment that succeeded and has to call support to find out |
| ✅ Claim on the payment row + fingerprint + processor reference | One payment per key forever; retries see the real outcome |

**What I give up.** A database round trip on every create — about a millisecond against a 500 ms processor call — and a unique index that grows with the payments table forever, which is the real reason I shard by merchant instead of partitioning by time. I also accept that a merchant who doesn't send a key gets no protection; I'd make the key mandatory for API versions going forward.

> "If someone asks 'what if the Payment API crashes after the processor approves but before we commit?' — the payment is still `pending` with no processor reference recorded. The merchant's retry gets `409`. Thirty seconds later the reconciler asks the processor about that payment id, learns it was approved, and commits the capture. The customer is charged once, and the merchant's next retry gets the captured payment."

---

## 🔧 Deep Dive 2: A Ledger the Database Won't Let You Unbalance (7 min)

"Every movement of money is a journal: a set of entries whose debits equal their credits. A capture of $100 with a $3.20 fee is three entries — debit receivables $100, credit the merchant $96.80, credit platform revenue $3.20. A refund is the mirror image for the refunded share; a chargeback adds a $15 dispute fee."

**The decision.** The balance rule is enforced by PostgreSQL, not just by application code:

1. A **deferred constraint trigger** runs at `COMMIT`, after all of a journal's entries exist, and aborts the transaction unless the journal has at least two entries, one currency, and debits equal to credits.
2. A second trigger makes `ledger_entries` **append-only**. A mistake is corrected with a reversing journal; history is never edited.
3. **Account balances** are updated inside the same transaction, `balance = balance + delta` under the row lock, and a nightly job checks that every stored balance equals the sum of its entries.

**Why it works.** The cheapest place to catch an accounting bug is the transaction that introduced it. An application-level check covers the code paths someone remembered to check; a new journal type, a hand-written backfill or a refactor that posts one leg of a pair goes straight through. With the trigger, the bad transaction never commits, and the alert fires within seconds instead of at month-end close.

**Partial refunds and rounding.** Fee shares round, and rounding errors accumulate: refund a $640 payment in two halves and naive rounding can return one cent more fee than was charged. I compute each refund's fee share cumulatively — the rounded share after this refund minus the rounded share before it — so any series of refunds that adds up to the full amount returns exactly the original fee.

| Approach | Where it breaks |
|----------|-----------------|
| ❌ One mutable `balance` per account | Fast, but no audit trail: after a bug you can't tell which payment moved what |
| ❌ Balance checked only in application code | Holds until the first code path that forgets; discovered at month-end |
| ❌ Event sourcing with balances as projections | Powerful, but projections are eventually consistent, and a refund must check the *current* refundable amount |
| ✅ Journals + deferred balance trigger + append-only entries | Unbalanced journals cannot commit; history is immutable |

**What I give up, and where it hurts.** Write amplification — three entries and three balance updates per capture instead of one update — and, more importantly, **hot rows**. Every capture touches the platform's receivables and revenue accounts. At 3,000 captures a second that's 3,000 locked updates per second on two rows, beyond what one row can serialize. The fix is to split each platform account into 64 shard rows (`shard = hash(payment_id) % 64`) and sum the shards in reports. A very large merchant's payable account gets the same treatment. I'd rather design that in from the start than discover it on Black Friday.

> "The isolation level question comes up here. I don't need `SERIALIZABLE`: the balance update is an atomic increment under a row lock, and journals touch accounts in a fixed order — sorted by account id — so two concurrent journals can't deadlock on each other's rows."

---

## 🔧 Deep Dive 3: When the Processor Doesn't Answer (6 min)

"About one processor call in two thousand times out. Most people's first instinct is to mark the payment failed. That's how double charges happen."

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

**The decision.** A processor call has four outcomes, not two. *Approved* and *declined* are answers. *Not attempted* — the circuit breaker was open and the request never left our process — is safe to report as failed. *Unknown* — a timeout or connection reset after we sent the request — means the card may well have been charged. Unknown payments stay `pending`, the merchant gets `202`, and the reconciler resolves them:

| The processor says | The reconciler does |
|--------------------|---------------------|
| Approved | Apply the approval; capture with its journal if the payment auto-captures |
| Declined | Fail the payment |
| Never heard of it | Resubmit under the **same** reference — the processor deduplicates, so at most one authorization can exist |
| Still no answer | Try again next pass; page someone if any payment is pending for more than 5 minutes |

**Why it works.** The reconciler and the live request apply outcomes through the same compare-and-set transition — `UPDATE ... WHERE status = 'pending'` — so if both resolve the same payment, exactly one wins and the journal is posted once. The reconciler claims work in a single statement that selects stuck rows with `FOR UPDATE SKIP LOCKED` and bumps their `updated_at` as a lease, so several reconciler instances never pick the same payment, and a live request still inside its first 30 seconds is left alone.

**Why the alternatives fail.** Marking the payment failed tells the merchant to retry — usually with a new key, because from their side it's a new attempt — and the customer ends up with two holds on their card. Retrying the processor call with a fresh reference is the same mistake made by our server instead of theirs. Holding the merchant's request open until we know turns a processor hiccup into thousands of hung connections.

**The circuit breaker fits here too.** When the processor degrades, a plain timeout means every in-flight payment holds a connection for the full timeout; the pool drains and unrelated endpoints — dashboard reads, refunds — start failing. A breaker that opens after five consecutive failures rejects new payments in microseconds and recovers through a half-open probe after 30 seconds. Its rejections are the clean "not attempted" case. Fail-fast makes merchant retries more likely, which is exactly why the breaker and the idempotency key have to be designed together.

**What I give up.** A clean synchronous answer. Merchants must handle `202` and wait for a webhook, and a few customers a day see "processing" for a minute or two. I'd also run a daily job matching the processor's settlement file against the ledger — it catches what the reconciler can't, such as a capture the processor reversed on its side.

---

## 📈 Scale, Failures & Observability (2 min)

**What breaks first, in order:** the hot platform account rows (sharded accounts), then the single primary's write volume (shard by merchant), then webhook fan-out to slow merchants (per-endpoint concurrency caps so one slow merchant can't consume the dispatcher pool).

| Failure | What merchants see | Mitigation |
|---------|--------------------|------------|
| Processor timeout | `202`, then a webhook | Reconciler resolves by reference |
| Processor down | Fast failures, no hung requests | Breaker; optional failover to a second processor for new payments |
| API crash mid-payment | Retry gets `409`, then the result | Reconciler finishes the payment |
| PostgreSQL primary lost | `503` with `Retry-After` for the failover window | Synchronous replica; nothing acknowledged is lost |
| Redis down | Nothing visible; fraud loses velocity signals | Payments continue; risk team alerted |
| Kafka down | Webhooks delayed, not lost | Outbox accumulates; relay resumes |
| Merchant endpoint down | Webhooks retried for 3 days | Dead-letter store plus `GET /v1/events` to catch up |

**What I'd watch:** age of the oldest `pending` payment (that's the unknown-outcome SLO), reconciler results, idempotency replays and body mismatches per merchant, balance-trigger violations (must be zero — any is a page), nightly account drift, outbox lag, webhook success rate per endpoint, processor latency and breaker state.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Idempotency store | Key on the payment row | Redis with a TTL | Durable with the money; never expires |
| Ledger invariant | Deferred trigger + append-only | Application checks | Bad journals can't commit |
| Processor timeouts | `pending` + reconcile by reference | Treat as decline or retry | Never a second authorization |
| Concurrent transitions | Compare-and-set `UPDATE` | Read-then-write | One winner per race, no long locks |
| Refund limits | Short row lock | Optimistic retries | The guard is an amount, not a status |
| Events | Transactional outbox → Kafka | Publish after commit | No lost or phantom events |
| Hot accounts | 64 shard rows per platform account | One revenue row | One row can't take 3,000 locked updates/s |

"With more time I'd add authorization-expiry tracking — holds lapse after about seven days, and a capture after that silently fails — then multi-processor routing with per-processor reconciliation, and payouts, which bring their own ledger journals and a second, bank-side reconciliation."
