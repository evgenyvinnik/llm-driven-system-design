# Freight Quote Service — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Requirements → Architecture → Quote path → Event-driven side → UI → Deep dives → Traces → Scale*

> "A shipper asks what it costs to move cars of freight from A to B. The price depends on four slow services: tariff and contract pricing, the fuel surcharge, network capacity and car availability. I'll design the endpoint so it always answers within a second, the portal so a customer can tell a commitment from an estimate at a glance, and an event-driven back half that turns estimates into commitments, invalidates caches when prices are published, and feeds analytics. The thread through the whole stack is one distinction: a *firm* quote is confirmed and pinned to the exact inputs it used; an *indicative* quote is labeled with what isn't confirmed yet, and becomes firm a few seconds later."

| Phase | Time | Focus |
|-------|------|-------|
| Requirements | ~5 min | Latency promise, firm vs indicative, contract prices |
| Architecture | ~5 min | Stateless API, four dependencies, outbox, consumers, portal and ops console |
| Quote path | ~6 min | Deadline, budgets, hedging, breakers, coalescing, shedding |
| Event side and UI | ~8 min | Async completion, invalidation; portal states; ops page |
| Deep dives | ~14 min | Indicative→firm across the stack; staleness and cache keys; idempotency end to end |
| Traces and scale | ~7 min | One success, one failure, checklist, what breaks first |

---

## 🎯 Requirements (~5 min)

### Clarifying questions

| Question | Assumption |
|----------|------------|
| Is a quote a commitment? | Firm quotes are honored at booking until they expire; estimates are labeled and not bookable |
| Who calls it? | People in a portal, and integrations that re-quote lanes every few minutes |
| Contract rates? | Per customer and lane; never visible to another customer |
| How often do inputs change? | Tariffs per publication, fuel weekly, capacity and car supply continuously |
| Can the answer come later? | Yes: 202 with a poll URL, or a signed callback to a registered URL |

### Functional

1. A customer (portal or API) requests a quote for lane, commodity, equipment, quantity and ship week, with an idempotency key.
2. The answer is firm (bookable, valid 24 hours) or indicative (an estimate with a band, valid 15 minutes) that becomes firm asynchronously, by polling or a signed callback.
3. Each quote shows its components (linehaul, fuel surcharge, capacity premium, equipment premium) with source, version, age and a staleness note.
4. Firm quotes pin their inputs; booking honors them. Published tariffs re-price open indicative quotes, never firm ones.
5. Operators see dependency latency, breakers, cache hit rate, shedding, consumer lag and the DLQ, and can inject faults.

### Non-functional

| Property | Target |
|----------|--------|
| Quote latency | p99 < 1 s whatever the dependencies do |
| Firm completion | p95 < 10 s after an indicative answer |
| Correctness | No cross-customer contract prices; no firm quote from unconfirmed inputs |
| Overload | Portal unaffected by an integration retry storm |
| Portal | Shows the state change indicative → firm within ~1 s of it happening |

### Scale (illustrative)

| Quantity | Estimate |
|----------|----------|
| Quote requests | ~300/s average, ~3,000/s peak, ~90% from integrations |
| Dependency calls without cache | 4 per quote, ~12,000/s at peak |
| Cache working set | ~1-2 GB (versioned tariffs, snapshots) |
| Events | ~1,000/s (2-4 per quote) |
| Pending firm completions | Up to ~30% of quotes during a capacity slowdown |

> "The API scales horizontally without thinking. The capacity service doesn't, so the design is about not converting quotes one-for-one into capacity calls, and about what the customer sees when it's slow."

---

## 🏗️ High-Level Architecture (~5 min)

