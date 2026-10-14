# 💳 Payment System — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one payment from the customer's Pay button to the ledger and back to the merchant's screen, and get the contracts between the layers right — so any layer can time out, crash or retry without anyone being charged twice or shown something untrue. Three contracts carry the weight: an idempotency key that travels from the browser all the way to the card processor, status codes that tell 'no' apart from 'not yet' and from 'we don't know', and event ids that make live updates and webhooks safe to repeat."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and targets on both sides of the wire |
| End-to-end architecture | 9 min | One diagram from the checkout page to the ledger, plus the core flows |
| Data model & API contract | 7 min | Server tables, client cache keys, and the fields both sides rely on |
| Deep dive 1: one payment per click | 8 min | Idempotency from the button to the processor |
| Deep dive 2: "we don't know yet" | 7 min | A processor timeout, from the server's `pending` to the customer's screen |
| Deep dive 3: refunds that can't over-refund | 6 min | Row locks, ledger journals and a form that tells the truth |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a customer and to a merchant |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Customers pay in a checkout embedded in the merchant's page (card fields, 3-D Secure, clear outcomes). Merchants capture, void and refund payments from a dashboard and from their own servers, see each payment's timeline and ledger entries, and receive webhooks for every state change. Every movement of money is a balanced double-entry journal. Out of scope: payouts, currency conversion, subscriptions, onboarding.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Payment API availability | 99.99% |
| Backend | Authorization latency | p99 < 1.5 s end to end; our overhead p99 < 100 ms |
| Backend | Ledger | Every journal balances, enforced at commit |
| Backend | Unknown outcomes | Resolved within 5 minutes; webhooks at least once, retried for 3 days |
| Frontend | Checkout | < 40 KB gzipped, async; INP < 100 ms on Pay |
| Frontend | Dashboard | LCP < 2.5 s; INP < 200 ms with 100,000+ payments |
| Both | Correctness | One click on Pay or Refund causes at most one charge or refund — across double clicks, timeouts, retries and refreshes |

**Scale.** 50M payments a day — about 580 a second, 3,000 at holiday peak — with roughly 0.05% of processor calls timing out, which is about 25,000 payments a day whose outcome we don't immediately know. Around 150M webhook events a day. Every capture writes three ledger entries and touches the platform's revenue account.

"The throughput is ordinary for a stateless tier and one well-indexed database. What shapes the design is that 0.05%: twenty-five thousand times a day, the browser, the API and the processor disagree about whether money moved, and every layer has to handle it the same way."

---

## 🏗️ End-to-End Architecture (9 min)

