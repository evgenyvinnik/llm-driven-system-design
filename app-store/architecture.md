# Design App Store - Architecture

## System Overview

App Store is a digital marketplace for applications with discovery and purchases. Core challenges involve ranking, review integrity, and scalable delivery.

**Learning Goals:**
- Build ranking and recommendation systems
- Design review integrity systems
- Implement secure purchase flows
- Handle large-scale content delivery

---

## Requirements

### Functional Requirements

1. **Discover**: Search and browse apps by category, keyword, and chart rankings
2. **Purchase**: Buy apps and subscriptions with receipt validation
3. **Review**: Rate and review apps with integrity scoring
4. **Update**: Download updates with delta delivery
5. **Develop**: Submit and manage apps through a developer portal

### Non-Functional Requirements

- **Scale**: 2M+ apps, billions of downloads
- **Availability**: 99.99% for purchases, 99.9% for search
- **Latency**: p99 < 100ms for search results, p99 < 200ms for catalog reads
- **Integrity**: Manipulation-resistant rankings via multi-signal scoring
- **Consistency**: Strong consistency for purchases, eventual consistency for rankings and analytics
- **Throughput**: 100K+ concurrent browsing users, 1K+ purchases/second during peak events

---

## Capacity Estimation

| Metric | Value |
|--------|-------|
| Total apps | 2M+ |
| Daily active users | 50M |
| Daily downloads | 100M |
| Daily reviews | 1M |
| Average app size | 100 MB |
| Search queries/second (peak) | 50K |
| Purchases/second (peak) | 5K |
| Total storage (binaries) | 200 PB |

