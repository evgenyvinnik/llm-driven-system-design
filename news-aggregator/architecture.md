# News Aggregator - Architecture Design

## System Overview

A content aggregation and curation platform that crawls RSS/Atom feeds from multiple sources, deduplicates articles, clusters related stories, extracts topics, and delivers personalized news feeds to users.

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

- **Scalability**: Handle 100-1000 concurrent users in local dev; architecture supports horizontal scaling
- **Availability**: 99% uptime target (allows ~15 min downtime/day for local dev restarts)
- **Latency**: p95 < 200ms for feed retrieval, p95 < 500ms for search
- **Consistency**: Eventual consistency acceptable (1-2 second delay for new articles to appear)
- **Durability**: No data loss for user preferences and reading history

---

## Capacity Estimation

### Local Development Scale

| Metric | Value | Rationale |
|--------|-------|-----------|
| Daily Active Users (DAU) | 10-50 | Local testing with simulated load |
| Concurrent Users | 5-20 | Typical browser tabs during development |
| News Sources | 50-200 RSS feeds | Mix of major outlets and niche blogs |
| Articles/Day | 2,000-10,000 | ~50-100 articles per active source |
| Average Article Size | 5 KB (metadata + summary) | Title, URL, summary, timestamps, fingerprint |

### Request Volume

| Endpoint | RPS (Peak) | Rationale |
|----------|------------|-----------|
| GET /api/feed | 10 | Users refreshing feeds |
| GET /api/stories/:id | 5 | Opening individual stories |
| GET /api/search | 2 | Search queries |
| POST /api/preferences | 0.5 | Preference updates (rare) |
| **Total API RPS** | **20** | With 3x headroom = 60 RPS capacity |

### Storage Growth

| Component | Size/Day | 30-Day Total | Retention |
|-----------|----------|--------------|-----------|
| PostgreSQL (articles) | 50 MB | 1.5 GB | 90 days, then archive |
| PostgreSQL (users/prefs) | 1 MB | 30 MB | Indefinite |
| Elasticsearch (search index) | 30 MB | 900 MB | 90 days, then prune |
| Redis (sessions + cache) | 10 MB | 50 MB (steady state) | TTL-based eviction |

### Component Sizing (Local Development)

| Component | Memory | CPU | Justification |
|-----------|--------|-----|---------------|
| PostgreSQL | 512 MB | 0.5 core | 2GB data, modest query load |
| Redis | 128 MB | 0.25 core | Session store + feed cache |
| Elasticsearch | 1 GB | 1 core | Heap for indexing and search |
| API Server (3 instances) | 256 MB each | 0.5 core each | Node.js Express services |
| Crawler Service | 256 MB | 0.5 core | Concurrent feed fetching |
| **Total** | **~3 GB** | **~3 cores** | Fits comfortably on dev laptop |

---

## SLO Targets

### Latency SLOs

| Operation | p50 | p95 | p99 |
|-----------|-----|-----|-----|
| Feed retrieval (cached) | 20ms | 50ms | 100ms |
| Feed retrieval (uncached) | 100ms | 200ms | 500ms |
| Search query | 150ms | 500ms | 1000ms |
| Article detail | 30ms | 80ms | 150ms |
| User login | 100ms | 300ms | 500ms |

### Availability SLOs

| Component | Target | Error Budget (monthly) |
|-----------|--------|------------------------|
| API Server | 99% | ~7 hours downtime |
| Database | 99.5% | ~3.5 hours downtime |
| Search | 95% | ~36 hours downtime (degraded mode OK) |
| Crawler | 90% | Can miss crawls; articles will catch up |

### Throughput SLOs

| Operation | Target | Burst Capacity |
|-----------|--------|----------------|
| Feed API | 20 RPS sustained | 100 RPS for 30 seconds |
| Search API | 5 RPS sustained | 20 RPS for 30 seconds |
| Crawl rate | 10 feeds/minute | 50 feeds/minute (catch-up) |

---

## High-Level Architecture

```
                                    +------------------+
                                    |   Load Balancer  |
                                    |   (nginx/local)  |
                                    +--------+---------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+          +---------v---------+          +---------v---------+
    |   API Server 1    |          |   API Server 2    |          |   API Server 3    |
    |   (Port 3001)     |          |   (Port 3002)     |          |   (Port 3003)     |
    +---------+---------+          +---------+---------+          +---------+---------+
              |                              |                              |
              +------------------------------+------------------------------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+          +---------v---------+          +---------v---------+
    |    PostgreSQL     |          |      Redis        |          |   Elasticsearch   |
    |   (Primary DB)    |          |   (Cache/Queue)   |          |   (Search Index)  |
    +-------------------+          +-------------------+          +-------------------+

    +-------------------+
    |  Crawler Service  |---------> Fetches RSS feeds, publishes to Redis queue
    +-------------------+
```

