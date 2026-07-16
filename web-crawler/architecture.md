# Web Crawler - Architecture Design

## System Overview

A distributed web crawling system that discovers, fetches, and extracts content from public HTML pages. The core challenges are URL frontier management with priority-based scheduling, per-domain politeness enforcement, URL deduplication at billion-scale, horizontal worker scaling, and fault-tolerant coordination across distributed crawl workers.

## Requirements

### Functional Requirements

1. **URL Discovery** - Extract and discover new links from crawled pages
2. **Page Fetching** - Download HTML content from web servers with proper error handling, timeouts, and redirect following
3. **Content Extraction** - Parse HTML to extract titles, meta descriptions, and outgoing links using Cheerio
4. **Politeness** - Respect robots.txt directives, implement per-domain rate limiting with configurable crawl delays
5. **Deduplication** - Avoid crawling duplicate URLs using normalized URL hashing
6. **Prioritization** - Crawl important pages first (seeds, homepages, shallow pages) using a 3-level priority queue

### Non-Functional Requirements

| Requirement | Target (Production) |
|-------------|---------------------|
| Crawl rate | 400+ pages/second |
| Workers | 80-150 stateless workers |
| Availability | 99.9% uptime; workers fail independently |
| Dashboard latency | < 1s updates |
| Consistency | Eventual (small duplicate window acceptable) |
| Politeness | Max 1 req/sec per domain by default; respect robots.txt crawl-delay |

### Non-Goals (v1)

- Full JavaScript rendering (SPA support deferred to v2)
- PageRank or advanced ranking algorithms
- Full-text search indexing
- Near-real-time freshness guarantees
- Anti-bot evasion or stealth crawling
- Content storage in object storage (raw HTML archival)

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Target crawl rate | 400+ pages/second |
| Workers | 80-150 |
| Storage per page (metadata) | ~100 bytes URL + ~1KB metadata |
| URL frontier size | Billions of URLs |
| robots.txt cache | ~100GB (millions of domains) |
| Bytes downloaded | ~8 GB/hour at 400 pages/sec x 20KB avg |
| Daily pages crawled | ~35 million |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Crawl rate | 10-50 pages/second |
| Workers | 3-5 |
| URL frontier | 100K URLs |
| Storage per page | ~20KB compressed |

## High-Level Architecture

```
                           ┌─────────────────────────┐
                           │    Admin Dashboard       │
                           │    (React + Vite)        │
                           │                          │
                           │  - Crawl stats/charts    │
                           │  - Frontier management   │
                           │  - Domain inspection     │
                           └────────────┬─────────────┘
                                        │ HTTP
                                        ▼
                           ┌─────────────────────────┐
                           │      API Server          │
                           │      (Express.js)        │
                           │                          │
                           │  - Stats / timeseries    │
                           │  - Frontier CRUD         │
                           │  - Seed injection        │
                           │  - Domain management     │
                           │  - Auth + RBAC           │
                           │  - Rate limiting         │
                           └────────────┬─────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
    ┌─────────▼──────────┐   ┌─────────▼──────────┐   ┌─────────▼──────────┐
    │  Crawler Worker 1  │   │  Crawler Worker 2  │   │  Crawler Worker N  │
    │                    │   │                    │   │                    │
    │  ┌──────────────┐  │   │  ┌──────────────┐  │   │  ┌──────────────┐  │
    │  │ Fetch Page   │  │   │  │ Fetch Page   │  │   │  │ Fetch Page   │  │
    │  ├──────────────┤  │   │  ├──────────────┤  │   │  ├──────────────┤  │
    │  │ Parse HTML   │  │   │  │ Parse HTML   │  │   │  │ Parse HTML   │  │
    │  ├──────────────┤  │   │  ├──────────────┤  │   │  ├──────────────┤  │
    │  │ Extract Links│  │   │  │ Extract Links│  │   │  │ Extract Links│  │
    │  ├──────────────┤  │   │  ├──────────────┤  │   │  ├──────────────┤  │
    │  │ Check Robots │  │   │  │ Check Robots │  │   │  │ Check Robots │  │
    │  ├──────────────┤  │   │  ├──────────────┤  │   │  ├──────────────┤  │
    │  │ Circuit Brkr │  │   │  │ Circuit Brkr │  │   │  │ Circuit Brkr │  │
    │  └──────────────┘  │   │  └──────────────┘  │   │  └──────────────┘  │
    └─────────┬──────────┘   └─────────┬──────────┘   └─────────┬──────────┘
              │                         │                         │
              └─────────────────────────┼─────────────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
             ┌──────▼───────┐   ┌───────▼────────┐  ┌──────▼───────┐
             │  PostgreSQL  │   │     Redis      │  │   Kafka      │
             │              │   │                │  │  (Prod Only) │
             │ - URL Frontr │   │ - Visited URLs │  │              │
             │ - Crawled    │   │ - Domain locks │  │ - URL ingest │
             │   pages      │   │ - Robots cache │  │ - Crawl      │
             │ - Domains    │   │ - Rate limits  │  │   events     │
             │              │   │ - Circuit brkr │  │              │
             └──────────────┘   │ - Sessions     │  └──────────────┘
                                └────────────────┘
```

### Core Components

