# Web Crawler - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## 📋 Introduction (2 minutes)

"I'll design a distributed web crawler with end-to-end integration. The full-stack challenge is connecting a high-throughput backend crawling system with a reactive monitoring dashboard. This requires:

1. **Backend complexity** - URL frontier, distributed workers, politeness enforcement
2. **Real-time frontend** - Live statistics and management controls
3. **Data contracts** - Type safety across the entire system
4. **Dual-write patterns** - Immediate cache updates with durable storage

Let me clarify requirements first."

---

## 🎯 Requirements Clarification (5 minutes)

### Functional Requirements

"For the distributed crawler with monitoring dashboard:

1. **URL Discovery** - Extract links from pages, queue for crawling
2. **Distributed Crawling** - Workers fetch pages while respecting politeness
3. **Deduplication** - Avoid re-crawling duplicate URLs
4. **Admin Dashboard** - Real-time stats, domain management, seed URL control
5. **Worker Monitoring** - Health status and throughput visualization

I'll focus on end-to-end data flow and technology choices for the integration layer."

### Non-Functional Requirements

| Requirement | Target | Implication |
|-------------|--------|-------------|
| Scale | 10,000 pages/second | Need efficient data propagation |
| Dashboard Latency | < 2 seconds | Real-time protocol required |
| Type Safety | End-to-end | Shared contracts between FE/BE |
| Operator Control | Immediate effect | Dual-write to cache + DB |

---

## 🏗️ High-Level Design (8 minutes)

### End-to-End Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Admin Dashboard (React)                          │
│   Real-time stats │ URL frontier │ Domain mgmt │ Worker monitoring      │
└─────────────────────────────────────────────────────────────────────────┘
                    │                           │
                    │ REST API                  │ WebSocket
                    ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          API Server (Express)                            │
│   Routes: /api/urls, /api/domains, /api/workers, /api/stats             │
│   WebSocket: /ws/stats (real-time updates)                              │
└─────────────────────────────────────────────────────────────────────────┘
                    │                           │
        ┌───────────┴───────────┐               │
        ▼                       ▼               ▼
┌───────────────┐      ┌───────────────┐  ┌──────────────┐
│  Coordinator  │      │    Workers    │  │ Stats Agg    │
│               │◄────►│   (1...N)     │  │              │
│ - Assignment  │      │ - Fetch pages │  │ - Metrics    │
│ - Scheduling  │      │ - Extract     │  │ - Broadcast  │
└───────────────┘      └───────────────┘  └──────────────┘
        │                       │                 │
        └───────────────────────┴─────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐      ┌───────────────┐      ┌───────────────┐
│  PostgreSQL   │      │     Redis     │      │ Object Store  │
│ - URL frontier│      │ - Rate limits │      │ - Page content│
│ - Domain meta │      │ - Pub/Sub     │      │ - robots.txt  │
└───────────────┘      └───────────────┘      └───────────────┘
```

---

## 🕸️ Deep Dive: The URL Frontier (10 minutes)

Everything else in a crawler is plumbing around one data structure. The frontier is a queue that must simultaneously be **prioritized** (crawl important pages first), **deduplicated** (never fetch the same URL twice), **polite** (never hammer one host), and **crash-safe** (a worker dying must not lose or permanently strand work). Those four requirements pull against each other, and how you split them across stores is the design.

### Splitting it across Redis and Postgres

Postgres holds `url_frontier` — the durable record, with a status per URL. Redis holds three sorted sets, one per priority level, containing URL hashes.

Adding a URL writes to both: an `INSERT ... ON CONFLICT (url_hash) DO NOTHING` into Postgres, and a push onto the sorted set matching its priority. Taking work pops from Redis high→medium→low, loads the row from Postgres, **re-checks that its status is still `pending`**, and marks it `in_progress`.

That re-check is the load-bearing line. The two stores are eventually consistent — a hash can linger in Redis after its Postgres row has moved on — so the Redis queue is treated as a *hint about what to look at*, never as the truth about what needs doing. Postgres is the arbiter. Without the re-check, two workers popping near-simultaneously could both proceed on the same URL.

**Why not pure Postgres with `FOR UPDATE SKIP LOCKED`?** It's a genuinely good pattern and it would work: one store, one source of truth, no consistency seam at all. What it costs is that every dequeue becomes a write-locking scan against the priority index — the hottest query in the system contending with the inserts that new link discoveries are constantly producing. Redis moves the hot path onto a data structure built for it. The price is exactly the seam described above, and the re-check is what makes that price safe rather than dangerous.

### Dedup: exact, not probabilistic — for now

Each URL is normalized (lowercase host, strip default ports and fragments, sort query params) and SHA-256 hashed. Membership is an O(1) `SISMEMBER` against a Redis set, backstopped by a UNIQUE index on `url_hash` in Postgres.

**Normalization is where the real bugs live**, not hashing. `example.com/page`, `example.com/page#section`, and `EXAMPLE.com/page?` are one page; if normalization disagrees with itself across code paths, dedup silently fails and the crawler re-fetches forever. Doing it once, in one function, before hashing is the whole defense.