**Storage breakdown:**
- App binaries: 2M apps x 100 MB average = 200 TB (plus version history ~5x = 1 PB)
- Screenshots/media: 2M apps x 10 screenshots x 2 MB = 40 TB
- Database (metadata, reviews, purchases): ~500 GB
- Search index: ~50 GB

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│              iPhone │ iPad │ Mac │ Apple TV                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         CDN                                     │
│        (App binaries, screenshots, static assets)               │
│          CloudFront / Akamai - 200+ edge locations              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│        Rate limiting, auth, request routing, TLS                │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Catalog Service│    │Purchase Service│    │Review Service │
│               │    │               │    │               │
│ - Search      │    │ - Checkout    │    │ - Ratings     │
│ - Rankings    │    │ - Subs        │    │ - Moderation  │
│ - Recs        │    │ - Receipts    │    │ - Integrity   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Message Broker (Kafka)                        │
│     purchase.completed, review.created, app.updated             │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Ranking Worker │    │Payout Worker  │    │Integrity      │
│(batch hourly) │    │(per purchase) │    │Worker (ML)    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│  PostgreSQL  │Elasticsearch │    Redis     │   Object Storage   │
│  (metadata,  │  (search,    │  (sessions,  │   (S3: binaries,   │
│   purchases, │   filters,   │   cache,     │    screenshots,    │
│   reviews)   │   suggest)   │   rankings)  │    icons)          │
└──────────────┴──────────────┴──────────────┴────────────────────┘
```

---

## Core Components

### 1. App Ranking

The ranking system combines multiple signals to resist manipulation. A single signal (e.g., download count) is trivially gameable; combining velocity, quality, engagement, revenue, and freshness forces attackers to sustain organic-looking behavior across all dimensions simultaneously.

**Multi-Factor Ranking Algorithm:**

The ranking score for each app combines five signals with learned weights:

1. **Download velocity** (weight 0.30) -- Recent downloads weighted by exponential decay with a 7-day half-life, normalized by category median. This rewards sustained organic growth over one-time spikes.
2. **Rating quality** (weight 0.25) -- Bayesian average with confidence parameter C=100 and global mean m=3.5. New apps with few reviews converge to the global average rather than dominating with a handful of 5-star reviews. A count multiplier penalizes apps with fewer than 50 ratings.
3. **Engagement** (weight 0.20) -- DAU/MAU ratio, average session length, and 7-day retention, each contributing equally. These signals are hard to fake because they require real user behavior over time.
4. **Revenue** (weight 0.15) -- For Top Grossing charts. Log-normalized to prevent a single whale app from dominating.
5. **Freshness** (weight 0.10) -- Bonus for recently published or updated apps, decaying over 30 days.

Rankings are precomputed hourly per category and country, stored in a `rankings` table. Clients read from cache (Redis) with fallback to PostgreSQL.

### 2. Search Service

Search uses Elasticsearch with a two-phase approach: text relevance followed by quality re-ranking.

**Phase 1 -- Text Matching:**
- Multi-match across `name` (3x boost), `developer` (2x), `description`, and `keywords`
- Fuzzy matching with `fuzziness: AUTO` for typo tolerance
- Filters for category, price type (free/paid), minimum rating

**Phase 2 -- Quality Re-ranking:**
- Combines text relevance score (60%) with quality signals (40%)
- Quality signals: average rating, log(rating count), log(downloads), engagement score
- Result: users see relevant apps that are also high quality

### 3. Purchase Service

Purchases require strong consistency and idempotency to prevent double charges.

**Purchase flow:**
1. Client sends purchase request with idempotency key
2. Server validates price, checks for existing purchase
3. Payment provider charges user (circuit breaker protected)
4. Within a serializable transaction: create purchase record, grant app access, increment download count
5. Generate cryptographically signed receipt
6. Publish `purchase.completed` event for async processing (payout calculation, analytics)
7. Store idempotency result in Redis (24-hour TTL)

**Receipt validation:** Clients can verify receipts by sending receipt data to a validation endpoint. The server decodes the receipt, verifies the cryptographic signature, and checks the purchase record in the database.

### 4. Review Integrity

The integrity scoring system uses six weighted signals to detect fake reviews:

| Signal | Weight | Description |
|--------|--------|-------------|
| Review velocity | 0.15 | Flags users posting >5 reviews/day (score: 0.2) or >2/day (score: 0.6) |
| Content quality | 0.25 | Detects generic phrases ("great app", "love it"), rewards length and specificity |
| Account age | 0.10 | New accounts (<1 day: 0.3, <7 days: 0.6, <30 days: 0.8) |
| Verified purchase | 0.20 | Users who downloaded the app score 1.0; others score 0.3 |
| Coordination | 0.20 | Detects review spikes (>5x daily average triggers 0.3 score) |
| Originality | 0.10 | Text similarity check against other reviews for the same app |

Reviews scoring below 0.6 are held for moderation (`status: 'pending'`). A background worker performs deeper analysis using cross-app user patterns (e.g., users who only give 5-star or 1-star reviews are penalized further).

### 5. Recommendations

Personalized suggestions using three approaches:

1. **Content-based** ("Because you downloaded X") -- Elasticsearch `more_like_this` query on app metadata to find similar apps within the same category.
2. **Collaborative filtering** ("Apps You Might Like") -- User embedding vectors compared via approximate nearest neighbor search. Users with similar download histories get similar recommendations.
3. **Category trending** ("Popular in [Category]") -- Trending apps in the user's most-downloaded categories, excluding already-installed apps.

---

## Database Schema

```sql
-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(200),
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user', -- 'user', 'developer', 'admin'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Developers
CREATE TABLE IF NOT EXISTS developers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  email VARCHAR(200),
  website VARCHAR(500),
  description TEXT,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Categories
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  icon VARCHAR(50),
  parent_id UUID REFERENCES categories(id),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Apps
CREATE TABLE IF NOT EXISTS apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id VARCHAR(200) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  developer_id UUID REFERENCES developers(id),
  category_id UUID REFERENCES categories(id),
  description TEXT,
  short_description VARCHAR(500),
  keywords TEXT[],
  release_notes TEXT,
  version VARCHAR(50),
  size_bytes BIGINT,
  age_rating VARCHAR(20),
  is_free BOOLEAN DEFAULT TRUE,
  price DECIMAL DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'USD',
  download_count BIGINT DEFAULT 0,
  rating_sum DECIMAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  average_rating DECIMAL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft', -- 'draft', 'pending', 'published', 'rejected', 'removed'
  published_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apps_category ON apps(category_id);
