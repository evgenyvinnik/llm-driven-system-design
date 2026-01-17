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

- **Scalability**: Handle 10K concurrent users in local dev; architecture supports horizontal scaling
- **Availability**: 99.9% uptime target (43 minutes downtime/month allowed)
- **Latency**: p50 < 100ms, p95 < 300ms, p99 < 500ms for search queries
- **Consistency**: Eventual consistency for search index (< 5 second lag); strong consistency for reviews and ratings

## Capacity Estimation

### Local Development Scale

Designed for a single developer machine running all services:

| Metric | Local Dev Target | Production Equivalent |
|--------|------------------|----------------------|
| Daily Active Users (DAU) | 10-50 simulated | 100K |
| Peak Requests per Second (RPS) | 50 | 5,000 |
| Businesses in database | 10,000 | 10M |
| Reviews in database | 100,000 | 500M |
| Average review size | 500 bytes text + 2KB metadata | Same |
| Photo storage | 1GB (MinIO) | 50TB (S3) |

### Storage Growth Estimates

| Data Type | Size per Record | Local Dev Total | Growth Rate |
|-----------|-----------------|-----------------|-------------|
| Business records | 2KB | 20MB | Static for dev |
| Review records | 2.5KB | 250MB | ~10MB/month |
| Review photos | 500KB avg | 1GB | ~100MB/month |
| Search index | 1KB/business + 500B/review | 60MB | Mirrors DB |
| Session data | 1KB/session | 50KB | TTL-managed |

### Component Sizing (Local Dev)

Based on 50 peak RPS target:

- **PostgreSQL**: 1 instance, 512MB RAM, 2GB disk
- **Elasticsearch**: 1 node, 1GB heap, 500MB disk
- **Redis/Valkey**: 1 instance, 64MB RAM
- **MinIO**: 1 instance, 2GB disk
- **RabbitMQ**: 1 instance, 128MB RAM
- **API Servers**: 2-3 instances on different ports, 256MB each

## High-Level Architecture

```
                                    +-----------------+
                                    |   CDN (local:   |
                                    |   nginx cache)  |
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
                               |    MinIO      |
                               | (port 9000)   |
                               +---------------+
```

### Request Flow

#### Search Request Flow

```
1. User -> nginx LB -> API Server (round-robin)
2. API Server checks Redis cache for query hash
   - Cache HIT: Return cached results (TTL: 2 minutes)
   - Cache MISS: Continue to step 3
3. API Server queries Elasticsearch:
   - Full-text match on business name/description
   - geo_distance filter for location radius
   - Aggregations for category facets
4. API Server enriches results with PostgreSQL data if needed
5. API Server caches results in Redis
6. Return JSON response to user
```

#### Review Submission Flow

```
1. User -> nginx LB -> API Server
2. API Server validates session (Redis lookup)
3. API Server validates review data:
   - User hasn't reviewed this business before (unique constraint)
   - Rating is 1-5, text length within limits
4. API Server writes to PostgreSQL (transaction):
   - INSERT review record
   - UPDATE business rating_sum, review_count (trigger-based)
5. API Server publishes event to RabbitMQ:
   - Queue: review.created
   - Payload: { businessId, reviewId, action: 'create' }
6. Index Worker consumes event:
   - Updates Elasticsearch business document
   - Invalidates Redis cache for business
7. Return success response to user
```

### Core Components

| Component | Purpose | Port | Technology |
|-----------|---------|------|------------|
| API Gateway | Load balancing, rate limiting, SSL termination | 3000 | nginx |
| API Server | Business logic, REST endpoints | 3001-3003 | Node.js + Express |
| Primary Database | Users, businesses, reviews (source of truth) | 5432 | PostgreSQL 16 + PostGIS |
| Search Engine | Full-text search, geo queries, aggregations | 9200 | Elasticsearch 8.x |
| Cache | Sessions, query results, hot business data | 6379 | Valkey/Redis |
| Message Queue | Async indexing, notifications | 5672 | RabbitMQ |
| Object Storage | Review photos, business images | 9000 | MinIO |

## Data Model

### Database Schema (PostgreSQL + PostGIS)

