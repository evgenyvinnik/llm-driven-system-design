# Price Tracking Service - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Problem Statement

Design a price tracking service similar to CamelCamelCamel or Honey. This system monitors product prices across e-commerce sites, stores historical data, and alerts users when prices drop. The core challenge is building a reliable, scalable scraping system that handles rate limiting, site changes, and millions of price updates daily.

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Product Tracking**: Users add products from various e-commerce sites
- **Price Scraping**: Fetch and extract current prices periodically
- **Historical Data**: Store and display price history with charts
- **Price Alerts**: Notify users when price drops below their target
- **Price Predictions**: ML-based predictions for optimal buying time

### Non-Functional Requirements
- **Freshness**: Prices updated at least every 4 hours, popular products hourly
- **Scalability**: Support millions of tracked products
- **Reliability**: Graceful handling of scraping failures and site changes
- **Latency**: Dashboard loads in under 2 seconds

### Scale Requirements
- 5 million registered users, 500,000 DAU
- 10 million unique products tracked
- 1,000 products/second scraping rate
- 35 TB/year time-series storage

## High-Level Architecture (5 minutes)

```
┌──────────────┐     ┌─────────────┐     ┌──────────────────┐
│   Browser    │────▶│   API       │────▶│   Product        │
│  Extension   │     │   Gateway   │     │   Service        │
└──────────────┘     └─────────────┘     └────────┬─────────┘
                            │                     │
┌──────────────┐            │            ┌────────▼─────────┐
│   Web App    │────────────┘            │   Alert          │
│              │                         │   Service        │
└──────────────┘                         └────────┬─────────┘
                                                  │
┌─────────────────────────────────────────────────┴───────────┐
│                    Redis (Cache + Pub/Sub)                  │
└─────────────────────────────────────────────────────────────┘
        │                    │                    │
┌───────▼───────┐   ┌────────▼────────┐   ┌──────▼───────────┐
│  PostgreSQL   │   │   TimescaleDB   │   │   Elasticsearch  │
│  (Metadata)   │   │   (Prices)      │   │   (Search)       │
└───────────────┘   └─────────────────┘   └──────────────────┘

                    ┌─────────────────┐
                    │   Scheduler     │
                    │   Service       │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   Message Queue │
                    │   (RabbitMQ)    │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
       ┌──────▼─────┐ ┌──────▼─────┐ ┌──────▼─────┐
       │  Scraper   │ │  Scraper   │ │  Scraper   │
       │  Worker 1  │ │  Worker 2  │ │  Worker N  │
       └──────┬─────┘ └──────┬─────┘ └──────┬─────┘
              │              │              │
              └──────────────┴──────────────┘
                             │
                    ┌────────▼────────┐
                    │   Proxy Pool    │
                    │   Manager       │
                    └─────────────────┘
```

## Deep Dive 1: Database Schema and Data Modeling (8 minutes)

### Core Tables

```sql
-- Products (canonical product information)
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL,
    domain VARCHAR(255) NOT NULL,
    title VARCHAR(500),
    image_url TEXT,
    current_price DECIMAL(12,2),
    currency VARCHAR(3) DEFAULT 'USD',
    last_scraped TIMESTAMP,
    scrape_priority INTEGER DEFAULT 5,  -- 1=highest, 10=lowest
    consecutive_failures INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(url)
);

CREATE INDEX idx_products_domain ON products(domain);
CREATE INDEX idx_products_scrape_status ON products(status);
CREATE INDEX idx_products_next_scrape ON products(last_scraped)
    WHERE status = 'active';

-- User product subscriptions
CREATE TABLE user_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    target_price DECIMAL(12,2),
    notify_any_drop BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

-- Price history (TimescaleDB hypertable)
CREATE TABLE price_history (
    id BIGSERIAL,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price DECIMAL(12,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, scraped_at)
);

-- Convert to hypertable
SELECT create_hypertable('price_history', 'scraped_at',
    chunk_time_interval => INTERVAL '7 days');

CREATE INDEX idx_price_history_product ON price_history(product_id, scraped_at DESC);

-- Price alerts configuration
CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    target_price DECIMAL(12,2) NOT NULL,
    alert_type VARCHAR(20) DEFAULT 'below',
    is_active BOOLEAN DEFAULT true,
    last_triggered_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, product_id, alert_type)
);

-- Scraper configuration per domain
CREATE TABLE scraper_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    domain VARCHAR(255) UNIQUE NOT NULL,
    price_selector TEXT,
    title_selector TEXT,
    json_ld_enabled BOOLEAN DEFAULT true,
    requires_js BOOLEAN DEFAULT false,
    rate_limit_rpm INTEGER DEFAULT 30,
    success_rate DECIMAL(5, 2) DEFAULT 100.0,
    last_updated TIMESTAMPTZ DEFAULT NOW()
);
```

