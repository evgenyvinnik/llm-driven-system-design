# Web Crawler - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 📋 Introduction (2 minutes)

"Thank you for having me. Today I'll design a distributed web crawler for indexing the internet at scale. This system is fascinating from a backend perspective because it requires:

1. **Two-level URL frontier** with priority queues and per-domain rate limiting
2. **Distributed coordination** across crawler workers using consistent hashing
3. **Massive deduplication** using Bloom filters for URLs and SimHash for content
4. **Politeness enforcement** respecting robots.txt and rate limits per domain

The core backend challenge is crawling billions of pages while being a good citizen of the web. Let me clarify the requirements."

---

## 🎯 Requirements Clarification (5 minutes)

### Functional Requirements

"For our distributed crawler:

1. **URL Discovery**: Extract and queue links from crawled pages
2. **Page Fetching**: Download pages respecting robots.txt and rate limits
3. **Content Storage**: Store crawled content for indexing
4. **Duplicate Detection**: Avoid re-crawling identical URLs and content
5. **Prioritization**: Crawl important pages first based on domain authority

I'll focus on the URL frontier design, distributed crawling, and deduplication since those are the most challenging backend problems."

### Non-Functional Requirements

"Key constraints:

- **Scale**: 10 billion pages, 1 billion unique domains
- **Throughput**: 10,000 pages/second across all workers
- **Freshness**: Re-crawl important pages within 24 hours
- **Politeness**: Maximum 1 request per second per domain
- **Storage**: Efficient storage for page content and metadata

The politeness constraint is critical - we must be good citizens or risk getting blocked."

---

## 🏗️ High-Level Design (8 minutes)

### Architecture Overview

```
+------------------------------------------------------------------+
|                      SEED URL INGESTION                          |
|              (Admin API, Sitemaps, External Sources)             |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                        URL FRONTIER                              |
|  +------------------------------------------------------------+  |
|  |              FRONT QUEUES (Priority-Based)                 |  |
|  |         HIGH ---------> MEDIUM ---------> LOW              |  |
|  +------------------------------------------------------------+  |
|                               |                                  |
|                               v                                  |
|  +------------------------------------------------------------+  |
|  |             BACK QUEUES (Per-Domain Politeness)            |  |
|  |   [Domain A] | [Domain B] | [Domain C] | ... | [Domain N]  |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
                               |
           +-------------------+-------------------+
           |                   |                   |
           v                   v                   v
    +-----------+       +-----------+       +-----------+
    | WORKER 1  |       | WORKER 2  |       | WORKER N  |
    |  - Fetch  |       |  - Fetch  |       |  - Fetch  |
    |  - Parse  |       |  - Parse  |       |  - Parse  |
    | - Extract |       | - Extract |       | - Extract |
    +-----------+       +-----------+       +-----------+
           |                   |                   |
           +-------------------+-------------------+
                               |
                               v
+------------------------------------------------------------------+
|                       STORAGE LAYER                              |
+------------------+------------------+----------------------------+
|   PostgreSQL     |      Redis       |      Object Store          |
| - URL frontier   | - Bloom filter   |    - Page content          |
| - Crawl state    | - Rate limits    |    - Robots.txt cache      |
| - Domain meta    | - URL dedup      |    - Screenshots           |
+------------------+------------------+----------------------------+
```

### Two-Level Queue Design

"The URL frontier uses a two-level queue architecture inspired by the Mercator paper:

**Front Queues (Priority-based)**:
- High: Seed URLs, homepages, important pages
- Medium: Content pages, blog posts
- Low: Pagination, archives, less important

**Back Queues (Domain-based)**:
- One queue per domain
- Enforces per-domain rate limiting
- Prevents any single domain from dominating

This separation ensures priority is respected while maintaining politeness."

---

## 🔍 Deep Dive: URL Frontier Implementation (10 minutes)

### Why PostgreSQL for the URL Frontier?

| Approach | Pros | Cons |
|----------|------|------|
| **PostgreSQL** | ACID guarantees, complex queries, durable | Slower than in-memory |
| Kafka | High throughput, partitioning | Overkill for learning, harder to query |
| Redis only | Fast, simple | Not durable, limited querying |
| Cassandra | Massive scale (10B+ URLs) | More operational overhead |

