# Web Crawler - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 📋 Introduction (2 minutes)

"Today I'll design a distributed web crawler — the system that discovers and downloads pages so a search index has something to index. On the surface it's a loop: pop a URL, fetch it, extract links, push the links. The difficulty is that every step of that loop collides with a constraint:

1. **The frontier** has to be prioritized, deduplicated, polite per host, and survive worker crashes — four requirements that pull against each other
2. **Deduplication** sits on the hottest path in the system — hotter than fetching, as the numbers will show
3. **Politeness** is a hard constraint, not a nice-to-have: one aggressive crawler gets its IP range banned from half the web
4. **The open web is adversarial** — infinite URL spaces, redirect loops, servers that hang, robots.txt that returns 503

Let me pin down scope first."

---

## 🎯 Requirements Clarification (4 minutes)

### Functional Requirements

1. **Seed and discover** — accept seed URLs, extract links from fetched pages, enqueue new ones
2. **Fetch politely** — obey robots.txt (allow/disallow and Crawl-delay), at most one request per host per crawl-delay
3. **Store results** — raw content for the indexer, plus metadata (status, title, content hash, links)
4. **Deduplicate** — never fetch the same normalized URL twice per crawl cycle; detect duplicate content
5. **Prioritize** — important pages first (seeds, shallow pages, high-authority hosts)
6. **Re-crawl** — revisit pages on a schedule that tracks how often they change

### Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Corpus | 10 billion pages, ~1 billion hosts |
| Throughput | 10,000 pages/second sustained |
| Politeness | ≤ 1 request/second/host by default; robots.txt Crawl-delay honored |
| Freshness | Top 1% of pages re-crawled within 24 hours |
| Durability | A worker crash loses no frontier entries; a fetch is retried, never forgotten |
| Correctness | No URL fetched twice concurrently; no robots.txt-disallowed URL ever fetched |

"I'll treat robots.txt compliance and politeness as correctness requirements — on par with 'don't lose data' — not as performance knobs."

---

## 📐 Capacity Estimation (4 minutes)

"The numbers change which component I'd worry about first."

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Fetch rate | 10K pages/s → 864M/day | A full 10B-page pass takes ~12 days |
| Bandwidth | 10K × 100 KB avg | ~1 GB/s ≈ 8 Gbps ingress |
| Content storage | 10B × ~25 KB compressed | ~250 TB per full crawl → object storage, not a database |
| Links discovered | ~50 links/page × 10K pages/s | **~500K dedup checks per second** |
| Concurrent fetches | 10K/s × ~500 ms avg latency | ~5,000 requests in flight |
| Active hosts | 10K pages/s ÷ 1 req/s/host | **≥ 10,000 distinct hosts must be ready at every instant** |
| DNS | One lookup per new host-connection | Needs a local caching resolver; public DNS would throttle us |
| Frontier metadata | 10B URLs × ~150 bytes | ~1.5 TB → must be partitioned |

"Two lines matter most. **Dedup runs 50× more often than fetching**, so the seen-set — not the fetcher — is the throughput bottleneck. And **politeness converts throughput into a breadth requirement**: to fetch 10K pages a second at one request per host per second, the frontier must always be able to hand out work from at least 10K different hosts. A frontier that's 'full' but concentrated on a few hundred big sites delivers a few hundred pages per second no matter how many workers we add."

---

## 🏗️ High-Level Design (6 minutes)

```
┌────────────────────┐
│ Seeds / Admin API  │
└─────────┬──────────┘
          ▼
┌──────────────────────────────────────────────────────────────┐
│                         URL FRONTIER                         │
│  Front queues (priority): HIGH ─▶ MEDIUM ─▶ LOW              │
│  Back queues (politeness): per-host, ordered by next-allowed │
└─────────┬────────────────────────────────────────▲───────────┘
          │ claim (host lock + atomic status flip) │ new URLs only
          ▼                                        │
┌──────────────────────┐   ┌──────────────┐  ┌─────┴──────────────┐
│    Fetcher workers   │──▶│ robots cache │  │   URL dedup        │
│ DNS cache · HTTP     │   │ (per origin) │  │ normalize → hash → │
│ no auto-redirects    │   └──────────────┘  │ seen-set check     │
└─────────┬────────────┘                     └─────▲──────────────┘
          ▼                                        │
┌──────────────────────┐   ┌──────────────┐        │
│  Parser / extractor  │──▶│ content dedup│────────┘ links
│ links · meta · <base>│   │ (hash check) │
└─────────┬────────────┘   └──────────────┘
          ▼
┌──────────────────┬───────────────────┬──────────────────────┐
│ Object storage   │ Frontier DB       │ Redis                │
│ WARC page bodies │ url state, retry  │ priority queues,     │
│                  │ counts, domains   │ host locks, seen-set │
└──────────────────┴───────────────────┴──────────────────────┘
```

