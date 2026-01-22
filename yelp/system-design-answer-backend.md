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
                                    ┌─────────────────┐
                                    │      CDN        │
                                    │ (Photos, Static)│
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Load Balancer  │
                                    │  (nginx:3000)   │
                                    └────────┬────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              │                              │                              │
    ┌─────────▼─────────┐          ┌─────────▼─────────┐          ┌─────────▼─────────┐
    │   API Server 1    │          │   API Server 2    │          │   API Server 3    │
    │   (port 3001)     │          │   (port 3002)     │          │   (port 3003)     │
    └───┬───────┬───────┘          └───┬───────┬───────┘          └───┬───────┬───────┘
        │       │                      │       │                      │       │
        │       └──────────────────────┴───────┴──────────────────────┘       │
        │                              │                                      │
        ▼                              ▼                                      ▼
┌───────┴───────┐              ┌───────┴───────┐                      ┌───────┴───────┐
│   PostgreSQL  │              │     Redis     │                      │ Elasticsearch │
│   + PostGIS   │              │   (Valkey)    │                      │               │
│  (port 5432)  │              │  (port 6379)  │                      │  (port 9200)  │
└───────┬───────┘              └───────────────┘                      └───────┬───────┘
        │                                                                     ▲
        │                      ┌───────────────┐                              │
        └─────────────────────▶│   RabbitMQ    │──────────────────────────────┘
                               │  (port 5672)  │
                               └───────┬───────┘
                                       │
                               ┌───────▼───────┐
                               │ Index Worker  │
                               └───────┬───────┘
                                       │
                               ┌───────▼───────┐
                               │    MinIO      │
                               │ (port 9000)   │
                               └───────────────┘
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

The businesses table uses PostGIS GEOGRAPHY type for accurate distance calculations:

1. **Enable PostGIS extension** - Required for geo-spatial queries
2. **Location column**: `GEOGRAPHY(POINT, 4326)` stores lat/lon using WGS84 coordinate system
3. **Key fields**: id, owner_id, name, description, address, city, state, zip_code, phone, website, location, categories (array), hours (JSONB), amenities (array), rating_sum, review_count
4. **GIST index on location** - Critical for geo-query performance
5. **GIN index on categories** - Enables fast category filtering
6. **Computed rating index** - For sorting by average rating

### PostGIS Geo-Queries

**Find businesses within radius:**
1. Use `ST_DWithin(location, point, distance_meters)` for radius filtering
2. Use `ST_Distance(location, point)` to calculate actual distance
3. Cast user coordinates to geography with `ST_Point(lon, lat)::geography`
4. Order by distance ascending, limit results

**Complex query with category filter:**
1. Filter by radius with ST_DWithin
2. Filter by category using `ANY(categories)`
3. Filter by is_active = true
4. Compute average rating as rating_sum / NULLIF(review_count, 0)
5. Order by rating DESC, distance ASC

### Elasticsearch Index Mapping

```
┌─────────────────────────────────────────────────────────────┐
│                 Elasticsearch Index: businesses              │
├─────────────────────────────────────────────────────────────┤
│  Fields:                                                     │
│  ├── id (keyword)                                           │
│  ├── name (text + keyword + autocomplete subfield)          │
│  ├── description (text)                                     │
│  ├── city, state (keyword)                                  │
│  ├── location (geo_point)                                   │
│  ├── categories, amenities (keyword arrays)                 │
│  ├── average_rating (float)                                 │
│  ├── review_count (integer)                                 │
│  └── is_active (boolean)                                    │
├─────────────────────────────────────────────────────────────┤
│  Analyzers:                                                  │
│  ├── autocomplete: edge_ngram tokenizer (2-20 chars)        │
│  └── standard: default text analysis                        │
└─────────────────────────────────────────────────────────────┘
```

### Elasticsearch Geo-Distance Query Flow

1. **Build query** with geo_distance filter specifying radiusKm and lat/lon
2. **Apply filters**: is_active=true, category term match, minRating range
3. **Sort by**: _score (relevance) DESC, then _geo_distance ASC
4. **Return** results with computed distance_km from sort values

### Why Dual-Layer Geo-Spatial Architecture?

| Layer | Responsibility | Strengths |
|-------|---------------|-----------|
| PostgreSQL + PostGIS | Source of truth, ACID transactions | Accurate spherical calculations, complex joins |
| Elasticsearch | Search and filtering | Fast full-text search, faceted queries, built-in geo_distance |

