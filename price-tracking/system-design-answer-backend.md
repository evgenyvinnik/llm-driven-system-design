# Price Tracking Service - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design a price tracking service similar to CamelCamelCamel or Honey. This system monitors product prices across e-commerce sites, stores historical data, and alerts users when prices drop. The core challenge is building a reliable, scalable scraping system that handles rate limiting, site changes, and millions of price updates daily.

## 🎯 Requirements Clarification (3 minutes)

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

## 🏗️ High-Level Architecture (5 minutes)

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

## 🗄️ Deep Dive 1: Database Schema and Data Modeling (8 minutes)

### Core Tables Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                         PRODUCTS TABLE                           │
├───────────────┬─────────────────────────────────────────────────┤
│ id            │ UUID primary key                                │
│ url           │ TEXT (unique) - product URL                     │
│ domain        │ VARCHAR(255) - amazon.com, walmart.com          │
│ title         │ VARCHAR(500) - scraped product name             │
│ image_url     │ TEXT - product image                            │
│ current_price │ DECIMAL(12,2) - latest price                    │
│ currency      │ VARCHAR(3) - USD, EUR                           │
│ last_scraped  │ TIMESTAMP - when last scraped                   │
│ scrape_priority│ INTEGER 1-10 (1=highest)                       │
│ consecutive_failures │ INTEGER - tracking failures              │
│ status        │ VARCHAR(20) - active/paused/failed              │
└───────────────┴─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                      USER_PRODUCTS TABLE                         │
├───────────────┬─────────────────────────────────────────────────┤
│ user_id       │ FK → users                                      │
│ product_id    │ FK → products                                   │
│ target_price  │ DECIMAL - alert threshold                       │
│ notify_any_drop│ BOOLEAN - alert on any decrease               │
│ UNIQUE(user_id, product_id)                                     │
└───────────────┴─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                  PRICE_HISTORY (TimescaleDB Hypertable)         │
├───────────────┬─────────────────────────────────────────────────┤
│ product_id    │ FK → products                                   │
│ price         │ DECIMAL(12,2)                                   │
│ currency      │ VARCHAR(3)                                      │
│ scraped_at    │ TIMESTAMPTZ - partition key                     │
│ Partitioned by time (7-day chunks)                              │
└───────────────┴─────────────────────────────────────────────────┘
```

### TimescaleDB Optimization Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                 TIME-SERIES DATA LIFECYCLE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Day 0-7: Raw data (full resolution)                           │
│     ├── Every scrape = one row                                  │
│     └── ~4 rows/product/day                                     │
│                                                                  │
│   Day 7+: Compressed chunks                                     │
│     ├── TimescaleDB auto-compression                            │
│     └── 90% storage reduction                                   │
│                                                                  │
│   CONTINUOUS AGGREGATE: price_daily                             │
│     ├── day: time_bucket('1 day')                               │
│     ├── low: MIN(price)                                         │
│     ├── high: MAX(price)                                        │
│     ├── avg: AVG(price)                                         │
│     ├── open: FIRST(price)                                      │
│     └── close: LAST(price)                                      │
│                                                                  │
│   Day 90+: Retention policy deletes raw data                    │
│     └── Keep only daily aggregates                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Index Strategy

| Index | Columns | Purpose |
|-------|---------|---------|
| idx_products_domain | domain | Filter by site |
| idx_products_scrape_status | status | Find active products |
| idx_products_next_scrape | last_scraped WHERE status='active' | Scheduling queries |
| idx_price_history_product | product_id, scraped_at DESC | History lookup |

## 🔧 Deep Dive 2: Distributed Scraping Architecture (10 minutes)

### Domain-Sharded Queue Design

```
┌───────────────┐
│   Scheduler   │
│   (Leader)    │
└───────┬───────┘
        │ Distributes jobs by domain
        ▼