### Time-Series Optimization with TimescaleDB

```sql
-- Compression policy for old data
ALTER TABLE price_history SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'product_id'
);

SELECT add_compression_policy('price_history', INTERVAL '7 days');

-- Continuous aggregate for daily statistics
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

-- Retention policy
SELECT add_retention_policy('price_history', INTERVAL '90 days');
```

## Deep Dive 2: Distributed Scraping Architecture (10 minutes)

### Domain-Sharded Queue Design

```
┌───────────────┐
│   Scheduler   │
│   (Leader)    │
└───────┬───────┘
        │
        ▼
┌───────────────────────────────────────────────────┐
│           RabbitMQ (Domain-Sharded Queues)        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐           │
│  │ amazon  │  │  ebay   │  │ walmart │  ...      │
│  │  queue  │  │  queue  │  │  queue  │           │
│  └─────────┘  └─────────┘  └─────────┘           │
└───────────────────────────────────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Amazon Worker │ │  eBay Worker  │ │Walmart Worker │
│   Pool (10)   │ │   Pool (5)    │ │   Pool (5)    │
└───────────────┘ └───────────────┘ └───────────────┘
```

### Why Domain-Sharded Queues?

1. **Rate limiting per domain**: Each site has different tolerances
2. **Specialized parsers**: Amazon HTML differs from Walmart
3. **Independent scaling**: More workers for popular sites
4. **Failure isolation**: If Amazon blocks us, eBay continues

### Priority-Based Scheduling

```python
class ScrapeScheduler:
    def calculate_priority(self, product):
        priority = 5  # Default

        # More watchers = higher priority
        watcher_count = get_watcher_count(product.id)
        if watcher_count > 100:
            priority -= 2
        elif watcher_count > 10:
            priority -= 1

        # Volatile prices = more frequent checks
        volatility = calculate_price_volatility(product.id)
        if volatility > 0.1:  # 10% swings
            priority -= 1

        # Recently added products need baseline
        if product.created_at > now() - days(7):
            priority -= 1

        return max(1, min(priority, 10))

    def get_scrape_interval(self, priority):
        intervals = {
            1: timedelta(minutes=30),
            2: timedelta(hours=1),
            3: timedelta(hours=2),
            4: timedelta(hours=4),
            5: timedelta(hours=6),
            6: timedelta(hours=8),
            7: timedelta(hours=12),
            8: timedelta(days=1),
            9: timedelta(days=2),
            10: timedelta(days=7),
        }
        return intervals[priority]
```

### Scraper Worker Implementation

```python
async def scrape_product(job):
    product = job.product
    config = get_scraper_config(product.domain)

    # 1. Get proxy from pool
    proxy = await proxy_pool.get_proxy(product.domain)

    try:
        # 2. Fetch page (with or without JavaScript rendering)
        if config.requires_js:
            html = await browser_pool.render(product.url, proxy=proxy)
        else:
            html = await http_client.get(product.url, proxy=proxy)

        # 3. Extract price using configured selector
        price = extract_price(html, config)

        if price is None:
            await alert_parser_failure(product.domain)
            return

        # 4. Store price point in TimescaleDB
        await timescale.insert_price(
            product_id=product.id,
            price=price,
            scraped_at=now()
        )

        # 5. Check for significant change
        if price != product.current_price:
            await handle_price_change(product, price)

        # 6. Update product metadata
        await db.update_product(product.id,
            current_price=price,
            last_scraped=now(),
            consecutive_failures=0
        )

        # 7. Mark proxy as successful
        await proxy_pool.mark_success(proxy)

    except BlockedError:
        await proxy_pool.mark_blocked(proxy)
        await job.retry(delay=300)
    except Exception as e:
        await increment_failure_count(product.id)
        await job.retry(delay=60)
```

## Deep Dive 3: Proxy Pool and Rate Limiting (6 minutes)

### Proxy Pool Management