Exact dedup means zero false negatives — a real page is never skipped. The cost is unbounded memory: roughly 64 bytes per hash, so 10 billion URLs is about 640GB, which is not a Redis instance. A Bloom filter is the production answer at ~10× less memory for ~0.1% false positives, and the trade is acceptable because a false positive means one page never gets crawled out of billions. What makes the migration awkward is that a Bloom filter can't be built incrementally from nothing without a full pass over history — which is the honest reason a learning-scale system starts exact.

### Politeness as a lock, not a rate limiter

Before fetching, a worker runs `SET crawler:domain:{d}:lock {workerId} NX EX {crawlDelay}`. Winning the key is permission to crawl that domain right now.

This one primitive does two jobs at once, which is why it's the nice part of the design. The **TTL is the crawl delay** — the key self-releases exactly when the next fetch becomes permissible, so no scheduler tracks "when may I next hit this host." And `NX` gives **worker exclusivity** for free: two workers cannot hold one domain's lock, so they cannot double-crawl it, with no coordination between them.

What it gives up is throughput shape. Politeness is per-domain, so one large site is a single-lane road no matter how many workers exist, and workers spin when every eligible domain is locked. A token bucket would let short bursts through while holding the average — closer to how a human browses — at the cost of losing the elegant equivalence between "the lock" and "the delay."

### Crash safety by lease

A worker marks a URL `in_progress` and then fetches it *outside* any transaction. If it dies, the row is stranded — so a periodic sweep resets `in_progress` rows older than N minutes back to `pending`.

The alternative is holding a database transaction for the duration of the fetch, which makes crash recovery automatic via rollback. It's wrong here: a slow page holds a connection for its entire timeout, and the pool is exhausted by exactly the hosts you least want to be blocked on. Leasing accepts at-least-once delivery instead — a crashed worker's URL gets crawled twice — which is harmless because crawling is idempotent. **That's the general shape: pick at-least-once whenever the work is idempotent, because the machinery for exactly-once costs more than the duplicate does.**

---

## 🔍 Deep Dive: How the Dashboard Stays Current (8 minutes)

The dashboard shows live crawl progress — pages crawled, frontier depth, active workers, recently crawled pages. The question is how those numbers get from the workers to the browser.

**What this system does: the client polls `/api/stats` every 5 seconds.** No WebSocket, no SSE, no pub/sub to the browser. I want to defend that, because "use WebSockets for real-time" is the reflex answer and it is wrong here.

### Why polling is the right call for this dashboard

Three properties of *this* data make polling fit:

