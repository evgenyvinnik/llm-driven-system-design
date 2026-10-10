# 🔗 URL Shortener (Bitly) — System Design Answer (Backend Focus)

*45-minute backend interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "A URL shortener looks like two endpoints and one table. What makes it a real design problem is the asymmetry: we create about 600 links a second but follow about 58,000. So I'm going to build two different paths — a careful write path that never gives one code to two people, and a redirect path that is little more than a cache lookup — and keep analytics completely off the redirect path."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope, targets, and the 100:1 read/write ratio |
| High-level architecture | 10 min | One overview diagram and the three core flows |
| Data model & API | 7 min | What lives where, and the contract |
| Deep dive 1: short codes | 7 min | Unique, unguessable codes without coordination |
| Deep dive 2: redirect hot path | 8 min | Caching, invalidation, 301 vs 302 |
| Deep dive 3: click analytics | 5 min | Counting 200K clicks/s without slowing redirects |
| Scale, failures, wrap-up | 3 min | What breaks first; the trade-offs I made |

---

## 🎯 Requirements & Scale (5 min)

"Let me pin down scope first, because 'URL shortener' can mean anything from a weekend project to Bitly's whole product."

### Functional requirements

1. **Create** a short link for a long HTTP(S) URL, optionally with a custom alias and an expiry date.
2. **Redirect**: `GET /{code}` sends the visitor to the destination.
3. **Manage**: owners list their links and deactivate them.
4. **Analytics**: per-link clicks over time, top referrers, devices and countries.
5. **Abuse response**: an administrator can take down a malicious link within seconds.

Out of scope: changing a link's destination after creation (it silently changes what an already-shared URL means, so I'd treat it as a new link), custom domains, QR codes, and billing.

### Non-functional requirements

| Requirement | Target | Why |
|-------------|--------|-----|
| Redirect latency | p99 < 50 ms server-side, in region | It sits in front of someone else's page load |
| Redirect availability | 99.99% | A dead short link breaks every place it was shared |
| Creation latency | p99 < 300 ms | Interactive, but not the hot path |
| Correctness | A code maps to exactly one destination, forever | Links live in emails and printed material for years |
| Takedown | Deactivation effective within 5 s | Abuse and phishing response |
| Analytics freshness | < 1 minute behind | Dashboards, not billing |

### Capacity estimate

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Link creations | 50M/day → ~600/s average, ~5K/s peak | One primary database handles the writes |
| Redirects | 5B/day → ~58K/s average, ~200K/s peak | Cache-first, horizontally scaled, stateless |
| Read:write ratio | ~100:1 | Separate read and write paths |
| Link storage | ~500 B × 50M/day ≈ 25 GB/day ≈ 9 TB/year | One node for year one, shard by code later |
| Click events | ~200 B × 5B/day ≈ 1 TB/day raw | Column store, 90-day raw retention, rollups kept |
| Hot set | ~100M active links × ~300 B ≈ 30 GB | Fits in a Redis cluster; viral links need an in-process tier |
| Code space | 62⁷ ≈ 3.5 trillion seven-character codes | 18B links/year fills ~0.5% of it per year |

"Two numbers drive the whole design: 200K redirects per second at peak, which means the redirect must be a cache hit, and 3.5 trillion possible codes, which means random codes will rarely collide."

---

## 🏗️ High-Level Architecture (10 min)

"I'll draw the whole system first, then walk through the three journeys that matter: creating a link, following it, and counting the click."

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

1. **Create (1).** The owner's app calls the Link API. It picks a random code, inserts the link into PostgreSQL — the primary key is what guarantees one destination per code — warms the Redis entry, and returns the short URL.
2. **Redirect (2).** The Redirect Service checks its in-process cache, then Redis, then a PostgreSQL read replica, and answers `302`. It never touches the primary database or the analytics stack while the visitor waits.
3. **Count (3).** After the `302` is sent, the Redirect Service publishes a click event to Kafka. Consumers dedupe by event ID and write to ClickHouse; the Link API reads ClickHouse rollups for the owner's dashboard.