```sql
-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    avatar_url VARCHAR(500),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'business_owner', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

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
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    categories TEXT[] DEFAULT '{}',
    hours JSONB DEFAULT '{}',
    amenities TEXT[] DEFAULT '{}',
    rating_sum INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    photo_urls TEXT[] DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Spatial index for geo queries
CREATE INDEX idx_businesses_location ON businesses USING GIST(location);
CREATE INDEX idx_businesses_city ON businesses(city);
CREATE INDEX idx_businesses_categories ON businesses USING GIN(categories);
CREATE INDEX idx_businesses_rating ON businesses((rating_sum::float / NULLIF(review_count, 0)));

-- Reviews table
CREATE TABLE reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title VARCHAR(200),
    content TEXT NOT NULL,
    photo_urls TEXT[] DEFAULT '{}',
    helpful_count INTEGER DEFAULT 0,
    is_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, business_id)
);

CREATE INDEX idx_reviews_business ON reviews(business_id, created_at DESC);
CREATE INDEX idx_reviews_user ON reviews(user_id, created_at DESC);
CREATE INDEX idx_reviews_rating ON reviews(business_id, rating);

-- Review votes (helpful/not helpful)
CREATE TABLE review_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    vote_type VARCHAR(10) CHECK (vote_type IN ('helpful', 'not_helpful')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(review_id, user_id)
);

-- Trigger to update business rating aggregates
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

-- Sessions table (alternative to Redis-only sessions)
CREATE TABLE sessions (
    id VARCHAR(255) PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    data JSONB DEFAULT '{}',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
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
ratelimit:ip:{ipAddress}         -> count                        TTL: 1 minute

# Popular searches (for autocomplete)
popular:searches                 -> Sorted Set (term -> count)   TTL: 1 hour
```

### Storage Strategy

| Data Type | Storage | Rationale |
|-----------|---------|-----------|
| User accounts | PostgreSQL | Transactional integrity, auth queries |
| Business records | PostgreSQL + PostGIS | Geo-spatial queries, source of truth |
| Reviews | PostgreSQL | Strong consistency, complex queries |
| Search index | Elasticsearch | Full-text search, geo_distance, facets |
| Sessions | Redis (primary) + PostgreSQL (backup) | Fast reads, simple invalidation |
| Photos | MinIO (S3-compatible) | Binary blob storage, CDN-friendly |
| Message queue | RabbitMQ | Reliable async processing |

## API Design

### Core Endpoints

#### Authentication
```
POST   /api/v1/auth/register     # Create user account
POST   /api/v1/auth/login        # Login, returns session cookie
POST   /api/v1/auth/logout       # Invalidate session
GET    /api/v1/auth/me           # Get current user
```

#### Businesses
```
GET    /api/v1/businesses                    # Search businesses
GET    /api/v1/businesses/:id                # Get business details
POST   /api/v1/businesses                    # Create business (owner/admin)
PUT    /api/v1/businesses/:id                # Update business (owner/admin)
DELETE /api/v1/businesses/:id                # Delete business (owner/admin)
GET    /api/v1/businesses/:id/reviews        # Get reviews for business
POST   /api/v1/businesses/:id/photos         # Upload business photo
```

#### Search
```
GET    /api/v1/search?q=pizza&lat=37.7&lng=-122.4&radius=5km
       # Full-text search with geo filter

GET    /api/v1/search/autocomplete?q=piz
       # Autocomplete suggestions

GET    /api/v1/search/nearby?lat=37.7&lng=-122.4&radius=1km&category=restaurants
       # Nearby businesses by category
```

#### Reviews
```
GET    /api/v1/reviews/:id                   # Get review details
POST   /api/v1/reviews                       # Create review
PUT    /api/v1/reviews/:id                   # Update own review
DELETE /api/v1/reviews/:id                   # Delete own review
POST   /api/v1/reviews/:id/vote              # Vote helpful/not helpful
POST   /api/v1/reviews/:id/photos            # Upload review photo
```

#### Admin
```
GET    /api/v1/admin/users                   # List users
PUT    /api/v1/admin/users/:id/role          # Change user role
GET    /api/v1/admin/businesses/pending      # Businesses pending approval
PUT    /api/v1/admin/businesses/:id/approve  # Approve business
DELETE /api/v1/admin/reviews/:id             # Remove review (moderation)
GET    /api/v1/admin/stats                   # System statistics
```

