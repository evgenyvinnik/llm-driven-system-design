# Freight Quote Service — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → API → Quote path → Event-driven side → Deep dives → Traces → Scale*

> "The prompt: shippers ask for a price to move carload freight, and the price depends on four slow internal services: tariff and contract pricing, the weekly fuel surcharge, network capacity on the lane, and car availability at the origin. Traffic is heavy, much of it from integrations that re-quote all day. I'll design it as a request/response core with an event-driven side. Three ideas carry the answer. First, the endpoint has a deadline it always meets: it calls everything in parallel under one budget and, when capacity or car supply is too slow, answers with an *indicative* quote that says exactly what isn't confirmed. Second, *firm* has a precise meaning: every input live or at its current published version, pinned on the quote so booking can honor it. Third, everything slow or retryable moves off the request path into idempotent consumers of an outbox: firm completion, callbacks, cache invalidation and analytics."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | A latency promise that holds while dependencies don't; firm vs indicative |
| Architecture | ~5 min | Gateway → stateless quote API → four dependencies; outbox → partitioned log → consumers |
| Data model and API | ~4 min | Quote row with pinned inputs; idempotency per customer; 201 vs 202 |
| Quote path and event side | ~10 min | Budgets, hedging, breakers, single-flight, shedding; completer, invalidator, projector |
| Deep dives | ~14 min | Latency budgets vs retries; staleness and cache keys; at-least-once plus idempotency |
| Traces, checklist, follow-ups | ~5 min | One success, one failure, six review questions |
| Scale and wrap-up | ~2 min | What breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Is a quote a commitment? | Decides what may be cached and what must be live | A *firm* quote is honored at booking until it expires. An estimate must be labeled as one |
| Who calls it? | Changes the overload policy | People in a portal, and integrations (3PLs, brokers) that re-quote lanes every few minutes |
| Do customers have contract rates? | Cache correctness | Yes, per customer and lane. A contract price must never reach another customer |
| How often do inputs change? | What can be cached | Tariffs: versioned publications, days or weeks apart. Fuel surcharge: weekly. Capacity and car supply: continuously |
| What latency do clients expect? | The deadline | About a second for the portal; integrations set their own timeouts and retry |
| Can the answer arrive later? | Async options | Yes: `202` with polling, or a callback to a URL the customer registered |

### Functional requirements

1. Quote a lane, commodity, equipment type, quantity and ship week, idempotently.
2. Return firm when every input is confirmed, otherwise indicative with per-component provenance and staleness, then complete the firm quote asynchronously (poll or signed callback).
3. Pin the exact inputs (tariff or contract version, fuel week, capacity and car-supply snapshots, rules version) on a firm quote; book against it.
4. Invalidate caches and re-price open indicative quotes when a tariff or surcharge is published.
5. Expire quotes; give operators latency, breaker, cache and shedding views; analytics on volume, conversion and dependency latency.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Quote latency | p99 < 1 s, regardless of dependencies | A hard deadline; an indicative fallback |
| Firm completion | p95 < 10 s after an indicative answer | An async worker with a longer budget |
| Availability | 99.95% | Only "no price at all" may fail a request |
| Correctness | No cross-customer contract prices; no firm quote from unconfirmed inputs | Keys by pricing basis; a strict definition of firm |
| Auditability | Any firm quote reconstructible years later | Pinned versions, versioned tariff history, append-only log |
| Overload | Portal p99 holds during an integration retry storm | Shed by class; per-customer limits |

### Capacity estimate (illustrative)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Quote requests | ~300/s average, ~3,000/s peak | ~10,000 shippers; integrations re-quote every few minutes |
| Dependency calls without caching | 4 per quote, 12,000/s at peak | The capacity model is the expensive one |
| Distinct pricing inputs per hour | ~200,000 | Lane × commodity × equipment × basis actually quoted |
| Cache working set | ~1-2 GB | ~1M entries × ~1 KB |
| Events | ~1,000/s, peak ~10,000/s | 2-4 per quote |

> "The quote API itself is easy to scale: it's stateless. The number that matters is the capacity service, which I'll assume sustains a few hundred calls a second. The whole design is about not turning 3,000 quotes a second into 3,000 capacity calls a second, and about what we tell the customer when it's slow anyway."

