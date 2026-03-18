# Price Tracking Service - Architecture Design

## System Overview

An e-commerce price monitoring and alert system that scrapes product prices from online retailers, stores historical price data, and sends alerts to users when prices drop below their configured thresholds. The core challenge is building a reliable scraping pipeline that respects target site rate limits while providing near-real-time price change detection across millions of tracked products.

## Requirements

### Functional Requirements

- **Product tracking**: Users add products by URL; system extracts product metadata
- **Price scraping**: Automated periodic scraping of tracked product prices
- **Historical tracking**: Store and visualize price history over time with charts
- **Price alerts**: Notify users via email/push when prices drop below threshold
- **Price predictions**: Basic trend analysis to predict future price movements
- **Admin dashboard**: Monitor scraper health, manage domain configurations, retry failed jobs

### Non-Functional Requirements

- **Scalability**: Support 10M tracked products with configurable scrape intervals
- **Availability**: 99.9% uptime for API; scraper tolerates brief outages
- **Latency**: API responses < 200ms p95; alert delivery within 5 minutes of price change
- **Consistency**: Eventual consistency acceptable for price history; strong consistency for user data and alert configurations
- **Resilience**: Per-domain circuit breakers; no single failing retailer degrades the whole system

## Capacity Estimation

### Production Scale

| Metric | Value | Notes |
|--------|-------|-------|
| Tracked Products | 10,000,000 | Across ~500 retailer domains |
| Scrape Frequency | 1-6 hours | Configurable per product priority |
| Peak Scrape RPS | 3,000 | 10M products / 3600s average |
| API Read RPS | 10,000 | Dashboard refreshes, chart views |
| API Write RPS | 500 | Add product, create alert |
| Price history records/day | 60,000,000 | 10M products x 6 avg scrapes |

### Storage Sizing (Production)

| Data Type | Size per Record | Records/Day | Daily Growth |
|-----------|-----------------|-------------|--------------|
| Price history | 50 bytes | 60,000,000 | 3 GB |
| Products | 2 KB | 10,000 new | 20 MB |
| Users | 1 KB | 1,000 new | 1 MB |
| Alerts | 500 bytes | 50,000 | 25 MB |

**Annual storage**: ~1 TB for price history (dominated by time-series data).

### Local Development Scale

| Metric | Value |
|--------|-------|
| Tracked products | 10,000 |
| Scrape frequency | 1 hour |
| Peak scrape RPS | 3 |
| API RPS | 10 |
| 30-day storage | ~400 MB |

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client Layer                                   │
│                  Web Dashboard (React + Recharts)                         │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         API Gateway / LB                                 │
│                  (Rate Limiting, Auth, TLS)                               │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
   │  API Server (N)  │ │  API Server (N)  │ │  API Server (N)  │
   │  (Express.js)    │ │  (Express.js)    │ │  (Express.js)    │
   └────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 │
    ┌───────────────┬────────────┼────────────┬───────────────┐
    ▼               ▼            ▼            ▼               ▼
┌────────┐   ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐
│Postgres│   │  Redis    │  │RabbitMQ │  │ Scraper  │  │  Alert   │
│+ Timesc│   │  Cluster  │  │         │  │ Workers  │  │  Worker  │
│aleDB   │   │           │  │         │  │  (N)     │  │          │
│        │   │- Sessions │  │- Scrape │  │          │  │- Email   │
│- Users │   │- Cache    │  │  Jobs   │  │- Cheerio │  │- Push    │
│- Prods │   │- Rate lim │  │- DLQ    │  │- Puppeteer│ │- Webhook │
│- Prices│   │- Circuits │  │- Alerts │  │          │  │          │
└────────┘   └──────────┘  └─────────┘  └──────────┘  └──────────┘
                                              │
                                              ▼
                                   ┌──────────────────┐
                                   │ External Retailers│
                                   │ (E-commerce sites)│
                                   └──────────────────┘
```

### Core Components

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **API Server** | REST API, authentication, CRUD operations | Node.js + Express |
| **Scraper Workers** | Fetch and parse product pages, extract prices | Cheerio (default), Puppeteer (JS-required sites) |
| **Job Queue** | Distribute scrape jobs with domain-based sharding | RabbitMQ |
| **Primary Database** | Users, products, alerts, scraper configs | PostgreSQL |
| **Time-Series Store** | Price history with efficient range queries | TimescaleDB (PostgreSQL extension) |
| **Cache Layer** | Session storage, price caching, rate limiting | Redis/Valkey |
| **Alert Worker** | Process price changes, trigger notifications | Node.js consumer |
| **Frontend** | Dashboard, charts, alert management | React + TanStack Router + Zustand + Recharts |

## Request Flows

### Add Product Flow

```
User ──▶ API Server ──▶ Validate URL ──▶ Extract domain
                     ──▶ Check scraper_configs for domain support
                     ──▶ Create product record (PostgreSQL)
                     ──▶ Enqueue initial scrape job (RabbitMQ)
                     ◀── Return product ID (201 Created)

