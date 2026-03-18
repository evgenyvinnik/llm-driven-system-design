# News Aggregator - Architecture Design

## System Overview

A content aggregation and curation platform that crawls RSS/Atom feeds from multiple sources, deduplicates articles, clusters related stories, extracts topics, and delivers personalized news feeds to users. Core challenges involve content deduplication at scale, real-time ranking, and balancing freshness with relevance.

**Learning Goals:**
- Build content deduplication with SimHash fingerprinting
- Design multi-signal ranking algorithms for personalized feeds
- Implement scheduled crawling with circuit breakers
- Handle full-text search with Elasticsearch

---

## Requirements

### Functional Requirements

- **Source Crawling**: Fetch RSS/Atom feeds on configurable schedules (5-60 minute intervals)
- **Deduplication**: Identify and group near-duplicate articles using SimHash fingerprinting
- **Story Clustering**: Group articles covering the same story from multiple sources
- **Categorization**: Extract topics using keyword matching (politics, tech, sports, etc.)
- **Personalization**: Rank feed items based on user interests, freshness, source quality, and trending signals
- **Search**: Full-text search across articles with filters (source, date, topic)
- **User Management**: Registration, login, preferences, reading history
- **Admin Dashboard**: Manage sources, view crawl status, monitor system health

### Non-Functional Requirements

- **Throughput**: 10K feed requests/second at peak, 1K crawls/minute
- **Latency**: p95 < 200ms for feed retrieval, p95 < 500ms for search
- **Availability**: 99.9% uptime (< 8.7 hours downtime/month)
- **Consistency**: Eventual consistency acceptable (1-2 second delay for new articles)
- **Durability**: No data loss for user preferences and reading history

---

## Capacity Estimation

### Production Scale

| Metric | Value | Rationale |
|--------|-------|-----------|
| Daily Active Users (DAU) | 5M | News aggregator user base |
| News Sources | 50K RSS feeds | Major outlets + niche blogs globally |
| Articles/Day | 2M | ~40 articles per active source |
| Average Article Size | 5 KB | Title, URL, summary, metadata, fingerprint |
| Feed requests/second | 10K peak | 5M users x 10 refreshes/day, concentrated in peak hours |
| Search queries/second | 2K peak | 20% of users search daily |

### Storage Growth

| Component | Size/Day | 30-Day Total | Retention |
|-----------|----------|--------------|-----------|
| PostgreSQL (articles) | 10 GB | 300 GB | 90 days, then archive |
| PostgreSQL (users/prefs) | 50 MB | 1.5 GB | Indefinite |
| Elasticsearch (search index) | 6 GB | 180 GB | 90 days, then prune |
| Redis (sessions + cache) | 500 MB | 2 GB (steady state) | TTL-based eviction |

### Local Development Scale

| Metric | Value | Rationale |
|--------|-------|-----------|
| Daily Active Users | 10-50 | Local testing |
| News Sources | 50-200 RSS feeds | Mix of major outlets and niche blogs |
| Articles/Day | 2,000-10,000 | ~50-100 articles per active source |
| Total API RPS | ~20 | With 3x headroom = 60 RPS capacity |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CDN / Edge Cache                             │
│                  (Static assets, trending feed cache)                │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       API Gateway / Load Balancer                    │
│              (Rate limiting, auth, request routing)                   │
└──────────────────────────────────────────────────────────────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
     ┌──────────────┐  ┌──────────────┐   ┌──────────────┐
     │  API Server  │  │  API Server  │   │  API Server  │
     │  Instance 1  │  │  Instance 2  │   │  Instance N  │
     └──────┬───────┘  └──────┬───────┘   └──────┬───────┘
            │                 │                   │
            └─────────────────┼───────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                      ▼
┌──────────────┐     ┌──────────────┐      ┌──────────────┐
│  PostgreSQL  │     │    Redis     │      │Elasticsearch │
│  (Primary)   │     │  (Cache +   │      │  (Search)    │
│  + Replicas  │     │   Sessions) │      │              │
└──────────────┘     └──────────────┘      └──────────────┘
                              │
                              │ Index queue
                              ▼
                     ┌──────────────┐
                     │ Index Worker │──────▶ Elasticsearch
                     └──────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                       Crawler Service Cluster                        │
│                                                                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                    │
│  │ Crawler 1  │  │ Crawler 2  │  │ Crawler N  │                    │
│  │ (feeds     │  │ (feeds     │  │ (feeds     │                    │
│  │  a-h hash) │  │  i-p hash) │  │  q-z hash) │                    │
│  └────────────┘  └────────────┘  └────────────┘                    │
│                                                                      │
│  Each crawler: RSS fetch ──▶ SimHash dedup ──▶ Topic extract         │
│                ──▶ Story cluster ──▶ PostgreSQL write ──▶ Index queue │
└──────────────────────────────────────────────────────────────────────┘
```

### Request Flow: Fetching Personalized Feed

```
1. User requests GET /api/v1/feed
2. API Server checks Redis cache for user:{id}:feed (TTL 60s)
3. If cache HIT:
   - Return cached feed immediately (< 20ms)
