# Yelp - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"I'll be designing a local business review and discovery platform like Yelp. As a backend engineer, I'll focus on the geo-spatial search infrastructure, rating aggregation systems, caching architecture, and async indexing pipelines. Let me start by clarifying what we need to build."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **Business Search**
   - Full-text search by name, category, keywords
   - Geo-spatial filtering by radius from user location
   - Filter by rating, price level, distance, open hours
   - Sort by relevance, rating, distance, or review count

2. **Review System**
   - Users create reviews with 1-5 star ratings and text
   - One review per user per business (unique constraint)
   - Review photo uploads with S3-compatible storage
   - Helpful/not helpful voting on reviews

3. **Rating Aggregation**
   - Real-time average rating calculation per business
   - Review count tracking for relevance scoring
   - Bayesian rating for fair comparison across businesses

4. **Business Profiles**
   - CRUD operations for business data
   - Business hours, address, phone, categories, amenities
   - Business owner claiming and verification

### Non-Functional Requirements

- **Latency**: p50 < 100ms, p95 < 300ms, p99 < 500ms for search queries
- **Availability**: 99.9% uptime (43 minutes downtime/month)
- **Consistency**: Strong consistency for reviews; eventual consistency for search index (< 5s lag)
- **Scale**: 200M businesses, 500M reviews, 10K peak RPS

---

## 2. Scale Estimation (2-3 minutes)

**Data Volume**
- 200 million businesses x 2KB = 400 GB
- 500 million reviews x 2.5KB = 1.25 TB
- 1 billion photos x 500KB avg = 500 TB
- Elasticsearch index: ~100 GB

**Request Patterns**
- Search queries: 10,000/second at peak
- Business page views: 50,000/second
- Review submissions: 100/second
- Read-to-write ratio: 1000:1

**Storage Breakdown**

| Data Type | Size per Record | Total | Growth Rate |
|-----------|-----------------|-------|-------------|
| Business records | 2KB | 400GB | 1GB/month |
| Review records | 2.5KB | 1.25TB | 50GB/month |
| Review photos | 500KB | 500TB | 10TB/month |
| Search index | 500B/doc | 100GB | Mirrors DB |

---

## 3. High-Level Architecture (8-10 minutes)

```
                                    +-----------------+
                                    |      CDN        |
                                    | (Photos, Static)|
                                    +--------+--------+
                                             |
                                    +--------v--------+
                                    |  Load Balancer  |
                                    |  (nginx:3000)   |
                                    +--------+--------+
                                             |
              +------------------------------+------------------------------+
              |                              |                              |
    +---------v---------+          +---------v---------+          +---------v---------+
    |   API Server 1    |          |   API Server 2    |          |   API Server 3    |
    |   (port 3001)     |          |   (port 3002)     |          |   (port 3003)     |
    +---+-------+-------+          +---+-------+-------+          +---+-------+-------+
        |       |                      |       |                      |       |
        |       +----------------------+-------+----------------------+       |
        |                              |                                      |
        v                              v                                      v
+-------+-------+              +-------+-------+                      +-------+-------+
|   PostgreSQL  |              |     Redis     |                      | Elasticsearch |
|   + PostGIS   |              |   (Valkey)    |                      |               |
|  (port 5432)  |              |  (port 6379)  |                      |  (port 9200)  |
+-------+-------+              +---------------+                      +-------+-------+
        |                                                                     ^
        |                      +---------------+                              |
        +--------------------->|   RabbitMQ    |------------------------------+
                               |  (port 5672)  |
                               +-------+-------+
                                       |
                               +-------v-------+
                               | Index Worker  |
                               +-------+-------+
                                       |
                               +-------v-------+
                               |    MinIO      |
                               | (port 9000)   |
                               +---------------+
```

### Core Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| API Gateway | Load balancing, rate limiting, SSL termination | nginx |
| API Server | Business logic, REST endpoints | Node.js + Express |
| Primary Database | Users, businesses, reviews (source of truth) | PostgreSQL 16 + PostGIS |
| Search Engine | Full-text search, geo queries, aggregations | Elasticsearch 8.x |
| Cache | Sessions, query results, hot business data | Redis/Valkey |
| Message Queue | Async indexing, notifications | RabbitMQ |
| Object Storage | Review photos, business images | MinIO (S3-compatible) |

---

## 4. Deep Dive: Geo-Spatial Search Architecture (8-10 minutes)