Scraper Worker ◀── Consume job from RabbitMQ
               ──▶ Check domain circuit breaker (open? skip)
               ──▶ Apply domain rate limit
               ──▶ Fetch page (Cheerio or Puppeteer)
               ──▶ Extract price via JSON-LD or CSS selectors
               ──▶ INSERT price_history record (TimescaleDB)
               ──▶ UPDATE product.current_price (PostgreSQL)
               ──▶ Check alerts for price drop ──▶ Enqueue alert
               ──▶ Schedule next scrape (RabbitMQ delayed queue)
```

### View Price History Flow

```
User ──▶ API Server ──▶ Check Redis cache for recent data
                     ──▶ Cache miss: Query daily_prices (continuous aggregate)
                     ──▶ Cache result (5-minute TTL)
                     ◀── Return price history JSON
```

### Price Alert Flow

```
Scraper Worker ──▶ Detects price drop below user threshold
               ──▶ Insert notification record (PostgreSQL)
               ──▶ Publish to alerts.send queue (RabbitMQ)

Alert Worker ◀── Consume from alert queue
             ──▶ Lookup user preferences
             ──▶ Send email via SMTP / SendGrid
             ──▶ Mark notification as sent
             ──▶ Update alert last_triggered_at
```

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    email_notifications BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Products (canonical product information)
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url VARCHAR(2048) UNIQUE NOT NULL,
    domain VARCHAR(255) NOT NULL,
    title VARCHAR(500),
    image_url VARCHAR(2048),
    current_price DECIMAL(12,2),
    currency VARCHAR(3) DEFAULT 'USD',
    last_scraped TIMESTAMPTZ,
    scrape_priority INTEGER DEFAULT 5 CHECK (scrape_priority BETWEEN 1 AND 10),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error', 'unavailable')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User product subscriptions
CREATE TABLE user_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    target_price DECIMAL(12,2),
    notify_any_drop BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

-- Price history (TimescaleDB hypertable)
CREATE TABLE price_history (
    id UUID DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    price DECIMAL(12,2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    availability BOOLEAN DEFAULT true,
    PRIMARY KEY (id, recorded_at)
);

SELECT create_hypertable('price_history', 'recorded_at',
    chunk_time_interval => INTERVAL '7 days');

CREATE INDEX idx_price_history_product ON price_history(product_id, recorded_at DESC);

-- Continuous aggregate for daily price stats
CREATE MATERIALIZED VIEW daily_prices
WITH (timescaledb.continuous) AS
SELECT
    product_id,
    time_bucket('1 day', recorded_at) AS day,
    MIN(price) as min_price,
    MAX(price) as max_price,
    AVG(price) as avg_price,
    COUNT(*) as data_points
FROM price_history
GROUP BY product_id, time_bucket('1 day', recorded_at)
WITH NO DATA;

SELECT add_continuous_aggregate_policy('daily_prices',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

-- Price alerts
CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('target_reached', 'price_drop', 'back_in_stock')),
    old_price DECIMAL(12,2),
    new_price DECIMAL(12,2) NOT NULL,
    is_read BOOLEAN DEFAULT false,
    is_sent BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scraper configurations per domain
CREATE TABLE scraper_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain VARCHAR(255) UNIQUE NOT NULL,
    price_selector VARCHAR(500),
    title_selector VARCHAR(500),
    image_selector VARCHAR(500),
    parser_type VARCHAR(50) DEFAULT 'css' CHECK (parser_type IN ('css', 'xpath', 'json-ld', 'custom')),
    rate_limit INTEGER DEFAULT 100,
    requires_js BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    last_validated TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_products_domain ON products(domain);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_last_scraped ON products(last_scraped);
CREATE INDEX idx_products_scrape_priority ON products(scrape_priority);
CREATE INDEX idx_user_products_user_id ON user_products(user_id);
CREATE INDEX idx_user_products_product_id ON user_products(product_id);
CREATE INDEX idx_alerts_user_id ON alerts(user_id, created_at DESC);
CREATE INDEX idx_alerts_is_read ON alerts(user_id, is_read);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
```

### Redis Data Structures

```
# Session storage
session:{sessionId} -> JSON { userId, role, createdAt }
TTL: 86400 (24 hours)

# Price cache (recent prices for dashboard)
cache:product:{productId}:prices -> JSON [{ price, timestamp }, ...]
TTL: 300 (5 minutes)

# Domain rate limiting
ratelimit:{domain}:{minute} -> Integer (request count)
TTL: 60 (1 minute)

# Scrape job deduplication
scrape:pending:{productId} -> 1
TTL: 3600 (1 hour)
```

