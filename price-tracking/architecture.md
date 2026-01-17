# Price Tracking Service - Architecture Design

## System Overview

An e-commerce price monitoring and alert system that scrapes product prices from online retailers, stores historical price data, and sends alerts to users when prices drop below their configured thresholds.

## Requirements

### Functional Requirements

- **Product tracking**: Users can add products by URL, system extracts product metadata
- **Price scraping**: Automated periodic scraping of tracked product prices
- **Historical tracking**: Store and visualize price history over time with charts
- **Price alerts**: Notify users via email/push when prices drop below threshold
- **Price predictions**: Basic trend analysis to predict future price movements

### Non-Functional Requirements

- **Scalability**: Support 10,000 tracked products with hourly scraping (local dev target)
- **Availability**: 99% uptime (single-node acceptable for learning project)
- **Latency**: API responses < 200ms p95, alert delivery within 5 minutes of price change
- **Consistency**: Eventual consistency acceptable for price history; strong consistency for user data and alert configurations

## Capacity Estimation

### Local Development Targets

This is a learning project designed to run on a single developer machine (< 8GB RAM total).

| Metric | Target | Calculation |
|--------|--------|-------------|
| Daily Active Users (DAU) | 100 | Simulated load for testing |
| Tracked Products | 10,000 | Upper bound for local testing |
| Scrape Frequency | 1 hour | Per-product interval |
| Peak Scrape RPS | 3 | 10,000 products / 3600 seconds |
| API Read RPS | 10 | Dashboard refreshes, chart views |
| API Write RPS | 1 | Add product, create alert |

### Storage Sizing

| Data Type | Size per Record | Records/Day | Daily Growth | 30-Day Total |
|-----------|-----------------|-------------|--------------|--------------|
| Price history | 50 bytes | 240,000 (10K products x 24 scrapes) | 12 MB | 360 MB |
| Products | 2 KB | 100 new | 200 KB | 6 MB |
| Users | 1 KB | 10 new | 10 KB | 300 KB |
| Alerts | 500 bytes | 50 new | 25 KB | 750 KB |

**Total 30-day storage**: ~400 MB (easily fits PostgreSQL on local machine)

### Component Sizing (Local Development)

| Component | Memory | CPU | Instances |
|-----------|--------|-----|-----------|
| PostgreSQL + TimescaleDB | 512 MB | 0.5 | 1 |
| Redis (cache + sessions) | 128 MB | 0.1 | 1 |
| RabbitMQ | 256 MB | 0.2 | 1 |
| API Server | 256 MB | 0.5 | 1-3 |
| Scraper Worker | 256 MB | 0.3 | 1-3 |
| Frontend (dev server) | 128 MB | 0.2 | 1 |
| **Total** | **~2 GB** | **~2 cores** | - |

## High-Level Architecture

```
                                    +------------------+
                                    |   React Frontend |
                                    |   (port 5173)    |
                                    +--------+---------+
                                             |
                                             v
+------------------+              +----------+---------+
|   Load Balancer  | <----------> |    API Server      |
|   (nginx/local)  |              |  (Express, 3001+)  |
+------------------+              +----------+---------+
                                             |
                    +------------------------+------------------------+
                    |                        |                        |
                    v                        v                        v
          +---------+--------+    +----------+---------+    +---------+--------+
          |   PostgreSQL     |    |      Redis         |    |    RabbitMQ      |
          |   + TimescaleDB  |    |  (cache/sessions)  |    |   (job queue)    |
          |   (port 5432)    |    |   (port 6379)      |    |   (port 5672)    |
          +------------------+    +--------------------+    +---------+--------+
                                                                      |
                                                                      v
                                                           +----------+---------+
                                                           |   Scraper Worker   |
                                                           |   (Cheerio/Puppeteer)
                                                           +--------------------+
                                                                      |
                                                                      v
                                                           +----------+---------+
                                                           |   External Sites   |
                                                           |   (e-commerce)     |
                                                           +--------------------+
```

