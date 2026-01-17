# Design Etsy - Architecture

## System Overview

Etsy is a marketplace for handmade and vintage goods. Unlike Amazon's uniform catalog, Etsy has highly varied products with unique descriptions requiring sophisticated search and personalization.

**Learning Goals:**
- Build multi-seller marketplace architecture
- Design personalization with sparse signals
- Handle unique/one-of-a-kind inventory
- Implement search relevance for varied content

---

## Traffic Estimates and Capacity Planning

### Local Development Baseline

For this learning project, we model a scaled-down version suitable for local development while maintaining realistic proportions.

| Metric | Local Dev Value | Production Equivalent |
|--------|-----------------|----------------------|
| DAU | 50 users | 5M users |
| MAU | 200 users | 20M users |
| Peak concurrent | 10 users | 100K users |
| Products in catalog | 10,000 | 100M |
| Active shops | 100 | 5M |

### Request Patterns

| Operation | Local RPS (peak) | Avg Payload Size | Notes |
|-----------|------------------|------------------|-------|
| Search queries | 5 RPS | 2 KB response | Elasticsearch query |
| Product page view | 10 RPS | 8 KB (with images meta) | Heaviest read path |
| Add to cart | 1 RPS | 500 bytes | Write operation |
| Checkout | 0.5 RPS | 2 KB | Transaction-heavy |
| Homepage/feed | 3 RPS | 15 KB | Personalized content |

### Sizing Derived from Traffic

**PostgreSQL:**
- Single instance sufficient for local dev
- Products table: ~10,000 rows x 2 KB avg = 20 MB
- Orders: ~500 rows/day x 1 KB = 500 KB/day
- No sharding needed locally; production would shard by shop_id

**Elasticsearch:**
- Single node, 1 shard, 0 replicas for local dev
- Index size: 10,000 products x 3 KB = 30 MB
- Production: 3 shards per 10M products, 1 replica each

**Redis/Valkey Cache:**
- 128 MB allocation for local dev
- Session storage: 50 users x 2 KB = 100 KB
- Product cache: 1,000 hot products x 8 KB = 8 MB
- Cart cache: 50 carts x 5 KB = 250 KB

**RabbitMQ (if implemented):**
- Single queue for order processing
- Target throughput: 10 messages/second locally
- Production: 10K messages/second with 3-node cluster

---

## SLO/SLA Targets and Error Budgets

### Service Level Objectives

| Endpoint | p50 Latency | p95 Latency | p99 Latency | Availability Target |
|----------|-------------|-------------|-------------|---------------------|
| Search | 50ms | 150ms | 300ms | 99.5% |
| Product page | 30ms | 100ms | 200ms | 99.9% |
| Add to cart | 20ms | 50ms | 100ms | 99.9% |
| Checkout | 100ms | 300ms | 500ms | 99.95% |
| Homepage | 80ms | 200ms | 400ms | 99.5% |

### Error Budgets

**Monthly Error Budget Calculation:**
- 99.9% availability = 43 minutes downtime/month
- 99.5% availability = 3.6 hours downtime/month

| Service | Availability | Monthly Error Budget | Action Threshold |
|---------|--------------|---------------------|------------------|
| Checkout flow | 99.95% | 22 minutes | Halt deploys at 50% consumed |
| Cart operations | 99.9% | 43 minutes | Alert at 25% consumed |
| Search | 99.5% | 3.6 hours | Degrade gracefully to cached results |
| Personalization | 99.0% | 7.2 hours | Fall back to trending products |

### How SLOs Drive Architecture Decisions

**Replication choices:**
- PostgreSQL: Single primary for local dev; production uses 1 primary + 2 read replicas
- Read replicas handle product reads (99.9% availability requirement)
- Writes go to primary (checkout requires strong consistency)

**Caching choices (driven by latency SLOs):**
- Product pages need 30ms p50: Cache product data in Redis (1ms read vs 5ms DB)
- Search needs 50ms p50: Cache frequent queries in Redis (bypass Elasticsearch)
- Personalization can tolerate 80ms: Compute real-time, cache for 5 minutes