---

## 🏗️ High-Level Architecture (~5 min)

```
 Portal ─────┐      ┌───────────────────┐       ┌───────────────────────────────┐
 API clients ┴─────▶│ API gateway       │──────▶│ Quote API (stateless, N)      │◀──▶ Component cache
                    │ auth, rate limits │       │ classify ▸ admit ▸ idempotent │     (Redis cluster)
                    └───────────────────┘       │ fan-out under one deadline    │
                                                └──┬─────┬──────┬──────┬────────┘
                                single-flight · breaker per dependency · hedge
                                                   ▼     ▼      ▼      ▼
                                            Pricing  Fuel  Capacity  Car supply
                                              │ TariffPublished / FuelSurchargeChanged
                                              ▼
 ┌────────────────────────────┐ outbox ┌──────────────────────────────────────────┐
 │ PostgreSQL                 │──CDC──▶│ Kafka: quote.events (key quote id),      │
 │ quotes · bookings ·        │        │ pricing.tariffs, pricing.fuel (compacted)│
 │ tariff history · events    │        └────┬───────────┬───────────┬─────────┬───┘
 └────────────────────────────┘             ▼           ▼           ▼         ▼
                                       Firm         Webhook     Invalidate  Analytics
                                       completer    delivery    + re-price  projection
```

> "Left to right: the gateway authenticates and applies per-customer limits. The quote API is stateless and does the interesting work. The four dependencies are other teams' services; I treat them as slow and unreliable. PostgreSQL holds quotes as the source of truth, and an append-only events table written in the same transaction as each state change. That's the transactional outbox. A relay or CDC publishes it to Kafka, and four consumer groups do the async work. Each consumer is idempotent, because delivery is at least once."

---

## 💾 Data Model (~3 min)

| Table | Key columns | Indexes / constraints | Notes |
|-------|-------------|-----------------------|-------|
| quotes | id, customer_id, idempotency_key, request_hash, client_class, lane, commodity, equipment, quantity, ship_week, kind, firm_status, status, revision, total, band low/high, inputs (json), components (json), valid_until, version | UNIQUE (customer_id, idempotency_key); open-by-expiry; open-indicative-by-lane | The source of truth. `inputs` pins the versions used |
| bookings | id, quote_id (unique), customer_id, idempotency_key, honored_total, honored_inputs, current_tariff_version | UNIQUE (customer_id, idempotency_key) | Records what was honored and what was current |
| tariff_versions | tariff_id, version, rate, effective_at, event_id | PK (tariff_id, version) | Every version ever published, for disputes |
| tariff_current | tariff_id, version, rate | PK tariff_id | Only moves forward |
| events | position, event_id, type, version, stream_id, stream_version, occurred_at, recorded_at, correlation_id, causation_id, payload, published_at | UNIQUE event_id; UNIQUE (stream_id, stream_version); partial index on unpublished | Append-only outbox and integration log |
| processed_events | consumer, event_id | PK (consumer, event_id) | Idempotent consumers |
| webhook_deliveries | event_id, quote_id, url, status, attempts, next_attempt_at | UNIQUE event_id | One callback per event |
| analytics_* | bucket (event hour), metric, dimension, value; latency histograms; source mix | PK per dimension | Rebuilt from the log |

> "The column I'd point at is `inputs`. A firm quote stores tariff or contract version, fuel surcharge week, the capacity and car-supply snapshot ids and the pricing-rules version. With the tariff history table, that's enough to reconstruct any quote in a dispute and to honor it at booking, whatever has been published since."

---

## 🔌 API Design (~2 min)

```
POST /api/v1/quotes            Idempotency-Key, X-Api-Key or session, optional X-Request-Deadline-Ms
                               → 201 firm · 202 indicative (Location, Retry-After) · 200 replay
                               → 422 key reused · 429 rate limited · 503 SHED · 503 PRICING_UNAVAILABLE
GET  /api/v1/quotes/:id        Poll target (404 for another customer's quote)
POST /api/v1/quotes/:id/book   Idempotency-Key → 409 NOT_FIRM · QUOTE_EXPIRED · ALREADY_BOOKED
Callback (optional)            POST to the customer's registered URL, HMAC-signed, at least once
```