### Core Components

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **API Server** | REST API, authentication, CRUD operations | Node.js + Express |
| **Scraper Worker** | Fetch and parse product pages, extract prices | Cheerio (default), Puppeteer (JS-required sites) |
| **Job Queue** | Distribute scrape jobs, handle retries | RabbitMQ |
| **Primary Database** | Users, products, alerts, scraper configs | PostgreSQL |
| **Time-Series Store** | Price history with efficient range queries | TimescaleDB (PostgreSQL extension) |
| **Cache Layer** | Session storage, hot data caching | Redis/Valkey |
| **Frontend** | Dashboard, charts, alert management | React + TanStack Router + Zustand |

## Request Flow

### 1. Add Product Flow

```
User -> API Server -> Validate URL -> Create Product record (PostgreSQL)
                   -> Enqueue initial scrape job (RabbitMQ)
                   <- Return product ID

Scraper Worker <- Consume job from RabbitMQ
               -> Fetch page (Cheerio/Puppeteer)
               -> Extract price, title, image (CSS selectors / JSON-LD)
               -> Insert price_history record (TimescaleDB)
               -> Update product.current_price (PostgreSQL)
               -> Schedule next scrape (RabbitMQ delayed queue)
```

### 2. View Price History Flow

```
User -> API Server -> Check cache (Redis) for recent data
                   -> Cache miss: Query price_history (TimescaleDB)
                   -> Apply continuous aggregate for daily/weekly views
                   -> Cache result (TTL: 5 minutes)
                   <- Return price history JSON
```

### 3. Price Alert Flow

```
Scraper Worker -> Detects price drop below threshold
               -> Insert notification record (PostgreSQL)
               -> Publish to alert queue (RabbitMQ)

Alert Worker <- Consume from alert queue
             -> Lookup user preferences
             -> Send email via SMTP / SendGrid
             -> Mark notification as sent
```

## Data Model

### Database Schema (PostgreSQL + TimescaleDB)

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Products being tracked
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    domain VARCHAR(255) NOT NULL,  -- extracted for domain-sharding
    title VARCHAR(500),
    image_url TEXT,
    current_price DECIMAL(10, 2),
    currency VARCHAR(3) DEFAULT 'USD',
    scrape_interval_minutes INTEGER DEFAULT 60,
    last_scraped_at TIMESTAMPTZ,
    scrape_status VARCHAR(20) DEFAULT 'pending',  -- pending, active, failed, paused
    consecutive_failures INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, url)
);

CREATE INDEX idx_products_domain ON products(domain);
CREATE INDEX idx_products_scrape_status ON products(scrape_status);
CREATE INDEX idx_products_next_scrape ON products(last_scraped_at)
    WHERE scrape_status = 'active';

-- Price history (TimescaleDB hypertable)
CREATE TABLE price_history (
    id BIGSERIAL,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, scraped_at)
);

-- Convert to TimescaleDB hypertable (partition by time)
SELECT create_hypertable('price_history', 'scraped_at',
    chunk_time_interval => INTERVAL '7 days');

CREATE INDEX idx_price_history_product ON price_history(product_id, scraped_at DESC);

-- Continuous aggregate for daily price stats
CREATE MATERIALIZED VIEW price_daily
WITH (timescaledb.continuous) AS
SELECT
    product_id,
    time_bucket('1 day', scraped_at) AS day,
    MIN(price) AS low,
    MAX(price) AS high,
    AVG(price) AS avg,
    FIRST(price, scraped_at) AS open,
    LAST(price, scraped_at) AS close
FROM price_history
GROUP BY product_id, time_bucket('1 day', scraped_at);

-- Price alerts configuration
CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    target_price DECIMAL(10, 2) NOT NULL,
    alert_type VARCHAR(20) DEFAULT 'below' CHECK (alert_type IN ('below', 'above', 'change_pct')),
    change_threshold_pct DECIMAL(5, 2),  -- for change_pct type
    is_active BOOLEAN DEFAULT true,
    last_triggered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, product_id, alert_type)
);