### Request Flow: Fetching Personalized Feed

```
1. User requests GET /api/feed
2. API Server checks Redis cache for user:{id}:feed
3. If cache HIT (TTL < 60s):
   - Return cached feed immediately
4. If cache MISS:
   a. Query PostgreSQL for recent articles (last 24h)
   b. Query user preferences from PostgreSQL (or Redis cache)
   c. Apply ranking algorithm:
      - Relevance score (35%): topic match with user interests
      - Freshness score (25%): exponential decay, 6-hour half-life
      - Quality score (20%): source diversity, multi-source stories
      - Trending score (10%): velocity of new articles in story cluster
      - Breaking boost (+30%): if breaking_news flag set
   d. Return top 50 articles, store in Redis (TTL 60s)
5. Return JSON response
```

### Request Flow: Search Query

```
1. User submits GET /api/search?q=election&topic=politics
2. API Server builds Elasticsearch query:
   - Full-text match on title + summary
   - Filter by topic
   - Sort by relevance + recency boost
3. Elasticsearch returns document IDs + highlights
4. API Server hydrates results with PostgreSQL data (if needed)
5. Return JSON with highlighted snippets
```

### Request Flow: Crawl Cycle

```
1. Crawler Service runs every 5 minutes (cron or interval)
2. Fetch list of active sources from PostgreSQL
3. For each source (parallel, max 10 concurrent):
   a. Fetch RSS/Atom feed with timeout (10s)
   b. Parse feed, extract articles
   c. For each article:
      - Generate SimHash fingerprint (64-bit)
      - Check PostgreSQL for existing fingerprint (Hamming distance <= 3)
      - If duplicate: link to existing story cluster
      - If new: insert article, create/update story cluster
   d. Push article IDs to Redis queue for indexing
4. Index Worker (async):
   - Pop article IDs from Redis queue
   - Bulk index to Elasticsearch
   - Update story cluster aggregations
```

---

## Core Components

### 1. API Server (Node.js + Express)

**Responsibilities:**
- Serve REST API for frontend
- Session-based authentication
- Rate limiting (100 req/min per IP)
- Request validation and sanitization

**Key Routes:**
```
GET  /api/feed                 # Personalized feed
GET  /api/stories/:id          # Story detail with all sources
GET  /api/search               # Full-text search
GET  /api/topics               # List topics with article counts
POST /api/auth/login           # User login
POST /api/auth/register        # User registration
GET  /api/preferences          # User preferences
PUT  /api/preferences          # Update preferences
GET  /api/admin/sources        # List sources (admin)
POST /api/admin/sources        # Add source (admin)
GET  /api/admin/stats          # System stats (admin)
```

### 2. Crawler Service

**Responsibilities:**
- Scheduled feed fetching
- Rate limiting per domain (1 req/sec)
- Retry with exponential backoff
- Deduplication via SimHash

**Configuration:**
- Crawl interval: 5 minutes (configurable per source)
- Fetch timeout: 10 seconds
- Max retries: 3
- Backoff: 1s, 5s, 30s

### 3. PostgreSQL (Primary Data Store)

**Responsibilities:**
- Articles, sources, users, preferences
- Story clusters and relationships
- Transactional integrity for user operations

### 4. Redis (Cache + Queue)

**Responsibilities:**
- Session storage (TTL 24 hours)
- Feed cache (TTL 60 seconds)
- User preference cache (TTL 5 minutes)
- Index queue (list data structure)

### 5. Elasticsearch (Search Index)

**Responsibilities:**
- Full-text search on articles
- Aggregations for topic counts
- Relevance scoring

---

## Data Model

### PostgreSQL Schema