```
 ┌───────────────────────┐        ┌─────────────────────┐
 │ Customer portal (SPA) │──────▶ │ API gateway         │  sessions, API keys,
 │ Ops console (SPA)     │        │ rate limits         │  per-customer limits
 └──────────┬────────────┘        └──────────┬──────────┘
            │ poll GET /quotes/:id           ▼
            │                     ┌─────────────────────────────┐      ┌─────────────────┐
            └────────────────────▶│ Quote API (stateless)       │◀────▶│ Component cache │
                                  │ admit ▸ idempotency ▸       │      └─────────────────┘
                                  │ fan-out under one deadline  │
                                  └──┬──────┬───────┬───────┬───┘
                                     ▼      ▼       ▼       ▼
                                 Pricing  Fuel  Capacity  Car supply
                                     │
 ┌──────────────────────────────┐   │ TariffPublished
 │ PostgreSQL: quotes + outbox  │   ▼
 └──────────────┬───────────────┘ ┌─────────────────────────────────────────────┐
                └──── relay ────▶ │ Kafka: quote.events, pricing.tariffs, fuel  │
                                  └──┬──────────┬───────────┬────────────┬──────┘
                                     ▼          ▼           ▼            ▼
                                Completer   Webhooks   Invalidator   Analytics
```

> "The backend is a stateless quote API in front of four slow dependencies, PostgreSQL as the source of truth with an outbox table, and four consumers. The frontend is two single-page apps on the same API: a customer portal and an ops console. The portal never talks to the event stream directly. It polls the quote resource, which the consumers keep up to date."

---

## ⏱️ The Quote Path (~6 min)

