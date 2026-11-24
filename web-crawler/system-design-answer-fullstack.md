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
| Scale | 10,000 pages/second | Dedup and frontier on the hot path; dashboard reads aggregates, never events |
| Politeness | ≤ 1 req/s/host, robots.txt honored | A correctness rule, enforced in the frontier, not the UI |
| Dashboard freshness | ≤ 5 seconds | Snapshot polling is sufficient — no push channel required |
| API contract | No silent drift | Explicit row→DTO mapping at every handler |
| Operator control | Effective on the next fetch | Settings published to the store workers actually read |

### Back-of-Envelope

"10K pages/s at ~50 links per page is ~500K dedup checks per second — the seen-set, not the fetcher, is the hot path. And at one request per host per second, 10K pages/s means at least 10K distinct hosts must be ready at every instant, so the frontier has to optimize for *breadth*. On the frontend side, the same numbers say the dashboard can never show individual crawl events: 10K rows a second is unreadable and unrenderable, so the API serves aggregates and a short recent-pages list."

---

## 🏗️ High-Level Design (8 minutes)

### End-to-End Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Admin Dashboard (React SPA)                    │
│  Dashboard │ Frontier │ Domains │ Pages │ Admin (seeds, recovery)   │
│  Zustand store ── polls GET /api/stats every 5s                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ REST (JSON DTOs, session cookie)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          API Server (Express)                       │
│  /api/stats · /api/frontier · /api/domains · /api/pages · /metrics  │
│  Frontier maintenance loop: lease recovery · queue rehydration      │
└───────────────┬───────────────────────────────────┬─────────────────┘
                │                                   │
                ▼                                   ▼
┌───────────────────────────────┐   ┌───────────────────────────────┐
│          PostgreSQL           │   │         Redis / Valkey        │
│ url_frontier (truth: status,  │   │ priority queues (eligible-at) │
│   retry_count, last_error)    │   │ domain locks · seen-set       │
│ crawled_pages · domains       │   │ robots cache · counters       │
└───────────────▲───────────────┘   └───────────────▲───────────────┘
                │                                   │
        ┌───────┴───────────────────────────────────┴───────┐
        │        Crawler workers 1..N (stateless)           │
        │  claim → robots → fetch → parse → dedup → enqueue │
        └───────────────────────────────────────────────────┘
```

"There is no coordinator and no push channel. Workers coordinate only through the frontier — a host lock in Redis and a conditional status update in Postgres — and the dashboard is a read-mostly client of the same two stores via the API. Each of those absences is a choice I'll defend in a deep dive."

---

## 🧭 Where the Complexity Lives (2 minutes)

Before the deep dives, the honest summary of where the difficulty actually is in this system — because it is not distributed evenly.

The **frontend is straightforward**: five read-mostly pages, a polling store, and a handful of admin actions. There is no optimistic UI, no offline mode, no collaborative editing. That is not a gap; a crawler's dashboard is an observability surface, and the right amount of cleverness in it is very little.

The **backend is where every hard decision is**, and almost all of them are about one thing: which store owns which fact, and what happens when they disagree. Postgres owns the frontier's truth; Redis owns its ordering. Postgres owns domain settings; Redis owns the copy workers actually read. Postgres owns crawled-page records; Redis owns the visited-set membership test. Each pairing is a deliberate split of durability from speed, and each one needs an answer to "what if the fast side is wrong?"

The three answers this system gives are worth stating together, because they're the same answer: **arbitrate every claim with a conditional update in Postgres**, **rebuild the Redis queues from Postgres when they go missing**, and **let the durable write win when a dual write is interrupted**. Different mechanisms, one principle — the fast store may be stale or missing, never authoritative.

---

## 🕸️ Deep Dive: The URL Frontier (10 minutes)

Everything else in a crawler is plumbing around one data structure. The frontier is a queue that must simultaneously be **prioritized** (crawl important pages first), **deduplicated** (never fetch the same URL twice), **polite** (never hammer one host), and **crash-safe** (a worker dying must not lose or permanently strand work). Those four requirements pull against each other, and how you split them across stores is the design.

### Splitting it across Redis and Postgres

Postgres holds `url_frontier` — the durable record, with a status per URL. Redis holds three sorted sets, one per priority level, containing URL hashes.

Adding a batch of links costs a constant number of round trips: one membership check against the seen-set, one multi-row `INSERT ... ON CONFLICT (url_hash) DO NOTHING RETURNING`, and one pipelined push of **only the rows that were actually inserted**. The sorted-set score is the time the URL becomes *eligible*, not when it was found — new URLs score "now", retries score "now + backoff" — so delayed retries need no separate timer queue.

Taking work reads eligible hashes from Redis high→medium→low, loads their rows from Postgres in one query, and drops hashes whose rows are no longer pending. Then the claim: win the host's politeness lock, and flip the row with a **conditional update** (`status = 'in_progress' WHERE status = 'pending'`), proceeding only if exactly one row changed.

That conditional update is the load-bearing line. The two stores are eventually consistent — a hash can linger in Redis after its row has moved on — so the Redis queue is a *hint about what to look at*, never the truth about what needs doing. Postgres is the arbiter, and the arbitration has to be atomic: a read-then-write re-check still lets two workers both see `pending` and both proceed.

One detail that sounds cosmetic and isn't: re-adding an already-queued URL must not reset its score. If it did, every new inbound link would push a page to the back of the queue — so the most-linked pages on the web, the ones you want first, would starve.

**Why not pure Postgres with `FOR UPDATE SKIP LOCKED`?** It's a genuinely good pattern and it would work: one store, one source of truth, no consistency seam at all. What it costs is that every dequeue becomes a write-locking scan against the priority index — the hottest query in the system contending with the inserts that new link discoveries are constantly producing. Redis moves the hot path onto a data structure built for it. The price is exactly the seam described above, and the re-check is what makes that price safe rather than dangerous.

### Dedup: exact, not probabilistic — for now

Each URL is normalized (lowercase host, strip default ports and fragments, sort query params) and SHA-256 hashed. Membership is an O(1) `SISMEMBER` against a Redis set, backstopped by a UNIQUE index on `url_hash` in Postgres.

**Normalization is where the real bugs live**, not hashing. `example.com/page`, `example.com/page#section`, and `EXAMPLE.com/page?` are one page; if normalization disagrees with itself across code paths, dedup silently fails and the crawler re-fetches forever. Doing it once, in one function, before hashing is the whole defense.