### Request/Response Examples

#### Search Request
```http
GET /api/v1/search?q=sushi&lat=37.7749&lng=-122.4194&radius=5km&category=restaurants&sort=rating&page=1&limit=20
```

#### Search Response
```json
{
  "data": {
    "businesses": [
      {
        "id": "uuid",
        "name": "Sushi House",
        "address": "123 Main St",
        "city": "San Francisco",
        "location": { "lat": 37.775, "lng": -122.418 },
        "distance_km": 0.5,
        "categories": ["sushi", "japanese", "restaurants"],
        "average_rating": 4.5,
        "review_count": 127,
        "price_level": 2,
        "photo_url": "https://cdn.example.com/photos/abc123.jpg"
      }
    ],
    "facets": {
      "categories": [
        { "key": "sushi", "count": 15 },
        { "key": "japanese", "count": 12 }
      ],
      "price_levels": [
        { "key": 1, "count": 5 },
        { "key": 2, "count": 8 }
      ]
    },
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 45,
      "total_pages": 3
    }
  },
  "meta": {
    "took_ms": 45,
    "cache_hit": false
  }
}
```

## Key Design Decisions

### Geo-spatial Search

**Problem**: Find businesses within a radius of a given point efficiently.

**Solution**: Dual-layer geo-spatial support:

1. **PostgreSQL + PostGIS** (source of truth):
   ```sql
   SELECT id, name, ST_Distance(location, ST_Point(-122.4, 37.7)::geography) as distance
   FROM businesses
   WHERE ST_DWithin(location, ST_Point(-122.4, 37.7)::geography, 5000)  -- 5km radius
   ORDER BY distance
   LIMIT 20;
   ```

2. **Elasticsearch** (search layer):
   ```json
   {
     "query": {
       "bool": {
         "must": { "match": { "name": "sushi" } },
         "filter": {
           "geo_distance": {
             "distance": "5km",
             "location": { "lat": 37.7, "lon": -122.4 }
           }
         }
       }
     },
     "sort": [
       { "_geo_distance": { "location": { "lat": 37.7, "lon": -122.4 }, "order": "asc" } }
     ]
   }
   ```

**Trade-off**: Maintaining two geo indexes adds sync complexity but provides better search performance and richer query capabilities.

### Rating Aggregation

**Problem**: Calculating average ratings per-query is expensive at scale.

**Solution**: Pre-computed aggregates with trigger-based updates:

- Store `rating_sum` and `review_count` on business records
- Database trigger updates these on review INSERT/UPDATE/DELETE
- Average = rating_sum / review_count (computed at query time)

**Alternative Considered**: Materialized view refreshed periodically. Rejected because triggers provide real-time accuracy without refresh overhead.

### Search Index Synchronization

**Problem**: Keep Elasticsearch in sync with PostgreSQL without blocking writes.

**Solution**: Async event-driven sync via RabbitMQ:

1. API writes to PostgreSQL (synchronous)
2. API publishes event to RabbitMQ (async, fire-and-forget)
3. Index worker consumes event and updates Elasticsearch
4. Maximum eventual consistency delay: < 5 seconds

**Failure Handling**:
- RabbitMQ durable queues persist messages
- Dead-letter queue for failed indexing attempts
- Periodic full re-index job as safety net (daily)

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Application Layer** | Node.js + Express | Fast development, good ecosystem, async I/O |
| **Frontend** | React 19 + TanStack Router + Tailwind | Modern stack, type-safe routing |
| **Data Layer** | PostgreSQL 16 + PostGIS | ACID transactions, mature geo support |
| **Search Layer** | Elasticsearch 8.x | Best-in-class full-text + geo |
| **Cache Layer** | Valkey/Redis | Sub-ms reads, flexible data structures |
| **Message Queue** | RabbitMQ | Reliable delivery, DLQ support, admin UI |
| **Object Storage** | MinIO | S3-compatible, runs locally |
| **Load Balancer** | nginx | Proven, simple config, caching |

## Caching Strategy

### Cache-Aside Pattern