4. If cache MISS:
   a. Query PostgreSQL for recent articles (last 24h)
   b. Load user preferences from Redis cache (or PostgreSQL)
   c. Apply ranking algorithm:
      - Relevance score (35%): topic match with user interests
      - Freshness score (25%): exponential decay, 6-hour half-life
      - Quality score (20%): source diversity, multi-source stories
      - Trending score (10%): velocity of new articles in cluster
      - Breaking boost (+30%): if breaking_news flag set
   d. Return top 50 articles, cache in Redis (TTL 60s)
5. Return JSON response
```

### Request Flow: Search Query

```
1. User submits GET /api/v1/search?q=election&topic=politics
2. API Server builds Elasticsearch query:
   - Full-text match on title + summary (English analyzer)
   - Filter by topic if specified
   - Sort by relevance + recency boost
3. Elasticsearch returns document IDs + highlights
4. API Server hydrates results with PostgreSQL data if needed
5. Return JSON with highlighted snippets
```

### Request Flow: Crawl Cycle

```
1. Crawler Service runs on schedule (cron: every 15 minutes)
2. Fetch list of due sources from PostgreSQL
3. For each source (parallel, max 10 concurrent):
   a. Check circuit breaker state for source domain
   b. Fetch RSS/Atom feed with timeout (10s)
   c. Parse feed, extract articles
   d. For each article:
      - Generate SimHash fingerprint (64-bit)
      - Check PostgreSQL for existing fingerprint (Hamming distance <= 3)
      - If duplicate: link to existing story cluster
      - If new: insert article, create/update story cluster
   e. Push article IDs to Redis queue for Elasticsearch indexing
4. Index Worker:
   - Pop article IDs from Redis queue (BLPOP)
   - Bulk index to Elasticsearch
   - Update story cluster aggregations
```

---

## Core Components

### 1. API Server (Node.js + Express)

Serves the REST API for the frontend. Handles session-based authentication, rate limiting (100 req/min per IP, 20 for search), request validation, and response caching via Redis.

### 2. Crawler Service

Scheduled feed fetching with per-domain rate limiting (1 req/sec), circuit breakers per source, and retry with exponential backoff (1s, 5s, 30s). Crawl results are stored in PostgreSQL and pushed to an indexing queue.

### 3. SimHash Deduplication Engine

Generates 64-bit fingerprints from article content. Two articles with Hamming distance <= 3 are considered near-duplicates. O(1) comparison, 8 bytes per article, no ML dependencies.

### 4. Multi-Signal Ranking Engine

Combines weighted signals for personalized feed scoring:

| Signal | Weight | Computation |
|--------|--------|-------------|
| Relevance | 35% | Topic match with user interests (cosine similarity) |
| Freshness | 25% | Exponential decay with 6-hour half-life |
| Quality | 20% | Source diversity, multi-source story coverage |
| Trending | 10% | Velocity (articles/hour) in story cluster |
| Breaking | +30% boost | Binary flag on story cluster |

### 5. PostgreSQL (Primary Data Store)

Articles, sources, users, preferences, story clusters, reading history. Transactional integrity for user operations. Indexes optimized for time-range queries and fingerprint lookups.

### 6. Redis (Cache + Queue)

Session storage (TTL 24h), feed cache (TTL 60s), user preference cache (TTL 5min), global trending feed cache (TTL 30s), and article indexing queue (RPUSH/BLPOP pattern).

### 7. Elasticsearch (Search Index)

Full-text search with English analyzer, relevance scoring, topic aggregations. Search is a degradable feature: if Elasticsearch is down, feeds still work.

---

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- News sources
CREATE TABLE sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  domain VARCHAR(255) UNIQUE,
  feed_url VARCHAR(500) NOT NULL,
  category VARCHAR(50),
  credibility_score DECIMAL(3, 2) DEFAULT 0.80,
  crawl_frequency_minutes INTEGER DEFAULT 15,
  is_active BOOLEAN DEFAULT true,
  last_crawled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Story clusters (groups of related articles)
CREATE TABLE stories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(500) NOT NULL,
  summary TEXT,
  primary_topic VARCHAR(50),
  topics TEXT[] DEFAULT '{}',
  entities JSONB DEFAULT '[]',
  fingerprint BIGINT,
  article_count INTEGER DEFAULT 1,
  source_count INTEGER DEFAULT 1,
  velocity DECIMAL(10, 4) DEFAULT 0,
  is_breaking BOOLEAN DEFAULT FALSE,
  breaking_started_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Articles
CREATE TABLE articles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
  story_id UUID REFERENCES stories(id) ON DELETE SET NULL,
  url VARCHAR(1000) UNIQUE NOT NULL,
  title VARCHAR(500) NOT NULL,
  summary TEXT,
  body TEXT,
  author VARCHAR(255),
  image_url VARCHAR(500),
  published_at TIMESTAMP,
  crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  fingerprint BIGINT,
  topics TEXT[] DEFAULT '{}',
  entities JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User preferences
CREATE TABLE user_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  preferred_topics TEXT[] DEFAULT '{}',
  preferred_sources UUID[] DEFAULT '{}',
  blocked_sources UUID[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User reading history
CREATE TABLE user_reading_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
  story_id UUID REFERENCES stories(id) ON DELETE SET NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  dwell_time_seconds INTEGER DEFAULT 0,
  UNIQUE(user_id, article_id)
);

-- Topic weights (learned from behavior)
CREATE TABLE user_topic_weights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  topic VARCHAR(50) NOT NULL,
  weight DECIMAL(5, 4) DEFAULT 0.1,
  UNIQUE(user_id, topic)
);

-- Crawl schedule
CREATE TABLE crawl_schedule (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES sources(id) ON DELETE CASCADE UNIQUE,
  next_crawl TIMESTAMP NOT NULL,
  priority INTEGER DEFAULT 5,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Performance indexes
CREATE INDEX idx_articles_story ON articles(story_id);
CREATE INDEX idx_articles_source ON articles(source_id);
CREATE INDEX idx_articles_published ON articles(published_at DESC);
CREATE INDEX idx_articles_fingerprint ON articles(fingerprint);
CREATE INDEX idx_stories_topics ON stories USING GIN(topics);
CREATE INDEX idx_stories_velocity ON stories(velocity DESC) WHERE velocity > 0;
CREATE INDEX idx_stories_breaking ON stories(is_breaking) WHERE is_breaking = true;
CREATE INDEX idx_stories_created ON stories(created_at DESC);
CREATE INDEX idx_reading_history_user ON user_reading_history(user_id);
CREATE INDEX idx_crawl_schedule_next ON crawl_schedule(next_crawl);
```