| Component | Responsibility |
|-----------|---------------|
| **API Server** | RESTful API for dashboard, seed injection, frontier management, stats, auth/RBAC |
| **Crawler Workers** | Stateless processes that fetch pages, parse HTML, extract links, and update the frontier |
| **URL Frontier** | Priority queue (PostgreSQL) deciding what to crawl next; tracks URL state and scheduling |
| **Robots Service** | Fetch, parse, and cache robots.txt per domain; answer "Is this URL allowed?" |
| **Parser/Extractor** | Parse HTML DOM with Cheerio; extract title, description, and outgoing links |
| **URL Ingestion** | Normalize discovered URLs, deduplicate via Redis SET, enqueue eligible URLs |

### Data Flow

```
1. Seed URLs inserted into url_frontier with high priority
2. Worker claims a URL: UPDATE url_frontier SET status='in_progress' WHERE ...
3. Worker checks robots.txt (Redis cache -> PostgreSQL -> fetch if missing)
4. Worker checks per-domain rate limit (Redis SET NX EX)
5. Worker fetches page via HTTP with circuit breaker protection
6. Parser extracts title, description, links from HTML
7. Discovered links normalized, deduplicated (Redis SISMEMBER), and enqueued
8. Page metadata stored in crawled_pages
9. Worker updates url_frontier status to 'completed' or 'failed'
10. Dashboard polls API for real-time statistics
```

## Database Schema

### URL Frontier

The frontier is the priority queue deciding what to crawl next. URLs are grouped by domain, and each domain has politeness constraints.

```sql
-- URL Frontier: Queue of URLs to crawl
CREATE TABLE url_frontier (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    url_hash VARCHAR(64) NOT NULL UNIQUE,    -- SHA-256 of normalized URL
    domain VARCHAR(255) NOT NULL,
    priority INTEGER DEFAULT 1,               -- 1=low, 2=medium, 3=high
    depth INTEGER DEFAULT 0,                  -- Crawl depth from seed
    status VARCHAR(20) DEFAULT 'pending',     -- pending, in_progress, completed, failed
    scheduled_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_frontier_priority ON url_frontier (priority DESC, scheduled_at ASC);
CREATE INDEX idx_frontier_domain ON url_frontier (domain);
CREATE INDEX idx_frontier_status ON url_frontier (status);
CREATE INDEX idx_frontier_status_priority ON url_frontier (status, priority DESC, scheduled_at ASC)
    WHERE status = 'pending';
```

### Crawled Pages

Metadata about fetched pages. Raw HTML content is not stored in v1 (would go to S3/MinIO in v2).

```sql
-- Crawled Pages: Metadata about fetched pages
CREATE TABLE crawled_pages (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    url_hash VARCHAR(64) NOT NULL UNIQUE,
    domain VARCHAR(255) NOT NULL,
    status_code INTEGER,
    content_type VARCHAR(100),
    content_length INTEGER,
    content_hash VARCHAR(64),                 -- SHA-256 of extracted content
    title TEXT,
    description TEXT,
    links_count INTEGER DEFAULT 0,
    crawled_at TIMESTAMP DEFAULT NOW(),
    crawl_duration_ms INTEGER,
    error_message TEXT
);

CREATE INDEX idx_pages_domain ON crawled_pages (domain);
CREATE INDEX idx_pages_crawled_at ON crawled_pages (crawled_at DESC);
```

### Domains

Per-domain settings and robots.txt cache.

```sql
-- Domains: Per-domain settings and robots.txt cache
CREATE TABLE domains (
    id SERIAL PRIMARY KEY,
    domain VARCHAR(255) NOT NULL UNIQUE,
    robots_txt TEXT,
    robots_fetched_at TIMESTAMP,
    crawl_delay FLOAT DEFAULT 1.0,            -- Seconds between requests
    page_count INTEGER DEFAULT 0,
    is_allowed BOOLEAN DEFAULT true            -- Whether crawling is permitted
);
```

### Priority Signals

| Level | Score | Criteria |
|-------|-------|----------|
| High | 3 | Seed URLs, homepages, shallow pages (depth <= 2) |
| Medium | 2 | Content pages, blog posts, /about, /contact |
| Low | 1 | Paginated content, archives, deep pages (depth > 5) |

### Redis Data Structures

```
# URL deduplication (visited URLs set)
crawler:visited_urls              -> SET of URL hashes (SADD, SISMEMBER)

# Per-domain rate limiting locks
crawler:domain:{domain}:lock      -> SET NX EX (distributed lock with TTL)

# Per-domain crawl delay
crawler:domain:{domain}:delay     -> STRING (crawl delay in seconds)

# Robots.txt cache
crawler:domain:{domain}:robots    -> STRING (cached robots.txt content, 1h TTL)

# Circuit breaker state per domain
crawler:circuit:{domain}          -> STRING (closed/open/half-open, 1h TTL)

# Worker heartbeats
crawler:worker:{id}               -> HASH (lastHeartbeat, status, currentUrl)

# Active workers set
crawler:active_workers            -> SET of worker IDs

# Crawl statistics
crawler:stats:pages_crawled       -> Counter (INCR)
crawler:stats:pages_failed        -> Counter (INCR)
crawler:stats:bytes_downloaded    -> Counter (INCRBY)

# Session storage
sess:{session_id}                 -> JSON (userId, role, createdAt)
```