```
Read:
1. Check cache for key
2. If HIT: return cached value
3. If MISS: query database, cache result, return

Write:
1. Write to database
2. Invalidate cache key (delete, not update)
3. Next read populates fresh cache
```

### Cache TTLs and Invalidation

| Data | TTL | Invalidation Trigger |
|------|-----|---------------------|
| Session | 24 hours | Explicit logout, password change |
| Search results | 2 minutes | Time-based expiry only |
| Business details | 5 minutes | On business update, review added |
| Popular searches | 1 hour | Time-based expiry |
| Rate limit counters | 1 minute | Time-based expiry |

### Cache Hit Rate Targets

- Session lookups: > 99% (almost all reads from cache)
- Search queries: > 60% (repeating queries within TTL window)
- Business details: > 70% (popular businesses cached)

## Message Queue Design

### RabbitMQ Queues

| Queue | Purpose | Consumers | Delivery |
|-------|---------|-----------|----------|
| `index.business` | Sync business to Elasticsearch | Index Worker | At-least-once |
| `index.review` | Sync review to Elasticsearch | Index Worker | At-least-once |
| `notifications.email` | Send email notifications | Notification Worker | At-least-once |
| `photos.process` | Resize/optimize uploaded photos | Photo Worker | At-least-once |

### Dead Letter Queue (DLQ)

Failed messages after 3 retries go to `dlq.{original_queue}`:
- Manual inspection via RabbitMQ admin UI
- Replay capability for transient failures
- Alerting on DLQ depth > 100 messages

## Security Considerations

### Authentication and Authorization

**Session-based Authentication**:
```
1. User submits credentials
2. Server validates password hash (bcrypt, cost factor 12)
3. Server creates session in Redis: session:{uuid} -> { userId, role }
4. Server sets HttpOnly, Secure, SameSite=Strict cookie
5. Subsequent requests include cookie for auth
```

**Role-Based Access Control (RBAC)**:

| Role | Permissions |
|------|-------------|
| `user` | Create/edit own reviews, vote on reviews |
| `business_owner` | All user permissions + manage own business(es) |
| `admin` | All permissions + user management, moderation |

**Authorization Middleware**:
```typescript
// Route protection examples
app.post('/api/v1/reviews', requireAuth, createReview);
app.put('/api/v1/businesses/:id', requireAuth, requireRole('business_owner', 'admin'), updateBusiness);
app.delete('/api/v1/admin/reviews/:id', requireAuth, requireRole('admin'), deleteReview);
```

### Rate Limiting

| Endpoint | Limit | Window | Key |
|----------|-------|--------|-----|
| POST /auth/login | 5 requests | 1 minute | IP address |
| POST /auth/register | 3 requests | 1 hour | IP address |
| POST /reviews | 10 requests | 1 hour | User ID |
| GET /search | 100 requests | 1 minute | User ID or IP |

**Implementation**: Token bucket in Redis with Lua script for atomicity.

### Input Validation

- All inputs validated with Zod schemas
- SQL injection prevented by parameterized queries (pg library)
- XSS prevented by React's default escaping + DOMPurify for user HTML
- File uploads: type validation, size limits (5MB), virus scan (ClamAV optional)

### Data Protection

- Passwords: bcrypt with cost factor 12
- PII: Not logged, masked in error responses
- HTTPS: Required in production (nginx terminates TLS)
- Cookies: HttpOnly, Secure, SameSite=Strict

## Observability

### Metrics (Prometheus)

**Application Metrics**:
```
# Request metrics
http_requests_total{method, path, status}
http_request_duration_seconds{method, path, quantile}

# Business metrics
reviews_created_total
searches_total{cache_hit}
businesses_created_total

# Resource metrics
db_pool_connections{state}  # active, idle, waiting
cache_operations_total{operation, result}
queue_messages_published_total{queue}
queue_messages_consumed_total{queue, result}
```

**Infrastructure Metrics** (from exporters):
```
# PostgreSQL
pg_stat_activity_count
pg_database_size_bytes
pg_replication_lag_seconds

# Elasticsearch
elasticsearch_cluster_health_status
elasticsearch_indices_docs_total
elasticsearch_indices_store_size_bytes

# Redis
redis_connected_clients
redis_memory_used_bytes
redis_keyspace_hits_total / redis_keyspace_misses_total
```

