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

## Frontend Architecture

### Technology Stack

React 19 + TypeScript + Vite + TanStack Router (file-based routing) + Zustand (state management) + Tailwind CSS + Lucide React (icons).

### Component Hierarchy

```
__root.tsx (Header + Footer layout)
├── index.tsx              → HomePage: hero search bar, category grid, featured businesses
├── search.tsx             → SearchPage: sidebar filters + business result list + pagination
├── business.$slug.tsx     → BusinessDetailPage: photo gallery, header, reviews, sidebar
├── dashboard.tsx          → DashboardPage: user's businesses + reviews tabs
├── dashboard.business.$id → Business management (edit info, respond to reviews)
├── dashboard.business.new → New business form
├── admin.tsx              → AdminPage: tabbed dashboard (overview, users, businesses, reviews)
├── profile.tsx            → User profile page
├── login.tsx              → Login form
└── register.tsx           → Registration form
```

### Zustand Stores

**`authStore`** -- manages user session, login, registration, logout, and session validation via `/api/auth/me`. Uses `zustand/persist` middleware to hydrate auth state from `localStorage` across page reloads. Stores `user` object and `isAuthenticated` flag. Partial persistence ensures only `user` and `isAuthenticated` survive refresh, while `isLoading` resets on each load.

**`searchStore`** -- manages the search results page state: current `businesses` array, `pagination` metadata, `filters` object (query, category, latitude, longitude, distance, minRating, maxPriceLevel, sortBy), and loading/error states. The `search()` action builds URL params from the filters object and calls `GET /api/search`. The `setFilters()` action merges partial filter updates into the existing filter state without triggering a search, allowing the UI to batch filter changes before calling `search()`.

### Routing and URL-Driven Search

TanStack Router's file-based routing maps filesystem paths to URL segments. The `search.tsx` route uses `validateSearch` to parse URL query params (`q`, `category`, `location`, `minRating`, `maxPrice`, `sortBy`) into typed search parameters. This means search state is URL-driven -- users can share or bookmark search URLs and get the same results. The search page watches URL params via `Route.useSearch()` and triggers `searchStore.search()` when they change.

The `business.$slug.tsx` route uses `Route.useParams()` to extract the business slug from the URL, enabling deep links to any business profile page.

### Data Fetching Patterns

All data fetching uses the centralized `api` service (`services/api.ts`), which wraps `fetch` with JSON serialization, `credentials: 'include'` for cookie-based session auth, and error handling that extracts error messages from API responses.

**Parallel data loading**: The home page and business detail page use `Promise.all` to fetch independent data sources simultaneously. For example, the home page fetches categories and featured businesses in parallel, and the business detail page fetches business data and reviews in parallel. This halves the perceived loading time compared to sequential fetches.

**Lazy tab loading**: The admin dashboard only fetches data for the active tab. Switching tabs triggers a new API call for that tab's data. This avoids loading all admin data upfront, which would be wasteful since admins typically focus on one section at a time.

### Search Filters UI

The search page implements a dual-layout filter system. On desktop (lg breakpoint and above), a persistent 256px sidebar shows radio-button category filters, star-rating filters, and price-level toggle buttons. On mobile, filters are hidden behind a toggle button that reveals a collapsible filter panel with dropdown selects. Both layouts call the same `applyFilters()` function, which passes the current filter state to `searchStore.search()`.

The sort dropdown triggers an immediate search (no "Apply" button required) because sort order is a lightweight operation that does not change the result set, only its ordering.

### Optimistic Updates

The business detail page implements optimistic UI updates for review voting. When a user clicks "Helpful", "Funny", or "Cool" on a review, the UI immediately increments the vote count in the local `reviews` state array without waiting for the API response. This provides instant visual feedback. If the API call fails, the error is logged but the UI is not rolled back -- a pragmatic trade-off where showing a stale count briefly is preferable to a jarring UI flicker.

### Loading States and Skeleton Screens