"The flow is a cycle: frontier → fetch → parse → dedup → frontier. Three things to notice. The **robots cache is consulted per origin** — scheme, host, and port — not per hostname. **Redirects come back through the frontier** instead of being followed inline. And the dedup stage sits between the parser and the frontier, which is where the 500K-per-second load lands."

### Core Data

| Table / Key | Key Columns | Notes |
|-------------|-------------|-------|
| url_frontier | url_hash (unique), url, domain, priority, depth, status, retry_count, last_error, scheduled_at | Status: pending → in_progress → completed / failed; scheduled_at = earliest eligible time |
| crawled_pages | url_hash, status_code, content_hash (indexed), title, links_count, storage_key | Metadata only; body lives in object storage |
| domains | domain (host:port), robots_txt, robots_fetched_at, crawl_delay, is_allowed | is_allowed is an operator block |
| Redis queue:{high,medium,low} | sorted set: member = url_hash, score = eligible-at ms | Retries are just future scores |
| Redis domain:{d}:lock | value = worker id, TTL = crawl delay | The politeness gate |
| Redis visited / content_hashes | sets (Bloom filters at scale) | Membership tests only |

### One URL, End to End

"Walking a single URL through the system makes the responsibilities concrete:

1. A link `https://Blog.example.com/post/?utm_source=x#top` is extracted from a page at depth 2
2. Normalization yields `https://blog.example.com/post`; it's hashed and checked against the seen-set in a batch with the page's other links
3. It's new, so a multi-row insert creates the row (pending, depth 3, priority from depth and path patterns) and its hash is added to the medium queue with score = now
4. A worker scanning eligible hashes finds it, wins the lock for blog.example.com, and flips the row to in_progress
5. robots.txt for `https://blog.example.com` comes from cache; the path is allowed
6. The fetch returns 301 to `/posts/42` — the target is enqueued at the same depth and this URL is marked completed
7. Later the target is fetched (200, text/html): body goes to object storage, metadata to crawled_pages, its content hash is new, so its links go back to step 2
8. Had the fetch timed out instead, retry_count would increment and the hash would return to the queue with a score one backoff interval in the future"

### Content Storage

| Approach | Why / why not |
|----------|---------------|
| ✅ WARC files in object storage | Append-only, compressed, the format indexers and archives already read; 250 TB is an object-store problem |
| ❌ Page bodies in Postgres | Bloats the frontier database, vacuum pain, and nothing queries body bytes relationally |
| ❌ One object per page | 10B tiny objects: per-request cost and metadata overhead dominate |

"Workers batch pages into WARC segments of ~1 GB and record the segment key plus byte offset per page, so the indexer can stream segments sequentially and a single page can still be read with a range request."

---

## 🔧 Deep Dive 1: The URL Frontier (10 minutes)

### Two levels: priority in front, politeness behind

"This is the Mercator design. **Front queues** answer 'what matters most'; **back queues** answer 'which host is allowed right now'. The split matters because the two orderings conflict constantly: the most important URL in the system is often on a host we hit 200ms ago. A single priority queue would either block on that host (head-of-line blocking) or skip it and lose ordering. With two levels, the scheduler takes the highest-priority URL **whose host is currently eligible**."

### The claim: a lock is not enough

"A worker claims work in two steps:

