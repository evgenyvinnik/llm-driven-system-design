# Yelp - Business Reviews - Architecture Design

## System Overview

A local business review and discovery platform enabling users to search for businesses by location, category, and keywords; read and write reviews; and discover highly-rated local establishments.

## Requirements

### Functional Requirements

- **Business Search**: Full-text search by name, category, keywords with geo-spatial filtering by radius
- **Reviews**: Create, read, update reviews with text content and photos
- **Ratings**: 1-5 star ratings with aggregated averages per business
- **Geo-search**: Find businesses within a radius of a location (city, zip, or lat/lng)
- **Business Profiles**: Hours, address, phone, photos, categories, amenities
- **User Accounts**: Registration, login, profile management, review history

### Non-Functional Requirements

- **Scalability**: Handle 100K concurrent users; architecture supports horizontal scaling to millions
- **Availability**: 99.9% uptime target (43 minutes downtime/month allowed)
- **Latency**: p50 < 100ms, p95 < 300ms, p99 < 500ms for search queries
- **Consistency**: Eventual consistency for search index (< 5 second lag); strong consistency for reviews and ratings

## Capacity Estimation

### Production Scale

| Metric | Target |
|--------|--------|
| Daily Active Users (DAU) | 100K growing to 10M |
| Peak Requests per Second (RPS) | 5,000 |
| Businesses in database | 10M |
| Reviews in database | 500M |
| Average review size | 500 bytes text + 2KB metadata |
| Photo storage | 50TB (S3) |

### Storage Growth Estimates

| Data Type | Size per Record | Annual Growth |
|-----------|-----------------|---------------|
| Business records | 2KB | 200K new/year |
| Review records | 2.5KB | 50M new/year |
| Review photos | 500KB avg | 10TB/year |
| Search index | 1KB/business + 500B/review | Mirrors DB |

## High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              Clients                                      │
│                    (Web, iOS, Android)                                     │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          CDN (CloudFront)                                  │
│              Static assets, photo delivery, edge caching                  │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     API Gateway / Load Balancer                            │
│                  (Rate limiting, SSL termination)                          │
└──────┬───────────────┬───────────────┬────────────────────────────────────┘
       │               │               │
       ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  API Server  │ │  API Server  │ │  API Server  │
│  (Stateless) │ │  (Stateless) │ │  (Stateless) │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │               │               │
       └───────────────┼───────────────┘
                       │
       ┌───────────────┼───────────────┬────────────────┐
       │               │               │                │
       ▼               ▼               ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  PostgreSQL  │ │    Redis     │ │Elasticsearch │ │   RabbitMQ   │
│  + PostGIS   │ │   (Cache/   │ │   (Search)   │ │  (Async Jobs)│
│  (Primary)   │ │  Sessions)  │ │              │ │              │
└──────────────┘ └──────────────┘ └──────────────┘ └──────┬───────┘
                                                          │
                                                    ┌─────▼────────┐
                                                    │ Index Worker  │
                                                    │ (ES Sync)     │
                                                    └──────────────┘
                                                          │
                                                    ┌─────▼────────┐
                                                    │  S3 / MinIO  │
                                                    │  (Photos)    │
                                                    └──────────────┘
```

### Request Flow

#### Search Request Flow

```
1. Client ──▶ CDN (cache check for static results)
2. CDN MISS ──▶ API Gateway ──▶ API Server (round-robin)
3. API Server checks Redis cache for query hash
   ├── Cache HIT: Return cached results (TTL: 2 minutes)
   └── Cache MISS: Continue to step 4
4. API Server queries Elasticsearch:
   ├── Full-text match on business name/description
   ├── geo_distance filter for location radius
   └── Aggregations for category facets
5. API Server enriches results with PostgreSQL data if needed
6. API Server caches results in Redis
7. Return JSON response
```

#### Review Submission Flow

```
1. Client ──▶ API Gateway ──▶ API Server
2. API Server validates session (Redis lookup)
3. Idempotency check: lookup Idempotency-Key header in Redis
4. API Server validates review data:
   ├── User hasn't reviewed this business before (unique constraint)
   └── Rating is 1-5, text length within limits
5. API Server writes to PostgreSQL (transaction):
   ├── INSERT review record
   └── UPDATE business rating_sum, review_count (trigger-based)