### Elasticsearch Mapping

```json
{
  "mappings": {
    "properties": {
      "article_id": { "type": "keyword" },
      "title": { "type": "text", "analyzer": "english", "fields": { "exact": { "type": "keyword" } } },
      "summary": { "type": "text", "analyzer": "english" },
      "source_name": { "type": "keyword" },
      "source_id": { "type": "keyword" },
      "topics": { "type": "keyword" },
      "published_at": { "type": "date" },
      "crawled_at": { "type": "date" },
      "story_cluster_id": { "type": "keyword" }
    }
  },
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "refresh_interval": "5s"
  }
}
```

### Redis Key Patterns

| Pattern | Type | TTL | Purpose |
|---------|------|-----|---------|
| `session:{sessionId}` | Hash | 24h | User session data |
| `user:{userId}:feed` | String (JSON) | 60s | Cached personalized feed |
| `user:{userId}:prefs` | String (JSON) | 5m | Cached user preferences |
| `feed:global` | String (JSON) | 30s | Cached global trending feed |
| `index:queue` | List | None | Article IDs pending ES indexing |
| `rate:{ip}` | String (count) | 60s | Rate limiting counter |
| `crawl:lock:{sourceId}` | String | 5m | Distributed crawl lock |

---

## API Design

### Core Endpoints

```
# Feed
GET  /api/v1/feed                 → Personalized feed (or trending for anonymous)
GET  /api/v1/stories/:id          → Story detail with all source articles
GET  /api/v1/search               → Full-text search with topic/date filters
GET  /api/v1/topics               → List topics with article counts
GET  /api/v1/trending             → Trending stories by velocity

# User
POST /api/v1/user/login           → Login (session-based)
POST /api/v1/user/register        → Registration
GET  /api/v1/user/preferences     → Get preferences
PUT  /api/v1/user/preferences     → Update preferences (invalidates cache)

# Admin
GET  /api/v1/admin/sources        → List all sources with crawl status
POST /api/v1/admin/sources        → Add new source
PUT  /api/v1/admin/sources/:id    → Update source
GET  /api/v1/admin/stats          → System stats (crawl rates, article counts)
POST /api/v1/admin/crawl          → Trigger immediate crawl
```

---

## Key Design Decisions

### SimHash vs Semantic Embeddings for Deduplication

**Chosen: SimHash (64-bit fingerprint).**

At 2M articles/day, computing semantic embeddings for every article would require GPU inference at ~100ms per article, adding 55 GPU-hours of daily compute. SimHash generates a 64-bit fingerprint from word frequencies in O(n) time with zero dependencies. Two fingerprints are compared via Hamming distance in O(1), and a threshold of <= 3 bits identifies near-duplicates with high precision for news content where duplicates are literal copies or minor rewrites.

The trade-off is accuracy on paraphrased content. If Reuters and AP write completely different articles about the same event, SimHash will not detect them as duplicates. Story clustering handles this partially: articles with overlapping keywords and entities are clustered together even if their fingerprints differ. For a news aggregator, this is acceptable: showing two genuinely different takes on the same story adds value rather than being noise.

### Elasticsearch vs PostgreSQL Full-Text Search