| Status | Meaning | Client should |
|--------|---------|---------------|
| 201 | Firm quote | Book it before `valid_until` |
| 202 | Indicative now, firm later | Poll `Location`, or wait for the callback |
| 429 / 503 | Refused before any work | Honor `Retry-After`; retry with the same key |

---

## ⏱️ The Quote Path (~6 min)

**1. Classify and admit.** A session is `portal`. An API key is `api`, or `api_requote` if the same customer asked for the same inputs within 60 seconds. A per-customer token bucket returns `429`. Then admission control compares the instance's in-flight count with the class's share (portal 100%, api 75%, re-quote 40% of the limit) and returns `503 SHED` with a longer `Retry-After` for machines. Both happen before any database query.

**2. Idempotency.** The key is scoped to the customer. If a quote exists for it with the same request hash, I return it in its *current* state, so a client that lost a `202` and retries later may get the firm quote. A different body under the same key is a `422`. Concurrent duplicates on one instance share one execution; across instances the unique constraint picks a winner.

**3. Fan-out under one deadline.** The deadline is the server's 900 ms or the client's shorter `X-Request-Deadline-Ms`. Each dependency gets `min(its budget, time left)`: pricing 400 ms, fuel 250, capacity and car supply 600. The absolute deadline goes downstream in a header, so a dependency can drop work nobody is waiting for. For each dependency:

- Versioned components (linehaul, fuel) check the cache first and skip the call on a current-version hit.
- Identical in-flight calls are coalesced (single-flight), *outside* the breaker, so fifty identical requests are one call and one breaker outcome. A follower still races its own deadline.
- A breaker per dependency fails fast when the dependency is clearly down.
- Capacity, the slow-tail service, is hedged: a second call after its recent p90, capped at 15% of calls.
- Live answers go back into the cache; a failed perishable call falls back to the last-known snapshot.

**4. Compose.** This is a pure function, and it's where correctness lives:

| Component | Firm needs | Indicative may use |
|-----------|------------|--------------------|
| Linehaul | Live, or cached at the current version | Nothing else. A superseded tariff is never served; no linehaul means `503` |
| Fuel surcharge | Live, or this week's cached value | Last week's value, labeled "may be superseded (±10%)" |
| Capacity premium | Live | A snapshot ≤ 30 min old, labeled with its age; else 0 and "not confirmed, up to 15%" |
| Equipment premium | Live | A snapshot ≤ 30 min old; else 0 and "not confirmed" |

An indicative quote carries an estimate and a band (low assumes no premium where unconfirmed, high assumes the maximum), is valid for 15 minutes, and can't be booked. A firm quote is valid for 24 hours.

> "Here's what Pat actually sees when capacity is slow: '≈ $177,666, firm price expected $163,428 to $183,768, estimate valid 15 minutes, confirming capacity and car supply'. Below it, four rows: linehaul from contract CTR-PGC-2026 v3, cached 23 seconds ago; fuel surcharge for the week of November 2, cached; capacity premium from a snapshot 3 minutes old, with the sentence 'capacity service did not answer within its budget'; equipment live, 103 ms. Two seconds later the same card turns firm. Nothing on it is a guess the customer can't see."

**5. Persist and respond.** One transaction inserts the quote row and appends `QuoteRequested` (with `needs_firm`) and `QuoteIssued` (with per-component provenance) to the events table. `201` for firm; `202` with `Location` and `Retry-After` for indicative.

---

## 📨 The Event-Driven Side (~5 min)

| Event | Producer | Consumers |
|-------|----------|-----------|
| QuoteRequested | Quote API | Completer (if `needs_firm`), analytics |
| QuoteIssued v2 (initial, firm_completed, repriced) | API, completer, invalidator | Analytics (provenance, latency) |
| FirmQuoteCompleted | Completer | Webhook delivery, analytics |
| QuoteExpired / QuoteBooked | Sweeper / API | Analytics (conversion) |
| TariffPublished / FuelSurchargeChanged | Pricing system | Invalidator (cache floors, re-pricing) |
| DependencyCircuitOpened / Closed | Breakers | Ops timeline, analytics |