**Graceful degradation:**
- If personalization exceeds error budget, serve cached trending products
- If search exceeds budget, serve category listings from PostgreSQL
- If Elasticsearch is down, return "search temporarily unavailable" (don't block checkout)

---

## Caching and Edge Strategy

### Cache Architecture Overview

```
[Browser] --> [CDN/Edge] --> [Load Balancer] --> [App Server] --> [Redis Cache] --> [PostgreSQL/ES]
                 |                                    |
            Static assets                      Cache-aside pattern
            (images, CSS, JS)                  for dynamic data
```

### CDN Layer (Simulated Locally)

For local development, we skip CDN but design for it:

| Asset Type | TTL | Cache-Control Header |
|------------|-----|---------------------|
| Product images | 30 days | `public, max-age=2592000, immutable` |
| CSS/JS bundles | 1 year | `public, max-age=31536000, immutable` (versioned) |
| Shop logos/banners | 7 days | `public, max-age=604800` |
| API responses | No CDN cache | `private, no-store` |

**Production CDN strategy:**
- Use path-based routing: `/static/*` to CDN, `/api/*` to origin
- Image optimization: WebP conversion at edge
- Geographic distribution: Cache product images in buyer's region

### Redis/Valkey Caching Strategy

**Cache-Aside Pattern (Read-Heavy Data):**

Used for: Product details, shop profiles, category listings

```javascript
async function getProduct(productId) {
  const cacheKey = `product:${productId}`

  // 1. Try cache first
  const cached = await redis.get(cacheKey)
  if (cached) {
    return JSON.parse(cached)
  }

  // 2. Cache miss: fetch from DB
  const product = await db('products').where({ id: productId }).first()

  // 3. Populate cache with TTL
  await redis.setex(cacheKey, 300, JSON.stringify(product)) // 5 min TTL

  return product
}
```

**Write-Through Pattern (Consistency-Critical Data):**

Used for: Cart contents, inventory counts

```javascript
async function updateCartItem(userId, productId, quantity) {
  const cacheKey = `cart:${userId}`

  // 1. Write to database first (source of truth)
  await db('cart_items')
    .where({ user_id: userId, product_id: productId })
    .update({ quantity })

  // 2. Immediately update cache
  const cart = await db('cart_items').where({ user_id: userId })
  await redis.setex(cacheKey, 1800, JSON.stringify(cart)) // 30 min TTL

  return cart
}
```

### Cache TTL Configuration

| Data Type | TTL | Pattern | Rationale |
|-----------|-----|---------|-----------|
| Product details | 5 min | Cache-aside | Products change rarely; 5 min staleness acceptable |
| Shop profiles | 10 min | Cache-aside | Shop info stable; longer TTL reduces DB load |
| Search results | 2 min | Cache-aside | Balance freshness with Elasticsearch load |
| Cart contents | 30 min | Write-through | Must reflect user actions immediately |
| Session data | 24 hours | Write-through | Standard session lifetime |
| Trending products | 15 min | Cache-aside | Computed aggregation; expensive to recalculate |
| User favorites | 5 min | Cache-aside | Favorites change infrequently |
| Inventory count | 30 sec | Cache-aside | Critical for "only 1 left" accuracy |

### Cache Invalidation Rules

**Event-Driven Invalidation:**

```javascript
// When product is updated by seller
async function updateProduct(productId, updates) {
  await db('products').where({ id: productId }).update(updates)

  // Invalidate product cache
  await redis.del(`product:${productId}`)

  // Invalidate search cache for affected categories
  const product = await db('products').where({ id: productId }).first()
  await redis.del(`search:category:${product.category_id}:*`)

  // Invalidate shop product list cache
  await redis.del(`shop:${product.shop_id}:products`)
}
```

**Invalidation Patterns by Event:**

| Event | Invalidate Keys | Notes |
|-------|-----------------|-------|
| Product updated | `product:{id}`, `shop:{shop_id}:products` | Immediate invalidation |
| Product sold | `product:{id}`, `trending:*` | Update inventory + rankings |
| New review added | `product:{id}`, `shop:{shop_id}:rating` | Recalculate averages |
| Shop profile updated | `shop:{shop_id}` | Direct key invalidation |
| Checkout completed | `cart:{user_id}`, `product:{id}` for each item | Clear cart, update inventory |

**Stampede Prevention:**

```javascript
async function getProductWithLock(productId) {
  const cacheKey = `product:${productId}`
  const lockKey = `lock:product:${productId}`

  const cached = await redis.get(cacheKey)
  if (cached) return JSON.parse(cached)

  // Try to acquire lock (prevents multiple DB queries on cache miss)
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX')

  if (!acquired) {
    // Another process is fetching; wait and retry
    await sleep(50)
    return getProductWithLock(productId)
  }

  try {
    const product = await db('products').where({ id: productId }).first()
    await redis.setex(cacheKey, 300, JSON.stringify(product))
    return product
  } finally {
    await redis.del(lockKey)
  }
}
```

### Local Development Cache Setup

```bash
# Start Redis via Docker (from project root)
docker run -d --name etsy-redis -p 6379:6379 redis:7-alpine

# Or via Homebrew
brew install redis
brew services start redis
```

**Environment variables:**
```bash
REDIS_URL=redis://localhost:6379
CACHE_DEFAULT_TTL=300
CACHE_ENABLED=true  # Set to false to bypass cache during debugging
```

---

## Core Components

### 1. Multi-Seller Cart

**Challenge**: Cart contains items from multiple sellers

```javascript
// Group cart by seller for checkout
async function getCartSummary(userId) {
  const items = await db('cart_items')
    .join('products', 'cart_items.product_id', 'products.id')
    .join('shops', 'products.shop_id', 'shops.id')
    .where({ 'cart_items.user_id': userId })
    .select('cart_items.*', 'products.title', 'products.price', 'shops.name as shop_name', 'shops.id as shop_id')

  // Group by shop
  const byShop = items.reduce((acc, item) => {
    if (!acc[item.shop_id]) {
      acc[item.shop_id] = { shop_name: item.shop_name, items: [], subtotal: 0 }
    }
    acc[item.shop_id].items.push(item)
    acc[item.shop_id].subtotal += item.price * item.quantity
    return acc
  }, {})

  return { shops: Object.values(byShop), total: items.reduce((sum, i) => sum + i.price * i.quantity, 0) }
}
```

### 2. Search Relevance

**Handmade Product Search Challenges:**
- Varied terminology (handmade, handcrafted, artisan)
- Misspellings in descriptions
- Unique product names

```json
{
  "settings": {
    "analysis": {
      "analyzer": {
        "etsy_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "synonym_filter", "stemmer"]
        }
      },
      "filter": {
        "synonym_filter": {
          "type": "synonym",
          "synonyms": [
            "handmade, handcrafted, artisan, homemade",
            "vintage, antique, retro, old"
          ]
        }
      }
    }
  }
}
```

### 3. Personalization

**Sparse Signal Handling:**
```javascript
// For users with limited history, fall back to category-based
async function getPersonalizedFeed(userId) {
  const history = await getUserHistory(userId)

  if (history.views.length < 5) {
    // Cold start: Show trending in broad categories
    return getTrendingProducts()
  }

  // Extract preferences from history
  const categories = extractTopCategories(history)
  const priceRange = extractPriceRange(history)
  const styles = extractStyles(history)

  // Find similar products
  return findSimilarProducts({ categories, priceRange, styles })
}
```

---

## Database Schema

```sql
-- Shops
CREATE TABLE shops (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  banner_image VARCHAR(500),
  logo_image VARCHAR(500),
  rating DECIMAL(2, 1),
  sales_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Products
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER DEFAULT 1, -- Often 1 for handmade
  category_id INTEGER REFERENCES categories(id),
  tags TEXT[],
  images TEXT[],
  is_vintage BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Favorites (items and shops)
CREATE TABLE favorites (
  user_id INTEGER REFERENCES users(id),
  favoritable_type VARCHAR(20), -- 'product' or 'shop'
  favoritable_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, favoritable_type, favoritable_id)
);
```

---

## Key Design Decisions

### 1. Orders Split by Seller

**Decision**: Create separate order records per seller

**Rationale**:
- Each seller handles own fulfillment
- Different shipping timelines
- Simpler dispute resolution

### 2. Synonym-Enhanced Search

**Decision**: Use synonym filters for product search

**Rationale**:
- Handmade products described inconsistently
- Improves recall without hurting precision

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Order structure | Split by seller | Single order | Fulfillment reality |
| Search | Synonyms + fuzzy | Exact match | Product variety |
| Inventory | Individual tracking | Aggregate | Unique items |

---

## Implementation Notes

This section documents the key infrastructure patterns implemented in the backend code and explains the reasoning behind each decision.

### Why Caching Reduces Database Load for Popular Listings

Popular products on Etsy receive disproportionately high traffic. A trending handmade item might receive thousands of views per hour, while most products see only a handful. Without caching, each product page view would require:

1. A PostgreSQL query to fetch product details (~5ms)
2. A PostgreSQL query to fetch shop information (~3ms)
3. An Elasticsearch query for similar products (~50ms)

**Implementation**: The `shared/cache.js` module implements cache-aside with stampede prevention:

```javascript
// From src/shared/cache.js
export async function cacheAsideWithLock(key, fetchFn, ttl, cacheType) {
  const cached = await getFromCache(key, cacheType);
  if (cached !== null) return cached;  // Cache hit: 1ms response

  // Acquire lock to prevent thundering herd
  const lockKey = `lock:${key}`;
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');
  // ... fetch from DB only once, then cache
}
```

**Measured impact**:
- Cache hit latency: ~1ms (Redis)
- Cache miss latency: ~60ms (DB + Elasticsearch)
- For a product with 1,000 views/hour with 5-minute TTL:
  - Without cache: 1,000 DB queries/hour
  - With cache: 12 DB queries/hour (99% reduction)

**TTL choices**:
- Product details: 5 minutes (products rarely change)
- Shop profiles: 10 minutes (even more stable)
- Search results: 2 minutes (balance freshness vs ES load)
- Trending products: 15 minutes (expensive aggregation)

### Why Idempotency Prevents Duplicate Orders

Checkout is a critical path where duplicate submissions are common:
- User double-clicks the "Place Order" button
- Network timeout triggers automatic retry
- Mobile app retries on connection restore

Without idempotency, each submission creates a new order, charging the customer multiple times.

**Implementation**: The `shared/idempotency.js` middleware intercepts checkout requests:

```javascript
// From src/shared/idempotency.js
export function idempotencyMiddleware(options = {}) {
  return async (req, res, next) => {
    const idempotencyKey = req.headers['idempotency-key'];

    // Check if we've seen this key before
    const existing = await checkIdempotencyKey(idempotencyKey);
    if (existing.exists && existing.state === 'COMPLETED') {
      // Return the cached response instead of processing again
      return res.status(existing.statusCode).json(existing.result);
    }

    // Acquire lock to prevent concurrent processing
    const acquired = await startIdempotentOperation(idempotencyKey);
    if (!acquired) {
      return res.status(409).json({ error: 'Request already processing' });
    }
    // ...
  };
}
```

**How it works**:
1. Client generates unique `Idempotency-Key` header (e.g., `user123:checkout:1705234567`)
2. First request: acquires lock, processes order, stores result
3. Duplicate requests: return cached result without re-processing
4. Key expires after 24 hours (configurable)

**Edge cases handled**:
- Concurrent requests: Lock prevents race conditions
- Processing failures: Key is deleted to allow retry
- Partial failures: Transaction rollback ensures atomicity

### Why Metrics Enable Seller Analytics and Search Optimization

Etsy sellers need visibility into their shop performance. Search engineers need to understand query patterns. Operations need to detect issues before they impact users.

**Implementation**: The `shared/metrics.js` module exposes Prometheus metrics:

```javascript
// Key metrics collected
export const productViews = new client.Counter({
  name: 'etsy_product_views_total',
  labelNames: ['category_id'],
});

export const searchLatency = new client.Histogram({
  name: 'etsy_search_latency_seconds',
  labelNames: ['query_type'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1],
});

export const ordersCreated = new client.Counter({
  name: 'etsy_orders_created_total',
  labelNames: ['status'],
});
```

**Seller analytics enabled**:
- `etsy_product_views_total{category_id}`: Which categories get most traffic?
- `etsy_orders_by_shop_total{shop_id}`: Order volume per shop
- `etsy_order_value_dollars`: Average order value distribution

**Search optimization insights**:
- `etsy_search_queries_total{has_filters}`: How often do users filter?
- `etsy_search_results_count`: Are searches returning enough results?
- `etsy_search_latency_seconds{query_type}`: Keyword vs browse performance

**Operational monitoring**:
- `etsy_cache_hits_total` vs `etsy_cache_misses_total`: Cache effectiveness
- `etsy_circuit_breaker_state{service}`: Service health
- `etsy_checkout_duration_seconds`: Checkout performance SLO tracking

### Why Circuit Breakers Protect Checkout Flow

The checkout flow depends on external services (payment gateway, Elasticsearch for inventory validation). If these services fail or slow down, the entire checkout could hang, causing:
- Poor user experience (spinning loading indicators)
- Thread pool exhaustion (cascading failures)
- Revenue loss (abandoned carts)

**Implementation**: The `shared/circuit-breaker.js` uses the opossum library:

```javascript
// From src/shared/circuit-breaker.js
const CIRCUIT_CONFIGS = {
  payment: {
    timeout: 5000,                    // Fail fast after 5s
    errorThresholdPercentage: 25,     // Open after 25% failures
    resetTimeout: 30000,              // Try again after 30s
    volumeThreshold: 5,               // Need 5 requests to calculate
  },
  search: {
    timeout: 3000,
    errorThresholdPercentage: 50,     // More tolerant for search
    resetTimeout: 15000,
    volumeThreshold: 10,
  },
};
```

**Payment circuit breaker behavior**:
1. **Closed state**: All requests pass through normally
2. **Failures accumulate**: If 25% of last 5 requests fail...
3. **Open state**: Requests immediately fail-fast with fallback
4. **Half-open state**: After 30s, allow one test request
5. **Recovery**: If test succeeds, close circuit; if fails, re-open

**Fallback strategies**:
- Payment failure: Queue order as "payment_pending", process later
- Elasticsearch down: Fall back to PostgreSQL ILIKE search
- Similar products unavailable: Return empty array (non-critical)

```javascript
// From src/routes/products.js
searchCircuitBreaker.init(
  async (query, filters) => await searchProducts(query, filters),
  async (query, filters) => {
    logger.warn('Elasticsearch unavailable, falling back to PostgreSQL');
    return await fallbackSearch(query, filters);  // Degraded but functional
  }
);
```

**Why this matters for Etsy**:
- Checkout must never hang indefinitely
- Search degradation is preferable to search unavailability
- Payment retries should be queued, not failed permanently

---

## Observability Stack

### Logging (Pino)

Structured JSON logging enables log aggregation and querying:

```javascript
// From src/shared/logger.js
const logger = pino({
  base: {
    service: 'etsy-backend',
    environment: config.nodeEnv,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Context-specific loggers
export const orderLogger = createLogger('orders');
export const searchLogger = createLogger('elasticsearch');
```

**Log format example**:
```json
{
  "level": "info",
  "time": "2024-01-16T12:00:00.000Z",
  "service": "etsy-backend",
  "context": "orders",
  "userId": 123,
  "orderId": 456,
  "msg": "Checkout completed"
}
```

### Health Checks

The `/api/health` endpoint provides comprehensive service status:

```javascript
// Response structure
{
  "status": "ok",  // or "degraded"
  "uptime": 3600,
  "services": {
    "postgres": { "status": "healthy", "latencyMs": 2 },
    "redis": { "status": "healthy", "latencyMs": 1 }
  },
  "circuitBreakers": {
    "elasticsearch": { "state": "closed" },
    "payment": { "state": "closed" }
  }
}
```

### Prometheus Metrics

Available at `/metrics` for scraping:

```
# Product metrics
etsy_product_views_total{category_id="1"} 1234

# Search performance
etsy_search_latency_seconds_bucket{query_type="keyword",le="0.1"} 950
etsy_search_latency_seconds_bucket{query_type="keyword",le="0.5"} 990

# Circuit breaker state (0=closed, 1=open, 2=half-open)
etsy_circuit_breaker_state{service="elasticsearch"} 0
etsy_circuit_breaker_state{service="payment"} 0

# Cache effectiveness
etsy_cache_hits_total{cache_type="product"} 9500
etsy_cache_misses_total{cache_type="product"} 500
```