| Component | Responsibility | Scales with | Notes |
|-----------|----------------|-------------|-------|
| Load balancer | TLS, path routing | Connections | GeoDNS or anycast across regions |
| Link API | Create, manage, auth, stats queries | Owners (~600 writes/s) | Stateless; a handful of instances |
| Redirect Service | Code → `302` | Visitors (~200K/s) | Stateless; dozens of instances per region, each with an LRU |
| Redis Cluster | Link cache, idempotency keys, rate limits | Hot set (~30 GB) | Losing it makes redirects slower, never wrong |
| PostgreSQL | Source of truth for links and users | Link count | Primary plus read replicas; hash-shard by code later |
| Kafka | Durable click log | Click rate | Partitioned by code; 7-day retention for replay |
| Click consumers | Dedupe, enrich, batch insert | Consumer lag | Commit offsets only after the insert |
| ClickHouse | Raw clicks and per-minute rollups | Events | 90-day raw TTL; rollups kept indefinitely |

"Why split the Link API from the Redirect Service when they share a database? Because their profiles are opposite. The Redirect Service carries 100 times the traffic, has the tighter latency target, and must keep working when Kafka, ClickHouse or the primary database are down. Splitting them lets me scale, deploy and degrade each one independently. The first version could ship as one binary with two route groups, but I'd still run them as separate instance pools."

### Flow 1: creating a link

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

"The idempotency key comes from the client: the owner's app generates one per submitted form. If the response is lost and the app retries, step 2 finds the stored response and returns the original `201` instead of creating a second link. The `NX` claim means two concurrent retries can't both reach the insert — the second one gets `409 Conflict` and retries shortly after. Step 7 warms the cache so the very first click doesn't depend on replica lag."

### Flow 2: following a link

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

"This is the worst case — a miss at both cache tiers. On an L1 hit only steps 1, 2 and 8 happen, which is well under a millisecond of server time. Step 9 is after the response is flushed: the visitor never waits for analytics."

### Flow 3: counting the click

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

"Offsets are committed only after the insert succeeds, so a consumer crash means a batch is delivered again. Each batch covers a fixed range of Kafka offsets and is inserted with that range as ClickHouse's deduplication token, so a replayed batch is skipped before the rollup counts it; the raw table also collapses duplicate event IDs as a backstop."

---

## 💾 Data Model (4 min)

"PostgreSQL holds anything that must be correct, Redis holds copies, and ClickHouse holds events."

| Store | Table / key | Key columns | Indexes and notes |
|-------|-------------|-------------|-------------------|
| PostgreSQL | `links` | `code` (PK, ≤ 10 chars), `long_url`, `owner_id`, `status` (active/disabled), `expires_at`, `created_at`, `version` | The primary key *is* the uniqueness guarantee; `(owner_id, created_at DESC, code)` serves the owner's list |
| PostgreSQL | `users` | `id`, `email` (unique), `password_hash`, `role` | Small; session lookups go through Redis |
| PostgreSQL | `outbox` | `id`, `code`, `change`, `version`, `created_at` | Written in the same transaction as a link change; a relay publishes it |
| Redis | `link:{code}` | `{url, status, expires_at, version}` | TTL = min(24 h, time until expiry) |
| Redis | `idem:{owner}:{key}` | Request hash + stored response | 24 h TTL |
| ClickHouse | `clicks` | `event_id`, `code`, `ts`, `referrer_host`, `country`, `device` | Partitioned by day; replayed batches skipped by insert deduplication; `ReplacingMergeTree` on `event_id` as a backstop; 90-day TTL |
| ClickHouse | `clicks_per_minute` | `code`, `minute`, `count` | Materialized view (`SummingMergeTree`), kept indefinitely |