> "The trade-off of maintaining two geo indexes adds sync complexity but provides better search performance with richer query capabilities."

---

## 5. Deep Dive: Rating Aggregation System (6-7 minutes)

### Database Trigger for Incremental Updates

**Reviews table structure:**
- id, user_id, business_id, rating (1-5), title, content, photo_urls, helpful_count, timestamps
- UNIQUE constraint on (user_id, business_id) - one review per user per business

**Trigger function logic:**
- **INSERT**: Add rating to business.rating_sum, increment review_count
- **UPDATE**: Adjust rating_sum by (NEW.rating - OLD.rating)
- **DELETE**: Subtract rating from rating_sum, decrement review_count
- All operations update business.updated_at timestamp

### Why Triggers Over Materialized Views?

| Approach | Pros | Cons |
|----------|------|------|
| Database Triggers | Real-time updates, atomic with transaction | Slightly slower writes |
| Materialized Views | Bulk refresh efficiency | Stale data between refreshes |
| Application-level | Flexible business logic | Not atomic, prone to inconsistency |

> "Triggers provide real-time accuracy with transactional guarantees - critical for a reviews platform where ratings must be immediately accurate."

### Bayesian Rating for Fair Ranking

**Formula**: `(review_count * rating + m * C) / (review_count + m)`

Where:
- C = 3.5 (prior mean / platform average)
- m = 10 (minimum reviews for full weight)

**Examples:**
- Business with 1 review of 5 stars: (1*5 + 10*3.5) / 11 = 3.64
- Business with 100 reviews of 5 stars: (100*5 + 10*3.5) / 110 = 4.86
- Business with 10 reviews of 4.5 stars: (10*4.5 + 10*3.5) / 20 = 4.0

> "This prevents new businesses with one 5-star review from outranking established businesses with many 4.5-star reviews."

---

## 6. Deep Dive: Async Indexing Pipeline (5-6 minutes)

### RabbitMQ Queue Architecture

```
┌──────────────────┐
│   API Server     │
└────────┬─────────┘
         │ publish
         ▼
┌──────────────────┐
│    RabbitMQ      │
│ ┌──────────────┐ │
│ │ index.update │ │  ◄── durable queue
│ └──────────────┘ │
└────────┬─────────┘
         │ consume
         ▼
┌──────────────────┐
│  Index Worker    │
└────────┬─────────┘
         │
┌────────▼─────────┐
│  Elasticsearch   │
└──────────────────┘
```

### Event Publishing on Business/Review Changes

**createReview flow:**
1. Check unique constraint - return ConflictError if user already reviewed this business
2. Insert review into PostgreSQL (trigger updates business rating_sum/review_count)
3. Publish async event to RabbitMQ: `{ type: 'business', action: 'update', businessId, timestamp }`
4. Invalidate Redis cache for business
5. Return created review

### Index Worker Consumer

**processIndexUpdate flow:**
1. Receive message with type, action, businessId
2. Fetch fresh data from PostgreSQL (source of truth) including computed average_rating
3. If action is 'delete' or business is not active: delete from Elasticsearch
4. Otherwise: index document with location as geo_point
5. On success: acknowledge message
6. On failure: retry up to 3 times with exponential backoff, then send to DLQ

### Dead Letter Queue (DLQ) Configuration

- Main queue: `index.update` with x-dead-letter-exchange and x-dead-letter-routing-key arguments
- DLQ: `dlq.index.update` - durable queue for failed messages
- Manual intervention for DLQ messages after investigation

---

## 7. Deep Dive: Caching Architecture (5-6 minutes)

### Redis Cache Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Redis Key Patterns                               │
├─────────────────────────────────────────────────────────────────────────┤
│  session:{sessionId}           │ user data          │ TTL: 24 hours     │
│  search:{sha256(query+filters)}│ [businessIds...]   │ TTL: 2 minutes    │
│  business:{businessId}         │ business details   │ TTL: 5 minutes    │
│  ratelimit:{userId}:{endpoint} │ count              │ TTL: 1 minute     │
│  ratelimit:ip:{ipAddress}      │ count              │ TTL: 1 minute     │
│  autocomplete:{prefix}         │ [suggestions...]   │ TTL: 5 minutes    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Cache-Aside Pattern Implementation