CREATE INDEX IF NOT EXISTS idx_apps_developer ON apps(developer_id);
CREATE INDEX IF NOT EXISTS idx_apps_bundle ON apps(bundle_id);
CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);

-- App Screenshots
CREATE TABLE IF NOT EXISTS app_screenshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  url VARCHAR(500) NOT NULL,
  device_type VARCHAR(50) DEFAULT 'phone',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- App Prices (per country)
CREATE TABLE IF NOT EXISTS app_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  country VARCHAR(2),
  price_tier INTEGER,
  amount DECIMAL,
  currency VARCHAR(3),
  type VARCHAR(20),   -- 'one_time', 'subscription'
  period VARCHAR(20)  -- 'monthly', 'yearly'
);

-- Purchases
CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  app_id UUID REFERENCES apps(id),
  price_id UUID REFERENCES app_prices(id),
  amount DECIMAL,
  currency VARCHAR(3),
  payment_id VARCHAR(100),
  receipt_data TEXT,
  purchased_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  app_id UUID REFERENCES apps(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  body TEXT,
  app_version VARCHAR(50),
  helpful_count INTEGER DEFAULT 0,
  not_helpful_count INTEGER DEFAULT 0,
  integrity_score DECIMAL,
  status VARCHAR(20) DEFAULT 'pending',
  developer_response TEXT,
  developer_response_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_app ON reviews(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);

-- Review Votes
CREATE TABLE IF NOT EXISTS review_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  helpful BOOLEAN NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(review_id, user_id)
);

-- Daily Rankings (precomputed)
CREATE TABLE IF NOT EXISTS rankings (
  date DATE,
  country VARCHAR(2),
  category VARCHAR(100),
  rank_type VARCHAR(20), -- 'free', 'paid', 'grossing'
  app_id UUID REFERENCES apps(id),
  rank INTEGER,
  PRIMARY KEY (date, country, category, rank_type, app_id)
);

-- Download Events
CREATE TABLE IF NOT EXISTS download_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id),
  user_id UUID,
  version VARCHAR(50),
  country VARCHAR(2),
  device_type VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_download_events_app ON download_events(app_id, created_at DESC);

-- User Apps (installed/downloaded)
CREATE TABLE IF NOT EXISTS user_apps (
  user_id UUID REFERENCES users(id),
  app_id UUID REFERENCES apps(id),
  download_count INTEGER DEFAULT 1,
  last_downloaded_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, app_id)
);

-- Event Outbox (for reliable event publishing)
CREATE TABLE IF NOT EXISTS event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_unpublished
  ON event_outbox(published, created_at) WHERE published = FALSE;
```

---

## API Design

### Catalog API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/apps/:id` | Get app details |
| GET | `/api/v1/apps/search?q=&category=&price=&rating=` | Search apps |
| GET | `/api/v1/categories` | List categories |
| GET | `/api/v1/categories/:slug/apps` | Apps in category |
| GET | `/api/v1/charts/:type` | Top charts (free, paid, grossing) |
| GET | `/api/v1/apps/:id/similar` | Similar app recommendations |

### Review API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/apps/:id/reviews?page=&sortBy=` | Get paginated reviews |
| POST | `/api/v1/apps/:id/reviews` | Submit review (auth required) |
| PUT | `/api/v1/reviews/:id` | Update review (auth, owner) |
| DELETE | `/api/v1/reviews/:id` | Delete review (auth, owner) |
| POST | `/api/v1/reviews/:id/vote` | Vote helpful/not helpful |
| POST | `/api/v1/reviews/:id/respond` | Developer response (auth, dev) |

### Purchase API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/purchases` | Purchase app (idempotency key required) |
| POST | `/api/v1/purchases/verify` | Verify receipt |
| GET | `/api/v1/purchases/history` | User purchase history |