**Chosen: Elasticsearch for search, PostgreSQL for primary data.**

PostgreSQL's `tsvector`/`tsquery` works well for simple keyword search, but news search demands relevance scoring with field boosting (title matches worth more than body), phrase matching, and faceted results (counts per topic, per source). Elasticsearch's BM25 scoring, built-in analyzers, and aggregation framework handle this natively. The English analyzer also handles stemming and stop words.

The cost is an additional service to operate and an eventual consistency gap: articles are searchable ~5 seconds after crawling (ES refresh interval). This is acceptable for a news aggregator where users search for topics, not breaking-second updates. Elasticsearch is also a degradable dependency: if it fails, feeds continue working from PostgreSQL and search returns a "temporarily unavailable" message.

### Redis Lists vs RabbitMQ for Index Queue

**Chosen: Redis Lists (RPUSH/BLPOP).**

The article indexing queue is a simple FIFO: crawlers produce article IDs, the index worker consumes them. Redis Lists provide this with zero additional infrastructure since Redis is already running for caching and sessions. BLPOP blocks efficiently when the queue is empty (no polling). Idempotent Elasticsearch upserts make at-least-once delivery safe.

RabbitMQ would add routing, acknowledgments, and dead letter exchange capabilities, but these are unnecessary for an indexing pipeline where reprocessing an article is cheap and harmless. The memory overhead of a RabbitMQ instance (256 MB+) is not justified for this use case.

---

## Caching Strategy

### Cache-Aside Pattern

All caching uses cache-aside (lazy loading): check cache first, on miss fetch from source, store in cache with TTL, return result.

| Cache Type | TTL | Invalidation Strategy |
|------------|-----|----------------------|
| User session | 24 hours | Explicit logout or expiry |
| Personalized feed | 60 seconds | TTL expiry only |
| Global trending | 30 seconds | TTL expiry only |
| User preferences | 5 minutes | Invalidate on PUT /preferences |
| Source list | 10 minutes | Invalidate on admin changes |

### Why Feed Caching Matters

Without caching, every feed request requires: PostgreSQL queries for candidate stories (200+ rows), user preference lookups, ranking algorithm execution, and article enrichment. With 10K requests/second at peak, this would require massive database capacity. A 60-second cache reduces database load by ~99.8%, returning cached responses in < 20ms vs 100-200ms for computed feeds. The staleness is invisible to users: news content changes on a 15-minute crawl cycle, so a 60-second cache never misses an article.

---

## Security

### Authentication

Session-based authentication with Redis store. Passwords hashed with bcrypt (cost factor 12). Session cookies set with HttpOnly, Secure (in production), SameSite=Lax, 24-hour expiry.

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| `user` | Read feeds, search, update own preferences, reading history |
| `admin` | All user permissions + manage sources, view stats, trigger crawls |

### Rate Limiting

| Endpoint | Limit | Rationale |
|----------|-------|-----------|
| General API | 100 req/min per IP | Standard abuse prevention |
| Search | 20 req/min per IP | Search is expensive (Elasticsearch) |
| Login | 5 attempts/min per IP | Brute force protection |

### Input Validation

All queries use parameterized statements for SQL injection prevention. Search queries are trimmed, length-limited (200 chars), and escaped. Topic filters validated against alphanumeric pattern.

---

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `http_request_duration_seconds` | Histogram | Track API latency against SLOs |
| `feed_generations_total` | Counter | Monitor feed request volume |
| `cache_hits_total` / `cache_misses_total` | Counter | Calculate cache hit rate |
| `crawler_fetch_total` | Counter | Track crawl success/failure rates |
| `circuit_breaker_state` | Gauge | Monitor source health (0=closed, 1=open, 2=half-open) |
| `articles_stored_total` | Counter | Track content ingestion rate |
| `index_queue_depth` | Gauge | Number of articles pending indexing |

### Key Alerting Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| API p95 latency | > 300ms | > 1s | Check DB queries, cache hit rate |
| Error rate | > 1% | > 5% | Check logs, investigate errors |
| Cache hit rate | < 70% | < 50% | Review cache TTLs, warm cache |
| Index queue depth | > 500 | > 2000 | Scale index workers |
| Crawl failure rate | > 10% | > 30% | Check network, source health |

### Structured Logging

Pino-based JSON logging with consistent fields: timestamp, level, service name, source ID, trace ID. Request logging middleware records method, path, status, duration, user ID. Pretty-printed in development, raw JSON in production.

### Health Checks

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `/health` | Liveness probe | Process running |
| `/health/live` | K8s liveness | Simple OK |
| `/health/ready` | Readiness probe | PostgreSQL + Redis + Elasticsearch (ES degraded OK) |
| `/health/detailed` | Debugging | All above + connection pool stats, circuit breaker states, cache stats |

---

## Failure Handling

### Circuit Breakers for RSS Sources

Each RSS source gets its own circuit breaker (Opossum library). A single slow or unresponsive source cannot block the crawler thread, exhaust connection pool slots, or delay crawling of healthy sources.