Normalization also strips tracking parameters (`utm_*`, `gclid`, `fbclid`): one email campaign can otherwise mint a thousand aliases of every page on a site.

Exact dedup means zero false positives — a real page is never wrongly skipped. The cost is unbounded memory: the hashes are stored as 64-character hex, so 10 billion URLs is about 640GB, which is not a Redis instance. A Bloom filter is the production answer — about 18GB for 10B URLs at a 0.1% false-positive rate — but the false positive is worth stating precisely: it's *deterministic*. The same URL sets the same bits every time, so a wrongly-"seen" URL is never crawled that cycle; rediscovering it doesn't help. That's tolerable for 1 in 1,000 ordinary links, which is why seeds and sitemap URLs should bypass the filter and go straight to the exact database check.

### Politeness as a lock, not a rate limiter

Before fetching, a worker runs `SET crawler:domain:{d}:lock {workerId} NX PX {crawlDelayMs}`. Winning the key is permission to start a request to that host right now.

The nice part is that the **TTL is the crawl delay** — the key self-releases exactly when the next request becomes permissible, so no scheduler tracks "when may I next hit this host," and a crashed worker can never deadlock a host. (Milliseconds rather than seconds, so a `Crawl-delay: 0.5` isn't rounded up to a full second.)

What the lock is *not* is worker exclusivity, and it's tempting to think it is. It expires after one crawl delay, while a fetch can take thirty seconds — so a second worker can legitimately win the same host's lock while the first is still downloading. That's correct for politeness (request *starts* stay spaced), which is exactly why exclusivity has to come from the conditional update above rather than from the lock.

The gate also has to cover every request, not just the main fetch. Two leaks: an in-process retry is a new request and must wait for the host's slot like any other; and an HTTP client that auto-follows redirects will hop to a different host without consulting its robots.txt or lock. So redirects are disabled in the client and the target is enqueued as a new URL.

What it gives up is throughput shape. Politeness is per-domain, so one large site is a single-lane road no matter how many workers exist, and workers spin when every eligible domain is locked. A token bucket would let short bursts through while holding the average — closer to how a human browses — at the cost of losing the elegant equivalence between "the lock" and "the delay."

### Crash safety by lease

A worker marks a URL `in_progress` and then fetches it *outside* any transaction. If it dies, the row is stranded — so a sweep every minute resets `in_progress` rows older than ten minutes back to `pending` **and re-adds them to their Redis queue**. That second half is the easy one to forget: workers only dequeue from Redis, so a row that's pending in Postgres but absent from Redis is invisible forever. The same loop rehydrates the queues wholesale if Redis comes back empty after a restart — compare queued count to pending count, and if Redis is short, re-add pending rows with ZADD NX so existing retry delays survive.

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

Up to 5 seconds of staleness, and a request every 5 seconds per open tab whether or not anything changed. At operator scale that is negligible. It also means a "Live" indicator is a claim about data age, so it should be computed from data age: the header shows "updated 3s ago" and turns to "Stale · retrying in 20s" when polls fail, while the last snapshot stays on screen. Polling is scheduled after each response settles (not on a fixed timer, which stacks requests behind a slow backend), pauses in background tabs, and backs off exponentially while the API is down.

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
Dashboard              API Server              PostgreSQL             Redis
    │                      │                        │                   │
    │ PUT /domains/foo/    │                        │                   │
    │   settings (admin)   │                        │                   │
    │ {crawlDelay: 2}      │                        │                   │
    │─────────────────────▶│  validate (0 < d ≤ 3600)                   │
    │                      │  UPDATE domains SET    │                   │
    │                      │  crawl_delay_override  │                   │
    │                      │───────────────────────▶│ (durable, 1st)    │
    │                      │  404 if no row         │                   │
    │                      │  SET delay_override:foo 2                  │
    │                      │───────────────────────────────────────────▶│
    │                      │                        │ (workers read     │
    │  200 OK              │                        │  this on claim)   │
    │◀─────────────────────│                        │                   │
```

"The override lives in its own key, separate from the robots.txt delay, for two reasons. A robots.txt refresh rewrites the robots key, and it must not silently erase an operator's choice. And workers compute the effective delay as **max(override, robots delay)** — the slider can slow a host down but never speed it past what the site asked for. A control that could set a delay below robots.txt would be a one-click way to violate it."

### Why Not Just PostgreSQL?

| Approach | Latency | Durability | Worker Complexity |
|----------|---------|------------|-------------------|
| PostgreSQL only | ~5-50ms | ✓ | Query on every URL |
| Redis only | ~1ms | ✗ | Simple key lookup |
| ✅ Both (dual-write) | ~1ms read | ✓ | Simple key lookup |

**Decision: ✅ Dual-write**

"Workers check rate limits on every URL fetch. Hitting PostgreSQL every time would add latency and load. Redis gives us microsecond reads. We write to both - Redis for immediate effect, PostgreSQL for durability across restarts."

### The ordering question nobody asks

A dual write has an order, and the order determines the failure mode. Writing **Redis first, then Postgres** means a crash between them leaves workers honoring a delay that won't survive a restart — the setting silently reverts, and the operator who set it has no idea. Writing **Postgres first, then Redis** means a crash leaves the setting durable but not yet in effect — the operator's change appears saved and workers ignore it until something repopulates the cache.

Neither is "safe"; they fail in opposite directions. Postgres-first is the better default because the divergence is *self-correcting* — any process that repopulates the cache from the database converges on the right answer, whereas Redis-first requires someone to notice the loss and redo the change. That's the same principle as the frontier's conditional claim, lease re-enqueue, and queue rehydration: **make the durable store authoritative and the fast store rebuildable, so recovery is a refresh rather than an investigation.**

The version that avoids the choice is an outbox — write the setting and an event in one transaction, and let a relay update Redis — which buys real atomicity for the cost of a relay process and end-to-end latency measured in the relay's poll interval, not milliseconds.

### Handling Dual-Write Failures (Postgres first)

| Scenario | Handling |
|----------|----------|
| PostgreSQL write fails | Return 500; nothing changed anywhere — the operator retries |
| PostgreSQL succeeds, Redis fails | Return 500; the maintenance loop rebuilds the Redis copy from Postgres within a minute (re-submitting also works — the write is idempotent) |
| Redis loses everything (restart) | Same rebuild restores every block and override; without it, a Redis restart would silently unblock every domain an operator blocked |
| An un-block's Redis write fails (stale block left behind) | Same rebuild removes it |
| Both succeed | Effective on the next claim for that host |

"The rebuild is what turns 'Postgres is the truth' from a slogan into a property, and one data-structure choice makes it work in both directions. If every domain had its own `blocked` key, restoring missing blocks is easy but finding *stale* ones means scanning every domain's keys. So blocks live in one Redis set and overrides in one hash, and the rebuild replaces both in a single MULTI/EXEC — stale entries vanish along with missing ones coming back.

The rebuild has its own race: it reads Postgres, then writes Redis, so an operator change landing in between would be overwritten by the older snapshot. Every publish bumps a version counter, and the rebuild WATCHes it — if the version moved, EXEC aborts and the next interval tries again. That's optimistic concurrency at the cache layer, the same idea as the frontier's conditional claim."

---

## 🧯 Operating It: What the Dashboard Is Actually For (4 minutes)

The admin surface looks like CRUD and isn't — each control exists because of a specific way crawls go wrong. **Reading is public; every control below requires an admin session**, enforced on the server by one `requireAdmin` middleware on each mutating route. The frontend hides the controls when signed out, but that's courtesy — a hidden button is not access control. One lesson from building it: the session store adapter was written for a different Redis client than the one the app passed in, so every session write failed silently *after* the login response said 200. Login 'worked' and nothing was ever authenticated. Auth needs an end-to-end test (log in, then call a protected route) — a unit test of the login handler would have passed.

**Accounts** are rows in a `users` table with two roles — admins change things, users only look. The interesting part is revocation: a session records the user's `session_version` at login, and every protected request re-reads the user by primary key. Disabling someone, changing their role, or resetting their password bumps the version, so their open sessions die on the next click rather than at cookie expiry — the property stateless JWTs make expensive. One rule needs a lock: "never zero admins." Two admins demoting each other at the same instant would both pass a naive check, so the update runs in a transaction that row-locks every active admin first.

**Add seed URLs** is the entry point for the whole system; a crawler with an empty frontier does nothing, and there is no other way in.

**Recover stale URLs** is the manual trigger for the lease sweep described above. The automatic sweep runs every minute but only reclaims leases older than ten, and an operator who just killed three workers doesn't want to wait for it.

**Clear frontier** is genuinely dangerous and is presented that way — typed confirmation plus the count of URLs it will delete. It's the escape hatch for when a crawl has gone somewhere it shouldn't (a calendar generating infinite URLs, a session-ID parameter defeating dedup) and the fastest fix is to stop and reseed. The per-domain page budget makes that rarer: a trap that mints infinite shallow URLs stops at 10,000 per domain instead of filling the frontier.

**The stats themselves are the diagnostic.** Pending versus in-progress versus completed is how you tell the difference between the three ways a crawl stalls: pending high with in-progress at zero means workers are dead or every domain is politeness-locked; in-progress stuck non-zero with completed flat means workers are hung mid-fetch and the lease sweep hasn't fired; pending at zero means the crawl is genuinely finished and needs new seeds. Those three states look identical if you only watch "pages crawled," which is why the dashboard breaks the frontier out by status rather than showing a single progress number.

The dashboard now says this out loud instead of leaving it to interpretation: a banner turns red when pending > 0 and no workers are running, amber when workers are alive but nothing is in progress (everything politeness-locked or in backoff), and neutral when the frontier is simply empty. Worker heartbeat age is computed on the server and sent as an age, because subtracting a worker's timestamp from the browser's clock makes every worker look dead on a laptop whose clock runs fast.

> "A stalled system and an idle one look identical on a counter. The first thing I'd want alerted on is the red banner's condition: work queued, nothing doing it."

---

## ⚠️ Failure Semantics, End to End (5 minutes)

The error handling that matters in a crawler isn't the API's 400s and 500s — it's what happens to a URL when the open web misbehaves, and whether an operator can see it.

### Classify every crawl outcome

| Outcome | Examples | Frontier action | What the dashboard shows |
|---------|----------|-----------------|--------------------------|
| Success | 200 text/html | completed; enqueue links unless the body is duplicate content | Row in Crawled Pages |
| Redirect | 301/302/307/308 | completed; target enqueued as a new URL at the same depth | Target appears as its own row |
| Permanent | 404, robots disallow, non-HTML, operator block | failed with `last_error`; added to seen-set; never retried | "failed" badge, reason on hover |
| Transient | Timeout, reset, 5xx, 429, robots.txt unreachable | `retry_count + 1`; back to pending with score now + base × 2ⁿ (± jitter); failed after N | "pending · retry 2", reason on hover |
| Not attempted | Host circuit breaker open | Deferred; no attempt counted | Stays pending |

"Getting this table wrong produces two opposite bugs. Treat transient as permanent and one network blip deletes a page from the crawl. Treat permanent as transient and a 404 retries forever. The jitter matters because failures are correlated: when a host dies, its thousand URLs fail together and would otherwise all return at the same second."

**robots.txt failures fail closed.** A 404 for robots.txt means "no rules — crawl freely," but a 5xx or timeout means "assume disallowed for now." The naive version — couldn't fetch, so assume allowed — starts crawling a site blind at exactly the moment it is struggling.

### Making failure visible

The frontier API returns `retryCount` and `lastError` per URL, and the Frontier page shows the retry count next to the status badge with the error as a tooltip. That's a small UI change with a large operational effect: "pending" alone can't distinguish a URL waiting its turn from one that has failed three times against a dying host. An operator who sees a column of "retry 3 · robots.txt unavailable" for one domain knows to look at that site, not at the workers.

> "Every new failure mode should be answerable from the dashboard without opening a log: what failed, how many times, and why."

---

## ⚖️ Trade-offs Summary (2 minutes)

| Decision | Chosen | Rejected | Why |
|----------|--------|----------|-----|
| Dashboard updates | ✅ 5s polling | ❌ WebSocket | Snapshot data, few viewers; nothing flows client→server on a live channel |
| The upgrade path | ✅ SSE, if push is ever needed | ❌ WebSocket | One-way traffic over plain HTTP, with automatic browser reconnect |
| API contract | ✅ Explicit row→DTO mapping | ❌ Returning `result.rows` | A raw row makes the DB schema the public contract |
| Frontier storage | ✅ Redis queue + PG durability | ❌ Pure Postgres `SKIP LOCKED` | Keeps the hot dequeue off the priority index |
| Claiming a URL | ✅ Host lock + conditional `UPDATE ... WHERE status='pending'` | ❌ Host lock alone | Lock TTL is the crawl delay, shorter than a fetch — it can't guarantee exclusivity |
| Retries | ✅ Eligible-at scores in the same queue | ❌ Separate delay queue / cron | Backoff and Retry-After become just a future score |
| Dedup | ✅ Exact Redis SET | ❌ Bloom filter | No false positives at this scale; Bloom (with deterministic misses) past ~1B URLs |
| Politeness | ✅ Per-domain `SET NX PX` lock covering retries and redirects | ❌ Global rate limiter | Lock TTL *is* the crawl delay; every request to a host passes the same gate |
| Domain updates | ✅ Dual-write, Postgres first, then Redis | ❌ Redis first | Postgres-first failures converge on retry; override can only slow a host |
| robots.txt 5xx | ✅ Defer as transient (fail closed) | ❌ Assume allowed | Don't crawl a struggling site blind |
| Crash recovery | ✅ Lease reset + Redis re-enqueue, every minute | ❌ Long transaction per fetch | A hung HTTP request must not hold a DB lock |
| Operator settings in Redis | ✅ One SET + one HASH, rebuilt atomically | ❌ A key per domain | Rebuild can remove stale entries without scanning every key |
| Session revocation | ✅ `session_version` checked per protected request | ❌ Stateless JWT | Disable / demote / password reset takes effect on the next request |
| Shared-host politeness | ✅ Second lock on resolved IP (looser than per-domain) | ❌ Per-domain only | Many domains on one server would otherwise be hit in parallel |
| Local dev topology | ✅ Compose profiles | ❌ Everything on by default | The app containers published the same port the source-run backend needs |

---

## 🚀 Future Enhancements

1. **Bloom-filter dedup** with Postgres as the exact backstop, once the visited set outgrows memory
2. **SSE stats stream** if the dashboard ever becomes multi-tenant
3. **Generated types from the schema**, so the row→DTO mapping is checked rather than reviewed
4. **A Puppeteer lane** for URLs whose extraction comes back suspiciously empty — likely JS-rendered
5. **CDN-aware per-IP limits**: the per-IP lock protects shared hosts, but large CDNs serve unrelated sites from shared anycast IPs, where a strict per-IP limit throttles all of them

---

## 📝 Summary

Two threads run through this design.

**Match the mechanism to the shape of the data.** Frontier URLs are hot and ordered, so they live in Redis sorted sets with Postgres underneath for durability and inspectability. Visited hashes are a membership test, so they're a set. Politeness is a time-bounded exclusive claim, so it's a key with a TTL — the expiry *is* the crawl delay, which means the data structure enforces the policy instead of a scheduler doing it. Dashboard stats are a snapshot read by a few operators, so they're polled.

**Be suspicious at the boundaries and trust the interior.** A crawler consumes adversarial input by definition, so extracted URLs are re-parsed, content is length-bounded, and non-HTML responses short-circuit. The same discipline applies to the API boundary, and this system learned it the hard way: two independently-declared TypeScript interfaces that both compiled, disagreed, and rendered `undefined` to every user. Type safety inside a process says nothing about the contract between two of them.