### Developer API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/developer/apps` | List developer's apps |
| POST | `/api/v1/developer/apps` | Create new app |
| PUT | `/api/v1/developer/apps/:id` | Update app metadata |
| POST | `/api/v1/developer/apps/:id/screenshots` | Upload screenshots |
| GET | `/api/v1/developer/apps/:id/analytics` | App analytics |

### Auth API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/register` | Create account |
| POST | `/api/v1/auth/login` | Login (session cookie) |
| POST | `/api/v1/auth/logout` | Logout |
| GET | `/api/v1/auth/me` | Current user |

### Monitoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Full health check |
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe |
| GET | `/metrics` | Prometheus metrics |

---

## Key Design Decisions

### 1. Bayesian Rating Average vs. Simple Average

**Chosen**: Bayesian average with confidence parameter C=100 and global mean m=3.5.

A simple average is unfair to new apps: an app with two 5-star reviews (average: 5.0) would outrank an established app with thousands of reviews averaging 4.7. The Bayesian approach pulls low-sample-size ratings toward the global mean, so gaming with a few early reviews is ineffective. The trade-off is that new apps need ~50 reviews before their true rating emerges, which can frustrate small developers. We mitigate this with a freshness bonus in the ranking algorithm.

### 2. Multi-Signal Ranking vs. Download Count

**Chosen**: Multi-signal ranking combining five dimensions.

Download count alone creates a winner-takes-all dynamic where established apps dominate forever, and sophisticated actors can inflate counts with bot downloads. By requiring sustained engagement (DAU/MAU, retention), genuine quality (ratings from verified purchasers), and revenue, an attacker would need to maintain fake users over weeks with realistic behavior patterns -- orders of magnitude more expensive than inflating a single metric. The trade-off is complexity: the ranking pipeline requires engagement telemetry, which adds data collection overhead and privacy considerations.

### 3. Elasticsearch for Search vs. PostgreSQL Full-Text Search

**Chosen**: Elasticsearch for primary search.

PostgreSQL's `tsvector` full-text search works for simple keyword matching but lacks fuzzy matching, suggestion generation, `more_like_this` for recommendations, and custom scoring functions. With 2M apps and 50K queries/second, Elasticsearch's inverted index and distributed architecture provide the latency and throughput needed. The trade-off is operational complexity: Elasticsearch requires its own cluster, index management, and monitoring. We mitigate downtime risk with a circuit breaker that falls back to PostgreSQL full-text search when Elasticsearch is unavailable.

### 4. RabbitMQ for Async Processing (Local) / Kafka at Scale

**Chosen**: RabbitMQ locally, Kafka at production scale.

For the local implementation, RabbitMQ provides durable, ordered message processing with explicit acknowledgments, dead letter queues, and a management UI -- all sufficient for learning async patterns. At production scale with 100M daily events, Kafka's partitioned log model provides better throughput, replay capability, and consumer group scaling. The local RabbitMQ setup uses the same exchange/queue/routing-key patterns that would map to Kafka topics and consumer groups.

---

## Consistency and Idempotency

### Consistency Model by Operation

| Operation | Consistency Level | Rationale |
|-----------|-------------------|-----------|
| Purchase creation | **Strong (serializable)** | Financial correctness requires no double-charges |
| Review submission | **Strong (read-your-writes)** | User sees their review immediately |
| Download count increment | **Eventual** | Slight delays acceptable for analytics |
| Ranking updates | **Eventual (batch)** | Rankings recomputed hourly, lag is acceptable |
| Search index updates | **Eventual (~5s)** | New apps appear shortly after publish |

### Idempotency Keys

All mutating operations that interact with payment or critical state use client-provided idempotency keys stored in Redis:

1. **Check** for existing result with idempotency key
2. If found, return cached result (duplicate request)
3. If not found, **acquire lock** via Redis `SET NX EX 30`
4. If lock acquired, **process** request and **cache** result (24-hour TTL)
5. If lock not acquired, return `409 Conflict` ("Request in progress")

