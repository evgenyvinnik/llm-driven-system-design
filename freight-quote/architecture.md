# Freight Quote Service - Architecture

## System Overview

Shippers and their logistics providers ask a railroad what it costs to move carload freight: origin, destination, commodity, car type and number of cars. The answer depends on four slow internal services: tariff and contract pricing, the weekly fuel surcharge, network capacity on the lane, and car availability at the origin. Traffic is heavy, and much of it comes from API integrations that re-quote the same lanes all day. The quote endpoint has to stay fast and correct while any of those dependencies is slow.

The design has a **request/response core** and an **event-driven side**:

- The core fans out to the four dependencies in parallel under one deadline, with a budget per dependency, hedged requests to the slow one, a circuit breaker per dependency, single-flight coalescing and load shedding by client class. When capacity or car supply can't answer in time, it returns an **indicative** quote at once, built from cached components with their staleness labeled, instead of a timeout.
- The event-driven side completes the **firm** quote asynchronously (`202` plus polling or a signed webhook), invalidates caches and re-prices open indicative quotes when a tariff or fuel surcharge is published, expires quotes, and builds an analytics read model. A transactional outbox in PostgreSQL feeds partitioned streams; every consumer is idempotent.

**Learning goals**

- Latency budgets, deadline propagation, and hedging versus retry amplification.
- Saying exactly which prices may be stale, who decides, and how a stale price is labeled (firm vs indicative).
- Cache keys that cannot leak one customer's contract price to another.
- At-least-once async completion made safe by idempotency, with retries, a DLQ and redrive.
- Shedding load by client class before the dependencies feel it.
- The event-driven bar: outbox, idempotent consumers, replayable projections, schema evolution, ordering and time.

**Signal.** BNSF candidate report: a high-traffic quote endpoint with slow dependencies. A curated PracHub account of a September 2026 screen reportedly began with implementing the service-layer logic of a freight rate inquiry endpoint, then discussed heavy traffic and downstream latency. Both are reported, not verified (see [CLAUDE.md](./CLAUDE.md)). All prices, volumes and latencies in this document are illustrative assumptions.

## Requirements

### Functional Requirements

1. `POST /quotes` with an idempotency key, customer (from authentication), lane, commodity, equipment type, quantity and ship week. It returns a **firm** quote (`201`) or an **indicative** quote (`202`) with a poll URL, and optionally a signed callback when the firm quote is ready.
2. Each quote carries priced components (linehaul, fuel surcharge, capacity premium, equipment premium). Each component records its source (live, cache, fallback), input version, age, latency and a staleness label.
3. A firm quote stores exactly the inputs it used (tariff or contract version, fuel surcharge week, capacity and car-supply snapshot ids, pricing rules version) and a validity window. Booking honors it until it expires.
4. Publishing a tariff or a fuel surcharge invalidates cached components and re-prices **open indicative** quotes. Firm quotes are never re-priced.
5. Quotes expire. Expired and indicative quotes cannot be booked.
6. Operators see per-dependency latency, breaker state, cache hit rate, hedges, coalescing and shed counts, and can inject slowness into the dependencies.
7. Analytics: quote volume by client class, conversion (booked ÷ firm), and latency per dependency, rebuilt from events.

### Non-Functional Requirements

| Property | Target (production) | What it forces |
|----------|---------------------|----------------|
| Quote latency | p99 < 1 s end to end, whatever the dependencies do | A hard deadline; indicative fallback instead of waiting |
| Firm completion | p95 < 10 s after an indicative answer | An async worker with a longer budget; `202` + poll or callback |
| Availability | 99.95% for `POST /quotes` | No single dependency on the critical path can fail the request, except pricing with an empty cache |
| Correctness | Zero contract prices served to the wrong customer; zero firm quotes built from unconfirmed inputs | Cache keys by pricing basis; firm requires live or current-version inputs |
| Auditability | Every firm quote reconstructible for disputes (retention per policy, e.g. 7 years) | Pinned input versions on the quote; versioned tariff history; append-only event log |
| Overload | Portal p99 holds during an integration retry storm | Shed by class, per-customer rate limits, `Retry-After` |
| Freshness of invalidation | A published tariff stops being served within seconds | Event-driven invalidation plus version floors, not TTLs |

### Out of Scope

Booking and car ordering beyond recording a booking against a quote; contract negotiation; the network capacity model itself; billing.

## Capacity Estimation

### Production Scale (illustrative assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Shippers with portal or API access | ~10,000 | A Class I railroad's active carload customers and logistics providers |
| Quote requests | ~300/s average, ~3,000/s peak | Integrations re-quote lanes every few minutes; portal is about 10% of traffic |
| Distinct pricing inputs per hour | ~200,000 | Lanes × commodities × equipment × contract basis actually quoted |
| Dependency fan-out without cache | 4 calls per quote → 12,000 calls/s at peak | The capacity model is the expensive one |
| Component cache | ~1-2 GB | ~1M entries × ~1 KB; versioned tariff entries live for days, snapshots for minutes |
| Events | ~1,000/s average, ~10,000/s peak | 2-4 events per quote (requested, issued, firm, expired or booked) |
| Firm completions | ~30% of quotes during a capacity slowdown | Everything that came back indicative |

> The capacity service is assumed to sustain a few hundred requests a second. Coalescing identical in-flight calls, caching last-known snapshots and shedding re-quotes are what keep 3,000 quotes a second from turning into 3,000 capacity calls a second.

The network figures that frame these estimates (32,500+ route miles, ~70,700 freight cars) are from BNSF's FY2025 10-K. Everything else is an assumption.