> "The log is an outbox, not an event store: the quote row is the source of truth. A relay publishes committed events to Kafka keyed by stream id, so a quote's events stay in order on one partition. I chose choreography: four independent consumers, each idempotent, none needing the others. There's no multi-step transaction to compensate. Booking with car orders and capacity slots would be a saga with an orchestrator, and I'd say so if we went there."

**Completer.** Consumes `QuoteRequested`. If the quote is already firm, expired or booked, it acknowledges and stops. Otherwise it calls the dependencies with a 5-second budget and no hedging. Still unconfirmed is a transient failure: the message stays unacknowledged and is redelivered after 1, 2, 4 and 8 seconds, then goes to a dead-letter topic, and the quote shows "firm delayed". Confirmed: one transaction locks the row, re-checks it, records `(completer, event_id)`, makes the quote firm with its pinned inputs, and appends `FirmQuoteCompleted` and `QuoteIssued`. Acknowledge after commit.

**Webhooks.** `FirmQuoteCompleted` becomes one delivery row per event. A dispatcher signs (HMAC over timestamp and body) and POSTs to the customer's registered URL, retrying with exponential backoff and jitter. The receiver deduplicates by event id.

**Invalidator.** On `TariffPublished`, it raises the cache version floor for that tariff key (idempotent, done first), records the event and the version history, moves `tariff_current` only forward, and re-prices open indicative quotes on public-tariff pricing for that key. Firm quotes are never re-priced.

**Analytics.** Commutative increments bucketed by event time, guarded by `processed_events`; rebuilt from position 0 on demand.

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Latency budgets and hedging vs retry amplification

**Decision.** One propagated deadline with a budget per dependency, budgeted hedging for the slow-tail dependency, a breaker per dependency, and *no retries inside the request*. Retries live in the async completer.

**Why this works here.** The promise is p99 under a second. Total latency of a parallel fan-out is the *maximum* of four calls, so the tail of the slowest dependency is the tail of the endpoint. If capacity is 80 ms at the median with 5% of calls taking 1.5 s, the endpoint's p99 is 1.5 s however fast the other three are. A hedge attacks exactly that: after the 90th percentile of recent capacity latency, I send a second identical request and take the first answer. When slowness is per request (a slow replica, a GC pause, a cold cache on one node), the chance that both are slow is the square of the chance that one is. In my load test that took p99 from 1,606 ms to 200 ms for 7% more capacity calls.

**Why in-request retries fail.** A retry after a timeout waits for the timeout first, so it can't fit inside the budget it's meant to rescue. Worse, it multiplies load at the moment the dependency is slowest: if the API retries three times and the capacity service retries three times against its own database, one quote is nine database calls during an incident. Retries convert a latency problem into a load problem, and the load problem then makes the latency worse. That's how a slowdown becomes an outage.

**Why hedging needs a budget.** Hedging is also extra load. When the *whole* service is slow, a hedge is just as slow and doubles the traffic. So a token bucket caps hedges at 15% of calls (each call earns 0.15 tokens, a hedge spends one), and I never hedge while the breaker is half-open. The breaker handles the "everything is slow" case: past 50% failures in a 10-second window it opens, and quotes become indicative instantly instead of waiting 600 ms each.

**Deadline propagation.** Without it, a dependency keeps working for callers that already gave up. With a worker pool of a few dozen, that abandoned work queues in front of live requests. Sending the absolute deadline lets it stop at the deadline. One thing building it showed me: a hedge's *loser* is cancelled by closing its connection, and a dependency that doesn't notice the closed connection still finishes the work. The mock counts those as "wasted", and with hedging on they're non-zero. Production needs cancellation propagation (gRPC does this; plain HTTP/1.1 doesn't reliably).

| Approach | Tail at p99 | Extra load | Fails when |
|----------|-------------|------------|------------|
| ✅ Budgeted hedge after p90 | ~p90 + one median (200 ms measured) | ≤ 15% of calls | The whole service is slow (then the breaker takes over) |
| ❌ Retry after timeout | Timeout + a second call: doesn't fit the budget | Up to 100%, multiplied per layer | Exactly during the incident it's meant for |
| ❌ Just wait longer | The dependency's own tail (1.6 s measured) | None | Every time the tail is longer than the user's patience |
| ❌ Fail fast, no fallback | Low, but nothing useful returned | None | Always: the customer gets an error instead of an estimate |