```
  ┌───────────────────────────┐                           ┌───────────────────────────┐
  │ Merchant checkout page    │                           │ Merchant dashboard (SPA)  │
  │ Checkout.js + card iframe │                           │ query cache, draft keys   │
  └─────────────┬─────────────┘                           └─────────────┬─────────────┘
                │ (1) POST confirm                                      │ (3) POST refunds, key R
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
                                           │ 1 tx: payment, journal, outbox       │ look up ref
                                           ▼                         ┌────────────┴──────────┐
                        ┌──────────────────────────────────┐         │ Reconciler            │
                        │ PostgreSQL primary               │  apply  │ stuck 'pending' rows, │
                        │ payments, ledger_entries, outbox │◀────────┤ settlement files      │
                        └────────────────┬─────────────────┘ outcome └───────────────────────┘
                                         │ (2) outbox relay: events
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

1. **Pay (1).** The customer's card goes from our iframe to our tokenization endpoint; Checkout.js then confirms the payment with an idempotency key tied to the checkout session. The Payment API claims the key by inserting the payment as `pending`, authorizes with the processor using the payment id as the processor's idempotency reference, and commits the status, the ledger journal and an outbox row in one transaction.
2. **Notify (2).** A relay publishes the committed outbox rows to Kafka. The webhook dispatcher signs and delivers them to the merchant's server, and the same events feed the dashboard's live stream.
3. **Refund (3).** The merchant refunds from the dashboard with a key stored alongside the draft; the API locks the payment row, checks the refundable amount, and commits the refund, its journal and its event together.

When the processor doesn't answer, the payment stays `pending` and the reconciler later asks the processor about that reference — that's deep dive 2.

| Layer | Choice | Why |
|-------|--------|-----|
| Checkout | Small framework-free bundle + card iframe on our domain | Card numbers never touch the merchant's page; minimal PCI scope |
| Dashboard | React SPA; TanStack Query for server state; filters in the URL | Authenticated, no SEO; the query cache handles dedupe, retries and invalidation |
| Live updates | Server-Sent Events with `Last-Event-ID` | One-way stream with built-in reconnect and replay |
| Payment API | Stateless service | Claim, fraud rules, processor calls, state machine, ledger posting |
| PostgreSQL | Payments, refunds, journals, entries, outbox | One transaction covers the claim, the money and the event |
| Reconciler | Worker claiming stuck payments with `SKIP LOCKED` | Resolves unknown outcomes through the same guarded transitions |
| Kafka + dispatcher | Event log and signed webhooks | Replayable; per-merchant ordering |

### Flow: creating a payment, and losing the response

```
 Browser                          Payment API                                PostgreSQL    PSP
    │                                  │                                          │         │
    │ 1 freeze draft, key K to sessionStorage                                     │         │
    │ 2 POST /v1/payments, key K       │                                          │         │
    │─────────────────────────────────▶│                                          │         │
    │                                  │ 3 INSERT pending ON CONFLICT DO NOTHING  │         │
    │                                  │─────────────────────────────────────────▶│         │
    │                                  │ 4 authorize(ref = payment id)                      │
    │                                  │───────────────────────────────────────────────────▶│
    │                                  │ 5 approved                                         │
    │                                  │◀───────────────────────────────────────────────────│
    │                                  │ 6 1 tx: status, journal, outbox          │         │
    │                                  │─────────────────────────────────────────▶│         │
    │ 7 201 lost (network drops)       │                                          │         │
    │◀─────────────────────────────────│                                          │         │
    │ 8 retry POST, same key K         │                                          │         │
    │─────────────────────────────────▶│                                          │         │
    │ 9 200 replay {status: captured}  │                                          │         │
    │◀─────────────────────────────────│                                          │         │
    │                                  │                                          │         │
```

"Steps 1 and 3 are two halves of one contract. The browser promises to send the same key for the same draft — even after a refresh, because the key is in `sessionStorage` — and the server promises that a repeated key returns the payment it already created instead of creating another. Step 7 is the case the contract exists for: the customer was charged, the response was lost, and the retry in step 8 gets the captured payment back, marked `Idempotent-Replayed`."

### Flow: when the processor goes quiet

```
 Browser                     Payment API                   PostgreSQL    PSP             Reconciler
    │                             │                             │         │                   │
    │ 1 POST /v1/payments, key K  │                             │         │                   │
    │────────────────────────────▶│                             │         │                   │
    │                             │ 2 authorize(ref = id)                 │                   │
    │                             │──────────────────────────────────────▶│                   │
    │                             │ 3 timeout                             │                   │
    │                             │◀──────────────────────────────────────│                   │
    │ 4 202 {status: pending}     │                             │         │                   │
    │◀────────────────────────────│                             │         │                   │
    ······································· 30 s later ········································
    │                             │                             │         │ 5 look up ref     │
    │                             │                             │         │◀──────────────────│
    │                             │                             │         │ 6 approved        │
    │                             │                             │         │──────────────────▶│
    │                             │                             │ 7 guarded UPDATE + journal  │
    │                             │                             │◀────────────────────────────│
    │                             │ 8 outbox: payment.captured  │         │                   │
    │                             │◀────────────────────────────│         │                   │
    │ 9 SSE event: show receipt   │                             │         │                   │
    │◀────────────────────────────│                             │         │                   │
    │                             │                             │         │                   │