### RabbitMQ Queues

| Queue | Purpose | Consumer | Retry Policy |
|-------|---------|----------|--------------|
| `scrape.jobs` | Main scrape job queue | Scraper Worker | 3 retries, exponential backoff |
| `scrape.{domain}` | Domain-sharded queues for rate limiting | Scraper Worker | Per-domain rate limit |
| `scrape.dlq` | Dead letter queue for failed jobs | Admin review | No retry |
| `alerts.send` | Alert notification delivery | Alert Worker | 5 retries, 1 minute delay |

## API Design

### Core Endpoints

```
# Authentication
POST   /api/v1/auth/register     # Create new user
POST   /api/v1/auth/login        # Login, create session
POST   /api/v1/auth/logout       # Destroy session
GET    /api/v1/auth/me           # Get current user

# Products
GET    /api/v1/products          # List user's tracked products
POST   /api/v1/products          # Add product to track (by URL)
GET    /api/v1/products/:id      # Get product details
DELETE /api/v1/products/:id      # Stop tracking product
GET    /api/v1/products/:id/history  # Get price history (range, resolution)

# Alerts
GET    /api/v1/alerts            # List user's alerts
POST   /api/v1/alerts            # Create new alert
PATCH  /api/v1/alerts/:id        # Update alert (target price, active status)
DELETE /api/v1/alerts/:id        # Delete alert

# Admin (requires admin role)
GET    /api/v1/admin/stats       # System statistics
GET    /api/v1/admin/scrapers    # List scraper configs
PATCH  /api/v1/admin/scrapers/:domain  # Update scraper config
GET    /api/v1/admin/jobs        # View job queue status
POST   /api/v1/admin/jobs/:id/retry    # Retry failed job
```

## Key Design Decisions

### TimescaleDB over Separate Time-Series Database

We chose TimescaleDB (PostgreSQL extension) over a standalone time-series database like InfluxDB. The trade-off: TimescaleDB provides familiar SQL with native JOINs between price history and relational data (products, users), eliminating the need for cross-database synchronization. InfluxDB would offer better raw write throughput at extreme scale, but at the cost of a separate query language (Flux), duplicate data pipelines, and operational complexity of managing two database systems. For price tracking, where writes are batched every hour and reads involve JOINing with product metadata, SQL wins.

Continuous aggregates (`daily_prices`) pre-compute daily min/max/avg statistics, transforming O(N) queries into O(1) lookups. Chunk-based time partitioning enables O(1) retention cleanup by dropping entire chunks rather than row-by-row deletion.

### Cheerio vs Puppeteer for Scraping

Most e-commerce sites render prices in initial HTML without requiring JavaScript execution. Cheerio (pure HTML parser) uses ~10MB memory per request vs ~100MB for Puppeteer (headless browser), allowing 10x higher concurrent scrape throughput. The `scraper_configs.requires_js` flag per domain determines which scraper to use. Sites like Amazon, Walmart, and Best Buy work with Cheerio + JSON-LD extraction. Only SPAs with client-rendered prices need Puppeteer. The trade-off: Cheerio cannot handle dynamically loaded content, so new domains must be tested and flagged appropriately.

### Domain-Sharded Queues for Rate Limiting

Each e-commerce domain gets its own RabbitMQ queue with an independent rate limit and circuit breaker. This provides failure isolation: if Amazon is rate-limiting our scraper, Best Buy and Walmart scraping continues unaffected. Without domain sharding, a single overloaded retailer could consume all worker capacity, starving scrapes for healthy domains. The trade-off is more complex queue topology and worker routing, but the isolation benefit is essential for production reliability.

### Price History Retention Policy

Price data has diminishing analytical value over time. Full-resolution hourly data is kept for 7 days, daily aggregates for 90 days, and data older than 365 days is deleted. This tiered approach reduces storage from ~5.3 GB/year (full resolution) to ~1.3 GB/year per 10,000 products while preserving trend visibility through aggregates.

## Caching Strategy

### Cache-Aside Pattern

| Data Type | TTL | Invalidation |
|-----------|-----|--------------|
| Price history (dashboard) | 5 minutes | Time-based expiry |
| Product details | 1 minute | Invalidate on scrape |
| User session | 24 hours | Logout or expiry |
| Scraper config | 10 minutes | Admin update invalidates |

Cache invalidation triggers: on scrape completion (product + price cache), on admin config change (scraper config cache). Alert processing does not invalidate cache (read-through pattern).

## Security

### Authentication and Authorization