**Decision: PostgreSQL**

"PostgreSQL gives us ACID guarantees for URL state transitions. When a worker picks up a URL, we need atomicity - the URL must transition from pending to processing without race conditions. PostgreSQL's SELECT FOR UPDATE SKIP LOCKED is perfect for this pattern. At 10 billion URLs, we'd migrate to Cassandra, but PostgreSQL teaches the fundamentals."

### URL Frontier Data Model

**Core Entities:**

| Entity | Key Fields | Purpose |
|--------|------------|---------|
| url_frontier | url, url_hash, domain, priority, status, scheduled_at | Queue of URLs to crawl |
| domains | domain, robots_txt, crawl_delay, last_crawl_at, is_blocked | Per-domain metadata |
| crawled_pages | url, content_hash, status_code, storage_path | Crawl results |

**Status State Machine:**

```
  pending -----> processing -----> completed
     |               |
     |               v
     +--------> failed (retry_count < 3)
                    |
                    v
               abandoned (retry_count >= 3)
```

### Why Redis Bloom Filter for URL Deduplication?

| Approach | Pros | Cons |
|----------|------|------|
| **Redis Bloom Filter** | O(1) lookup, ~1.25GB for 10B URLs, no false negatives | False positives (~1%) |
| Redis SET | Exact, no false positives | ~640GB RAM for 10B URLs |
| PostgreSQL lookup | No new dependency, exact | Too slow for hot path |
| HyperLogLog | Very compact | Only counts, can't check membership |

**Decision: Redis Bloom Filter**

"Bloom filters are perfect for URL deduplication. A false positive means we might skip a URL we haven't seen - acceptable since we'll likely discover it again. A false negative would mean re-crawling - Bloom filters guarantee this never happens. With 10 hash functions and 10 billion bits (~1.25GB), we get ~1% false positive rate. That's a great trade-off."

### Bloom Filter Mechanics (Whiteboard)

```
URL: "https://example.com/page1"
                |
                v
        +---------------+
        |   Normalize   |  (lowercase, remove fragments, trailing slashes)
        +---------------+
                |
                v
        +---------------+
        |   Hash (x10)  |  (10 different hash positions)
        +---------------+
                |
                v
   Position: [142, 8391, 2847, 9102, 4427, 7183, 512, 6294, 3871, 9934]
                |
   +------------+------------+
   |                         |
   v                         v
+--------+               +--------+
| CHECK  |               |  MARK  |
| All 1? |               | Set 1s |
+--------+               +--------+
   |                         |
   v                         v
If ALL bits are 1       Set all 10 bits to 1
-> "Probably seen"      -> URL now "seen"
```

---

## 🔍 Deep Dive: Politeness and Rate Limiting (8 minutes)

### Why Redis for Rate Limiting?

| Approach | Pros | Cons |
|----------|------|------|
| **Redis SET NX + TTL** | Atomic, distributed, auto-expiry | Additional dependency |
| In-memory per worker | Simple, fast | Not distributed, domain conflicts |
| PostgreSQL advisory locks | No new dependency | Slower, adds DB load |
| Token bucket (Redis) | Smoother rate limiting | More complex implementation |

**Decision: Redis SET NX + TTL**

"Redis gives us atomic distributed locks with automatic TTL expiry. One command handles acquire plus timeout. Workers don't need to coordinate - if SET NX succeeds, you have the lock. When it fails, another worker is crawling that domain. The TTL ensures locks don't get stuck if workers crash."

### Rate Limiting Flow (Whiteboard)

