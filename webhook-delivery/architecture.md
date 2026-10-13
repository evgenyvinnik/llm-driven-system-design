# Webhook Delivery - Architecture Design

## System Overview

A multi-tenant platform that turns internal domain events ("a batch job finished", "a fine-tuning job failed", "an invoice was paid") into signed HTTP POSTs to endpoints that customers register, and keeps trying until each customer's server acknowledges them. Producer services hand events over through a transactional outbox. The platform fans each event out to every endpoint subscribed to its type, delivers at least once with exponential backoff and jitter, and isolates endpoints from one another so that one slow or broken receiver cannot delay anyone else. Customers get a dashboard to configure endpoints, rotate signing secrets, send test events, inspect every attempt, and replay what failed.

The hard part is not sending an HTTP request. It is that the receivers are a million servers we do not control: some answer in 50 ms, some hang for the full timeout, some return 500 for three days, and a few point at our own internal network. Delivery has to stay correct (nothing acknowledged is lost) and fair (nobody waits behind someone else's outage) under that mix.

**Learning goals:**

- At-least-once delivery across a multi-hop pipeline, and why exactly-once to an external HTTP endpoint is impossible
- Head-of-line blocking: per-endpoint lanes and concurrency limits on top of a partitioned log
- A hybrid queue: a Kafka hot path for first attempts plus a durable retry store for the failing 5%
- HMAC signing, timestamp-based replay protection, and secret rotation without downtime
- What ordering guarantee to promise (by default, none) and what an opt-in ordered mode costs
- Endpoint health tracking, per-endpoint circuit breakers, and auto-disable
- The transactional outbox as the only safe handoff from a producer's database

## Requirements

### Functional Requirements

1. **Event publishing**: internal producer services publish events through a transactional outbox; external or legacy producers can call an ingest API with an idempotency key
2. **Endpoint management**: tenants register HTTPS endpoints, choose event types (explicit list or wildcard such as `batch.*`), set a rate limit, and enable or disable them
3. **Fan-out**: each event is delivered to every enabled endpoint of its tenant that subscribes to its type
4. **At-least-once delivery**: retry non-2xx responses, timeouts, and connection errors on an exponential schedule with jitter for about 2.6 days
5. **Signing**: every request carries an id, a timestamp, and an HMAC-SHA256 signature over both plus the raw body
6. **Isolation**: per-endpoint concurrency and rate limits; a failing endpoint is circuit-broken and its traffic parked
7. **Dead letters and replay**: exhausted deliveries become dead letters; customers replay one delivery or bulk-recover a time range
8. **Health and auto-disable**: track per-endpoint success rate and latency; notify on sustained failure and auto-disable after 72 hours with no success
9. **Delivery log**: every attempt (request, response status, latency, error class, first 1 KB of response body) is searchable for 30 days
10. **Test events and secret rotation**: send a sample event on demand; rotate a secret with an overlap window during which both signatures are sent
11. **Admin**: operators see backlog, auto-disabled endpoints, top failing endpoints, and can throttle or pause an endpoint

### Non-Functional Requirements

| Property | Target | Notes |
|----------|--------|-------|
| Durability | Zero loss of acknowledged events | Kafka `acks=all`, replication factor 3, `min.insync.replicas=2`; outbox rows committed with business data |
| First-attempt latency | p50 < 1 s, p99 < 5 s from producer commit to first HTTP attempt | For healthy endpoints with no backlog |
| Isolation | A failing or slow endpoint raises other endpoints' p99 first-attempt latency by < 10% | The core requirement |
| Ingest API latency | p99 < 50 ms | Validates, dedupes, writes to Kafka |
| Availability | Ingest 99.99%, delivery pipeline 99.95%, dashboard 99.9% | Ingest must outlive delivery problems |
| Log freshness | An attempt appears in the dashboard within 5 s (p99) | Kafka to ClickHouse micro-batches |
| Retention | Payloads and attempts kept 30 days | Bounds replay and the log |

### Out of Scope

- Consuming webhooks from third parties (this system only sends)
- Transformations or customer-supplied code that rewrites payloads
- Non-HTTP transports (SQS, Pub/Sub, email); designed as future "sink" types
- Exactly-once delivery, which no HTTP sender can promise (see Consistency and Idempotency)

## Capacity Estimation

### Assumptions

| Assumption | Value |
|------------|-------|
| Tenants with webhooks configured | 500K |
| Endpoints | 1M (about 2 per tenant) |
| Subscriptions | 5M (about 5 event types per endpoint) |
| Events produced | 1B per day |
| Average fan-out | 2 endpoints per event |
| Average payload | 2 KB (max 256 KB) |
| First-attempt failure rate | 5% of deliveries |
| Retries per failing delivery | 4 on average (most recover in 1–2, a tail runs the full schedule) |
| Dead-lettered | 0.5% of deliveries use the whole schedule |
| Peak-to-average ratio | 3× |
| Attempt timeout | 15 s total (3 s connect) |
| Largest tenant | 10M deliveries per day |

### Traffic

| Quantity | Per day | Average | Peak (3×) |
|----------|---------|---------|-----------|
| Events | 1B | ~11.6K/s | ~35K/s |
| Deliveries (events × fan-out 2) | 2B | ~23K/s | ~69K/s |
| Retries (2B × 5% × 4) | 400M | ~4.6K/s | ~13.9K/s |
| HTTP attempts (deliveries + retries) | 2.4B | ~27.8K/s | ~83K/s |
| Ingest bandwidth (events × 2 KB) | 2 TB | ~23 MB/s | ~69 MB/s |
| Egress payload bandwidth (attempts × 2 KB) | 4.8 TB | ~56 MB/s (~0.44 Gbps) | ~167 MB/s (~1.3 Gbps) |

Bandwidth is not the constraint: 1.3 Gbps of payload at peak is a small fraction of one 10 Gbps NIC per egress node. Concurrency is.

### Concurrency (Little's Law)

In-flight requests = arrival rate × time in system. At the ~83K attempts/s peak, assume 99% of attempts finish in 200 ms on average and 1% hang until the 15 s timeout:

```
fast:  82,500/s × 0.2 s  = 16,500 in flight
slow:     833/s × 15 s   = 12,500 in flight
total                    ≈ 29,000 in flight
```

The 1% of slow traffic holds 43% of all sockets. This is head-of-line blocking expressed as arithmetic, and it is why per-endpoint concurrency caps exist: a slow endpoint should consume its own cap, not the fleet's sockets. At 1,000 in-flight requests per dispatcher process, peak needs ~29 processes. We run 64 (four of the 256 delivery partitions each) for headroom and zone loss.

HMAC-SHA256 over 167 MB/s at roughly 500 MB/s per core costs ~0.3 of a core fleet-wide, so signing is free compared with TLS handshakes, which is why connection reuse matters.

### Storage

| Store | Calculation | Size |
|-------|-------------|------|
| Event store (payloads) | 1B × 2 KB = 2 TB/day × 30 days = 60 TB raw; ~4:1 compression | ~15 TB compressed, ~45 TB at replication factor 3 |
| Attempt log (ClickHouse) | 2.4B rows × 400 B = 960 GB/day raw; ~5:1 compression → ~190 GB/day × 30 | ~5.8 TB per replica |
| Retry store (dead letters) | 0.5% × 2B = 10M/day × 30 days = 300M rows × 300 B | ~90 GB, plus the live retry backlog |
| Configuration (PostgreSQL) | 1M endpoints + 5M subscriptions + secrets | < 10 GB |
| Kafka `deliveries` | ~69K/s × 2 KB at peak | ~140 MB/s, 256 partitions (~3,900 endpoints and ~270 msg/s each at peak) |

### Retry Store Write Load

Only failures touch the database. At peak: ~3.5K/s new parked deliveries (5% of 69K/s) plus ~13.9K/s retry outcomes, about **17K row writes/s**, or ~1.1K/s per shard across 16 shards. If every delivery and attempt were a database row (the "database as the queue" design), it would be 69K inserts/s plus 83K outcome updates/s, about **153K writes/s**, roughly 9× more.

### Local Development Scale

Locally the same pipeline runs at 5–50 events/s from a producer simulator, against 50–200 mock receivers whose failure rate, latency, and stalls are configurable, with two dispatcher processes so lane ownership and rebalancing can be observed.

## High-Level Architecture

```
┌─────────────────────────────┐                     ┌─────────────────────────────┐
│ Producer services           │                     │ External producers          │
│ business write + outbox row │                     │ POST /v1/events             │
│ in one transaction          │                     │ Idempotency-Key header      │
└──────────────┬──────────────┘                     └──────────────┬──────────────┘
               │ WAL (CDC)                                         │
               ▼                                                   ▼
┌─────────────────────────────┐                     ┌─────────────────────────────┐
│ Outbox relay                │                     │ Ingest API                  │
│ publish, then mark sent     │                     │ auth · schema · dedupe key  │
└──────────────┬──────────────┘                     └──────────────┬──────────────┘
               └─────────────────────────┬─────────────────────────┘
                                         ▼
                      ┌─────────────────────────────────────┐
                      │ Kafka: events                       │
                      │ key = ordering_key, else event_id   │
                      └──────────────────┬──────────────────┘
                                         ▼
┌──────────────────┐  ┌─────────────────────────────────────┐  ┌──────────────────────┐
│ Subscription     │◀─│ Fan-out workers                     │─▶│ Event store          │
│ cache            │  │ match types · chunk wide fan-outs   │  │ payload by event_id  │
└──────────────────┘  └──────────────────┬──────────────────┘  └──────────────────────┘
                                         ▼
                      ┌─────────────────────────────────────┐  ┌──────────────────────┐
                      │ Kafka: deliveries                   │◀─│ Retry scheduler      │
                      │ key = endpoint_id · 256 partitions  │  │ due rows → re-enqueue│
                      └──────────────────┬──────────────────┘  └──────────▲───────────┘
                                         ▼                                │
                      ┌─────────────────────────────────────┐  ┌──────────┴───────────┐
                      │ Dispatcher fleet                    │─▶│ Retry store (PG)     │
                      │ per-endpoint lanes · breakers       │  │ sharded by endpoint  │
                      │ HMAC signing · adaptive limits      │  │ retry · park · dead  │
                      └──────────┬───────────────┬──────────┘  └──────────────────────┘
                                 │ HTTPS         │ attempt records
                                 ▼               ▼
┌──────────────────────────────────┐  ┌─────────────────────────────────────┐
│ Egress proxy                     │  │ Kafka: attempts                     │
│ static IPs · SSRF · DNS pinning  │  └────────┬───────────────────┬────────┘
└────────────────┬─────────────────┘           ▼                   ▼
                 ▼                    ┌──────────────────┐  ┌──────────────────────┐
┌──────────────────────────────────┐  │ Delivery log     │  │ Health service       │
│ Customer endpoints               │  │ (ClickHouse)     │  │ circuits · auto-off  │
└──────────────────────────────────┘  └────────▲─────────┘  └──────────┬───────────┘
                                               │                       │
┌──────────────────────┐  ┌────────────────────┴───────────────────────▼───────────┐
│ Customer dashboard   │─▶│ Management API: endpoints · secrets · log · replay     │
└──────────────────────┘  └────────────────────────────────────────────────────────┘
```

| Component | Responsibility | Technology |
|-----------|----------------|------------|
| Outbox relay | Tail producer outbox tables and publish to `events` | Debezium CDC (production), polling publisher (local) |
| Ingest API | Authenticated event publishing for producers without an outbox | Node.js + Express, Redis idempotency keys |
| Fan-out workers | Match subscriptions, write the payload once, emit one delivery per endpoint | Kafka consumer group |
| Dispatcher fleet | Per-endpoint lanes, signing, HTTP attempts, parking failures | Kafka consumer group, endpoint-affine partitions |
| Retry store + scheduler | Durable home for retries, parked overflow, dead letters, ordered-mode queues | Sharded PostgreSQL, `SKIP LOCKED` leases |
| Egress proxy | SSRF filtering, DNS pinning, static source IPs | Smokescreen-style forward proxy |
| Health service | Rolling success windows, circuit state, notifications, auto-disable | Kafka consumer + Redis |
| Delivery log | Searchable attempts for 30 days, rollups for charts | ClickHouse |
| Management API + dashboard | Endpoint config, secrets, log search, replay, test events | Express + React |

## Core Components / Request Flows

### 1. Producer Side: Transactional Outbox

A producer such as the batch service changes its own state and records the event in the same database transaction:

```sql
BEGIN;
UPDATE batches SET status = 'completed', version = version + 1 WHERE id = $1;
INSERT INTO outbox (event_id, tenant_id, event_type, ordering_key, sequence, payload)
VALUES (gen_random_uuid(), $2, 'batch.completed', $1, $3, $4);
COMMIT;
```

The relay publishes outbox rows to Kafka in commit order and marks or deletes them only after Kafka acknowledges. A crash between publish and mark republishes the row with the same `event_id`, which downstream dedupe absorbs. The outbox is the only safe handoff: committing first and then publishing loses events on a crash, and publishing first and then committing announces state changes that rolled back. `sequence` is the aggregate's version, assigned by the producer, because only the producer knows the true order of its state changes.

### 2. Ingest API

For producers that cannot run an outbox, `POST /v1/events` validates the event type against the tenant's catalog and the payload against its JSON schema, then checks `Idempotency-Key` in Redis (`SET NX`, 24 h TTL). A repeated key returns the original `event_id`. The API responds 202 only after Kafka acknowledges with `acks=all`.

### 3. Fan-out Workers

For each event:

1. Look up subscriptions for `(tenant_id, event_type)` in a local LRU backed by Redis and PostgreSQL. Config changes publish invalidations.
2. Upsert the payload into the event store keyed by `event_id` (idempotent), so retries and replays can read it later.
3. For each matching enabled endpoint, produce a delivery message keyed by `endpoint_id`. `delivery_id = hash(event_id, endpoint_id)` is deterministic, so re-processing an event yields the same delivery ids.
4. Endpoints that are disabled get a `skipped_disabled` attempt record instead of a delivery.
5. Commit the consumer offset only after all deliveries are acknowledged.

**Wide fan-out**: an event matching more than 1,000 endpoints (platform announcements, or one tenant's many endpoints) is split into chunks of 1,000, each processed as its own task, so one event cannot occupy a worker for minutes. Broadcast chunks pass through a tenant-weighted token bucket so they consume at most a configured share of dispatch capacity.

### 4. Dispatcher: Per-Endpoint Lanes

The `deliveries` topic is keyed by `endpoint_id`, so every delivery for an endpoint lands on one partition, and therefore one dispatcher owns that endpoint at a time. Per-endpoint state (lane, in-flight count, circuit breaker, adaptive limit, keep-alive connections) lives in that process's memory.

```
partition 17 ──▶ reader ──┬──▶ lane ep_A  [cap 10, in flight 3]  ──▶ HTTPS
                          ├──▶ lane ep_B  [cap 10, in flight 10] ──▶ HTTPS (saturated)
                          ├──▶ lane ep_C  [circuit OPEN]         ──▶ park → retry store
                          └──▶ lane ep_D  [cap 1, ordered]       ──▶ retry store queue
```

The reader never performs HTTP itself. It routes each message to its lane in microseconds:

1. Endpoint disabled → write `skipped_disabled` and mark done.
2. Circuit open → park the delivery in the retry store with `next_attempt_at` at the next probe time.
3. Lane full (more than 500 queued or the oldest message waiting more than 30 s) → park with `next_attempt_at` set from the endpoint's measured drain rate.
4. Otherwise queue in the lane. The lane starts an attempt whenever in-flight < the endpoint's current limit.

An attempt fetches a keep-alive connection, signs the request, sends it through the egress proxy, and classifies the outcome (2xx, HTTP error, timeout, connection or TLS error, 410 Gone, 429 with Retry-After). Success emits an attempt record. Failure inserts a row into the retry store with the next backoff time, then emits the attempt record.

**Offset commits**: a message is done once it has been delivered, parked (retry row committed), or skipped. Each partition commits the lowest offset that is not done yet. Because lanes cap waiting at 30 s and attempts time out at 15 s, the commit watermark never lags more than about 45 s. A dispatcher crash replays at most that window, which produces duplicates, never loss. To suppress most of those duplicates, a successful send sets `sent:{delivery_id}` in Redis with a 1 h TTL, and the dispatcher checks it before sending a replayed message.

**Adaptive concurrency**: each lane runs AIMD between 1 and the endpoint's configured cap (default 10, up to 100). Healthy windows add 1. A timeout, 429, or 503 halves the limit. A 429 or 503 with `Retry-After` parks the lane's queue until then, capped at 1 h.

### 5. Retry Store and Scheduler

The retry store is a sharded PostgreSQL table (`delivery_tasks`, 16 shards by `endpoint_id`). It holds four kinds of rows: failed deliveries awaiting retry, parked overflow, dead letters, and every message of ordered-mode endpoints. The scheduler on each shard runs:

```sql
WITH due AS (
  SELECT delivery_id FROM delivery_tasks
  WHERE status = 'scheduled' AND next_attempt_at <= now()
  ORDER BY next_attempt_at
  LIMIT 1000
  FOR UPDATE SKIP LOCKED
)
UPDATE delivery_tasks t
SET status = 'enqueued', lease_until = now() + interval '10 minutes'
FROM due WHERE t.delivery_id = due.delivery_id
RETURNING t.*;
```

It produces each leased row back onto `deliveries` with its attempt number, which keeps endpoint affinity. The dispatcher writes the outcome back: on success the row becomes `delivered` (deleted by a daily partition drop); on failure `attempt_count` increments and `next_attempt_at` moves out; when attempts run out or the delivery is older than 72 h, the row becomes `dead`. A row whose lease expires without an outcome is re-enqueued.

The scheduler releases an endpoint's parked rows no faster than its measured drain rate (a Redis token bucket per endpoint). Without that, a saturated endpoint churns: park, release, overflow, park again.

### 6. Endpoint Health Service

Two layers, because they answer different questions on different timescales:

| Layer | Where | Reacts in | Decides |
|-------|-------|-----------|---------|
| Circuit breaker | Dispatcher memory (endpoint-affine) | Seconds | Stop sending now; probe until healthy |
| Health service | Consumes `attempts`, windows in Redis | Minutes to days | Notify the customer, auto-disable, chart data |

**Circuit policy**: open after 10 consecutive failures, or when more than 50% of the last 50 attempts failed. While open, deliveries are parked and one real delivery is sent as a probe after 30 s, doubling to a 10 min ceiling. A successful probe closes the circuit with slow start (limit 1, then AIMD).

**Auto-disable policy**: notify at 1 h and 24 h of continuous failure; disable when there has been no successful attempt for 72 h while attempts were being made. 410 Gone disables immediately. The 72 h threshold is deliberately longer than the 2.6-day retry schedule, so by the time an endpoint is disabled, its oldest deliveries have already run their full schedule. Disabling stops new deliveries (recorded as `skipped_disabled`) instead of filling the retry store with work that cannot succeed. Re-enabling offers a bulk recover from the disable time.

### 7. Delivery Log Pipeline

Dispatchers emit one attempt record per attempt to the `attempts` topic. ClickHouse ingests it through a Kafka engine table in 1–2 s micro-batches, which meets the 5 s freshness target. A materialized view maintains per-endpoint minute rollups (attempts, successes, p50/p95 latency) for dashboard charts. The current state of a pending retry (next attempt time) comes from the retry store, and the management API merges the two into one delivery status.

### 8. Management API and Dashboard

The dashboard (React SPA) calls a management API for endpoint CRUD, subscriptions, secrets, the delivery log, replay jobs, test events, and a server-sent-events stream of new attempts per endpoint. Test events bypass the queue: a test sender uses the same signer and egress proxy, sends synchronously with the 15 s timeout, and logs the attempt with `trigger = 'test'`, so a developer sees the result immediately even if the endpoint's circuit is open.

### Request Flow: Happy Path

1. The batch service commits its state change and an outbox row in one transaction.
2. The relay publishes the row to `events`; a fan-out worker stores the payload and emits one delivery per subscribed endpoint.
3. The owning dispatcher queues it in the endpoint's lane, signs it, and POSTs it through the egress proxy.
4. The receiver returns 200; the dispatcher sets the `sent:` marker and emits an attempt record, which reaches ClickHouse within seconds.

### Request Flow: Failing Endpoint

1. Attempt 1 returns 503. The dispatcher inserts a `delivery_tasks` row with `next_attempt_at = now + 10 s ± 20%` and emits the attempt record.
2. Nine more failures within seconds open the circuit. New deliveries are parked without being attempted.
3. Probes back off from 30 s to 10 min. The health service emails the tenant at 1 h.
4. The endpoint recovers; a probe succeeds; the circuit closes with limit 1 and grows.
5. The scheduler releases parked rows at the endpoint's drain rate. Each keeps its own `webhook-id`, so a receiver that saw one of them before dedupes it.

## Database Schema

### Configuration (PostgreSQL)

```sql
CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'standard',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'developer', 'viewer', 'operator')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_types (
  name          TEXT PRIMARY KEY,                -- e.g. 'batch.completed'
  description   TEXT NOT NULL,
  json_schema   JSONB NOT NULL,
  example       JSONB NOT NULL,
  archived      BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE endpoints (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  url              TEXT NOT NULL CHECK (url LIKE 'https://%'),
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'enabled'
                   CHECK (status IN ('enabled', 'disabled_manual', 'disabled_auto')),
  disabled_reason  TEXT,
  disabled_at      TIMESTAMPTZ,
  max_concurrency  INT NOT NULL DEFAULT 10 CHECK (max_concurrency BETWEEN 1 AND 100),
  rate_limit_per_s INT CHECK (rate_limit_per_s > 0),
  ordered          BOOLEAN NOT NULL DEFAULT false,
  version          INT NOT NULL DEFAULT 1,        -- bumps on every config change
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_endpoints_tenant ON endpoints(tenant_id);
CREATE INDEX idx_endpoints_auto_disabled ON endpoints(disabled_at) WHERE status = 'disabled_auto';

CREATE TABLE subscriptions (
  endpoint_id   UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  event_pattern TEXT NOT NULL,                   -- exact type or wildcard 'batch.*'
  PRIMARY KEY (endpoint_id, event_pattern)
);
CREATE INDEX idx_subscriptions_tenant ON subscriptions(tenant_id, event_pattern);

CREATE TABLE endpoint_secrets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id       UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  secret_ciphertext BYTEA NOT NULL,              -- envelope-encrypted with KMS
  kms_key_version   INT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('primary', 'previous')),
  valid_until       TIMESTAMPTZ,                 -- set when demoted to 'previous'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_one_primary_secret ON endpoint_secrets(endpoint_id) WHERE state = 'primary';

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL,
  actor_id    UUID,
  action      TEXT NOT NULL,                     -- secret.reveal, secret.rotate, replay.bulk, ...
  target_id   UUID,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_time ON audit_log(tenant_id, created_at DESC);
```

### Producer Outbox (in each producer's own database)

```sql
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,            -- commit order for the polling relay
  event_id     UUID NOT NULL UNIQUE,
  tenant_id    UUID NOT NULL,
  event_type   TEXT NOT NULL,
  ordering_key TEXT,                             -- usually the aggregate id
  sequence     BIGINT,                           -- aggregate version from the producer
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished ON outbox(id) WHERE published_at IS NULL;
```

### Event Store

Production uses a replicated key-value store (Cassandra) keyed by `event_id` with a 30-day TTL. Locally it is a PostgreSQL table partitioned by day so expiry is a partition drop:

```sql
CREATE TABLE events (
  event_id     UUID NOT NULL,
  tenant_id    UUID NOT NULL,
  event_type   TEXT NOT NULL,
  ordering_key TEXT,
  sequence     BIGINT,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_events_tenant_time ON events(tenant_id, created_at DESC);
```

### Retry Store

```sql
CREATE TABLE delivery_tasks (
  delivery_id     UUID PRIMARY KEY,              -- hash(event_id, endpoint_id)
  endpoint_id     UUID NOT NULL,
  tenant_id       UUID NOT NULL,
  event_id        UUID NOT NULL,
  event_type      TEXT NOT NULL,
  status          TEXT NOT NULL
                  CHECK (status IN ('scheduled', 'enqueued', 'delivered', 'dead', 'cancelled')),
  reason          TEXT NOT NULL                  -- retry, parked_overflow, parked_circuit, ordered, replay
                  CHECK (reason IN ('retry', 'parked_overflow', 'parked_circuit', 'ordered', 'replay')),
  attempt_count   INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_until     TIMESTAMPTZ,
  first_attempt_at TIMESTAMPTZ,
  last_status_code INT,
  last_error      TEXT,
  ordering_key    TEXT,
  sequence        BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- scheduler: due work, smallest index possible
CREATE INDEX idx_tasks_due ON delivery_tasks(next_attempt_at) WHERE status = 'scheduled';
-- lease recovery
CREATE INDEX idx_tasks_lease ON delivery_tasks(lease_until) WHERE status = 'enqueued';
-- dashboard: failed and pending deliveries per endpoint
CREATE INDEX idx_tasks_endpoint ON delivery_tasks(endpoint_id, status, created_at DESC);
-- ordered mode: head of each key's queue
CREATE INDEX idx_tasks_ordered ON delivery_tasks(endpoint_id, ordering_key, sequence)
  WHERE reason = 'ordered' AND status IN ('scheduled', 'enqueued');
```

### Replay Jobs and Idempotency

```sql
CREATE TABLE replay_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  endpoint_id     UUID NOT NULL REFERENCES endpoints(id),
  idempotency_key TEXT NOT NULL,
  filter          JSONB NOT NULL,                -- {since, until, statuses, event_types}
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
  total           INT,
  enqueued        INT NOT NULL DEFAULT 0,
  cursor          TEXT,                          -- resume point after a worker crash
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX idx_replay_jobs_endpoint ON replay_jobs(endpoint_id, created_at DESC);

```

### Delivery Attempt Log

Production (ClickHouse), ordered for the dashboard's dominant query "this endpoint's recent attempts":

```sql
CREATE TABLE attempts (
  tenant_id        UUID,
  endpoint_id      UUID,
  delivery_id      UUID,
  event_id         UUID,
  event_type       LowCardinality(String),
  attempt_number   UInt8,
  trigger          LowCardinality(String),       -- scheduled, retry, manual, test
  outcome          LowCardinality(String),       -- success, http_error, timeout, conn_error, skipped_disabled
  status_code      UInt16,
  latency_ms       UInt32,
  response_snippet String,                       -- first 1 KB
  attempted_at     DateTime64(3),
  INDEX idx_event event_id TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree
PARTITION BY toDate(attempted_at)
ORDER BY (tenant_id, endpoint_id, attempted_at)
TTL toDate(attempted_at) + INTERVAL 30 DAY;
```

Locally the same columns live in a PostgreSQL table partitioned by day with an index on `(endpoint_id, attempted_at DESC)`.

### Redis Keys

| Key | Type | TTL | Purpose |
|-----|------|-----|---------|
| `idem:{tenant}:{key}` | String | 24 h | Ingest API idempotency |
| `sent:{delivery_id}` | String | 1 h | Suppress duplicate sends after a dispatcher crash |
| `circuit:{endpoint_id}` | Hash | none | Circuit state, shared with the scheduler and dashboard |
| `drain:{endpoint_id}` | Hash | 1 h | Token bucket for releasing parked rows |
| `health:{endpoint_id}:{window}` | Hash | window × 2 | Success and failure counts for 5 min, 1 h, 24 h windows |
| `subs:{tenant_id}` | Hash | 10 min | Subscription cache; invalidated on config change |
| `sess:{id}` | String | 24 h | Dashboard sessions |

## API Design

### Ingest

```
POST /v1/events                     → 202 {event_id}; Idempotency-Key required
```

### Management (tenant-scoped, session or API key)

```
GET    /v1/event-types                       → catalog with schemas and examples
GET    /v1/endpoints                         → list with health summary
POST   /v1/endpoints                         → create; returns the secret once
GET    /v1/endpoints/:id                     → config, status, circuit state
PATCH  /v1/endpoints/:id                     → url, description, limits, ordered flag
DELETE /v1/endpoints/:id                     → delete (cancels pending tasks)
POST   /v1/endpoints/:id/enable              → re-enable; returns suggested recover window
POST   /v1/endpoints/:id/disable             → manual disable
PUT    /v1/endpoints/:id/subscriptions       → replace event patterns
POST   /v1/endpoints/:id/secret/reveal       → requires recent re-auth; audited
POST   /v1/endpoints/:id/secret/rotate       → {overlap_hours: 0..168}
POST   /v1/endpoints/:id/test                → synchronous test send; returns the attempt
GET    /v1/endpoints/:id/stats?window=24h    → success rate and latency rollups
```

### Delivery Log, Replay, and Admin

```
GET  /v1/deliveries?endpoint_id=&status=&event_type=&since=&until=&cursor=
                                           → keyset-paginated deliveries with derived status
GET  /v1/deliveries/:id                    → delivery plus attempt timeline
POST /v1/deliveries/:id/replay             → single replay; Idempotency-Key
POST /v1/endpoints/:id/recover             → bulk replay job; dry_run=true returns the count
GET  /v1/replay-jobs/:id                   → progress
POST /v1/replay-jobs/:id/cancel            → stop releasing rows
GET  /v1/endpoints/:id/attempts/stream     → SSE live tail
GET  /v1/admin/backlog                     → partition lag, retry store depth per shard
GET  /v1/admin/endpoints?status=disabled_auto
POST /v1/admin/endpoints/:id/throttle      → override concurrency or pause
```

### Wire Contract (what receivers see)

```
POST https://customer.example.com/webhooks
content-type: application/json
webhook-id: evt_2Q8Hk3...                 (same on every retry and replay)
webhook-timestamp: 1791734400             (seconds; set at each attempt)
webhook-signature: v1,K5oZfzN95Z9UVu1Eso... v1,9ZK1sQ...   (two during rotation)

{"type":"batch.completed","created_at":"...","sequence":7,"data":{...}}
```

The signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`, following the Standard Webhooks convention. Every request goes over HTTPS, ignores redirects (a 3xx counts as a failure), and times out after 15 s.

## Key Design Decisions

### 1. Kafka Hot Path Plus a Durable Retry Store

**Chosen**: first attempts flow through Kafka with no database write; only deliveries that fail, overflow, or need ordering are written to a sharded PostgreSQL retry store.

95% of deliveries succeed on the first try, and for them a database row is pure overhead: it is written, updated, and deleted within a second. The hybrid cuts retry store writes from about 153K/s to about 17K/s at peak, and the 5% that do fail get what Kafka cannot offer: arbitrary per-row delays (a 24 h retry is just a timestamp), cheap lookups for the dashboard, and in-place state transitions for replay.

**Alternative rejected: Kafka retry topics** (`retry-10s`, `retry-1m`, ...). Each tier has one fixed delay, so jitter and `Retry-After` are approximations; a consumer for the 24 h tier must hold messages a full day, pinning offsets; and "show me this endpoint's pending retries" requires scanning topics. **Alternative rejected: the database as the only queue.** It is the right MVP (see Scalability Considerations), but at 69K deliveries/s it turns every webhook into multiple row writes and makes the database the throughput ceiling.

**Cost**: two queueing systems to operate and reason about, and a crash window (up to ~45 s of a partition) where Kafka redelivery creates duplicates.

### 2. Per-Endpoint Lanes on Endpoint-Affine Partitions

**Chosen**: key `deliveries` by `endpoint_id` so one dispatcher owns each endpoint, and give every endpoint its own in-memory lane with a concurrency cap and circuit breaker. The partition reader never blocks on HTTP.

A Kafka partition is a FIFO shared by ~3,900 endpoints. If the consumer processes it serially, one endpoint that times out at 15 s and receives one event per second consumes 15 s of wall-clock per second of traffic, and the other ~3,900 endpoints on that partition fall further behind every second (lag grows by ~16K messages a minute at the 270 msg/s peak). Lanes decouple reading from sending; parking moves anything that cannot make progress out of memory and out of the commit window. Affinity also means limits, breakers, and keep-alive pools need no distributed coordination.

**Alternative rejected: a broker queue per endpoint** (RabbitMQ). A million queues, most idle, strain the broker's metadata and memory, and consumers must subscribe to queues dynamically. **Alternative rejected: a shared worker pool with a global concurrency limit.** It is fair in the wrong unit: the slow 1% of traffic takes 43% of sockets.

**Cost**: a rebalance moves endpoints between processes, briefly resetting their adaptive limits and circuits (the circuit state is checkpointed to Redis to soften this), and a single endpoint's throughput is capped by one process. Very large endpoints need sub-keys (see Scalability Considerations).

### 3. No Ordering Guarantee by Default; Opt-In Ordered Mode

**Chosen**: by default, deliveries can arrive in any order. Every payload carries `created_at` and a producer-assigned per-resource `sequence`, so receivers can discard stale updates or fetch current state. Endpoints can opt into ordered delivery per `ordering_key`.

Ordering and at-least-once delivery with retries conflict: if event 1 fails and event 2 succeeds, either event 2 waits (blocking) or it arrives first (reordering). Strict per-endpoint FIFO means one failing message can block an endpoint's entire stream for up to the 2.6-day retry window, which is head-of-line blocking promised as a feature. Ordered mode narrows the blast radius to one `ordering_key` (one batch job, one invoice): each key is a queue in the retry store with concurrency 1, and the scheduler releases only the lowest pending `sequence` per key. When a message dead-letters, the next one is released by default (configurable to stop).

**Cost of ordered mode**: every message takes the database path (no hot path), throughput per key is 1/latency (about 5/s at 200 ms), and a poison message stalls its key until it dead-letters.

### 4. HMAC Signatures with an Embedded Timestamp

**Chosen**: HMAC-SHA256 with a per-endpoint secret over `id.timestamp.body`, with multiple signatures during rotation.

The timestamp bounds replay: a captured request is rejected after a 5-minute tolerance, and within that window the receiver's `webhook-id` dedupe rejects it. Signing the id prevents an attacker from changing it to slip past dedupe. Per-endpoint secrets limit a leak to one endpoint. HMAC costs ~0.3 of a core at peak.

**Alternative rejected as the default: mutual TLS.** It authenticates the connection, not the message, and is lost wherever the customer terminates TLS at a load balancer. **Offered as an option: Ed25519 signatures** (`v1a`), which let receivers verify with a public key so a leaked receiver config cannot forge requests. They cost more CPU and are less familiar to customers.

### 5. Transactional Outbox Instead of Dual Writes

**Chosen**: producers write an outbox row in their business transaction, and a CDC relay publishes it.

A producer that commits and then publishes loses the event if it crashes in between; one that publishes and then commits announces a state change that may roll back. The outbox makes "state changed" and "event will be published" a single atomic fact. CDC (Debezium tailing the WAL) adds no query load and preserves commit order; a polling relay is simpler and is what the local build uses.

**Cost**: every producer team runs a relay (or onboards to a shared CDC platform), and publication is asynchronous, typically 100–500 ms behind the commit.

## Consistency and Idempotency

**Exactly-once to an HTTP endpoint is impossible.** If the receiver processes a request and its 200 is lost to a timeout, the sender cannot distinguish that from a failure and must retry. The platform therefore promises at-least-once delivery and makes duplicates cheap to detect.

| Hop | Durability point | Duplicate source | Dedupe |
|-----|------------------|------------------|--------|
| Producer → outbox | Business transaction commit | none | — |
| Relay → `events` | Kafka ack, then outbox mark | Crash between ack and mark | Same `event_id` |
| Ingest API → `events` | Kafka ack before 202 | Client retry | `Idempotency-Key` → original `event_id` |
| Fan-out → `deliveries` | Kafka ack before offset commit | Re-processing after crash | Deterministic `delivery_id` |
| Dispatcher → receiver | Attempt record or retry row before watermark | Replay of up to ~45 s after crash | `sent:{delivery_id}` marker (best effort) |
| Scheduler → `deliveries` | Lease in retry store | Lease expiry | Row state machine; same `delivery_id` |
| Receiver | — | All of the above, plus lost 2xx | **`webhook-id` dedupe (the guarantee)** |

Parking is `INSERT ... ON CONFLICT (delivery_id) DO NOTHING`, so a replayed message cannot create a second retry row. Outcome updates are conditional on the current `attempt_count`, so a late result from an expired lease cannot overwrite a newer one.

### Retry Schedule

Delay before retry *n* = min(10 s × 4^(n−1), 24 h), multiplied by a uniform jitter factor in [0.8, 1.2]. Ten attempts in total; a delivery dead-letters after the tenth failure or 72 h of age, whichever comes first.

| Attempt | Nominal delay | Cumulative |
|---------|---------------|------------|
| 1 | immediate | 0 |
| 2 | 10 s | 10 s |
| 3 | 40 s | 50 s |
| 4 | 2 min 40 s | 3 min 30 s |
| 5 | 10 min 40 s | 14 min 10 s |
| 6 | 42 min 40 s | 56 min 50 s |
| 7 | 2 h 50 min 40 s | 3 h 47 min 30 s |
| 8 | 11 h 22 min 40 s | 15 h 10 min 10 s |
| 9 | 24 h (capped) | 39 h 10 min 10 s |
| 10 | 24 h (capped) | 63 h 10 min 10 s (≈ 2.6 days) |

Jitter prevents synchronized retry waves: 10K deliveries that failed during the same second retry over a 4 s spread (8–12 s) instead of the same instant, which matters for our scheduler and database as much as for receivers. Jitter alone does not protect a recovering endpoint; the circuit breaker's slow start and the drain-rate token bucket do.

### Receiver Contract

Receivers verify the signature over the raw body, reject timestamps more than 5 minutes off, dedupe on `webhook-id` for at least 3 days (longer than the retry horizon), record the id in the same transaction as the side effect, and return 2xx quickly before processing asynchronously. A manual replay reuses the `webhook-id` with a fresh timestamp and signature; one sent after the receiver's dedupe TTL is processed again, which is what an explicit replay intends.

## Security / Auth

- **SSRF**: customer URLs are untrusted. All traffic leaves through an egress proxy that resolves DNS itself, rejects private, loopback, link-local (including `169.254.169.254`), and internal ranges, pins the resolved IP for the connection to defeat DNS rebinding, and does not follow redirects. Validation at registration time is a convenience; the proxy at send time is the control.
- **Static egress IPs** are published per region so customers can allowlist them.
- **HTTPS only** in live mode; `http://` is allowed only for test-mode endpoints.
- **Secrets**: 32 random bytes with a `whsec_` prefix, envelope-encrypted with KMS. Dispatchers cache decrypted secrets in memory for 5 minutes. Revealing a secret requires re-authentication within 10 minutes and writes an audit row. Rotation with `overlap_hours = 0` is the emergency path for a leaked secret.
- **Dashboard auth**: session cookies in Redis (HttpOnly, SameSite=Lax), roles `owner`, `developer`, `viewer`, plus an internal `operator` role for admin routes. Management API keys are scoped per tenant.
- **Rate limiting**: ingest per tenant (token bucket, default 1,000 events/s with bursts), management API per user, bulk replay limited to 5 concurrent jobs per tenant.
- **Response handling**: response bodies are read up to 64 KB, stored truncated to 1 KB, and rendered as text in the dashboard, since they are untrusted content from the customer's server.
- **Payload hygiene**: producers must not put secrets in payloads; "thin" events (ids plus a fetch URL) are recommended for sensitive resources.

## Observability

| Metric | Type | Labels | Why |
|--------|------|--------|-----|
| `webhook_events_ingested_total` | Counter | source (outbox, api) | Input rate |
| `webhook_first_attempt_latency_seconds` | Histogram | — | Commit-to-first-attempt SLO |
| `webhook_attempts_total` | Counter | outcome, status_class | Success rate, error mix |
| `webhook_attempt_duration_seconds` | Histogram | outcome | Receiver latency, timeout share |
| `webhook_inflight_requests` | Gauge | dispatcher | Little's-law check |
| `webhook_lane_parked_total` | Counter | reason (overflow, circuit) | Isolation working as designed |
| `webhook_circuit_state` | Gauge | state | Count of endpoints per state (not per-endpoint labels) |
| `webhook_partition_commit_lag_seconds` | Gauge | partition | Watermark health |
| `webhook_retry_backlog` | Gauge | shard, status | Retry store depth |
| `webhook_dead_letters_total` | Counter | — | Exhausted deliveries |
| `webhook_outbox_relay_lag_seconds` | Gauge | producer | Outbox health |

Per-endpoint metrics would be a million label values, so they live in ClickHouse rollups rather than Prometheus.

**SLO alerts**: first-attempt p99 above 5 s for 10 minutes; partition commit lag above 60 s; retry store due-but-not-leased rows older than 2 minutes (scheduler stalled); outbox relay lag above 30 s; dead letters jumping above 3× the 7-day baseline.

**End-to-end canaries**: a synthetic tenant publishes an event every 10 s in each region to an internal receiver that verifies the signature and records arrival. Missing canaries detect silent loss, which no component-level metric can.

**Logging**: structured JSON with `event_id`, `delivery_id`, `endpoint_id`, and `attempt` on every line; payloads and secrets are never logged.

## Failure Handling

| Failure | Behavior |
|---------|----------|
| Receiver slow or hanging | Its lane saturates at its cap; overflow parks; others unaffected |
| Receiver returning 5xx | Retries on schedule; circuit opens; probes; notifications; auto-disable at 72 h |
| Receiver returns 429/503 with Retry-After | Lane pauses until then (max 1 h); AIMD halves the limit |
| Receiver returns 410 Gone | Endpoint disabled immediately; tenant notified |
| Dispatcher crash | Partitions rebalance; up to ~45 s replayed; `sent:` markers suppress most duplicates |
| Retry store shard down | Parking for that shard's endpoints fails, so their lanes hold messages and the partition watermark stalls; other shards continue; Opossum breaker around the shard fails fast |
| Kafka broker loss | RF 3 with `min.insync.replicas=2`; producers retry; no acknowledged data lost |
| ClickHouse down | Attempt records accumulate in Kafka (7-day retention); delivery continues; log is stale |
| Health service down | Dispatcher-local circuits still protect; auto-disable and emails pause |
| Mass customer outage (a cloud region) | Circuits open for affected endpoints; parked deliveries drain at measured rates on recovery |

**Retry storm example**: 20% of endpoints go down for an hour. That parks 0.2 × ~23K/s × 3,600 s ≈ 16.7M deliveries. On recovery, the fleet's spare capacity at average load (~55K/s) could push them in ~5 minutes, but per-endpoint slow start and drain-rate buckets stretch it out for each receiver, which is the point: the receivers are fragile right after an outage.

Circuit breakers (Opossum) also wrap our own dependencies: the retry store shards, Redis, and the event store. When Redis is down, `sent:` markers are skipped (more duplicates, still correct) and circuit state stays local.

## Scalability Considerations

**Horizontal scaling path**:

1. Dispatchers scale with partitions (256, four per process). Add partitions ahead of need, since repartitioning moves endpoints.
2. Fan-out workers scale with `events` partitions and are stateless apart from caches.
3. The retry store scales by adding shards (consistent hashing on `endpoint_id`); 16 shards carry ~1.1K writes/s each at peak.
4. ClickHouse scales by shards on `tenant_id`.

**Whale endpoints**: an endpoint receiving 2K deliveries/s at 200 ms needs ~400 in flight, within one process's 1,000 but above the default cap. Higher caps are granted per plan. Beyond one process, the endpoint is split into N sub-keys (`endpoint_id#k`), which spreads it across partitions and gives up ordered mode.

**Whale tenants**: `events` is keyed by `ordering_key` (or `event_id`), not tenant, so one tenant's burst spreads across partitions. Fan-out applies per-tenant weighted fair queuing so a 1M-event burst cannot starve other tenants' first attempts.

**What breaks first**: the egress tier. At ~29K in-flight requests, most of the sockets belong to slow receivers, and every new connection costs a TLS handshake. Endpoint affinity makes keep-alive reuse effective; adaptive timeouts (shorter for endpoints whose p99 is far below 15 s) would reclaim sockets. Next are ClickHouse inserts during retry storms and retry store hot shards when one huge endpoint fails.

**10× (10B events/day)**: ~830K attempts/s at peak and ~290K in flight; ~300 dispatcher processes at 1,000 each, run as ~640; 2,048 partitions; 64 retry store shards at ~2.7K writes/s each; ~58 TB of attempt log per replica. TLS handshake CPU becomes the egress cost driver, so connection reuse is the main lever.

**Multi-region**: tenants have a home region, and all their deliveries originate there (keeping affinity and dedupe local). Kafka is replicated to a standby region asynchronously. On region loss, tenants fail over; events not yet replicated are delayed until the region returns (they were acknowledged by three in-region replicas, so they are not lost), and the new region may resend some already-delivered webhooks, which `webhook-id` dedupe absorbs. Customers allowlist every region's egress IPs.

**Two-week MVP**: one PostgreSQL database as both event store and queue (`delivery_tasks` for every delivery, `SKIP LOCKED` workers), a per-endpoint in-flight cap enforced by a `COUNT` on enqueued rows, HMAC signing, the retry schedule, and a log table. It handles roughly 1–2K deliveries/s, which covers launch. Kafka, the hot path, and ClickHouse come when write volume demands them.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Delivery semantics | At-least-once + `webhook-id` | Exactly-once | Impossible over HTTP; dedupe at the receiver is the guarantee |
| Queue design | Kafka hot path + PG retry store | DB-only queue / retry topics | ~9× fewer DB writes; per-row delays for the 5% that fail |
| Endpoint isolation | Affine partitions + in-memory lanes | Queue per endpoint / shared pool | No million-queue broker; slow endpoints cannot take 43% of sockets |
| Concurrency control | AIMD per endpoint, default cap 10 | Fixed global limit | Adapts to each receiver's capacity and 429s |
| Ordering | None by default; opt-in per key | Strict per-endpoint FIFO | FIFO turns one failure into a multi-day stall |
| Retry schedule | 10 s × 4^n capped at 24 h, ±20% jitter | Fixed interval | Fast recovery for blips, multi-day coverage for outages |
| Failing endpoints | Circuit + park + auto-disable at 72 h | Retry everything forever | Protects receivers and our retry store |
| Signing | HMAC-SHA256 over id.timestamp.body | mTLS | Survives TLS termination; per-message replay protection |
| Producer handoff | Transactional outbox + CDC | Dual write | Atomic "state changed" and "event will publish" |
| Delivery log | ClickHouse, 30-day TTL | PostgreSQL | 2.4B rows/day with fast filters and rollups |
| Test events | Synchronous direct send | Through the queue | Immediate feedback even when the circuit is open |
| Egress | Proxy with DNS pinning | Validate URL at registration | Only send-time checks stop DNS rebinding |

## Implementation Notes

Nothing is implemented yet. This section describes the **planned** local build: Node.js + Express + TypeScript services and a React 19 + Vite + TanStack Router + Zustand + Tailwind dashboard, on PostgreSQL, Valkey, and RabbitMQ.

### Planned Local Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Local machine (planned)                                                      │
│  ┌────────────────┐    ┌────────────────────────────┐   ┌─────────────────┐  │
│  │ Dashboard      │───▶│ API :3000                  │   │ Producer :3004  │  │
│  │ Vite :5173     │    │ (:3001-3003 for instances) │   │ outbox + relay  │  │
│  └────────────────┘    └────────────────────────────┘   └────────┬────────┘  │
│                                                                  ▼           │
│  ┌───────────────────────────────────────────────────┐   ┌─────────────────┐ │
│  │ Workers: fanout · dispatcher ×2 · scheduler       │◀─▶│ RabbitMQ :5672  │ │
│  └─────────────────────────┬─────────────────────────┘   └─────────────────┘ │
│                            ▼                                                 │
│  ┌────────────────────┐  ┌────────────────┐  ┌────────────────┐              │
│  │ Mock receivers     │  │ PostgreSQL     │  │ Valkey         │              │
│  │ :3005 /r/:name     │  │ :5432          │  │ :6379          │              │
│  └────────────────────┘  └────────────────┘  └────────────────┘              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Production-Grade Patterns Planned

| Pattern | Planned location | Why it matters at scale |
|---------|------------------|-------------------------|
| Transactional outbox + polling relay | planned `backend/src/producer/` | Business row and outbox row in one transaction; relay publishes with confirms, then marks |
| Idempotency | planned `backend/src/shared/idempotency.ts` | Ingest and replay `Idempotency-Key`, deterministic `delivery_id`, `ON CONFLICT` parking |
| Per-endpoint circuit breakers (Opossum) | planned `backend/src/dispatcher/lane.ts` | One breaker per active lane, created lazily |
| Adaptive concurrency (AIMD) | planned `backend/src/dispatcher/lane.ts` | A stalling receiver's limit collapses while neighbors keep their throughput |
| Prometheus metrics (prom-client) | planned `backend/src/shared/metrics.ts` | Exposed at `/metrics` on every service |
| Structured logging (Pino) | planned `backend/src/shared/logger.ts` | Ids on every line; secrets redacted |
| Health checks | planned `/health` on every service | Checks PostgreSQL, Redis, and RabbitMQ |
| Rate limiting | planned `backend/src/shared/rate-limit.ts` | Ingest per tenant, login per IP |
| HMAC signing and verification | planned `backend/src/shared/signing.ts` | Shared by the dispatcher, the test sender, and the mock receivers |

### What Will Be Simplified or Simulated

| Production | Local substitute |
|------------|------------------|
| Producer services with their own databases | A producer service with its own `producer` schema and outbox |
| Debezium CDC relay | Polling relay with `FOR UPDATE SKIP LOCKED` |
| Kafka `events` / `deliveries`, keyed partitions | RabbitMQ: one events queue; 8 partition queues routed by `hash(endpoint_id)`, each with single active consumer for affinity |
| Cassandra event store, ClickHouse attempt log | PostgreSQL `events`, `attempts`, and a `deliveries` summary table |
| Customer endpoints | Mock receivers whose mode (healthy, slow, flaky, down, stall, gone) is switchable at runtime |
| Egress proxy | In-process SSRF check with a localhost allowlist |
| KMS envelope encryption | AES-256-GCM with a key from an environment variable |
| Multi-day retry schedule | A `TIME_SCALE` multiplier so the schedule plays out in minutes |

### What Will Be Omitted

- Multi-region failover, static egress IPs, and a real forward proxy
- Ordered delivery mode, Ed25519 signatures, and mTLS
- Whale-endpoint sub-key splitting, Kubernetes, and Grafana dashboards