**Configuration:**
- Timeout: 10 seconds
- Error threshold: 50% of requests
- Reset timeout: 30 seconds (half-open test)
- Volume threshold: 5 requests before tripping

### Retry Strategy

Exponential backoff with jitter for RSS fetch failures:
- Retry 1: ~1 second
- Retry 2: ~5 seconds
- Retry 3: ~30 seconds
- Total worst-case: ~36 seconds per source

Only transient failures are retried. Permanent failures (404, 410 Gone) update the source's `last_error` field.

### Idempotent Operations

Article insertion uses `ON CONFLICT (url) DO NOTHING` for safe replay. Elasticsearch indexing uses upsert by article UUID. Duplicate processing has no side effects.

### Graceful Degradation

| Component Failure | Degraded Behavior |
|-------------------|-------------------|
| Redis unavailable | Sessions fail (re-login required), feeds uncached but functional |
| Elasticsearch unavailable | Search returns "temporarily unavailable", feeds still work |
| PostgreSQL unavailable | Full outage (primary data store) |
| Individual source down | Circuit opens, other sources continue, retry on next cycle |

---

## Scalability Considerations

### Horizontal Scaling Path

1. **API Servers**: Stateless, scale behind load balancer
2. **Crawlers**: Partition sources by domain hash, run multiple crawler instances
3. **PostgreSQL**: Read replicas for feed queries, partition articles by month
4. **Redis**: Redis Cluster for cache sharding at > 1GB
5. **Elasticsearch**: Add nodes, increase shard count for search scaling

### What Breaks First

At 100x scale (500M articles/month):
- **Fingerprint lookups**: Hamming distance scan becomes expensive. Solution: locality-sensitive hashing index or bit-manipulation tricks.
- **Feed computation**: Even with caching, cache misses at 10K RPS require fast ranking. Solution: pre-compute feeds in background workers.
- **Elasticsearch index size**: 18 TB/year at full text. Solution: rolling indices with lifecycle management.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Deduplication | SimHash (64-bit) | Semantic embeddings | O(1) comparison, no ML dependencies, sufficient for news |
| Search engine | Elasticsearch | PostgreSQL full-text | Better relevance scoring, facets, gracefully degradable |
| Index queue | Redis Lists | RabbitMQ | Already running, simpler, idempotent consumers |
| Database | PostgreSQL + JSONB | MongoDB | SQL joins for stories+articles, JSONB for flexible fields |
| Feed caching | 60s TTL | Real-time computation | 99.8% DB load reduction, invisible staleness |
| Auth | Session + Redis | JWT | Immediate revocation, simpler for learning |
| Crawl scheduling | node-cron in-process | Dedicated scheduler service | Simpler for single-process deployment |

---

## Frontend Architecture

This section documents the React frontend implementation, covering component hierarchy, state management, routing, data fetching, and key UI patterns.

### Component Hierarchy

```
__root.tsx (Root Layout)
├── Header (components/Header.tsx)
│   ├── Logo + brand "NewsAgg"
│   ├── Navigation links (Feed, Trending, Topics, Search)
│   ├── Auth state display (login/register or user menu)
│   └── Admin link (conditional on role)
├── index.tsx (Feed Page)
│   └── StoryCard list with topic badges, source counts, breaking indicators
├── trending.tsx (Trending Stories)
│   └── StoryCard list sorted by velocity
├── topics.index.tsx (Topics Overview)
│   └── Topic grid with article counts
├── topics.$topic.tsx (Topic Feed)
│   └── StoryCard list filtered by selected topic
├── story.$storyId.tsx (Story Detail)
│   └── Story metadata + list of source articles with links
├── search.tsx (Search Page)
│   └── Search input, topic/date filters, article result list
├── settings.tsx (User Settings)
│   └── Preferred topics selector, blocked sources
├── admin.tsx (Admin Dashboard)
│   └── Source list, add/edit/delete sources, crawl triggers, system stats
├── login.tsx / register.tsx (Auth Pages)
```

### Shared Components

- **`Header`** (`components/Header.tsx`) -- Top navigation bar with route links, auth state, and responsive layout. Extracted as a shared component used by the root layout.
- **`StoryCard`** (`components/StoryCard.tsx`) -- Reusable card displaying a story's title, summary, topics (as badges), source count, article count, and relative timestamp. Used on the feed, trending, and topic pages.
- **`TopicBadges`** (`components/TopicBadges.tsx`) -- Renders an array of topic names as colored pill badges. Used inside StoryCard and on the story detail page.

### Zustand Stores

The frontend uses two Zustand stores:

**`useAuthStore`** (`stores/index.ts`) -- Manages user authentication and preferences. Uses `zustand/middleware/persist` to save the user object to `localStorage` for session restoration. On login, it automatically fetches user preferences (preferred topics, blocked sources) to enable personalized feed ranking. The `updatePreferences` action sends a PUT request and updates the local state in one step.

