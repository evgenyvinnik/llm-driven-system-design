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
| POST | `/api/v1/urls` | Create a link (optional auth, custom code, `expires_in` seconds, optional `Idempotency-Key`) → `201`, `400` invalid, `409` code taken or key in flight, `422` key reused with another body |
| GET | `/api/v1/urls` | Owner's links (`limit`/`offset`, clamped) |
| GET, PATCH, DELETE | `/api/v1/urls/:shortCode` | Details, update `is_active`/`expires_at` (`null` clears it), soft delete |
| GET | `/api/v1/analytics/:shortCode`, `/clicks` | Aggregates and raw events; owner or admin only (`403` otherwise) |
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

The local project runs all three journeys — create, redirect, count — on a single-node stack: one Express process, one analytics worker, PostgreSQL 16, Valkey 7 and RabbitMQ 3 from [`docker-compose.yml`](./docker-compose.yml), and a React 18 + TanStack Router + Zustand dashboard. This section maps the production design above to what the code does today (last reviewed 2026-10-10).

### Production design → local implementation

| Production design | Local implementation | Where |
|-------------------|----------------------|-------|
| Link API and Redirect Service as separate pools | One Express app; `/api/v1/*` routers plus the root-mounted redirect | [index.ts](./backend/src/index.ts), [routes/](./backend/src/routes/) |
| Random code + unique insert | Pre-generated key pool leased in batches of 100, with expiring leases and a reaper | [keyService.ts](./backend/src/services/keyService.ts) |
| L1 + Redis + read replicas | Redis cache-aside with expiry-bounded TTLs, a negative cache and per-process request coalescing; no in-process L1, no replicas | [urlService.ts](./backend/src/services/urlService.ts), [cache.ts](./backend/src/utils/cache.ts) |
| Outbox + pub/sub + versioned tombstones | Inline invalidation after every lifecycle write, plus a 10-second guard key that blocks racing refills | [cache.ts](./backend/src/utils/cache.ts) |
| Kafka → consumers → ClickHouse | RabbitMQ with publisher confirms → worker → `click_events` in PostgreSQL, deduplicated by `event_id`; retry queue and dead-letter queue | [queue.ts](./backend/src/utils/queue.ts), [clickEvents.ts](./backend/src/utils/clickEvents.ts), [analytics-worker.ts](./backend/src/workers/analytics-worker.ts) |
| `Idempotency-Key` on create | Implemented as described in [Consistency and Idempotency](#consistency-and-idempotency) | [idempotency.ts](./backend/src/utils/idempotency.ts) |
| Rate limits in Redis | Redis fixed-window store for express-rate-limit, `RateLimit` draft-7 headers | [rateLimit.ts](./backend/src/middleware/rateLimit.ts) |
| `version` + `If-Match` | Not implemented: last write wins | — |
| Rollups with `as_of` | Aggregation queries over raw `click_events` at read time | [analyticsService.ts](./backend/src/services/analyticsService.ts) |

### Short codes: why the local build uses a key pool

The production design argues for random codes; the local build deliberately implements the key-pool alternative because its failure modes are the interesting part to study. An instance leases 100 unused codes in one statement, and `SKIP LOCKED` lets concurrent instances refill without queueing behind each other:

```sql
UPDATE key_pool SET is_used = false, allocated_to = $1, allocated_at = NOW()
WHERE short_code IN (
  SELECT short_code FROM key_pool
  WHERE is_used = false AND allocated_to IS NULL
  LIMIT $2 FOR UPDATE SKIP LOCKED)
RETURNING short_code
```

- **Leases expire.** A lease lasts `KEY_LEASE_TTL_MS` (60 min). Each instance stamps the batch before leasing and discards local keys 10 minutes before expiry, so a paused process doesn't use a code that may have been handed out again. `reclaimStaleKeys()` runs at startup and every 5 minutes: it marks pool rows already present in `urls` as used, and releases unused leases older than the TTL. The TTL must be identical on every instance.
- **Creation is atomic.** The `urls` insert and marking the key used share one transaction. A unique violation (`23505`) on a generated code retires that key and retries with a fresh one, up to three times, then returns `503`. The empty-pool fallback draws from `crypto.randomInt`.
- **Custom codes** are 4–10 characters from `[A-Za-z0-9_-]` (the column is `VARCHAR(10)`), not a reserved word (`api`, `admin`, `metrics`, `ready`, `dashboard`, …), and checked against both `urls` and `key_pool`; the primary key still decides races, returning `409`.
- **Remaining limits:** custom codes are not registered in `key_pool`, so the generator can still mint one (the `23505` retry handles it); the reaper's "mark used" step scans all unused pool rows, fine for 10,000 keys but not for billions.

### Redirect path

`resolveShortCode()` is the only lookup the redirect route uses. One `MGET` reads the positive entry `url:{code}` and the negative entry `url:neg:{code}`; a positive hit is served only if its `expiresAt` hasn't passed. On a miss, concurrent requests for the same code in one process share a single PostgreSQL query. Fills never outlive the link:

```typescript
// backend/src/utils/ttl.ts — 0 means "don't cache"
if (expiresAtMs === null) return maxTtlSeconds;
const remainingSeconds = Math.floor((expiresAtMs - nowMs) / 1000);
return remainingSeconds <= 0 ? 0 : Math.min(maxTtlSeconds, remainingSeconds);
```

- Unknown, inactive and expired codes are cached negatively for 60 seconds. Codes that cannot exist (wrong length or characters, such as `favicon.ico`) return `404` without touching Redis or PostgreSQL.
- Every lifecycle write — owner update or delete, admin deactivate or reactivate, expired-link cleanup — deletes both cache entries and sets a 10-second guard key `url:inv:{code}` in one `MULTI`. Fills are Lua scripts that write only while no guard exists, so a lookup that read the old row cannot put it back.
- Both `302` and `404` responses carry `Cache-Control: private, no-store`.
- **Remaining limits:** coalescing works within one process only; a failed invalidation is logged and the entry lives until its TTL; a lookup stalled for more than 10 seconds could still write a stale entry; for 10 seconds after a write, misses for that code go to PostgreSQL.

### Click pipeline

The redirect assigns `event_id = crypto.randomUUID()` and dispatches the click after `res.redirect()`. Publishing uses a RabbitMQ confirm channel; a broker nack, a closed channel or a 5-second timeout falls back to inserting directly, and a full socket buffer waits up to 2 seconds for `drain` before falling back. Both paths persist through one function, so a redelivery, or a late confirm racing the fallback, never double counts:

```sql
-- backend/src/services/analyticsService.ts, inside one transaction
INSERT INTO click_events (event_id, short_code, referrer, user_agent, ip_address, device_type, clicked_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (event_id) DO NOTHING RETURNING id;
-- only if a row was inserted:
UPDATE urls SET click_count = click_count + 1 WHERE short_code = $1;
```

- **Retries without poison loops.** The main `click-events` queue keeps its original arguments (changing them would break `assertQueue` on existing brokers). A transient failure republishes a copy to `click-events.retry` with `x-retry-count + 1` and a 10-second per-message expiration that dead-letters it back to `click-events`; after five attempts — or immediately for malformed messages and SQLSTATE class 22/23 errors — it goes to `click-events.dlq` with the reason in its headers.
- **Reconnects.** Connection attempts back off from 5 to 60 seconds, a closed channel recycles the connection, and the consumer is re-attached after every reconnect. The worker waits for the broker indefinitely instead of exiting.
- **Reports** aggregate raw `click_events` at query time; hourly buckets use `date_trunc('hour', clicked_at)`. Analytics endpoints require the link's owner or an administrator (`403` otherwise).
- **Remaining limits:** a crash between responding and dispatching loses that click (there is no outbox); retries use a fixed delay; dead letters are replayed by hand; seeded rows have a null `event_id`. The retry and dead-letter logic is covered by tests against a fake amqplib channel but was not run against a live broker in the 2026-10 review.

### Creation and idempotency

`POST /api/v1/urls` runs the creation rate limiter, optional authentication, then the idempotency middleware. With an `Idempotency-Key` header, the key is claimed in Redis with `SET … NX EX 60` under `idempotency:{user or anonymous}:{key}`, storing a SHA-256 fingerprint of the method, path and body. A completed key replays the stored `2xx` response with `Idempotent-Replayed: true`; a key still in flight returns `409` with `Retry-After: 1`; the same key with a different body returns `422`; a non-`2xx` result releases the claim so the client can retry. Without the header, two identical requests create two links. **Limit:** the middleware fails open — during a Redis outage a retried create can produce a duplicate.

The dashboard generates one key per submitted draft and reuses it when the same draft is resubmitted after a failure; a changed draft gets a new key.

### Authentication, authorization and rate limiting

- bcrypt (10 rounds) and UUID session tokens stored in PostgreSQL and cached in Valkey with a TTL equal to the session's remaining lifetime; the cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production. Logout evicts Redis, deletes the SQL row, then evicts again, returning `503` if revocation could not be confirmed.
- Owner checks on list, update, delete and analytics; administrators can manage any link.
- Two Redis-backed limiters shared across instances: 200 requests/minute on `/api` and 100 creations/hour, per IP, with `RateLimit-Policy` and `RateLimit` headers. They skip limiting while Redis is down. `trust proxy` is not configured, so behind a proxy every client would share one IP.
- The seeded `admin@bitly.local` hash matches no known password; reset it before using the admin dashboard (see the [README](./README.md)).

### Operations

[metrics.ts](./backend/src/utils/metrics.ts) exports request latency, cache hits and misses, redirect outcomes, key-pool state (`key_pool_reclaimed_total`), click dispatch path (`click_event_dispatch_total`), duplicates, retries and dead letters (the worker serves its own metrics on `WORKER_METRICS_PORT`). Pino writes structured logs. `/health`, `/health/detailed`, `/ready` and `/metrics` are served by the API. Plain queries go through an Opossum circuit breaker; transactions bypass it. Shutdown stops the reaper, closes the HTTP server, waits for pending click dispatches, then closes RabbitMQ, PostgreSQL and Redis, with a forced exit after 10 seconds.

### Verification (2026-10-10)

- `npm test` in `backend/` runs 132 offline vitest tests (TTL and cache logic, idempotency, rate limiting, key leasing, URL service, click events, queue retry/DLQ routing against a fake channel, analytics and auth services). Backend `tsc`, lint and build, and frontend `tsc`, lint and build, are clean.
- Against real PostgreSQL 16 and Redis with RabbitMQ absent (the sync-fallback path): `init.sql` loads twice without errors; idempotent replay, `409` and `422` behave as described, and five parallel requests with one key create one row; a link with a 2-second expiry returns `404` after expiry even though it was cached; deactivation and reactivation take effect on the next request; 25 concurrent redirects produce exactly 25 click rows; analytics return `200` to the owner and admin, `403` to another user; `SIGTERM` during a burst loses no dispatched clicks.

### Simplified or omitted

There is no in-process L1 cache, read replica, outbox relay, Kafka, ClickHouse, rollup table, `version` column, multi-region deployment, CDN, or malicious-URL screening. Analytics share the PostgreSQL instance with link data. Four Playwright smoke tests (`npm run test:smoke bitly` from the repository root) check page rendering only.