| Aspect | Implementation |
|--------|----------------|
| Session Management | Redis-backed sessions, 24-hour TTL, secure cookies |
| Password Storage | bcrypt with cost factor 12 |
| RBAC | Two roles: `user` (default), `admin` (elevated) |
| Admin Access | All `/api/v1/admin/*` endpoints require `role = 'admin'` |
| Rate Limiting | Redis-based, 100 requests/minute per IP for API, per-domain limits for scraping |

### Input Validation

URL validation with domain allowlist via Zod schemas. Alert validation: positive target price, valid alert type. All database queries use parameterized statements.

## Observability

### Metrics (Prometheus)

| Metric | Type | Labels |
|--------|------|--------|
| `price_tracker_scrapes_total` | Counter | domain, status |
| `price_tracker_scrape_duration_seconds` | Histogram | domain |
| `price_tracker_scrape_queue_size` | Gauge | - |
| `price_tracker_circuit_breaker_state` | Gauge | domain |
| `price_tracker_alerts_triggered_total` | Counter | alert_type |
| `price_tracker_alerts_sent_total` | Counter | channel, status |
| `price_tracker_alert_delivery_latency_seconds` | Histogram | channel |
| `price_tracker_http_requests_total` | Counter | method, path, status |
| `price_tracker_http_request_duration_seconds` | Histogram | method, path |
| `price_tracker_cache_operations_total` | Counter | operation, result |
| `price_tracker_price_history_inserts_total` | Counter | - |
| `price_tracker_db_query_duration_seconds` | Histogram | operation |

Path normalization replaces UUIDs with `:id` to prevent unbounded label cardinality.

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Scrape success rate per domain | < 80% | < 50% |
| API p95 latency | > 500ms | > 1s |
| Queue depth | > 1000 | > 5000 |
| DB connection pool exhaustion | > 80% | > 95% |
| Cache hit rate | < 70% | < 50% |

### Logging

Structured JSON logs via Pino with correlation IDs. Key log events: `scrape_complete`, `scrape_failed`, `alert_triggered`, `circuit_state_change`. Sensitive data (passwords, tokens) automatically redacted.

## Failure Handling

### Scraper Retry Strategy

3 retries with exponential backoff (1s, 2s, 4s, max 30s). Only network errors and HTTP 5xx are retryable; 4xx client errors fail immediately. After max retries, the job routes to the dead-letter queue for admin review. The product's `status` transitions to `error` after consecutive failures, and `scrape_priority` is lowered to reduce wasted capacity.

### Circuit Breaker (Per Domain)

Each e-commerce domain gets its own circuit breaker. Opens after 5 consecutive failures, stays open for 60 seconds, then allows 3 test requests in half-open state. This prevents overwhelming a struggling retailer with retry traffic and isolates failures so one domain's outage does not affect others.

```
CLOSED (normal) ──5 failures──▶ OPEN (blocking)
OPEN ──60s timeout──▶ HALF-OPEN (testing)
HALF-OPEN ──success──▶ CLOSED
HALF-OPEN ──failure──▶ OPEN
```

### Graceful Degradation

| Component Failure | Degradation Strategy |
|-------------------|---------------------|
| Redis down | Fall back to DB queries (slower), sessions use memory store |
| RabbitMQ down | API still works for reads, writes queued in memory (limited) |
| Scraper worker down | Queue backs up, no new prices, alerts still work on cached data |
| TimescaleDB continuous aggregate stale | Use raw price_history with sampling |

### Idempotency

Scrape job deduplication via Redis SETNX (`scrape:pending:{productId}`, 1-hour TTL) prevents queueing duplicate scrape jobs. Alert deduplication checks `last_triggered_at` to avoid re-alerting for the same price drop within a cooldown window.

## Scalability Considerations

### Horizontal Scaling Path

1. **API Servers**: Stateless, add instances behind load balancer
2. **Scraper Workers**: Add workers, each consumes from domain-sharded queues
3. **Database**: Read replicas for dashboard queries, primary for writes
4. **Cache**: Redis Cluster for sharding (> 10GB cache)
5. **TimescaleDB**: Tune `chunk_time_interval` based on query patterns; multi-node for > 1TB

### Bottlenecks and Mitigations

| Bottleneck | Mitigation |
|------------|------------|
| Database writes during bulk scrape | Batch inserts via COPY, async writes via queue |
| Rate limiting per domain | Domain-sharded queues with individual rate limits |
| Memory for Puppeteer | Dedicated Puppeteer workers, browser pooling, limit concurrency |
| TimescaleDB chunk size | Tune chunk_time_interval from 7 days to 1 day at high volume |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Time-series DB | TimescaleDB (PG extension) | InfluxDB | SQL joins, single DB to operate |
| Default scraper | Cheerio (HTML parser) | Puppeteer (headless browser) | 10x less memory, sufficient for most sites |
| Job queue | RabbitMQ | BullMQ/Redis | Better durability, DLQ support, domain sharding |
| Price history | Tiered retention (7d/90d/365d) | Keep everything | Storage cost vs analytical value decay |
| Alert delivery | Async queue | Synchronous inline | Decouples scraping from notification reliability |
| Resilience | Cockatiel (circuit + retry) | Custom implementation | Battle-tested patterns, composable policies |