6. API Server publishes event to RabbitMQ:
   ├── Queue: review.created
   └── Payload: { businessId, reviewId, action: 'create' }
7. Index Worker consumes event:
   ├── Updates Elasticsearch business document
   └── Invalidates Redis cache for business
8. Return success response
```

### Core Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| API Gateway | Load balancing, rate limiting, SSL termination | nginx / AWS ALB |
| API Server | Business logic, REST endpoints | Node.js + Express |
| Primary Database | Users, businesses, reviews (source of truth) | PostgreSQL 16 + PostGIS |
| Search Engine | Full-text search, geo queries, aggregations | Elasticsearch 8.x |
| Cache | Sessions, query results, hot business data | Redis / Valkey |
| Message Queue | Async indexing, notifications | RabbitMQ |
| Object Storage | Review photos, business images | S3 (MinIO locally) |

## Database Schema

```sql
-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    role VARCHAR(50) DEFAULT 'user' CHECK (role IN ('user', 'business_owner', 'admin')),
    review_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions table
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Categories table
CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    parent_id UUID REFERENCES categories(id),
    icon VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Businesses table with PostGIS geography
CREATE TABLE businesses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(50) NOT NULL,
    zip_code VARCHAR(20) NOT NULL,
    country VARCHAR(100) DEFAULT 'USA',
    latitude DECIMAL(10, 7) NOT NULL,
    longitude DECIMAL(10, 7) NOT NULL,
    location GEOGRAPHY(POINT, 4326),
    phone VARCHAR(20),
    website VARCHAR(255),
    email VARCHAR(255),
    price_level INTEGER CHECK (price_level >= 1 AND price_level <= 4),
    rating DECIMAL(2, 1) DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    rating_sum DECIMAL(10, 1) DEFAULT 0,
    photo_count INTEGER DEFAULT 0,
    is_claimed BOOLEAN DEFAULT FALSE,
    is_verified BOOLEAN DEFAULT FALSE,
    owner_id UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Spatial index for geo queries
CREATE INDEX idx_businesses_location ON businesses USING GIST(location);
CREATE INDEX idx_businesses_rating ON businesses(rating DESC);
CREATE INDEX idx_businesses_city ON businesses(city);
CREATE INDEX idx_businesses_slug ON businesses(slug);

-- Business categories junction table
CREATE TABLE business_categories (
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (business_id, category_id)
);

-- Business hours table
CREATE TABLE business_hours (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
    open_time TIME NOT NULL,
    close_time TIME NOT NULL,
    is_closed BOOLEAN DEFAULT FALSE,
    UNIQUE(business_id, day_of_week)
);

-- Business photos table
CREATE TABLE business_photos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    caption TEXT,
    is_primary BOOLEAN DEFAULT FALSE,
    uploaded_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews table
CREATE TABLE reviews (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    text TEXT NOT NULL,
    helpful_count INTEGER DEFAULT 0,
    funny_count INTEGER DEFAULT 0,
    cool_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(business_id, user_id)
);

CREATE INDEX idx_reviews_business ON reviews(business_id, created_at DESC);
CREATE INDEX idx_reviews_user ON reviews(user_id);
CREATE INDEX idx_reviews_rating ON reviews(rating);

-- Review photos, votes, and owner responses
CREATE TABLE review_photos (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    caption TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE review_votes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    vote_type VARCHAR(20) NOT NULL CHECK (vote_type IN ('helpful', 'funny', 'cool')),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(review_id, user_id, vote_type)
);

CREATE TABLE review_responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE UNIQUE,
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Trigger: auto-sync PostGIS geography from lat/lng
CREATE OR REPLACE FUNCTION update_business_location()
RETURNS TRIGGER AS $$
BEGIN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_business_location
    BEFORE INSERT OR UPDATE OF latitude, longitude ON businesses
    FOR EACH ROW EXECUTE FUNCTION update_business_location();