```sql
-- Users table
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    display_name    VARCHAR(100),
    role            VARCHAR(20) DEFAULT 'user', -- 'user' | 'admin'
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- User preferences
CREATE TABLE user_preferences (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    topics          JSONB DEFAULT '[]',           -- ["tech", "politics"]
    sources         JSONB DEFAULT '[]',           -- preferred source IDs
    excluded_sources JSONB DEFAULT '[]',          -- blocked source IDs
    reading_history JSONB DEFAULT '[]',           -- last 100 article IDs
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- News sources
CREATE TABLE sources (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    url             VARCHAR(2048) NOT NULL,       -- RSS/Atom feed URL
    homepage        VARCHAR(2048),                -- Source homepage
    category        VARCHAR(50),                  -- 'mainstream', 'tech', 'local'
    credibility_score FLOAT DEFAULT 0.5,          -- 0.0 to 1.0
    crawl_interval  INTEGER DEFAULT 300,          -- seconds between crawls
    last_crawled_at TIMESTAMPTZ,
    last_error      TEXT,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sources_active ON sources(is_active, last_crawled_at);

-- Story clusters (groups of related articles)
CREATE TABLE story_clusters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           VARCHAR(500),                 -- Representative title
    canonical_url   VARCHAR(2048),                -- Primary article URL
    fingerprint     BIGINT NOT NULL,              -- SimHash for matching
    article_count   INTEGER DEFAULT 1,
    first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_breaking     BOOLEAN DEFAULT false,
    velocity        FLOAT DEFAULT 0.0             -- articles per hour
);

CREATE INDEX idx_story_clusters_fingerprint ON story_clusters(fingerprint);
CREATE INDEX idx_story_clusters_recent ON story_clusters(last_updated_at DESC);

-- Individual articles
CREATE TABLE articles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID REFERENCES sources(id) ON DELETE CASCADE,
    story_cluster_id UUID REFERENCES story_clusters(id) ON DELETE SET NULL,
    external_id     VARCHAR(255),                 -- GUID from feed
    url             VARCHAR(2048) NOT NULL,
    title           VARCHAR(500) NOT NULL,
    summary         TEXT,
    author          VARCHAR(255),
    published_at    TIMESTAMPTZ,
    crawled_at      TIMESTAMPTZ DEFAULT NOW(),
    fingerprint     BIGINT NOT NULL,              -- SimHash of content
    topics          JSONB DEFAULT '[]',           -- extracted topics
    is_indexed      BOOLEAN DEFAULT false
);

CREATE INDEX idx_articles_source ON articles(source_id);
CREATE INDEX idx_articles_cluster ON articles(story_cluster_id);
CREATE INDEX idx_articles_fingerprint ON articles(fingerprint);
CREATE INDEX idx_articles_published ON articles(published_at DESC);
CREATE INDEX idx_articles_not_indexed ON articles(is_indexed) WHERE is_indexed = false;
CREATE UNIQUE INDEX idx_articles_source_external ON articles(source_id, external_id);

-- Topic definitions
CREATE TABLE topics (
    id              VARCHAR(50) PRIMARY KEY,      -- 'tech', 'politics', etc.
    display_name    VARCHAR(100) NOT NULL,
    keywords        JSONB NOT NULL,               -- matching keywords
    parent_topic    VARCHAR(50) REFERENCES topics(id),
    article_count   INTEGER DEFAULT 0
);
```

### Elasticsearch Mapping

```json
{
  "mappings": {
    "properties": {
      "article_id": { "type": "keyword" },
      "title": {
        "type": "text",
        "analyzer": "english",
        "fields": {
          "exact": { "type": "keyword" }
        }
      },
      "summary": {
        "type": "text",
        "analyzer": "english"
      },
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
| `index:queue` | List | None | Article IDs pending indexing |
| `rate:{ip}` | String (count) | 60s | Rate limiting counter |
| `crawl:lock:{sourceId}` | String | 5m | Distributed crawl lock |

---

## Technology Stack

| Layer | Technology | Version | Rationale |
|-------|------------|---------|-----------|
| **Frontend** | React 19 + TypeScript | 19.x | Modern hooks, Suspense support |
| **Routing** | Tanstack Router | 1.x | Type-safe routing, loaders |
| **State** | Zustand | 5.x | Simple, lightweight state management |
| **Styling** | Tailwind CSS | 4.x | Utility-first, rapid development |
| **Backend** | Node.js + Express | 22.x | Fast iteration, shared TS types |
| **ORM** | Raw SQL (pg) | - | Full control, learning opportunity |
| **Database** | PostgreSQL | 16.x | ACID, JSONB, mature ecosystem |
| **Cache** | Redis/Valkey | 7.x | Sessions, caching, simple queuing |
| **Search** | Elasticsearch | 8.x | Full-text search, aggregations |
| **Feed Parsing** | fast-xml-parser | 4.x | Fast, tolerant XML parsing |
| **Auth** | express-session | 1.x | Simple session-based auth |

---

## Caching Strategy

### Cache Layers

```
Request → API Server → Redis Cache → PostgreSQL/Elasticsearch
                ↓ (miss)
         Compute result
                ↓
         Store in Redis
                ↓
         Return response