```python
class ProxyPool:
    def __init__(self):
        self.proxies = {}  # domain -> list of proxies
        self.stats = {}    # proxy_id -> {success, failure, blocked}

    async def get_proxy(self, domain):
        available = [p for p in self.proxies[domain]
                     if not p.is_cooling_down()]

        # Weighted random selection based on success rate
        weights = [self.calculate_weight(p) for p in available]
        return random.choices(available, weights=weights)[0]

    def calculate_weight(self, proxy):
        stats = self.stats[proxy.id]
        success_rate = stats.success / (stats.success + stats.failure + 1)
        recency_factor = 1 / (time_since_last_use(proxy).seconds + 60)
        return success_rate * recency_factor

    async def mark_blocked(self, proxy):
        proxy.cooldown_until = now() + timedelta(hours=1)

        # Rotate proxy if consistently blocked
        if self.stats[proxy.id].blocked > 10:
            await self.retire_proxy(proxy)
            await self.provision_new_proxy()
```

### Rate Limiting per Domain

```python
# Redis-based rate limiting
async def check_rate_limit(domain):
    key = f"ratelimit:{domain}:{current_minute()}"
    config = await get_scraper_config(domain)

    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, 60)

    if count > config.rate_limit_rpm:
        raise RateLimitExceeded(domain)
```

### Circuit Breaker Pattern

```python
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
```

## Deep Dive 4: Alert System (5 minutes)

### Price Change Detection

```python
async def handle_price_change(product, new_price):
    old_price = product.current_price

    # Publish event for alert processing
    await rabbitmq.publish('price.changed', {
        'product_id': product.id,
        'old_price': old_price,
        'new_price': new_price,
        'change_pct': (new_price - old_price) / old_price * 100,
        'timestamp': now()
    })
```

### Alert Evaluation Service

```python
async def process_price_change(event):
    product_id = event['product_id']
    new_price = event['new_price']

    # Get all users watching this product
    subscriptions = await db.get_subscriptions(product_id)

    alerts_to_send = []

    for sub in subscriptions:
        should_alert = False

        if sub.target_price and new_price <= sub.target_price:
            should_alert = True
            alert_type = 'target_reached'
        elif sub.notify_any_drop and new_price < event['old_price']:
            should_alert = True
            alert_type = 'price_drop'

        if should_alert:
            alerts_to_send.append({
                'user_id': sub.user_id,
                'product_id': product_id,
                'type': alert_type,
                'new_price': new_price,
                'old_price': event['old_price']
            })

    # Batch send alerts
    if alerts_to_send:
        await notification_service.send_batch(alerts_to_send)
```

## Deep Dive 5: Caching Strategy (5 minutes)

### Cache-Aside Pattern

```typescript
async function getProductPrices(productId: string, range: string): Promise<PricePoint[]> {
  const cacheKey = `cache:product:${productId}:prices:${range}`;

  // Check cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss - query database
  const prices = await db.query(`
    SELECT day, low, high, avg FROM price_daily
    WHERE product_id = $1 AND day >= NOW() - $2::interval
    ORDER BY day DESC
  `, [productId, range]);

  // Populate cache
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

## Deep Dive 6: Site Change Detection (4 minutes)

### Parser Validation

```python
async def validate_parser(domain):
    config = get_scraper_config(domain)
    test_urls = get_sample_products(domain, count=10)

    success_count = 0
    for url in test_urls:
        html = await fetch(url)
        price = extract_price(html, config)
        if price and looks_valid(price):
            success_count += 1

    success_rate = success_count / len(test_urls)

    if success_rate < 0.7:
        await alert_parser_broken(domain, success_rate)
        await disable_scraping(domain)
```

### Self-Healing Options

1. **Multiple selectors**: Try fallback selectors if primary fails
2. **JSON-LD extraction**: Many sites embed structured data
3. **ML-based extraction**: Train model to find price on any page
4. **Manual intervention**: Alert team to update parser

## Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| Time-Series DB | TimescaleDB | InfluxDB | SQL familiarity, joins with relational data |
| Scraping | Cheerio (default) | Puppeteer only | 10x faster, lower resource usage |
| Queue | RabbitMQ | Redis (BullMQ) | Better persistence, delayed messages |
| Scheduling | Variable by priority | Fixed interval | Popular products get fresher data |
| Proxy Pool | Weighted random | Round-robin | Better success rate distribution |
| Rate Limiting | Per-domain Redis | Global limit | Different sites have different tolerances |

## Future Backend Enhancements

1. **ML Price Prediction**: Feature extraction for trend analysis
2. **Smart Scheduling**: Learn optimal scrape times per product
3. **Distributed Tracing**: OpenTelemetry for cross-service visibility
4. **Geographic Distribution**: Multi-region scrapers for faster access
5. **Webhook API**: Allow developers to integrate with our price data
6. **Batch Processing**: Kafka for high-throughput price event streaming