**`useFeedStore`** (`stores/index.ts`) -- Manages news feed state including the story list, pagination cursor, loading/error states, and selected topic filter. Supports two operations: `setStories` (replaces the list, used for initial load and refresh) and `appendStories` (appends to the list, used for infinite scroll "load more"). Changing the `selectedTopic` resets the story list and cursor to start a fresh filtered fetch. This store does not persist to storage -- the feed always starts fresh on page load.

### Routing

The frontend uses TanStack Router with file-based routing. The route structure mirrors the content hierarchy:

- `/` -- personalized feed (or global trending for anonymous users)
- `/trending` -- stories sorted by velocity (article count growth rate)
- `/topics` -- overview of all topics with story counts
- `/topics/$topic` -- feed filtered by a specific topic (dynamic route segment)
- `/story/$storyId` -- story detail page with all source articles (dynamic route segment)
- `/search` -- full-text search with topic and date filters
- `/settings` -- user preference management (preferred topics, blocked sources)
- `/admin` -- source management and system stats (admin role required)
- `/login`, `/register` -- authentication pages

The root layout calls `Header` and wraps child routes in a centered content area via `Outlet`.

### Data Fetching

API communication is organized into three client modules (`services/api.ts`):

- **`feedApi`** -- Feed retrieval (`getFeed`, `getTopicFeed`, `getTrending`, `getBreaking`), story details, story articles, search, and topics listing. Uses cursor-based pagination for feed endpoints.
- **`userApi`** -- Authentication (login, register, logout, session check), preference management, reading history recording, and available topics.
- **`adminApi`** -- Source CRUD, manual crawl triggers, article listing, breaking news management, and system stats.

All API methods use a shared `fetchApi` wrapper that includes `credentials: 'include'` for session cookie-based authentication, sets JSON content type, and extracts error messages from response bodies. Data fetching is triggered from route components via `useEffect` hooks or from store actions.

### Key UI Patterns

- **Cursor-based pagination**: The feed uses cursor-based pagination rather than offset-based. Each API response includes a `next_cursor` and `has_more` flag. The feed store's `appendStories` action appends new stories without re-fetching previous pages, enabling efficient infinite scroll.
- **Topic filtering with state reset**: When the user selects a topic in the feed store, the stories array, cursor, and hasMore flag are all reset to initial values, triggering a fresh fetch from the first page of the filtered feed.
- **Reading history tracking**: When a user views a story detail page, the frontend can record the read event via `userApi.recordRead`, including dwell time. This implicit signal feeds back into the ranking algorithm's relevance scoring.
- **Conditional personalization**: The feed endpoint returns personalized results for authenticated users (weighted by topic preferences and reading history) and falls back to global trending for anonymous visitors, with no UI change required.
- **Session restoration**: The auth store persists only the user object (not preferences) to localStorage. On page load, the stored user enables immediate rendering of the authenticated UI while preferences are re-fetched from the API.

---

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, written for readers who may be encountering these concepts for the first time.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles rather than individual users, and users are assigned one or more roles. Instead of checking "can user X manage sources?" the system checks "does user X have a role that includes the manage-sources permission?"

In this project, there are two roles: `user` and `admin`. Regular users can read feeds, search, and manage their own preferences and reading history. Admins get all user permissions plus the ability to manage sources, view system stats, and trigger crawls. When a request arrives, the auth middleware extracts the user's role from their session and checks whether that role permits the requested operation.

The key advantage over per-user permission lists is simplicity: with 5M users, you manage 2 role definitions instead of 5M permission sets. The trade-off is granularity -- you cannot give one specific user elevated crawl permissions without promoting them to full admin. For a news aggregator, this coarse-grained model is appropriate because the admin operations (source management) are infrequent and high-trust.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application code is responsible for managing the cache. On every read, the application first checks the cache. If the data is there (a "cache hit"), it returns immediately. If not (a "cache miss"), the application fetches from the database, stores the result in the cache with a TTL (time-to-live), and then returns it.

In this project, cache-aside is used at multiple levels: personalized feeds (60-second TTL), global trending feed (30-second TTL), user preferences (5-minute TTL), and source lists (10-minute TTL). At 10K feed requests/second at peak, a 60-second cache reduces database load by 99.8% -- only the first request in each 60-second window actually hits PostgreSQL and runs the ranking algorithm. Subsequent requests get the cached JSON in under 20ms.

Cache-aside differs from "write-through" caching (where every write updates both the cache and the database simultaneously). Cache-aside is simpler because it does not require the cache to participate in write operations. The trade-off is staleness: after an article is crawled and inserted into PostgreSQL, it will not appear in cached feeds until the feed cache TTL expires. For a news aggregator with a 15-minute crawl cycle, a 60-second cache staleness window is invisible.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents a failing service from being called repeatedly, giving it time to recover. It works like an electrical circuit breaker: when failures exceed a threshold, the breaker "opens" and immediately rejects all requests for a cooldown period, rather than letting them pile up and make the problem worse.