1. Acquire the host's politeness lock — `SET domain:{d}:lock worker NX PX {delay}`. Winning means at least one crawl-delay has passed since anyone last started a request to that host. The TTL *is* the delay, so no scheduler has to track 'next allowed time', and a crashed worker can never deadlock a host.
2. Flip the row with a **conditional update** — set status to in_progress only where status is still pending — and proceed only if exactly one row changed.

The tempting shortcut is to treat the lock as worker exclusivity too. It isn't: the lock expires after the crawl delay (one second), and a fetch can take thirty. A second worker can legitimately win the lock for the same host while the first is still downloading — which is fine for politeness (request *starts* are still spaced) but means the lock alone can't stop two workers from claiming the *same URL* if a stale queue entry hands it to both. The conditional update is what makes the claim exactly-once. If it loses, the worker releases its lock with a compare-and-delete so it doesn't burn the host's slot."

### Retries without a timer service

"Every queue member's score is the time it becomes eligible, not the time it was discovered. A new URL scores 'now'. A URL that hit a timeout scores 'now plus backoff'. Dequeue only reads members with score ≤ now. That one choice gives us delayed retries, Retry-After support, and circuit-breaker deferrals with no separate delay queue and no cron."

### Why Redis + Postgres, and what the seam costs

| Approach | Strength | Why it fails here |
|----------|----------|-------------------|
| ✅ Redis sorted sets + Postgres rows | Hot dequeue in memory; durable, queryable state | Two stores can disagree — needs repair paths |
| ❌ Postgres only (FOR UPDATE SKIP LOCKED) | One source of truth, no seam | Every dequeue is a locking scan on the hottest index, contending with ~500K inserts/s of discoveries |
| ❌ Kafka partitions as the frontier | Huge throughput, ordered | Can't reprioritize, can't delay a single message, can't ask 'what's pending for host X' |
| ❌ Redis only | Simplest, fastest | A Redis restart loses the crawl |

"I chose the hybrid, and the honest cost is the consistency seam. Three repair paths make it safe:

- **Re-validate on dequeue.** Redis is a hint about what to look at; Postgres decides. Hashes whose rows are no longer pending are dropped in one batch.
- **Lease recovery re-enqueues.** A row stuck in_progress past its lease goes back to pending *and back into Redis*. Resetting only the row is a classic bug: workers dequeue from Redis, so a row that's pending in Postgres but absent from Redis is invisible forever.
- **Rehydrate on loss.** A periodic job compares queued count to pending count; if Redis is short (restart, flush), it walks pending rows by keyset pagination and re-adds them with ZADD NX, so existing retry delays are preserved.

The general rule: **the fast store may be stale or missing, never authoritative**, and every way it can go wrong has a path back to the durable store."

### Making dequeue cheap

"A naive dequeue reads the top 100 hashes and runs 100 point queries. Two fixes: load all 100 rows in one query, and remember which hosts were locked in this pass so one hot host doesn't cost 100 lock attempts. At full scale, the better structure is a **ready-host heap** — one entry per host keyed by next-allowed time — so a worker pops an eligible host in O(log n) instead of scanning URLs. That's also what solves the breadth requirement from the estimate: the heap makes the number of ready hosts directly observable."

---

## 🔧 Deep Dive 2: Deduplication at 500K Checks per Second (8 minutes)

### Normalization is where dedup actually fails

"Hashing is trivial; deciding that two strings are the same URL is not. Before hashing: lowercase scheme and host, drop default ports, drop the fragment, strip trailing slashes, sort query parameters, and **drop tracking parameters** like utm_*, gclid, and fbclid. That last one matters more than it sounds — one newsletter campaign can mint a thousand aliases of every page on a site. Normalization must live in exactly one function; if two code paths normalize differently, dedup silently fails and the crawler re-fetches forever."

### Exact set vs Bloom filter

| Approach | Memory for 10B URLs | Failure mode |
|----------|---------------------|--------------|
| Exact set of 32-byte hashes | ~320 GB raw, more with overhead | None — but doesn't fit one node |
| ✅ Bloom filter, 1% false positives | ~12 GB (≈ 9.6 bits per URL, 7 hashes) | 1 in 100 new URLs wrongly marked 'seen' |
| ✅ Bloom filter, 0.1% false positives | ~18 GB (≈ 14.4 bits per URL, 10 hashes) | 1 in 1,000 |
| ❌ Database lookup per link | Disk-sized | 500K random reads/s on the hot path |