```

### Cache-Aside Pattern

All caching uses cache-aside (lazy loading):
1. Check cache first
2. On miss, fetch from source
3. Store result in cache with TTL
4. Return result

### TTL Configuration

| Cache Type | TTL | Invalidation Strategy |
|------------|-----|----------------------|
| User session | 24 hours | Explicit logout or expiry |
| Personalized feed | 60 seconds | TTL expiry only |
| Global trending | 30 seconds | TTL expiry only |
| User preferences | 5 minutes | Invalidate on PUT /preferences |
| Source list | 10 minutes | Invalidate on admin changes |

### Cache Invalidation

Explicit invalidation used sparingly:
- User preferences: `DEL user:{id}:prefs` on update
- Source changes: `DEL sources:list` on admin update
- No invalidation for feeds (short TTL is sufficient)

---

## Message Queue (Redis Lists)

### Queue: Article Indexing

```
Producer: Crawler Service
Consumer: Index Worker
Pattern: RPUSH / BLPOP
```

```javascript
// Producer (Crawler)
await redis.rpush('index:queue', JSON.stringify({
  articleId: 'uuid',
  action: 'index',
  timestamp: Date.now()
}));

// Consumer (Index Worker)
while (true) {
  const [, message] = await redis.blpop('index:queue', 0);
  const { articleId, action } = JSON.parse(message);
  await indexArticle(articleId);
}
```

### Delivery Semantics

- **At-least-once delivery**: If worker crashes, message may be reprocessed
- **Idempotency**: Elasticsearch upsert by article_id ensures safe replay
- **Backpressure**: BLPOP blocks when queue is empty (no polling)

### Queue Monitoring

Track queue depth with:
```javascript
const queueLength = await redis.llen('index:queue');
// Alert if > 1000 for local dev (indicates consumer failure)
```

---

## Security

### Authentication

**Session-based authentication with Redis store:**

```javascript
// Session configuration
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax'
  }
}));
```

**Password hashing:**
```javascript
// bcrypt with cost factor 12
const hash = await bcrypt.hash(password, 12);
const valid = await bcrypt.compare(password, hash);
```

### Authorization (RBAC)

| Role | Permissions |
|------|-------------|
| `user` | Read feeds, update own preferences, search |
| `admin` | All user permissions + manage sources, view stats |

**Middleware implementation:**
```javascript
const requireAuth = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

const requireAdmin = async (req, res, next) => {
  const user = await getUserById(req.session.userId);
  if (user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
```

### Rate Limiting

```javascript
const rateLimit = require('express-rate-limit');

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests' });
  }
});

// Stricter limit for search (expensive operation)
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20 // 20 searches per minute
});
```

### Input Validation

```javascript
// Using express-validator
const { body, query, validationResult } = require('express-validator');

const validateSearch = [
  query('q').trim().isLength({ min: 1, max: 200 }).escape(),
  query('topic').optional().isAlphanumeric(),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
  }
];
```

### SQL Injection Prevention

All queries use parameterized statements:
```javascript
// Safe
const result = await pool.query(
  'SELECT * FROM articles WHERE source_id = $1 AND published_at > $2',
  [sourceId, since]
);

// Never do this
const result = await pool.query(
  `SELECT * FROM articles WHERE source_id = '${sourceId}'` // UNSAFE
);
```

---

## Observability

### Metrics (Prometheus Format)

**Application metrics exported at `/metrics`:**

```javascript
// Request latency histogram
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
});

// Active connections gauge
const activeConnections = new Gauge({
  name: 'api_active_connections',
  help: 'Number of active connections'
});

// Crawl success/failure counter
const crawlTotal = new Counter({
  name: 'crawler_fetch_total',
  help: 'Total feed fetches',
  labelNames: ['status'] // 'success', 'error', 'timeout'
});

// Queue depth gauge
const indexQueueDepth = new Gauge({
  name: 'index_queue_depth',
  help: 'Number of articles pending indexing'
});

// Cache hit rate
const cacheHits = new Counter({
  name: 'cache_hits_total',
  help: 'Cache hits',
  labelNames: ['cache_type']
});