**Key patterns:**
- **Purchases**: `{userId}:{appId}:{timestamp_bucket}` -- prevents double-purchase within 1-minute window
- **Reviews**: `{userId}:{appId}` -- one review per user per app, upsert semantics
- **Developer payouts**: `{developerId}:{period}` -- one payout per billing period

### Conflict Resolution

| Resource | Strategy | Implementation |
|----------|----------|----------------|
| App metadata | Optimistic locking with version | `UPDATE apps SET ... WHERE id = $1 AND version = $2` |
| Reviews | One per user per app | `ON CONFLICT (user_id, app_id) DO UPDATE` |
| Developer response | Last-write-wins | Single developer per app simplifies this |
| Rankings | Batch recompute | No conflicts -- read-only table rebuilt hourly |

---

## Security and Auth

- **Session-based auth** with Redis-backed cookies (`express-session` + `ioredis`)
- **Role-based access control**: `user`, `developer`, `admin` roles on the `users` table
- **Password hashing** with bcrypt (cost factor 12)
- **CORS** restricted to known frontend origins
- **Helmet** for security headers (CSP, HSTS, X-Frame-Options)
- **Rate limiting** per user and per IP (configurable per endpoint)
- **Input validation** with `express-validator` on all endpoints
- **Idempotency keys** on all mutating endpoints to prevent CSRF-style replay

---

## Observability

### Prometheus Metrics

The application exposes a `/metrics` endpoint in Prometheus format with the following metric categories:

| Category | Metrics | Purpose |
|----------|---------|---------|
| HTTP | Request duration histogram, request count, active connections | SLA tracking, capacity planning |
| Database | Query duration histogram, pool utilization gauge | Query optimization, connection management |
| Cache | Hit/miss counter, operation duration | Cache effectiveness tuning |
| Message Queue | Published/consumed counters, processing duration, queue depth | Backpressure detection, worker scaling |
| Circuit Breaker | State gauge, failure/success counters | Dependency health visibility |
| Business | Downloads, reviews submitted, purchases, revenue | Business impact correlation |

### Structured Logging

Pino structured JSON logging with child loggers for request context propagation. Development mode uses `pino-pretty` for human-readable output; production mode outputs raw JSON for log aggregation.

### Health Checks

Three-tier health check system:
- `/health/live` -- Lightweight liveness probe (process running)
- `/health/ready` -- Readiness probe (PostgreSQL + Redis healthy)
- `/health` -- Comprehensive check (all dependencies, queue depths, circuit breaker states)

---

## Failure Handling

### Circuit Breaker Pattern

External service calls use the circuit breaker pattern with three states:

| Service | Timeout | Failure Threshold | Reset Timeout | Fallback |
|---------|---------|-------------------|---------------|----------|
| Payment | 5s | 30% | 60s | "Try again later", preserve cart |
| Elasticsearch | 10s | 50% | 30s | PostgreSQL full-text search |
| RabbitMQ | N/A | N/A | N/A | Outbox table in PostgreSQL |

### Retry Strategy

Exponential backoff with jitter for all retryable operations:
- Base delay: 1s, multiplier: 2x, max delay: 30s, max retries: 3
- Non-retryable: 4xx errors (except 429), business logic errors (`ALREADY_PURCHASED`, `INVALID_PRICE`)

### Graceful Degradation

| Dependency | Failure Mode | Degradation |
|------------|--------------|-------------|
| Elasticsearch | Circuit open | Fall back to PostgreSQL `ts_vector` search (slower, no fuzzy) |
| Redis (cache) | Connection lost | Bypass cache, hit database directly |
| Redis (sessions) | Connection lost | Reject new logins; existing in-flight requests complete |
| RabbitMQ | Broker down | Write to `event_outbox` table, replay on recovery (outbox pattern) |
| Payment provider | Timeout | Show "try again later", preserve cart state in Redis |

### Outbox Pattern

