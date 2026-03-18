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