```
Worker wants to crawl example.com
              |
              v
+---------------------------+
| GET ratelimit:example.com |
| (last crawl timestamp)    |
+---------------------------+
              |
              v
    +-------------------+
    | NOW - last_crawl  |
    | < crawl_delay_ms? |
    +-------------------+
         |         |
        YES        NO
         |         |
         v         v
     +------+  +----------------------------------+
     | WAIT |  | SET lock:example.com "1"        |
     +------+  | PX {delay_ms} NX                |
               +----------------------------------+
                              |
                 +------------+------------+
                 |                         |
              SUCCESS                    FAIL
                 |                         |
                 v                         v
          +------------+            +------------+
          | CRAWL NOW  |            | SKIP DOMAIN|
          | Update ts  |            | Try another|
          +------------+            +------------+
```

### robots.txt Caching Strategy

| Approach | Pros | Cons |
|----------|------|------|
| **Redis + PostgreSQL** | Fast reads, durable storage | Two stores to maintain |
| Redis only | Simple, fast | Lost on restart |
| PostgreSQL only | Durable, queryable | Slower for hot path |
| S3/MinIO only | Cheap storage | High latency |

**Decision: Redis + PostgreSQL**

"We cache robots.txt in Redis with 1-hour TTL for fast access - every crawl needs to check it. PostgreSQL stores the authoritative copy for durability and auditing. On cache miss, we fetch from PostgreSQL first, then from the origin if stale. This gives us both speed and durability."

### Adaptive Rate Limiting

"We don't just respect robots.txt - we adapt to server health:

| Server Response | Action |
|-----------------|--------|
| Response time > 5 seconds | Increase crawl delay by 500ms |
| Response time < 500ms | Decrease delay by 100ms (never below robots.txt minimum) |
| HTTP 429 (Too Many Requests) | Double crawl delay, back off exponentially |
| HTTP 503 (Service Unavailable) | Circuit breaker opens |

This keeps us polite even when robots.txt doesn't specify a crawl-delay."

---

## 🔍 Deep Dive: Content Deduplication with SimHash (6 minutes)

### Why SimHash for Near-Duplicate Detection?

| Approach | Pros | Cons |
|----------|------|------|
| **SimHash** | Fixed size (64 bits), fast comparison, good for documents | Less accurate than MinHash for small docs |
| MinHash | Better for Jaccard similarity, adjustable precision | Variable size, more complex |
| Exact hash (SHA-256) | Simple, exact | No near-duplicate detection |
| Machine learning | Most accurate | Slow, expensive, complex |

**Decision: SimHash**

"SimHash produces a 64-bit fingerprint for any document. Two documents are near-duplicates if their Hamming distance (number of different bits) is 3 or less. This catches boilerplate pages, paginated content with minor differences, and mirror sites. At 64 bits per page, we can store billions of fingerprints efficiently."

### SimHash Algorithm (Whiteboard)

```
Page Content: "the quick brown fox jumps over the lazy dog"
                               |
                               v
+----------------------------------------------------------+
| STEP 1: Extract Shingles (k=3 word windows)              |
+----------------------------------------------------------+
| "the quick brown" | "quick brown fox" | "brown fox jumps"|
+----------------------------------------------------------+
                               |
                               v
+----------------------------------------------------------+
| STEP 2: Hash Each Shingle to 64 bits                     |
+----------------------------------------------------------+
| shingle_1 -> 1101001010110100...                         |
| shingle_2 -> 0110101101001011...                         |
| shingle_3 -> 1010110010110100...                         |
+----------------------------------------------------------+
                               |
                               v
+----------------------------------------------------------+
| STEP 3: Build Weight Vector (64 dimensions)             |
+----------------------------------------------------------+
| For each bit position:                                   |
|   bit=1 -> add +1 to vector[position]                   |
|   bit=0 -> add -1 to vector[position]                   |
+----------------------------------------------------------+
                               |
                               v
+----------------------------------------------------------+
| STEP 4: Reduce to Fingerprint                           |
+----------------------------------------------------------+
| For each position:                                       |
|   vector[i] > 0 -> fingerprint bit = 1                  |
|   vector[i] <= 0 -> fingerprint bit = 0                 |
+----------------------------------------------------------+
                               |
                               v
            RESULT: 64-bit SimHash fingerprint
```

### Hamming Distance Thresholds