## Implementation Notes

This section maps the production architecture above to the local Docker + Node.js setup actually built.

### Local Setup Diagram

```
┌──────────────────┐
│  React Frontend  │
│ (localhost:5173)  │
│  Recharts, Zustand│
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│  API Server      │     │  Scraper Worker   │
│ (localhost:3001)  │     │  (separate proc)  │
│  Express + Prom  │     │  Cheerio/Puppeteer│
└────────┬─────────┘     └────────┬─────────┘
         │                        │
    ┌────┴────────────────────────┴────┐
    │                                  │
    ▼                    ▼             ▼
┌──────────────┐  ┌──────────┐  ┌──────────┐
│ TimescaleDB  │  │  Valkey  │  │ RabbitMQ │
│(localhost:5432)│ │(localhost │  │(localhost │
│              │  │  :6379)  │  │  :5672)  │
│DB:pricetracker│ │Sessions, │  │Scrape    │
│User:pricetracker│ cache   │  │  jobs    │
└──────────────┘  └──────────┘  └──────────┘
```

### Production Patterns Actually Implemented

| Pattern | Library | File Path | Purpose |
|---------|---------|-----------|---------|
| Circuit breaker | Cockatiel | `backend/src/shared/resilience.ts` | Per-domain circuit breakers with state tracking |
| Retry + backoff | Cockatiel | `backend/src/shared/resilience.ts` | Exponential backoff for transient scrape failures |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | 20+ metrics: scrapes, alerts, cache, DB, circuits |
| Data retention | Custom | `backend/src/shared/retention.ts` | Tiered cleanup with batch deletion |
| Rate limiting | express-rate-limit | `backend/src/index.ts` | API rate limiting per IP |
| Structured logging | Pino | `backend/src/utils/logger.ts` | JSON logs with correlation, redaction |
| Health checks | Custom endpoints | `backend/src/index.ts` | `/health`, `/health/detailed`, `/ready`, `/live` |
| TimescaleDB hypertable | TimescaleDB | `backend/src/db/init.sql` | Automatic time-partitioned price history |
| Continuous aggregates | TimescaleDB | `backend/src/db/init.sql` | Pre-computed daily price stats |
| Job scheduling | node-cron | `backend/src/job-scheduler.ts` | Periodic scrape job enqueuing |
| HTML parsing | Cheerio + JSON-LD | `backend/src/scrapers/` | Price extraction with CSS selectors |
| Metrics middleware | prom-client | `backend/src/index.ts` | HTTP duration histograms with path normalization |

### Simplifications from Production Design

| Production | Local Substitute | Impact |
|------------|-----------------|--------|
| API Gateway + CDN | Direct frontend-to-backend | No TLS termination, no geographic routing |
| Redis Cluster | Single Valkey instance | No sharding, single point of failure |
| Multiple scraper workers | Single scraper process | Lower throughput, no parallelism |
| Domain-sharded queues | Single scrape queue | No per-domain rate isolation |
| Email/push notifications | Stored in DB, not sent | No actual alert delivery |
| Proxy rotation | Direct requests | May trigger rate limits on real sites |
| PostgreSQL read replicas | Single instance | All reads/writes on same instance |
| Load balancer | Run manually on :3001-:3003 | No automatic failover |
| Puppeteer browser pool | Single browser instance | Limited JS-rendered site support |

### What Was Omitted

- CDN for frontend assets
- Multi-region deployment and Kubernetes
- Real email/push notification delivery (SendGrid, Firebase)
- Proxy rotation service for blocked sites
- WebSocket real-time price updates
- Machine learning price prediction
- Multi-currency conversion
- Database sharding / read replicas
- OAuth authentication
- Smart scheduling (increase frequency for volatile products)

## Frontend Architecture

This section describes the React frontend implementation: component hierarchy, state management, routing, data fetching patterns, and key UI behaviors.

### Technology Stack

| Technology | Purpose |
|-----------|---------|
| React 19 + TypeScript | UI framework with type safety |
| TanStack Router | File-based routing with type-safe params |
| Zustand | Lightweight global state management |
| Axios | HTTP client with interceptors for auth and error handling |
| Recharts | Interactive price history charts |
| date-fns | Date formatting and relative time display |
| Tailwind CSS | Utility-first CSS styling |
| Vite | Development server and build tool |

