# Freight Quote Service - Event Catalog

Every domain event is a first-class record: a past-tense name, a versioned zod schema (`backend/src/shared/events.ts`) and an envelope. The PostgreSQL `events` table is the **transactional outbox and the integration backbone**: a state change (the `quotes` row) and its events commit in one transaction, and the relay then publishes them to Valkey Streams. The `quotes` table, not the log, is the source of truth for a quote's current state (state plus outbox, not event sourcing). The log is complete enough to replay the analytics projection from position 0 and to show a quote's timeline for a dispute.

## Flow

```
 producers                      log / streams                               consumers (groups)
 ─────────                      ─────────────                               ──────────────────
 Quote API ──┐  one tx with    ┌──────────────────┐  relay (leader)   ┌──────────────────────┐
 completer ──┼─ the state ────▶│ events (PG)      │─────────────────▶ │ fq:events:p0..p3      │
 invalidator─┤  change         │ append-only      │  hash(stream_id)  │ (partitions)          │
 expiry ─────┘                 └──────────────────┘                   └──┬────────┬────────┬──┘
                                        ▲                                │        │        │
                                        │ recorded (dedup by event_id)   ▼        ▼        ▼
 Pricing system ──▶ fq:ext:pricing ──▶ invalidator              completer  webhooks  projector
 (TariffPublished,                     (cache floors, re-price)  (firm)    (signed   (analytics)
  FuelSurchargeChanged)                                                     callback)
                                                 every group: fq:redrive:<group> ──▶ itself
                                                 poison / exhausted retries ──▶ fq:dlq
```

## Envelope