| Distance | Interpretation | Action |
|----------|---------------|--------|
| 0 | Exact duplicate | Skip, log as duplicate |
| 1-3 | Near-duplicate | Skip, link to original |
| 4-10 | Similar but distinct | Crawl, may be useful |
| > 10 | Different content | Crawl normally |

"At distance 3, about 95% match. This catches pagination (page 1, page 2), regional variants (en-US, en-GB), and minor template differences."

---

## 🔍 Deep Dive: Distributed Crawling with Consistent Hashing (5 minutes)

### Why Consistent Hashing for Worker Assignment?

| Approach | Pros | Cons |
|----------|------|------|
| **Consistent hashing** | Minimal reassignment on scaling, deterministic | Slightly complex implementation |
| Random assignment | Simple | Domain could hit multiple workers (cache inefficiency) |
| Round-robin | Even distribution | No domain affinity |
| Kafka partitions | Built-in, robust | Another dependency, less control |

**Decision: Consistent Hashing**

"Consistent hashing assigns each domain to exactly one worker. When we add Worker 5, only ~20% of domains move (1/N). Each worker can cache robots.txt, rate limit state, and connection pools for its assigned domains. Without this, every worker would need to coordinate on every domain."

### Hash Ring (Whiteboard)

```
              0 (top of ring)
              |
              |
     Worker A o--------o Worker B
     (v1,v2,v3)        (v1,v2,v3)
            /            \
           /              \
          /                \
         /   o example.com  \
        /    o github.com    \
       /                      \
      o------------------------o
  Worker D                  Worker C
  (v1,v2,v3)               (v1,v2,v3)

Each worker has 150 virtual nodes for even distribution.

Domain assignment:
1. Hash(domain) -> position on ring
2. Walk clockwise to find nearest worker
3. That worker owns the domain
```

### Worker Coordination Flow

```
+------------------------------------------+
|           COORDINATOR PROCESS            |
+------------------------------------------+
| 1. Query pending domains (LIMIT 10000)   |
| 2. For each: worker = hashRing(domain)   |
| 3. Group domains by worker               |
| 4. Push to Redis: worker:{id}:domains    |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
|            WORKER PROCESS                |
+------------------------------------------+
| 1. Read my domains from Redis            |
| 2. For each assigned domain:             |
|    - Check rate limit                    |
|    - Fetch next URL from frontier        |
|    - Check robots.txt                    |
|    - Crawl page                          |
|    - Extract links -> back to frontier   |
|    - Store content -> object storage     |
+------------------------------------------+
```

---

## 🔍 Deep Dive: Circuit Breaker per Domain (4 minutes)

### Why Circuit Breaker Pattern?

| Approach | Pros | Cons |
|----------|------|------|
| **Circuit breaker** | Prevents cascade failures, auto-recovery | Requires state management |
| Simple retry with backoff | Simple | Keeps trying failed domains |
| Manual blocklist | Full control | Doesn't scale, no auto-recovery |
| Ignore failures | Simple | Wastes resources on dead domains |

**Decision: Circuit Breaker**

"When a domain fails repeatedly (5+ errors), we stop crawling it entirely. After 5 minutes, we try one request. If it succeeds, we resume. If not, we wait longer. This prevents wasting worker capacity on unreachable or broken sites, and automatically recovers when they come back."

### Circuit Breaker State Machine

```
                    +----------------+
                    |     CLOSED     |
                    | (Normal crawl) |
                    +----------------+
                           |
              failures >= 5|
                           v
                    +----------------+
                    |      OPEN      |
                    | (Block domain) |
                    +----------------+
                           |
           after 5 minutes |
                           v
                    +----------------+
                    |   HALF-OPEN    |
                    | (Test 1 request)|
                    +----------------+
                      /           \
               success/             \failure
                    /               \
                   v                 v
            +----------+      +----------------+
            |  CLOSED  |      |      OPEN      |
            | (Resume) |      | (Wait longer)  |
            +----------+      +----------------+
```

### Circuit State Storage

"Circuit breaker state lives in Redis with domain-specific keys:

| Key | Value | Purpose |
|-----|-------|---------|
| circuit:{domain}:failures | Integer | Consecutive failure count |
| circuit:{domain}:state | closed/open/half_open | Current state |
| circuit:{domain}:opened_at | Timestamp | When circuit opened |

