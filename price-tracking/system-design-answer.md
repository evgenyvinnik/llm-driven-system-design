# Price Tracking Service - System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing a price tracking service similar to CamelCamelCamel or Honey. This system monitors product prices across e-commerce sites, stores historical data, and alerts users when prices drop. Let me start by clarifying requirements."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Product Tracking** - Users can add products from various e-commerce sites to track
2. **Price Scraping** - System fetches and extracts current prices periodically
3. **Historical Data** - Store and display price history with charts
4. **Price Alerts** - Notify users when price drops below their target
5. **Price Predictions** - ML-based predictions for optimal buying time
6. **Browser Extension** - Quick add products while browsing

### Non-Functional Requirements

- **Freshness** - Prices updated at least every 4 hours, popular products hourly
- **Scalability** - Support millions of tracked products
- **Reliability** - Graceful handling of scraping failures and site changes
- **Latency** - Dashboard loads in under 2 seconds

### Out of Scope

"For this discussion, I'll set aside: cashback features, coupon aggregation, affiliate revenue optimization, and mobile apps."

---

## 2. Scale Estimation (3 minutes)

### Assumptions
- 5 million registered users
- 500,000 DAU
- 50 million products being tracked
- Average user tracks 20 products
- 10 million unique products (some tracked by multiple users)

### Scraping Estimates
- 10 million unique products / 4 hours = 700 products/second
- Popular products (10%): updated hourly = 280 products/second
- **Total scraping rate**: ~1,000 products/second

### Storage Estimates
- Product metadata: 2 KB per product
- Price point: 50 bytes (timestamp + price + currency)
- 4 price points/day x 365 days x 10M products = 730 billion price points
- **Time-series storage**: ~35 TB/year

### Alert Delivery
- 1% of products have price changes daily = 100,000 alerts/day
- Peak: 10,000 alerts/hour

---

## 3. High-Level Architecture (8 minutes)

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

### Core Components

1. **Product Service** - CRUD for products and user subscriptions
2. **Scheduler Service** - Determines which products to scrape and when
3. **Scraper Workers** - Fetch pages and extract prices using site-specific parsers
4. **Proxy Pool Manager** - Rotates proxies to avoid rate limiting
5. **Alert Service** - Evaluates price changes and sends notifications
6. **Prediction Service** - ML model for price trend predictions

---

## 4. Data Model (5 minutes)

### Core Entities

```sql
-- Products (canonical product information)
CREATE TABLE products (
    id              UUID PRIMARY KEY,
    url             VARCHAR(2048) UNIQUE NOT NULL,
    domain          VARCHAR(255) NOT NULL,
    title           VARCHAR(500),
    image_url       VARCHAR(2048),
    current_price   DECIMAL(12,2),
    currency        VARCHAR(3) DEFAULT 'USD',
    last_scraped    TIMESTAMP,
    scrape_priority INTEGER DEFAULT 5,  -- 1=highest, 10=lowest
    status          VARCHAR(20) DEFAULT 'active',
    created_at      TIMESTAMP DEFAULT NOW()
);

-- User product subscriptions
CREATE TABLE user_products (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL,
    product_id      UUID NOT NULL,
    target_price    DECIMAL(12,2),
    notify_any_drop BOOLEAN DEFAULT false,
    created_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

-- Price history (TimescaleDB hypertable)
CREATE TABLE price_history (
    product_id      UUID NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL,
    price           DECIMAL(12,2) NOT NULL,
    currency        VARCHAR(3) NOT NULL,
    availability    BOOLEAN DEFAULT true
);

SELECT create_hypertable('price_history', 'recorded_at');

-- Site-specific scraping configurations
CREATE TABLE scraper_configs (
    id              UUID PRIMARY KEY,
    domain          VARCHAR(255) UNIQUE NOT NULL,
    price_selector  VARCHAR(500),        -- CSS/XPath selector
    title_selector  VARCHAR(500),
    parser_type     VARCHAR(50),         -- 'css', 'xpath', 'json-ld', 'custom'
    rate_limit      INTEGER DEFAULT 100, -- requests per minute
    requires_js     BOOLEAN DEFAULT false,
    last_validated  TIMESTAMP
);
```

### Time-Series Optimization

```sql
-- Compress old data (TimescaleDB feature)
ALTER TABLE price_history SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'product_id'
);

SELECT add_compression_policy('price_history', INTERVAL '7 days');

-- Create continuous aggregate for daily prices
CREATE MATERIALIZED VIEW daily_prices
WITH (timescaledb.continuous) AS
SELECT
    product_id,
    time_bucket('1 day', recorded_at) AS day,
    MIN(price) as min_price,
    MAX(price) as max_price,
    AVG(price) as avg_price
FROM price_history
GROUP BY product_id, time_bucket('1 day', recorded_at);
```

---

## 5. Deep Dive: Scraping at Scale (10 minutes)

"The scraping system is the most challenging component. Let me walk through the design."

### Scheduling Strategy

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

### Distributed Scraping Architecture

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

1. **Rate limiting per domain** - Each site has different tolerances
2. **Specialized parsers** - Amazon HTML differs from Walmart
3. **Independent scaling** - More workers for popular sites
4. **Failure isolation** - If Amazon blocks us, eBay continues

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
            # Parser might be broken - alert for investigation
            await alert_parser_failure(product.domain)
            return

        # 4. Store price point
        await timescale.insert_price(
            product_id=product.id,
            price=price,
            recorded_at=now()
        )

        # 5. Check for significant change
        if price != product.current_price:
            await handle_price_change(product, price)

        # 6. Update product metadata
        await db.update_product(product.id,
            current_price=price,
            last_scraped=now()
        )

        # 7. Mark proxy as successful
        await proxy_pool.mark_success(proxy)

    except BlockedError:
        await proxy_pool.mark_blocked(proxy)
        await job.retry(delay=300)  # Retry in 5 minutes
    except Exception as e:
        await job.retry(delay=60)