### URL Normalization Rules

Before hashing, URLs are normalized to prevent duplicate crawling:

1. Lowercase scheme and hostname
2. Remove fragment (`#...`)
3. Normalize default ports (`:80` for HTTP, `:443` for HTTPS)
4. Sort query parameters alphabetically
5. Remove known tracking params (`utm_source`, `utm_medium`, `utm_campaign`, `ref`)
6. Remove trailing slashes
7. Decode percent-encoded characters where safe

## API Design

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check with PostgreSQL/Redis status |
| GET | `/api/stats` | Comprehensive crawl statistics |
| GET | `/api/stats/timeseries` | Time-series data for charts |
| GET | `/api/frontier/stats` | Frontier queue statistics |
| GET | `/api/frontier/urls` | List URLs in frontier (filtered) |
| POST | `/api/frontier/add` | Add URLs to frontier |
| POST | `/api/frontier/seed` | Add seed URLs with high priority (admin) |
| POST | `/api/frontier/recover` | Recover stale in-progress URLs (admin) |
| GET | `/api/pages` | List crawled pages with filtering |
| GET | `/api/domains` | List crawled domains |
| GET | `/api/domains/:domain/robots` | Get cached robots.txt |
| GET | `/metrics` | Prometheus metrics endpoint |

### Authentication and RBAC

| Role | Permissions | Endpoints |
|------|-------------|-----------|
| anonymous | Read public stats | `GET /health`, `GET /api/stats` |
| user | View dashboard, read all data | `GET /api/*` |
| admin | Full access, seed URLs, clear frontier | `POST /api/frontier/*`, `DELETE /api/*` |

### API Rate Limiting

| Tier | Limit | Window | Applies To |
|------|-------|--------|------------|
| Anonymous | 10 req | 1 min | Unauthenticated requests |
| User | 100 req | 1 min | Regular authenticated users |
| Admin | 500 req | 1 min | Admin operations |
| Seed injection | 10 req | 1 min | `POST /api/frontier/seed` |

Rate limiting uses Redis sliding window: ZREMRANGEBYSCORE to remove old entries, ZADD to add current request, ZCARD to count requests in window.

## Key Design Decisions

### 1. URL Frontier: hybrid Redis queue + PostgreSQL state (vs Kafka)

**Chosen: Redis priority sorted-sets for the hot dequeue path, PostgreSQL for durable, queryable frontier state.** The frontier needs three things: fast "get the next highest-priority URL" (Redis), durable status tracking that survives a restart and is inspectable (PostgreSQL), and idempotent enqueue. The implementation splits them: `addUrl` inserts into `url_frontier` with `ON CONFLICT (url_hash) DO NOTHING` *and* pushes the URL hash onto one of three Redis sorted-sets (high/medium/low) keyed by insert time. `getNextUrl` pops candidates from Redis high→medium→low, loads the row from PostgreSQL, and flips its status to `in_progress`. Kafka would give higher throughput but loses queryability -- you cannot inspect, reprioritize, or recover stale URLs from a topic, and frontier management needs random access.

**Why not pure PostgreSQL with `FOR UPDATE SKIP LOCKED`?** That's the textbook single-store answer and it works, but every dequeue then contends on the priority index under all workers at once. Putting the priority ordering in Redis sorted-sets keeps the hot path off the PostgreSQL index; PostgreSQL is consulted per-URL by primary/unique key (`url_hash`), which is cheap. The cost is that Redis and PostgreSQL can briefly disagree — a URL hash can sit in a Redis queue after its row already moved on — so `getNextUrl` re-checks `status = 'pending'` in PostgreSQL and drops stale queue entries.

**Trade-off acknowledged:** the two stores are eventually consistent, and Redis is the volatile half — if Redis is flushed, the priority queues must be rebuilt from `url_frontier` (the durable source of truth). Worker exclusivity is *not* provided by a database row lock here; it comes from the per-domain Redis lock in Decision 3. Production would partition the frontier by domain across multiple queue shards.

### 2. URL Deduplication: Redis SET vs Bloom Filter

**Chosen: Redis SET of URL hashes.** Each normalized URL is SHA-256 hashed (64 bytes) and checked against a Redis SET using SISMEMBER (O(1)). This provides exact deduplication with zero false positives. A Bloom filter would use ~10x less memory but introduces false positives (URLs never crawled because they "look" visited), which means missed pages.

**Trade-off acknowledged:** At 10 billion URLs, Redis SET requires ~640GB RAM (64 bytes x 10B). Production would use a probabilistic approach: Bloom filter for first-pass dedup (accepting ~0.1% false positive rate), with PostgreSQL as the source of truth for exact checks on Bloom-positive URLs. The learning project uses exact dedup because memory is not a constraint at 100K URLs.

### 3. Per-Domain Rate Limiting: Redis Locks vs Token Bucket

**Chosen: Redis SET NX EX (distributed lock with TTL).** When a worker wants to crawl a domain, it attempts `SET crawler:domain:{domain}:lock {workerId} NX EX {crawlDelay}`. If successful, it proceeds; otherwise, it skips this domain and picks another URL. The TTL equals the domain's crawl-delay (from robots.txt or default 1s), ensuring automatic lock expiry.