┌───────────────────────────────────────────────────┐
│           RabbitMQ (Domain-Sharded Queues)        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐           │
│  │ amazon  │  │  ebay   │  │ walmart │  ...      │
│  │  queue  │  │  queue  │  │  queue  │           │
│  │ (5000)  │  │ (2000)  │  │ (3000)  │ products  │
│  └─────────┘  └─────────┘  └─────────┘           │
└───────────────────────────────────────────────────┘
        │              │              │
        ▼              ▼              ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ Amazon Worker │ │  eBay Worker  │ │Walmart Worker │
│   Pool (10)   │ │   Pool (5)    │ │   Pool (5)    │
│  30 RPM each  │ │  60 RPM each  │ │  45 RPM each  │
└───────────────┘ └───────────────┘ └───────────────┘
```

### Why Domain-Sharded Queues?

| Benefit | Explanation |
|---------|-------------|
| Rate limiting per domain | Each site has different tolerances (Amazon stricter than eBay) |
| Specialized parsers | Amazon HTML differs from Walmart - different extraction logic |
| Independent scaling | More workers for popular sites |
| Failure isolation | If Amazon blocks us, eBay continues unaffected |

### Priority-Based Scheduling

```
┌─────────────────────────────────────────────────────────────────┐
│                    PRIORITY CALCULATION                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Base Priority: 5 (middle of 1-10 scale)                       │
│                                                                  │
│   ADJUSTMENTS:                                                   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ Factor              │ Condition          │ Adjustment   │   │
│   ├─────────────────────┼────────────────────┼──────────────┤   │
│   │ Many watchers       │ >100 users         │ -2 (higher)  │   │
│   │ Some watchers       │ >10 users          │ -1           │   │
│   │ Volatile price      │ >10% swings        │ -1 (higher)  │   │
│   │ New product         │ <7 days old        │ -1           │   │
│   │ Low activity        │ 0 watchers, old    │ +2 (lower)   │   │
│   └─────────────────────┴────────────────────┴──────────────┘   │
│                                                                  │
│   SCRAPE INTERVALS BY PRIORITY:                                 │
│   ┌────────────┬─────────────────┐                              │
│   │ Priority 1 │ Every 30 min    │  ← Hot products              │
│   │ Priority 2 │ Every 1 hour    │                              │
│   │ Priority 3 │ Every 2 hours   │                              │
│   │ Priority 4 │ Every 4 hours   │                              │
│   │ Priority 5 │ Every 6 hours   │  ← Default                   │
│   │ Priority 6 │ Every 8 hours   │                              │
│   │ Priority 7 │ Every 12 hours  │                              │
│   │ Priority 8 │ Every 1 day     │                              │
│   │ Priority 9 │ Every 2 days    │                              │
│   │ Priority 10│ Every 7 days    │  ← Cold products             │
│   └────────────┴─────────────────┘                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Scraper Worker Flow

```
Job ──▶ get proxy ──▶ requires_js?
                       ├─ no  ──▶ Cheerio    (~100ms)
                       └─ yes ──▶ Puppeteer  (~2000ms)
                                     │
                                     ▼
                        extract price via selector
                                     │
                       ┌─────────────┴─────────────┐
                    valid                      invalid
                       │                           │
                       ▼                           ▼
              store in TimescaleDB       flag parser failure
                       │
              price changed? ──▶ publish to alert queue
                       │
                       ▼
          update product metadata ──▶ mark proxy success
```

The 20× cost difference between the two branches is the reason `requires_js` is a per-domain config flag rather than a runtime guess: getting it wrong in the permissive direction means paying two seconds and a headless Chrome for a page whose price was in the HTML all along.

## 🔄 Deep Dive 3: Proxy Pool and Rate Limiting (6 minutes)