### Route Structure

TanStack Router file-based routing in `frontend/src/routes/`:

| File | Path | Description |
|------|------|-------------|
| `__root.tsx` | (layout) | Root layout with auth check on mount, Layout wrapper, loading spinner |
| `index.tsx` | `/` | Dashboard showing tracked products and add-product form (requires auth) |
| `login.tsx` | `/login` | Login form |
| `register.tsx` | `/register` | Registration form |
| `products.$productId.tsx` | `/products/:productId` | Product detail with price chart, stats, and alert settings |
| `alerts.tsx` | `/alerts` | Notification center for price drop alerts |
| `admin.tsx` | `/admin` | Admin dashboard with scraper stats and domain configurations |

### Zustand Stores

The frontend uses three Zustand stores for domain-separated global state:

**`authStore.ts`** -- Authentication state without persistence middleware. Stores user object and auth status. On app load, `checkAuth()` reads a token from localStorage and validates it via `authService.getCurrentUser()`. If the token is invalid or missing, the store clears state and sets `isLoading: false`. Includes an `updateSettings()` action for email notification preferences. Unlike the other projects in this repo, this store does not use Zustand's `persist` middleware -- instead it manually checks localStorage for the token.

**`productStore.ts`** -- Product tracking state. Manages the list of tracked products with CRUD operations. `fetchProducts()` loads all products from the API. `addProduct()` optimistically prepends the new product to the list (newest first). `updateProduct()` optimistically merges updates into the local list. `deleteProduct()` optimistically removes the product from the list. Each action delegates to the `productService` module for the actual API call. Error state is tracked per-store, not per-operation.

**`alertStore.ts`** -- Alert notification state. Maintains a list of price drop alerts with an `unreadCount` for badge display. `markAsRead()` optimistically marks an alert as read in local state and decrements the unread count. `markAllAsRead()` sets all alerts to read and zeroes the count. `fetchUnreadCount()` is called separately (e.g., on navigation) to update the badge without loading full alert data. Errors in `fetchUnreadCount` are silently swallowed to avoid disrupting the UI for a non-critical feature.

### Component Hierarchy

```
__root (Layout wrapper with auth check)
├── Layout
│   └── Header (nav links, alert badge with unreadCount)
├── HomePage
│   ├── AddProductForm (URL input, target price, notify-any-drop checkbox)
│   └── ProductCard[] (image, title, domain, current price, link to detail)
├── ProductDetailPage
│   ├── Product info header (image, title, domain, current price)
│   ├── Price statistics (lowest, highest, average for selected period)
│   ├── PriceChart (Recharts LineChart with avg/min/max lines + target ReferenceLine)
│   ├── Time range selector (30d, 90d, 180d, 365d toggle buttons)
│   └── Alert settings editor (target price input, notify-any-drop toggle)
├── AlertsPage (alert list with read/unread styling, mark-read, delete)
└── AdminPage (system statistics, scraper configurations, job queue status)
```

### Data Fetching Pattern

The frontend uses Axios (`services/api.ts`) with two interceptors. The request interceptor reads a token from localStorage and attaches it as a `Bearer` token in the `Authorization` header. The response interceptor catches 401 errors, removes the stale token from localStorage, and redirects to `/login`. Typed service modules (`services/products.ts`, `services/alerts.ts`, `services/auth.ts`) wrap Axios calls and return typed data. Zustand stores call these service modules and manage loading/error state internally.

### Key UI Patterns

**Price history charts with Recharts**: The `PriceChart` component renders a `ResponsiveContainer` containing a `LineChart` with three `Line` elements: average price (solid blue), min price (dashed green), and max price (dashed red). A `ReferenceLine` marks the user's target price as a dashed yellow horizontal line when configured. The Y-axis domain is calculated from actual data bounds with 10% padding. A custom `Tooltip` component shows formatted prices for all three series on hover. When no data exists, a gray placeholder with "No price history available yet" is shown.

**Time range selector**: The product detail page has toggle buttons for 30d, 90d, 180d, and 365d ranges. Selecting a range updates the `selectedDays` state, which triggers a `useEffect` to call `getDailyPrices(productId, selectedDays)`. The API returns data from TimescaleDB continuous aggregates, and the price statistics (lowest, highest, average) are recalculated from the returned data.

**Inline alert settings editing**: The product detail page has an alert settings section that toggles between view mode (showing current target price and notify-any-drop status) and edit mode (form with inputs). Edit mode is entered via an "Edit" button and exited via "Save" (which calls `updateProduct`) or "Cancel". This inline editing pattern avoids a separate settings page.