### Local Development Scale

One API instance (3001-3002 for more), one completer, one projector, a mock dependency process and a mock customer webhook receiver, all against PostgreSQL 16 and Valkey 7. The load script drives a few hundred requests per second, enough to show tail latency, coalescing and shedding.

## High-Level Architecture

```
                         ┌──────────────────────┐
  Portal (people) ──────▶│  CDN / API Gateway   │  auth, per-customer rate limits,
  API integrations ─────▶│  (class: portal/api) │  request deadline header
                         └──────────┬───────────┘
                                    ▼
                    ┌───────────────────────────────┐        ┌────────────────────────┐
                    │      Quote API (stateless)    │───────▶│ Component cache        │
                    │ admission ▸ idempotency ▸     │◀───────│ (Redis cluster)        │
                    │ fan-out under one deadline    │        │ versioned + snapshots  │
                    └──┬──────┬──────┬──────┬───────┘        └────────────────────────┘
          single-flight│ breaker per dependency │ hedge (capacity)
                       ▼      ▼      ▼      ▼
                 ┌────────┐┌──────┐┌────────┐┌────────────┐
                 │Pricing ││ Fuel ││Capacity││Car supply  │   internal services,
                 │tariff +││ FSC  ││network ││availability│   slow and independently
                 │contract││      ││ model  ││            │   deployed
                 └───┬────┘└──┬───┘└────────┘└────────────┘
                     │ TariffPublished / FuelSurchargeChanged
                     ▼
  ┌─────────────────────────────┐    ┌──────────────────────────────────────────────┐
  │ PostgreSQL (primary)        │    │ Kafka                                        │
  │ quotes, bookings,           │    │  quote.events      (keyed by quote id)       │
  │ tariff history, outbox log  │──▶ │  pricing.tariffs   (compacted by tariff key) │
  └─────────────────────────────┘    │  pricing.fuel      (compacted)               │
        outbox relay (CDC)           │  ops.dependency    (breaker transitions)     │
                                     └──┬──────────┬──────────┬──────────┬──────────┘
                                        ▼          ▼          ▼          ▼
                                  ┌──────────┐┌─────────┐┌──────────┐┌────────────┐
                                  │Firm      ││Webhook  ││Invalidate││Analytics   │
                                  │completer ││delivery ││+ re-price││projection  │
                                  │(retry,   ││(signed, ││(version  ││(ClickHouse │
                                  │ DLQ)     ││ retries)││ floors)  ││ in prod)   │
                                  └──────────┘└─────────┘└──────────┘└────────────┘
```

## Core Components / Request Flows

### 1. Admission: classify, rate-limit, shed

Each request is classified before any work:

| Class | How it is recognized | Admitted while in-flight is below |
|-------|----------------------|-----------------------------------|
| `portal` | Session (a person) | 100% of `maxInflight` |
| `api` | API key, first request for these inputs in 60 s | 75% |
| `api_requote` | API key, same inputs again within 60 s | 40% |

Then a per-customer token bucket (one Lua script in Redis; the contract can override the default rate) returns `429` with `Retry-After`. Then admission control compares the instance's in-flight count with the class threshold and returns `503 SHED` with a longer `Retry-After` for integrations. Both happen before the idempotency lookup, so refusing a request never costs a database query or a dependency call. Local: `backend/src/api/services/admission.ts`, `backend/src/shared/rate-limit.ts`.

### 2. Idempotency

The client sends `Idempotency-Key`, scoped to the customer (`UNIQUE (customer_id, idempotency_key)`). Same key and same request hash returns the stored quote with `Idempotent-Replayed: true` (its current state: an indicative answer may have become firm since). Same key with a different body returns `422 IDEMPOTENCY_KEY_REUSED`. Concurrent duplicates on one instance share one in-flight execution (single-flight on the key). Across instances, the unique constraint decides the winner and the loser returns the winner's quote. A request that produced no quote (pricing unavailable) leaves no record, so a retry with the same key tries again.

### 3. Fan-out under one deadline

```
deadline      = min(server deadline 900 ms, client X-Request-Deadline-Ms)
budget(dep)   = min(dep budget, deadline − now)     pricing 400 · fuel 250 · capacity 600 · availability 600
propagate     = X-Deadline: <absolute epoch ms> on every dependency call
```

For each dependency, in parallel:

1. **Versioned components first look in the cache** (linehaul, fuel surcharge). A hit at the current version is served without a call.
2. **Single-flight** joins an identical in-flight call (same coalescing key) instead of making a new one. The leader's call runs under its own budget; a follower races its own deadline, so it never waits longer than it was allowed to.
3. **The breaker** wraps the call. Open means fail fast to the fallback.
4. **Hedging** (capacity only, by default): if the call hasn't answered after the 90th percentile of its recent latency (never sooner than 60 ms), a second identical call starts and the first answer wins; the loser is aborted. A token bucket caps hedges at 15% of calls, and a half-open breaker is never hedged.
5. A live answer is written back to the cache, unless a newer version was published while it was in flight (version floor, below).
6. A failed perishable call (capacity, car supply) falls back to the last-known snapshot if it is younger than the staleness policy.

Every branch resolves to a result; nothing throws. The composer decides what they add up to. Local: `backend/src/shared/fanout.ts`, `backend/src/shared/resilience.ts`, `backend/src/shared/breakers.ts`.

### 4. Firm vs indicative (the composer)