"Why PostgreSQL and not DynamoDB or Cassandra? The access pattern is key-value, so either would work, and at 50 TB I'd seriously consider one. I start with PostgreSQL because the one thing that must never go wrong — two owners getting the same code — is a primary-key insert there. In Cassandra I'd need lightweight transactions, which are Paxos rounds, for the same guarantee. When storage forces it, around year two or three, I hash-shard by code: each code lives on exactly one shard, so the uniqueness check stays local. The owner's link list then becomes a cross-shard query, so I'd maintain a separate `links_by_owner` index sharded by owner."

---

## 🔌 API Design (3 min)

```
POST   /api/v1/links                    create; Idempotency-Key header → 201 | 409 alias taken | 422
GET    /api/v1/links?cursor=…&limit=50  owner's links, newest first (keyset pagination)
GET    /api/v1/links/{code}             details (owner or admin only)
PATCH  /api/v1/links/{code}             deactivate or change expiry; If-Match: version
GET    /api/v1/links/{code}/stats       ?from&to&granularity → series + as_of watermark
GET    /{code}                          302 to destination | 404 unknown | 410 disabled or expired
```

A few decisions worth saying out loud:

- **Idempotency-Key on create.** Creation is not naturally idempotent — two identical requests should normally produce two links — so the client has to tell me which requests are retries. Same key with a different body is a `422`, as in the IETF draft.
- **Keyset pagination.** A cursor of `(created_at, code)` stays fast at page 500; `OFFSET 25000` reads and discards 25,000 rows.
- **`If-Match` on PATCH.** The `version` column gives optimistic concurrency, so an owner's change and an admin takedown can't silently overwrite each other.
- **Errors as `application/problem+json`** (RFC 9457) and **rate limits** advertised with `RateLimit` headers: 100 creations/hour per user, stricter per IP for anonymous creation.
- **`410 Gone` for disabled or expired links** instead of `404`: it's honest, and crawlers drop the URL. Both render a small human-readable page.

---

## 🔧 Deep Dive 1: Generating Unique Short Codes (7 min)

"A code has to be unique forever, short, and unguessable. That last one matters more than people expect: sequential codes let anyone enumerate every link ever created, and people shorten private document links all the time."

| Approach | How it works | Where it breaks |
|----------|--------------|-----------------|
| ❌ Hash of the URL | Base62 of the first 42 bits of SHA-256(url) | Two owners shortening the same URL collide and share analytics; different URLs still collide; it reveals whether a URL was ever shortened |
| ❌ Global counter | `nextval()` → base62 | Sequential and enumerable; a single sequence becomes a cross-region dependency |
| ⚠️ Counter blocks + permutation | Each instance leases 10,000 IDs; a keyed Feistel permutation scatters them | No retries ever, but adds a sequence service, key management, and a permutation nobody on call understands at 3 a.m. |
| ⚠️ Pre-generated key pool | A job mints random codes into a table; instances lease batches | No collisions at insert time, but crashed instances strand leased keys unless leases expire; a second table of billions of rows |
| ✅ Random code + unique insert | 7 chars from a CSPRNG; `INSERT … ON CONFLICT DO NOTHING`; new code if 0 rows | Occasional retries — and nothing else |

**Why random works here.** After one year at 18 billion links the space is about 0.5% full, so 1 insert in 200 needs a second attempt and 1 in 40,000 needs a third. After five years it's 2.6%. That's a far cheaper price than any coordination scheme. When occupancy passes ~10%, new links get eight characters (218 trillion codes); old codes keep working, so there's no migration.

**Why the alternatives fail.** Every scheme that pre-reserves codes still ends in the same primary-key insert, so it adds a second source of truth without removing the first. Hashing breaks per-owner analytics and leaks information. Counters are enumerable unless you add a permutation, at which point you've built a small cryptosystem to avoid a 0.5% retry rate.

**What I give up.** A small latency tail — one extra round trip for 0.5% of creations — and codes that consume the space randomly. I would never recycle expired codes anyway: a reused code sends old bookmarks to an unrelated site.