```

"Every layer treats the timeout the same way: as 'we don't know yet', never as 'failed'. The API answers `202`, the browser shows 'Processing' with no Pay button, the reconciler asks the processor about our reference, and the answer reaches the browser as an event and the merchant as a webhook."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Table | Key columns | Notes |
|-------|-------------|-------|
| `payments` | `id` (also the processor reference), `merchant_id`, `idempotency_key`, `request_hash`, `amount`, `currency`, `status`, `capture_method`, `version` | Unique `(merchant_id, idempotency_key)` is the idempotency claim; partial index on `pending` rows for the reconciler |
| `refunds` | `id`, `payment_id`, `merchant_id`, `idempotency_key`, `request_hash`, `amount`, `status` | Unique `(merchant_id, idempotency_key)` |
| `journals`, `ledger_entries` | `journal_id`, `account_id`, `direction`, `amount`, `currency` | Append-only; a deferred trigger rejects any journal whose debits and credits differ |
| `accounts` | `owner_id`, `kind`, `shard`, `balance` | Balance is the signed sum of entries; platform accounts sharded |
| `outbox` | `event_id`, `merchant_id`, `type`, `payload`, `published_at` | Written in the same transaction as the change |

### Client side

| Cache key | Holds | Updated by |
|-----------|-------|------------|
| `['payments', {status, from, to, q}]` | Pages of payments with `nextCursor` | Invalidated after mutations; patched by events |
| `['payment', id]` | One payment with timeline, `refundableAmount`, `version` | Events via `setQueryData`; refetch after mutations |
| `['balance']` | Available and pending balance with `asOf` | Invalidated by refunds and capture events |
| `sessionStorage['refund-draft:{id}']` | Frozen refund draft and its idempotency key | Cleared on success |
| Checkout session (server-side) | The confirm key and the payment it created | A refresh resumes the same session |

### The contract

```
POST /v1/checkout/{session}/confirm  Idempotency-Key → 201 succeeded | requires_action | 202 processing
POST /v1/payments                    Idempotency-Key → 201 | 202 | 200 replay | 409 in flight | 422 key reused
GET  /v1/payments?status&cursor      → {items, next_cursor}
GET  /v1/payments/{id}               → payment, timeline, refundable_amount, version
POST /v1/payments/{id}/refunds       Idempotency-Key, {amount, reason} → 201 | 200 replay | 422
GET  /v1/events                      SSE stream; Last-Event-ID resume
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `Idempotency-Key` | Same key + same body → the same payment or refund, forever; different body → `422` | Retry after timeouts, refreshes and offline periods without duplicates |
| `202` / `status: pending` | The outcome is unknown and will be resolved; retrying with the same key is safe | Show "Processing" and wait, instead of re-enabling Pay |
| `409` + `Retry-After` | The same key is still being processed | Wait and retry with the same key |
| `refundable_amount` | The amount the server will accept right now, pending refunds included | Validate the form and show the limit |
| `application/problem+json` `code` | Stable codes: `amount_exceeds_refundable`, `idempotency_key_reused`, `invalid_state` | Map errors to the right field or message |
| `event_id` | Stable per event; webhooks and the stream may repeat it | Deduplicate; resume with `Last-Event-ID` |
| Amounts | Integers in minor units plus currency | Never do float arithmetic on money; format with `Intl.NumberFormat` |

---

## 🔧 Deep Dive 1: One Payment per Click (8 min)

"The scenario: a customer on a train presses Pay, the request hangs, they press it again — or the page retries on its own, or they refresh. Without care, each of those is a new charge. Each layer has a specific job."

**Browser.** The Pay button locks on the same frame as the click, but that only stops double clicks. The real guarantee is the key: the checkout session carries one idempotency key, so every confirm for that session — a retry after a network error, a second click, a refresh that reloads the session — sends the same key. In the dashboard, a refund draft freezes its key in `sessionStorage` at submit; editing the amount makes a new key, because it is a different request.