"I'd use a Bloom filter in front with the frontier's unique index as the exact backstop — but I want to be precise about the false-positive cost, because it's commonly misstated. A false positive is **deterministic**: the same URL hashes to the same bits every time, so 'we'll just rediscover it later' is wrong. That URL is never crawled this cycle. The mitigations are a lower false-positive rate (bits are cheap: 0.1% costs 50% more memory than 1%), a fresh filter per crawl cycle so errors don't compound, and bypassing the filter for seeds and sitemap URLs, which go straight to the exact backstop.

At learning scale an exact Redis set is the right call — zero false positives, trivial to reason about — and the switch point is when the set stops fitting in one node's memory."

### Batching is what makes the hot path survivable

"A page yields ~50 links. Checking them one at a time is ~200 round trips per page. Batched, it's constant: one SMISMEMBER against the seen-set, one multi-row INSERT ... ON CONFLICT DO NOTHING RETURNING, one pipelined ZADD for **only the rows that were actually inserted**. That last detail prevents a subtle starvation bug: re-adding an already-queued URL resets its score to 'now', so the most-linked pages on the web — exactly the ones we want first — would be pushed to the back of the queue every time someone links to them."

### Content dedup

"URL dedup doesn't catch mirrors, session-ID variants, or the same article under two paths. I keep an exact content hash per page; if a body's hash is already known, we store the record but **don't re-enqueue its links**, since the first copy already did. Near-duplicates — same article with a different ad block — need SimHash: 64-bit fingerprints where a Hamming distance ≤ 3 means near-duplicate, looked up by splitting the fingerprint into bands so candidates come from an index rather than a scan. I'd ship exact hashing first and add SimHash when duplicate-rate metrics justify it."

---

## 🔧 Deep Dive 3: Politeness and robots.txt (7 minutes)

### robots.txt status codes have meaning

| robots.txt response | Correct interpretation (RFC 9309) |
|---------------------|-----------------------------------|
| 2xx | Parse and obey rules |
| 4xx (including 404) | No restrictions — crawl freely |
| 5xx or unreachable | **Assume full disallow for now; retry later** |
| Body > 500 KiB | Parse the first 500 KiB |

"The 5xx row is the one people get backwards. 'Couldn't fetch robots.txt, so assume allowed' means the moment a site starts failing — exactly when it's least able to absorb load — we start crawling it blind. The right behavior is to defer that host's URLs as transient failures and negatively cache the outage for a minute, so 10,000 URLs from a dead host don't trigger 10,000 robots.txt fetches."

"Two more details that bite in practice: robots.txt is **per origin**, so example.com:8080 has its own file — keying the cache on hostname alone applies the wrong rules. And robots parsers typically only answer for URLs on the same origin they were built for; build the parser with https and ask about an http URL and many libraries return 'no answer', which naive code reads as 'allowed'."

### Every request goes through the gate — including retries and redirects

"Politeness leaks in two places that aren't the main fetch path:

- **In-process retries.** A retry is a new request to the host. If it fires after a jittered backoff without re-acquiring the host lock, it can land milliseconds after another worker's request. Retries must wait for the host's slot like any other fetch.
- **Redirects.** An HTTP client following redirects will happily follow a 301 to a different host — skipping that host's robots.txt and politeness entirely — and relative links on the final page then get resolved against the wrong base URL. I disable automatic redirects and enqueue the Location target as a new URL, so it goes through dedup, robots, and the host lock like anything else."

### Adaptive delay

| Signal | Action |
|--------|--------|
| robots.txt Crawl-delay | Floor for the host (capped at 60s to avoid a typo pinning a worker for a day) |
| HTTP 429 / 503 with Retry-After | Reschedule no earlier than Retry-After |
| Rising latency or error rate | Increase delay; circuit-break after repeated failures |
| Operator override | **Can slow a host down, never speed it below robots.txt** |

"The override rule is deliberate: a dashboard slider that can set a delay below what the site asked for is a way to violate robots.txt with one click."

---