**getBusinessById flow:**
1. Check cache with key `business:{id}`
2. If cache hit: increment metrics.cacheHits, return parsed JSON
3. If cache miss: increment metrics.cacheMisses
4. Query PostgreSQL with computed average_rating and location extraction
5. If not found: return null
6. Store in cache with 5-minute TTL (setex)
7. Return business data

### Cache Invalidation Strategy

**updateBusiness flow:**
1. Update database with new values
2. Delete cache entry (next read repopulates)
3. Publish index update event to RabbitMQ

**invalidateSearchCache:**
- Use SCAN to find keys matching `search:*` pattern
- Delete all matching keys in batch

### Cache Hit Rate Targets

| Cache Type | Target Hit Rate | Justification |
|------------|-----------------|---------------|
| Session | > 99% | Almost all reads from cache |
| Search results | > 60% | Repeating queries within TTL window |
| Business details | > 70% | Popular businesses frequently accessed |

---

## 8. Deep Dive: Circuit Breaker Pattern (4-5 minutes)

### Opossum Circuit Breaker for Elasticsearch

**Configuration:**
- timeout: 3000ms
- errorThresholdPercentage: 50 (open circuit at 50% failure rate)
- resetTimeout: 30000ms (try again after 30 seconds)
- volumeThreshold: 10 (minimum requests before tripping)

**Fallback:** PostgreSQL full-text search using ts_vector/ts_rank

**Metrics events:**
- success: increment esRequestsTotal with status=success
- failure: increment esRequestsTotal with status=failure
- open: set circuitBreakerState gauge to 1
- close: set circuitBreakerState gauge to 0

### PostgreSQL Fallback Implementation

When Elasticsearch circuit opens:
1. Use `to_tsvector('english', name || ' ' || description)` for full-text search
2. Use `plainto_tsquery('english', query)` for query parsing
3. Filter with `ST_DWithin` for geo-distance
4. Rank with `ts_rank` function
5. Return top 20 results

### Circuit Breaker States

```
CLOSED (normal) ──▶ OPEN (after 50% failure rate with 10+ requests)
       ▲                              │
       │                              ▼
       └─── HALF_OPEN (after 30 second timeout)
              │
              ├── success ──▶ CLOSED
              └── failure ──▶ OPEN
```

---

## 9. Rate Limiting Implementation (3-4 minutes)

### Multi-Layer Rate Limiting

**Rate limit configuration by endpoint:**
- POST /auth/login: 5 per 60s (by IP)
- POST /auth/register: 3 per 3600s (by IP)
- POST /reviews: 10 per 3600s (by user)
- GET /search: 100 per 60s (by user or IP)

### Redis Sliding Window Implementation

**Lua script for atomic operations:**
1. Remove expired entries with ZREMRANGEBYSCORE
2. Count current requests with ZCARD
3. If count < limit: add current request with ZADD, set TTL with EXPIRE, return allowed
4. If count >= limit: return denied

**Response headers:**
- X-RateLimit-Limit: configured limit
- X-RateLimit-Remaining: remaining requests
- X-RateLimit-Reset: unix timestamp when window resets
- Retry-After: seconds to wait (on 429 response)

---

## 10. Idempotency for Review Submission (3-4 minutes)

### Idempotency Key Implementation

**Middleware flow:**
1. Extract `idempotency-key` header
2. If no key: proceed normally
3. Check cache for existing response
4. If cached: return cached status and body immediately
5. Acquire lock with SETNX to prevent concurrent processing
6. If lock not acquired: wait 100ms and retry
7. Intercept response.json to cache the response before sending
8. Store response in cache with 24-hour TTL
9. Release lock after caching

### Why Idempotency Matters for Reviews

1. **Network unreliability**: Mobile users on unstable connections will retry failed requests
2. **Database constraint is insufficient**: UNIQUE(user_id, business_id) doesn't prevent processing the same request twice
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

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Application Metrics                                │
├─────────────────────────────────────────────────────────────────────────┤
│  http_request_duration_seconds     │ Histogram │ method, path, status   │
│  yelp_searches_total               │ Counter   │ cache_hit, has_geo     │
│  yelp_reviews_created_total        │ Counter   │ rating                 │
│  yelp_circuit_breaker_state        │ Gauge     │ name (0=closed, 1=open)│
└─────────────────────────────────────────────────────────────────────────┘
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

> "This architecture handles 10K+ RPS through careful indexing, caching, and a read-optimized design with eventual consistency for search (< 5s lag) and strong consistency for reviews."
