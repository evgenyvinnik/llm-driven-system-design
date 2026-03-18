# Design Google Search - Architecture

## System Overview

Google Search is a web search engine with distributed crawling and ranking. Core challenges involve scale, freshness, relevance, and low-latency serving.

**Learning Goals:**
- Build web crawling infrastructure
- Design inverted index systems
- Implement PageRank algorithm
- Handle query processing at scale

---

## Requirements

### Functional Requirements

1. **Crawl**: Discover and fetch web pages respecting robots.txt
2. **Index**: Build searchable inverted index of content
3. **Query**: Process user search queries with phrases, exclusions, and site filters
4. **Rank**: Order results by relevance using text scoring, PageRank, and freshness
5. **Serve**: Return results with snippets and highlighting at low latency

### Non-Functional Requirements

- **Scale**: Index 100B+ pages
- **Latency**: < 200ms p95 for queries
- **Freshness**: Update popular pages daily, news pages hourly
- **Relevance**: High precision and recall, zero-result rate < 5%
- **Availability**: 99.99% uptime for query serving
- **Throughput**: 100K+ queries per second globally

---

## Capacity Estimation

### Production Scale

| Metric | Target |
|--------|--------|
| Indexed pages | 100B+ |
| Daily queries | 8.5B (100K QPS) |
| Daily crawl volume | 50M pages |
| Index size | 100+ PB (distributed) |
| Average query latency | < 200ms |

### Storage Breakdown (Production)

