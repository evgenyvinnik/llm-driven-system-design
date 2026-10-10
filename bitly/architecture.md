# Bitly (URL Shortener) — Architecture

## System Overview

A URL shortener turns a long URL into a seven-character code, sends anyone who follows `/{code}` to the destination, and tells the link's owner who clicked. It looks like two endpoints and one table; what makes it a real design problem is the **read/write asymmetry** (about 100 redirects per link created), the need for **unique, unguessable codes without coordination**, and **analytics that ride on the hottest path without slowing it down**.

This document describes the production-scale design first, then — in [Implementation Notes](#implementation-notes) — what the local Express + PostgreSQL + Valkey + RabbitMQ + React implementation actually does.

**Learning goals**

- Separating a careful write path from a cache-first read path, and sizing each.
- Generating unique short codes: random + unique insert versus key pools, counters and hashes.
- Cache tiers, cache invalidation with a bounded staleness promise, and stampede protection.
- Moving analytics off the request path: at-least-once delivery plus idempotent consumers.
- Idempotency keys for safe client retries.

## Requirements

### Functional requirements

1. Create a short link for an HTTP(S) URL, optionally with a custom alias and an expiry.
2. Redirect `GET /{code}` to the destination.
3. Owners list their links and deactivate them; administrators take down abusive links.
4. Per-link analytics: clicks over time, referrers, devices, countries.

Out of scope: editing a link's destination after creation, custom domains, QR codes, billing.

### Non-functional requirements

| Requirement | Target |
|-------------|--------|
| Redirect latency | p99 < 50 ms server-side within a region |
| Redirect availability | 99.99% |
| Creation latency | p99 < 300 ms |
| Correctness | A code maps to exactly one destination forever; codes are never reassigned |
| Takedown propagation | A deactivated link stops redirecting everywhere within 5 s |
| Analytics freshness | < 1 minute behind real time |

## Capacity Estimation

| Quantity | Estimate | Design consequence |
|----------|----------|--------------------|
| Link creations | 50M/day → ~600/s average, ~5K/s peak | One write primary is enough |
| Redirects | 5B/day → ~58K/s average, ~200K/s peak | Cache-first, stateless, horizontally scaled |
| Link storage | ~500 B × 50M/day ≈ 25 GB/day ≈ 9 TB/year | Single node in year one; hash-shard by code later |
| Click events | ~200 B × 5B/day ≈ 1 TB/day raw | Column store; 90-day raw retention; rollups kept |
| Hot working set | ~100M active links × ~300 B ≈ 30 GB | Redis cluster; viral links need an in-process tier |
| Code space | 62⁷ ≈ 3.5 trillion | ~0.5% filled per year at 18B links/year |

At 0.5% occupancy a random new code collides with probability 0.005, so one creation in 200 needs a second attempt. Codes are never recycled: a reused code would send old bookmarks and printed links to an unrelated destination.

### Local Development Scale

One API process, one analytics worker, PostgreSQL, Valkey, RabbitMQ and the Vite dev server. `dev:server1..3` and `dev:worker1..2` run extra processes against the same infrastructure to exercise concurrent key leasing and competing consumers. There is no load balancer, ClickHouse or Kafka locally. Ports and setup are in the [README](./README.md).

## High-Level Architecture

```
  ┌──────────────────────┐                          ┌──────────────────────┐
  │ Link owner (web app) │                          │ Visitor's browser    │
  └──────────┬───────────┘                          └──────────┬───────────┘
             │ (1) POST /api/v1/links                          │ (2) GET /aZ3kq9x
             ▼                                                 ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │ Load balancer · TLS termination · routes /api/* and /{code}            │
  └──────────┬─────────────────────────────────────────────────┬───────────┘
             ▼                                                 ▼
  ┌──────────────────────┐                          ┌──────────────────────┐
  │ Link API             │                          │ Redirect Service     │
  │ create · deactivate  │                          │ in-process L1 → 302  │
  │ stats queries        │                          │ stateless, ~200K/s   │
  └──┬───────┬───────┬───┘                          └───┬──────┬───────┬───┘
     │       │       │ SET/DEL        GET link:{code}   │      │       │ (3) click
     │       │       └──────────▶┌──────────────┐◀──────┘      │       │     event
     │       │                   │ Redis        │              │       ▼
     │       │                   │ link cache   │              │  ┌──────────────┐
     │       │                   └──────────────┘              │  │ Kafka        │
     │       │ INSERT/UPDATE     ┌──────────────┐ miss→replica │  │ click-events │
     │       └──────────────────▶│ PostgreSQL   │◀─────────────┘  └──────┬───────┘
     │                           │ links, users │                        ▼
     │                           └──────────────┘                 ┌──────────────┐
     │ query stats               ┌──────────────┐  insert, dedupe │ Click        │
     └──────────────────────────▶│ ClickHouse   │◀────────────────┤ consumers    │
                                 │ clicks       │                 └──────────────┘
                                 └──────────────┘
```

1. **Create (1).** The owner's app calls the Link API, which picks a random code, inserts the link into PostgreSQL (the primary key guarantees one destination per code), warms Redis, and returns the short URL.
2. **Redirect (2).** The Redirect Service answers from its in-process cache, then Redis, then a PostgreSQL read replica, and returns `302`. It never calls the primary database or the analytics stack while the visitor waits.
3. **Count (3).** After the `302` is sent, the Redirect Service publishes a click event to Kafka. Consumers write deduplicated batches to ClickHouse; the Link API reads ClickHouse rollups for dashboards.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, path routing (`/api/*` vs `/{code}`) | Connections | GeoDNS or anycast across regions |
| Link API | Create, list, deactivate, auth, stats queries | Owners (~600 writes/s) | Stateless |
| Redirect Service | Code → `302`, click capture | Visitors (~200K/s) | Stateless; in-process LRU per instance |
| Redis Cluster | Link cache, idempotency records, rate-limit counters | Hot set (~30 GB) | Losing it makes redirects slower, never wrong |
| PostgreSQL | Source of truth for links, users, outbox | Link count | Primary + read replicas; hash-shard by code later |
| Outbox relay + pub/sub | Publishes link changes to every Redirect instance | Change rate (tiny) | Drives L1 eviction for takedowns |
| Kafka | Durable, replayable click log | Click rate | Partitioned by code; 7-day retention |
| Click consumers | Deduplicate, enrich, batch insert | Consumer lag | Commit offsets only after the insert |
| ClickHouse | Raw clicks + per-minute rollups | Events | 90-day raw TTL |

The Link API and the Redirect Service share data but not traffic profiles: the Redirect Service carries 100× the load, has the tighter SLO, and must keep working when Kafka, ClickHouse or the primary database are unavailable. They run as separate instance pools so each can be scaled, deployed and degraded independently.

## Core Components / Request Flows

### Creating a link

```
 Owner app                           Link API                                  Redis   PostgreSQL
     │                                   │                                       │          │
     │ 1 POST /links, Idempotency-Key K  │                                       │          │
     │──────────────────────────────────▶│                                       │          │
     │                                   │ 2 SET idem:K pending NX EX 60         │          │
     │                                   │──────────────────────────────────────▶│          │
     │                                   │ 3 OK (first attempt)                  │          │
     │                                   │◀──────────────────────────────────────│          │
     │                                   │ 4 code = 7 random base62 chars        │          │
     │                                   │ 5 INSERT … ON CONFLICT DO NOTHING                │
     │                                   │─────────────────────────────────────────────────▶│
     │                                   │ 6 1 row (0 rows → new code, retry)               │
     │                                   │◀─────────────────────────────────────────────────│
     │                                   │ 7 SET link:{code}; idem:K = 201 body  │          │
     │                                   │──────────────────────────────────────▶│          │
     │ 8 201 {code, short_url}           │                                       │          │
     │◀──────────────────────────────────│                                       │          │
     │                                   │                                       │          │
```

- The client generates the `Idempotency-Key` once per submitted form. A retry with the same key and body returns the stored `201`; the same key with a different body returns `422`; a concurrent duplicate that finds the key still `pending` gets `409` with `Retry-After`.
- The code is seven characters from a CSPRNG. `INSERT … ON CONFLICT (code) DO NOTHING` returning zero rows means a collision; the API draws a new code (at most three attempts before failing with `503`).
- Custom aliases go through the same insert without retry and return `409` when taken. Reserved words (`api`, `admin`, `login`, `health`, `metrics`, `ready`, …) are rejected before the insert.
- Step 7 writes the cache so the first redirect doesn't depend on replica lag.

### Following a link

```
 Visitor        Redirect Svc                       Redis   PG replica    Kafka
    │                 │                              │          │          │
    │ 1 GET /aZ3kq9x  │                              │          │          │
    │────────────────▶│                              │          │          │
    │                 │ 2 L1 (in-process, 5 s): miss │          │          │
    │                 │ 3 GET link:aZ3kq9x           │          │          │
    │                 │─────────────────────────────▶│          │          │
    │                 │ 4 miss                       │          │          │
    │                 │◀─────────────────────────────│          │          │
    │                 │ 5 SELECT … WHERE code = $1              │          │
    │                 │────────────────────────────────────────▶│          │
    │                 │ 6 url, status, expires_at               │          │
    │                 │◀────────────────────────────────────────│          │
    │                 │ 7 SET … EX min(24h, expiry)  │          │          │
    │                 │─────────────────────────────▶│          │          │
    │ 8 302 Location  │                              │          │          │
    │◀────────────────│                              │          │          │
    ························· after the response ···························
    │                 │ 9 click {event_id, code, ts}                       │
    │                 │───────────────────────────────────────────────────▶│
    │                 │                              │          │          │
```

| Tier | What it holds | TTL | Why it exists |
|------|---------------|-----|---------------|
| L1: in-process LRU | ~100K hottest entries per instance | 5 s | A viral link is one Redis key on one shard; L1 spreads it across every instance. The TTL is also the takedown bound |
| L2: Redis Cluster | `{url, status, expires_at, version}` | min(24 h, time until expiry) ± 10% jitter | Shared cache for the ~30 GB working set |
| L3: PostgreSQL replica | Everything | — | Source of truth for misses; falls back to the primary for unknown codes |

Every hit re-checks `expires_at`, so an expired link stops redirecting on time even while cached. Concurrent misses for the same code within one instance are coalesced into a single query (singleflight), and unknown codes are cached negatively for 60 s so random-code scans don't reach the database.

### Deactivating a link

```
 Owner app           Link API                   PostgreSQL    Redis     Pub/Sub    Redirect Svc
     │                   │                           │          │          │             │
     │ 1 PATCH disabled  │                           │          │          │             │
     │──────────────────▶│                           │          │          │             │
     │                   │ 2 UPDATE + outbox (1 tx)  │          │          │             │
     │                   │──────────────────────────▶│          │          │             │
     │                   │ 3 SET tombstone v+1                  │          │             │
     │                   │─────────────────────────────────────▶│          │             │
     │ 4 200 OK          │                           │          │          │             │
     │◀──────────────────│                           │          │          │             │
     ······························· outbox relay, < 1 s ·································
     │                   │                           │ 5 link-changed v+1  │             │
     │                   │                           │────────────────────▶│             │
     │                   │                           │          │          │ 6 evict L1  │
     │                   │                           │          │          │────────────▶│
     │                   │                           │          │          │             │
```

The status change and its outbox row commit in one transaction, so the invalidation survives a crash immediately after the commit. The Redis entry is overwritten with a versioned tombstone rather than deleted, and cache writes are a compare-and-set that only accepts a higher `version`, so a redirect that read the old row a moment earlier cannot write it back. If the pub/sub message is lost, the 5-second L1 TTL still bounds staleness.

### Counting clicks

```
Redirect Svc                        Kafka             Consumer         ClickHouse           Link API
      │                               │                   │                 │                   │
      │ 1 click {event_id, code, ts}  │                   │                 │                   │
      │──────────────────────────────▶│                   │                 │                   │
      │                               │ 2 poll batch      │                 │                   │
      │                               │──────────────────▶│                 │                   │
      │                               │                   │ 3 INSERT batch  │                   │
      │                               │                   │────────────────▶│                   │
      │                               │                   │                 │ 4 dedupe, roll up │
      │                               │ 5 commit offsets  │                 │                   │
      │                               │◀──────────────────│                 │                   │
      ··································· owner opens stats ·····································
      │                               │                   │                 │ 6 SELECT buckets  │
      │                               │                   │                 │◀──────────────────│
      │                               │                   │                 │ 7 series + as_of  │
      │                               │                   │                 │──────────────────▶│
      │                               │                   │                 │                   │
```

- The Redirect Service assigns a UUIDv7 `event_id` and publishes after the response through a bounded buffer and a batching producer (`acks=all`, idempotent producer). When Kafka is unavailable the buffer fills and then drops events, counting the drops so dashboards can flag partial data.
- Consumers build each batch from a fixed offset range and pass that range as ClickHouse's insert deduplication token, so a batch replayed after a crash is skipped before the materialized view counts it. `ReplacingMergeTree` on `event_id` collapses any remaining raw duplicates.
- Offsets are committed only after the insert succeeds: at-least-once delivery plus deduplicated inserts gives effectively-once counts.
- Dashboards query the per-minute rollup and return an `as_of` watermark derived from consumer progress.

## Database Schema

### Production schema

PostgreSQL holds everything that must be correct:

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE links (
  code        VARCHAR(10) PRIMARY KEY,            -- the uniqueness guarantee
  long_url    TEXT NOT NULL CHECK (length(long_url) <= 2048),
  owner_id    UUID REFERENCES users(id),
  is_custom   BOOLEAN NOT NULL DEFAULT false,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  expires_at  TIMESTAMPTZ,
  version     INTEGER NOT NULL DEFAULT 1,         -- If-Match and cache tombstones
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX links_owner_created ON links (owner_id, created_at DESC, code);   -- keyset pagination
CREATE UNIQUE INDEX links_alias_ci ON links (lower(code)) WHERE is_custom;     -- no look-alike aliases

CREATE TABLE link_outbox (
  id           BIGSERIAL PRIMARY KEY,
  code         VARCHAR(10) NOT NULL,
  change       TEXT NOT NULL,                     -- 'disabled' | 'enabled' | 'expiry'
  version      INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX link_outbox_pending ON link_outbox (id) WHERE published_at IS NULL;
```

ClickHouse holds events and rollups:

```sql
CREATE TABLE clicks (
  event_id      UUID,
  code          String,
  ts            DateTime64(3),
  referrer_host LowCardinality(String),
  country       LowCardinality(FixedString(2)),
  device        LowCardinality(String)
) ENGINE = ReplacingMergeTree
PARTITION BY toDate(ts)
ORDER BY (code, ts, event_id)
TTL toDate(ts) + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW clicks_per_minute
ENGINE = SummingMergeTree PARTITION BY toYYYYMM(minute) ORDER BY (code, minute)
AS SELECT code, toStartOfMinute(ts) AS minute, count() AS clicks
FROM clicks GROUP BY code, minute;
```

Redis keys: `link:{code}` (cache entry or tombstone), `link:neg:{code}` (negative cache), `idem:{owner}:{key}` (idempotency record), `rl:{scope}:{id}` (rate-limit counters).

When storage forces sharding (around 10 TB), `links` is hash-partitioned by `code`, so each code's uniqueness check stays on one shard. The owner's list then needs a separate `links_by_owner (owner_id, created_at, code)` index sharded by owner.

### Local schema

The local schema lives in [`backend/src/db/init.sql`](./backend/src/db/init.sql) and is loaded into fresh PostgreSQL volumes by Docker Compose. It maps to the production design like this:

| Production | Local | Difference |
|------------|-------|------------|
| `links` | `urls` (`short_code`, `long_url`, `user_id`, `expires_at`, `click_count`, `is_active`, `is_custom`) | Boolean `is_active` instead of `status`; no `version` column; a denormalized `click_count` |
| — | `key_pool` (`short_code`, `is_used`, `allocated_to`, `allocated_at`) | Local codes come from a pre-generated pool (see [Implementation Notes](#implementation-notes)) |
| `clicks` in ClickHouse | `click_events` in PostgreSQL | Same database as the links; aggregated at query time |
| `link_outbox` | — | No outbox; invalidation happens inline after the write |
| `users` + sessions in Redis | `users` + `sessions` tables, session cache in Valkey | Same idea |

## API Design

### Production API

```
POST   /api/v1/links                    create; Idempotency-Key → 201 | 409 alias taken | 422 invalid
GET    /api/v1/links?cursor=…&limit=50  owner's links, newest first (keyset pagination)
GET    /api/v1/links/{code}             details (owner or admin)
PATCH  /api/v1/links/{code}             deactivate or change expiry; If-Match: version → 200 | 412
GET    /api/v1/links/{code}/stats       ?from&to&tz&granularity → buckets + as_of + partial
GET    /{code}                          302 Location | 404 unknown | 410 disabled or expired
```

- Errors use `application/problem+json` (RFC 9457); rate limits are advertised with `RateLimit` headers.
- The redirect sets `Cache-Control: private, max-age=0` so neither browsers nor shared caches store it.
- `tz` makes "clicks per day" start at the viewer's midnight; buckets are computed server-side.

### Local routes

The local API is mounted under `/api/v1` with the redirect at the root; see [Implementation Notes](#implementation-notes) for behavior.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/auth/register`, `/login`, `/logout` | Session auth (cookie, also returns a bearer token) |
| GET | `/api/v1/auth/me` | Current user |
| POST | `/api/v1/urls` | Create a link (optional auth, custom code, `expires_in` seconds) |
| GET | `/api/v1/urls` | Owner's links (`limit`/`offset`) |
| GET, PATCH, DELETE | `/api/v1/urls/:shortCode` | Details, update `is_active`/`expires_at`, soft delete |
| GET | `/api/v1/analytics/:shortCode`, `/clicks` | Aggregates and raw events |
| GET, POST, PATCH | `/api/v1/admin/...` | Stats, URL/user management, key pool, expired-link cleanup |
| GET | `/:shortCode` | `302` redirect |
| GET | `/health`, `/health/detailed`, `/ready`, `/metrics` | Operations |

## Key Design Decisions

### 1. Random codes with a unique insert, not a key pool, counter or hash

Every scheme ends in the same primary-key insert, so the question is what to put in front of it. **Hashing** the URL makes two owners of the same URL share a code and its analytics, still needs collision handling, and reveals whether a URL was ever shortened. A **global counter** is enumerable — anyone can walk every link ever created — and becomes a cross-region dependency. **Counter blocks plus a keyed permutation** avoid both problems but add a sequence service and key management. A **pre-generated key pool** avoids collisions at insert time but adds lease bookkeeping and strands keys when an instance crashes. A **random code plus a unique insert** needs nothing extra and retries 0.5% of the time in year one; at ~10% occupancy new links move to eight characters. The cost is a small latency tail on creation.

### 2. `302` with `max-age=0`, not `301`

A `301` is semantically right (the mapping never changes) and would let browsers skip us on repeat visits — which is exactly the problem: those clicks would never be counted and a takedown could never reach users who had visited before. The product's value beyond redirection is analytics, and abuse response needs revocation, so every click must reach the service. That decision is the reason the cache tiers exist.

### 3. Bounded staleness instead of synchronous invalidation

Purging every cache in every region before acknowledging a takedown would couple an owner's click to the health of every region. Instead the system promises five seconds: outbox-driven eviction for speed, versioned tombstones against racing refills, and the L1 TTL as the hard bound if a message is lost. When the database is unreachable, redirects keep serving cached entries — safe because destinations never change and a takedown requires a database write anyway.

### 4. Analytics off the redirect path

A synchronous insert would put a database write, and that database's availability, in front of every redirect, and a `clicks = clicks + 1` counter would serialize a viral link's clicks behind one row lock. Publishing to Kafka after the response keeps redirects independent of analytics. The cost is that clicks can be lost when the buffer overflows during a Kafka outage — accepted and reported as partial data, because losing a redirect is worse than losing a count. Kafka is chosen over a work queue because it retains events for replay and supports multiple independent consumers.

## Consistency and Idempotency

| Operation | Guarantee | Mechanism |
|-----------|-----------|-----------|
| Create link | At most one link per client request | `Idempotency-Key` with an `NX` claim and a stored response (24 h) |
| Code uniqueness | One destination per code, forever | Primary key on `code`; codes never recycled |
| Update/deactivate | No lost updates between owner and admin | `version` column with `If-Match` → `412` |
| Cache vs database | Stale for at most 5 s after a change | Outbox + versioned tombstones + L1 TTL |
| Expiry | Never redirects after `expires_at` | Cache TTL ≤ time to expiry; every hit re-checks |
| Click counting | Effectively once | Event ID at the source, deduplicated batch inserts, offsets committed after insert |

Read-your-writes for a brand-new link holds because creation writes the cache, and a replica miss falls back to the primary.

## Security / Auth

- **Authentication:** session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`) backed by Redis; admins are a role on the user.
- **Authorization:** every link read, update and stats query checks ownership (or the admin role). Raw click data never leaves the service; reports are aggregates.
- **Input validation:** only `http`/`https` destinations up to 2,048 characters; aliases are 4–10 characters from `[A-Za-z0-9_-]` and not reserved route names; case-insensitive uniqueness for aliases blocks look-alikes.
- **Abuse:** destinations are screened against a malicious-URL list at creation and re-scanned periodically; takedowns use the 5-second propagation path.
- **Rate limiting:** per user for creation (100/hour), stricter per IP for anonymous creation, enforced in Redis so limits hold across instances; edge limits on redirects against code scanning.
- **Privacy:** country is derived from the IP at ingest and the IP is dropped; only the referrer's host is stored.

## Observability

- **Redirect:** latency by cache tier (L1/L2/replica/primary), hit ratios, negative-cache hits, `302`/`404`/`410` rates.
- **Creation:** latency, collision retries (a rising rate signals a filling code space), idempotency replays and conflicts.
- **Propagation:** outbox relay lag — this is the takedown SLO, alert above 5 s.
- **Analytics:** Kafka consumer lag, dropped events in Redirect buffers, duplicate batches skipped.
- Structured logs carry a request ID and the code; traces span LB → Redirect Service → Redis/PostgreSQL.

## Failure Handling

| Failure | Behavior | Mitigation |
|---------|----------|------------|
| Redis node down | Redirects slower; creation returns `503` (no idempotency guarantee) | L1 absorbs hot keys; singleflight and a circuit breaker protect replicas |
| PostgreSQL primary down | No creates or takedowns; redirects continue from caches and replicas | Replica promotion; `503` with `Retry-After` |
| Replica lag | A new link might miss on a replica | Creation warms the cache; replica miss falls back to primary |
| Kafka down | Analytics gap | Bounded buffer, counted drops, dashboards flag partial data |
| Consumer crash | Redelivery of uncommitted batches | Deduplicated batch inserts; offsets committed after insert |
| Pub/sub message lost | Takedown slower on some instances | L1 TTL bounds staleness to 5 s |
| Region outage | Redirects fail over | Every region has Redirect instances, Redis and replicas |

## Scalability Considerations

1. **Hot keys first.** A single viral link concentrates traffic on one Redis shard; the in-process L1 handles it.
2. **Redirect capacity** scales linearly with stateless instances; each region serves its own traffic.
3. **Click pipeline** scales by Kafka partitions and consumer instances; ClickHouse scales by shards.
4. **Link storage** reaches ~10 TB in a year or two; hash-shard `links` by code and move the owner listing to a separately sharded index.
5. **Multi-region:** one write primary is plenty at 600 writes/s; every region has replicas, Redis and Redirect instances. A link clicked in another region before replication falls back to the primary once and is then cached.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Code generation | Random 7 chars + unique insert | Key pool, counter, hash | Simplest correct option; ~0.5% retries in year one |
| Redirect status | `302` + `max-age=0` | `301` | Every click must reach us for analytics and takedowns |
| Redirect caching | L1 (5 s) + Redis + replicas | Database per request | 200K/s peak; the L1 TTL bounds staleness |
| Invalidation | Outbox + versioned tombstones | Delete after write | Survives crashes and racing refills |
| Click recording | Kafka after the response | Synchronous insert | Redirects never wait on analytics |
| Click storage | ClickHouse rollups | Counter column in PostgreSQL | No hot-row contention; time-series queries |
| Link store | PostgreSQL, shard later | Cassandra/DynamoDB from day one | Uniqueness is a primary-key insert |
| Creation safety | Client idempotency key | Body fingerprint dedupe | Retries can't duplicate; intentional duplicates allowed |

## Implementation Notes

### Actual runtime and data setup

[The API entry point](./backend/src/index.ts) serves authentication, URL management, analytics, administration, redirects, and operational endpoints in one Express process. [The worker](./backend/src/workers/analytics-worker.ts) is separate. The browser runs React 18 and uses Zustand plus direct fetch calls; there is no server-query cache library or live event transport.

[Compose](./docker-compose.yml) starts PostgreSQL 16, Valkey 7 with AOF, and RabbitMQ 3 management. Only PostgreSQL and Valkey have named data volumes. The schema initializes fresh PostgreSQL volumes, and each manual schema execution attempts to add more keys. There are no automatic users or migrations. The optional SQL fixture has nine links and 1,146 events; repeated seeding appends events while retaining existing counters. The administrator hash requires an explicit local reset for a known password, as shown in the README.

[Configuration](./backend/src/config.ts) defaults to API port 3000 and independently defaults `BASE_URL` to that address. Server variants use ports 3001–3003 without adjusting generated URLs or the Vite proxy. There is no load balancer, `.env` loader, or background cleanup service.

### Creation and the actual key pool

[The key service](./backend/src/services/keyService.ts) stores a batch in a process-local array. Allocation uses one transactional `UPDATE` over rows selected with `FOR UPDATE SKIP LOCKED`, preventing two current allocators from claiming the same pool row. The similarly named Redis `keyPoolCache` helper is unused.

```sql
SELECT short_code FROM key_pool
WHERE is_used = false AND allocated_to IS NULL
LIMIT $1 FOR UPDATE SKIP LOCKED
```

This pattern amortizes reservation across a batch; it still coordinates in PostgreSQL. Startup claims 100 keys. Every request awaits refill below 50 remaining keys, so refill is synchronous on that path, not a background task. Concurrent refill calls are not coalesced. There is no automatic pool generator or allocated-key expiry/reaper. Crashed processes strand unused reservations; reclaiming by age alone would be unsafe if a previous holder resumed.

When both local and database pools are empty, generation falls back to `Math.random` without reservation or collision retry. SQL pool generation uses `random()` and checks only pool uniqueness. Custom-alias preflight checks both tables, but races with subsequent generation remain; the final URL primary key can reject a collision. A generated/custom common namespace is not enforced as one atomic claim.

[URL creation](./backend/src/services/urlService.ts) commits the mapping, then marks a generated key used, then awaits a cache write whose errors are swallowed. A key-mark failure can report 400 after the link already exists. The configured 365-day default expiration is unused; absent or zero duration means no expiration, and negative values can create already-expired rows that are nevertheless cached.

URL validation checks HTTP(S) syntax and 2,048 JavaScript string units, not reachability or reputation. It lacks a complete input schema. Custom codes allow 4–20 characters while both tables allow 10; `metrics` and `ready` are not reserved and collide with earlier routes. Destinations are stored as supplied. PATCH cannot clear expiration with null because the route converts null to undefined.

### Redirect cache and lifecycle gaps

[The redirect router](./backend/src/routes/redirect.ts) uses its own lookup helper; the similar URL-service lookup is not the called implementation. [Mapping cache](./backend/src/utils/cache.ts) reads a destination string, with no expiry, active flag, or revision:

```typescript
const result = await redis.get(`url:${shortCode}`);
await redis.setex(`url:${shortCode}`, ttl || CACHE_CONFIG.urlTTL, longUrl);
```

The default TTL is 86,400 seconds. Only a miss reaches SQL's active/expiration predicates. Creation warms this cache regardless of expiration. Owner deletion or an explicit owner `is_active: false` update deletes it; expiry changes and [administrator status/cleanup writes](./backend/src/services/adminService.ts) do not. An in-flight old SQL read can refill after deletion. The current cache therefore has neither correct expiration nor the proposed five-second deactivation bound.

The response uses 302 without explicit Cache-Control. No human-visit proof follows from that status. Invalid, inactive, and expired cold lookups all return 404; dependency failures can return 500. Redis mapping errors become misses only after client retry behavior, and an awaited failed cache set can also delay a response.

### Click delivery and aggregation

The router schedules both queue publication and its SQL fallback with `setImmediate`, after choosing the redirect response. The fallback named `recordClickSync` is deferred too; it does not synchronously delay that response, though it consumes shared database capacity. A process failure before the callback loses the observation.

[Queue wiring](./backend/src/utils/queue.ts) declares durable `click-events` with a 24-hour message TTL and sends persistent messages through a plain channel. It uses no publisher confirms. Publisher confirmation and consumer acknowledgement cover different legs of delivery. [RabbitMQ's acknowledgement guide](https://www.rabbitmq.com/docs/confirms) explains that distinction.

The router ignores the publisher's boolean result when a connection appeared available, so publication failure does not trigger its SQL fallback. The underlying `sendToQueue` boolean is a buffer-flow signal, not a durable receipt; false requires handling backpressure, not assuming the event was never sent. See the [amqplib channel API](https://amqp-node.github.io/amqplib/channel_api.html#channel_sendToQueue).

Events contain code, timestamp, referrer, user agent, raw request IP, and a heuristic device type. There is no event ID, deduplication, IP hashing, geolocation, or unique-visitor algorithm. Country/city columns are not populated by this path.

The worker prefetches 10 messages but processes each with separate click INSERT and counter UPDATE statements. This is concurrent delivery, not batch insertion. Failure between writes leaves divergent counts; redelivery can duplicate an insert or both effects. Poisoned messages are requeued without backoff, attempt limits, or a dead-letter destination and can churn until TTL expiry.

Initial worker connection retries are bounded. A later connection-close callback reconnects the channel but does not restore the consumer. Broker connectivity can appear healthy while the worker no longer drains events. There is no automatic replay from another retained source.

[Analytics queries](./backend/src/services/analyticsService.ts) read raw PostgreSQL events directly. Total/referrer/device counts are all-time; daily activity covers the recent 30-day window and omits empty days. Queries run separately without a common snapshot. Global hourly grouping uses hour number without date, merging partial hours across the last-24-hour boundary and sorting by clock hour. There are no rollups, analytics cache, ClickHouse instance, or raw-event retention job.

The admin total-click statistic sums denormalized URL counters, while other totals count events. Active URL statistics ignore expiration. Pool-used counts do not include custom links. These quantities can disagree even without a display bug.

### Authentication, authorization, and browser behavior

[Authentication](./backend/src/services/authService.ts) uses bcrypt with 10 rounds and UUID session tokens. SQL sessions expire after seven days; Redis maps tokens to user IDs for seven days. The cookie is HttpOnly, SameSite=Lax, and Secure only in production mode. Login also returns the token for bearer use.

A warm session still reads the current user from PostgreSQL, so role changes and user deactivation take effect on the next authenticated request. It does not recheck the SQL session's expiry or deletion. A cache miss reloads an unexpired SQL session but grants a full new seven-day cache TTL instead of the remaining lifetime; bearer use can outlive SQL expiry. Logout deletes SQL first, then Redis; a cache failure can leave cached access and prevent cookie clearing. There is no coordinated protection from concurrent cache repopulation.

Session-cache errors propagate instead of using the mapping cache's fail-open behavior. [Optional authentication](./backend/src/middleware/auth.ts) catches such failures and continues anonymously, so even a browser with a cookie can create an unowned link during an authentication dependency failure.

Owned list/update/delete routes check the owner. Anonymous details are unrestricted, including inactive and expired rows; an authenticated details request is filtered to its owner. Both analytics routes require authentication but omit ownership checks, including raw events with IPs and user agents. Admin role changes have no last-administrator or self-demotion protection.

[Frontend authentication](./frontend/src/stores/authStore.ts) persists user state. Route guards call the server check only when no stored user exists. There is no universal expired-session interceptor, and logout does not reset [URL state](./frontend/src/stores/urlStore.ts) or invalidate outstanding requests. Older account/query responses can replace newer state.

Creation waits for a response before adding the returned link, but uses no operation key. Its shared loading/error state also covers list/delete operations. Inputs remain editable during submission, and success clears the current draft even if the user changed it. Copy failures only log to the console.

[The link list](./frontend/src/components/UrlList.tsx) fetches 50 rows without paging controls. Delete removes a row after server success, but reload returns inactive rows and the formatter omits status. Analytics fetches have no cancellation/context guard or freshness watermark. [Admin tables](./frontend/src/components/AdminDashboard.tsx) also fetch one page; searches are submitted explicitly, with no debounce or stale-response protection. There is no virtualization or automatic analytics refresh.

### Operational patterns actually wired

This project keeps shared helpers under `backend/src/utils/`, rather than `src/shared/`.

| Pattern | Actual wiring and purpose | Practical limit |
|---------|---------------------------|-----------------|
| Database breaker | [database.ts](./backend/src/utils/database.ts) wraps normal queries through [circuitBreaker.ts](./backend/src/utils/circuitBreaker.ts) to reduce repeated failing calls | Transactions and health queries bypass it; fallback replaces all failures with a generic open-circuit error |
| Prometheus metrics | [metrics.ts](./backend/src/utils/metrics.ts) and HTTP completion hooks record latency, counts, cache outcomes, and breaker state | No queue-depth metric; raw fallback paths can create unbounded labels; successful SQL durations exclude failures/transaction queries |
| Structured logs | [logger.ts](./backend/src/utils/logger.ts) and Pino HTTP record requests and service events | Most service logs do not use request context; URL error logs can include query secrets; no durable admin audit trail |
| General API limiter | Entry point applies 200 requests/minute by IP | Process-local store; creation's intended 100/hour middleware is after the terminal router; redirect limiter is unused |
| Health/readiness | `/health`, `/health/detailed`, and `/ready` inspect liveness, SQL, Redis status, and optional queue connection | No consumer-progress proof or active Redis PING; failed SQL health queries can leak a checked-out client |

The database breaker has a five-second timeout, 50% threshold after a minimum volume of 10, and a 30-second reset period. A timed-out query is not canceled and may commit after the caller sees failure. Its fallback can label ordinary query errors as circuit-open errors even when the circuit remains closed.

`dbConnectionsActive` counts open pool connections, not currently busy queries. `/metrics` first queries pool statistics in PostgreSQL, so a database outage can prevent scraping otherwise useful process metrics. Helmet's CSP is disabled unconditionally. Shutdown handlers close dependencies and exit without stopping HTTP admission or draining in-flight consumers.

### Simplified and omitted production capabilities

The demo uses one PostgreSQL database for mappings, users, sessions, and raw click history; one shared Valkey; and RabbitMQ instead of a large retained analytics log and dedicated warehouse. It omits region ownership, sharding, outbox propagation, durable operation receipts, revision-aware caches, event deduplication, dead-letter recovery, retention, abuse scanning, and CDN configuration.

[Four page smoke checks](./tests/smoke.spec.ts) and screenshot configuration establish only limited rendering coverage. The admin check uses Alice's ordinary user account and can pass after a redirect to another page. No cache-race, queue-recovery, transactional analytics, or production-load result was established by this documentation review; implementation defects are documented rather than repaired here.