**Trade-off acknowledged:** This is domain-level, not path-level granularity. A domain with crawl-delay=1s allows only 1 req/sec regardless of how many workers exist. Token bucket would allow smoother rate distribution (e.g., 10 req/10s instead of 1 req/s), but adds implementation complexity for marginal benefit. The lock approach also wastes worker cycles when all available domains are locked -- production would use a work-stealing queue per domain shard.

### 4. HTML Parsing: Cheerio vs Puppeteer

**Chosen: Cheerio (server-side DOM parser).** Cheerio parses HTML in ~5ms vs Puppeteer's ~500ms (launching headless Chrome). For a basic crawler that processes static HTML, Cheerio extracts titles, descriptions, and links 100x faster with 50x less memory. Puppeteer is only needed for JavaScript-rendered SPAs, which are a v2 feature.

**Trade-off acknowledged:** ~30% of modern web pages rely on JavaScript for content rendering. A Cheerio-only crawler will extract empty or incomplete content from React/Angular/Vue SPAs. The workaround is to detect empty content and flag those URLs for future Puppeteer processing.

## Consistency and Idempotency

### Idempotency in Crawl Operations

Crawl operations are inherently idempotent: fetching the same URL multiple times produces the same result. However, internal operations need coordination:

- **URL ingestion**: The `url_hash UNIQUE` constraint on url_frontier prevents duplicate URL insertions. `INSERT ... ON CONFLICT (url_hash) DO NOTHING` makes ingestion idempotent.
- **Page metadata**: `url_hash UNIQUE` on crawled_pages with `ON CONFLICT DO UPDATE` ensures re-crawls update rather than duplicate.
- **Worker claim**: exactly-once claiming is enforced by the per-domain Redis lock (`SET domain:lock NX EX crawlDelay`), not a database row lock. A worker only crawls a domain if it wins that lock; it then marks the specific URL `in_progress` in `url_frontier`. Two workers can't hold the same domain's lock, so they can't crawl the same URL concurrently.

### Consistency Model

| Entity | Consistency | Rationale |
|--------|-------------|-----------|
| URL frontier state | Durable in PostgreSQL; exclusivity via per-domain Redis lock | Worker claims must be exclusive; the domain lock (not a row lock) guarantees one crawler per domain |
| Visited URLs (Redis SET) | Eventual (small duplicate window) | Brief period where two workers may crawl the same URL before SET is updated |
| robots.txt cache | Eventual (1h TTL) | Stale robots.txt is acceptable; re-fetch hourly |
| Circuit breaker state | Eventual (Redis, distributed) | Workers share domain failure state with seconds delay |

## Security

| Concern | Mitigation |
|---------|------------|
| Crawler identification | Clear User-Agent with contact info |
| Per-domain rate limiting | Max 1 req/sec per domain by default; respect robots.txt crawl-delay |
| robots.txt compliance | Always checked before crawling; denied domains skipped |
| Request timeouts | 30s timeout prevents hanging on unresponsive servers |
| Page size limit | 10MB max to prevent memory exhaustion |
| Dangerous URL schemes | Skip `file://`, `javascript:`, `tel:`, `mailto:` |
| Dashboard auth | Session-based with Redis; admin-only destructive operations |
| API rate limiting | Tiered limits (anonymous/user/admin) via Redis sliding window |
| Input sanitization | Helmet middleware, compression, CORS |

## Observability

### Metrics (Prometheus via prom-client)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `crawler_pages_crawled_total` | Counter | status, worker_id | Crawl throughput |
| `crawler_crawl_duration_seconds` | Histogram | status, worker_id | Fetch latency distribution |
| `crawler_bytes_downloaded_total` | Counter | worker_id | Bandwidth consumption |
| `crawler_links_discovered_total` | Counter | worker_id | Link extraction rate |
| `crawler_duplicates_skipped_total` | Counter | - | Dedup effectiveness |
| `crawler_frontier_size` | Gauge | status | Queue depth (pending/in_progress/completed/failed) |
| `crawler_domains_total` | Gauge | - | Unique domains discovered |
| `crawler_active_workers` | Gauge | - | Worker fleet size |
| `crawler_errors_total` | Counter | error_type, worker_id | Error classification |
| `crawler_http_status_total` | Counter | status_code, worker_id | HTTP status distribution |
| `crawler_circuit_breaker_state` | Gauge | domain | Per-domain circuit breaker (0=closed, 1=half-open, 2=open) |
| `crawler_circuit_breaker_transitions_total` | Counter | domain, from, to | Circuit state changes |
| `crawler_rate_limit_hits_total` | Counter | tier | API rate limit enforcement |
| `crawler_cleanup_records_total` | Counter | table | Data retention cleanup activity |

### Health Checks

`GET /health` checks PostgreSQL connectivity, Redis connectivity, and returns worker heartbeat status. Used for load balancer integration and Docker health checks.

### Dashboard Updates

The React dashboard polls the API every 5 seconds for real-time charts showing crawl rate, success rate, HTTP status distribution, frontier depth, and active workers.

## Failure Handling

### Circuit Breaker Pattern (Per-Domain)

Each domain gets its own circuit breaker to isolate failures:

- **Closed**: Normal operation; requests pass through
- **Open**: After 5 consecutive failures; immediately reject requests for 60 seconds
- **Half-open**: After cooldown, allow 1 test request; close on success, reopen on failure