Every page that fetches data renders skeleton placeholders during loading. These are Tailwind-based `animate-pulse` divs that mirror the layout of the real content. The home page shows a 4-column grid of skeleton cards, the search page shows 5 skeleton result rows, and the business detail page shows a skeleton for the image and title area. Skeletons reduce perceived load time because the page structure appears immediately, giving the user visual anchors while content loads.

### Admin Dashboard

The admin page enforces role-based access on the client side by checking `user.role === 'admin'` and redirecting non-admins. It uses a tabbed interface with four sections (Overview, Users, Businesses, Reviews), each rendered by a dedicated component. Tab content components receive data and action callbacks as props, keeping them stateless and testable. The overview tab shows aggregate stats, the users tab supports role changes, the businesses tab supports verification toggling, and the reviews tab supports deletion.

### Key UI Patterns

- **Hero search**: Full-width background image with dual-input search form (query + location), immediately recognizable as a discovery-first interface
- **Category grid**: 8-column icon grid linking directly to pre-filtered search results
- **Business cards**: Two variants -- `BusinessCard` (list view for search results with rank number) and `BusinessGridCard` (card view for featured/home page)
- **Star rating**: Reusable `StarRating` component used across business cards, reviews, and filter controls
- **Photo gallery**: `PhotoGallery` component displaying business photos in a grid layout
- **Review form**: Toggle-revealed form with 1-5 star selection and text input, only shown to authenticated users

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation assumes no prior knowledge of the pattern.

### Role-Based Access Control (RBAC)

RBAC is a method of restricting system access based on the roles assigned to individual users. Instead of assigning permissions directly to each user (which does not scale -- imagine managing individual permissions for 100,000 users), you define a small set of roles, assign permissions to those roles, and then assign roles to users.

In this project, there are three roles: `user`, `business_owner`, and `admin`. A `user` can create and edit their own reviews and vote on other reviews. A `business_owner` inherits all user permissions and can additionally manage their own businesses (edit info, respond to reviews). An `admin` inherits all permissions and can additionally manage all users, moderate reviews, and verify businesses.

The implementation lives in `backend/src/middleware/auth.ts`. Every protected route passes through an authentication middleware that reads the session cookie, looks up the session in Redis, and attaches the user object (including their role) to the request. Role-checking middleware then compares the user's role against the required role for that endpoint. If the user lacks the required role, the request is rejected with a 403 Forbidden response before it reaches any business logic.

The key advantage over per-user permissions is maintainability. When you add a new feature (say, "pin a review"), you add the permission to the `admin` role once, and every admin user automatically gets it. Without RBAC, you would need to update permission records for every admin user individually.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. If the data is in the cache (a "cache hit"), it is returned immediately. If the data is not in the cache (a "cache miss"), the application queries the database, stores the result in the cache with a time-to-live (TTL), and then returns the result.

The critical property of cache-aside is that the cache is only populated on demand. This contrasts with "write-through" caching (where every database write also writes to the cache) and "write-behind" caching (where writes go to the cache first and are asynchronously flushed to the database). Cache-aside is simpler because the cache and database are not tightly coupled -- if the cache goes down, the application still works (just slower, hitting the database directly).

In this project, cache-aside is used for two data types. Search results are cached for 2 minutes using a SHA-256 hash of the query plus filters as the cache key. Business detail pages are cached for 5 minutes using the business ID as the cache key. The TTLs are deliberately short because search results and business data change frequently (new reviews, rating changes). A 2-minute TTL means at worst a user sees results that are 2 minutes stale, which is acceptable for a discovery platform.

The implementation in `backend/src/utils/redis.ts` follows a standard pattern: check cache, return on hit, query database on miss, write to cache, return result. Cache invalidation happens in two places: the TTL handles natural expiry, and the Index Worker explicitly invalidates business cache entries when it processes review-created events from RabbitMQ.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents an application from repeatedly calling a service that is failing. The concept is borrowed from electrical circuit breakers: when too much current flows, the breaker trips and stops the flow to prevent damage.

