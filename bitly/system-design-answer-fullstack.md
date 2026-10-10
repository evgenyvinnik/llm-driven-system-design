# 🔗 URL Shortener (Bitly) — System Design Answer (Full-Stack Focus)

*45-minute full-stack interview. This is a proposed production design; what this repository actually runs is described in [architecture.md → Implementation Notes](./architecture.md#implementation-notes).*

> "As a full-stack engineer I want to follow one link through its whole life — created in the dashboard, clicked a million times, counted, and reported back to its owner — and get the contracts between the layers right, so each layer can fail or lag without breaking the others. Three contracts carry most of the weight: an idempotency key that makes creation safe to retry, a version that makes takedowns and edits safe to race, and an `as_of` timestamp that makes analytics honest about lag."

| Phase | Time | What I want the interviewer to leave with |
|-------|------|--------------------------------------------|
| Requirements & scale | 5 min | Scope and the targets on both sides of the wire |
| End-to-end architecture | 8 min | One diagram from the owner's browser to ClickHouse, plus the core flows |
| Data model & API contract | 7 min | Server tables, client cache keys, and the fields both sides rely on |
| Deep dive 1: exactly one link per click | 8 min | Idempotency from the button to the database |
| Deep dive 2: takedowns end to end | 7 min | From the Deactivate button to every cache in five seconds |
| Deep dive 3: from click to chart | 7 min | Event pipeline plus an honest dashboard |
| Failures, scale, wrap-up | 3 min | What each failure looks like to a user |

---

## 🎯 Requirements & Scale (5 min)

**Functional.** Owners create short links (optional custom alias and expiry), browse and search their links, deactivate them, and view per-link analytics: clicks over time, referrers, devices, countries. Visitors follow `GET /{code}` and get redirected. Admins take down abusive links. Out of scope: editing destinations, custom domains, QR codes, billing.

| Side | Requirement | Target |
|------|-------------|--------|
| Backend | Redirect latency / availability | p99 < 50 ms in region / 99.99% |
| Backend | Creation latency | p99 < 300 ms |
| Backend | Takedown propagation | Effective everywhere within 5 s |
| Backend | Analytics freshness | < 1 minute behind |
| Frontend | Dashboard load | LCP < 2.0 s on mid-range mobile; initial JS < 170 KB gzipped |
| Frontend | Responsiveness | INP < 200 ms with 50K links in the list |
| Both | Correctness | One click on Create makes at most one link, even across timeouts and refreshes |

**Scale.** 50M creations/day (~600/s, 5K/s peak) against 5B redirects/day (~58K/s, 200K/s peak) — a 100:1 read/write ratio. Links grow ~9 TB/year; click events ~1 TB/day raw. Seven base62 characters give 3.5 trillion codes, so a year of links fills only ~0.5% of the space.

"The ratio tells me the redirect path must be a cache lookup that never waits on anything else, and the dashboard side tells me the API needs real pagination and pre-aggregated stats — not because of the backend, but because a 50,000-row JSON response would ruin the frontend."

---

## 🏗️ End-to-End Architecture (8 min)

```
  ┌──────────────────────┐                          ┌──────────────────────┐
  │ Owner's browser: SPA │                          │ Visitor's browser    │
  │ Query cache, draft + │                          │ just follows the 302 │
  │ Idempotency-Key      │                          │                      │
  └──────────┬───────────┘                          └──────────┬───────────┘
             │ (1) POST /api/v1/links                          │ (2) GET /aZ3kq9x
             │ (3) GET /api/v1/links/{code}/stats              │
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
     │       │       │ SET/DEL        GET link:{code}   │      │       │ click
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

1. **Create (1).** The SPA freezes the form with an idempotency key and posts it. The Link API inserts the link into PostgreSQL (the primary key guarantees one destination per code), warms Redis, and returns the link, which the SPA inserts into its cached list.
2. **Redirect (2).** The visitor's browser hits the Redirect Service, which answers `302` from its in-process cache, Redis or a read replica. After responding, it publishes a click event to Kafka; consumers dedupe and write to ClickHouse.
3. **Stats (3).** The SPA asks for a link's stats for a range and time zone; the Link API reads ClickHouse rollups and returns the buckets with an `as_of` watermark, which the UI displays.

| Layer | Choice | Why |
|-------|--------|-----|
| Dashboard | React SPA, TanStack Query for server state, URL params for filters | Authenticated, no SEO; the query cache handles dedupe, retries and invalidation |
| Link API | Stateless service | Owner-facing CRUD, auth, stats queries; ~600 writes/s |
| Redirect Service | Separate stateless pool with an in-process LRU | 100× the traffic and a tighter SLO; must survive Kafka, ClickHouse or primary-DB outages |
| PostgreSQL | Source of truth for links and users | Uniqueness is a primary-key insert; hash-shard by code later |
| Redis | Link cache, idempotency keys, rate limits | Losing it makes redirects slower, not wrong |
| Kafka → ClickHouse | Click log and rollups | Replayable events; column store for time-series queries |

### Flow: creating a link across the wire

```
 Owner                  SPA                              Link API                     PostgreSQL
   │                     │                                   │                             │
   │ 1 Create            │                                   │                             │
   │────────────────────▶│                                   │                             │
   │                     │ 2 save draft + key K (sessionStorage)                           │
   │                     │ 3 POST /links, Idempotency-Key K  │                             │
   │                     │──────────────────────────────────▶│                             │
   │                     │                                   │ 4 claim K in Redis (SET NX) │
   │                     │                                   │ 5 INSERT link, unique code  │
   │                     │                                   │────────────────────────────▶│
   │                     │   6 save 201 under K, warm cache  │                             │
   │                     │ 7 201 Link (retry → same 201)     │                             │
   │                     │◀──────────────────────────────────│                             │
   │                     │ 8 prepend to ['links']; clear draft                             │
   │ 9 short URL + Copy  │                                   │                             │
   │◀────────────────────│                                   │                             │
   │                     │                                   │                             │
```

"Steps 2 and 4 are two halves of the same contract. The browser promises to send the same key for the same draft — even after a refresh, because the key is in `sessionStorage` — and the server promises that a repeated key returns the stored response rather than doing the work again."

### Flow: from click to chart

```
Redirect Svc              Kafka             ClickHouse             Link API                    SPA
      │                     │                    │                     │                        │
      │ 1 click {event_id}  │                    │                     │                        │
      │────────────────────▶│                    │                     │                        │
      │                     │ 2 consumer INSERT  │                     │                        │
      │                     │───────────────────▶│                     │                        │
      │                     │                    │ 3 dedupe, roll up   │                        │
      ·························· every 60 s while the tab is visible ····························
      │                     │                    │                     │ 4 GET /stats?range&tz  │
      │                     │                    │                     │◀───────────────────────│
      │                     │                    │ 5 SELECT rollups    │                        │
      │                     │                    │◀────────────────────│                        │
      │                     │                    │ 6 rows + watermark  │                        │
      │                     │                    │────────────────────▶│                        │
      │                     │                    │                     │ 7 buckets + as_of      │
      │                     │                    │                     │───────────────────────▶│
      │                     │                    │              8 render chart + "as of 14:05"  │
      │                     │                    │                     │                        │
```

"The `as_of` field is how the backend's lag becomes visible in the UI. The consumer's progress becomes ClickHouse's watermark, then the API's `as_of`, then the label under the chart."

---

## 💾 Data Model & API Contract (7 min)

### Server side

| Store | Table / key | Key columns | Notes |
|-------|-------------|-------------|-------|
| PostgreSQL | `links` | `code` (PK), `long_url`, `owner_id`, `status`, `expires_at`, `created_at`, `version` | `(owner_id, created_at DESC, code)` serves the dashboard list |
| PostgreSQL | `outbox` | `id`, `code`, `change`, `version` | Same transaction as the link change; relayed to pub/sub |
| Redis | `link:{code}` | `{url, status, expires_at, version}` | TTL = min(24 h, time until expiry) |
| Redis | `idem:{owner}:{key}` | Request hash + stored response | 24 h TTL |
| ClickHouse | `clicks`, `clicks_per_minute` | `event_id`, `code`, `ts`, `referrer_host`, `country`, `device` | Replayed batches skipped by insert deduplication; rollups via materialized view |

### Client side

| Cache key | Holds | Invalidated by |
|-----------|-------|----------------|
| `['links', {q, sort}]` | Pages of `Link` with `nextCursor` | Create (prepend), deactivate (patch row), then refetch |
| `['link', code]` | One `Link` including `version` | Any mutation on that code |
| `['stats', code, {range, tz}]` | Buckets, breakdowns, `asOf`, `partial` | Time: 60 s stale time, refetch while visible |
| `sessionStorage['create-draft']` | Frozen draft + idempotency key | Successful create |

### The contract

```
POST  /api/v1/links                     + Idempotency-Key → 201 Link | 409 alias taken | 422
GET   /api/v1/links?q&sort&cursor&limit → {items, next_cursor}
PATCH /api/v1/links/{code}              + If-Match: version → 200 Link | 412 stale
GET   /api/v1/links/{code}/stats        ?from&to&tz&granularity → {buckets, as_of, partial}
GET   /{code}                           302 | 404 unknown | 410 disabled or expired
```

| Contract element | The server guarantees | The client relies on it to |
|------------------|----------------------|----------------------------|
| `Idempotency-Key` | Same key + same body → same response for 24 h; same key + different body → `422` | Retry after timeouts, refreshes and offline periods without duplicates |
| `version` + `If-Match` | Writes apply only to the version the caller saw | Detect that an admin changed the link while the owner was looking at it |
| `next_cursor` | Stable keyset ordering by `(created_at, code)` | Infinite scroll without duplicates or gaps as new links arrive |
| `tz` parameter | Daily buckets start at the viewer's midnight, DST included | Render days correctly; the client only formats |
| `as_of`, `partial` | How current the numbers are, and whether events were dropped | Tell the owner the truth about lag and gaps |
| `application/problem+json` | Machine-readable error type and field errors | Show "alias taken" on the alias field instead of a generic toast |

---

## 🔧 Deep Dive 1: Exactly One Link per Click (8 min)

"The scenario: an owner on a flaky connection clicks Create, the request times out, and they click again. Without care we create two links, and their analytics are split across two codes forever. Each layer has a job."

**Browser.** On submit, the SPA freezes the draft and generates a key with `crypto.randomUUID()`, storing both in `sessionStorage`. Retries — the Retry button, TanStack Query's automatic retry, or a reload that finds a pending draft — reuse that key. Editing the draft generates a new key, because it is now a different request. The button is disabled while pending, but correctness doesn't depend on that.

**API.** The Link API claims the key with `SET idem:{owner}:{key} pending NX EX 60`. If the claim fails and a stored response exists, it returns that response. If the key is still `pending` (a concurrent duplicate), it returns `409` with `Retry-After: 1` and the client tries again. Only the claimant runs the insert and then stores the `201` body under the key for 24 hours. The key is scoped by owner so one user's keys can't collide with another's.

**Database.** The insert itself is protected by the primary key on `code`, with a retry on the rare random collision. The idempotency key prevents a duplicate *link*; the primary key prevents a duplicate *code*. They solve different problems.

| Approach | Verdict |
|----------|---------|
| ✅ Client-generated key + server-stored response | Correct across timeouts, refreshes and concurrent duplicates |
| ❌ Server dedupe by request body | Silently merges intentional duplicates — an owner may want two links to the same URL for two campaigns |
| ❌ Disable the button only | Prevents double clicks, not retries after a timeout or a refresh |
| ❌ Optimistic create in the UI | The code doesn't exist until the server assigns it |

"What I give up: a Redis round trip on every create and 24 hours of stored responses — a few gigabytes at our volume. If Redis is unavailable I'd rather fail creation with a `503` than create without the guarantee; creation is the cheap path to make wait."

---

## 🔧 Deep Dive 2: Takedowns End to End (7 min)

"The promise is that a deactivated link stops redirecting everywhere within five seconds. That promise spans the button, the API, three cache tiers and every region."

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

**In the UI**, deactivation is optimistic: the row flips to "Disabled" immediately with the `version` it was loaded with. On `412` the SPA refetches and shows what changed (usually an admin got there first); on other errors it restores the snapshot and shows a toast. Success shows "Deactivated — can take up to 5 seconds to stop everywhere", because that's what the backend actually promises.

**In the backend**, the status change and an outbox row commit in one transaction, so the invalidation survives a crash right after commit. The Link API overwrites the Redis entry with a versioned tombstone rather than deleting it; a delete would let a redirect that read the old row a millisecond earlier write it back. A relay publishes `link-changed` from the outbox, and every Redirect instance evicts its in-process entry. If that message is lost, the in-process TTL of 5 seconds still bounds the damage.

**Expiry** uses the same machinery without any messages: cache entries carry `expires_at`, their TTL is never longer than the time left, and every cache hit re-checks it. The SPA shows a countdown, but the server's clock decides.

| Approach | Verdict |
|----------|---------|
| ✅ Outbox + versioned tombstone + 5 s L1 TTL | Bounded staleness that survives crashes and racing refills |
| ❌ Synchronous purge of every cache before responding | Couples the owner's click to every region's health; one slow region blocks the UI |
| ❌ No in-process cache | Simplest, but a viral link concentrates ~200K requests/s on a single Redis key |

"I'm trading 'instant' for 'within five seconds, reliably' — and the UI copy says so rather than pretending otherwise."

---

## 🔧 Deep Dive 3: From Click to Chart (7 min)

"Two rules: analytics must never slow a redirect, and the dashboard must never pretend to be more current or complete than it is."

**Capture.** The Redirect Service creates a UUIDv7 `event_id` for each click and publishes after the `302` is flushed, via a bounded buffer and a batching Kafka producer. If Kafka is down, the buffer fills and then drops events — counting them, so the gap can be reported later.

**Process.** Consumers insert batches into ClickHouse and commit Kafka offsets only afterwards. A crash means the same offset range is delivered again; it is inserted with that range as its deduplication token, so ClickHouse skips the replay and each click counts once. A materialized view keeps per-minute rollups; nothing ever increments a counter row in PostgreSQL, which would serialize a viral link's clicks behind one row lock.

**Serve.** The SPA requests `/stats?from&to&tz&granularity`. The server buckets in the viewer's time zone, because "clicks on Tuesday" depends on where Tuesday starts. The response carries `as_of`, and `partial: true` if dropped events overlap the range.

**Render.** The chart is a lazy-loaded chunk behind a fixed-height skeleton. The UI shows "Updated 14:05" and, when `partial` is set, a banner naming the affected window. Stats refetch every 60 s, only while the tab is visible.

| Approach | Verdict |
|----------|---------|
| ✅ Kafka → ClickHouse rollups + polling with `as_of` | Matches the ~1 minute freshness target; replayable |
| ❌ WebSocket push of live counts | A persistent connection per open dashboard to display numbers that are a minute behind anyway |
| ❌ Counting in PostgreSQL | Hot-row contention and slow time-range queries |
| ❌ Synchronous click insert on redirect | Puts a database write, and its availability, in front of every redirect |

---

## 📈 Failures & Scale (2 min)

| Failure | What the owner sees | What the visitor sees | Mitigation |
|---------|---------------------|-----------------------|------------|
| Redis down | Create returns `503` (idempotency unavailable) | Slightly slower redirects | L1 cache, singleflight, circuit breaker on replicas |
| PostgreSQL primary down | Read-only dashboard: create and deactivate disabled with a banner | Nothing — redirects run on caches and replicas | Replica promotion; `Retry-After` |
| Kafka down | "Partial data" banner on recent stats | Nothing | Bounded buffer, counted drops |
| ClickHouse slow | Stats skeleton, then a retry message; the link list still works | Nothing | Stats is an isolated query with its own timeout |
| Region outage | Dashboard served from another region | Redirects fail over via GeoDNS | Replicas, Redis and Redirect instances in every region |

**What breaks first as we grow:** a single viral link overloading one Redis shard (absorbed by L1), click-pipeline lag (add partitions and consumers; the UI shows the lag), and PostgreSQL storage around year two or three (hash-shard by code, with a separate owner-sharded index for the dashboard list).

---

## ⚖️ Trade-offs & Wrap-up (1 min)

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Creation safety | Client key + server-stored response | Body fingerprint or disabled button | Retries can't duplicate; intentional duplicates still allowed |
| Code generation | Random 7 chars + unique insert | Key pool or counter | Simplest correct option at 0.5% occupancy per year |
| Redirect status | `302`, `max-age=0` | `301` | Every click must reach us for analytics and takedowns |
| Takedown | Outbox + tombstone + 5 s L1 TTL | Synchronous global purge | Reliable bound without coupling the UI to every region |
| Analytics | Kafka → ClickHouse, `as_of` in the API | Live WebSocket counters | Honest freshness at a fraction of the cost |
| Dashboard data | TanStack Query + cursor pages + virtualization | Load everything into a client store | Fast at 50K links; no hand-rolled caching |

"With more time: malicious-URL screening at creation plus periodic re-scans, custom domains with automated certificates, and a bulk CSV import that parses in a Web Worker and streams results back with per-row idempotency keys."