| Component | Firm requires | Indicative may use | Never |
|-----------|---------------|--------------------|-------|
| Linehaul (tariff or contract) | Live, or cached **at the current version** | The same; nothing else | A superseded version; an invented price |
| Fuel surcharge | Live, or cached for the current publication | Last week's cached surcharge, labeled "may be superseded (±10%)" | |
| Capacity premium | Live | Snapshot ≤ 30 min old, labeled with its age; else 0 and "not confirmed" | |
| Equipment premium | Live | Snapshot ≤ 30 min old; else 0 and "not confirmed" | |

- No linehaul at all means `503 PRICING_UNAVAILABLE` with `Retry-After`. There is no price to estimate from.
- An indicative quote shows an estimate **and a band**: low assumes no premium for unconfirmed components, high assumes the maximum (15% capacity premium, $250 per car equipment premium, illustrative). It is valid for 15 minutes and is not bookable.
- A firm quote is valid for 24 hours and is a commitment.

The staleness policy (30 minutes for snapshots, the bands, the validity windows) belongs to pricing and commercial owners, not to engineers; it is runtime configuration shown on the ops page. Local: `backend/src/shared/compose.ts`.

### 5. Persist: quote row + events in one transaction

```sql
BEGIN;
INSERT INTO quotes (...) ON CONFLICT (customer_id, idempotency_key) DO NOTHING RETURNING *;
INSERT INTO events (QuoteRequested {needs_firm}, stream quote-<id>, stream_version 1);
INSERT INTO events (QuoteIssued v2 {kind, price_components...}, stream_version 2, causation = QuoteRequested);
COMMIT;
```

The quote row is the source of truth for its state; the events are the outbox. A firm answer returns `201`. An indicative one returns `202`, `Location: /api/v1/quotes/:id` and `Retry-After: 2`.

### 6. Async firm completion

The completer consumes `QuoteRequested`. For each one:

1. Load the quote. Firm already, or expired or booked: acknowledge and stop (this is what makes redelivery harmless).
2. Call the four dependencies with a 5-second budget each, no hedging.
3. Still unconfirmed: a transient failure. The message stays pending and is retried after 1, 2, 4 and 8 s, and the quote counts `firm_attempts`. On the fifth failure it goes to the dead-letter stream and the quote shows "firm delayed".
4. Confirmed: in one transaction, lock the quote row, re-check that it is still indicative and open, insert `(completer, event_id)` into `processed_events`, update the quote to firm with its new inputs and validity, and append `FirmQuoteCompleted` and `QuoteIssued` (firm). Acknowledge after commit.

The webhook consumer turns `FirmQuoteCompleted` into a delivery row (`UNIQUE event_id`) when the customer asked for a callback. A dispatcher signs and POSTs it to the URL the customer **registered**, never a URL from the request.

### 7. Event-driven invalidation and re-pricing

`TariffPublished` (from the pricing system) is handled by the invalidator:

1. Raise the cache **version floor** for that tariff key to the new version and delete the public tariff entry. Monotonic and idempotent, so it runs first; a retry after a failed transaction still invalidates.
2. In one transaction: record the event in our log (deduplicated by `event_id`), add the version to `tariff_versions`, and move `tariff_current` **only forward** (`WHERE current.version < new.version`).
3. If it moved, re-price every open **indicative** quote on that tariff key whose basis is the public tariff: new linehaul, rescaled capacity premium, shifted band, `revision + 1`, and `QuoteIssued` (reason `repriced_tariff`, causation = the tariff event).

`FuelSurchargeChanged` does the same for the fuel floor and all open indicative quotes. Contract quotes are unaffected by tariffs; firm quotes are untouched.

**Why a version floor and not just a delete.** A pricing call that started before the publication can return the old version after the invalidation and write it back. Every cached value carries its version, and both the read and the write compare it with the floor:

```lua
-- write: refuse a value older than the floor
local floor = redis.call('GET', KEYS[2])
if floor and ARGV[2] < floor then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
```

### 8. Expiry and booking

A sweeper expires open quotes past `valid_until` (`FOR UPDATE SKIP LOCKED`, status guard, `QuoteExpired` with occurred_at = valid_until). Booking re-checks `valid_until` itself, so a late sweeper never makes a quote bookable. Booking a firm quote records the honored total and inputs, and the tariff version current at booking time, in `bookings` plus `QuoteBooked`.

### Worked example: one successful trace (indicative → firm)

1. Pat (portal, contract `CTR-PGC-2026`) requests 30 covered hoppers of wheat, Minneapolis → Portland, ship week of 2026-11-30, with a callback. Key `portal-03336c94…`.
2. The API classifies `portal`, takes a token, admits it (in-flight 1 of 48), and finds no row for the key.
3. Fan-out with a 900 ms deadline: linehaul is a cache hit at contract v3; the fuel surcharge is a cache hit for the current week; car supply answers live in 103 ms; capacity (slowed to 2.5 s) misses its 600 ms budget. The hedge fired at the recent p90 and missed too.
4. The composer finds a capacity snapshot 3 minutes old (policy 30 minutes), prices the premium at 10.5% from it, labels it, and returns an indicative quote: about $177,666, firm expected between $163,428 and $183,768.
5. One transaction writes the quote and `QuoteRequested` + `QuoteIssued`. Response `202` in 603 ms.
6. The relay publishes both events to partition `hash(quote-<id>) % 4`. The completer receives `QuoteRequested`, calls capacity with 5 s, gets 94% utilization in 2.4 s, and commits the firm quote ($177,666), `FirmQuoteCompleted` and `QuoteIssued` (firm). It acks.
7. The webhook consumer inserts one delivery row. The receiver is down for two attempts (500), then accepts the third; it verifies the HMAC and stores the event once.
8. The portal's 1-second poll sees `kind: firm`; the Book button enables.