### Logging (Structured JSON)

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "service": "api-server",
  "traceId": "abc123",
  "spanId": "def456",
  "userId": "user-uuid",
  "method": "GET",
  "path": "/api/v1/search",
  "status": 200,
  "duration_ms": 45,
  "cache_hit": true
}
```

**Log Levels**:
- `error`: Failures requiring attention (5xx, unhandled exceptions)
- `warn`: Degraded behavior (retries, cache misses, rate limits)
- `info`: Request/response, major state changes
- `debug`: Detailed debugging (disabled in production)

### Tracing (OpenTelemetry)

Distributed traces across services:
```
[API Server] ---> [Redis] (cache lookup)
     |
     +---------> [Elasticsearch] (search query)
     |
     +---------> [PostgreSQL] (data fetch)
     |
     +---------> [RabbitMQ] (publish event)
```

**Trace Context**: Propagated via `traceparent` header (W3C Trace Context).

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| p95 latency | > 300ms | > 500ms |
| Error rate (5xx) | > 1% | > 5% |
| DB connection pool exhausted | > 80% | > 95% |
| Cache hit rate | < 50% | < 30% |
| Queue depth (DLQ) | > 50 | > 100 |
| Disk usage | > 70% | > 85% |

## Failure Handling

### Retry Strategy

| Operation | Retries | Backoff | Timeout |
|-----------|---------|---------|---------|
| Database query | 2 | Exponential (100ms, 200ms) | 5s |
| Elasticsearch query | 2 | Exponential (50ms, 100ms) | 3s |
| Redis operation | 1 | Immediate | 500ms |
| RabbitMQ publish | 3 | Exponential (100ms base) | 2s |
| External API (if any) | 3 | Exponential (1s base) | 10s |

### Circuit Breaker Pattern

```typescript
// Circuit breaker states: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
const esCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,      // Open after 5 failures
  resetTimeout: 30000,      // Try again after 30s
  halfOpenRequests: 3       // Allow 3 test requests
});

// Usage
const results = await esCircuitBreaker.fire(() => elasticsearch.search(query));
```

**Fallback Behavior**:
- Elasticsearch down: Fall back to PostgreSQL full-text search (slower but functional)
- Redis down: Sessions from PostgreSQL backup table, skip caching
- RabbitMQ down: Write to PostgreSQL outbox table, process later

### Idempotency

**Review Creation**:
- Client generates `Idempotency-Key` header (UUID)
- Server checks Redis for existing key before processing
- Key stored for 24 hours to handle retries

```typescript
// Idempotency middleware
const idempotencyKey = req.headers['idempotency-key'];
if (idempotencyKey) {
  const existing = await redis.get(`idempotency:${idempotencyKey}`);
  if (existing) return res.json(JSON.parse(existing));
}

// Process request...

if (idempotencyKey) {
  await redis.setex(`idempotency:${idempotencyKey}`, 86400, JSON.stringify(result));
}
```

### Disaster Recovery (Local Dev)

For local development, simplified DR:

1. **Database Backup**: `pg_dump` script, daily cron
2. **Elasticsearch Re-index**: Full re-index from PostgreSQL on demand
3. **MinIO**: Local filesystem backup

**Production Considerations** (not implemented for local dev):
- Multi-region PostgreSQL replication
- Elasticsearch cross-cluster replication
- S3 cross-region replication
- RTO: 1 hour, RPO: 5 minutes

## Scalability Considerations

### Horizontal Scaling Path

| Component | Scaling Strategy | Trigger |
|-----------|-----------------|---------|
| API Servers | Add instances behind LB | CPU > 70%, RPS > threshold |
| PostgreSQL | Read replicas, then sharding by city | Reads > 10K/s |
| Elasticsearch | Add nodes to cluster | Index size > 50GB |
| Redis | Redis Cluster (16K slots) | Memory > 80% |
| RabbitMQ | Clustering + federation | Queue depth growing |

### Database Sharding Strategy (Future)

When single PostgreSQL instance is insufficient:

1. **Shard by city/region**: Most queries are geo-local
2. **Shard key**: `city_id` or geohash prefix
3. **Cross-shard queries**: Scatter-gather for global searches

### Read Replica Configuration

```
                    +-------------+
                    | Primary DB  |  <-- Writes
                    +------+------+
                           |
            +--------------+--------------+
            |              |              |
      +-----v-----+  +-----v-----+  +-----v-----+
      | Replica 1 |  | Replica 2 |  | Replica 3 |  <-- Reads
      +-----------+  +-----------+  +-----------+