-- Alert notifications sent
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id UUID REFERENCES alerts(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    old_price DECIMAL(10, 2),
    new_price DECIMAL(10, 2),
    message TEXT,
    channel VARCHAR(20) DEFAULT 'email',  -- email, push, webhook
    status VARCHAR(20) DEFAULT 'pending',  -- pending, sent, failed
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_pending ON notifications(status, created_at)
    WHERE status = 'pending';

-- Scraper configuration per domain
CREATE TABLE scraper_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain VARCHAR(255) UNIQUE NOT NULL,
    price_selector TEXT,           -- CSS selector for price
    title_selector TEXT,           -- CSS selector for title
    image_selector TEXT,           -- CSS selector for image
    json_ld_enabled BOOLEAN DEFAULT true,  -- try JSON-LD extraction first
    requires_js BOOLEAN DEFAULT false,     -- use Puppeteer instead of Cheerio
    rate_limit_rpm INTEGER DEFAULT 30,     -- requests per minute to this domain
    proxy_required BOOLEAN DEFAULT false,
    success_rate DECIMAL(5, 2) DEFAULT 100.0,
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- Sessions (Redis-backed, but schema for reference)
-- Key: session:{sessionId}
-- Value: { userId, role, createdAt, expiresAt }
-- TTL: 24 hours
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
GET    /api/v1/products/:id/history  # Get price history

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

### Request/Response Examples

**Add Product**
```json
POST /api/v1/products
{
  "url": "https://amazon.com/dp/B09V3KXJPB"
}

Response 201:
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://amazon.com/dp/B09V3KXJPB",
  "domain": "amazon.com",
  "title": null,
  "currentPrice": null,
  "scrapeStatus": "pending",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

**Get Price History**
```json
GET /api/v1/products/550e8400.../history?range=30d&resolution=daily

Response 200:
{
  "productId": "550e8400-e29b-41d4-a716-446655440000",
  "range": "30d",
  "resolution": "daily",
  "data": [
    { "date": "2024-01-15", "low": 29.99, "high": 34.99, "avg": 32.50 },
    { "date": "2024-01-16", "low": 28.99, "high": 32.99, "avg": 30.00 }
  ]
}
```

## Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Application** | Node.js + Express | Standard for this learning repo, async I/O good for scraping |
| **Frontend** | React 19 + TanStack Router + Zustand | Repo defaults, type-safe routing |
| **Database** | PostgreSQL 16 | Relational data, joins with time-series |
| **Time-Series** | TimescaleDB | PostgreSQL extension, no separate system to learn |
| **Cache** | Redis/Valkey | Sessions, caching, rate limiting |
| **Queue** | RabbitMQ | Job distribution, delayed messages, DLQ support |
| **Scraping** | Cheerio (default) / Puppeteer (JS sites) | Cheerio: fast, low memory; Puppeteer: when needed |
| **Charts** | Recharts | React charting library, good for time-series |

## Caching Strategy

### Cache-Aside Pattern (Default)

```typescript
async function getProductPrices(productId: string, range: string): Promise<PricePoint[]> {
  const cacheKey = `cache:product:${productId}:prices:${range}`;

  // 1. Check cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // 2. Cache miss - query database
  const prices = await db.query(`
    SELECT day, low, high, avg FROM price_daily
    WHERE product_id = $1 AND day >= NOW() - $2::interval
    ORDER BY day DESC
  `, [productId, range]);

  // 3. Populate cache
  await redis.setex(cacheKey, 300, JSON.stringify(prices));

  return prices;
}
```

### Cache TTLs

| Data Type | TTL | Invalidation |
|-----------|-----|--------------|
| Price history (dashboard) | 5 minutes | Time-based expiry |
| Product details | 1 minute | Invalidate on scrape |
| User session | 24 hours | Logout or expiry |
| Scraper config | 10 minutes | Admin update invalidates |

### Cache Invalidation

- **On scrape completion**: Invalidate product cache and related price history cache
- **On alert trigger**: No cache impact (read-through)
- **On admin config change**: Invalidate scraper config cache for domain

## Security

### Authentication and Authorization

| Aspect | Implementation |
|--------|----------------|
| **Session Management** | Redis-backed sessions, 24-hour TTL, secure cookies |
| **Password Storage** | bcrypt with cost factor 12 |
| **RBAC** | Two roles: `user` (default), `admin` (elevated) |
| **Admin Access** | All `/api/v1/admin/*` endpoints require `role = 'admin'` |
| **Rate Limiting** | Redis-based, 100 requests/minute per IP for API, 30 requests/minute per domain for scraping |

### Input Validation

```typescript
// URL validation for product tracking
const productSchema = z.object({
  url: z.string()
    .url()
    .refine(url => {
      const allowed = ['amazon.com', 'walmart.com', 'bestbuy.com', ...];
      const domain = new URL(url).hostname.replace('www.', '');
      return allowed.includes(domain);
    }, 'Unsupported retailer')
});

// Alert validation
const alertSchema = z.object({
  productId: z.string().uuid(),
  targetPrice: z.number().positive().max(1000000),
  alertType: z.enum(['below', 'above', 'change_pct']),
  changeThresholdPct: z.number().min(1).max(100).optional()
});
```

### Security Headers

```typescript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", "https:", "data:"],  // Allow product images
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true
}));
```

## Observability

### Metrics (Prometheus Format)

```
# API metrics
http_requests_total{method, path, status}          # Counter
http_request_duration_seconds{method, path}        # Histogram

# Scraper metrics
scrapes_total{domain, status}                      # Counter (success/fail)
scrape_duration_seconds{domain}                    # Histogram
scrape_queue_size                                  # Gauge
scrape_success_rate{domain}                        # Gauge (0-100%)

# Database metrics
db_pool_connections_active                         # Gauge
db_pool_connections_idle                           # Gauge
db_query_duration_seconds{query_type}              # Histogram

# Cache metrics
cache_hits_total                                   # Counter
cache_misses_total                                 # Counter
cache_hit_rate                                     # Gauge (0-100%)

# Alert metrics
alerts_triggered_total                             # Counter
alerts_sent_total{channel}                         # Counter
alert_delivery_latency_seconds                     # Histogram
```

### Logging

```typescript
// Structured logging with pino
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

// Log format example
{
  "level": "info",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "requestId": "abc123",
  "userId": "user-uuid",
  "action": "scrape_complete",
  "productId": "product-uuid",
  "domain": "amazon.com",
  "price": 29.99,
  "duration_ms": 1250
}
```

### Tracing (OpenTelemetry)

For local development, tracing is optional but can be enabled with Jaeger:

```typescript
// Spans for key operations
- api.request -> db.query -> cache.get/set
- scraper.job -> http.fetch -> parse.extract -> db.insert
- alert.check -> alert.send -> email.deliver
```

### Alerting Thresholds (Local Development)

| Metric | Warning | Critical |
|--------|---------|----------|
| Scrape success rate per domain | < 80% | < 50% |
| API p95 latency | > 500ms | > 1s |
| Queue depth | > 1000 | > 5000 |
| DB connection pool exhaustion | > 80% | > 95% |
| Cache hit rate | < 70% | < 50% |

## Failure Handling

### Scraper Retry Strategy

```typescript
const retryConfig = {
  maxRetries: 3,
  backoffMultiplier: 2,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  retryableErrors: ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'HTTP_5XX']
};

async function scrapeWithRetry(job: ScrapeJob): Promise<void> {
  for (let attempt = 1; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      await scrapeProduct(job);
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt === retryConfig.maxRetries) {
        await markJobFailed(job, error);
        await publishToDLQ(job);
        return;
      }
      const delay = Math.min(
        retryConfig.initialDelayMs * Math.pow(retryConfig.backoffMultiplier, attempt - 1),
        retryConfig.maxDelayMs
      );
      await sleep(delay);
    }
  }
}
```

### Circuit Breaker (Per Domain)

```typescript
interface CircuitState {
  failures: number;
  lastFailure: Date;
  state: 'closed' | 'open' | 'half-open';
}

const circuitConfig = {
  failureThreshold: 5,      // Consecutive failures to open
  resetTimeoutMs: 60000,    // Time before trying again
  halfOpenRequests: 3       // Requests to try in half-open state
};

// Circuit opens after 5 consecutive failures for a domain
// Stays open for 1 minute, then allows 3 test requests
// If test requests succeed, circuit closes
// If test requests fail, circuit reopens
```

### Graceful Degradation

| Component Failure | Degradation Strategy |
|-------------------|---------------------|
| Redis down | Fall back to DB queries (slower), sessions use memory store |
| RabbitMQ down | API still works for reads, writes queued in memory (limited) |
| Scraper worker down | Queue backs up, no new prices, alerts still work on cached data |
| TimescaleDB continuous aggregate stale | Use raw price_history with sampling |

### Idempotency

```typescript
// Scrape job deduplication
async function enqueueScrapeJob(productId: string): Promise<void> {
  const lockKey = `scrape:pending:${productId}`;
  const acquired = await redis.setnx(lockKey, '1');

  if (!acquired) {
    logger.info({ productId }, 'Scrape job already pending, skipping');
    return;
  }

  await redis.expire(lockKey, 3600);  // 1 hour TTL
  await rabbitMQ.publish('scrape.jobs', { productId });
}

// Alert deduplication (don't re-alert for same price drop)
// Check last_triggered_at and current price before sending
```

### Backup and Recovery (Local Development)

```bash
# PostgreSQL backup
pg_dump -Fc price_tracking > backup_$(date +%Y%m%d).dump

# Restore
pg_restore -d price_tracking backup_20240115.dump

# Redis persistence (RDB snapshot every 15 minutes by default)
# For learning project, data loss is acceptable on restart
```

## Cost Tradeoffs (Scaling Considerations)

This section documents tradeoffs for when scaling beyond local development.

### Scraping: Cheerio vs Puppeteer

| Factor | Cheerio | Puppeteer |
|--------|---------|-----------|
| Memory per request | ~10 MB | ~100 MB |
| Requests/second | 50+ | 5-10 |
| JavaScript support | No | Yes |
| Detection risk | Lower | Higher (browser fingerprint) |

**Recommendation**: Use Cheerio by default, flag sites needing Puppeteer in `scraper_configs`.

### Database: Single PostgreSQL vs Separate TimescaleDB

| Factor | Combined | Separate |
|--------|----------|----------|
| Operational complexity | Lower | Higher |
| Resource isolation | Shared | Independent scaling |
| Backup/restore | Single process | Two processes |
| Cost | 1 instance | 2 instances |

**Recommendation**: Combined for local/small scale, separate for > 1M products.

### Queue: RabbitMQ vs Redis (BullMQ)

| Factor | RabbitMQ | BullMQ/Redis |
|--------|----------|--------------|
| Persistence | Built-in | Depends on Redis persistence |
| Delayed messages | Native plugin | Native support |
| Priority queues | Native | Native |
| Operational overhead | Separate service | Reuse existing Redis |

**Recommendation**: RabbitMQ provides better guarantees for critical scrape jobs.

### Cache Sizing Estimates

| Products | Price Points/Product | Cache Size | Redis Memory |
|----------|---------------------|------------|--------------|
| 1,000 | 100 | 5 MB | 32 MB |
| 10,000 | 100 | 50 MB | 128 MB |
| 100,000 | 100 | 500 MB | 1 GB |

## Scalability Considerations

### Horizontal Scaling Path

1. **API Servers**: Stateless, add instances behind load balancer
2. **Scraper Workers**: Add workers, each consumes from domain-sharded queues
3. **Database**: Read replicas for dashboard queries, primary for writes
4. **Cache**: Redis Cluster for sharding (> 10GB cache)

### Bottlenecks and Mitigations

| Bottleneck | Mitigation |
|------------|------------|
| Database writes during bulk scrape | Batch inserts, async writes via queue |
| Rate limiting per domain | Domain-sharded queues with individual rate limits |
| Memory for Puppeteer | Dedicated Puppeteer workers, browser pooling |
| TimescaleDB chunk size | Tune chunk_time_interval based on query patterns |

## Future Optimizations

- **Price prediction ML**: Store features (day of week, historical trends) for simple regression
- **Smart scheduling**: Increase scrape frequency for volatile products
- **Proxy rotation**: Integrate with proxy service for blocked sites
- **WebSocket**: Real-time price updates on dashboard
- **Multi-currency**: Currency conversion at query time using stored exchange rates