-- Trigger: update business rating aggregates on review changes
CREATE OR REPLACE FUNCTION update_business_rating()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE businesses
        SET rating_sum = rating_sum + NEW.rating,
            review_count = review_count + 1,
            rating = (rating_sum + NEW.rating) / (review_count + 1)
        WHERE id = NEW.business_id;
        UPDATE users SET review_count = review_count + 1 WHERE id = NEW.user_id;
    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE businesses
        SET rating_sum = rating_sum - OLD.rating + NEW.rating,
            rating = (rating_sum - OLD.rating + NEW.rating) / review_count
        WHERE id = NEW.business_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE businesses
        SET rating_sum = GREATEST(0, rating_sum - OLD.rating),
            review_count = GREATEST(0, review_count - 1),
            rating = CASE WHEN review_count - 1 <= 0 THEN 0
                     ELSE (rating_sum - OLD.rating) / (review_count - 1) END
        WHERE id = OLD.business_id;
        UPDATE users SET review_count = GREATEST(0, review_count - 1) WHERE id = OLD.user_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_business_rating
    AFTER INSERT OR UPDATE OR DELETE ON reviews
    FOR EACH ROW EXECUTE FUNCTION update_business_rating();
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
          "autocomplete": { "type": "text", "analyzer": "autocomplete" }
        }
      },
      "description": { "type": "text" },
      "address": { "type": "text" },
      "city": { "type": "keyword" },
      "state": { "type": "keyword" },
      "zip_code": { "type": "keyword" },
      "location": { "type": "geo_point" },
      "categories": { "type": "keyword" },
      "amenities": { "type": "keyword" },
      "average_rating": { "type": "float" },
      "review_count": { "type": "integer" },
      "is_active": { "type": "boolean" },
      "updated_at": { "type": "date" }
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

### Redis Cache Keys

```
# Session storage
session:{sessionId}              -> { userId, role, expiresAt }  TTL: 24 hours

# Search result cache
search:{sha256(query+filters)}   -> [businessIds...]             TTL: 2 minutes

# Business detail cache
business:{businessId}            -> { ...businessData }          TTL: 5 minutes

# Rate limiting
ratelimit:{userId}:{endpoint}    -> count                        TTL: 1 minute

# Popular searches (for autocomplete)
popular:searches                 -> Sorted Set (term -> count)   TTL: 1 hour
```

## API Design

### Authentication
```
POST   /api/v1/auth/register     # Create user account
POST   /api/v1/auth/login        # Login, returns session cookie
POST   /api/v1/auth/logout       # Invalidate session
GET    /api/v1/auth/me           # Get current user
```

### Businesses
```
GET    /api/v1/businesses                    # Search businesses
GET    /api/v1/businesses/:id                # Get business details
POST   /api/v1/businesses                    # Create business (owner/admin)
PUT    /api/v1/businesses/:id                # Update business (owner/admin)
DELETE /api/v1/businesses/:id                # Delete business (owner/admin)
GET    /api/v1/businesses/:id/reviews        # Get reviews for business
POST   /api/v1/businesses/:id/photos         # Upload business photo
```

### Search
```
GET    /api/v1/search?q=pizza&lat=37.7&lng=-122.4&radius=5km
GET    /api/v1/search/autocomplete?q=piz
GET    /api/v1/search/nearby?lat=37.7&lng=-122.4&radius=1km&category=restaurants
```

### Reviews
```
GET    /api/v1/reviews/:id                   # Get review details
POST   /api/v1/reviews                       # Create review
PUT    /api/v1/reviews/:id                   # Update own review
DELETE /api/v1/reviews/:id                   # Delete own review
POST   /api/v1/reviews/:id/vote              # Vote helpful/funny/cool
POST   /api/v1/reviews/:id/photos            # Upload review photo
```

### Admin
```
GET    /api/v1/admin/users                   # List users
PUT    /api/v1/admin/users/:id/role          # Change user role
GET    /api/v1/admin/businesses/pending      # Businesses pending approval
PUT    /api/v1/admin/businesses/:id/approve  # Approve business
DELETE /api/v1/admin/reviews/:id             # Remove review (moderation)
GET    /api/v1/admin/stats                   # System statistics
```

## Key Design Decisions

### Geo-spatial Search: Dual-Layer Approach

**Problem**: Find businesses within a radius efficiently while supporting full-text search and faceted filtering.

**Solution**: PostgreSQL + PostGIS as source of truth, Elasticsearch as search layer.