```

Replication lag: < 100ms acceptable for this use case (eventual consistency for reads).

## Trade-offs and Alternatives

### PostgreSQL + PostGIS vs. MongoDB + GeoJSON

**Chose PostgreSQL because**:
- ACID transactions for review/rating consistency
- Mature PostGIS with rich spatial functions
- Simpler operational model (single RDBMS)

**Trade-off**: MongoDB's flexible schema might speed initial development, but PostgreSQL's constraints catch bugs early.

### Elasticsearch vs. PostgreSQL Full-Text Search

**Chose Elasticsearch because**:
- Better relevance tuning (BM25, custom scoring)
- Native geo_distance sorting
- Faceted search (aggregations) out of the box
- Autocomplete with edge n-grams

**Trade-off**: Adds operational complexity and sync requirements. For < 100K businesses, PostgreSQL `tsvector` + `pg_trgm` might suffice.

### Redis vs. Memcached

**Chose Redis/Valkey because**:
- Data structures (sorted sets for leaderboards, hashes for sessions)
- Persistence options if needed
- Pub/sub for real-time features (future)

**Trade-off**: Memcached has simpler multi-threaded model, but Redis's feature set wins for this use case.

### RabbitMQ vs. Kafka

**Chose RabbitMQ because**:
- Simpler for request-response and work queues
- Built-in DLQ, priority queues, TTL
- Lower resource footprint for local dev

**Trade-off**: Kafka better for event sourcing, high-throughput streams, replay. If adding analytics pipeline, consider Kafka.

## Cost Tradeoffs (Production Estimates)

| Component | Local Dev Cost | Production Monthly (AWS) |
|-----------|---------------|-------------------------|
| PostgreSQL | Free (Docker) | $200-500 (RDS db.r6g.large) |
| Elasticsearch | Free (Docker) | $300-600 (OpenSearch m6g.large) |
| Redis | Free (Docker) | $50-100 (ElastiCache r6g.large) |
| Object Storage | Free (MinIO) | $50-100 (S3, ~500GB) |
| Compute (API) | Free (local) | $200-400 (3x t3.medium) |
| **Total** | $0 | **$800-1700/month** |

**Cost Optimization Strategies**:
- Reserved instances for predictable workloads (30-40% savings)
- S3 Intelligent Tiering for photos
- Elasticsearch UltraWarm for old data
- Spot instances for index workers

## Future Optimizations

### Short-term (Next Iteration)
- [ ] Implement Bayesian rating for fairer ranking (account for review count)
- [ ] Add review photo uploads with automatic resizing
- [ ] Implement spam detection (naive Bayes classifier)
- [ ] Add real-time review notifications via WebSocket

### Medium-term
- [ ] Map-based browsing with marker clustering
- [ ] Personalized search ranking (user preferences, history)
- [ ] Business owner analytics dashboard
- [ ] Mobile app API optimization (GraphQL or response compression)

### Long-term
- [ ] Machine learning for review sentiment analysis
- [ ] Recommendation engine ("Users who liked X also liked Y")
- [ ] Multi-language support with translation API
- [ ] Real-time bidding for featured placements

## Monitoring and Observability Dashboard

### Grafana Dashboard Panels

1. **Overview**
   - Request rate (RPS) by endpoint
   - Error rate (5xx percentage)
   - p50/p95/p99 latency

2. **Database**
   - Query duration histogram
   - Active connections
   - Replication lag

3. **Search**
   - Elasticsearch query latency
   - Index size and document count
   - Cache hit ratio

4. **Queue**
   - Message publish/consume rate
   - Queue depth
   - DLQ size

5. **Business Metrics**
   - Reviews per hour
   - Searches per hour
   - New user signups

---

*Architecture document for local development learning project. Production deployment would require additional considerations for multi-region, compliance, and operational runbooks.*