A circuit breaker has three states. In the **CLOSED** state (normal operation), all requests pass through to the downstream service. The breaker tracks failure counts. When failures exceed a threshold (e.g., 5 failures within 30 seconds), the breaker transitions to the **OPEN** state. In the OPEN state, all requests immediately fail without calling the downstream service, returning a fallback response instead. This prevents the application from wasting time and resources on a service that is clearly broken, and it gives the failing service breathing room to recover. After a timeout (e.g., 30 seconds), the breaker transitions to **HALF-OPEN** state, where it allows a small number of test requests through. If those test requests succeed, the breaker returns to CLOSED. If they fail, the breaker goes back to OPEN.

Without circuit breakers, a failing Elasticsearch cluster would cause every search request to hang for the full timeout period (e.g., 5 seconds) before failing, creating a cascading slowdown across the entire application. With a circuit breaker, the first few failures trip the breaker, and subsequent requests immediately get the fallback response (PostgreSQL full-text search in this project), taking milliseconds instead of seconds.

The implementation uses the Opossum library (`backend/src/utils/circuitBreaker.ts`). Opossum wraps any function and monitors its success/failure rate. When the circuit trips, it fires a `fallback` event that triggers the PostgreSQL search path. Prometheus metrics track the circuit state, allowing operators to see when and how often the breaker trips.

### Structured Logging

Structured logging means emitting log entries as machine-parseable data (typically JSON objects) rather than freeform text strings. A traditional log line like `"User 123 searched for pizza in San Francisco, 15 results, 45ms"` is easy for a human to read but difficult for a machine to parse. A structured log entry for the same event looks like `{"userId":"123","query":"pizza","location":"San Francisco","resultCount":15,"latencyMs":45,"level":"info","timestamp":"2024-01-15T10:30:00Z"}`.

The key advantages of structured logging are searchability and aggregation. With structured logs, you can query "show me all search requests with latency > 200ms in the last hour" by filtering on the `latencyMs` field. With freeform text, you would need complex regex patterns that break when someone changes the log format. Structured logs also integrate directly with log aggregation systems (ELK stack, Grafana Loki, Datadog) that can index JSON fields for fast querying.

In this project, structured logging is implemented using Pino (`backend/src/utils/logger.ts`). Pino is a JSON-first logger for Node.js that is significantly faster than alternatives like Winston because it writes JSON directly to stdout without string formatting. Every HTTP request gets a unique `requestId` (generated by middleware) that is attached to all log entries for that request, enabling correlation -- if a search request triggers a cache lookup, a database query, and an Elasticsearch call, all three log entries share the same `requestId`, making it possible to trace the full request lifecycle.

Sensitive fields like passwords and session tokens are automatically redacted from log output. Log levels follow a standard hierarchy: `error` for 5xx responses and unhandled exceptions, `warn` for retries, cache misses, and rate-limited requests, `info` for normal request/response logging, and `debug` for verbose output disabled in production.

### Prometheus Metrics

Prometheus is a time-series monitoring system where the application exposes numeric metrics at an HTTP endpoint (`/metrics`), and a Prometheus server periodically scrapes (fetches) that endpoint to collect the metrics. This "pull-based" model (Prometheus pulls metrics from the application) is simpler than "push-based" models (where the application pushes metrics to a monitoring server) because the application does not need to know the monitoring server's address or handle connection failures to the monitoring system.

Metrics come in four types. **Counters** are monotonically increasing values (e.g., `http_requests_total` -- the total number of HTTP requests served since the process started). **Gauges** can go up or down (e.g., `db_pool_connections` -- the current number of active database connections). **Histograms** track the distribution of values (e.g., `http_request_duration_seconds` -- how long requests take, bucketed into ranges like 0-10ms, 10-50ms, 50-100ms, etc.). **Summaries** are similar to histograms but calculate quantiles on the client side.

In this project, metrics are implemented using the `prom-client` library (`backend/src/utils/metrics.ts`). The key business metrics include `yelp_searches_total` (labeled by cache hit/miss, whether the search used geo-filtering, and whether it included a category filter), `yelp_search_duration_seconds` (how long searches take, broken down by cache hit/miss), `yelp_reviews_created_total` (labeled by rating value), and `yelp_circuit_breaker_state` (whether the Elasticsearch circuit breaker is open or closed).