1. **The data is a snapshot, not a stream of events.** The dashboard renders aggregate counters and a top-N list. A viewer who misses an intermediate value has lost nothing — they only ever wanted the current state. Push shines when every event matters (a chat message, a trade fill); here, only the latest sample is meaningful, and polling delivers exactly that.
2. **The update rate is bounded by the crawl, not by the UI.** Workers complete pages on the order of hundreds of milliseconds to seconds. A 5-second refresh is already close to the underlying rate of change, so a push channel would mostly deliver redundant updates.
3. **The audience is one to a handful of operators.** The cost model for push — a connection held open per viewer, heartbeats, reconnect logic, and cross-instance fan-out so a viewer on instance A sees events produced on instance B — is paid per viewer. Amortized over three operators, it buys almost nothing.

### What polling costs, honestly

Up to 5 seconds of staleness, and a request every 5 seconds per open tab whether or not anything changed. At operator scale that is negligible. It also means the "Live" indicator in the corner is a claim about the polling loop being healthy, not about the data being current to the instant — a distinction worth being honest about in the UI.

The place it genuinely breaks down: if this dashboard ever became customer-facing with thousands of concurrent viewers, the polling load would scale linearly with viewers *and* be almost entirely redundant, because they would all be requesting the same global aggregate. That is the moment to switch — and the right switch is **SSE, not WebSocket**.

### Why SSE would be the upgrade, not WebSocket

| Approach | Fit here |
|----------|----------|
| ✅ Polling (current) | Snapshot data, few viewers, no connection state to manage, trivially survives a backend restart |
| ✅ SSE (the upgrade) | One-way server→client is exactly the traffic shape; runs over plain HTTP, so proxies and auth work unchanged; the browser reconnects automatically |
| ❌ WebSocket | Bidirectional, and nothing here flows client→server on the live channel; costs a protocol upgrade, heartbeat handling, and manual reconnect for capability that goes unused |

The dashboard sends nothing upstream — every mutation (add seeds, recover stale URLs, clear the frontier) is a plain REST call that already works. Choosing WebSocket would mean taking on connection-lifecycle complexity to serve traffic that only ever goes one direction.

### What would have to change server-side

Today `/api/stats` reads Redis counters and runs a couple of Postgres aggregates per request. Under push, that computation moves from per-request to per-tick: one process samples on an interval and fans the result out. With multiple API instances that fan-out needs Redis pub/sub, since a viewer connected to instance A must receive a sample computed anywhere. That is the actual cost of "real-time" here — not the transport, but the fact that a periodic computation now needs an owner and a distribution path. Polling avoids the question entirely by letting each request compute its own answer.

---

## 🏗️ Deep Dive: Keeping the API Contract Honest (6 minutes)

Frontend and backend are both TypeScript, which invites the assumption that the contract between them is type-checked. It is not, and this system has the scar to prove it.

### The shape of the problem

The frontend declares a `CrawledPage` interface in its own `types/` folder with camelCase fields — `statusCode`, `contentLength`, `crawledAt`. The backend queries Postgres, which returns snake_case — `status_code`, `content_length`, `crawled_at` — and one route returned `result.rows` verbatim. Both sides compiled cleanly. `tsc` had no way to know they disagreed, because neither side imports the other's definition; each is internally consistent about a shape the other doesn't produce.

The result reached production-equivalent: every row in the crawled-pages table rendered `undefined B` for size, a bare `ms` for duration, and `Invalid Date` for the timestamp. **A type system gave complete confidence about a contract it was never checking.**

### The options, and why each one bites

| Approach | What it buys | What it costs |
|----------|--------------|---------------|
| ❌ Duplicated interfaces (what this had) | Nothing but the appearance of safety | Silent drift; compiles on both sides while disagreeing |
| ✅ Shared types package | One declaration, both sides import it | Needs a monorepo build step; still doesn't validate what the DB actually returns |
| ✅ Generated from the schema | Contract derived from the real source of truth | Codegen in the build; regenerate on migration |
| ❌ GraphQL | Schema *is* the contract, enforced | Large overhead to solve a serialization-casing problem |

