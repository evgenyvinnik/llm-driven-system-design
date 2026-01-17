# Web Crawler - Architecture Design

## System Overview

A distributed web crawling system for indexing the internet with politeness, scalability, and efficient URL management.

## Requirements

### Functional Requirements

1. **URL Discovery**: Extract and discover new links from crawled pages
2. **Page Fetching**: Download HTML content from web servers with proper error handling
3. **Content Extraction**: Parse HTML to extract titles, descriptions, and links
4. **Politeness**: Respect robots.txt, implement per-domain rate limiting

### Non-Functional Requirements

- **Scalability**: Horizontally scalable workers (target: 100+ pages/second with 3 workers)
- **Availability**: Workers can fail independently without affecting the system
- **Latency**: Dashboard updates within 5 seconds
- **Consistency**: Eventual consistency for deduplication (small window for duplicate crawls acceptable)

## Capacity Estimation

Based on local development scale:

- **Target crawl rate**: 10-50 pages/second (local), 400+ pages/second (production)
- **Workers**: 3-5 for local, 80-150 for production
- **Storage per page**: ~20KB compressed metadata
- **URL frontier**: Millions of URLs with 100 bytes each

## High-Level Architecture

```
                    +------------------+
                    |   Frontend       |
                    |   Dashboard      |
                    |   (React/Vite)   |
                    +--------+---------+
                             |
                    +--------v---------+
                    |   API Server     |
                    |   (Express.js)   |
                    |   Port: 3001     |
                    +--------+---------+
                             |
         +-------------------+-------------------+
         |                   |                   |
+--------v-------+  +--------v-------+  +--------v-------+
| Worker 1       |  | Worker 2       |  | Worker N       |
| WORKER_ID=1    |  | WORKER_ID=2    |  | WORKER_ID=N    |
+----------------+  +----------------+  +----------------+
         |                   |                   |
         +-------------------+-------------------+
                             |
              +--------------+---------------+
              |              |               |
     +--------v-------+ +----v----+  +-------v-------+
     |   PostgreSQL   | |  Redis  |  | robots.txt    |
     |   - Frontier   | | - Dedup |  | Cache (Redis) |
     |   - Metadata   | | - Locks |  +---------------+
     +----------------+ +---------+
```

### Core Components

1. **API Server** (`backend/src/server.ts`)
   - RESTful API for dashboard and management
   - Handles seed URL injection, stats retrieval
   - Health checks for monitoring

2. **Crawler Workers** (`backend/src/worker.ts`)
   - Stateless workers that fetch pages
   - Pull URLs from frontier, respect politeness
   - Store results and discovered links

3. **URL Frontier Service** (`backend/src/services/frontier.ts`)
   - Priority queue with 3 levels (high, medium, low)
   - Tracks URL states: pending, in_progress, completed, failed
   - Handles deduplication before adding

4. **Robots Service** (`backend/src/services/robots.ts`)
   - Fetches and caches robots.txt per domain
   - Extracts crawl-delay directives
   - Checks URL permission before crawling

5. **Stats Service** (`backend/src/services/stats.ts`)
   - Aggregates crawl statistics
   - Tracks worker heartbeats
   - Provides time-series data for charts

## Data Model

### Database Schema (PostgreSQL)

```sql
-- URL Frontier: Queue of URLs to crawl
CREATE TABLE url_frontier (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    url_hash VARCHAR(64) NOT NULL UNIQUE,
    domain VARCHAR(255) NOT NULL,
    priority INTEGER DEFAULT 1,      -- 1=low, 2=medium, 3=high
    depth INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',  -- pending, in_progress, completed, failed
    scheduled_at TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Crawled Pages: Metadata about fetched pages
CREATE TABLE crawled_pages (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL,
    url_hash VARCHAR(64) NOT NULL UNIQUE,
    domain VARCHAR(255) NOT NULL,
    status_code INTEGER,
    content_type VARCHAR(100),
    content_length INTEGER,
    content_hash VARCHAR(64),
    title TEXT,
    description TEXT,
    links_count INTEGER DEFAULT 0,
    crawled_at TIMESTAMP DEFAULT NOW(),
    crawl_duration_ms INTEGER,
    error_message TEXT
);

-- Domains: Per-domain settings and robots.txt cache
CREATE TABLE domains (
    id SERIAL PRIMARY KEY,
    domain VARCHAR(255) NOT NULL UNIQUE,
    robots_txt TEXT,
    robots_fetched_at TIMESTAMP,
    crawl_delay FLOAT DEFAULT 1.0,
    page_count INTEGER DEFAULT 0,
    is_allowed BOOLEAN DEFAULT true
);

-- Seed URLs: Initial crawl starting points
CREATE TABLE seed_urls (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    priority INTEGER DEFAULT 2,
    added_at TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT true
);
```