These metrics enable dashboarding and alerting. For example, if the cache hit rate drops below 30%, it might indicate a Redis problem. If the p95 search latency exceeds 300ms, it might indicate Elasticsearch degradation.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. Without rate limiting, a single user (or bot) can overwhelm a service by sending thousands of requests per second, degrading performance for all other users. Rate limiting serves three purposes: preventing abuse, protecting backend resources from overload, and ensuring fair resource distribution among users.

In this project, rate limiting uses a multi-layer approach. Login attempts are limited to 5 per minute per IP address (preventing brute-force password attacks). Registration is limited to 3 per hour per IP (preventing spam account creation). Review creation is limited to 10 per hour per user ID (preventing review spam). Search queries are limited to 100 per minute per user ID or IP (preventing scraping).

The implementation uses sliding window counters in Redis (`backend/src/utils/reviewRateLimit.ts`). A sliding window is more accurate than a fixed window because it avoids the "boundary burst" problem. With a fixed 1-minute window, a user could make 100 requests in the last second of one window and 100 more in the first second of the next window, effectively making 200 requests in 2 seconds. A sliding window counts requests across a rolling time period, preventing this exploit.

The system uses a "fail-open" design: if Redis is unavailable, requests are allowed through rather than blocked. This is a deliberate trade-off -- briefly allowing unlimited requests during a Redis outage is preferable to making the entire application unavailable.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. This property is critical in distributed systems because networks are unreliable -- a client might send a request, the server processes it successfully, but the response gets lost. The client, seeing no response, retries the same request. Without idempotency, this retry creates a duplicate (e.g., a second review for the same business).

In this project, review submission uses idempotency keys. The client generates a unique UUID before sending the review request and includes it as an `Idempotency-Key` HTTP header. The server checks Redis for this key before processing the request. If the key exists, the server returns the cached response from the first request (no duplicate review is created). If the key does not exist, the server acquires a Redis lock, processes the request, caches the response keyed by the idempotency key, and returns the result. Keys expire after 24 hours.

The implementation in `backend/src/utils/idempotency.ts` handles a subtle edge case: concurrent retries. If two identical requests arrive simultaneously (the client retried before the first request finished), the Redis lock ensures only one of them processes the review. The second request waits briefly and then returns the cached response.

Note that idempotency keys and database unique constraints solve different problems. The `UNIQUE(business_id, user_id)` constraint prevents a user from reviewing the same business twice (a business rule). The idempotency key prevents the same review request from being processed twice due to network retries (an infrastructure concern).

### Health Checks

Health checks are HTTP endpoints that report whether a service is functioning correctly. They are used by load balancers, container orchestrators (like Kubernetes), and monitoring systems to determine whether a service instance should receive traffic.

There are typically three types of health checks. A **liveness check** (`/api/health`) returns 200 OK if the process is running and can respond to HTTP requests. If this fails, the process is likely crashed or deadlocked and should be restarted. A **readiness check** (`/api/health/ready`) returns 200 OK if the service is ready to handle traffic. A newly started instance might be alive but not ready (still establishing database connections or warming caches). A **detailed check** (`/api/health/detailed`) returns the status of each dependency (PostgreSQL, Redis, Elasticsearch, RabbitMQ) individually, which helps operators quickly identify which component is causing problems.

In this project, the detailed health check tests each dependency by running a lightweight operation: `SELECT 1` for PostgreSQL, `PING` for Redis, `GET _cluster/health` for Elasticsearch, and a channel check for RabbitMQ. Each dependency check has its own timeout (typically 2 seconds) so that a single slow dependency does not make the health check hang indefinitely. The response includes status per dependency and overall status -- overall status is "unhealthy" if any critical dependency (PostgreSQL) is down, and "degraded" if any non-critical dependency (Elasticsearch, which has a PostgreSQL fallback) is down.

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