### PostgreSQL + PostGIS Schema

```sql
-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Businesses table with PostGIS geometry
CREATE TABLE businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    address VARCHAR(500) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(50) NOT NULL,
    zip_code VARCHAR(20) NOT NULL,
    phone VARCHAR(20),
    website VARCHAR(500),
    location GEOGRAPHY(POINT, 4326) NOT NULL,  -- SRID 4326 = WGS84
    categories TEXT[] DEFAULT '{}',
    hours JSONB DEFAULT '{}',
    amenities TEXT[] DEFAULT '{}',
    rating_sum INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial index for geo queries (critical for performance)
CREATE INDEX idx_businesses_location ON businesses USING GIST(location);
CREATE INDEX idx_businesses_city ON businesses(city);
CREATE INDEX idx_businesses_categories ON businesses USING GIN(categories);
CREATE INDEX idx_businesses_rating ON businesses((rating_sum::float / NULLIF(review_count, 0)));
```

### PostGIS Geo-Queries

```sql
-- Find businesses within 5km radius (using Geography type for accuracy)
SELECT
    id,
    name,
    ST_Distance(location, ST_Point(-122.4, 37.7)::geography) as distance_meters
FROM businesses
WHERE ST_DWithin(
    location,
    ST_Point(-122.4, 37.7)::geography,
    5000  -- 5km in meters
)
ORDER BY distance_meters
LIMIT 20;

-- More complex query with category filter
SELECT
    id,
    name,
    rating_sum::float / NULLIF(review_count, 0) as avg_rating,
    ST_Distance(location, ST_Point($1, $2)::geography) as distance
FROM businesses
WHERE ST_DWithin(location, ST_Point($1, $2)::geography, $3)
  AND $4 = ANY(categories)
  AND is_active = true
ORDER BY avg_rating DESC, distance ASC
LIMIT 20;
```

### Elasticsearch Index Mapping

```json
{
  "mappings": {
    "properties": {
      "id": { "type": "keyword" },
      "name": {
        "type": "text",
        "analyzer": "standard",
        "fields": {
          "keyword": { "type": "keyword" },
          "autocomplete": {
            "type": "text",
            "analyzer": "autocomplete"
          }
        }
      },
      "description": { "type": "text" },
      "city": { "type": "keyword" },
      "state": { "type": "keyword" },
      "location": { "type": "geo_point" },
      "categories": { "type": "keyword" },
      "amenities": { "type": "keyword" },
      "average_rating": { "type": "float" },
      "review_count": { "type": "integer" },
      "is_active": { "type": "boolean" }
    }
  },
  "settings": {
    "analysis": {
      "analyzer": {
        "autocomplete": {
          "type": "custom",
          "tokenizer": "autocomplete",
          "filter": ["lowercase"]
        }
      },
      "tokenizer": {
        "autocomplete": {
          "type": "edge_ngram",
          "min_gram": 2,
          "max_gram": 20,
          "token_chars": ["letter", "digit"]
        }
      }
    }
  }
}
```

### Elasticsearch Geo-Distance Query

```typescript
async function searchBusinesses(
  query: string,
  lat: number,
  lon: number,
  radiusKm: number,
  filters: SearchFilters
): Promise<SearchResult[]> {
  const esQuery = {
    query: {
      bool: {
        must: query ? [{ match: { name: query } }] : [{ match_all: {} }],
        filter: [
          {
            geo_distance: {
              distance: `${radiusKm}km`,
              location: { lat, lon }
            }
          },
          { term: { is_active: true } }
        ]
      }
    },
    sort: [
      { _score: 'desc' },
      {
        _geo_distance: {
          location: { lat, lon },
          order: 'asc',
          unit: 'km'
        }
      }
    ],
    size: 20
  };

  // Add category filter if specified
  if (filters.category) {
    esQuery.query.bool.filter.push({ term: { categories: filters.category } });
  }

  // Add rating filter if specified
  if (filters.minRating) {
    esQuery.query.bool.filter.push({
      range: { average_rating: { gte: filters.minRating } }
    });
  }

  const result = await esClient.search({
    index: 'businesses',
    body: esQuery
  });

  return result.hits.hits.map((hit) => ({
    ...hit._source,
    distance_km: hit.sort?.[1] || 0
  }));
}
```

### Why Dual-Layer Geo-Spatial Architecture?