Circuit breaker state is stored in Redis (`crawler:circuit:{domain}`) so all workers share failure awareness. When a domain's circuit is open, workers skip URLs from that domain and pick another URL, preventing resource waste on failing domains.

Implementation uses Cockatiel library with retry (exponential backoff: 1s, 2s, 4s) wrapping the circuit breaker. Retries happen within a closed circuit; if the circuit opens, retries stop immediately (fail fast).

### Retry Strategy

| Operation | Max Retries | Backoff | Timeout |
|-----------|-------------|---------|---------|
| HTTP fetch | 3 | Exponential (1s, 2s, 4s) + jitter | 30s |
| robots.txt fetch | 2 | Linear (2s, 4s) | 10s |
| Database write | 3 | Exponential (100ms, 200ms, 400ms) | 5s |
| Redis operation | 3 | Fixed (100ms) | 1s |

Retryable errors: ECONNRESET, ETIMEDOUT, ECONNREFUSED, ENOTFOUND, EAI_AGAIN, EPIPE, EHOSTUNREACH, ENETUNREACH, and HTTP 5xx responses.

### Worker Failure Recovery

Workers send heartbeats every 30 seconds (`crawler:worker:{id}` with 2-minute TTL). A recovery job runs every 5 minutes to find URLs stuck in `in_progress` state for >5 minutes and reset them to `pending`:

```sql
UPDATE url_frontier
SET status = 'pending', scheduled_at = NOW()
WHERE status = 'in_progress'
AND updated_at < NOW() - INTERVAL '5 minutes'
```

### Graceful Degradation

| Failure | Degradation |
|---------|-------------|
| PostgreSQL down | Stop accepting new URLs; continue with in-memory queue if available |
| Redis down | Use PostgreSQL for dedup (slower); skip rate limiting |
| Single worker crash | Other workers continue; stale URLs recovered automatically |
| All workers crash | API server continues serving dashboard; no crawling |
| robots.txt timeout | Skip domain for 1 hour; mark as potentially blocked |

## Scalability Considerations

### Horizontal Scaling Path

1. **Workers**: Fully stateless; add instances to increase crawl rate linearly. Each worker independently claims URLs from the frontier
2. **API Server**: Stateless, behind load balancer. 2-3 replicas with HPA
3. **PostgreSQL**: Partition url_frontier by domain hash for reduced contention. Read replicas for dashboard queries
4. **Redis**: Redis Cluster for sharded dedup SET at billion-scale. Separate instance for locks/rate limiting
5. **Kafka** (production): Decouple URL discovery from ingestion; workers publish discovered URLs to Kafka topic; ingestion service consumes and deduplicates

### What Breaks First

At ~1,000 pages/second, the PostgreSQL frontier dequeue becomes the bottleneck. The `SELECT ... FOR UPDATE SKIP LOCKED` contends on the priority index. Solutions:
1. Partition by domain (workers claim a domain shard, not individual URLs)
2. Use Redis sorted sets as a fast frontier layer, with PostgreSQL as durable backing store
3. Batch dequeue (claim 10-50 URLs at once)

### Data Lifecycle

| Data Type | Retention | Cleanup Mechanism | Rationale |
|-----------|-----------|-------------------|-----------|
| Frontier (pending) | Until crawled | Status change | Must crawl before deletion |
| Frontier (completed) | 7 days | Daily cron job | Keep for debugging |
| Frontier (failed) | 30 days | Daily cron job | Longer for failure analysis |
| Crawled pages metadata | 90 days | Daily cron + archive | Historical data for re-crawl decisions |
| Visited URLs (Redis SET) | 24 hours TTL | Redis TTL | Memory-bound; URLs re-discovered naturally |
| Rate limit keys | 1 minute | Redis TTL | Auto-expire after window |
| Circuit breaker state | 1 hour | Redis TTL | Reset on service restart |
| robots.txt cache | 1 hour | Redis TTL | Re-fetch periodically |
| Session data | 24 hours | Redis TTL | Force re-login daily |
| Worker heartbeats | 2 minutes | Redis TTL | Auto-expire on worker death |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Frontier storage | PostgreSQL | Kafka | Queryable, inspectable, manageable; Kafka for >1K pages/sec |
| URL deduplication | Redis SET (exact) | Bloom Filter | Zero false positives; memory acceptable at learning scale |
| Rate limiting | Redis SET NX EX | Token Bucket | Simpler; domain-level granularity sufficient |
| HTML parsing | Cheerio | Puppeteer | 100x faster, 50x less memory; no JS rendering needed for v1 |
| Priority queue | 3-level (high/med/low) | Redis ZSET with continuous scores | Simpler to understand, debug, and reason about |
| Circuit breaker | Cockatiel (per-domain) | No circuit breaker | Prevents cascade failures; shared state via Redis |
| Coordination | Redis distributed locks | Central scheduler | Simple, auto-expiry; no SPOF |

## Frontend Architecture

### Component Hierarchy