const cacheMisses = new Counter({
  name: 'cache_misses_total',
  help: 'Cache misses',
  labelNames: ['cache_type']
});
```

### Key Metrics Dashboard

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| API p95 latency | > 300ms | > 1s | Check DB queries, cache hit rate |
| Error rate | > 1% | > 5% | Check logs, investigate errors |
| Cache hit rate | < 70% | < 50% | Review cache TTLs, warm cache |
| Index queue depth | > 500 | > 2000 | Scale index workers |
| Crawl failure rate | > 10% | > 30% | Check network, source health |
| DB connection pool | > 80% | > 95% | Increase pool size or optimize queries |

### Structured Logging

```javascript
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  }
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      user_id: req.session?.userId
    });
  });
  next();
});

// Error logging
app.use((err, req, res, next) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path
  });
  res.status(500).json({ error: 'Internal server error' });
});
```

### Distributed Tracing

For local development, simple request ID propagation:

```javascript
const { v4: uuidv4 } = require('uuid');

// Generate trace ID for each request
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  res.setHeader('x-trace-id', req.traceId);
  next();
});

// Include trace ID in all logs
logger.child({ traceId: req.traceId }).info('Processing request');
```

### Health Checks

```javascript
// Liveness probe (am I running?)
app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness probe (am I ready to serve traffic?)
app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not ready', error: err.message });
  }
});
```

---

## Failure Handling

### Retry Strategy

**Exponential backoff with jitter:**

```javascript
async function fetchWithRetry(url, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, { timeout: 10000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;

      // Exponential backoff: 1s, 5s, 30s + jitter
      const baseDelay = [1000, 5000, 30000][attempt];
      const jitter = Math.random() * 1000;
      await sleep(baseDelay + jitter);

      logger.warn({ url, attempt, error: err.message }, 'Retry fetch');
    }
  }
}
```

### Idempotency

**Article ingestion is idempotent:**
```javascript
// Upsert by source_id + external_id
await pool.query(`
  INSERT INTO articles (source_id, external_id, url, title, fingerprint)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (source_id, external_id)
  DO UPDATE SET title = EXCLUDED.title, updated_at = NOW()
`, [sourceId, externalId, url, title, fingerprint]);
```

**Elasticsearch indexing is idempotent:**
```javascript
// Upsert by document ID
await esClient.index({
  index: 'articles',
  id: articleId, // Use article UUID as doc ID
  body: articleDoc
});
```

### Circuit Breaker

```javascript
const CircuitBreaker = require('opossum');

const esCircuitBreaker = new CircuitBreaker(searchElasticsearch, {
  timeout: 5000,        // Trip if request takes > 5s
  errorThresholdPercentage: 50, // Trip if 50% of requests fail
  resetTimeout: 30000   // Try again after 30s
});

esCircuitBreaker.fallback(() => ({
  hits: [],
  total: 0,
  message: 'Search temporarily unavailable'
}));

esCircuitBreaker.on('open', () => {
  logger.warn('Elasticsearch circuit breaker opened');
});
```

### Graceful Degradation

| Component Failure | Degraded Behavior |
|-------------------|-------------------|
| Redis unavailable | Sessions fail (require re-login), feeds uncached but functional |
| Elasticsearch unavailable | Search returns empty with error message, feeds still work |
| PostgreSQL unavailable | Full outage (primary data store) |
| Crawler fails | Stale articles served, retry on next cycle |

### Database Connection Handling

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,              // Max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  logger.error({ error: err.message }, 'Unexpected pool error');
});

// Wrapper with timeout
async function queryWithTimeout(sql, params, timeoutMs = 5000) {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${timeoutMs}`);
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}
```

### Disaster Recovery (Local Development)

**Backup strategy:**
```bash
# Daily PostgreSQL backup (cron job)
pg_dump -h localhost -U postgres news_aggregator > backup_$(date +%Y%m%d).sql