PostGIS handles authoritative geo-queries with `ST_DWithin` and GIST indexes. Elasticsearch handles the search UX: full-text matching on business names, `geo_distance` filtering, faceted aggregations for categories, and autocomplete via edge n-grams. Writes go to PostgreSQL first, then async sync to Elasticsearch via RabbitMQ.

**Why not PostGIS alone?** PostgreSQL's `tsvector` + `pg_trgm` provides full-text search, but lacks Elasticsearch's relevance tuning (BM25 scoring), built-in aggregations for faceted search, and autocomplete tokenization. For < 100K businesses, PostgreSQL alone might suffice. At 10M+ businesses with complex multi-field queries, Elasticsearch's inverted index architecture handles read-heavy workloads more efficiently.

**Trade-off**: Two geo indexes adds sync complexity. If Elasticsearch falls behind PostgreSQL, search results are temporarily stale (< 5 seconds). This is acceptable because users searching for restaurants don't need sub-second freshness on ratings.

### Rating Aggregation: Trigger-Based Pre-computation

**Problem**: Computing `AVG(rating)` across thousands of reviews on every search result is expensive.

**Solution**: Store `rating_sum` and `review_count` on the `businesses` table. A PostgreSQL trigger updates these counters on review INSERT/UPDATE/DELETE. Average is computed as `rating_sum / review_count`.

**Why triggers over materialized views?** Triggers provide real-time accuracy. A materialized view refreshed every N minutes would show stale ratings, and periodic refresh under write-heavy load creates spikes. Triggers amortize the cost across individual writes.

**Trade-off**: Triggers add latency to review writes (~1ms extra) and couple the review and business tables at the database level. If review volume reaches millions per day, the single-row UPDATE on the business row could become a bottleneck. At that scale, we would move to async aggregation via a queue.

### Search Index Synchronization: Async via RabbitMQ

**Problem**: Keep Elasticsearch in sync with PostgreSQL without blocking API responses.

**Solution**: Event-driven sync. API writes to PostgreSQL (synchronous), publishes an event to RabbitMQ (async, fire-and-forget), and a separate Index Worker consumes events and updates Elasticsearch. Maximum eventual consistency delay: < 5 seconds.

**Failure handling**: RabbitMQ durable queues persist messages. Failed indexing attempts go to a dead-letter queue after 3 retries. A daily full re-index from PostgreSQL acts as a safety net.

**Why RabbitMQ over Kafka?** RabbitMQ's work-queue model, built-in DLQ, priority queues, and lower resource footprint make it better suited for request-response patterns at this scale. Kafka's log-based architecture would be overkill unless we need event replay or an analytics pipeline.

### PostgreSQL + PostGIS vs MongoDB + GeoJSON

**Chose PostgreSQL** for ACID transactions ensuring review/rating consistency, mature PostGIS spatial functions, and a simpler operational model (single RDBMS). MongoDB's flexible schema might speed initial development, but PostgreSQL's constraints catch data integrity bugs early. The explicit schema also makes the rating trigger system possible.

## Consistency and Idempotency

### Idempotency for Review Submission

Clients generate a UUID `Idempotency-Key` header before sending review requests. The server checks Redis for an existing key before processing. If found, it returns the cached response. If not found, it acquires a lock, processes the request, and caches the response. Keys expire after 24 hours.

```
Request 1: POST /reviews, Idempotency-Key: abc-123
  -> Lock acquired, review created, response cached, return 201

Request 2: POST /reviews, Idempotency-Key: abc-123 (retry)
  -> Key found in cache, return cached 201 response (no duplicate created)
```

The database `UNIQUE(business_id, user_id)` constraint catches a different class of problem (same user reviewing twice), not retry duplicates.

## Security

### Authentication and Authorization

**Session-based authentication**: User submits credentials, server validates bcrypt hash (cost factor 12), creates session in Redis, and sets HttpOnly/Secure/SameSite=Strict cookie.

**Role-Based Access Control (RBAC)**:

| Role | Permissions |
|------|-------------|
| `user` | Create/edit own reviews, vote on reviews |
| `business_owner` | All user permissions + manage own businesses |
| `admin` | All permissions + user management, moderation |

### Rate Limiting