**Auth-guarded routes**: Route components check `isAuthenticated` from the auth store and render `<Navigate to="/login" />` if false. This is a client-side guard -- the API also enforces authentication, so the frontend guard is a UX convenience that prevents seeing a broken page before the API returns 401.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend as if the reader has never encountered it before. Each explanation covers what the pattern is, what problem it solves, and how it works in this project.

### RBAC (Role-Based Access Control)

**What it is**: RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of checking "can user X do action Y?" for every user individually, the system checks "does user X have a role that permits action Y?" This decouples permission logic from individual user identities.

**What problem it solves**: Without RBAC, authorization logic scatters throughout the codebase as ad-hoc checks. When new admin capabilities are added (like managing scraper configurations or retrying failed jobs), every endpoint must be audited. RBAC centralizes permission decisions: a middleware checks the user's role against the route's required role before the handler executes. If the role does not match, the request is rejected with 403 Forbidden.

**How it works in this project**: The `users` table has a `role` column constrained to `('user', 'admin')`. Regular users can only manage their own tracked products and alerts. Admin users can access `/api/v1/admin/*` endpoints to view system statistics, update scraper configurations per domain, view the job queue, and retry failed scrape jobs. The auth middleware loads the session from Redis, retrieves the user role, and attaches it to the request object. Admin routes check `req.user.role === 'admin'` via middleware.

### Redis Cache-Aside

**What it is**: Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. On a cache miss, the application queries the database, stores the result in the cache with a time-to-live (TTL), and returns it. On a cache hit, the cached value is returned directly, skipping the database entirely. The cache is "aside" from the main data flow -- it is not in the write path, and the database is the source of truth.

**What problem it solves**: Price history queries hit TimescaleDB continuous aggregates, which are efficient but still require a database round-trip. For dashboard views where many users view the same product's price chart, caching avoids redundant queries. With 10,000 tracked products and frequent dashboard refreshes, cache-aside reduces database load from O(users * products) to O(products) per cache TTL period.

**How it works in this project**: Price history for dashboard display is cached in Redis with key pattern `cache:product:{productId}:prices` and a 5-minute TTL. When a user views a product's price chart, the server checks Redis first. On cache miss, it queries the `daily_prices` continuous aggregate, stores the JSON result in Redis, and returns it. On scrape completion, product and price caches are invalidated so the next read reflects the new price. Scraper configurations are also cached with a 10-minute TTL and invalidated when an admin updates them.

### Circuit Breaker

**What it is**: A circuit breaker is a stability pattern borrowed from electrical engineering. It wraps calls to an external service and monitors failure rates. When failures exceed a threshold, the circuit "opens" and immediately rejects subsequent calls without attempting them, giving the failing service time to recover. After a timeout, the circuit enters a "half-open" state where it allows a limited number of test requests. If those succeed, the circuit closes and normal operation resumes.

**What problem it solves**: When scraping an e-commerce site, that site may start rate-limiting, returning errors, or timing out. Without a circuit breaker, the scraper would continue hammering the failing site, wasting worker capacity and potentially getting the scraper's IP permanently banned. The circuit breaker stops futile requests immediately, preserving worker capacity for domains that are healthy, and automatically resumes scraping when the target site recovers.

**How it works in this project**: The Cockatiel library (`backend/src/shared/resilience.ts`) provides per-domain circuit breakers. Each e-commerce domain gets its own circuit breaker instance with independent state tracking. Configuration: opens after 5 consecutive failures, stays open for 60 seconds, then allows 3 test requests in half-open state. State transitions are logged and exposed as Prometheus gauge metrics (`price_tracker_circuit_breaker_state`). This per-domain isolation is critical: if Amazon is down, Best Buy and Walmart scraping continues unaffected.

### Structured Logging

**What it is**: Structured logging means emitting log entries as machine-parseable JSON rather than free-form text strings. Each log entry has well-defined fields: timestamp, log level, message, and arbitrary contextual key-value pairs (product ID, domain, scrape duration). This contrasts with `console.log("Scraped amazon.com in 2.3s")` which is human-readable but impossible to reliably parse.

**What problem it solves**: When debugging why a particular product's price is not updating, you need to find the relevant log entries among millions of scrape operations. Free-form text requires regex searching that breaks when messages change. Structured logs enable precise queries: "show all entries where `domain = amazon.com` and `level = error` in the last hour." Log aggregation tools can index JSON fields for sub-second search.

**How it works in this project**: Pino (`backend/src/utils/logger.ts`) outputs JSON logs with correlation IDs. Each log entry includes contextual data like `domain`, `product_id`, `scrape_duration_ms`. Key logged events: `scrape_complete` (with domain, status, duration), `scrape_failed` (with error type, retry count), `alert_triggered` (with alert type, old/new price), `circuit_state_change` (with domain, old/new state). Sensitive data (passwords, session tokens) is automatically redacted by Pino's redaction configuration. In development, `pino-pretty` reformats JSON into colored, human-readable output.