Worth being precise about a limit of the shared-package answer, since it's the one people reach for: a shared type still doesn't catch this bug on its own. Both sides would agree on `statusCode`, and the backend would still be free to return a row object that doesn't match — `pg` returns `any`. What actually closes the gap is an explicit mapping layer at the boundary, typed against the shared definition, so the compiler checks the row→DTO translation rather than trusting it.

### The rule that follows

**Never return a database row directly from a handler.** Not because the casing is wrong — because a raw row makes the database schema the API contract, so a column rename becomes a breaking API change nobody notices, and every column added is silently published to clients whether it should be or not. An explicit mapping is three boring lines that make the contract a decision rather than an accident.

### Validating at the boundary

Types vanish at runtime, so the type-sharing above buys nothing at the two places data actually enters the system: the request body an operator submits, and the HTML a crawler fetches from a stranger's server. Both need runtime validation, and they need different kinds.

**Request bodies** get schema validation — a declarative schema that both validates and produces the TypeScript type, so the two can't drift. The alternative most codebases end up with is a hand-written type guard *plus* a separately declared interface, which agree on the day they're written and diverge on the first field added.

**Fetched HTML gets validated by suspicion rather than by schema**, because there is no schema for "whatever a website returned." The crawler treats every extracted field as untrusted: URLs are normalized and re-parsed before being queued (a malformed `href` must not become a frontier entry), extracted text is length-bounded before it reaches the database, and a `Content-Type` that isn't HTML short-circuits parsing entirely. This is the validation layer that actually matters for a crawler, and it's the one people forget — a crawler consumes adversarial input by definition.

> "I'd rather over-validate at these two boundaries and trust types everywhere inside them. The interior of the system is code we wrote; the edges are an operator's typo and the open web."

---

## 📊 Deep Dive: Dual-Write Pattern for Domain Control (8 minutes)

### The Problem

When an operator changes a domain's crawl delay from the dashboard, workers need to see that change immediately. But we also need the change persisted.

### Solution: Write to Both Redis and PostgreSQL

```
Dashboard                API Server               Redis              PostgreSQL
    │                        │                      │                     │
    │  PATCH /domains/foo    │                      │                     │
    │  {crawlDelayMs: 2000}  │                      │                     │
    │───────────────────────►│                      │                     │
    │                        │                      │                     │
    │                        │  SET crawldelay:foo  │                     │
    │                        │───────────────────►  │  (immediate effect) │
    │                        │                      │                     │
    │                        │  UPDATE domains...   │                     │
    │                        │──────────────────────────────────────────► │
    │                        │                      │  (durable storage)  │
    │                        │                      │                     │
    │  200 OK                │                      │                     │
    │◄───────────────────────│                      │                     │
```

### Why Not Just PostgreSQL?

| Approach | Latency | Durability | Worker Complexity |
|----------|---------|------------|-------------------|
| PostgreSQL only | ~5-50ms | ✓ | Query on every URL |
| Redis only | ~1ms | ✗ | Simple key lookup |
| ✅ Both (dual-write) | ~1ms read | ✓ | Simple key lookup |

**Decision: ✅ Dual-write**

"Workers check rate limits on every URL fetch. Hitting PostgreSQL every time would add latency and load. Redis gives us microsecond reads. We write to both - Redis for immediate effect, PostgreSQL for durability across restarts."

### Handling Dual-Write Failures

| Scenario | Handling |
|----------|----------|
| Redis write fails | Return error, don't update PostgreSQL |
| PostgreSQL write fails | Redis already updated, log for reconciliation |
| Both succeed | Ideal path |

"We accept eventual consistency. If PostgreSQL fails after Redis succeeds, the worker has the new rate limit but it won't survive a restart. A background job can reconcile periodically."

---

## ⚠️ Error Handling Philosophy (4 minutes)

### Backend: Typed Error Classes