| Endpoint | Limit | Window | Key |
|----------|-------|--------|-----|
| POST /auth/login | 5 requests | 1 minute | IP address |
| POST /auth/register | 3 requests | 1 hour | IP address |
| POST /reviews | 10 requests | 1 hour | User ID |
| GET /search | 100 requests | 1 minute | User ID or IP |

Multi-layer rate limiting: per-user, per-IP, and per-user-per-business limits. Sliding window counters in Redis prevent boundary-burst issues. Fail-open design: if Redis is unavailable, requests are allowed.

### Input Validation

- All inputs validated server-side
- SQL injection prevented by parameterized queries (pg library)
- XSS prevented by React's default escaping
- File uploads: type validation, size limits (5MB)
- Passwords: bcrypt with cost factor 12

## Observability

### Metrics (Prometheus)

```
# Request metrics
http_requests_total{method, path, status}
http_request_duration_seconds{method, path, quantile}

# Business metrics
yelp_searches_total{cache_hit, has_geo, has_category}
yelp_search_duration_seconds{cache_hit}
yelp_search_results_count (histogram)
yelp_reviews_created_total{rating}
yelp_circuit_breaker_state{name}

# Resource metrics
db_pool_connections{state}
cache_operations_total{operation, result}
queue_messages_published_total{queue}
queue_messages_consumed_total{queue, result}
```

### Logging (Structured JSON via Pino)

All logs are structured JSON with request IDs for correlation. Log levels: `error` (5xx, unhandled exceptions), `warn` (retries, cache misses, rate limits), `info` (request/response), `debug` (disabled in production). Sensitive fields (passwords, tokens) are automatically redacted.

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| p95 latency | > 300ms | > 500ms |
| Error rate (5xx) | > 1% | > 5% |
| DB connection pool exhausted | > 80% | > 95% |
| Cache hit rate | < 50% | < 30% |
| DLQ depth | > 50 | > 100 |

## Failure Handling

### Circuit Breaker Pattern

Elasticsearch and heavy PostgreSQL geo-queries are wrapped in circuit breakers (CLOSED -> OPEN after 5 failures -> HALF_OPEN after 30s -> test requests -> CLOSED or OPEN).

**Fallback behavior**:
- Elasticsearch down: Fall back to PostgreSQL full-text search (slower but functional)
- Redis down: Sessions from PostgreSQL backup table, skip caching
- RabbitMQ down: Write to PostgreSQL outbox table, process later

### Retry Strategy

| Operation | Retries | Backoff | Timeout |
|-----------|---------|---------|---------|
| Database query | 2 | Exponential (100ms, 200ms) | 5s |
| Elasticsearch query | 2 | Exponential (50ms, 100ms) | 3s |
| Redis operation | 1 | Immediate | 500ms |
| RabbitMQ publish | 3 | Exponential (100ms base) | 2s |

## Scalability Considerations

### Horizontal Scaling Path

| Component | Scaling Strategy | Trigger |
|-----------|-----------------|---------|
| API Servers | Add instances behind LB | CPU > 70%, RPS > threshold |
| PostgreSQL | Read replicas, then sharding by city | Reads > 10K/s |
| Elasticsearch | Add nodes to cluster | Index size > 50GB |
| Redis | Redis Cluster (16K slots) | Memory > 80% |
| RabbitMQ | Clustering + federation | Queue depth growing |

### Database Sharding Strategy

When single PostgreSQL instance is insufficient, shard by city/region. Most queries are geo-local, making city-based sharding natural. Cross-shard queries (global search) use scatter-gather. Read replicas handle the read-heavy search enrichment workload with < 100ms replication lag.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Primary DB | PostgreSQL + PostGIS | MongoDB + GeoJSON | ACID transactions, mature geo support |
| Search | Elasticsearch | PostgreSQL tsvector | Better relevance, geo_distance, facets |
| Cache | Redis/Valkey | Memcached | Data structures, persistence, pub/sub |
| Queue | RabbitMQ | Kafka | Simpler for work queues, DLQ built-in |
| Rating | Trigger-based aggregation | Materialized views | Real-time accuracy |
| Index sync | Async via RabbitMQ | Synchronous dual-write | Non-blocking writes |
| Auth | Session-based (Redis) | JWT | Immediate revocation, simpler |

