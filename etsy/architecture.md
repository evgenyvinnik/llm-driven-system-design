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