| Layer | Responsibility | Strengths |
|-------|---------------|-----------|
| PostgreSQL + PostGIS | Source of truth, ACID transactions | Accurate spherical calculations, complex joins |
| Elasticsearch | Search and filtering | Fast full-text search, faceted queries, built-in geo_distance |

**Trade-off**: Maintaining two geo indexes adds sync complexity but provides better search performance with richer query capabilities.

---

## 5. Deep Dive: Rating Aggregation System (6-7 minutes)

### Database Trigger for Incremental Updates

```sql
-- Reviews table with unique constraint
CREATE TABLE reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title VARCHAR(200),
    content TEXT NOT NULL,
    photo_urls TEXT[] DEFAULT '{}',
    helpful_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, business_id)  -- One review per user per business
);

-- Trigger function for rating aggregation
CREATE OR REPLACE FUNCTION update_business_rating()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE businesses
        SET rating_sum = rating_sum + NEW.rating,
            review_count = review_count + 1,
            updated_at = NOW()
        WHERE id = NEW.business_id;
    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE businesses
        SET rating_sum = rating_sum - OLD.rating + NEW.rating,
            updated_at = NOW()
        WHERE id = NEW.business_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE businesses
        SET rating_sum = rating_sum - OLD.rating,
            review_count = review_count - 1,
            updated_at = NOW()
        WHERE id = OLD.business_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_business_rating
AFTER INSERT OR UPDATE OF rating OR DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION update_business_rating();
```

### Why Triggers Over Materialized Views?

| Approach | Pros | Cons |
|----------|------|------|
| Database Triggers | Real-time updates, atomic with transaction | Slightly slower writes |
| Materialized Views | Bulk refresh efficiency | Stale data between refreshes |
| Application-level | Flexible business logic | Not atomic, prone to inconsistency |

**Decision**: Triggers provide real-time accuracy with transactional guarantees - critical for a reviews platform where ratings must be immediately accurate.

### Bayesian Rating for Fair Ranking

```typescript
function calculateBayesianRating(
  businessRating: number,
  businessReviewCount: number
): number {
  const C = 3.5;  // Prior mean (platform-wide average)
  const m = 10;   // Minimum reviews for full weight

  // Bayesian average formula
  return (businessReviewCount * businessRating + m * C) / (businessReviewCount + m);
}

// Examples:
// Business with 1 review of 5 stars: (1 * 5 + 10 * 3.5) / 11 = 3.64
// Business with 100 reviews of 5 stars: (100 * 5 + 10 * 3.5) / 110 = 4.86
// Business with 10 reviews of 4.5 stars: (10 * 4.5 + 10 * 3.5) / 20 = 4.0
```

This prevents new businesses with one 5-star review from outranking established businesses with many 4.5-star reviews.

---

## 6. Deep Dive: Async Indexing Pipeline (5-6 minutes)

### RabbitMQ Queue Architecture

```
                    +------------------+
                    |   API Server     |
                    +--------+---------+
                             |
                             v (publish)
                    +------------------+
                    |    RabbitMQ      |
                    |                  |
                    | +--------------+ |
                    | | index.update | |  <-- durable queue
                    | +--------------+ |
                    +--------+---------+
                             |
                             v (consume)
                    +------------------+
                    |  Index Worker    |
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Elasticsearch   |
                    +------------------+
```

### Event Publishing on Business/Review Changes