## Implementation Notes

This section documents the actual local setup, what production patterns are implemented, what was simplified, and what was omitted.

### Local Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    React Frontend                         │
│           (Vite dev server, localhost:5173)               │
└─────────────────────────┬────────────────────────────────┘
                          │ HTTP
                          ▼
┌──────────────────────────────────────────────────────────┐
│              Express API Server (localhost:3001)           │
│                  (or 3002/3003 for multi-instance)        │
└────┬──────────┬──────────┬──────────┬────────────────────┘
     │          │          │          │
     ▼          ▼          ▼          ▼
┌─────────┐ ┌────────┐ ┌───────┐ ┌─────────┐
│PostgreSQL│ │ Valkey │ │Elastic│ │RabbitMQ │
│+ PostGIS│ │ :6379  │ │Search │ │ :5672   │
│  :5432  │ │        │ │ :9200 │ │ :15672  │
└─────────┘ └────────┘ └───────┘ └────┬────┘
                                      │
                                ┌─────▼────┐   ┌────────┐
                                │  Index   │   │ MinIO  │
                                │  Worker  │   │ :9000  │
                                └──────────┘   └────────┘
```

All infrastructure runs via `docker-compose up -d` using `docker-compose.yml`.

### Production Patterns Actually Implemented

| Pattern | Implementation | File Path |
|---------|---------------|-----------|
| Circuit breaker | Opossum wrapping Elasticsearch queries | `backend/src/utils/circuitBreaker.ts` |
| Structured logging | Pino with JSON output and request context | `backend/src/utils/logger.ts` |
| Prometheus metrics | prom-client with search/review/cache counters | `backend/src/utils/metrics.ts` |
| Redis caching | Cache-aside for search results (2min), businesses (5min) | `backend/src/utils/redis.ts` |
| Idempotency keys | Redis-backed deduplication for review creation | `backend/src/utils/idempotency.ts` |
| Rate limiting | express-rate-limit with multi-layer limits | `backend/src/utils/reviewRateLimit.ts` |
| Async ES indexing | RabbitMQ queue with Index Worker consumer | `backend/src/workers/indexWorker.ts` |
| ES full-text search | Autocomplete, geo_distance, faceted search | `backend/src/utils/elasticsearch.ts` |
| PostGIS geo-queries | ST_DWithin, ST_Distance with GIST index | `backend/src/routes/businesses/nearby.ts` |
| Object storage | MinIO for photo uploads | `backend/src/utils/storage.ts` |
| Session auth | Cookie-based sessions with Redis | `backend/src/middleware/auth.ts` |
| RBAC | user, business_owner, admin roles | `backend/src/middleware/auth.ts` |

### What Was Simplified or Substituted

| Production Design | Local Substitute | Why |
|-------------------|-----------------|-----|
| S3 + CloudFront | MinIO (single node, port 9000) | S3-compatible API, no AWS account needed |
| AWS ALB / API Gateway | Direct Express server (port 3001) | No load balancer configured |
| PostgreSQL read replicas | Single PostgreSQL instance | Sufficient for dev-scale queries |
| Redis Cluster | Single Valkey instance | < 100MB data, no sharding needed |
| Multi-node Elasticsearch | Single ES node (512MB heap) | Dev-scale index fits in memory |
| CDN for static assets | Vite dev server serves directly | No caching layer for assets |
| OAuth / SSO | Cookie-based session auth | Simpler, avoids OAuth provider setup |
| Grafana dashboards | Prometheus `/metrics` endpoint only | Metrics exposed but no visualization |
| Multi-region deployment | Single machine, all services | Learning project, not HA |

### What Was Omitted

- CDN / edge caching (CloudFront, Cloudflare)
- Multi-region PostgreSQL replication
- Database sharding by city/region
- Kubernetes / container orchestration
- CI/CD pipeline for backend deployment
- OAuth / social login integration
- Review spam detection (ML-based classifier)
- Recommendation engine ("Users who liked X also liked Y")
- A/B testing infrastructure for search ranking
- Distributed tracing (OpenTelemetry integration)
- Push notifications
- Map-based browsing with marker clustering

---

*Architecture document for a local development learning project. Production deployment would require additional considerations for multi-region, compliance, and operational runbooks.*