**API.** The key is claimed by inserting the payment itself: `INSERT ... ON CONFLICT (merchant_id, idempotency_key) DO NOTHING`. Exactly one concurrent request gets a row back and calls the processor. The others compare a SHA-256 fingerprint of the body: different body → `422`; still `pending` → `409` with `Retry-After`; finished → the payment's current state with `Idempotent-Replayed: true`.

**Processor.** Our payment id is the processor's own idempotency reference. If anything on our side calls the processor twice for one payment — a retry, the reconciler, a deploy that restarts mid-call — the processor returns its original decision instead of authorizing again.

| Approach | Verdict |
|----------|---------|
| ✅ Key from the client, claimed on the payment row, payment id as the processor reference | One payment per key across every layer, with no expiry |
| ❌ Disable the button only | Stops double clicks; not timeouts, retries or refreshes |
| ❌ Key stored in Redis with a 24 h TTL | A crash can lose the last second of claims; a retry after the TTL charges again |
| ❌ Server deduplicates identical bodies | Silently merges two genuinely identical purchases |
| ❌ Optimistic "Paid!" in the UI | The processor can still decline, ask for 3-D Secure, or not answer |

"What I give up: a database round trip on every create, and a unique index that grows with the payments table forever — which is why the server shards by merchant instead of partitioning payments by time. On the client, the cost is discipline: every money-moving form has to own its key's lifecycle, so I wrap that in `useRefund` and the checkout's button state machine instead of trusting each component to get it right."

---

## 🔧 Deep Dive 2: "We Don't Know Yet", End to End (7 min)

"About one processor call in two thousand times out after we've sent it. The card may have been charged. This is where a system's layers most often disagree, so I want one rule everywhere: a timeout is *unknown*, not *failed*."

**Server.** The payment stays `pending` and the API answers `202` with the pending payment. A reconciler claims stuck payments — `FOR UPDATE SKIP LOCKED`, with an `updated_at` lease so several reconcilers never pick the same one — and asks the processor about our reference. Approved: authorize and capture through the same compare-and-set transition the API uses, posting the journal once. Declined: fail it. Never heard of it: resubmit under the *same* reference, which the processor deduplicates. Still nothing: try again next pass, and page someone after 5 minutes.

**Wire.** The outbox emits `payment.captured` (or `payment.failed`) in the same transaction as the reconciler's change. The dispatcher sends the webhook to the merchant's server; the SSE stream carries the same event to the customer's checkout and the merchant's dashboard.

**Client.** The checkout shows "Your payment is processing — don't pay again", keeps the Pay button hidden, and listens for the result (with a 5-second poll as a fallback). If the customer refreshes, the checkout session reloads in its processing state. In the dashboard, the payment shows "Processing" with no refund or capture actions until the event arrives. A retry with the same key gets `409` while the payment is pending and the final payment afterwards.

| Approach | Verdict |
|----------|---------|
| ✅ `202` + `pending`, reconcile by reference, event to every client | One answer everywhere, never a second authorization |
| ❌ Treat the timeout as a decline | The customer retries — usually with a new key — and ends up with two holds |
| ❌ Retry the processor call with a new reference | The same double charge, made by our server |
| ❌ Hold the HTTP request open until we know | Thousands of hung connections during a processor incident; the browser times out anyway |

"What I give up is a clean synchronous answer. A few customers a day see 'processing' for a minute or two, and merchant integrations must handle `202` and wait for the webhook — which I'd make explicit in the API docs and the test cards, so merchants build that path before it happens in production."

---

## 🔧 Deep Dive 3: Refunds That Can't Over-Refund (6 min)

"A payment of $100 has $70 left to refund. Two support agents each refund $70 at the same moment — or one agent's browser retries a timed-out request. Only one of those should succeed, and the other agent should see why."