### Redis Keys

```
crawler:visited_urls          - Set of URL hashes (deduplication)
crawler:domain:{d}:lock       - Per-domain rate limit lock
crawler:domain:{d}:robots     - Cached robots.txt content
crawler:domain:{d}:delay      - Crawl delay for domain
crawler:worker:{id}:heartbeat - Worker last heartbeat timestamp
crawler:active_workers        - Set of active worker IDs
crawler:stats:*               - Various counter keys
crawler:queue:high            - High priority URL queue (sorted set)
crawler:queue:medium          - Medium priority URL queue (sorted set)
crawler:queue:low             - Low priority URL queue (sorted set)
```

## API Design

### Core Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check with DB/Redis status |
| GET | `/api/stats` | Comprehensive crawl statistics |
| GET | `/api/stats/timeseries` | Time-series data for charts |
| GET | `/api/frontier/stats` | Frontier queue statistics |
| GET | `/api/frontier/urls` | List URLs in frontier |
| POST | `/api/frontier/add` | Add URLs to frontier |
| POST | `/api/frontier/seed` | Add seed URLs with high priority |
| POST | `/api/frontier/recover` | Recover stale in-progress URLs |
| GET | `/api/pages` | List crawled pages with filtering |
| GET | `/api/domains` | List crawled domains |
| GET | `/api/domains/:domain/robots` | Get cached robots.txt |

## Key Design Decisions

### Distributed Coordination

**Problem**: Multiple workers must coordinate to avoid hitting the same domain concurrently.

**Solution**: Redis distributed locks with TTL
```typescript
// Acquire lock for domain (NX = only if not exists, EX = expire)
const result = await redis.set(lockKey, workerId, 'NX', 'EX', delaySeconds);
return result === 'OK';
```

**Trade-off**: Slightly less efficient than centralized scheduling, but simpler and more resilient.

### URL Deduplication

**Problem**: Avoid crawling the same URL multiple times.

**Solution**: Redis SET for visited URL hashes
- SHA-256 hash of normalized URL
- O(1) lookup time
- Check before adding to frontier AND before crawling

**Trade-off**: Memory usage scales with URL count. For 10B URLs, would need Bloom filter.

### Priority Queue

**Problem**: Important pages should be crawled first.

**Solution**: Three-level priority based on:
- URL depth (shallow = higher priority)
- URL patterns (/about, /contact = high; /page/2 = low)
- Seed URLs always high priority

## Technology Stack

- **Application Layer**: Node.js + Express + TypeScript
- **Data Layer**: PostgreSQL (frontier, metadata)
- **Caching Layer**: Redis (dedup, locks, robots cache)
- **Frontend**: React 19 + Vite + TanStack Router + Zustand + Tailwind CSS
- **Parsing**: Cheerio (HTML), robots-parser (robots.txt)
- **HTTP Client**: Axios with timeouts

## Scalability Considerations

1. **Horizontal Worker Scaling**: Add more workers with unique WORKER_IDs
2. **Database Connection Pooling**: Pool of 20 connections per worker
3. **Redis Clustering**: Can shard by domain hash for larger scale
4. **Stateless Workers**: Any worker can process any URL (domain lock ensures coordination)

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Frontier Storage | PostgreSQL | Kafka | Simpler, queryable, good enough for learning scale |
| Dedup | Redis SET | Bloom Filter | Exact dedup, no false positives, memory acceptable |
| Rate Limit | Redis Lock | Token Bucket | Simpler, domain-level granularity sufficient |
| Parsing | Cheerio | Puppeteer | Faster, no JS rendering needed for basic crawl |

## Monitoring and Observability

Current implementation:
- Worker heartbeats in Redis
- Stats counters in Redis
- Dashboard with real-time updates (5s polling)

Future:
- Prometheus metrics export
- Grafana dashboards
- Alerting on worker failures

## Security Considerations

1. **User-Agent**: Identify as crawler with contact info
2. **Rate Limiting**: Never exceed 1 request/second per domain by default
3. **robots.txt**: Always check before crawling
4. **Timeouts**: 30s request timeout to avoid getting stuck
5. **Max Page Size**: 10MB limit to prevent memory issues

## Future Optimizations

1. **JavaScript Rendering**: Puppeteer integration for SPA sites
2. **Near-Duplicate Detection**: SimHash for content similarity
3. **Content Storage**: S3/local filesystem for raw HTML
4. **Sitemap Parsing**: Extract URLs from sitemap.xml
5. **Work Stealing**: Dynamic rebalancing when workers are idle
6. **DNS Caching**: Reduce DNS lookups for repeated domains