```
App (root layout: Header + Outlet)
├── Dashboard (/)
│   ├── StatCard (x9: pages crawled/failed, links, duplicates, frontier status, domains)
│   ├── WorkerStatus (active workers with heartbeat indicators)
│   ├── TopDomains (grid of top 10 domains by page count)
│   └── RecentPagesTable (table of recently crawled pages)
├── Frontier (/frontier)
│   ├── AddUrlsForm (textarea + priority selector for URL submission)
│   └── FrontierUrlTable (filterable table with status/priority badges)
├── Pages (/pages)
│   └── Paginated table with domain/search filtering
├── Domains (/domains)
│   └── Sortable domain list with robots.txt inspection
└── Admin (/admin)
    ├── Seed URLs panel (textarea for high-priority URL injection)
    ├── Recovery Actions panel (recover stale in-progress URLs)
    ├── Statistics panel (reset counters)
    ├── Danger Zone panel (clear frontier with confirmation)
    └── System Health panel (check database/Redis connectivity)
```

### Routing

TanStack Router with programmatic route definitions in `frontend/src/router.tsx`. Five routes are registered under a root route that wraps the `App` shell (Header with navigation links + `<Outlet />`):

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | Dashboard | Real-time crawl overview with auto-polling |
| `/frontier` | Frontier | URL queue management with status filtering |
| `/pages` | Pages | Browse crawled page metadata |
| `/domains` | Domains | Domain-level stats and robots.txt inspection |
| `/admin` | Admin | Administrative controls and system health |

### Zustand Store

A single store (`useCrawlerStore`) in `frontend/src/stores/crawlerStore.ts` manages all application state. The store is organized into four data domains, each with its own loading/error states:

| Domain | State Fields | Actions | Polling |
|--------|-------------|---------|---------|
| Stats | `stats`, `statsLoading`, `statsError` | `fetchStats()` | 5-second interval via `startPolling()`/`stopPolling()` |
| Frontier | `frontierUrls`, `frontierLoading` | `fetchFrontierUrls(status?)`, `addUrls(urls, priority)` | Manual refresh |
| Pages | `pages`, `pagesTotal`, `pagesLoading` | `fetchPages(limit, offset, domain, search)` | Manual refresh |
| Domains | `domains`, `domainsTotal`, `domainsLoading` | `fetchDomains(limit, offset)` | Manual refresh |

The polling mechanism uses a module-level `setInterval` reference stored outside the store to persist across React renders. The Dashboard component calls `startPolling()` on mount and `stopPolling()` on unmount.

### Data Fetching

All API communication is centralized in `frontend/src/services/api.ts`, which provides a typed `api` object wrapping a generic `fetchApi<T>()` helper. The helper automatically sets `Content-Type: application/json`, parses responses, and throws errors for non-2xx status codes. The frontend uses the Vite dev server proxy to forward `/api` requests to the backend on port 3001.

### Key UI Patterns

- **Live indicator**: A pulsing green dot in the Dashboard header signals active polling
- **Loading skeletons**: The Dashboard renders animated gray placeholder blocks while data loads
- **Status badges**: Color-coded pill badges for URL status (pending=yellow, in_progress=blue, completed=green, failed=red) and priority levels (high=red, medium=yellow, low=gray)
- **Confirmation dialogs**: Destructive operations (clear frontier) require `window.confirm()` before execution
- **Action feedback**: The Admin panel displays success/error banners after each operation with the full API response
- **Responsive grid**: Tailwind CSS grid layouts adapt from single-column on mobile to multi-column on desktop (e.g., stat cards use `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`)

## Deep Pattern Explanations

This section explains the production-grade patterns used in this project for readers unfamiliar with them.

### RBAC (Role-Based Access Control)

RBAC is a method of restricting system access based on the roles assigned to individual users, rather than assigning permissions directly to each user. Instead of saying "user Alice can seed URLs and clear the frontier," you assign Alice the "admin" role, and the admin role carries those permissions. This matters because managing permissions for thousands of users individually is error-prone -- when a new feature launches, you update the role definition once rather than every user record.

In this project, three roles exist: anonymous (read public stats), user (view all dashboard data), and admin (destructive operations like seeding URLs and clearing the frontier). The middleware checks the user's session in Redis, extracts their role, and compares it against the required role for each endpoint. If the role does not match, the request is rejected with 403 Forbidden before reaching the route handler.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. If the data is in the cache (a "hit"), it is returned immediately. If not (a "miss"), the application queries the database, stores the result in the cache with a TTL (time-to-live), and returns it. The cache is never populated proactively -- it fills up as data is requested.

In this project, robots.txt content is cached in Redis with a 1-hour TTL. When a worker needs to check robots.txt for a domain, it first checks `crawler:domain:{domain}:robots` in Redis. On a miss, it fetches from the web, stores the result in both Redis (for fast access) and PostgreSQL (for persistence), and returns it. The 1-hour TTL means stale robots.txt rules may be enforced briefly, but this is acceptable since robots.txt changes rarely.

### Circuit Breaker

A circuit breaker is a pattern borrowed from electrical engineering: when a component detects repeated failures, it "trips" and stops sending requests to the failing service, preventing wasted resources and cascading failures. The circuit has three states: Closed (normal operation, requests pass through), Open (failures exceeded threshold, requests are immediately rejected without attempting the call), and Half-Open (after a cooldown period, a single test request is allowed through to see if the service has recovered).