| Field | Meaning |
|-------|---------|
| `event_id` | UUID; the idempotency key for every consumer |
| `type` | Past-tense name, also carried as a stream field so groups can skip types they don't handle |
| `version` | Schema version the payload was written in |
| `occurred_at` | Event time: when it happened in the domain (a quote's `valid_until` for QuoteExpired) |
| `recorded_at` | Processing time: when it was written to our log |
| `stream_id` | Aggregate key: `quote-<id>`, `tariff-<O>-<D>-<commodity>-<equipment>`, `fuel-surcharge`, `dependency-<name>` |
| `stream_version` | Gapless per stream; `UNIQUE (stream_id, stream_version)` is the optimistic-concurrency check |
| `correlation_id` | The originating request (`X-Correlation-Id` or generated); shared by every event of a quote |
| `causation_id` | The event that caused this one (QuoteIssued ← QuoteRequested; repriced QuoteIssued ← TariffPublished) |
| `producer` | `quote-api`, `firm-completer`, `invalidator`, `expiry-sweeper`, `pricing-system` |
| `position` | Global order in the PostgreSQL log (not part of the published envelope's contract) |

## Streams and consumer groups

| Stream (local) | Kafka equivalent | Key | Groups | Retention |
|----------------|------------------|-----|--------|-----------|
| `fq:events:p0..p3` | `quote.events`, 32-64 partitions | `hash(stream_id)` | `completer`, `webhooks`, `projector` | ~200k entries (MAXLEN); production 7 days + archive. The PG log keeps everything |
| `fq:ext:pricing` | `pricing.tariffs`, `pricing.fuel` (compacted) | tariff id / schedule | `invalidator` | Compaction keeps the latest per key |
| `fq:redrive:<group>` | per-group retry topic | - | that group only | Until consumed |
| `fq:dlq` | per-group DLQ topic | - | operators (redrive, discard) | Until handled |

## Events

### QuoteRequested

| | |
|-|-|
| **Producer** | Quote API, in the transaction that inserts the quote |
| **Consumers** | `completer` (acts when `needs_firm`), `projector` (volume by client class) |
| **Key** | `quote-<quote_id>` |
| **Versions** | v1 |

| Field | Type | Notes |
|-------|------|-------|
| `quote_id` | uuid | |
| `customer_id` | string | From authentication, never the body |
| `client_class` | `portal` · `api` · `api_requote` | Drives shedding; analytics dimension |
| `origin`, `destination`, `commodity`, `equipment` | string | |
| `quantity` | int | |
| `ship_week` | date | |
| `idempotency_key` | string | |
| `deadline_ms` | int | Effective deadline (server, or a shorter client deadline) |
| `needs_firm` | boolean | False when the synchronous path already issued a firm quote |

### QuoteIssued

| | |
|-|-|
| **Producer** | Quote API (initial), completer (firm_completed), invalidator (repriced_tariff, repriced_fuel) |
| **Consumers** | `projector` (issued by kind, re-pricing, dependency latency, source mix) |
| **Key** | `quote-<quote_id>` |
| **Versions** | v1 (pre-migration), **v2** (current) |

| Field | v1 | v2 | Notes |
|-------|----|----|-------|
| `quote_id`, `customer_id` | ✓ | ✓ | |
| `kind` | ✓ | ✓ | `firm` · `indicative` |
| `revision` | ✓ | ✓ | 1 = initial; +1 per firm completion or re-pricing |
| `total_cents`, `currency`, `valid_until` | ✓ | ✓ | |
| `tariff_version` | ✓ | ✓ | `v7`; null for contract pricing |
| `surcharge_date` | ✓ | ✓ | Fuel surcharge week |
| `reason` | | ✓ | `initial` · `firm_completed` · `repriced_tariff` · `repriced_fuel` (upcast: `unknown`) |
| `client_class` | | ✓ | Null when upcast |
| `latency_ms` | | ✓ | End-to-end latency of the initial answer; null otherwise |
| `price_components[]` | | ✓ | Per component: `component`, `dependency`, `source` (live · cache · fallback; upcast: unknown), `version`, `as_of`, `age_seconds`, `latency_ms`, `amount_cents_per_car` |

**Schema evolution.** v2 added price provenance so analytics can measure latency per dependency and how often each component was cached or unconfirmed. Writers emit only v2. Readers call `parseEvent`, which validates the stored version and runs the **upcaster** v1 → v2: `reason: unknown`, `client_class: null`, `latency_ms: null`, and a synthesized `price_components` list (linehaul and fuel only, from the flat version fields, `source: unknown`, null latencies). The projector counts upcast events but takes no latency from them, and treats `reason: unknown` with `revision: 1` as the initial issue, so a v1 firm completion isn't counted twice. Rollout order: deploy readers that understand v2 (and upcast v1) first, then the writers. The v1 rows stay in the log forever; nothing is rewritten. The seed writes three days of history, of which events older than 30 hours are v1, so every replay exercises the upcaster.

### FirmQuoteCompleted

| | |
|-|-|
| **Producer** | Completer, in the transaction that makes the quote firm |
| **Consumers** | `webhooks` (signed callback when requested), `projector` (completions, request-to-firm latency) |
| **Key** | `quote-<quote_id>` |
| **Versions** | v1 |

| Field | Type | Notes |
|-------|------|-------|
| `quote_id`, `customer_id` | | |
| `total_cents` | int | The firm price |
| `indicative_total_cents` | int | What the customer was first shown |
| `valid_until` | timestamp | Firm validity |
| `tariff_version`, `surcharge_date` | | Inputs the firm price is pinned to |
| `attempts` | int | Deliveries it took, counted across a DLQ redrive |
| `completion_ms` | int | Event time from QuoteRequested to firm |

### QuoteExpired

| | |
|-|-|
| **Producer** | Expiry sweeper (completer process) |
| **Consumers** | `projector` |
| **Key** | `quote-<quote_id>` |
| **Versions** | v1 |

Fields: `quote_id`, `customer_id`, `kind`, `valid_until`. `occurred_at` is `valid_until` (when it expired in the domain), `recorded_at` is when the sweeper noticed, so analytics bucket it in the right hour even when the sweeper runs late.

### QuoteBooked

| | |
|-|-|
| **Producer** | Quote API, in the booking transaction |
| **Consumers** | `projector` (conversion) |
| **Key** | `quote-<quote_id>` |
| **Versions** | v1 |

Fields: `quote_id`, `booking_id`, `customer_id`, `kind` (always firm), `honored_total_cents`, `honored_tariff_version` (the version the quote is pinned to), `current_tariff_version` (what is current at booking). When they differ, the booking still honors the quote: a firm quote is a commitment until it expires.

### TariffPublished

| | |
|-|-|
| **Producer** | Pricing system (the mock dependency's admin route), to `fq:ext:pricing` |
| **Consumers** | `invalidator` (records it in our log, raises the cache floor, moves `tariff_current` forward, re-prices open indicative quotes); `projector` (count, via our log) |
| **Key** | `tariff-<origin>-<destination>-<commodity>-<equipment>` (Kafka: compacted by tariff id) |
| **Versions** | v1 |

| Field | Type | Notes |
|-------|------|-------|
| `tariff_id` | string | e.g. `TRF-PDXLAX-LUMBER-CB` |
| `origin`, `destination`, `commodity`, `equipment` | string | |
| `version` | int | Monotonic per tariff id |
| `rate_per_car_cents` | int | |
| `effective_at` | timestamp | |

**Ordering and late delivery.** Two publications of one tariff can arrive out of order (a retried or replayed publication). The invalidator doesn't rely on stream order: the cache floor and `tariff_current` only move forward, so a late v7 after v8 is recorded in history and changes nothing (`stale`). A redelivered v8 is a `duplicate` (its `event_id` is already in our log).

### FuelSurchargeChanged

| | |
|-|-|
| **Producer** | Pricing system, to `fq:ext:pricing` |
| **Consumers** | `invalidator` (fuel floor, `fuel_surcharges` history, re-price open indicative quotes); `projector` |
| **Key** | `fuel-surcharge` |
| **Versions** | v1 |

Fields: `effective_date` (week), `published_at` (orders two publications for the same week, i.e. a correction), `cents_per_mile`, `previous_cents_per_mile`. "Current" is the latest `(effective_date, published_at)`; the cache floor uses the same pair.

### DependencyCircuitOpened / DependencyCircuitClosed

| | |
|-|-|
| **Producer** | The breaker of an API instance or completer (in-memory state; the event is an observation written to the outbox on its own) |
| **Consumers** | `projector` (counts per dependency); ops timeline |
| **Key** | `dependency-<name>` |
| **Versions** | v1 |

Opened: `dependency`, `instance_id`, `reason`. Closed: `dependency`, `instance_id`, `open_ms`. Half-open is logged, not emitted. A breaker is per process, so two instances may disagree for a few seconds; the event says which one.

## Consumer behavior

| Group | Handles | Idempotency | On failure | Order needed? |
|-------|---------|-------------|------------|---------------|
| `completer` | QuoteRequested | Quote state under row lock + `processed_events (completer, event_id)` | Transient (dependency still down): retry after 1, 2, 4, 8 s, then DLQ (quote shows "firm delayed"). Permanent (unknown schema, missing quote): DLQ at once | No: decides from the quote row |
| `webhooks` | FirmQuoteCompleted | `webhook_deliveries.event_id UNIQUE`; receivers dedupe by `X-FQ-Event-Id` | Delivery retries with backoff and jitter, up to 8 attempts, then `dead` (operator retry) | No |
| `invalidator` | TariffPublished, FuelSurchargeChanged | `events.event_id UNIQUE` when recording; floors and current versions monotonic | Retry, then DLQ | No: monotonic guards |
| `projector` | All types | `processed_events (analytics, event_id)` in the same transaction | Retry, then DLQ | No: commutative increments by event time |

All groups acknowledge only after their transaction commits, and use a heartbeat (`XCLAIM … JUSTID`) so a slow handler isn't mistaken for a dead one. A dead consumer's pending messages are claimed by the others once idle past the backoff.

## Replay

`npm run replay -- analytics` rebuilds the projection from position 0: it locks the projection tables, folds every event (upcasting v1) through the same `deltasFor` function the live projector uses, swaps the result in with the matching `processed_events` rows, and verifies. `--verify` re-folds only the events the live projector has applied and diffs them with the live tables (events still in flight are reported as lag, not as a mismatch). The streams page has the same two buttons.