### Worked example: one failed trace (dependency down past the retry budget)

1. Nina (tariff pricing) asks for 8 centerbeams of lumber, Portland → Los Angeles. Capacity is down (503).
2. The breaker counts the failure; no snapshot exists for that lane. The quote is indicative with "capacity not confirmed, may add up to 15%". `202` in 85 ms.
3. The pricing system publishes tariff v8 for that lane. The invalidator raises the floor, records v8, re-prices the open indicative quote (revision 2, +$840 total), and emits `QuoteIssued` (repriced_tariff).
4. The completer fails five times (backoff 1-8 s); the message goes to `fq:dlq` with `max_deliveries`, and the quote shows "firm delayed".
5. A duplicate delivery of the same v8 event arrives: `processed` → `duplicate`, nothing changes. A late v7 publication arrives: recorded in history, `tariff_current` stays at v8, no re-pricing (`stale`).
6. Capacity recovers. An operator redrives the dead letter into `fq:redrive:completer`, which only the completer group reads. It completes the firm quote at tariff v8 (attempt 6) and the timeline shows the whole chain with causation ids.

### Design Review Checklist

| Question | Answer |
|----------|--------|
| 1. Source of truth; when is a write successful? | The `quotes` row in PostgreSQL. A quote exists when the transaction that inserts it and its `QuoteRequested`/`QuoteIssued` events commits. Everything downstream (firm completion, webhooks, analytics) is derived from those events. |
| 2. Client retries after losing the response? | Same `Idempotency-Key` → the same quote, in its current state (`200`, `Idempotent-Replayed`). A different body under the key → `422`. A booking retry with the same key returns the same booking. |
| 3. A worker fails between two important steps? | The completer commits the firm quote and its events in one transaction, then acks. A crash before the ack redelivers the message; the quote is already firm, so it's a no-op (verified by killing the completer between commit and XACK). The relay may republish events after a crash; every consumer deduplicates by `event_id`. |
| 4. Which ordering is actually required? | Per quote only, and only for the timeline, which reads the log by `stream_version`. Consumers are designed not to need order: the completer reads quote state, the projector's deltas are commutative, tariff "current" only moves forward. Events go to partitions by `hash(stream_id)`, so per-quote order is preserved anyway. |
| 5. Access with caches and async jobs? | Contract prices are cached under the contract id, resolved from the authenticated customer, never from the request. Quotes, timelines and deliveries are filtered by customer (another customer's quote is a 404). Callbacks go only to the customer's registered URL, signed with that customer's secret. |
| 6. What breaks first at 10×, and the evidence? | The capacity service: with 6 workers at 150 ms, 60 re-quoting integrations pushed portal quotes to 13% firm (load test below). Next, the outbox relay's single leader and the completer's dependency budget. Evidence: the load script's numbers and the consumer-lag gauges. |

## Database Schema

Full schema: `backend/src/db/init.sql`. The core tables:

```sql
CREATE TABLE quotes (
  id UUID PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  client_class TEXT NOT NULL CHECK (client_class IN ('portal','api','api_requote')),
  origin TEXT, destination TEXT, commodity TEXT, equipment TEXT,
  quantity INT NOT NULL CHECK (quantity > 0), ship_week DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('firm','indicative')),
  firm_status TEXT NOT NULL CHECK (firm_status IN ('not_needed','pending','completed','delayed')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','expired')),
  revision INT NOT NULL DEFAULT 1,
  total_cents BIGINT NOT NULL, band_low_cents BIGINT NOT NULL, band_high_cents BIGINT NOT NULL,
  inputs JSONB NOT NULL,          -- tariff/contract version, fuel week, snapshot ids, rules version
  components JSONB NOT NULL,      -- per-component source, version, age, latency, staleness
  indicative_snapshot JSONB,      -- the first answer, kept when the quote turns firm
  valid_until TIMESTAMPTZ NOT NULL,
  callback BOOLEAN NOT NULL DEFAULT false,
  correlation_id TEXT NOT NULL,
  firm_attempts INT NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 1, -- optimistic concurrency
  UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX quotes_open_expiry ON quotes (valid_until) WHERE status = 'open';
CREATE INDEX quotes_open_indicative_lane ON quotes (origin, destination, commodity, equipment)
  WHERE status = 'open' AND kind = 'indicative';

-- Append-only event log: the outbox and the integration backbone (a trigger rejects UPDATE/DELETE
-- except stamping published_at).
CREATE TABLE events (
  position BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  type TEXT NOT NULL, version INT NOT NULL,
  stream_id TEXT NOT NULL, stream_version INT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id TEXT NOT NULL, causation_id UUID, producer TEXT NOT NULL,
  payload JSONB NOT NULL, published_at TIMESTAMPTZ,
  CONSTRAINT events_stream_version UNIQUE (stream_id, stream_version)
);
CREATE INDEX events_unpublished ON events (position) WHERE published_at IS NULL;

CREATE TABLE processed_events (consumer TEXT, event_id UUID, processed_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (consumer, event_id));

CREATE TABLE tariff_versions (tariff_id TEXT, version INT, origin TEXT, destination TEXT, commodity TEXT,
  equipment TEXT, rate_per_car_cents BIGINT, effective_at TIMESTAMPTZ, event_id UUID,
  PRIMARY KEY (tariff_id, version));
CREATE TABLE tariff_current (tariff_id TEXT PRIMARY KEY, version INT, rate_per_car_cents BIGINT);

CREATE TABLE bookings (id UUID PRIMARY KEY, quote_id UUID UNIQUE REFERENCES quotes(id),
  customer_id TEXT, idempotency_key TEXT, honored_total_cents BIGINT, honored_inputs JSONB,
  current_tariff_version INT, UNIQUE (customer_id, idempotency_key));

CREATE TABLE webhook_deliveries (id UUID PRIMARY KEY, event_id UUID UNIQUE, quote_id UUID, customer_id TEXT,
  url TEXT, payload JSONB, status TEXT CHECK (status IN ('pending','in_flight','delivered','dead')),
  attempts INT, next_attempt_at TIMESTAMPTZ, locked_until TIMESTAMPTZ, last_status_code INT, last_error TEXT);

-- Analytics projection (bucketed by event time), rebuilt by replay
CREATE TABLE analytics_counters (bucket TIMESTAMPTZ, metric TEXT, dimension TEXT, value BIGINT,
  PRIMARY KEY (bucket, metric, dimension));
CREATE TABLE analytics_latency (dependency TEXT, le_ms INT, count BIGINT, PRIMARY KEY (dependency, le_ms));
CREATE TABLE analytics_sources (dependency TEXT, source TEXT, count BIGINT, PRIMARY KEY (dependency, source));
```

Reconstructing a disputed quote needs three things: `quotes.inputs` (which versions), `tariff_versions` or the contract record (what those versions said), and the pricing `rules_version` (how they were combined). The event log adds when each revision happened and what caused it.

## API Design

```
POST /api/v1/auth/login                     session cookie (portal users, ops, admin)
POST /api/v1/quotes                         Idempotency-Key required; X-Api-Key or session;
                                            optional X-Request-Deadline-Ms
     → 201 firm | 202 indicative (+ Location, Retry-After) | 200 replay
     → 422 key reused / bad lane | 429 rate limited | 503 SHED | 503 PRICING_UNAVAILABLE
GET  /api/v1/quotes                         own quotes (customers) or all (ops)
GET  /api/v1/quotes/:id                     poll target; 404 for another customer's quote
GET  /api/v1/quotes/:id/events              the quote's stream + causes + webhook deliveries
POST /api/v1/quotes/:id/book                Idempotency-Key; 409 NOT_FIRM / QUOTE_EXPIRED / ALREADY_BOOKED

GET  /api/v1/ops/overview                   merged per-instance stats, settings, knobs, dependency stats
PUT  /api/v1/ops/settings                   deadline, budgets, hedging, coalescing, shedding, rate limits
PUT  /api/v1/ops/knobs/:dep                 mock dependency latency, tail, errors, hangs, workers, down
POST /api/v1/ops/pricing/tariffs            (admin) publish a tariff version → TariffPublished
POST /api/v1/ops/pricing/fuel               (admin) publish a surcharge → FuelSurchargeChanged
GET  /api/v1/events                         event log (filters: type, stream, correlation, older versions)
GET  /api/v1/streams                        consumer lag/pending, outbox backlog, DLQ depth, staleness
GET  /api/v1/streams/dlq                    dead letters; POST …/:id/redrive, …/:id/discard
POST /api/v1/streams/projections/analytics/verify | rebuild
GET  /api/v1/analytics                      volume, conversion, dependency latency (from the projection)
```

A `202` response body:

```json
{
  "quote": { "id": "d66f2850-…", "kind": "indicative", "firmStatus": "pending", "totalCents": 17766600,
             "band": { "lowCents": 16342800, "highCents": 18376800 }, "validUntil": "…+15 min",
             "components": [{ "component": "capacity_premium", "source": "cache", "ageSeconds": 180,
                              "staleness": "Capacity service did not answer within its budget; using a snapshot 3 min old (policy max 30 min)" }] },
  "firm": { "status": "pending", "poll": "/api/v1/quotes/d66f2850-…", "callback": true, "unconfirmed": ["capacity"] }
}
```

The webhook: `POST <registered url>` with `X-FQ-Event-Id`, `X-FQ-Delivery-Attempt` and `X-FQ-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.

## Key Design Decisions

### 1. An indicative answer now beats a firm answer late

When capacity's p99 jumps to 8 seconds, the alternatives are to wait (the portal spins, integrations time out and retry, threads pile up), to fail fast (the customer gets nothing), or to answer with what is known and say what isn't. Quoting is a negotiation, not a transaction: an estimate with a stated band and a firm price seconds later is useful; a timeout isn't. The rule that keeps this honest is that *firm* has a precise meaning (every input live or at its current published version) and an indicative quote can't be booked. What it costs: a second write path (the completer), the `202` contract for clients, and a band that has to be right about the worst case.

### 2. Deadlines, budgets and hedging; no retries inside the request

A retry inside a 900 ms request either doesn't fit or doubles load exactly when the dependency is slowest; with three layers each retrying three times, one user request becomes 27 calls. Instead each dependency gets a budget within one deadline that is propagated (`X-Deadline`), so the dependency stops abandoned work. The one slow-tail dependency gets a **hedge**: a second request after the 90th percentile, capped at 15% of calls by a token bucket. Hedging helps only when slowness is per request (a slow replica, a GC pause); when the whole service is slow it can't help, which is why it's budgeted and disabled while the breaker is half-open. Measured: p99 1,606 ms → 200 ms for 7% more capacity calls. Retries live in the async completer, with backoff, where a few seconds don't matter.

### 3. Versioned cache entries with event-driven floors, not TTLs

A TTL answers "how long might this be wrong?", which is the wrong question for a published price. A tariff is valid until a newer version is published, so a cached tariff at the current version is exactly as correct as a live call, and a firm quote may use it. `TariffPublished` raises a per-key version floor; reads and writes compare against it, which also closes the race where a slow in-flight call writes an old version back after invalidation. Perishable inputs (capacity, car supply) are different: they're cached only as labeled last-known snapshots for indicative quotes, bounded by the staleness policy. What it costs: every cached value carries a comparable version, and invalidation depends on the event pipeline (its lag is monitored; firm quotes record the version they used, so a lagging invalidation can't produce an unexplainable price).

### 4. Cache keys by pricing basis, resolved on the server

The linehaul key is `contract:<contract_id>:<lane>:<commodity>:<equipment>` or `tariff:<lane>:<commodity>:<equipment>`. The contract id comes from the authenticated customer's contract table, never from the request. Keying by customer id would also be safe but would cut the tariff hit rate by the number of customers; keying by lane alone leaks contract prices. The same rule applies to the single-flight key: coalescing two customers' identical pricing calls is only safe when both are on the public tariff.

### 5. State plus outbox, not event sourcing

The quote is a small aggregate whose current state is read on every poll, booking and re-pricing. Event sourcing would make every read a fold (or a snapshot store to maintain) and every schema change a migration of history. With state plus outbox, the row is the source of truth, the event log is written in the same transaction, and the log is still complete enough for analytics replay and dispute timelines. What it costs: two representations to keep consistent (the single transaction does it), and the log is not the system of record for quote state.

### 6. Choreography for the async side

Nothing in the async side is a multi-step business transaction that needs compensation: the completer, webhook dispatcher, invalidator and projector each react to events independently, and each is idempotent on its own. An orchestrator would add a central state machine with no decisions to make. Where orchestration would earn its place is **booking**: reserving car supply, a capacity slot and a waybill is a saga with compensation (release the car order if the slot fails). That's out of scope here, and the design would add a booking process manager rather than more choreography.

### 7. Consumers that don't need ordering

Valkey consumer groups (and Kafka with more consumers than partitions per key) don't give a consumer per-key ordering for free. Instead of building it, every consumer is order-insensitive by construction: the completer decides from the quote row, the projector applies commutative increments bucketed by event time, and `tariff_current` moves only forward. Partitioning by `hash(stream_id)` still keeps a quote's events in order for anyone who wants it. What it costs: each consumer's logic must be checked for commutativity; the analytics replay test does exactly that by applying events shuffled and duplicated.

### 8. Shed by client class at the instance, limit per customer at the edge

The portal is a person waiting; an integration re-quote is a machine that will ask again in a minute. When the instance is saturated, refusing the re-quote first protects the person. Load shedding alone isn't enough, though: a client with no backoff turns cheap `503`s into a tight loop (25,809 requests in 12 s in the storm test). Per-customer rate limits with `Retry-After` cut the loop at the door, and the API contract says clients must honor it.

## Consistency and Idempotency

| Operation | Mechanism | Duplicate outcome |
|-----------|-----------|-------------------|
| `POST /quotes` | `UNIQUE (customer_id, idempotency_key)` + request hash + single-flight on the key | Same quote (`200`, replayed); different body `422` |
| `POST /quotes/:id/book` | `UNIQUE (customer_id, idempotency_key)` on bookings, quote row lock | Same booking |
| Outbox relay | Advisory-lock leader, publish then stamp `published_at` | Republish after a crash; consumers dedupe |
| Firm completion | Quote state re-checked under `FOR UPDATE` + `processed_events (completer, event_id)` | `already_firm`, no new events |
| Webhook enqueue | `webhook_deliveries.event_id UNIQUE` | No second row |
| Webhook delivery | At least once; receiver dedupes by `X-FQ-Event-Id` | Receiver acknowledges, acts once |
| Invalidator | `events.event_id UNIQUE` (recorded in our log) + monotonic floors and `tariff_current` | `duplicate` or `stale`, no re-pricing |
| Projector | `processed_events (analytics, event_id)` in the same transaction as the increments | No change |
| Quote updates (completer, re-pricing, booking) | Row lock + status/kind guards in the `UPDATE` | The later writer sees the new state |

Exactly-once *effects* come from at-least-once delivery plus these idempotency records.

## Security / Auth

- Portal users: session in Redis, httpOnly cookie. Integrations: API keys stored as SHA-256 hashes. Roles: `customer` (own quotes only), `ops`, `admin` (publishes pricing, rebuilds projections).
- A quote, its timeline and its deliveries are visible to its customer and to staff. Another customer's quote returns `404`, so ids can't be probed.
- Contract prices never cross customers (cache and single-flight keys by contract id, resolved server-side).
- Webhooks: only to the registered URL (no SSRF through quote requests), HMAC-signed with a per-customer secret over timestamp + body, 5-minute replay window, dedupe by event id.
- Request logs never include headers (session cookies and API keys).
- Rate limits per customer, overridable by contract.

## Observability

| Signal | Metric / view |
|--------|---------------|
| Quote latency by class and outcome | `fq_quote_duration_seconds{client_class,outcome}` |
| Dependency latency and outcomes | `fq_dependency_call_duration_seconds{dependency,outcome,caller}`; ops page p50/p95/p99 |
| Breaker state | `fq_circuit_state{dependency,caller}`; `DependencyCircuitOpened/Closed` events |
| Cache | `fq_component_cache_lookups_total{dependency,result}` (hit, miss, stale_version) |
| Hedging / coalescing | `fq_hedges_total{result}`, `fq_coalesced_total` |
| Shedding | `fq_shed_total{client_class,reason}` |
| Outbox backlog | `fq_outbox_unpublished` |
| Consumer lag and pending | `fq_consumer_lag{group}`, `fq_consumer_pending{group}` (XINFO GROUPS) |
| DLQ depth | `fq_dlq_depth`, `fq_dead_lettered_total{group,reason}` |
| Projection staleness | `fq_projection_staleness_seconds{projection}` |
| Events/sec | streams page (events recorded in the last minute) |
| Webhooks | `fq_webhook_deliveries_total{result}` |

Alerts worth paging on: indicative share above 20% for 10 minutes (a dependency is degraded), DLQ depth > 0 for `completer` (a firm quote is stuck), outbox backlog older than 30 s, and invalidator lag above 60 s (stale tariffs being served from cache would be impossible, but firm completions use the old version until it catches up).

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Capacity slow (p99 8 s) | Hedge after p90; budget 600 ms; indicative from snapshot; async firm in seconds |
| Capacity down | Breaker opens after 50% errors in 10 s (≥ 10 calls); indicative instantly; completer retries then DLQ; redrive after recovery |
| Pricing down, cache warm | Current-version cached linehaul; firm still possible |
| Pricing down, cache cold | `503 PRICING_UNAVAILABLE` with `Retry-After`; no quote |
| Fuel service down | Current cached surcharge (firm) or last week's (indicative, ±10%) |
| Retry storm from an integration | Shed `api_requote` first; per-customer `429`; portal unaffected |
| Completer crash mid-message | Message stays pending; reclaimed after backoff; idempotent |
| Poison message | Permanent error → DLQ on first delivery, only in groups that handle the type |
| Relay crash after XADD | Republished; consumers dedupe |
| Webhook receiver down | Retries with exponential backoff and jitter up to 8 attempts, then `dead`; operator retry |
| Redis down | Settings fall back to defaults; cache misses go live; rate limiting and sessions fail (the gateway's limiter is the backstop in production) |
| Late or duplicated pricing event | Duplicate: no-op. Older version: recorded, not applied |

## Scalability Considerations

- **Quote API**: stateless; scale horizontally. Shedding and breakers are per instance, so `maxInflight` is per-instance capacity.
- **Single-flight across instances**: in-process coalescing collapses duplicates per instance; with N instances the dependency sees up to N calls per key. At larger scale, route by a consistent hash of the pricing key (sticky load balancing) or add a short distributed lock with result sharing in Redis.
- **Capacity service**: what breaks first. Mitigations in order: snapshot cache with a staleness policy, coalescing, re-quote shedding, and pushing capacity changes as events (a lane's utilization changes a few times an hour) so the quote path stops calling it at all.
- **Cache**: Redis cluster sharded by key; versioned tariff entries are tiny and hot.
- **PostgreSQL**: quotes partitioned by month (most reads are recent); the event log moves to Kafka via CDC (Debezium) once the outbox relay becomes the bottleneck; read replicas for quote polling.
- **Events**: `quote.events` with 32-64 partitions keyed by quote id; the completer scales with partitions; the projection moves to ClickHouse.

### Kafka mapping (local Valkey Streams → production)

| Local | Production | Notes |
|-------|------------|-------|
| `events` table + relay | Outbox table + Debezium CDC | Same transactional guarantee |
| `fq:events:p0..p3` (hash of stream_id) | Topic `quote.events`, 32-64 partitions, key = quote id; retention 7 days + S3 archive | Per-quote order |
| `fq:ext:pricing` | Topics `pricing.tariffs` (compacted, key = tariff id) and `pricing.fuel` (compacted) | Compaction keeps the latest version per key; a new consumer can rebuild current tariffs |
| Breaker events in the log | Topic `ops.dependency` | Short retention |
| Consumer groups `completer`, `webhooks`, `projector`, `invalidator` | Same consumer groups | Offsets replace XACK |
| XPENDING + XCLAIM with backoff | Retry topics (`quote.events.completer.retry.1s/4s/…`) or a delay queue | Kafka has no per-message redelivery |
| `fq:redrive:<group>` | Per-group retry/redrive topic | Redrive never replays to other groups |
| `fq:dlq` | Per-group DLQ topic with headers (reason, attempts) | |
| `processed_events` | Same table, or a compacted dedupe store | Exactly-once effects |

### Load test results (local, one API instance)

Measured with `npm run load` (one run on a shared development machine; your numbers will differ):

| Scenario | Off | On |
|----------|-----|----|
| Hedging (capacity: 80 ms median, 5% at 1.5 s), 600 quotes | p50 109 · p95 147 · **p99 1,606 ms**, 1.00 capacity calls/quote | p50 107 · p95 180 · **p99 200 ms**, 1.07 calls/quote |
| Coalescing (10 bursts × 40 identical requests; capacity 4 workers × 200 ms) | p50 658 · p99 733 ms, **10% firm**, 187 capacity calls (the breaker opened) | p50 259 · p99 290 ms, **100% firm**, 37 capacity calls |

Retry storm (60 integration workers re-quoting with no backoff; 2 portal users; capacity 6 workers × 150 ms; 12 s each):

| Protection | Portal p50 | Portal p99 | Portal firm | Storm requests | Shed (503) | 429 | Capacity calls |
|------------|-----------|-----------|-------------|----------------|-----------|-----|----------------|
| None | 607 ms | 626 ms | 13% | 1,217 | 0 | 0 | 724 |
| Shedding | 270 ms | 393 ms | 63% | 25,809 | 25,296 | 0 | 356 |
| Shedding + rate limits | 229 ms | 420 ms | 100% | 31,392 | 45 | 31,262 | 214 |

The storm rows show both halves of the argument: shedding protects the portal's latency, but a client that ignores `Retry-After` turns cheap rejections into twenty times the request rate; the per-customer limit is what gives the capacity service its headroom back.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Slow dependency | Indicative now, firm async | Wait or fail | Bounded latency with an honest label |
| Slow-tail mitigation | Budgeted hedging | In-request retries | Cuts p99 without multiplying load |
| Deadline | Propagated absolute deadline | Per-hop timeouts only | Dependencies stop abandoned work |
| Tariff cache freshness | Version floors from events | TTL | Correct, not merely recent |
| Contract cache key | Contract id (server-resolved) | Customer id / lane only | Shares tariffs, never leaks contracts |
| Event log role | State + outbox | Event sourcing | Simple reads; log still replayable |
| Async coordination | Choreography | Orchestrator | No multi-step transaction to compensate |
| Ordering | Order-insensitive consumers | Per-key ordered consumption | Parallelism without ordering bugs |
| Overload | Shed by class + per-customer limits | Global limit | Protects people first |
| Retries | Async completer with backoff + DLQ | Retry inside the request | Time is cheap off the critical path |
| Breaker scope | Per dependency, per instance | Global breaker | No coordination; fast local decisions |

## Implementation Notes

### Local architecture

| Process | Default port | Entry | Role |
|---------|--------------|-------|------|
| Quote API | 3000 (3001, 3002) | `backend/src/api/index.ts` | HTTP, breakers, fan-out, outbox relay (leader lock), ops snapshots |
| Mock dependencies | 3010 | `backend/src/deps/index.ts` | Four routes with knobs; pricing admin emits `TariffPublished` / `FuelSurchargeChanged` |
| Completer | 3011 (metrics) | `backend/src/completer/index.ts` | Groups `completer`, `webhooks`, `invalidator`; expiry sweeper; webhook dispatcher |
| Projector | 3012 (metrics) | `backend/src/projector/index.ts` | Group `projector`; analytics tables |
| Webhook receiver | 3020 | `backend/src/receiver/index.ts` | The customer's side: verifies signatures, dedupes, can fail on demand |
| Frontend | 5173 | `frontend/` | Portal, quote timeline, ops, event log, streams/DLQ, analytics |

### Production-grade patterns actually implemented

- **Deadline-bounded fan-out with propagation** (`shared/fanout.ts`, `shared/dependency-client.ts`): one absolute deadline, per-dependency budgets, `AbortSignal` cancellation and `X-Deadline`. The mock dependencies stop at the deadline and count abandoned versus wasted work.
- **Hedged requests with a budget** (`shared/resilience.ts`): delay from the dependency's recent p90, a 15% token bucket, no hedge while half-open.
- **Circuit breakers** (opossum, `shared/breakers.ts`): per dependency and process; 422 business answers don't count; transitions recorded as events.
- **Single-flight** outside the breaker, so fifty identical requests are one call and one breaker outcome.
- **Versioned component cache with floors** (`shared/component-cache.ts`): Lua compare on write, floor check on read.
- **Firm/indicative composer** (`shared/compose.ts`): pure and unit-tested.
- **Admission control and per-customer token buckets** (`api/services/admission.ts`, `shared/rate-limit.ts`).
- **Transactional outbox and relay** (`shared/event-store.ts`, `shared/relay.ts`): per-stream versions with a unique constraint, an append-only trigger, an advisory-lock leader.
- **Consumer groups with ack after commit, exponential redelivery through XPENDING/XCLAIM, heartbeats, DLQ and per-group redrive** (`shared/consumer.ts`, `shared/stream.ts`).
- **Idempotent consumers** (`processed_events`, state guards) and **replay** (`projector/rebuild.ts`, `npm run replay -- analytics`).
- **Schema evolution**: `QuoteIssued` v1 → v2 with an upcaster (`shared/events.ts`).
- **Signed webhooks with retries** (`completer/webhooks.ts`, `shared/signing.ts`).
- **Prometheus metrics** (`shared/metrics.ts`) and structured logs (pino) without headers.

A short look at the shape of the core:

```typescript
// shared/fanout.ts (abridged): coalesce outside the breaker, hedge inside it
const flight = singleFlight.do(coalesceKey(dep, input), () =>
  breakers.fire(dep, () => hedgedCall(dep, input, deadlineAt)))
const value = await raceDeadline(flight.promise, deadlineAt, dep) // a follower keeps its own deadline
```

### Simplified or substituted

- **Valkey Streams instead of Kafka**, with four partition streams; consumer groups deliver to any consumer, which is why consumers are order-insensitive.
- **One PostgreSQL** for quotes, the log and analytics (ClickHouse in production).
- **Mock dependencies in one process**, with deterministic answers per 5-minute bucket and in-memory state persisted to Valkey.
- **In-process single-flight and per-instance breakers and shedding**; no cross-instance coordination.
- **The pricing system writes straight to a stream** (it has no outbox of its own here).
- **Contracts are reference data** in both the quote service and the mock pricing system; there are no contract-amendment events.
- **Session auth and dev API keys**; production would use the gateway's OAuth client credentials for integrations.

### Omitted

CDN, multi-region, Kubernetes, CDC (Debezium), the booking saga, a real capacity model, contract management, billing, cross-instance coalescing.