When state is 'open' and (now - opened_at) > 5 minutes, transition to half_open and allow one test request."

---

## 📊 API Design (3 minutes)

### Core Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /api/v1/urls/seed | Add seed URLs to frontier |
| GET | /api/v1/urls/pending | Get pending URL count |
| GET | /api/v1/domains | List all domains with stats |
| GET | /api/v1/domains/:domain | Get domain details (robots.txt, crawl stats) |
| PUT | /api/v1/domains/:domain/block | Manually block a domain |
| GET | /api/v1/pages | Search crawled pages |
| GET | /api/v1/workers | List active workers |
| GET | /api/v1/stats | Overall crawl statistics |
| GET | /api/v1/stats/throughput | Pages per second over time |

"The API is intentionally simple. Most crawl operations happen internally. The API exists for monitoring and manual intervention - seeding URLs, blocking abusive domains, checking progress."

---

## ⚖️ Trade-offs and Alternatives (2 minutes)

### Key Technology Decisions

| Component | Chosen | Alternative | Why Chosen |
|-----------|--------|-------------|------------|
| URL Storage | PostgreSQL | Cassandra | ACID guarantees, easier to learn; Cassandra at 10B+ |
| URL Dedup | Redis Bloom | Redis SET | 500x less memory, acceptable 1% false positives |
| Rate Limiting | Redis SET NX | Token bucket | Simpler, lock-based sufficient for our scale |
| Content Dedup | SimHash | MinHash | Fixed size, faster comparison, good for documents |
| Worker Assignment | Consistent hashing | Kafka partitions | More control, no extra dependency |
| Queue Design | Two-level frontier | Single queue | Separates priority from politeness concerns |
| Content Storage | MinIO/S3 | PostgreSQL BLOB | Object storage designed for this, cheaper |
| Robots.txt Cache | Redis + PostgreSQL | Redis only | Need durability across restarts |

### What I'd Do Differently at 100x Scale

| Current | At Scale |
|---------|----------|
| PostgreSQL frontier | Cassandra with partition by domain hash |
| Single coordinator | Kafka for URL stream partitioning |
| Redis Bloom | Distributed Bloom (multiple Redis nodes) |
| HTTP fetching | Keep-alive connection pools per domain |
| SimHash in PostgreSQL | Dedicated SimHash index service |

---

## 🚀 Future Enhancements

"With more time, I would add:

1. **JavaScript rendering** - Puppeteer/Playwright cluster for SPA content. Many modern sites require JS execution to render meaningful content.

2. **Kafka integration** - Replace PostgreSQL frontier with Kafka topics partitioned by domain. Higher throughput, natural backpressure.

3. **Sitemap parsing** - Fetch and parse sitemap.xml to discover URLs more efficiently than crawling.

4. **Page importance scoring** - Machine learning model to prioritize URLs based on predicted value. Train on click-through data from search.

5. **Content extraction pipeline** - Structured data extraction using CSS selectors and ML. Extract articles, products, events."

---

## 📝 Summary

"I've designed a distributed web crawler with:

1. **Two-level URL frontier** - Front queues for priority (high/medium/low), back queues for per-domain politeness. Ensures we crawl important pages first while respecting rate limits.

2. **Bloom filter deduplication** - O(1) URL seen checks at 1.25GB for 10 billion URLs. Trades 1% false positives for massive memory savings.

3. **SimHash content deduplication** - 64-bit fingerprints detect near-duplicate pages. Hamming distance <= 3 means duplicate.

4. **Consistent hashing** - Domain-to-worker assignment with 150 virtual nodes. Adding workers only reassigns ~1/N domains.

5. **Circuit breakers** - Automatic failure isolation per domain. Prevents wasting resources on broken sites, auto-recovers.

6. **Redis rate limiting** - SET NX with TTL for distributed locks. Simple, atomic, automatic expiry.

The architecture respects web politeness while maximizing crawl throughput through distributed coordination. We're being good internet citizens while still crawling billions of pages."