## 🛡️ Failure Handling (5 minutes)

### Classify every outcome

| Outcome | Examples | Action |
|---------|----------|--------|
| Success | 200 text/html | Store, enqueue links, mark completed |
| Redirect | 301/302/307/308 | Enqueue target (same depth), mark completed |
| Permanent | 404, 410, robots disallow, non-HTML, oversized | Mark failed, add to seen-set, never retry |
| Transient | Timeout, reset, 5xx, 429, robots.txt unavailable | retry_count + 1, reschedule at now + base × 2ⁿ with jitter; fail after N |
| Not attempted | Host circuit open | Defer without counting an attempt |

"Without this table, two bad things happen: transient failures become permanent (one network blip and a page is gone for the cycle), or permanent failures retry forever. Jitter matters because failures are correlated — when a host goes down, its thousand URLs fail together and would all come back at the same instant."

### Crash safety by lease

"A worker marks a URL in_progress and fetches **outside** any transaction. If it dies, a lease sweep returns the URL after ten minutes — at-least-once delivery, which is harmless because fetching is idempotent. Holding a database transaction open for the fetch would make recovery automatic, but a slow host would pin a connection for its whole timeout, and the pool would be exhausted by exactly the hosts we least want to wait on. Graceful shutdown matters too: a worker that receives SIGTERM finishes its in-flight crawl before closing connections, or every deploy strands one URL per worker until the lease expires."

### Circuit breaker per host

"After five consecutive transient failures, a host's breaker opens and a shared flag goes into Redis so every worker skips it. The flag's TTL must equal the break duration. If it's longer — say an hour with a one-minute break — every worker skips the host, so no worker ever sends the half-open probe that would close the breaker, and the host stays blocked for the full TTL. URLs for an open-circuit host are deferred, not failed; the host is expected to come back."

---

## 🕳️ Crawler Traps and Freshness (3 minutes)

"Traps are URL spaces that never end: calendars with a 'next month' link, faceted search with every filter combination, session IDs in the path. Defenses, layered:

1. **Max depth** from seed (6 hops is plenty for discovery)
2. **Max URL length** (2,048) — generated URLs are long
3. **Max links per page** (500) — bounds fan-out from link farms
4. **Tracking-param stripping** in normalization
5. **Per-host budget** — a cap on pages per host per cycle, so one infinite site can't eat the crawl

For freshness, each URL gets a revisit interval that adapts to observed change: if the content hash is unchanged on revisit, double the interval; if it changed, halve it. Conditional GETs with If-Modified-Since and ETag make unchanged revisits cost a 304 instead of a full body."

---

## 🔭 Observability (2 minutes)

"A crawler fails quietly — it doesn't crash, it just gets slower or narrower. The metrics I'd alert on are the ones that distinguish *why*:

| Metric | What it tells you |
|--------|-------------------|
| Ready hosts (eligible right now) | The real throughput ceiling; falling = breadth problem, not a worker problem |
| Queue depth by priority + oldest eligible age | Backlog vs starvation of low priority |
| Fetch outcomes by class (2xx/3xx/4xx/5xx/timeout) | A spike in timeouts is our network; a spike in 5xx is theirs |
| Dedup hit rate | A sudden drop usually means a normalization bug or a trap minting new URLs |
| robots.txt unavailable rate | Hosts we are deliberately not crawling |
| Lease recoveries and rehydrated entries | Worker crashes and Redis loss — should be near zero |
| Retries exhausted per host | Candidates for blocking or a lower budget |

The trio pending / in-progress / completed also diagnoses stalls on its own: pending high with in-progress zero means workers are dead or every host is locked; in-progress stuck with completed flat means workers hang mid-fetch."

---

## 📈 Scalability: What Breaks First (3 minutes)

| Bottleneck | Symptom | Fix |
|------------|---------|-----|
| Dedup | Insert latency climbs with discovery rate | Bloom filter in front; shard seen-set by URL hash |
| Frontier DB | Single node can't hold 1.5 TB or absorb inserts | Partition by **host hash** |
| Breadth | Throughput flat despite more workers | Ready-host heap; per-host budgets; more seeds across hosts |
| DNS | Fetch latency dominated by lookups | Local caching resolver, prefetch on enqueue |
| Shared host behind one IP | Many domains, one overloaded server | Politeness keyed on resolved IP as well as host |