```typescript
// Publish index update event after database write
async function createReview(
  userId: string,
  businessId: string,
  reviewData: CreateReviewDTO
): Promise<Review> {
  // 1. Check unique constraint
  const existing = await db.query(
    'SELECT id FROM reviews WHERE user_id = $1 AND business_id = $2',
    [userId, businessId]
  );
  if (existing.rows.length > 0) {
    throw new ConflictError('You have already reviewed this business');
  }

  // 2. Insert review (trigger updates business rating_sum/review_count)
  const result = await db.query(
    `INSERT INTO reviews (user_id, business_id, rating, title, content)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, businessId, reviewData.rating, reviewData.title, reviewData.content]
  );

  const review = result.rows[0];

  // 3. Publish async event for Elasticsearch indexing
  await rabbitMQ.publish('index.update', {
    type: 'business',
    action: 'update',
    businessId,
    timestamp: new Date().toISOString()
  });

  // 4. Invalidate cache
  await redis.del(`business:${businessId}`);

  return review;
}
```

### Index Worker Consumer

```typescript
async function processIndexUpdate(message: IndexUpdateMessage): Promise<void> {
  const { type, action, businessId } = message;

  try {
    if (type === 'business') {
      // Fetch fresh data from PostgreSQL (source of truth)
      const business = await db.query(
        `SELECT
          id, name, description, city, state,
          ST_X(location::geometry) as lon,
          ST_Y(location::geometry) as lat,
          categories, amenities,
          rating_sum::float / NULLIF(review_count, 0) as average_rating,
          review_count, is_active
         FROM businesses WHERE id = $1`,
        [businessId]
      );

      if (action === 'delete' || !business.rows[0].is_active) {
        await esClient.delete({ index: 'businesses', id: businessId });
      } else {
        const doc = business.rows[0];
        await esClient.index({
          index: 'businesses',
          id: businessId,
          body: {
            ...doc,
            location: { lat: doc.lat, lon: doc.lon }
          }
        });
      }
    }

    // Acknowledge message
    message.ack();
  } catch (error) {
    // Retry with exponential backoff, then DLQ
    if (message.retryCount < 3) {
      message.nack(true);  // Requeue
    } else {
      message.nack(false); // Send to DLQ
    }
  }
}
```

### Dead Letter Queue (DLQ) Configuration

```typescript
// RabbitMQ queue setup with DLQ
await channel.assertQueue('index.update', {
  durable: true,
  arguments: {
    'x-dead-letter-exchange': 'dlx',
    'x-dead-letter-routing-key': 'dlq.index.update'
  }
});

await channel.assertQueue('dlq.index.update', { durable: true });
```

---

## 7. Deep Dive: Caching Architecture (5-6 minutes)

### Redis Cache Strategy

```
# Session storage
session:{sessionId}              -> { userId, role, expiresAt }  TTL: 24 hours

# Search result cache (keyed by query hash)
search:{sha256(query+filters)}   -> [businessIds...]             TTL: 2 minutes

# Business detail cache
business:{businessId}            -> { ...businessData }          TTL: 5 minutes

# Rate limiting counters
ratelimit:{userId}:{endpoint}    -> count                        TTL: 1 minute
ratelimit:ip:{ipAddress}         -> count                        TTL: 1 minute