### Prometheus Metrics

**What it is**: Prometheus is a time-series monitoring system. The application exposes a `/metrics` HTTP endpoint that returns numerical measurements. A Prometheus server scrapes this endpoint periodically and stores the values. Grafana queries this data to create dashboards and trigger alerts. The three main metric types are: counters (monotonically increasing, like "total scrapes"), histograms (distribution of values, like "scrape duration in buckets"), and gauges (point-in-time values, like "queue depth").

**What problem it solves**: Without metrics, the only way to know if scraping is healthy is to manually check if prices are updating. Metrics provide continuous quantitative visibility: "amazon.com scrape success rate dropped from 95% to 40% over the last 30 minutes" triggers an alert before users notice stale prices. Metrics also enable capacity planning: "we process 3 scrapes/second; peak requires 10; we need 4x more workers."

**How it works in this project**: The `prom-client` library (`backend/src/shared/metrics.ts`) registers 20+ custom metrics. Examples: `price_tracker_scrapes_total` (counter by domain and status -- success/failure/circuit_open), `price_tracker_scrape_duration_seconds` (histogram by domain, showing p50/p95/p99 scrape latency), `price_tracker_scrape_queue_size` (gauge showing backlog), `price_tracker_alerts_triggered_total` (counter by alert type), `price_tracker_cache_operations_total` (counter by operation and result -- hit/miss). HTTP metrics use path normalization (UUIDs replaced with `:id`) to prevent unbounded label cardinality.

### Rate Limiting

**What it is**: Rate limiting restricts how many requests a client can make within a time window. The system tracks request counts per client (by IP, user ID, or API key) and rejects excess requests with HTTP 429 (Too Many Requests).

**What problem it solves**: This project has two rate-limiting concerns: API rate limiting (preventing abuse of the web API) and domain rate limiting (preventing excessive scraping of target e-commerce sites). API rate limiting protects the server from being overwhelmed by a single client. Domain rate limiting prevents getting blocked by target sites and ensures fair distribution of scrape capacity across domains.

**How it works in this project**: API rate limiting uses `express-rate-limit` middleware configured at 100 requests/minute per IP. Domain scrape rate limiting uses Redis counters with key pattern `ratelimit:{domain}:{minute}` and 60-second TTL. Before each scrape, the worker checks if the domain's request count exceeds its configured limit (from `scraper_configs.rate_limit`). If exceeded, the scrape job is delayed until the next minute. This per-domain approach prevents a high-volume domain (Amazon with 100K tracked products) from starving low-volume domains.

### Idempotency

**What it is**: An idempotent operation produces the same result whether executed once or multiple times. In the context of web APIs, idempotency means that if a client sends the same request twice (due to network retry, user double-click, or app crash), the server processes it only once and returns the same response both times.

**What problem it solves**: In this project, idempotency serves two purposes. First, scrape job deduplication: if the job scheduler fires while a product's scrape is already queued (because the previous scrape took longer than expected), the system should not queue a duplicate job. Second, alert deduplication: if a product's price drops and the alert check runs twice before the alert is marked as sent, the user should not receive two identical notifications.

**How it works in this project**: Scrape job deduplication uses Redis SETNX with key `scrape:pending:{productId}` and a 1-hour TTL. Before enqueueing a scrape job, the scheduler checks if this key exists. If it does, the product's scrape is already in progress and a new job is not queued. The key is deleted when the scrape completes. Alert deduplication checks `last_triggered_at` on the alert record -- if an alert was triggered within a cooldown window (configurable, default 1 hour), it is not triggered again for the same price drop.

### Health Checks

**What it is**: Health check endpoints are HTTP routes that report whether the application is functioning correctly. They are consumed by infrastructure components (load balancers, container orchestrators, monitoring systems) to make automated decisions about traffic routing and process lifecycle.

**What problem it solves**: An API server might be running but unable to serve requests because its database connection was lost or Redis is unreachable. Without health checks, the load balancer continues sending traffic to the broken instance, causing cascading errors for users. Health checks enable automatic traffic rerouting and container restarts.

**How it works in this project**: The backend exposes four endpoints. `GET /health` returns 200 with basic process info (uptime, memory). `GET /health/detailed` checks PostgreSQL connectivity (via `SELECT 1`), Redis connectivity (via `PING`), and TimescaleDB status, reporting per-component latency. `GET /ready` returns 200 only if all dependencies are connected (used by load balancers to decide if this instance should receive traffic). `GET /live` always returns 200 if the process is running (used by container orchestrators to detect deadlocked processes). The separation between liveness and readiness is important: a process that lost its database connection is alive (should not be killed) but not ready (should not receive traffic).