### Proxy Pool Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       PROXY POOL MANAGER                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Proxies organized by domain:                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ amazon.com    │ proxy-1, proxy-2, proxy-3 (cooldown)    │   │
│   │ walmart.com   │ proxy-4, proxy-5                        │   │
│   │ ebay.com      │ proxy-6, proxy-7, proxy-8               │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   PROXY SELECTION (Weighted Random):                            │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                                                          │   │
│   │   weight = success_rate × recency_factor                │   │
│   │                                                          │   │
│   │   success_rate = successes / (successes + failures + 1) │   │
│   │   recency_factor = 1 / (seconds_since_use + 60)         │   │
│   │                                                          │   │
│   │   Higher weight = more likely to be selected            │   │
│   │                                                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   COOLDOWN LOGIC:                                               │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ On block detected → cooldown for 1 hour                 │   │
│   │ On 10+ blocks     → retire proxy, provision new one     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Rate Limiting Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                   REDIS-BASED RATE LIMITING                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Key Pattern: ratelimit:{domain}:{minute}                      │
│                                                                  │
│   Flow:                                                         │
│   1. INCR key                                                   │
│   2. If count == 1, EXPIRE key 60                               │
│   3. If count > domain.rate_limit_rpm → REJECT                  │
│                                                                  │
│   Example Limits:                                                │
│   ┌──────────────┬─────────────────────────────────────────┐    │
│   │ Domain       │ Requests/Minute                         │    │
│   ├──────────────┼─────────────────────────────────────────┤    │
│   │ amazon.com   │ 30 RPM (strict, aggressive blocking)    │    │
│   │ walmart.com  │ 45 RPM                                  │    │
│   │ ebay.com     │ 60 RPM (more lenient)                   │    │
│   │ bestbuy.com  │ 40 RPM                                  │    │
│   └──────────────┴─────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Circuit Breaker Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                     CIRCUIT BREAKER STATES                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   CLOSED ──(5 failures)──▶ OPEN ──(60s timeout)──▶ HALF-OPEN   │
│      ▲                                                    │     │
│      │                                                    │     │
│      │◀──────────────(3 successes)────────────────────────┘     │
│      │                                                          │
│      └──────────────(any failure)─────────▶ OPEN               │
│                                                                  │
│   Configuration:                                                │
│   • Failure threshold: 5 consecutive failures                  │
│   • Reset timeout: 60 seconds                                   │
│   • Half-open test requests: 3                                  │
│                                                                  │
│   Per-domain isolation: Each domain has independent circuit     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 🔔 Deep Dive 4: Alert System (5 minutes)

### Price Change Event Flow

```
┌──────────────┐     ┌───────────────┐     ┌────────────────────┐
│   Scraper    │────▶│   RabbitMQ    │────▶│   Alert Worker     │
│   Worker     │     │ price.changed │     │                    │
└──────────────┘     └───────────────┘     └─────────┬──────────┘
                                                      │
                     Event payload:                   │
                     • product_id                     │
                     • old_price                      │
                     • new_price                      │
                     • change_pct                     │
                     • timestamp                      │
                                                      │
                           ┌──────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │ Load all    │
                    │ subscriptions│
                    │ for product │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ For each    │
                    │ subscription│
                    └──────┬──────┘
                           │
              ┌────────────▼────────────┐
              │   Check Alert Trigger   │
              └────────────┬────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
  ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
  │ Target      │   │ Any Drop    │   │ % Change   │
  │ Price Met?  │   │ Enabled?    │   │ Threshold? │
  │ new ≤ target│   │ new < old   │   │ |change|>N │
  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
         │                 │                 │
         └─────────────────┴─────────────────┘
                           │
                    ┌──────▼──────┐
                    │ Batch Send  │
                    │ Notifications│
                    │ (email/push)│
                    └─────────────┘
```

### Alert Evaluation Logic

| Alert Type | Condition | Use Case |
|------------|-----------|----------|
| target_reached | new_price ≤ target_price | "Alert me when iPhone drops to $800" |
| price_drop | new_price < old_price AND notify_any_drop | "Alert on any price decrease" |
| change_pct | \|change\| ≥ threshold_pct | "Alert on 10%+ changes" |

## 💾 Deep Dive 5: Caching Strategy (5 minutes)