**Server.** The refund runs in one transaction that starts by locking the payment row (`SELECT ... FOR UPDATE`). Under the lock it checks whether this idempotency key already created a refund (replay it), sums existing refunds — pending ones count against the limit — and rejects anything above the refundable amount with `422 amount_exceeds_refundable`, including the current refundable amount in the problem body. Otherwise it inserts the refund, posts a refund journal, moves the payment to `partially_refunded` or `refunded`, and writes the event. The commit-time ledger trigger guarantees the journal balances. Fee shares are computed cumulatively, so a series of partial refunds that adds up to the full amount returns exactly the original fee.

**Client.** The dialog shows `refundableAmount` from the server and validates against it for instant feedback, but treats the server as the authority. On `422` it shows "Only $30.00 can still be refunded" on the amount field and refetches the payment. There is no optimistic update: the badge changes to "Refunded" only when the server says so.

| Approach | Verdict |
|----------|---------|
| ✅ Row lock on the payment + key checked under the lock; pessimistic UI | The total can never exceed the payment; the losing agent sees the real limit |
| ❌ Check-then-insert without a lock | Both refunds read "$70 refundable" and both succeed: $140 refunded on a $100 payment |
| ❌ Optimistic compare-and-set on a `version` column | Works, but every concurrent refund forces a retry loop; the lock is held for milliseconds anyway |
| ❌ Optimistic "Refunded" badge in the UI | Tells the merchant money was returned when the server may refuse |

"What I give up: refunds of one payment are serialized behind a row lock. That's fine — refunds of the same payment are rare and the lock is held for a few milliseconds, never across a network call. The processor's refund call happens after commit, through the same pending-and-reconcile machinery as authorizations."

---

## 📈 Failures & Scale (2 min)

| Failure | What the customer sees | What the merchant sees | Mitigation |
|---------|------------------------|------------------------|------------|
| Processor timeout | "Processing — don't pay again", then the result | Payment "Processing", then a webhook | `202`, reconciler, events |
| Processor down | A fast "Payment couldn't be processed, try again" | Failed payments marked "processor unavailable" | Circuit breaker; nothing was sent, so failing is safe |
| API crash mid-payment | Processing state after refresh | Retry gets `409`, then the result | Reconciler finishes the payment |
| PostgreSQL failover | Brief "try again" | `503` with `Retry-After` | Synchronous replica; nothing acknowledged is lost |
| Event stream disconnects | Nothing (polling fallback) | "Reconnecting…" banner | `Last-Event-ID` replay or a full refetch |
| Merchant's webhook endpoint down | Nothing | Delivery failures in the dashboard | Retries for 3 days, then `GET /v1/events` to catch up |

**What breaks first as we grow:** the platform revenue and receivables rows, which every capture updates — at 3,000 captures a second I split each into 64 shard rows and sum them in reports; then the single primary's write volume, answered by sharding by merchant; then webhook fan-out to slow merchants, answered by per-endpoint concurrency caps.

---

## ⚖️ Trade-offs & Wrap-up (2 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Duplicate protection | Client key → row claim → processor reference | Disabled button or Redis TTL | One charge per click across every layer |
| Processor timeouts | `202` + `pending` + reconcile by reference | Treat as failure | Never a second authorization |
| Refund concurrency | Row lock + key under the lock | Check-then-insert | The refunded total can never exceed the payment |
| Money in the UI | Pessimistic with honest pending states | Optimistic updates | The server can refuse or not know yet |
| Ledger | Journals with a commit-time balance check | Mutable balances | Bugs can't commit an unbalanced journal |
| Live updates | SSE + webhooks from one outbox | Polling everything | One event source, safe to repeat |
| Card entry | Iframe + tokenization | Inputs in the merchant's page | Card data never in the merchant's DOM |

"With more time: authorization-expiry tracking, because holds lapse after about seven days and a late capture silently fails; a test mode with processor test cards for 'timeout' and 'lost request', so merchants exercise the `202` path before production does it for them; and payouts, with their own journals and a bank-side reconciliation."