1. **Classify and admit.** Session = `portal`; API key = `api`, or `api_requote` if the same inputs were asked for in the last minute. A per-customer token bucket (429), then admission control by class (re-quotes shed first at 40% of an instance's in-flight limit, integrations at 75%, people at 100%).
2. **Idempotency.** The key is scoped to the customer; a replay returns the quote in its current state; a different body under the key is a 422.
3. **Fan-out.** A 900 ms deadline (or the client's shorter one), propagated downstream. Budgets: pricing 400 ms, fuel 250, capacity and car supply 600. Linehaul and fuel are served from cache when the cached version is current. Identical in-flight calls coalesce. A breaker per dependency. Capacity is hedged after its recent p90, capped at 15% of calls.
4. **Compose.** Firm needs live or current-version linehaul and fuel, and live capacity and car supply. Otherwise indicative: snapshots up to 30 minutes old labeled with their age, or "not confirmed" with the maximum premium added to the band's high end. No linehaul at all is a 503.
5. **Persist.** Quote row plus `QuoteRequested` and `QuoteIssued` in one transaction. 201 firm, 202 indicative with `Location`.

| Data | Key fields |
|------|------------|
| quotes | customer, idempotency key (unique per customer), lane, kind, firm status, status, revision, total, band, inputs (pinned versions), components (provenance), valid until |
| events | event id, type, version, stream id + version, occurred/recorded at, correlation, causation, payload |
| bookings | quote (unique), honored total, honored inputs, tariff version current at booking |

---

### API

```
POST /api/v1/quotes            Idempotency-Key; session or X-Api-Key; optional X-Request-Deadline-Ms
                               → 201 firm · 202 indicative + Location · 200 replay · 422 · 429 · 503
GET  /api/v1/quotes/:id        Poll target; 404 for another customer's quote
GET  /api/v1/quotes/:id/events Timeline (own stream + causes + webhook deliveries)
POST /api/v1/quotes/:id/book   Idempotency-Key; 409 when indicative, expired or already booked
GET  /api/v1/ops/overview      Merged per-instance stats, settings, knobs (ops)
GET  /api/v1/streams           Consumer lag, outbox backlog, DLQ (ops)
```

### Quote lifecycle

```
             ┌──────────── 201 ─────────────┐
 request ────┤                              ▼
             └─ 202 ─▶ indicative ──firm──▶ firm ──book──▶ booked
                       │   ▲  pending       │
           re-priced ──┘   │                └──valid_until──▶ expired
           (tariff, fuel)  └── delayed (DLQ) ── redrive ──▶ firm
```

---

## 📨 The Event-Driven Side (~4 min)

| Event | Producer | Consumers |
|-------|----------|-----------|
| QuoteRequested | API | Completer, analytics |
| QuoteIssued (v2, with provenance) | API, completer, invalidator | Analytics |
| FirmQuoteCompleted | Completer | Webhooks, analytics |
| QuoteExpired, QuoteBooked | Sweeper, API | Analytics |
| TariffPublished, FuelSurchargeChanged | Pricing system | Invalidator |
| DependencyCircuitOpened / Closed | Breakers | Ops, analytics |

- **Completer**: skips quotes already firm, expired or booked; calls dependencies with 5 s; retries with 1-8 s backoff; dead-letters after five tries ("firm delayed" in the UI); redrive per group.
- **Invalidator**: raises the cache version floor, records the version, moves the current tariff only forward, re-prices open indicative quotes (new revision, new `QuoteIssued`).
- **Webhooks**: one delivery row per event; signed; retried with backoff; receivers dedupe by event id.
- **Analytics**: commutative counters by event hour; replayable from position 0.

> "Choreography fits: four independent reactions, none needing a coordinator or compensation. The log is an outbox; the quote row is the source of truth."

---

## 🖥️ The UI (~4 min)

### Customer portal

```
┌ Request a quote ────────┐  ┌ Quote ──────────────────────────────────────────────┐
│ Lane    [MSP → PDX ▾]   │  │ [Indicative] open        ≈ $177,666                 │
│ Commodity [Wheat ▾]     │  │ MSP→PDX · 30 hoppers     firm expected $163k–$184k  │
│ Cars [30]  Week [11-30] │  │ ⏱ estimate valid 15 min · answered in 603 ms        │
│ ☑ notify our webhook    │  │ ◌ Confirming capacity… firm quote follows           │
│ [ Get quote ]           │  ├ Price components ───────────────────────────────────┤
│ Idempotency-Key a1b2…   │  │ Linehaul   $4,520  cached  contract CTR-PGC v3  23s │
└─────────────────────────┘  │ Capacity    $475   cached  snapshot 3 min old  ⚠    │
                             │ Equipment   $180   live    18 cars near origin      │
                             └─────────────────────────────────────────────────────┘
```

- **Submit** creates an idempotency key per submission; a retry after a network error reuses it.
- **202** shows the indicative card with a spinner line and starts polling `GET /quotes/:id` every second until the quote is firm or delayed.
- **Firm** swaps the badge, the price becomes exact, the countdown says 24 h, Book enables.
- **Quote detail** adds the pinned inputs and an event timeline from the log (requested, issued, re-priced by tariff v8, firm completed, webhook delivered), with causation links.

### State on the client

| State | Where it lives | Why |
|-------|----------------|-----|
| Signed-in user and role | Zustand store | Read by the shell, routes and role checks |
| Reference data (lanes, commodities, weeks) | Loaded once per page | Changes rarely |
| Current quote | Component state, replaced by each poll | The server is the source of truth; no client-side merging |
| Idempotency key | Form state, regenerated when any field changes or after a definitive answer | One key per logical submission |
| Ops and streams data | Polling hook (2 s), paused while the tab is hidden | Cheap, no extra infrastructure |

> "I don't do optimistic UI for prices. A price the server hasn't computed is a guess the customer might act on. The only optimism is in the label: an indicative card says up front that it will change."

### The timeline view

The quote detail page reads the quote's own event stream in `stream_version` order plus any events from other streams named as a cause (a `TariffPublished` that re-priced it), and the webhook deliveries for it. Each row shows event time, the schema version it was stored in, the producer and the causation link. It's the dispute view and the debugging view at once, and it costs one indexed query because the outbox is also a log.

### Ops console

Four dependency cards (p50/p95/p99 against the budget, breaker badge, calls, cache hit rate, hedges, coalesced, server-side queue and abandoned work), traffic by client class (firm, indicative, shed, 429), switches for hedging, coalescing, deadline propagation, shedding and rate limits, fault knobs ("p99 → 8 s", "down"), and pricing publications. A streams page shows consumer lag per group, outbox backlog, DLQ entries with redrive, webhook deliveries and a "verify replay = live" button. Everything polls every 2 seconds.

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Indicative → firm across the stack (202 + poll vs push)

**Decision.** The API returns `202` with a `Location`; the portal polls that resource every second while the quote is pending; integrations can also register a callback URL and receive a signed webhook at least once.

**Why this works.** The quote resource is the source of truth and the poll is a cheap indexed read. Whatever happened (completed, re-priced by a tariff, delayed), the next poll returns the current state, so the client can't miss or misorder anything. Pending lasts seconds, so 1 s polls cost a handful of requests per quote. For integrations, a webhook avoids polling entirely, and because it's at least once and signed, they can trust it and deduplicate by event id. Both paths work through any proxy, and both survive an API restart.

**Why push to the browser fails here.** Server-sent events or WebSockets would need the API instance holding the connection to learn about `FirmQuoteCompleted`, which means a fan-out layer (Redis pub/sub or a gateway) between the consumers and every API instance, sticky connections, reconnection with replay ("what did I miss?"), and auth on a long-lived channel. For a state change that happens once per quote within seconds, that machinery buys about 500 ms of latency. Push earns its keep for continuous updates (a live ops wall); here it adds a second source of truth that can drift from the resource.

**What I give up.** Up to a second of extra latency and some idle polls. If the portal needed many concurrent pending quotes, I'd batch them into one `GET /quotes?ids=` poll before reaching for push.

| Option | Latency | Moving parts | Missed updates |
|--------|---------|--------------|----------------|
| ✅ 202 + poll (portal) | ≤ 1 s | None new | Impossible: reads current state |
| ✅ Signed webhook (integrations) | Seconds | Delivery table, retries | At least once, deduped by event id |
| ❌ SSE/WebSocket to the browser | ~100 ms | Pub/sub fan-out, sticky sessions, replay | Possible across reconnects |

### Deep dive 2: Staleness that's labeled, and cache keys that can't leak

**Decision.** Versioned inputs (tariffs, contracts, the weekly fuel surcharge) are cached and count as confirmed at their current version; events invalidate them through monotonic version floors. Perishable inputs (capacity, car supply) are cached only as snapshots for indicative quotes, age-limited and labeled. The linehaul cache key includes the contract id or the word "tariff", never just the lane.

**Why it works.** A tariff is valid until a new version is published, so a cached copy at the current version is as good as asking. `TariffPublished` raises the floor; cached values below it are ignored on read and refused on write, which also stops a slow in-flight call from writing an old version back after invalidation. Contract prices are keyed by a contract id the server resolves from the authenticated customer, so the cache can only ever return a contract price to that contract's requests, and every tariff customer on a lane shares one entry.

**Why TTL caching and lane keys fail.** A TTL is either long enough to sell at a superseded tariff for minutes after every publication, or so short it hammers the pricing service for a value that changes weekly. A lane-only key leaks: the first time customer B's pricing call times out, the fallback serves customer A's discounted contract rate. The single-flight key has the same trap.

**How the UI carries it.** Each component row shows its source badge (live, cached, unconfirmed), basis and version, and age; cached perishable values add a sentence ("capacity service did not answer within its budget; using a snapshot 3 min old (policy max 30 min)"). An indicative price is prefixed with "≈" and paired with a band. Nothing stale is shown without a label, and the staleness policy is owned by pricing, configurable and visible on the ops page.

| Input | Cached as | Can make a quote firm? | Label when used stale |
|-------|-----------|------------------------|-----------------------|
| ✅ Tariff / contract | Versioned entry, floor from TariffPublished | Yes, at the current version | Never served stale |
| ✅ Fuel surcharge | Versioned by week and publication | Yes, current publication | "Superseded week, ±10%" |
| ✅ Capacity, car supply | Last-known snapshot, ≤ 30 min | No | "Snapshot N min old" or "not confirmed" |
| ❌ Everything with one TTL | Opaque entry | Ambiguous | Nothing to say: the cache doesn't know |

**What I give up.** Every cached value carries a version; invalidation depends on the event pipeline (its lag is a paged metric); contract amendments need their own event.

### Deep dive 3: Exactly-once effects from end to end (at-least-once plus idempotency)

**Decision.** Idempotency at every hop: the browser's idempotency key, the quote's unique key per customer, a transactional outbox, idempotent consumers, deduplicated webhooks.

**Why it works.** Follow one click. The form makes a key when the user submits. If the network drops the response, pressing the button again resends the same key, and the server returns the quote it already made, in its current state. The quote row and its events commit together, so there's never a quote without its `QuoteRequested`, or the reverse. The relay can publish twice after a crash; the completer can process a message twice if it dies between committing and acknowledging. I tested exactly that by killing it in the gap: on restart it reclaimed the message, saw the quote already firm and did nothing. The webhook table has one row per event, and the customer's receiver deduplicates by event id. Each step tolerates a duplicate, so the whole chain gives exactly-once effects over at-least-once delivery.

**Why "exactly-once delivery" fails.** It isn't available end to end: the chain crosses PostgreSQL, Kafka, Redis and a customer's HTTP endpoint, and no transaction spans them. Kafka's transactions cover Kafka-to-Kafka; the HTTP callback is never covered. Pretending otherwise means the one crash nobody tested produces a second firm quote or a double booking.

**Why order doesn't matter either.** Consumers decide from current state (the completer), use commutative increments bucketed by event time (analytics), or move a version only forward (tariffs). So the completer can work on many messages at once, replay equals live, and a late tariff v7 after v8 changes nothing.

| Hop | Duplicate source | Guard |
|-----|------------------|-------|
| Browser → API | Double click, retry after a lost response | Idempotency-Key, unique per customer |
| API → PostgreSQL | Two instances racing on one key | Unique constraint; loser returns the winner's quote |
| Outbox → Kafka | Relay crash after publishing | Consumers dedupe by event id |
| Kafka → completer | Crash between commit and ack | Quote state under row lock + processed_events |
| Completer → webhook | Redelivered FirmQuoteCompleted | One delivery row per event id |
| Webhook → customer | Retry after a timeout | Receiver dedupes by X-FQ-Event-Id |

**What I give up.** An idempotency record per consumer per event, a DLQ with an owner, and discipline: every new consumer needs its key decided before its first line of code.

---

## 📜 Execution Traces (~4 min)

### Successful trace

1. Pat submits 30 hoppers MSP → PDX with a callback; the form sends key `portal-0333…`.
2. Linehaul and fuel are current-version cache hits; car supply answers in 103 ms; capacity misses its 600 ms budget. The composer uses a 3-minute-old snapshot and returns indicative ≈ $177,666 (band $163k-$184k). `202` in 603 ms; the portal starts polling.
3. The completer confirms capacity in 2.4 s and commits the firm quote with `FirmQuoteCompleted`. The next poll swaps the card to Firm; Book enables.
4. The webhook fails twice at the customer's end and succeeds on the third attempt; the receiver stores it once.

### Failed trace

1. Nina's lumber quote PDX → LAX meets a capacity outage: indicative, "not confirmed, up to 15%", `202` in 85 ms.
2. Tariff v8 is published: the invalidator re-prices her open quote (revision 2, +$840); the portal's poll shows the new total and the timeline shows "re-priced, caused by TariffPublished v8". A duplicate v8 and a late v7 change nothing.
3. Five completion attempts fail; the message goes to the DLQ; the card says "firm delayed"; ops gets paged.
4. Capacity recovers; ops redrives from the streams page; the quote becomes firm at v8.

---

### Measured locally (one API instance, `npm run load`)

| Mechanism | Without | With |
|-----------|---------|------|
| Hedging (5% of capacity calls at 1.5 s) | p99 1,606 ms | p99 200 ms, +7% capacity calls |
| Coalescing (bursts of 40 identical requests, 4 capacity workers) | 10% firm, p99 733 ms | 100% firm, p99 290 ms |
| Shedding + rate limits (60 re-quoting workers vs 2 portal users) | Portal 13% firm, p50 607 ms | Portal 100% firm, p50 229 ms |

---

## ✅ Design Review Checklist

| Question | Answer |
|----------|--------|
| Source of truth? | The quote row, committed with its events |
| Client retries after a lost response? | Same key returns the same quote in its current state; the form reuses the key |
| Worker fails between steps? | Commit, then acknowledge; redelivery is a no-op |
| Ordering required? | Per quote for the timeline (Kafka key = quote id); consumers are order-insensitive |
| Access with caches and async jobs? | Contract-id cache keys; quotes filtered per customer (404); callbacks only to registered URLs |
| What breaks first? | Capacity: sixty re-quoting clients took portal firm rates from 100% to 13% in the load test without protection |

---

## ❓ Follow-ups

- **Capacity p99 is 8 s?** Within 600 ms the customer sees an indicative quote with the capacity row labeled; hedging rescues the per-request tail and the breaker handles a uniformly slow service; the card turns firm when the completer gets through.
- **How stale may a price be?** Published prices: the current version, invalidated by event. Snapshots: up to the pricing-owned policy (30 minutes), only in estimates, always labeled.
- **An integration re-quotes 50 times a minute?** Classified as re-quote, rate-limited per customer with Retry-After, coalesced, shed first under load.
- **Booking after a tariff change?** A firm unexpired quote is honored at its pinned version; the booking records both versions. Expired: 409, re-quote.
- **Dispute last week's quote?** Pinned inputs on the quote, the tariff version history, and the timeline from the log reconstruct it.

---

## 🚨 Failure Handling and Observability

| Failure | What the customer sees | What ops sees |
|---------|------------------------|---------------|
| Capacity slow | Indicative with a labeled snapshot, firm in seconds | p99 over budget, hedges fired, indicative share up |
| Capacity down | Instant indicative, then "firm delayed" | Breaker open, completer retries, DLQ depth |
| Pricing down, cold cache | 503 with Retry-After | Unavailable count, breaker open |
| Retry storm | Nothing (portal protected) | Shed and 429 counts by class |
| Webhook endpoint down | Polling still works | Delivery attempts, then dead; retry button |
| Consumer crash | Nothing | Pending messages reclaimed after backoff |

Security: sessions for people, hashed API keys for integrations, per-customer filtering everywhere (another customer's quote is a 404), contract-id cache keys, callbacks only to registered URLs with HMAC signatures, no headers in logs.

---

## 📈 What Breaks First and How It Scales

| Order | Bottleneck | Fix |
|-------|------------|-----|
| 1 | Capacity service | Snapshots, coalescing, re-quote shedding; capacity changes published as events |
| 2 | Per-instance single-flight | Route by pricing-key hash, or share results in Redis |
| 3 | Outbox relay | CDC into Kafka |
| 4 | Portal polling at scale | Batch polls; push only if the product needs it |
| 5 | PostgreSQL | Monthly partitions, read replicas, analytics in ClickHouse |

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Slow dependency | Indicative now, firm async | Wait / error | Bounded latency, honest label |
| Async result to portal | 202 + 1 s poll | SSE/WebSocket | One source of truth, no fan-out layer |
| Async result to integrations | Signed webhook, at least once | Polling only | No re-quote polling storms |
| Tariff freshness | Event-driven version floors | TTL | Correct, not merely recent |
| Contract cache key | Server-resolved contract id | Lane | No leaks |
| Event log | State + outbox | Event sourcing | Simple hot reads |
| Tail latency | Budgeted hedge | Retries | No load amplification |
| Overload | Shed by class + per-customer limit | Global limit | People first |
| UI for uncertainty | Badges, band, provenance rows | A single number | Customers can tell estimate from commitment |

---

## 📝 Wrap-up

> "On the backend: one deadline, hedging, breakers, coalescing and shedding keep the endpoint fast; a strict definition of firm, versioned cache entries and contract-keyed caches keep it correct; an outbox and idempotent consumers make the async side safe to retry. On the frontend: the portal shows the difference between an estimate and a commitment in every row, and follows a 202 by polling the resource that the consumers keep current."

The repo's implementation runs this with Express, PostgreSQL and Valkey Streams (as Kafka), mock dependencies with fault knobs, a React portal and ops console, and a load script whose numbers appear above. Simplifications: one database, in-process coalescing, per-instance breakers, polling everywhere.