### Cache-Aside Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                      CACHE-ASIDE FLOW                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   GET /products/:id/prices?range=30d                            │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                                                          │   │
│   │   1. Check Redis: cache:product:{id}:prices:30d         │   │
│   │      │                                                   │   │
│   │      ├── HIT → Return cached data                       │   │
│   │      │                                                   │   │
│   │      └── MISS ↓                                         │   │
│   │          │                                               │   │
│   │          2. Query TimescaleDB price_daily aggregate     │   │
│   │          │                                               │   │
│   │          3. Store in Redis with TTL                     │   │
│   │          │                                               │   │
│   │          4. Return data                                 │   │
│   │                                                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Cache TTLs by Data Type

| Data Type | TTL | Invalidation Strategy |
|-----------|-----|----------------------|
| Price history (dashboard) | 5 minutes | Time-based expiry (stale OK) |
| Product details | 1 minute | Invalidate on scrape completion |
| User session | 24 hours | Logout or token expiry |
| Scraper config | 10 minutes | Admin update triggers DEL |
| Daily aggregates | 1 hour | Auto-refresh from continuous aggregate |

## 🔍 Deep Dive 6: Site Change Detection (4 minutes)

### Parser Health Monitoring

```
┌─────────────────────────────────────────────────────────────────┐
│                   PARSER VALIDATION FLOW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Scheduled job (every 6 hours per domain):                     │
│                                                                  │
│   1. Select 10 random products from domain                      │
│   2. Scrape each using current parser                           │
│   3. Check: price extracted AND looks_valid(price)?             │
│   4. Calculate success_rate = successes / 10                    │
│                                                                  │
│   Decision tree:                                                │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                                                          │   │
│   │   success_rate ≥ 90%   → HEALTHY, continue normally     │   │
│   │   success_rate ≥ 70%   → WARNING, alert on-call         │   │
│   │   success_rate < 70%   → CRITICAL, disable domain       │   │
│   │                                                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Self-Healing Options

```
┌─────────────────────────────────────────────────────────────────┐
│                   EXTRACTION FALLBACK CHAIN                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Priority order:                                               │
│                                                                  │
│   1. CSS Selector (configured per domain)                       │
│      └── #price, .price-now, [data-price]                       │
│                                                                  │
│   2. JSON-LD structured data                                    │
│      └── script[type="application/ld+json"]                     │
│      └── @type: "Product" → offers.price                        │
│                                                                  │
│   3. OpenGraph meta tags                                        │
│      └── og:price:amount                                        │
│                                                                  │
│   4. Fallback selectors (generic patterns)                      │
│      └── Common price class patterns                            │
│                                                                  │
│   5. ML-based extraction (future)                               │
│      └── Train model to find price visually                     │
│                                                                  │
│   If all fail → Mark product as needs_review                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## ⚖️ Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| Time-Series DB | ✅ TimescaleDB | ❌ InfluxDB | SQL familiarity, joins with relational data |
| Default Scraping | ✅ Cheerio (HTTP) | ❌ Puppeteer only | 10x faster, 80% of sites work without JS |
| Queue | ✅ RabbitMQ | ❌ Redis BullMQ | Better persistence, delayed messages, domain routing |
| Scheduling | ✅ Variable by priority | ❌ Fixed interval | Popular products get fresher data |
| Proxy Selection | ✅ Weighted random | ❌ Round-robin | Better success rate distribution |
| Rate Limiting | ✅ Per-domain Redis | ❌ Global limit | Different sites have different tolerances |

## 🚀 Future Backend Enhancements

1. **ML Price Prediction**: Feature extraction (day-of-week, season) for trend analysis
2. **Smart Scheduling**: Learn optimal scrape times per product (some sites update at specific hours)
3. **Distributed Tracing**: OpenTelemetry for cross-service visibility
4. **Geographic Distribution**: Multi-region scrapers for faster access and redundancy
5. **Webhook API**: Allow developers to subscribe to price changes
6. **Batch Processing**: Kafka for high-throughput price event streaming