In this project, each domain gets its own circuit breaker (implemented via Cockatiel). If a domain returns 5 consecutive failures (HTTP 5xx, connection timeouts, DNS errors), the circuit opens for 60 seconds. During that time, workers skip URLs from that domain and pick another URL instead of wasting time on a domain that is likely down. After 60 seconds, one test request is allowed through -- if it succeeds, the circuit closes and normal crawling resumes. Circuit breaker state is stored in Redis (`crawler:circuit:{domain}`) so all workers share failure awareness across the distributed fleet.

### Structured Logging

Structured logging means emitting log entries as machine-parseable JSON objects rather than free-form text strings. Instead of `"Worker 3 crawled https://example.com in 450ms"`, a structured log entry looks like `{"level":"info","component":"crawler","workerId":"w-3","url":"https://example.com","durationMs":450,"event":"page_crawled"}`. This makes logs searchable, filterable, and aggregatable by any field -- you can query "show me all logs from worker 3 where durationMs > 1000" without regex.

This project uses Pino, a high-performance Node.js JSON logger. Component-specific child loggers (http, crawler, database, redis, circuit-breaker) add contextual fields to every log entry automatically. In development, `pino-pretty` reformats the JSON into human-readable colored output. In production, the raw JSON is ingested by log aggregation systems like Elasticsearch or Datadog.

### Prometheus Metrics

Prometheus is a monitoring system that collects numerical time-series data by scraping an HTTP endpoint at regular intervals. The application exposes metrics at `GET /metrics` in a specific text format. Prometheus periodically fetches this endpoint and stores the data, enabling dashboards (Grafana) and alerting rules.

There are four metric types: Counter (monotonically increasing value, like `crawler_pages_crawled_total`), Gauge (value that can go up and down, like `crawler_frontier_size`), Histogram (distribution of values in configurable buckets, like `crawler_crawl_duration_seconds`), and Summary (similar to histogram but calculates quantiles client-side). This project uses the `prom-client` library and exposes 15+ metrics covering crawl throughput, latency, errors, frontier depth, circuit breaker state, and data retention cleanup activity.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. Without rate limiting, a single client (or bot) could consume all server resources, degrading service for everyone else. The core idea is to track request counts per client identifier (IP address, API key, or user ID) and reject requests that exceed the configured threshold with HTTP 429 (Too Many Requests).

This project implements tiered rate limiting with Redis sliding window counters: anonymous users get 10 requests per minute, authenticated users get 100, and admins get 500. The sliding window approach uses `ZREMRANGEBYSCORE` to remove old entries, `ZADD` to add the current request timestamp, and `ZCARD` to count requests in the window. This avoids the "boundary burst" problem of fixed windows where a client could send double the limit by timing requests at the window boundary.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. This is critical in distributed systems where network failures cause retries -- if a URL insertion request is retried after a timeout, you do not want the URL added twice.

In this project, idempotency is enforced at two levels: (1) The `url_hash UNIQUE` constraint on `url_frontier` ensures that `INSERT ... ON CONFLICT (url_hash) DO NOTHING` silently ignores duplicate URL insertions. (2) The `url_hash UNIQUE` constraint on `crawled_pages` with `ON CONFLICT DO UPDATE` ensures re-crawls update the existing record rather than creating duplicates. The URL hash is a SHA-256 digest of the normalized URL, so different representations of the same URL (with/without trailing slash, different query parameter order) map to the same hash.

### Health Checks

Health checks are HTTP endpoints that report whether a service is functioning correctly. Load balancers, container orchestrators (Docker, Kubernetes), and monitoring systems call these endpoints to determine if a service instance should receive traffic.

This project exposes `GET /health` which checks PostgreSQL connectivity (runs a simple `SELECT 1` query) and Redis connectivity (runs a `PING` command). If both succeed, it returns `{"status":"healthy"}` with HTTP 200. If either fails, it returns `{"status":"unhealthy","details":{...}}` with HTTP 503. Docker uses this endpoint for container health checks -- if a container fails health checks, Docker restarts it. In production, a load balancer would stop routing traffic to unhealthy instances while they recover.

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + React.