# Restore from backup
psql -h localhost -U postgres news_aggregator < backup_20240115.sql
```

**Elasticsearch reindexing:**
```javascript
// If ES index corrupted, rebuild from PostgreSQL
async function reindexAllArticles() {
  const batchSize = 1000;
  let offset = 0;

  while (true) {
    const { rows } = await pool.query(
      'SELECT * FROM articles ORDER BY id LIMIT $1 OFFSET $2',
      [batchSize, offset]
    );

    if (rows.length === 0) break;

    const operations = rows.flatMap(article => [
      { index: { _index: 'articles', _id: article.id } },
      articleToEsDoc(article)
    ]);

    await esClient.bulk({ operations });
    offset += batchSize;
    logger.info({ indexed: offset }, 'Reindexing progress');
  }
}
```

---

## Cost Tradeoffs

### Local Development Resource Usage

| Choice | Memory Cost | Alternative | Tradeoff |
|--------|-------------|-------------|----------|
| Elasticsearch for search | 1 GB | PostgreSQL full-text search | ES: better relevance, more memory |
| Redis for sessions | 128 MB | PostgreSQL sessions | Redis: faster, more memory |
| 3 API instances | 768 MB | Single instance | Multi: realistic testing, more memory |

### Storage vs Compute Tradeoffs

| Decision | Storage | Compute | Chosen |
|----------|---------|---------|--------|
| Store full article text | +500 MB/month | - | No, store summary only |
| Cache precomputed feeds | +10 MB Redis | Save 50% queries | Yes |
| Store article fingerprints | +8 bytes/article | Skip SimHash on read | Yes |

### When to Scale (Future)

| Trigger | Current | Scaling Action |
|---------|---------|----------------|
| API latency p95 > 500ms | Single region | Add Redis cache, optimize queries |
| 1000+ concurrent users | 3 API instances | Add load balancer, more instances |
| 100K+ articles | Single PostgreSQL | Consider read replicas |
| Search latency > 2s | Single ES node | Add ES node, increase heap |

---

## Scalability Considerations

### Horizontal Scaling Path

1. **API Servers**: Stateless, scale behind load balancer
2. **Crawler**: Partition sources by hash, run multiple crawlers
3. **PostgreSQL**: Read replicas for query scaling
4. **Redis**: Redis Cluster for cache scaling
5. **Elasticsearch**: Add nodes, increase shard count

### Database Scaling

```sql
-- Partition articles by month (future optimization)
CREATE TABLE articles (
    ...
) PARTITION BY RANGE (published_at);

CREATE TABLE articles_2024_01 PARTITION OF articles
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
```

### Cache Scaling

- Feed cache can be sharded by user_id hash
- Use consistent hashing for cache distribution
- Consider Redis Cluster for > 1GB cache size

---

## Future Optimizations

### Near-Term (Next Sprint)
- [ ] Add breaking news detection (velocity-based)
- [ ] Implement source credibility scoring
- [ ] Add user reading history for better personalization
- [ ] WebSocket support for real-time feed updates

### Medium-Term
- [ ] ML-based topic extraction (replace keyword matching)
- [ ] Semantic embeddings for better deduplication
- [ ] A/B testing framework for ranking algorithm
- [ ] Multi-language support

### Long-Term
- [ ] GraphQL API alongside REST
- [ ] Push notifications for breaking news
- [ ] Collaborative filtering for recommendations
- [ ] Source bias detection

---

## Trade-offs and Alternatives

### SimHash vs Semantic Embeddings

**Chosen: SimHash (64-bit fingerprint)**

| Aspect | SimHash | Semantic Embeddings |
|--------|---------|---------------------|
| Accuracy | Good for near-duplicates | Better for paraphrases |
| Speed | O(1) comparison | O(n) for nearest neighbor |
| Memory | 8 bytes per article | 512-1536 bytes per article |
| Dependencies | None | Requires ML model |

**Rationale**: SimHash is sufficient for learning project; semantic embeddings can be added later for borderline cases.

### PostgreSQL vs Document DB

**Chosen: PostgreSQL with JSONB**

| Aspect | PostgreSQL | MongoDB/CouchDB |
|--------|------------|-----------------|
| Schema flexibility | JSONB for dynamic fields | Native document model |
| Transactions | Full ACID | Limited |
| Joins | Native | Application-level |
| Learning value | SQL skills, broader applicability | Document query syntax |

**Rationale**: PostgreSQL JSONB provides sufficient flexibility while teaching SQL fundamentals.

### Redis vs Dedicated Queue

**Chosen: Redis Lists for queuing**

| Aspect | Redis Lists | RabbitMQ |
|--------|-------------|----------|
| Setup complexity | Already running | Additional service |
| Durability | Optional (AOF) | Built-in |
| Features | Basic FIFO | Routing, acks, DLQ |
| Resource usage | Minimal | 256 MB+ |

**Rationale**: Redis Lists sufficient for simple indexing queue; RabbitMQ overkill for local dev.