When RabbitMQ is unavailable, events are written to the `event_outbox` table in PostgreSQL within the same transaction as the business operation. A background poller runs every 10 seconds, reads unpublished events, publishes them to RabbitMQ, and marks them as published. Events that fail after 5 retries are logged for manual investigation.

---

## Scalability Considerations

### What Breaks First

1. **Search queries** -- At 50K QPS, a single Elasticsearch node saturates. Scale with sharded indices (shard per category group) and read replicas.
2. **App binary downloads** -- 100M daily downloads at 100 MB average = 10 PB/day egress. CDN is mandatory; origin serves <1% of requests.
3. **Purchase spikes** -- Flash sales can 10x normal purchase rate. Horizontal scaling of purchase service instances behind the API gateway, with idempotency preventing duplicates during retries.
4. **Review write storms** -- App launches or controversies trigger review spikes. Queue-based processing absorbs bursts; integrity scoring runs asynchronously.

### Horizontal Scaling Path

- **Catalog/Search**: Stateless services behind load balancer. Elasticsearch cluster scales with shards and replicas.
- **Purchase**: Stateless services with Redis-backed idempotency. Database write scaling via partitioning by user_id.
- **Reviews**: Write-heavy path scales via queue buffering. Read path scales with Redis cache.
- **Rankings**: Batch compute job scales independently. Results cached in Redis with 1-hour TTL.

### Sharding Strategy