The circuit breaker has three states. In the **closed** state (normal operation), requests flow through to the downstream service. If failures exceed a configured threshold (50% of requests in this project), the breaker transitions to the **open** state. In the open state, all requests are immediately rejected without contacting the downstream service. After a configured timeout (30 seconds), the breaker enters the **half-open** state, where it allows a small number of test requests through. If those succeed, the breaker closes again; if they fail, it reopens.

In this project, each RSS source gets its own circuit breaker (via the Opossum library). This is critical because the crawler fetches from hundreds of different sources. If one source's server is down or responding slowly (10+ second timeouts), its circuit breaker opens, and the crawler skips it on subsequent cycles without wasting time or connection pool slots. Other sources continue to be crawled normally. Without per-source circuit breakers, a single slow source could exhaust the crawler's concurrency limit and delay all other sources.

### Structured Logging

Structured logging means emitting log entries as machine-parseable data (typically JSON objects) rather than free-form text strings. Instead of `console.log('Crawled source Reuters, found 15 articles')`, structured logging produces `{"level":"info","sourceId":"abc","sourceName":"Reuters","articlesFound":15,"crawlDuration":1234,"timestamp":"..."}`.

This project uses Pino, a high-performance JSON logger for Node.js. Every log entry includes a consistent set of fields: timestamp, log level, and service name. The request logging middleware (pino-http) automatically adds method, path, status code, duration, and user ID to every HTTP request log. In development, logs are pretty-printed for readability; in production, raw JSON is emitted for ingestion by log aggregation tools.

The primary advantage is queryability. When investigating why a specific source's crawl failed, you can filter logs by `sourceId` and `level=error` to find the exact failure. With unstructured text logs, you would need to write fragile regex patterns to extract the same information.

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical metrics from applications by periodically "scraping" an HTTP endpoint (typically `/metrics`). The application exposes counters, histograms, and gauges in a text format that Prometheus understands, and Prometheus stores and queries this data over time.

The three main metric types used in this project are:
- **Counters**: Values that only go up (e.g., `crawler_fetch_total`, `cache_hits_total`). Useful for computing rates (crawls per minute, cache hit ratio).
- **Histograms**: Track the distribution of values (e.g., `http_request_duration_seconds`). Prometheus computes percentiles (p50, p95, p99) from histogram buckets, enabling latency SLO monitoring like "API p95 < 200ms."
- **Gauges**: Values that go up or down (e.g., `circuit_breaker_state`, `index_queue_depth`). Useful for tracking current state -- for example, knowing how many articles are waiting for Elasticsearch indexing.

Each metric has labels that add dimensions. For example, `crawler_fetch_total{source="reuters",status="success"}` lets you independently track crawl outcomes per source. The alerting thresholds defined in the Observability section (e.g., "cache hit rate < 50% = critical") are implemented as Prometheus alerting rules that evaluate against these metrics.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. It protects the system from abuse, prevents any single client from monopolizing resources, and ensures fair access for all users.

This project implements per-IP rate limiting with different thresholds per endpoint:
- General API: 100 requests/minute (standard abuse prevention)
- Search: 20 requests/minute (search is expensive because it hits Elasticsearch)
- Login: 5 attempts/minute (brute force protection)

The implementation uses Redis counters keyed by IP address with a 60-second TTL. When a request arrives, the counter is atomically incremented. If it exceeds the limit, the server returns HTTP 429 (Too Many Requests) with a `Retry-After` header. The rate limit key includes the IP and the current minute, so the counter automatically resets each minute without cleanup.

The search endpoint gets a tighter limit because each search query involves an Elasticsearch query with text analysis, scoring, and aggregation -- significantly more expensive than a feed request that might be served from Redis cache. Without search rate limiting, a single client could degrade search performance for all users.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. In a news aggregator, this prevents duplicate articles when the crawler processes the same RSS feed entry twice.

This project achieves idempotency through database constraints: article insertion uses `ON CONFLICT (url) DO NOTHING`. If the crawler encounters the same article URL during a re-crawl (which happens every 15 minutes), the insert is silently skipped. Similarly, Elasticsearch indexing uses upsert by article UUID -- re-indexing the same article overwrites the existing document rather than creating a duplicate.

Reading history recording uses a composite unique constraint `(user_id, article_id)`. If a user opens the same article twice, only one reading history entry is created. These constraint-based approaches are simpler than explicit idempotency key management (as used in the notification system) because the operations are naturally idempotent -- there is no side effect beyond data storage.

### Health Checks

Health checks are HTTP endpoints that report whether a service is alive and ready to handle traffic. They are consumed by load balancers, container orchestrators (Kubernetes), and monitoring systems to make automated decisions about routing and restarts.