# Autocomplete suggestions
autocomplete:{prefix}            -> [suggestions...]             TTL: 5 minutes
```

### Cache-Aside Pattern Implementation

```typescript
async function getBusinessById(id: string): Promise<Business | null> {
  const cacheKey = `business:${id}`;

  // 1. Check cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    metrics.cacheHits.inc({ type: 'business' });
    return JSON.parse(cached);
  }

  metrics.cacheMisses.inc({ type: 'business' });

  // 2. Query database
  const result = await db.query(
    `SELECT b.*,
            rating_sum::float / NULLIF(review_count, 0) as average_rating,
            ST_X(location::geometry) as lon,
            ST_Y(location::geometry) as lat
     FROM businesses b WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const business = result.rows[0];

  // 3. Cache result
  await redis.setex(cacheKey, 300, JSON.stringify(business)); // 5 min TTL

  return business;
}
```

### Cache Invalidation Strategy

```typescript
// Invalidate on business update
async function updateBusiness(id: string, updates: Partial<Business>): Promise<void> {
  // 1. Update database
  await db.query(
    'UPDATE businesses SET name = $1, description = $2 WHERE id = $3',
    [updates.name, updates.description, id]
  );

  // 2. Delete cache (next read will repopulate)
  await redis.del(`business:${id}`);

  // 3. Publish index update event
  await rabbitMQ.publish('index.update', { type: 'business', action: 'update', businessId: id });
}

// Invalidate search cache on any business change
async function invalidateSearchCache(): Promise<void> {
  // Use SCAN to find and delete search cache keys (pattern: search:*)
  const keys = await redis.keys('search:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
```

### Cache Hit Rate Targets

| Cache Type | Target Hit Rate | Justification |
|------------|-----------------|---------------|
| Session | > 99% | Almost all reads from cache |
| Search results | > 60% | Repeating queries within TTL window |
| Business details | > 70% | Popular businesses frequently accessed |

---

## 8. Deep Dive: Circuit Breaker Pattern (4-5 minutes)

### Opossum Circuit Breaker for Elasticsearch

```typescript
import CircuitBreaker from 'opossum';

// Circuit breaker configuration
const esCircuitBreaker = new CircuitBreaker(
  async (query: object) => esClient.search(query),
  {
    timeout: 3000,           // 3 second timeout
    errorThresholdPercentage: 50,  // Open circuit at 50% failure rate
    resetTimeout: 30000,     // Try again after 30 seconds
    volumeThreshold: 10      // Minimum requests before tripping
  }
);

// Fallback to PostgreSQL full-text search
esCircuitBreaker.fallback(async (query: object) => {
  logger.warn('Elasticsearch circuit open, falling back to PostgreSQL');
  return postgresFullTextSearch(query);
});

// Metrics
esCircuitBreaker.on('success', () => metrics.esRequestsTotal.inc({ status: 'success' }));
esCircuitBreaker.on('failure', () => metrics.esRequestsTotal.inc({ status: 'failure' }));
esCircuitBreaker.on('open', () => metrics.circuitBreakerState.set({ name: 'elasticsearch' }, 1));
esCircuitBreaker.on('close', () => metrics.circuitBreakerState.set({ name: 'elasticsearch' }, 0));

// Usage in search service
async function searchBusinesses(query: SearchQuery): Promise<SearchResult[]> {
  return esCircuitBreaker.fire(buildEsQuery(query));
}
```

### PostgreSQL Fallback Implementation

```typescript
async function postgresFullTextSearch(query: SearchQuery): Promise<SearchResult[]> {
  const result = await db.query(
    `SELECT id, name, description,
            rating_sum::float / NULLIF(review_count, 0) as average_rating,
            ST_Distance(location, ST_Point($1, $2)::geography) as distance
     FROM businesses
     WHERE to_tsvector('english', name || ' ' || COALESCE(description, ''))
           @@ plainto_tsquery('english', $3)
       AND ST_DWithin(location, ST_Point($1, $2)::geography, $4)
       AND is_active = true
     ORDER BY ts_rank(to_tsvector('english', name), plainto_tsquery('english', $3)) DESC
     LIMIT 20`,
    [query.lon, query.lat, query.text, query.radiusMeters]
  );

  return result.rows;
}
```

### Circuit Breaker States

```
CLOSED (normal) -> OPEN (after 50% failure rate with 10+ requests)
OPEN (failing fast) -> HALF_OPEN (after 30 second timeout)
HALF_OPEN (testing) -> CLOSED (if test requests succeed)
HALF_OPEN (testing) -> OPEN (if test requests fail)
```

---

## 9. Rate Limiting Implementation (3-4 minutes)

### Multi-Layer Rate Limiting

```typescript
// Rate limit configuration
const rateLimits = {
  'POST /auth/login': { limit: 5, window: 60, key: 'ip' },
  'POST /auth/register': { limit: 3, window: 3600, key: 'ip' },
  'POST /reviews': { limit: 10, window: 3600, key: 'user' },
  'GET /search': { limit: 100, window: 60, key: 'user_or_ip' }
};

// Redis sliding window implementation
async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;

  // Lua script for atomic sliding window
  const script = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window_start = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local ttl = tonumber(ARGV[4])

    -- Remove expired entries
    redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

    -- Count current requests
    local count = redis.call('ZCARD', key)

    if count < limit then
      -- Add current request
      redis.call('ZADD', key, now, now .. ':' .. math.random())
      redis.call('EXPIRE', key, ttl)
      return {1, limit - count - 1}
    else
      return {0, 0}
    end
  `;

  const result = await redis.eval(script, 1, key, now, windowStart, limit, windowSeconds);

  return {
    allowed: result[0] === 1,
    remaining: result[1],
    resetAt: Math.floor(now / 1000) + windowSeconds
  };
}
```

### Rate Limit Middleware

```typescript
function rateLimitMiddleware(config: RateLimitConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = config.key === 'ip'
      ? `ratelimit:ip:${req.ip}`
      : `ratelimit:user:${req.user?.id}:${req.path}`;

    const result = await checkRateLimit(key, config.limit, config.window);

    res.set({
      'X-RateLimit-Limit': config.limit,
      'X-RateLimit-Remaining': result.remaining,
      'X-RateLimit-Reset': result.resetAt
    });

    if (!result.allowed) {
      res.set('Retry-After', config.window);
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    next();
  };
}
```

---

## 10. Idempotency for Review Submission (3-4 minutes)

### Idempotency Key Implementation

```typescript
// Idempotency middleware
async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const idempotencyKey = req.headers['idempotency-key'] as string;

  if (!idempotencyKey) {
    return next();
  }

  const cacheKey = `idempotency:${idempotencyKey}`;

  // Check for existing response
  const cached = await redis.get(cacheKey);
  if (cached) {
    const { status, body } = JSON.parse(cached);
    return res.status(status).json(body);
  }

  // Acquire lock to prevent concurrent processing
  const lockKey = `lock:${cacheKey}`;
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', 30);

  if (!acquired) {
    // Another request is processing - wait and return cached result
    await sleep(100);
    return idempotencyMiddleware(req, res, next);
  }

  // Store original res.json to intercept response
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    // Cache the response
    redis.setex(cacheKey, 86400, JSON.stringify({
      status: res.statusCode,
      body
    }));
    redis.del(lockKey);
    return originalJson(body);
  };

  next();
}
```

### Why Idempotency Matters for Reviews

1. **Network unreliability**: Mobile users on unstable connections will retry failed requests
2. **Database constraint is insufficient**: `UNIQUE(user_id, business_id)` doesn't prevent processing the same request twice
3. **User experience**: Double-clicking "Submit" shouldn't create errors or duplicates

---

## 11. Trade-offs and Alternatives (3-4 minutes)

### Database Choice

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| PostgreSQL + PostGIS | ACID, mature geo support, rich SQL | Single point of failure | **Chosen** - best fit for transactional reviews |
| MongoDB + GeoJSON | Flexible schema, easy scaling | Weaker consistency | Rejected - reviews need strong consistency |
| CockroachDB | Distributed PostgreSQL | Operational complexity | Consider at scale |

### Search Engine

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Elasticsearch | Best-in-class full-text + geo | Operational complexity | **Chosen** - feature-rich for search UX |
| PostgreSQL tsvector | Single DB, simpler architecture | Slower, fewer features | Fallback only |
| Algolia | Managed, fast | Expensive at scale | Consider for startup phase |

### Message Queue

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| RabbitMQ | Simple, reliable, DLQ support | Not ideal for event sourcing | **Chosen** - fits async indexing well |
| Kafka | High throughput, replay | Overkill for this use case | Consider for analytics |
| Redis Streams | Single dependency | Less feature-rich | Consider for simplicity |

---

## 12. Monitoring and Observability (2-3 minutes)

### Key Metrics (Prometheus)

```typescript
// Application metrics
const metrics = {
  httpRequestDuration: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'path', 'status']
  }),
  searchesTotal: new Counter({
    name: 'yelp_searches_total',
    help: 'Total searches',
    labelNames: ['cache_hit', 'has_geo']
  }),
  reviewsCreated: new Counter({
    name: 'yelp_reviews_created_total',
    help: 'Total reviews created',
    labelNames: ['rating']
  }),
  circuitBreakerState: new Gauge({
    name: 'yelp_circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=open)',
    labelNames: ['name']
  })
};
```

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| p95 latency | > 300ms | > 500ms |
| Error rate (5xx) | > 1% | > 5% |
| Cache hit rate | < 50% | < 30% |
| Circuit breaker open | - | Any |
| DLQ depth | > 50 | > 100 |

---

## Summary

The key backend insights for Yelp's design are:

1. **Dual-layer geo-spatial**: PostgreSQL + PostGIS as source of truth; Elasticsearch for fast search with geo_distance filtering

2. **Database triggers for ratings**: Atomic, real-time rating updates with `rating_sum` and `review_count` denormalization

3. **Async indexing pipeline**: RabbitMQ decouples write path from search index updates, with DLQ for failure handling

4. **Cache-aside pattern**: Redis caching for search results (2 min TTL), business details (5 min TTL), with aggressive invalidation on writes

5. **Circuit breaker pattern**: Opossum wrapping Elasticsearch with PostgreSQL full-text fallback for graceful degradation

6. **Multi-layer rate limiting**: Redis sliding window for spam prevention at IP and user levels

7. **Bayesian rating**: Fair ranking that prevents new businesses with few reviews from gaming the system

This architecture handles 10K+ RPS through careful indexing, caching, and a read-optimized design with eventual consistency for search (< 5s lag) and strong consistency for reviews.