### Local Setup Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    localhost (or Docker Compose)                   │
│                                                                   │
│  ┌──────────────┐    HTTP     ┌──────────────────────────────┐   │
│  │   Frontend   │ ──────────▶ │      API Server (Express)    │   │
│  │  React + Vite│             │        Port 3001             │   │
│  │  Port 5173   │             │                              │   │
│  │              │             │  - /api/stats                │   │
│  │  - Dashboard │             │  - /api/frontier/*           │   │
│  │  - Frontier  │             │  - /api/pages                │   │
│  │  - Pages     │             │  - /api/domains              │   │
│  │  - Domains   │             │  - /health                   │   │
│  │  - Admin     │             │  - /metrics                  │   │
│  └──────────────┘             └──────────┬───────────────────┘   │
│                                          │                        │
│  ┌───────────────────────────────────────┤                        │
│  │                                       │                        │
│  │  ┌────────────┐ ┌────────────┐ ┌──────┴─────┐                 │
│  │  │  Worker 1  │ │  Worker 2  │ │  Worker 3  │                 │
│  │  │  (tsx)     │ │  (tsx)     │ │  (tsx)     │                 │
│  │  │            │ │            │ │            │                 │
│  │  │ Fetch ──▶  │ │ Fetch ──▶  │ │ Fetch ──▶  │                 │
│  │  │ Parse ──▶  │ │ Parse ──▶  │ │ Parse ──▶  │                 │
│  │  │ Extract    │ │ Extract    │ │ Extract    │                 │
│  │  │ Ingest     │ │ Ingest     │ │ Ingest     │                 │
│  │  └──────┬─────┘ └──────┬─────┘ └──────┬─────┘                 │
│  │         └───────────────┼───────────────┘                      │
│  │                         │                                      │
│  │           ┌─────────────┴─────────────┐                        │
│  │           │                           │                        │
│  │    ┌──────▼──────┐            ┌───────▼──────┐                 │
│  │    │  PostgreSQL │            │    Valkey    │                 │
│  │    │  Port 5432  │            │  Port 6379   │                 │
│  │    │             │            │              │                 │
│  │    │  webcrawler │            │ - Visited    │                 │
│  │    │  DB:        │            │   URLs SET   │                 │
│  │    │  - url_     │            │ - Domain     │                 │
│  │    │    frontier  │            │   locks      │                 │
│  │    │  - crawled_  │            │ - Robots     │                 │
│  │    │    pages     │            │   cache      │                 │
│  │    │  - domains   │            │ - Circuit    │                 │
│  │    │              │            │   breakers   │                 │
│  │    └──────────────┘            │ - Sessions   │                 │
│  │                                └──────────────┘                 │
│  │                                                                │
│  │  Docker Compose: webcrawler-postgres, webcrawler-redis,        │
│  │    webcrawler-api, webcrawler-worker-{1,2,3}, webcrawler-frontend│
│  └────────────────────────────────────────────────────────────────┘
└──────────────────────────────────────────────────────────────────┘
```

### Production-Grade Patterns Implemented

| Pattern | Library | File Path | Why It Matters |
|---------|---------|-----------|----------------|
| Circuit breaker (per-domain) | Cockatiel | `backend/src/shared/resilience.ts` | Per-domain isolation prevents one failing site from affecting crawling of others; shared state via Redis for cross-worker awareness |
| Retry with exponential backoff | Cockatiel | `backend/src/shared/resilience.ts` | Handles transient failures (ECONNRESET, 5xx) with jitter to prevent thundering herd |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | 15+ metrics: crawl throughput, latency, errors, frontier depth, circuit breaker state, cleanup activity |
| Structured logging | Pino | `backend/src/shared/logger.ts` | JSON logs with component loggers (http, crawler, database, redis, circuit-breaker); worker ID context |
| URL frontier | PostgreSQL + Redis | `backend/src/services/frontier.ts` | Priority-based scheduling with politeness; `FOR UPDATE SKIP LOCKED` for concurrent access |
| robots.txt compliance | robots-parser | `backend/src/services/robots.ts` | Fetches, parses, and caches robots.txt; respects crawl-delay and disallow directives |
| URL deduplication | Redis SET | `backend/src/services/crawler.ts` | O(1) membership check via SISMEMBER on SHA-256 hashes |
| Per-domain rate limiting | Redis SET NX EX | `backend/src/services/crawler.ts` | Distributed lock with TTL matching domain crawl-delay |
| Data cleanup | Custom cron jobs | `backend/src/services/cleanup.ts` | Removes completed frontier entries (7d), failed entries (30d), old page metadata (90d) |
| Health checks | Custom | `backend/src/routes/` | `/health` checks PostgreSQL and Redis; Docker healthcheck integration |
| Session auth + RBAC | express-session + Redis | `backend/src/middleware/` | Session-based auth with role-based access control for admin operations |
| API rate limiting | express-rate-limit | `backend/src/middleware/` | Tiered rate limits for anonymous/user/admin |
| Request security | Helmet + compression | `backend/src/server.ts` | Security headers and response compression |

### Simplifications from Production Design

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| 80-150 workers | 3 workers (Docker) or `dev:worker1`/`dev:worker2`/`dev:worker3` | Lower crawl rate; sufficient for learning |
| Kafka for URL ingestion | Direct PostgreSQL INSERT from workers | No event replay; simpler but tighter coupling |
| Redis Cluster for dedup at billion-scale | Single Valkey instance | Memory-limited; fine for 100K URLs |
| Kubernetes HPA for workers | docker-compose restart: unless-stopped | No auto-scaling |
| S3/MinIO for content storage | Metadata-only (no raw HTML stored) | Cannot re-process pages without re-crawling |
| Multiple API server replicas | Single API server | No load balancing; single point of failure |
| Partitioned frontier (by domain) | Single table with index | Contention at high concurrency |
| Bloom filter for memory-efficient dedup | Exact dedup via Redis SET | Higher memory usage per URL |

### What Was Omitted

- JavaScript rendering for SPA content (Puppeteer integration)
- Full-text search indexing (Elasticsearch)
- PageRank or link-based authority scoring
- Content storage in object storage (S3/MinIO)
- Near-duplicate content detection (SimHash)
- CDN for dashboard static assets
- Multi-region deployment
- Kubernetes orchestration and auto-scaling
- Grafana dashboards (metrics exposed at `/metrics` but no visualization)
- Distributed tracing (OpenTelemetry)
- Webhook notifications for crawl completion
- Sitemap.xml parsing for URL discovery