```

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

---

## 6. Deep Dive: Alert System (5 minutes)

### Price Change Detection

```python
async def handle_price_change(product, new_price):
    old_price = product.current_price

    # Publish event for alert processing
    await kafka.publish('price.changed', {
        'product_id': product.id,
        'old_price': old_price,
        'new_price': new_price,
        'change_pct': (new_price - old_price) / old_price * 100,
        'timestamp': now()
    })
```

### Alert Evaluation

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

### Notification Channels

```python
async def send_alert(alert):
    user = await db.get_user(alert['user_id'])
    product = await db.get_product(alert['product_id'])

    message = format_alert_message(alert, product)

    # Multi-channel delivery
    tasks = []

    if user.email_enabled:
        tasks.append(email_service.send(user.email, message))

    if user.push_enabled and user.push_token:
        tasks.append(push_service.send(user.push_token, message))

    if user.browser_extension_id:
        tasks.append(extension_service.notify(user.browser_extension_id, message))

    await asyncio.gather(*tasks)
```

---

## 7. Price Prediction (3 minutes)

### Feature Engineering

```python
def extract_features(product_id):
    history = get_price_history(product_id, days=365)

    features = {
        # Time-based features
        'day_of_week': current_day_of_week(),
        'month': current_month(),
        'days_since_last_drop': days_since_last_price_drop(history),

        # Price statistics
        'current_vs_min': current_price / min(history),
        'current_vs_avg': current_price / avg(history),
        'volatility_30d': price_volatility(history[-30:]),

        # Trend features
        'trend_7d': calculate_trend(history[-7:]),
        'trend_30d': calculate_trend(history[-30:]),

        # Seasonality
        'is_holiday_season': is_holiday_season(),
        'is_prime_day': is_prime_day(),
    }

    return features
```

### Prediction Output

```python
def predict_price_trend(product_id):
    features = extract_features(product_id)

    # Model outputs probability of price drop
    drop_probability = model.predict(features)

    return {
        'drop_likely': drop_probability > 0.6,
        'confidence': drop_probability,
        'recommendation': 'wait' if drop_probability > 0.6 else 'buy_now',
        'predicted_low': estimate_low_price(features)
    }
```

---

## 8. Trade-offs and Alternatives (3 minutes)

### Trade-off 1: Scraping Frequency vs. Cost

**Chose**: Variable frequency based on popularity and volatility
**Trade-off**: Popular products get fresher data; obscure ones may be stale
**Alternative**: Uniform frequency (simpler but wasteful)

### Trade-off 2: Headless Browser vs. HTTP Requests

**Chose**: HTTP for most sites, headless browser only when needed
**Trade-off**: Headless is 10x slower and more resource-intensive
**Alternative**: Always use headless (more reliable but expensive)

### Trade-off 3: TimescaleDB vs. InfluxDB

**Chose**: TimescaleDB (PostgreSQL extension)
**Rationale**: Familiar SQL, excellent compression, easy joins with relational data
**Alternative**: InfluxDB (purpose-built for time-series but separate query language)

---

## 9. Handling Site Changes (3 minutes)

"E-commerce sites frequently change their HTML structure, breaking our parsers."

### Detection

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

1. **Multiple selectors** - Try fallback selectors if primary fails
2. **JSON-LD extraction** - Many sites embed structured data
3. **ML-based extraction** - Train model to find price on any page
4. **Manual intervention** - Alert team to update parser

---

## 10. Scalability Considerations (2 minutes)

### Horizontal Scaling

- **Scrapers**: Add more workers per domain queue as needed
- **API**: Stateless services behind load balancer
- **Database**: Read replicas for dashboard queries

### Data Lifecycle

```sql
-- Retention policy: detailed data for 90 days, aggregates forever
SELECT add_retention_policy('price_history', INTERVAL '90 days');

-- Keep daily aggregates indefinitely
-- daily_prices continuous aggregate is not subject to retention
```

---

## Summary

"To summarize, I've designed a price tracking service with:

1. **Priority-based scheduling** ensuring popular products are scraped more frequently
2. **Domain-sharded scraping** with per-site rate limiting and specialized parsers
3. **Proxy rotation** to avoid blocks and maintain reliability
4. **Time-series storage** with TimescaleDB for efficient price history
5. **Real-time alerting** when prices hit user targets
6. **ML predictions** for optimal buying recommendations

The key insight is treating each e-commerce domain as a separate subsystem with its own rate limits, parsers, and failure modes, while maintaining a unified user experience."

---

## Questions I'd Expect

**Q: How do you handle Amazon's anti-scraping measures?**
A: Combination of residential proxies, request randomization (headers, timing), and respecting robots.txt rate limits. For critical products, we may use Amazon's Product Advertising API where available.

**Q: What happens when a product URL changes?**
A: We store the canonical product ID where available. For URL changes, we detect 301 redirects and update our records. Users can also manually update tracked products.

**Q: How accurate are the predictions?**
A: Our model achieves ~65% accuracy on "will price drop in next 7 days" for products with sufficient history. We're transparent about confidence levels and always present predictions as suggestions.