| Error Type | HTTP Status | When Used |
|------------|-------------|-----------|
| ValidationError | 400 | Invalid input (Zod failure) |
| NotFoundError | 404 | Domain/URL doesn't exist |
| RateLimitError | 429 | Too many requests |
| InternalError | 500 | Unexpected failures |

### Why Custom Classes Over HTTP Problem Details?

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Custom error classes | Simple, TypeScript-native | Non-standard |
| RFC 7807 Problem Details | Standard format | More verbose |
| Plain objects | Flexible | No structure |

**Decision: ✅ Custom classes**

"For an internal API, custom error classes with `code` and `message` fields are simpler. Problem Details adds value for public APIs where clients need standardization."

### Frontend: Layered Error Handling

```
┌─────────────────────────────────────────┐
│         Error Boundary (React)          │  ← Catches render crashes
├─────────────────────────────────────────┤
│         Toast Notifications             │  ← Shows API errors
├─────────────────────────────────────────┤
│         API Client Layer                │  ← Parses error responses
└─────────────────────────────────────────┘
```

"Three layers: Error Boundary catches React crashes, Toasts show API errors to users, API client layer parses and types the errors. Each layer has a specific job."

---

## ⚖️ Trade-offs Summary (2 minutes)

| Decision | Chosen | Rejected | Why |
|----------|--------|----------|-----|
| Dashboard updates | ✅ 5s polling | ❌ WebSocket | Snapshot data, few viewers; nothing flows client→server on a live channel |
| The upgrade path | ✅ SSE, if push is ever needed | ❌ WebSocket | One-way traffic over plain HTTP, with automatic browser reconnect |
| API contract | ✅ Explicit row→DTO mapping | ❌ Returning `result.rows` | A raw row makes the DB schema the public contract |
| Frontier storage | ✅ Redis queue + PG durability | ❌ Pure Postgres `SKIP LOCKED` | Keeps the hot dequeue off the priority index |
| Dedup | ✅ Exact Redis SET | ❌ Bloom filter | Zero false negatives at this scale; Bloom is the answer past ~1B URLs |
| Politeness | ✅ Per-domain `SET NX EX` lock | ❌ Global rate limiter | Lock TTL *is* the crawl delay, and it doubles as worker exclusivity |
| Domain updates | ✅ Dual-write Redis + PG | ❌ Postgres only | Workers check rate limits on every fetch; a DB read per URL is not affordable |
| Crash recovery | ✅ Lease + stale-URL reset | ❌ Long transaction per fetch | A hung HTTP request must not hold a DB lock |
| Local dev topology | ✅ Compose profiles | ❌ Everything on by default | The app containers published the same port the source-run backend needs |

---

## 🚀 Future Enhancements

1. **Bloom-filter dedup** with Postgres as the exact backstop, once the visited set outgrows memory
2. **SSE stats stream** if the dashboard ever becomes multi-tenant
3. **Generated types from the schema**, so the row→DTO mapping is checked rather than reviewed
4. **A Puppeteer lane** for URLs whose extraction comes back suspiciously empty — likely JS-rendered
5. **IP-level politeness**, since per-domain throttling still lets a shared host behind one IP get hammered

---

## 📝 Summary

Two threads run through this design.

**Match the mechanism to the shape of the data.** Frontier URLs are hot and ordered, so they live in Redis sorted sets with Postgres underneath for durability and inspectability. Visited hashes are a membership test, so they're a set. Politeness is a time-bounded exclusive claim, so it's a key with a TTL — the expiry *is* the crawl delay, which means the data structure enforces the policy instead of a scheduler doing it. Dashboard stats are a snapshot read by a few operators, so they're polled.

**Be suspicious at the boundaries and trust the interior.** A crawler consumes adversarial input by definition, so extracted URLs are re-parsed, content is length-bounded, and non-HTML responses short-circuit. The same discipline applies to the API boundary, and this system learned it the hard way: two independently-declared TypeScript interfaces that both compiled, disagreed, and rendered `undefined` to every user. Type safety inside a process says nothing about the contract between two of them.