- **Apps table**: Shard by `category_id` (co-locates apps in same category for chart queries)
- **Purchases**: Shard by `user_id` (co-locates user's purchase history)
- **Reviews**: Shard by `app_id` (co-locates all reviews for an app)
- **Download events**: Time-partitioned (monthly) with automatic partition pruning

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Ranking | Multi-signal scoring | Download count alone | Manipulation resistance at cost of pipeline complexity |
| Reviews | ML integrity scoring | Manual moderation only | Scales to 1M reviews/day; manual moderation doesn't |
| Search | Elasticsearch | PostgreSQL FTS | Fuzzy matching, suggestions, performance at 50K QPS |
| Recommendations | Hybrid (content + CF) | Pure collaborative filtering | Handles cold-start for new apps/users |
| Message queue | RabbitMQ (local) / Kafka (prod) | In-process async | Durability, backpressure, worker scaling |
| Consistency | Strong for payments, eventual for analytics | All strong | Availability and performance for non-critical paths |
| Idempotency | Redis-backed client keys | Database constraints only | Handles network retries, concurrent requests gracefully |
| Session auth | Redis + cookie | JWT | Immediate revocation, simpler token management |

---

## Implementation Notes

This section maps the production architecture above to what is actually running locally.

### Local Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                     Browser (localhost:5173)                       │
│       React 19 + TanStack Router + Zustand + Tailwind             │
└───────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────┐
│                Express Server (localhost:3000)                     │
│         Single process, all routes in one service                 │
│         Auth, Catalog, Review, Developer controllers              │
├───────────────────────────────────────────────────────────────────┤
│  Middleware: CORS, Helmet, Pino HTTP logging, Metrics, Auth       │
│  Workers: downloadWorker (separate process), reviewWorker         │
└───────────────────────────────────────────────────────────────────┘
     │              │              │             │            │
     ▼              ▼              ▼             ▼            ▼
┌─────────┐  ┌───────────┐  ┌──────────┐  ┌─────────┐  ┌────────┐
│Postgres │  │Elastic-   │  │Redis/    │  │RabbitMQ │  │MinIO   │
│:5432    │  │search     │  │Valkey    │  │:5672    │  │:9000   │
│         │  │:9200      │  │:6379     │  │:15672   │  │:9001   │
│appstore │  │           │  │sessions, │  │events,  │  │icons,  │
│database │  │apps index │  │cache     │  │tasks    │  │screens │
└─────────┘  └───────────┘  └──────────┘  └─────────┘  └────────┘
```

### Production-Grade Patterns Actually Implemented

**1. Structured Logging (Pino)**
- JSON structured logs with child loggers for request context
- Dev mode: `pino-pretty` for readability; prod mode: raw JSON
- File: `backend/src/shared/logger.ts`

**2. Prometheus Metrics (prom-client)**
- HTTP request duration/count, DB query latency, cache hit/miss, queue depth, circuit breaker state, business metrics (downloads, reviews, purchases)
- Exposed at `/metrics` endpoint
- File: `backend/src/shared/metrics.ts`

**3. Comprehensive Health Checks**
- `/health/live` (liveness), `/health/ready` (Postgres + Redis), `/health` (all deps + queue depths + circuit breakers)
- File: `backend/src/shared/health.ts`

**4. Idempotency (Redis-backed)**
- `checkIdempotency` / `storeIdempotentResult` with Redis NX locks and 24-hour TTL
- Express middleware `idempotencyMiddleware` for endpoint-level usage
- File: `backend/src/shared/idempotency.ts`

**5. Circuit Breaker (Opossum)**
- Pre-configured breakers for payment (5s timeout, 30% threshold) and Elasticsearch (10s, 50%)
- Metrics integration for state tracking
- File: `backend/src/shared/circuitBreaker.ts`

**6. RabbitMQ Async Processing**
- Topic exchange for event fanout, direct exchange for tasks, dead letter exchange for failures
- Two workers: `downloadWorker` (analytics), `reviewWorker` (deep integrity analysis)
- At-least-once delivery with idempotent consumers and exponential backoff retry
- File: `backend/src/shared/queue.ts`, `backend/src/workers/downloadWorker.ts`, `backend/src/workers/reviewWorker.ts`

**7. Review Integrity Scoring**
- Six-signal weighted scoring (velocity, content quality, account age, verified purchase, coordination, originality)
- Deep async analysis via review worker
- File: `backend/src/services/reviewService.ts`

### Simplifications vs. Production

| Area | Production | Local Implementation |
|------|-----------|---------------------|
| Services | Separate microservices (Catalog, Purchase, Review) | Single Express process with controller separation |
| Message queue | Kafka with partitioned topics | RabbitMQ with topic exchange |
| Auth | OAuth 2.0 / SSO | Session-based with Redis cookies |
| Object storage | AWS S3 + CloudFront CDN | MinIO (S3-compatible) on localhost:9000 |
| Database | Sharded PostgreSQL with read replicas | Single PostgreSQL instance |
| Elasticsearch | Multi-node cluster with sharded indices | Single-node, no replicas |
| Payment | Payment provider integration (Stripe/Apple Pay) | Simulated payment (no real charges) |
| ML ranking | ML model for ranking weights | Fixed weights in code |
| Recommendations | Vector DB + collaborative filtering | Elasticsearch `more_like_this` |
| Multi-region | Geo-distributed with CDN | Single machine |

### What Was Omitted

- CDN for app binaries and screenshots
- Multi-region deployment and geo-routing
- Kubernetes orchestration and auto-scaling
- Real payment provider integration
- ML pipeline for ranking weight optimization
- App binary delta updates
- Subscription lifecycle management (renewal, cancellation, grace periods)
- Admin moderation dashboard
- Editorial content and curated collections
- App review (submission approval) pipeline

### Running Locally

```bash
# Terminal 1: Infrastructure
docker-compose up -d

# Terminal 2: Database setup + backend
cd backend && npm run db:migrate && npm run seed && npm run dev

# Terminal 3: Download worker
cd backend && npm run dev:download-worker

# Terminal 4: Review worker
cd backend && npm run dev:review-worker

# Terminal 5: Frontend
cd frontend && npm run dev

# Endpoints
# Frontend:           http://localhost:5173
# Backend API:        http://localhost:3000/api/v1
# Prometheus Metrics: http://localhost:3000/metrics
# Health Check:       http://localhost:3000/health
# RabbitMQ Mgmt:      http://localhost:15672 (appstore/appstore_pass)
# MinIO Console:      http://localhost:9001 (minio_admin/minio_password)
```