**Custom aliases** go through the same insert with no retry: `409` if taken. A reserved-word list blocks route names (`api`, `admin`, `login`, `health`, `metrics`), and I keep a unique index on the lowercased alias so `Sale` and `sale` can't belong to different owners — that's a phishing vector.

> "The repo actually implements the key-pool variant, precisely to study its failure mode: batches leased with `FOR UPDATE SKIP LOCKED`, leases that expire, and a reaper that reclaims keys stranded by a crashed process."

---

## 🔧 Deep Dive 2: The Redirect Hot Path (8 min)

"The redirect has one job: turn a code into a `Location` header in a few milliseconds, survive a viral spike, and stop working within five seconds of a takedown."

### 301 or 302?

| Option | Behavior | Consequence |
|--------|----------|-------------|
| ❌ `301 Moved Permanently` | Browsers cache it indefinitely | Repeat clicks never reach us: no analytics, and a takedown can't reach anyone who visited before |
| ✅ `302 Found` + `Cache-Control: private, max-age=0` | Every click reaches us | Complete analytics and effective takedowns, at the cost of serving every click |

"This is the most expensive decision in the system — it's why everything else on this path exists. A `301` would cut our redirect traffic dramatically, but the product is the analytics, and a link we can't revoke is a liability."

### Three cache tiers

1. **L1, in-process LRU** (~100K entries, 5-second TTL, per Redirect instance). A viral link getting 500K clicks a minute is a single Redis key on a single shard; L1 absorbs it across all instances. The 5-second TTL is also my upper bound on takedown lag.
2. **L2, Redis Cluster**, cache-aside. Entries hold `{url, status, expires_at, version}` with a TTL of `min(24 h, time until expiry)`, and every hit re-checks `expires_at`, so an expired link stops on time even while it's cached.
3. **L3, PostgreSQL read replicas.** A brand-new link might not have replicated yet, but creation writes the cache (flow 1, step 7), and a replica miss falls back to the primary. That fallback only fires for unknown codes, which I also cache negatively.

**Stampede protection.** If a hot entry expires, 2,000 concurrent requests on one instance would all miss together. Each instance coalesces concurrent misses for the same code into one query (a "singleflight" map of in-flight promises). Negative entries for unknown codes (60 s) stop random-code scanners from reaching the database, and TTLs get ±10% jitter so popular entries don't expire in lockstep.

### Takedowns within five seconds

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

"Three details make this reliable. First, the outbox row commits in the same transaction as the status change, so the invalidation can't be lost if the Link API crashes after the commit. Second, I overwrite the Redis entry with a versioned tombstone instead of deleting it: a redirect that read the old row a millisecond earlier would otherwise put the stale entry back. The cache write is a small Lua compare-and-set that only accepts a higher version. Third, if the pub/sub message is lost entirely, the 5-second L1 TTL still bounds the damage."

**The trade-off.** I'm choosing availability over perfect freshness. If PostgreSQL is unreachable, redirects keep serving from Redis with entries up to 24 hours old. That's safe because destinations never change after creation, and a takedown needs a database write anyway, so there's nothing newer to miss. What I give up is a guarantee of *immediate* revocation: the system promises five seconds, not zero, and that has to be written into the abuse team's runbook.

---

## 🔧 Deep Dive 3: Click Analytics at 200K Events per Second (5 min)

"The rule for analytics is that it must never slow down or break a redirect. Everything follows from that."