| Data Type | Size | Storage System |
|-----------|------|----------------|
| Raw page content | 100+ PB | Distributed file system (GFS/Colossus) |
| Inverted index | 50+ PB | Custom sharded index servers |
| URL metadata + crawl state | 10+ TB | Bigtable / distributed KV store |
| PageRank scores | 1+ TB | Pre-computed, loaded into memory |
| Query cache | 1+ TB | Distributed Redis/Memcached |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Crawl System                                  │
│                                                                       │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌──────────┐ │
│  │ URL Frontier │──▶│   Fetcher   │──▶│   Parser    │──▶│  Dedup   │ │
│  │ (Priority Q) │   │ (Politeness)│   │ (Cheerio)   │   │(Hash Cmp)│ │
│  └─────────────┘   └─────────────┘   └─────────────┘   └──────────┘ │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ Parsed documents + discovered URLs
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Indexing Pipeline                                │
│                                                                       │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────┐   ┌────────────┐ │
│  │  Tokenizer  │──▶│ Index Builder │──▶│ PageRank │──▶│  Sharding  │ │
│  │ (Stem/Stop) │   │  (TF-IDF)    │   │ (Batch)  │   │ (By Term)  │ │
│  └─────────────┘   └──────────────┘   └──────────┘   └────────────┘ │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ Indexed shards
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Serving System                                  │
│                                                                       │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────┐   ┌────────────┐ │
│  │Query Parser  │──▶│ Index Servers │──▶│ Ranking  │──▶│  Snippet   │ │
│  │(Spell/Expand)│   │ (BM25 Score) │   │(Multi-Sig)│  │ Generation │ │
│  └─────────────┘   └──────────────┘   └──────────┘   └────────────┘ │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Data Layer                                    │
├──────────────────┬────────────────────┬──────────────────────────────┤
│   PostgreSQL     │   Elasticsearch    │      Redis/Valkey            │
│   - URL state    │   - Inverted index │      - Query cache           │
│   - Link graph   │   - BM25 scoring   │      - Suggestions           │
│   - PageRank     │   - Highlighting   │      - Rate limiting         │
│   - Query logs   │                    │      - Idempotency keys      │
└──────────────────┴────────────────────┴──────────────────────────────┘
```

---

## Core Components

### 1. Web Crawler

The crawler manages a URL frontier with priority-based scheduling and per-host politeness. Each URL is assigned a priority based on domain importance, inlink count, and freshness needs. The frontier maintains per-host queues to enforce a minimum 1-second delay between requests to the same host (politeness policy). Before fetching, the crawler checks a cached robots.txt for the target domain.

After fetching, the crawler extracts content using an HTML parser, computes a content hash for deduplication, extracts outgoing links, and stores the parsed document for indexing. Discovered links are added back to the frontier with calculated priorities.

### 2. Inverted Index

The indexing pipeline tokenizes document content (lowercasing, stopword removal, Porter stemming), then builds postings lists mapping each term to the documents containing it, along with positions and term frequency. Field-specific boosts are applied: terms appearing in the title get a 3x boost, terms in anchor text get 2x.

TF-IDF scoring is computed at index time: `tf = 1 + log(termFreq)`, `idf = log(N / docFreq)`. At query time, Elasticsearch applies BM25 scoring with parameters k1=1.2 and b=0.75.

At production scale, the index is sharded by term hash so that all postings for a given term live on one shard. This makes query routing simple -- the query coordinator sends each query term to the appropriate shard and merges results. The alternative (sharding by document) would require querying every shard for every query.

### 3. PageRank

PageRank is computed offline in batch using the iterative power method with damping factor d=0.85. The algorithm loads the link graph from PostgreSQL, initializes all pages with uniform rank 1/N, and iterates the formula:

`PR(page) = (1 - d) / N + d * sum(PR(inlink) / outDegree(inlink))`

Convergence is checked by max absolute difference between iterations, terminating when delta < 0.0001 or after 100 iterations. Scores are written back to the URL table and used as a ranking signal.

Computing PageRank incrementally (on every new crawl) would provide fresher scores but is computationally expensive and complex to implement correctly. Weekly batch recomputation is sufficient since the web's link structure changes slowly relative to content.

### 4. Query Processing

The query parser handles:
- Basic terms: `javascript tutorial`
- Exact phrases: `"react hooks"` (position-based matching)
- Exclusions: `python -django` (filter from results)
- Site filters: `site:example.com tutorial` (domain constraint)

Spell correction uses edit distance against a dictionary of known terms, preferring corrections with higher document frequency. Query expansion adds synonyms to broaden recall.

### 5. Ranking System

Results are ranked by combining four signals with learned weights:

| Signal | Weight | Source |
|--------|--------|--------|
| Text relevance (BM25) | 0.35 | Elasticsearch scoring |
| PageRank | 0.25 | Pre-computed batch scores |
| Freshness | 0.15 | Decay function on last-modified date |
| Click-through rate | 0.25 | Historical query-document click data |

Two-phase ranking is used at scale: a cheap first pass retrieves the top 1000 candidates using BM25 alone, then an expensive re-ranking pass applies all signals to the top candidates. This prevents computing expensive signals (PageRank lookup, freshness calculation) for millions of candidate documents.

---

## Database Schema

```sql
-- URLs table (crawl state)
CREATE TABLE urls (
    id BIGSERIAL PRIMARY KEY,
    url_hash BIGINT UNIQUE NOT NULL,
    url TEXT NOT NULL,
    domain VARCHAR(255) NOT NULL,
    last_crawl TIMESTAMP,
    last_modified TIMESTAMP,
    crawl_status VARCHAR(20) DEFAULT 'pending',
    content_hash BIGINT,
    page_rank DECIMAL DEFAULT 0.0,
    inlink_count INTEGER DEFAULT 0,
    priority DECIMAL DEFAULT 0.5,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Documents
CREATE TABLE documents (
    id BIGSERIAL PRIMARY KEY,
    url_id BIGINT REFERENCES urls(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT,
    description TEXT,
    content TEXT,
    content_length INTEGER,
    language VARCHAR(10) DEFAULT 'en',
    fetch_time TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Link Graph (for PageRank)
CREATE TABLE links (
    id BIGSERIAL PRIMARY KEY,
    source_url_id BIGINT REFERENCES urls(id) ON DELETE CASCADE,
    target_url_id BIGINT REFERENCES urls(id) ON DELETE CASCADE,
    anchor_text TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(source_url_id, target_url_id)
);

-- Query Logs (for analytics and ranking improvement)
CREATE TABLE query_logs (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL,
    results_count INTEGER DEFAULT 0,
    results_clicked JSONB DEFAULT '[]',
    duration_ms INTEGER,
    session_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Search Suggestions (popular queries for autocomplete)
CREATE TABLE search_suggestions (
    id BIGSERIAL PRIMARY KEY,
    query TEXT NOT NULL UNIQUE,
    frequency INTEGER DEFAULT 1,
    last_used TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Robots.txt cache
CREATE TABLE robots_cache (
    id BIGSERIAL PRIMARY KEY,
    domain VARCHAR(255) UNIQUE NOT NULL,
    content TEXT,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Key Indexes

```sql
CREATE INDEX idx_urls_domain ON urls(domain);
CREATE INDEX idx_urls_crawl_status ON urls(crawl_status);
CREATE INDEX idx_urls_priority ON urls(priority DESC);
CREATE INDEX idx_urls_page_rank ON urls(page_rank DESC);
CREATE INDEX idx_documents_url_id ON documents(url_id);
CREATE INDEX idx_links_source ON links(source_url_id);
CREATE INDEX idx_links_target ON links(target_url_id);
CREATE INDEX idx_query_logs_query ON query_logs(query);
CREATE INDEX idx_search_suggestions_frequency ON search_suggestions(frequency DESC);
```

---

## API Design

```
Search:
GET  /search?q=query&page=1&size=10     - Execute search query
GET  /suggest?q=partial                  - Autocomplete suggestions

Admin:
GET  /admin/stats                        - Crawl/index/query statistics
POST /admin/crawl                        - Trigger crawl job
POST /admin/index/rebuild                - Rebuild Elasticsearch index
POST /admin/pagerank/calculate           - Trigger PageRank recalculation

Health/Observability:
GET  /health                             - Full dependency health check
GET  /healthz                            - Kubernetes liveness probe
GET  /ready                              - Kubernetes readiness probe
GET  /metrics                            - Prometheus metrics endpoint
```

---

## Key Design Decisions

### 1. Inverted Index Sharding: By Term, Not Document

Sharding by term hash means all postings for "javascript" live on one shard. A query for "javascript tutorial" requires hitting exactly 2 shards (one per term), then intersecting results. Sharding by document would require querying every shard for every query and merging results -- at 10,000 shards, this creates 10,000 fan-out requests per query, making sub-200ms latency impossible.

The trade-off: term-based sharding creates hot spots for common terms ("the", "is"). This is mitigated by stopword removal during indexing and by replicating high-frequency term shards.

### 2. Two-Phase Ranking

Computing all four ranking signals (BM25, PageRank, freshness, click-through) for every matching document would require O(millions) lookups per query. Two-phase ranking retrieves the top 1000 candidates with cheap BM25 scoring, then re-ranks only those with expensive signals. This reduces computation by 1000x while maintaining result quality -- the top 10 results almost always come from the BM25 top-1000.

The trade-off: a document with low BM25 but very high PageRank might be missed. For navigational queries ("facebook login"), this matters. We handle these with a separate navigational index that maps domain names directly to URLs, bypassing the ranking pipeline entirely.

### 3. PageRank as Batch Pre-computation

Computing PageRank iteratively over the entire link graph takes hours even on distributed infrastructure. Running this at query time is impossible. Batch computation (weekly) is acceptable because the web's link structure changes slowly -- a page that was important last week is almost certainly still important this week.

The trade-off: newly published pages start with zero PageRank regardless of their quality. We compensate with a freshness boost for recently crawled pages and by weighting other signals (BM25, click-through) more heavily for new content.

---

## Consistency and Idempotency

### Consistency Model

| Component | Consistency Level | Rationale |
|-----------|-------------------|-----------|
| URL Frontier | Eventual | Duplicate URLs acceptable; deduped during crawl |
| Crawl State (PostgreSQL) | Strong (per-URL) | Row-level locks prevent concurrent crawls of same URL |
| Document Store | Eventual | Newer crawls overwrite older; content hash prevents duplicates |
| Inverted Index (ES) | Eventual | Near real-time indexing with refresh interval |
| PageRank | Batch consistent | Computed atomically; swapped in during index rebuild |
| Query Cache (Redis) | Eventual | Stale reads acceptable; TTL-based invalidation |

### Idempotency Patterns

**URL Crawling**: Each crawl job carries an idempotency key (`crawl:{urlHash}:{scheduledAt}`). Before crawling, the crawler acquires a Redis lock with `SET NX EX 3600`. If the lock exists, the job is skipped. This prevents duplicate crawls when multiple crawler instances pick up the same URL.

**Document Indexing**: Elasticsearch uses deterministic document IDs derived from URL hashes. Re-indexing the same URL produces an upsert, not a duplicate. This makes index rebuilds safe to retry.

**PageRank Updates**: New scores are written to a staging table, then atomically swapped into the active table within a transaction. This prevents partial updates where some URLs have new scores and others have old ones.

---

## Observability

### Metrics (Prometheus)

| Metric | Type | Purpose |
|--------|------|---------|
| `crawl_urls_fetched_total{status_code}` | Counter | Crawl throughput and error rate |
| `crawl_latency_seconds` | Histogram | Per-URL fetch + parse time |
| `crawl_frontier_size` | Gauge | Backlog monitoring |
| `index_documents_total` | Counter | Indexing throughput |
| `search_query_latency_seconds{cache_hit}` | Histogram | Query latency SLI |
| `search_queries_total{status}` | Counter | Query volume |
| `search_cache_hit_ratio` | Gauge | Cache effectiveness |
| `search_query_results_count` | Histogram | Zero-result detection |
| `circuit_breaker_state{service}` | Gauge | Dependency health |

### SLIs and Alerts

| SLI | Target | Alert |
|-----|--------|-------|
| Query latency p95 | < 200ms | > 500ms for 2 min |
| Query error rate | < 1% | > 5% for 2 min |
| Cache hit ratio | > 60% | < 30% for 5 min |
| Crawl error rate | < 10% | > 10% for 5 min |
| ES cluster health | green/yellow | red for 1 min |
| Frontier backlog | < 100K | > 100K for 10 min |

### Structured Logging

JSON-formatted logs with trace IDs, service name, and event-specific metadata. Key events logged: `crawl_complete` (URL, status, links extracted), `query_executed` (query text, result count, latency, cache hit), `index_rebuild` (document count, duration).

---

## Failure Handling

### Circuit Breakers

Separate circuit breakers protect each dependency:

| Service | Failure Threshold | Reset Timeout | Fallback |
|---------|-------------------|---------------|----------|
| Elasticsearch | 3 failures | 10 seconds | Return empty results with `fallback: true` |
| PostgreSQL | 5 failures | 30 seconds | Skip crawl state updates, queue for retry |
| Redis | 3 failures | 5 seconds | Bypass cache, query ES directly |

### Retry Strategy

Exponential backoff with jitter for transient failures. Max 3 retries with base delay 1 second, capped at 30 seconds. Non-retryable errors (4xx status codes, validation failures) fail immediately. Each retry checks Redis for cached results (idempotency) to avoid duplicate work.

### Graceful Degradation

| Failure | Behavior |
|---------|----------|
| ES cluster down | Circuit breaker opens, queries return "temporarily unavailable" |
| Redis down | Bypass cache, all queries hit ES directly (higher latency) |
| PostgreSQL down | Crawling pauses, serving continues from cached index |
| Single crawler down | Other crawlers continue; frontier rebalances |

---

## Scalability Considerations

### What Breaks First

1. **Elasticsearch** at ~10K QPS per node. Scale horizontally with index replication (each shard has 2 replicas). Query coordinators distribute load across replicas.
2. **Crawl throughput** limited by politeness constraints, not infrastructure. Scale by adding crawler instances with distinct host assignments. A 1000-crawler fleet can fetch ~50M pages/day.
3. **PostgreSQL** link graph table grows to billions of rows. Shard by source_url_hash. Consider graph database (Neo4j) for PageRank if iteration becomes too slow.
4. **Redis query cache** at ~1M cached queries. Redis Cluster with hash slots distributes memory. Eviction policy: allkeys-lfu.

### Index Freshness vs. Cost

Real-time indexing for every page change is prohibitively expensive at 100B pages. Instead, use adaptive recrawl scheduling: news sites every hour, popular sites daily, long-tail sites monthly. Change detection via HTTP conditional GETs (If-Modified-Since) reduces unnecessary fetches by ~60%.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Index sharding | By term | By document | Query efficiency, simple routing |
| Ranking | Multi-phase (2-pass) | Single phase | Latency: avoid expensive signals on all candidates |
| Freshness | Crawl priority scheduling | Real-time indexing | Cost-effective at scale |
| PageRank | Weekly batch | Incremental | Simpler, link structure changes slowly |
| Consistency | Eventual (reads) | Strong | Performance; stale results acceptable |
| Idempotency | Redis locks + content hash | DB transactions | Speed for crawl dedup |
| Circuit breakers | Per-service (ES/PG/Redis) | Global | Granular failure isolation |
| Full-text search | Elasticsearch | Custom inverted index | Production-grade BM25 with minimal overhead |

---

## Implementation Notes

This section documents the actual local implementation: what was built, what was simplified, and what was omitted.

### Local Setup Diagram

```
┌───────────────────┐
│  React Frontend   │
│  (Vite :5173)     │
│  SearchBox, Admin │
└────────┬──────────┘
         │ HTTP
         ▼
┌───────────────────┐
│  Express Backend  │
│  (Port 3000)      │
│  Search + Admin   │
└──┬──────┬──────┬──┘
   │      │      │
   ▼      ▼      ▼
┌──────┐ ┌────┐ ┌──────────────┐
│ PG   │ │ VK │ │ Elasticsearch│
│:5432 │ │:6379│ │   :9200      │
└──────┘ └────┘ └──────────────┘
```

Multiple API instances can be run on ports 3001-3003 via `PORT=300x npm run dev`.

Backend scripts for offline processing:
- `npm run crawl` -- Run crawler against seed URLs
- `npm run build-index` -- Index crawled documents into Elasticsearch
- `npm run calculate-pagerank` -- Compute PageRank from link graph

### Frontend Architecture

The frontend is a React 19 + TypeScript application built with Vite, using TanStack Router for file-based routing and Zustand for state management. It replicates Google's two-page search experience: a landing page with a centered search box, and a results page with a header-mounted search box and paginated results.

**Component Hierarchy:**

```
__root.tsx (bare Outlet, no global layout)
├── index.tsx (HomePage)
│   └── SearchBox (large, centered, with autocomplete)
├── search.tsx (SearchPage)
│   ├── SearchBox (small, header-mounted)
│   └── SearchResults
│       └── SearchResultItem (per-result: title, URL breadcrumb, snippet, metadata)
└── admin.tsx (AdminPage)
    ├── StatCard (URLs, documents, links, queries)
    └── ActionButton (crawl, index, PageRank triggers)
```

**Zustand Store -- `useSearchStore`:**

A single store manages the entire search lifecycle. It holds the current query string, search results (or null), loading and error states, and a list of recent searches persisted to `localStorage`. The `search` action calls the API, updates results, and appends the query to recent searches. This store is consumed by both the home page (to access `recentSearches`) and the search results page (to execute queries and display results).

**Data Fetching Pattern:**

The frontend uses direct `fetch` calls organized in a `services/api.ts` module, split into `searchApi` (search, autocomplete, popular searches, related searches) and `adminApi` (stats, seed URLs, crawl, index build, PageRank). There is no global data-fetching library (no React Query or SWR). The search page reads query parameters (`q` and `page`) from the URL via TanStack Router's `validateSearch`, then triggers a search via `useEffect` when parameters change. This means search state is URL-driven: sharing a URL reproduces the exact same search results.

**Autocomplete with Debounce (`useAutocomplete` hook):**

A custom hook manages the autocomplete lifecycle. It debounces user keystrokes (200ms), sends a request to `/search/autocomplete`, and maintains a list of suggestions with keyboard navigation (ArrowUp/ArrowDown/Escape). The `SearchBox` component combines these suggestions with recent searches in a dropdown, showing recent searches when the suggestions list is empty and the input is focused. The dropdown closes on outside click via a `mousedown` event listener on `document`.

**Search Result Rendering:**

Each `SearchResultItem` displays a domain favicon placeholder, a URL breadcrumb (protocol stripped), a clickable title rendered with `dangerouslySetInnerHTML` to support Elasticsearch highlight markup (`<em>` tags), a snippet (also with `innerHTML` for highlights), and metadata (PageRank score, index date, external link). This mirrors Google's SERP layout.

**Admin Dashboard:**

The admin page uses local React state (no Zustand) because its state is ephemeral and page-scoped. It fetches stats on mount, displays them in a grid of `StatCard` components, shows top pages by PageRank in a table, and provides action buttons to trigger crawl, index, and PageRank operations. A status banner shows action results and auto-refreshes stats after 2 seconds.

**Routing:**

TanStack Router with file-based routing. Three routes: `/` (home), `/search` (results with `q` and `page` search params), and `/admin` (dashboard). The root route is a bare `Outlet` with no global layout, since the home page and search page have completely different layouts (centered vs. left-aligned with header).

### Production Patterns Actually Implemented

| Pattern | File Path | Description |
|---------|-----------|-------------|
| Prometheus metrics | `backend/src/shared/metrics.ts` | Query latency histogram, cache hit ratio, crawl counters, result count distribution |
| Circuit breakers | `backend/src/shared/circuitBreaker.ts` | Opossum-based breakers for ES, PostgreSQL, Redis with Prometheus state gauge |
| Rate limiting | `backend/src/shared/rateLimiter.ts` | Redis-backed per-endpoint rate limiting (search: 60/min, admin: 10/min) |
| Idempotency | `backend/src/shared/idempotency.ts` | Redis SET NX for crawl dedup; deterministic ES document IDs for index idempotency |
| Structured logging | `backend/src/shared/logger.ts` | Pino JSON logger with request correlation and trace IDs |
| Health checks | `backend/src/shared/health.ts` | `/health` with dependency checks (PG, Redis, ES), `/healthz` liveness, `/ready` readiness |
| Crawler | `backend/src/services/crawler.ts` | URL frontier, robots.txt compliance, politeness, content extraction with Cheerio |
| PageRank | `backend/src/services/pagerank.ts` | Iterative computation with convergence detection, damping factor 0.85 |
| Indexer | `backend/src/services/indexer.ts` | Tokenization, stemming (natural library), Elasticsearch bulk indexing |
| Search service | `backend/src/services/search.ts` | Query parsing (phrases, exclusions, site filter), BM25 via ES, snippet generation |
| Tokenizer | `backend/src/utils/tokenizer.ts` | Stopword removal, Porter stemming via `natural` library |

### Production Pattern Deep Dives

This section explains each production-grade pattern implemented in the backend as if the reader has never encountered it before. Understanding *why* each pattern exists is as important as understanding *how* it works.

**Circuit Breaker (`backend/src/shared/circuitBreaker.ts`):**

A circuit breaker is a stability pattern borrowed from electrical engineering. In an electrical system, a circuit breaker detects excessive current and cuts the circuit to prevent a fire. In software, it detects repeated failures when calling an external service (like Elasticsearch or PostgreSQL) and stops making calls to that service for a cooldown period.

Without a circuit breaker, if Elasticsearch goes down, every search request would wait for a connection timeout (typically 30 seconds), tying up server threads and creating a cascading failure where the API server itself becomes unresponsive. The circuit breaker has three states: **Closed** (normal operation -- requests pass through), **Open** (failures exceeded threshold -- requests fail immediately without attempting the call), and **Half-Open** (after a cooldown period, one test request is allowed through to check if the service has recovered). This implementation uses the Opossum library and configures separate breakers for Elasticsearch, PostgreSQL, and Redis. Each breaker opens after 3-5 failures and resets after 5-30 seconds. When a breaker is open, the fallback behavior differs per service: search returns empty results, crawl state updates are queued for retry, and cache misses fall through to the database. A Prometheus gauge tracks each breaker's state, enabling alerting on prolonged outages.

**Redis Cache-Aside (`backend/src/shared/` -- integrated in search service):**

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. If the data is in the cache (a "hit"), it is returned immediately. If not (a "miss"), the application queries the primary data source, stores the result in the cache with a time-to-live (TTL), and returns it.

In this project, search query results are cached in Redis with the query string as the key. When a user searches for "javascript tutorial," the search service first checks Redis. If cached results exist and have not expired, they are returned in sub-millisecond time. If not, the query goes to Elasticsearch, results are formatted, stored in Redis with a TTL, and then returned. The TTL ensures stale results are eventually replaced. This pattern is distinct from "write-through" caching (where every write updates the cache) and "write-behind" (where writes go to the cache first and are asynchronously persisted). Cache-aside is appropriate here because search results are read-heavy, tolerance for staleness is high (a few minutes), and there is no need to invalidate individual cache entries when documents are re-indexed.

**Structured Logging (`backend/src/shared/logger.ts`):**

Structured logging means emitting log entries as machine-parsable JSON objects instead of free-form text strings. A traditional log line like `"2024-01-15 Search query 'react hooks' returned 42 results in 15ms"` is human-readable but difficult to filter, aggregate, or alert on programmatically. A structured log emits the same information as `{"timestamp":"2024-01-15T...","level":"info","event":"query_executed","query":"react hooks","resultCount":42,"durationMs":15,"cacheHit":false,"traceId":"abc123"}`.

This implementation uses the Pino library, which produces JSON logs with nanosecond timestamps and minimal serialization overhead. Each log entry includes a trace ID (propagated via the `x-trace-id` HTTP header) that links all log entries for a single request across services. Key events logged include `crawl_complete` (URL, HTTP status, links extracted), `query_executed` (query text, result count, latency, cache hit), and `index_rebuild` (document count, duration). In a production environment, these JSON logs would be shipped to a log aggregation service (like Elasticsearch/Kibana or Datadog) where engineers can filter by trace ID to reconstruct the full lifecycle of a single request across multiple services.

**Prometheus Metrics (`backend/src/shared/metrics.ts`):**

Prometheus is a pull-based monitoring system. The application exposes a `/metrics` HTTP endpoint that returns all collected metrics in a text-based format. A Prometheus server periodically scrapes this endpoint (typically every 15 seconds) and stores the time-series data for querying and alerting.

There are four metric types: **Counters** (monotonically increasing values, like `search_queries_total`), **Gauges** (values that go up and down, like `crawl_frontier_size` or `circuit_breaker_state`), **Histograms** (distributions of values, like `search_query_latency_seconds` which tracks how many queries fell into each latency bucket), and **Summaries** (similar to histograms but compute quantiles on the client side). This project exposes crawl throughput, query latency (bucketed by cache hit/miss), cache hit ratio, frontier backlog size, and circuit breaker state. These metrics enable SLI-based alerting: for example, "alert if query p95 latency exceeds 500ms for 2 consecutive minutes."

**Rate Limiting (`backend/src/shared/rateLimiter.ts`):**

Rate limiting restricts how many requests a client can make within a time window. Without rate limiting, a single user (or bot) could overwhelm the search service with thousands of queries per second, degrading performance for all other users.

This implementation uses Redis as the backing store for rate limit counters, which means the limits are enforced consistently across multiple API server instances. Each request increments a counter keyed by `ratelimit:{endpoint}:{clientId}` with a TTL equal to the window duration. If the counter exceeds the threshold, the server returns HTTP 429 (Too Many Requests) with a `Retry-After` header. Different endpoints have different limits: search allows 60 requests per minute (generous for interactive use, restrictive enough to prevent scraping), while admin endpoints allow only 10 per minute. The Redis-backed approach is superior to in-memory rate limiting because it works across multiple server instances -- if the API is scaled to 5 instances behind a load balancer, the rate limit is still enforced globally.

**Idempotency (`backend/src/shared/idempotency.ts`):**

Idempotency means that performing the same operation multiple times produces the same result as performing it once. This is critical for operations that have side effects, like crawling a URL or indexing a document.

Consider what happens without idempotency: a crawler instance picks up URL X, starts fetching it, but the process crashes before marking the URL as crawled. Another instance picks up URL X and fetches it again. Now the same page is indexed twice, wasting resources and potentially creating duplicate results. The idempotency implementation uses Redis `SET NX EX` (set-if-not-exists with expiry) to acquire a lock keyed by `crawl:{urlHash}:{scheduledAt}`. If the lock already exists, the crawl job is skipped. For document indexing, idempotency is achieved differently: Elasticsearch document IDs are deterministically derived from URL hashes, so re-indexing the same URL produces an upsert rather than a duplicate. For PageRank updates, new scores are written to a staging table and atomically swapped into the active table, preventing partial updates.

**Health Checks (`backend/src/shared/health.ts`):**

Health checks are HTTP endpoints that report whether the application and its dependencies are functioning correctly. They serve three distinct purposes:

1. **Liveness probe (`/healthz`)**: Answers "is the process alive?" A simple HTTP 200 response. If this fails, the orchestrator (Kubernetes) kills and restarts the container. This catches situations where the process is hung (deadlocked, infinite loop) but the OS has not killed it.

2. **Readiness probe (`/ready`)**: Answers "is the application ready to serve traffic?" This checks whether PostgreSQL, Redis, and Elasticsearch connections are established. If this fails, the load balancer stops routing traffic to this instance but does not restart it. This is used during startup (while the application is establishing database connections) and during dependency outages (PostgreSQL goes down temporarily).

3. **Detailed health (`/health`)**: Returns a JSON object with the status of every dependency, connection pool utilization, and latency measurements. This is used by operations dashboards and alerting systems, not by the orchestrator.

### What Was Simplified or Substituted

| Production Design | Local Implementation | Rationale |
|-------------------|---------------------|-----------|
| Custom distributed index (Bigtable + Colossus) | Single Elasticsearch node | ES provides production-grade BM25 with minimal setup |
| 1000-crawler distributed fleet | Single-process crawler | Demonstrates concepts without distributed coordination |
| Redis Cluster for query cache | Single Valkey instance | Same API, sufficient for local volume |
| PostgreSQL sharded link graph | Single PostgreSQL instance | Link graph fits in memory at local scale |
| Learning-to-rank model | Static weight combination (0.35/0.25/0.15/0.25) | Demonstrates multi-signal ranking without ML infrastructure |
| Click-through rate signal | Simulated via query logs | No real user click data at local scale |
| Distributed tracing (OpenTelemetry) | Structured logs with trace IDs | Lighter weight, sufficient for debugging |

### What Was Omitted

- **Distributed crawling** coordination (URL frontier partitioning across crawlers)
- **Index compression** (variable-byte encoding, PForDelta for postings)
- **Real-time indexing pipeline** (Kafka-based streaming from crawl to index)
- **Learning-to-rank** model training on click data
- **CDN** for serving static frontend assets
- **Multi-region** deployment with geo-routed queries
- **Kubernetes** orchestration and horizontal pod autoscaling
- **Spell correction** with language model (basic edit-distance only)
- **Knowledge graph** panels and entity extraction
- **Image/video search** and multimodal indexing
- **Personalization** based on user search history