**What I give up.** Some extra load (bounded at 15%), a more complex client, and per-instance breakers that can disagree for a few seconds. And a firm price sometimes arrives seconds later rather than slowly in the same request. I take that trade because a bounded wait with an honest label is better than an unbounded wait.

### Deep dive 2: What may be stale, how it's labeled, and cache keys that can't leak

**Decision.** Separate *versioned* inputs from *perishable* ones. Versioned ones (tariff, contract, fuel surcharge) are cached under keys that include their pricing basis, invalidated by events through monotonic version floors, and count as confirmed at the current version. Perishable ones (capacity, car supply) are cached only as last-known snapshots, used only in indicative quotes, labeled with their age and bounded by a staleness policy owned by pricing.

**Why versioned caching is correct, not merely fresh.** A tariff is a publication: v7 is valid until v8 exists. A cached v7 *while v7 is current* is exactly as correct as asking the pricing service, so a firm quote may use it. A TTL asks the wrong question ("how long might this be wrong?"). Five minutes of TTL means five minutes of selling at a superseded price after every publication; a five-second TTL means hammering pricing for an answer that changes weekly. Instead, `TariffPublished` raises a floor for that tariff key. Reads ignore cached values below the floor, and writes refuse them. That second check closes a real race: a pricing call that started before the publication returns v7 after the invalidator deleted the entry, and without the floor it would write v7 back for hours.

**Why perishable inputs are different.** Lane utilization changes all the time; a snapshot from 20 minutes ago is an estimate, not a fact. So it can never make a quote firm. It can make an indicative quote *better* (a premium from a 3-minute-old snapshot is closer than "unknown, up to 15%"), and the quote says how old it is.

**Who decides how stale.** Not engineering. The 30-minute snapshot limit, the ±10% fuel band and the 15-minute indicative validity are commercial decisions about risk; they're runtime configuration that pricing owns, shown on the ops page next to the measured hit rates.

**Cache-key correctness with contract prices.** The linehaul key is either `contract:<contract id>:<lane>:<commodity>:<equipment>` or `tariff:<lane>:<commodity>:<equipment>`. The contract id is resolved on the server from the authenticated customer's contracts, never taken from the request. Keying by lane alone leaks: customer A's discounted contract rate becomes customer B's quote the first time B's pricing call times out and falls back to the cache. Keying by customer is safe but cuts the tariff hit rate by the number of customers sharing that public price. Keying by pricing basis shares exactly what is public and isolates exactly what is private. The same rule applies to single-flight keys, which people forget: coalescing two customers' "identical" pricing calls is a leak unless both are on the tariff.

| Linehaul cache key | Shares the tariff entry | Leaks a contract price | Verdict |
|--------------------|-------------------------|------------------------|---------|
| ✅ Pricing basis: contract id, or "tariff" | Yes, across every tariff customer | No | Chosen |
| ❌ Lane + commodity + equipment | Yes | Yes, on the first cache fallback | Wrong |
| ❌ Customer + lane + … | No: one entry per customer | No | Safe but wasteful |
| ❌ Contract id taken from the request | Yes | Yes, by anyone who guesses an id | Wrong |