1. **Publish after the response.** The Redirect Service drops each event into a bounded in-memory buffer. The Kafka producer batches with a 5 ms linger, `acks=all`, and the idempotent producer enabled. If Kafka is down, the buffer fills (50 MB is about 250,000 events) and then drops — and counts the drops, so the dashboard can say "partial data for 14:02–14:07" instead of silently under-reporting.
2. **Assign the event ID at the source.** A UUIDv7 created in the Redirect Service makes every downstream retry the *same* event. Kafka gives at-least-once delivery and consumers commit offsets only after inserting. A batch replayed after a crash carries the same offset range as its deduplication token, so ClickHouse skips it before the materialized view can count it twice. At-least-once delivery plus a deduplicated write means each click is counted once.
3. **Never `UPDATE links SET clicks = clicks + 1`.** A viral link would serialize 50,000 row updates per second on one row, behind one lock. Aggregation belongs in the column store.
4. **Roll up, then query rollups.** A materialized view keeps per-minute counts; dashboards read those and return an `as_of` watermark (the consumer's progress) so the UI can show how fresh the numbers are.
5. **Minimize what we keep.** Derive country from the IP at ingest and then drop the IP; store the referrer's host, not its full URL, which can contain tokens.

| Option | Why / why not |
|--------|---------------|
| ✅ Kafka | Retained, replayable log: if an aggregation bug is found, I re-consume last week. Partitioning by code keeps per-link order, and new consumers (fraud detection, billing) can read the same stream |
| ❌ RabbitMQ | Deletes a message once acknowledged, so there's no replay. Fine for the local demo, wrong for an event log |
| ❌ Synchronous insert | Puts a database write, and that database's availability, in front of every redirect |

"What I give up is completeness during a Kafka outage: I'd rather lose some clicks — and say so on the dashboard — than lose redirects. If clicks became billable, I'd flip that: buffer to local disk on every Redirect instance and accept the extra operational weight."

---

## 📈 Scale, Failures & Observability (2 min)

**What breaks first, in order:** a single viral link overloading one Redis shard (answered by L1); click-pipeline lag during spikes (more partitions and consumers, and the dashboard reports the lag); and PostgreSQL storage at ~9 TB/year (hash-shard by code, with the owner index sharded separately).

| Failure | What users see | Mitigation |
|---------|----------------|------------|
| Redis node down | Slightly slower redirects | L1 absorbs hot keys; singleflight and a circuit breaker protect the replicas |
| PostgreSQL primary down | Can't create or deactivate; redirects keep working | Replica promotion; Link API returns `503` with `Retry-After` |
| Kafka down | Gap in analytics | Bounded buffer, drop and count; dashboard flags partial data |
| Region outage | Redirects fail over via GeoDNS | Each region has replicas, Redis and Redirect instances; creation needs the primary region |
| Random-code scanning | Nothing, if mitigated | Negative cache and per-IP limits at the edge |

**Multi-region.** A single write primary is fine at 600 writes/s. Every region runs Redirect instances, Redis and read replicas. A link created in us-east and clicked in eu-west 100 ms later misses the European replica, falls back to the primary, and caches the answer — a rare, slower path, not a broken one.

**What I'd watch:** redirect p99 by cache tier, L1 and L2 hit ratios, the replica-fallback rate, outbox relay lag (that's takedown propagation, so alert above 5 s), Kafka consumer lag, dropped click events, and the creation retry rate — a rising retry rate is my early warning that the code space is filling.

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Code generation | Random 7 chars + unique insert | Hash, counter, or key pool | Simplest correct option; ~0.5% retry rate |
| Redirect status | `302` + `max-age=0` | `301` | Analytics and takedowns need every click |
| Redirect caching | L1 (5 s) + Redis + replicas | Database on every request | 200K/s peak; the L1 TTL bounds takedown lag |
| Invalidation | Outbox + versioned tombstones | Delete-and-hope | Survives crashes and racing refills |
| Click recording | Kafka, after the response | Synchronous insert | Redirects never wait on analytics |
| Click storage | ClickHouse rollups | Counter column in PostgreSQL | No hot-row contention; time-series queries |
| Link store | PostgreSQL, shard later | Cassandra or DynamoDB from day one | Uniqueness is a primary-key insert; defer sharding until storage forces it |

"If I had more time, I'd add malicious-URL screening at creation and periodic re-scanning — a link can turn bad after it's created — then custom domains with automated certificates, and per-tenant quotas."