"Partitioning by host hash is where consistent hashing earns its place. Each frontier shard owns a set of hosts outright, so politeness becomes a local decision inside the shard instead of a distributed lock, robots.txt and DNS caches stay warm, and adding a shard moves ~1/N of hosts. At smaller scale a shared frontier with Redis locks is simpler and fine — the partitioned design is the answer once the frontier no longer fits one database."

---

## 📊 API Design (2 minutes)

```
POST   /api/v1/admin/seeds                → Add seed URLs (priority, depth 0)
POST   /api/v1/admin/frontier/recover     → Force a lease sweep now
GET    /api/v1/frontier/stats             → Counts by status + queue depths
GET    /api/v1/frontier/urls?status=      → Recent URLs with retry_count, last_error
GET    /api/v1/domains/:domain            → robots.txt, crawl delay, page count
PUT    /api/v1/admin/domains/:domain      → Block/unblock; slow-down override
POST   /api/v1/domains/:domain/robots     → Force robots.txt refresh
GET    /api/v1/stats                      → Counters, active workers, top domains
GET    /metrics                           → Prometheus
```

"Mutating routes sit under /admin behind session auth. The API is for operators — the crawl itself is driven entirely by the frontier."

---

## ❓ Likely Follow-ups

**"A site owner emails asking us to stop crawling them. What happens?"** — An operator blocks the host. The block is published to the store workers read on every claim, so it takes effect on the next fetch, not the next deploy; queued URLs for that host fail permanently with a clear reason rather than being silently dropped.

**"What about JavaScript-rendered pages?"** — A separate rendering lane with headless browsers, fed only URLs whose static extraction came back suspiciously empty. Rendering costs 10–50× a plain fetch, so it can't be the default path, and the rendering pool needs the same politeness gate since a browser fires many sub-requests per page.

**"How do you avoid overloading a shared host?"** — Hundreds of small domains can sit behind one IP. I'd add a second politeness key on the resolved IP with a looser limit, so per-domain spacing still applies and the shared server is protected as a whole.

**"How do you know the crawl is good, not just fast?"** — Track coverage of a known-URL sample (e.g. URLs from sitemaps), duplicate rate, and the share of fetches that produced indexable HTML. Fast and narrow is a failure mode the throughput graph hides.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Frontier | Redis sorted sets + Postgres rows | SKIP LOCKED in Postgres | Hot dequeue in memory; repair paths make the seam safe |
| Claim | Host lock + conditional status update | Host lock alone | Lock TTL < fetch time, so the lock can't guarantee exclusivity |
| Retries | Eligible-at scores in the same queue | Separate delay queue | No extra component; backoff and Retry-After are just scores |
| URL dedup | Bloom filter + exact DB backstop | Exact set | ~20× less memory; deterministic false positives mitigated |
| robots.txt 5xx | Defer as transient | Assume allowed | Don't crawl blind exactly when a host is failing |
| Redirects | Re-enqueue via frontier | Client auto-follow | Target host gets robots + politeness; correct link base |
| Crash recovery | Lease + re-enqueue | Transaction per fetch | A hung request must not pin a DB connection |
| Scale-out | Partition frontier by host hash | Shared frontier + locks | Politeness becomes shard-local |

---

## 📝 Summary

"The frontier is the system: two levels so priority and politeness don't corrupt each other, a host lock for spacing plus a conditional update for exactly-once claims, and eligible-at scores so retries need no extra machinery. Redis serves the hot path, Postgres owns the truth, and every way the two can disagree — stale entries, expired leases, a lost Redis — has a path back.

The estimate drove the rest. Dedup runs 50× more often than fetching, so it gets batching and a correctly-sized Bloom filter, with the honest caveat that its false positives are permanent. Politeness turns throughput into a breadth requirement, so the scheduler is built around ready hosts rather than ready URLs. And because the web is adversarial, politeness covers every request — retries and redirects included — robots.txt failures fail closed, and traps are bounded by depth, length, fan-out, and per-host budgets."