**What I give up.** Every cached value has to carry a comparable version, invalidation depends on the event pipeline being healthy, and a contract amendment would need its own event to raise a contract floor (I'd add `ContractAmended`). The lag between publication and invalidation is real but bounded and visible: firm quotes record the version they used, so even in that window every price is explainable.

### Deep dive 3: Exactly-once effects from at-least-once delivery (state plus outbox, idempotent consumers)

**Decision.** State plus a transactional outbox, at-least-once delivery everywhere, and every consumer idempotent by a natural key or a `processed_events` row written in its own transaction. Consumers are built so they don't need ordering.

**Why the outbox.** The quote row and the fact that it needs completing must agree. Writing the row and then publishing to Kafka loses the event if the process dies between them; publishing first emits an event for a quote that may never commit. With the outbox, both are one PostgreSQL transaction, and a relay publishes committed rows afterwards. The relay can crash after publishing and before marking rows published, so it republishes. That's fine, because...

**Why every consumer must be idempotent.** Each step has a gap between "did the work" and "recorded that I did": the completer commits and then acknowledges; the relay publishes and then stamps. Any crash in that gap means redelivery. I tested it by killing the completer between its commit and its acknowledgment: on restart it reclaimed the pending message after the backoff, saw the quote already firm, and acknowledged. One `FirmQuoteCompleted`, one webhook. The rule is that exactly-once *effects* come from at-least-once delivery plus an idempotency check that lives in the same transaction as the effect: the quote state under a row lock for the completer, a unique `event_id` for webhook rows, `processed_events` for the projector, monotonic versions for the invalidator.

**Why not event sourcing.** The quote's current state is read on every poll, booking and re-pricing. With event sourcing every read is a fold or a snapshot store to maintain, and every schema change touches history. A small aggregate with a hot read path is the case where state plus outbox wins. I still keep the log complete enough to replay analytics from position 0 and to show a dispute timeline.

**Ordering vs parallelism.** Kafka keeps per-partition order, but I don't build consumers that depend on it. The completer decides from the row; the projector's increments are commutative and bucketed by event time, so a late event lands in the right hour; "current tariff" only moves forward, so a replayed v7 after v8 is recorded but ignored. That lets the completer process many messages at once without a per-key ordering scheme, and makes replay trivially equal to live. I verified it both ways: a test folds events shuffled and duplicated and compares with an in-order fold, and the replay command rebuilds the live tables to the same checksum.

**Schema evolution.** `QuoteIssued` v2 added per-component provenance. Readers upcast v1 to v2 (`reason: unknown`, null latencies) and were deployed before writers. Nothing in the log is rewritten.

| Consumer | Idempotency key | Where it lives | Redelivery outcome |
|----------|-----------------|----------------|--------------------|
| Completer | Quote state + (completer, event_id) | Same transaction as the firm update | `already_firm`, no events |
| Webhook enqueue | event_id | Unique column on deliveries | No second row |
| Invalidator | event_id; monotonic floor and current version | Our log; Redis floor | `duplicate` or `stale` |
| Projector | (analytics, event_id) | Same transaction as the increments | No change |
| Customer's receiver | X-FQ-Event-Id | Their inbox | Acknowledged, acted on once |

**What I give up.** Duplicate deliveries cost a lookup each; consumers need an idempotency record per event; the DLQ needs an owner. Redrive goes to a per-group topic so it doesn't replay to every other group.

---

## 🛡️ Overload: Shedding by Client Class (~2 min)

> "When an instance is saturated, I refuse the re-quoting integration first, then other integrations, and the person in the portal last. A shed costs a counter and a 503 with Retry-After, never a dependency call."

In a 12-second storm test (60 integration workers re-quoting with no backoff, two portal users, a capacity service with six workers), portal quotes were firm 13% of the time unprotected, 63% with shedding, and 100% with shedding plus per-customer rate limits. The middle row carries a lesson: a client that ignores `Retry-After` turns cheap `503`s into 25,809 requests in 12 seconds. Shedding protects latency; rate limits at the door and documented backoff protect capacity.

---

## 📜 Execution Traces (~4 min)

### Successful trace: indicative, then firm by callback

1. Pat (portal, contract CTR-PGC-2026) asks for 30 covered hoppers of wheat, Minneapolis → Portland, with a callback. Classified `portal`, token taken, admitted, no existing row for the key.
2. Fan-out (900 ms deadline): linehaul and fuel are current-version cache hits; car supply answers live in 103 ms; capacity, slowed to 2.5 s, misses its 600 ms budget (the hedge misses too).
3. The composer uses a 3-minute-old capacity snapshot, labels it, and returns indicative ≈ $177,666, firm expected between $163,428 and $183,768.
4. One transaction: quote row, `QuoteRequested`, `QuoteIssued`. `202` in 603 ms.
5. The completer gets `QuoteRequested`, calls capacity with 5 s, gets an answer in 2.4 s, commits the firm quote with `FirmQuoteCompleted`, then acknowledges.
6. The webhook consumer creates one delivery. The customer's endpoint fails twice and accepts the third attempt, verifying the signature. The portal's poll shows "Firm", and Book is enabled.

### Failed trace: capacity down beyond the retry budget, a tariff in between

1. Nina (public tariff) asks for 8 centerbeams of lumber, Portland → Los Angeles. Capacity returns 503 and there's no snapshot: indicative, "capacity not confirmed, up to 15%", `202` in 85 ms.
2. Pricing publishes tariff v8 for that lane. The invalidator raises the floor, records v8, re-prices Nina's open indicative quote (revision 2, +$840) and emits `QuoteIssued` (repriced, caused by the tariff event).
3. The same v8 event is delivered again: duplicate, no change. A late v7 arrives: recorded, current stays v8.
4. The completer fails five times (1, 2, 4, 8 s backoff), the message goes to the DLQ, and the quote shows "firm delayed". An alert fires on completer DLQ depth.
5. Capacity recovers; an operator redrives. Only the completer group sees it. The firm quote is priced at v8, attempt 6, and the timeline shows the chain through causation ids.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | The quote row in PostgreSQL, committed together with its events. Everything else is derived. |
| Client retries after losing the response? | Same Idempotency-Key returns the same quote in its current state; a different body is a 422. Bookings work the same way. |
| A worker fails between two steps? | Effects and their idempotency record commit together; acknowledgment comes after. A crash means redelivery, which is a no-op. |
| Which ordering is required? | Per quote, for the timeline only, and Kafka keys by quote id. Consumers are order-insensitive by design. |
| Access with caches and async jobs? | Contract prices cached under a server-resolved contract id; quotes filtered by customer (404 otherwise); callbacks only to registered URLs, signed per customer. |
| What breaks first at 10×? | The capacity service. With six workers, sixty re-quoting clients took portal firm rates from 100% to 13% in the load test. Then the single outbox relay. |

---

## ❓ Follow-ups the Answer Must Handle

**"Capacity's p99 jumps to eight seconds. What does a customer see?"** Within 600 ms, an indicative quote with the capacity premium either from a labeled snapshot or marked "not confirmed, up to 15%" with a price band. Hedging rescues the per-request tail; if the whole service is slow, the breaker opens and answers become instant. The firm quote follows when the completer gets through (it has 5 seconds per try), by poll or callback.

**"How stale may a cached price be, and who decides?"** Versioned prices: as stale as the current published version, which isn't stale at all. Invalidation is by event, not TTL. Perishable inputs: up to the policy (30 minutes here), only in indicative quotes, always labeled. Pricing and commercial owners set the policy; engineering enforces and measures it.

**"An integration re-quotes the same lane 50 times a minute."** It's classified `api_requote` after the first request in a minute. Its customer's token bucket returns `429` with `Retry-After` beyond its contracted rate. Identical in-flight calls coalesce into one dependency call, versioned components come from cache, and under load its re-quotes are shed first. In production I'd also return the existing still-valid firm quote for identical inputs.

**"A customer books against a quote whose tariff has since changed."** If the quote is firm and unexpired, booking honors it at the quoted version; the booking records both the honored version and the current one. If it expired, `409 QUOTE_EXPIRED` and a new quote at current prices. Indicative quotes can't be booked; open ones were re-priced when the tariff changed.

**"A customer disputes last week's quote."** The quote row pins tariff or contract version, fuel week, snapshot ids and rules version; `tariff_versions` holds what each version said; the event log shows every revision with event time, cause and producer. Reconstruction is a lookup, not an archaeology project.

---

## 🔭 Observability and Security (~2 min)

| Signal | Why I'd watch it | Page when |
|--------|------------------|-----------|
| Indicative share by dependency | The customer-visible symptom of a slow dependency | > 20% for 10 minutes |
| Dependency p99 vs budget, breaker state | Which dependency, and whether it's slow or down | Breaker open > 2 minutes |
| Shed and 429 counts by class | Who is being refused | Portal shed > 0 |
| Cache hit rate, stale-version lookups | Whether invalidation is working | Hit rate drops by half |
| Consumer lag per group, DLQ depth | Firm quotes stuck, tariffs not invalidated | Completer DLQ > 0; invalidator lag > 60 s |
| Outbox backlog age | Events not leaving PostgreSQL | > 30 s |

Security in one breath: sessions for people, hashed API keys for integrations, a customer can't see another customer's quote (404, not 403), contract prices isolated by key, callbacks only to registered URLs with per-customer HMAC secrets and a five-minute replay window, and no headers in logs.

### Topics

| Topic | Key | Partitions | Retention |
|-------|-----|------------|-----------|
| quote.events | quote id | 32-64 | 7 days + archive; PostgreSQL keeps the full log |
| pricing.tariffs | tariff id | 8 | Compacted: latest version per tariff |
| pricing.fuel | schedule | 1 | Compacted |
| quote.events.completer.retry / .dlq | quote id | 8 | Until handled |

---

## 🚨 Failure Handling (~1 min)

| Failure | Behavior |
|---------|----------|
| One dependency slow | Budget, hedge (capacity), indicative from snapshot, async firm |
| One dependency down | Breaker opens, instant indicative; completer retries, then DLQ and redrive |
| Pricing down with an empty cache | `503 PRICING_UNAVAILABLE`, Retry-After, no quote stored |
| Completer crash mid-message | Redelivered after backoff; idempotent |
| Poison event (unknown schema) | DLQ on first delivery, only in groups that handle that type |
| Webhook endpoint down | Exponential backoff with jitter, 8 attempts, then dead and operator retry |
| Redis down | Defaults for settings; live calls instead of cache; the gateway's limiter is the backstop |

---

## 📈 What Breaks First and How It Scales (~2 min)

1. **The capacity service.** Snapshot cache, coalescing and re-quote shedding first; then have capacity publish lane-utilization changes as events (they change a few times an hour) so the quote path reads a local view and stops calling it.
2. **Coalescing across instances.** Single-flight is per process; with N instances a hot key costs N calls. Route by a hash of the pricing key, or share results through a short-lived Redis entry.
3. **The outbox relay.** One leader per database; replace it with CDC (Debezium) into Kafka.
4. **PostgreSQL.** Partition quotes by month, read replicas for polling, and move analytics to ClickHouse.
5. **Completer.** Scales with partitions; its per-try budget bounds work per message.

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Slow dependency | Indicative now, firm async | Wait / fail | Bounded latency, honest label |
| Tail latency | Budgeted hedging | In-request retries | Fixes p99 without multiplying load |
| Tariff freshness | Version floors from events | TTL | Correct rather than recent |
| Contract cache key | Server-resolved contract id | Lane only / customer id | No leaks, shared tariffs |
| Event log | State + outbox | Event sourcing | Hot reads stay simple; log still replayable |
| Delivery | At-least-once + idempotency | Exactly-once transport | Works across DB, cache, HTTP |
| Async coordination | Choreography | Orchestrator | No compensation needed |
| Ordering | Order-insensitive consumers | Ordered per-key consumers | Parallelism, trivial replay |
| Overload | Shed by class + per-customer limits | Global limit | People first; storms stopped at the door |

---

## 📝 Wrap-up (~1 min)

> "The endpoint always answers within its deadline because nothing on the request path is allowed to wait: one budget, hedging for the slow tail, breakers for outages, coalescing for duplicates, shedding for overload. It stays correct because 'firm' means confirmed and pinned, cache entries carry versions that events invalidate, and contract prices are keyed by contract. Everything that takes longer or might be retried is an idempotent consumer of an outbox, so at-least-once delivery produces exactly-once effects."

### How the local implementation compares

The repo builds this with Express, PostgreSQL and Valkey Streams standing in for Kafka (four partition streams, consumer groups, XPENDING/XCLAIM redelivery with exponential backoff, a DLQ and per-group redrive). Mock dependencies have latency, tail, error, hang, worker-pool and outage knobs, and honor propagated deadlines. Breakers use opossum. The measured numbers above come from its load script. Simplifications: one database for everything, in-process single-flight, per-instance breakers and shedding, and a pricing system that writes straight to a stream.