This project implements four health check tiers:
- **`/health`** (liveness): Returns 200 if the process is running. No dependency checks.
- **`/health/live`** (K8s liveness probe): Simple OK response. If this fails, the orchestrator restarts the container.
- **`/health/ready`** (readiness probe): Checks PostgreSQL and Redis connectivity. Elasticsearch failure is treated as "degraded" rather than "not ready" because search is a degradable feature -- feeds still work without it.
- **`/health/detailed`** (debugging): Returns all dependency statuses plus connection pool statistics and circuit breaker states for each RSS source. This endpoint is used for monitoring dashboards and incident investigation, not for automated routing.

The distinction between readiness and liveness is important: if PostgreSQL is temporarily unreachable, the service is alive (do not restart it) but not ready (do not route traffic to it). If Elasticsearch is down, the service is still ready because feeds work without search -- only the `/health/detailed` endpoint shows the degradation.

---

## Implementation Notes

This section maps the production architecture to the actual local implementation running on Docker + Node.js + Express.

### Local Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend (Vite)                        │
│                  localhost:5173                           │
│  Routes: / (feed), /search, /trending, /topics,          │
│          /story/:id, /settings, /admin, /login           │
└───────────────────────────┬──────────────────────────────┘
                            │ HTTP
                            ▼
┌──────────────────────────────────────────────────────────┐
│              API Server (Express)                         │
│           localhost:3001 / 3002 / 3003                    │
│                                                          │
│  /api/v1/feed, /stories, /search, /topics, /trending     │
│  /api/v1/user/login, /register, /preferences             │
│  /api/v1/admin/sources, /stats, /crawl                   │
│  /health, /health/live, /health/ready, /health/detailed  │
│  /metrics (Prometheus)                                   │
│                                                          │
│  Built-in: Crawler (node-cron every 15 min)              │
│            Index worker (BLPOP from Redis queue)          │
└─────┬──────────┬──────────┬──────────────────────────────┘
      │          │          │
      ▼          ▼          ▼
┌──────────┐ ┌──────────┐ ┌───────────────┐
│PostgreSQL│ │  Valkey   │ │ Elasticsearch │
│  :5432   │ │  :6379   │ │  :9200        │
│          │ │          │ │               │
│  newsagg │ │ Sessions │ │ Articles      │
│  newsagg │ │ Feeds    │ │ index         │
│  _dev    │ │ Queue    │ │               │
└──────────┘ └──────────┘ └───────────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | File | Description |
|---------|------|-------------|
| Structured logging | `backend/src/shared/logger.ts` | Pino JSON logging, request correlation, pretty-print in dev |
| Prometheus metrics | `backend/src/shared/metrics.ts` | HTTP latency histograms, crawl counters, cache hit/miss counters, queue depth gauge |
| Circuit breakers | `backend/src/shared/circuit-breaker.ts` | Per-source circuit breakers via Opossum, state exposed to `/health/detailed` |
| Retry with backoff | `backend/src/shared/retry.ts` | Exponential backoff with jitter for RSS fetches |
| Feed caching | `backend/src/shared/cache.ts` | Redis cache-aside with configurable TTL, cache stats for monitoring |
| Health checks | `backend/src/index.ts` | Four-tier: `/health`, `/health/live`, `/health/ready`, `/health/detailed` with pool stats + circuit state |
| SimHash dedup | `backend/src/utils/simhash.ts` | 64-bit fingerprinting, Hamming distance comparison |
| Topic extraction | `backend/src/utils/topics.ts` | Keyword-based topic classification |
| RSS parsing | `backend/src/utils/rss.ts` | RSS/Atom feed parsing via fast-xml-parser |
| Scheduled crawling | `backend/src/services/crawler.ts` | node-cron scheduling, parallel crawls with concurrency limit |
| Config management | `backend/src/shared/config.ts` | Centralized config with validation and environment variable support |
| Graceful shutdown | `backend/src/index.ts` | SIGTERM/SIGINT handlers, connection draining |

### Simplifications for Local Development

| Production Design | Local Substitute | Why |
|-------------------|------------------|-----|
| CDN + edge cache | Direct Vite dev server | No CDN needed locally |
| API Gateway + LB | Direct connection to Express on port 3001-3003 | No nginx needed |
| Crawler service cluster | In-process node-cron scheduler | Simpler, single process |
| Dedicated index workers | In-process BLPOP consumer | No separate worker process |
| PostgreSQL read replicas | Single PostgreSQL instance | Low query volume |
| Redis Cluster | Single Valkey instance | < 100 MB cache |
| Elasticsearch cluster | Single ES node (512 MB heap) | Sufficient for ~10K articles |
| Partitioned articles table | Single unpartitioned table | No partition management needed |
| ML-based topic extraction | Keyword matching | No model training/deployment |

### What Was Omitted

- CDN for static assets and feed caching
- Multi-region deployment
- Kubernetes orchestration
- OAuth/OIDC (uses session auth)
- ML-based topic extraction and semantic embeddings
- Breaking news detection via velocity thresholds
- Push notifications for breaking news
- Source credibility scoring with feedback loops
- A/B testing for ranking algorithm weights
- Collaborative filtering for recommendations
- Multi-language support
- GraphQL API
