# Design Etsy - Architecture

## System Overview

Etsy is a marketplace for handmade and vintage goods. Unlike Amazon's uniform catalog, Etsy has highly varied products with unique descriptions requiring sophisticated search and personalization. Core challenges include multi-seller checkout, search relevance for non-standardized products, and personalization with sparse user signals.

**Learning Goals:**
- Build multi-seller marketplace architecture
- Design personalization with sparse signals
- Handle unique/one-of-a-kind inventory
- Implement search relevance for varied content

---

## Requirements

### Functional Requirements

1. **Shops**: Sellers create and manage shops with products
2. **Search**: Find products across inconsistently described handmade goods
3. **Cart**: Multi-seller cart with grouped checkout
4. **Orders**: Per-seller order creation and fulfillment
5. **Favorites**: Save products and shops for later
6. **Reviews**: Purchase-linked reviews for trust signals
7. **Personalization**: Recommendations based on browsing and purchase history

### Non-Functional Requirements

- **Availability**: 99.95% for checkout, 99.5% for search
- **Latency**: < 50ms p50 for search, < 100ms p50 for product pages
- **Scale**: 100M products, 5M active shops, 20M MAU
- **Consistency**: Strong for inventory (unique items have quantity=1, overselling means lost sale)

---

## Capacity Estimation

### Production Scale

| Metric | Value | Derivation |
|--------|-------|------------|
| DAU | 5M | ~25% of 20M MAU |
| Peak concurrent | 100K | 2% of DAU during peak hours |
| Products | 100M | Across 5M active shops |
| Search queries/sec | 10,000 | Peak during holiday season |
| Orders/day | 500K | ~6 orders/second average |

### Storage Estimates

| Data | Size | Growth |
|------|------|--------|
| Products + descriptions | 300 GB | 100 GB/year |
| Product images | 30 TB | 10 TB/year |
| Elasticsearch index | 60 GB | Mirrors active products |
| Orders | 1 TB | 500 GB/year |
| Reviews | 50 GB | 20 GB/year |
| User favorites + history | 20 GB | 10 GB/year |

### SLO/SLA Targets

| Endpoint | p50 Latency | p95 Latency | p99 Latency | Availability |
|----------|-------------|-------------|-------------|--------------|
| Search | 50ms | 150ms | 300ms | 99.5% |
| Product page | 30ms | 100ms | 200ms | 99.9% |
| Add to cart | 20ms | 50ms | 100ms | 99.9% |
| Checkout | 100ms | 300ms | 500ms | 99.95% |
| Homepage | 80ms | 200ms | 400ms | 99.5% |

### Error Budgets

| Service | Availability | Monthly Error Budget | Action Threshold |
|---------|-------------|---------------------|------------------|
| Checkout flow | 99.95% | 22 minutes | Halt deploys at 50% consumed |
| Cart operations | 99.9% | 43 minutes | Alert at 25% consumed |
| Search | 99.5% | 3.6 hours | Degrade to cached results |
| Personalization | 99.0% | 7.2 hours | Fall back to trending products |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Client Layer                                  │
│  Homepage  │  Search  │  Shop Pages  │  Cart  │  Checkout  │  Favorites  │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       CDN / Edge Layer                                   │
│    Static Assets (images, CSS, JS)  │  API routing  │  Image CDN        │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          API Gateway / LB                                │
│          Auth  │  Rate Limiting  │  Request Routing                      │
└──────────────────────────────────────────────────────────────────────────┘
        │              │              │              │              │
        ▼              ▼              ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│   Shop     │ │  Search    │ │   Cart     │ │   Order    │ │ Personal-  │
│  Service   │ │  Service   │ │  Service   │ │  Service   │ │ ization    │
│            │ │            │ │            │ │            │ │  Service   │
│ - CRUD     │ │ - ES query │ │ - Multi-   │ │ - Per-shop │ │ - Favorites│
│ - Products │ │ - Synonyms │ │   seller   │ │   orders   │ │ - History  │
│ - Reviews  │ │ - Fuzzy    │ │   grouping │ │ - Fulfillmt│ │ - Similar  │
│ - Ratings  │ │ - Facets   │ │ - Reserve  │ │ - Reviews  │ │   products │
└────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘
        │              │              │              │              │
        ▼              ▼              ▼              ▼              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           Data Layer                                     │
├──────────────────┬──────────────────┬────────────────────────────────────┤
│    PostgreSQL    │  Elasticsearch   │         Valkey/Redis               │
│  - Shops, Users  │  - Product search│  - Sessions                       │
│  - Products      │  - Synonym filter│  - Product cache                  │
│  - Orders        │  - Fuzzy match   │  - Search cache                   │
│  - Reviews       │  - Shop boosting │  - Cart cache                     │
│  - Favorites     │                  │  - Trending products              │
│  - View history  │                  │                                    │
└──────────────────┴──────────────────┴────────────────────────────────────┘
```

---

## Core Components

### 1. Multi-Seller Cart and Checkout

**Challenge**: A buyer's cart contains items from multiple sellers. Each seller handles their own fulfillment with different shipping timelines.

**Cart Grouping**: Items are grouped by shop at display time. The cart table stores individual items; grouping happens via a JOIN to `products` and `shops`.

**Checkout Flow**:
1. Group cart items by `shop_id`
2. For each shop group, validate inventory (unique items may have quantity=1)
3. Within a single database transaction:
   - Create one `order` per shop (independent fulfillment)
   - Copy cart items to `order_items`
   - Decrement product quantities
   - Update shop `sales_count`
4. Clear cart
5. Return list of created orders

**Why Separate Orders Per Seller:**

A single unified order would require coordinating fulfillment across multiple independent sellers. Seller A in Portland ships in 3 days; Seller B in Brooklyn ships in 7 days. A single order status would be misleading (is it "shipped" when one of three sellers ships?). Separate orders allow independent tracking, simpler dispute resolution (buyer disputes with one seller, not the platform), and seller-specific shipping calculations. The trade-off is that the buyer sees multiple order confirmations instead of one, and payment must be split across sellers -- at production scale this requires a marketplace payment processor like Stripe Connect.

### 2. Search Relevance for Handmade Products

**Challenge**: Handmade products are described inconsistently. A ceramic mug might be tagged "handmade," "handcrafted," "artisan," or "homemade." Misspellings are common in seller-written descriptions.

**Elasticsearch Configuration:**

The search uses a custom `etsy_analyzer` with three layers:
- **Synonym filter**: Maps equivalent terms (`handmade, handcrafted, artisan, homemade` and `vintage, antique, retro, old`)
- **Stemmer**: Matches "necklaces" when searching "necklace"
- **Fuzzy matching**: Handles typos (edit distance of 2)

**Relevance Boosting:**

Search results are boosted by shop quality signals using `function_score`:
- Shop rating (higher-rated shops rank higher)
- Sales count (shops with more sales rank higher)
- Recency (newer listings get a small boost)

This prevents a brand-new shop with zero reviews from outranking established sellers for the same keywords.

**Why Synonym Filters over Machine-Learned Embeddings:**

ML-based semantic search (BERT embeddings, vector similarity) would better handle the vocabulary gap between buyer queries and seller descriptions. However, it requires embedding infrastructure (model serving, vector database), significantly increases search latency (50ms embedding + 30ms vector search vs 20ms synonym-enhanced keyword search), and is harder to debug ("why did this result appear?"). Synonym filters are transparent, tunable, and operationally simple. The trade-off is manual maintenance -- when new terminology emerges (e.g., "upcycled"), synonyms must be manually added to the filter.

### 3. Personalization with Sparse Signals

**Challenge**: Most Etsy buyers have limited purchase history (many buy once for a specific occasion). Traditional collaborative filtering fails with sparse data.

**Cold-Start Strategy:**
- Users with < 5 views: Show trending products by broad category
- Users with 5-20 views: Extract top categories and price ranges from view history, find similar products
- Users with 20+ views: Full personalization with category affinity, price range, style preferences

**Similar Products:**

Elasticsearch `more_like_this` query finds products with similar descriptions and tags. This works well for Etsy because product descriptions are rich text with many distinctive terms.

**Favorites as Explicit Signals:**

Unlike implicit signals (page views), favorites are explicit interest indicators. Users can favorite both products and shops. This provides higher-confidence personalization data than view history, which may include accidental clicks.

---

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username VARCHAR(50) UNIQUE NOT NULL,
  full_name VARCHAR(200),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Categories
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Shops
CREATE TABLE shops (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  location VARCHAR(200),
  shipping_policy JSONB,
  return_policy TEXT,
  rating DECIMAL(2, 1) DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  sales_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Products
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER DEFAULT 1,     -- Often 1 for handmade/unique
  tags TEXT[],
  images TEXT[],
  is_vintage BOOLEAN DEFAULT false,
  is_handmade BOOLEAN DEFAULT true,
  shipping_price DECIMAL(10, 2) DEFAULT 0,
  processing_time VARCHAR(50),
  view_count INTEGER DEFAULT 0,
  favorite_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Favorites (polymorphic: products and shops)
CREATE TABLE favorites (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  favoritable_type VARCHAR(20) NOT NULL,  -- 'product' or 'shop'
  favoritable_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, favoritable_type, favoritable_id)
);

-- View history (for personalization)
CREATE TABLE view_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  viewed_at TIMESTAMP DEFAULT NOW()
);

-- Cart items
CREATE TABLE cart_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER DEFAULT 1 CHECK (quantity > 0),
  added_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

-- Orders (one per shop per checkout)
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  buyer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  order_number VARCHAR(50) NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL,
  shipping DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  shipping_address JSONB,
  status VARCHAR(30) DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Order items
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title VARCHAR(200) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  image_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews (linked to purchase)
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Index Strategy

```sql
CREATE INDEX idx_products_shop ON products(shop_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_price ON products(price);
CREATE INDEX idx_products_active ON products(is_active);
CREATE INDEX idx_favorites_user ON favorites(user_id);
CREATE INDEX idx_view_history_user ON view_history(user_id, viewed_at DESC);
CREATE INDEX idx_cart_user ON cart_items(user_id);
CREATE INDEX idx_orders_buyer ON orders(buyer_id);
CREATE INDEX idx_orders_shop ON orders(shop_id);
CREATE INDEX idx_reviews_product ON reviews(product_id);
CREATE INDEX idx_reviews_shop ON reviews(shop_id);
CREATE INDEX idx_shops_slug ON shops(slug);
```

---

## API Design

### Public API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/products` | List products (paginated, filterable) |
| GET | `/api/products/:id` | Product detail |
| GET | `/api/products/:id/similar` | Similar products (ES more_like_this) |
| GET | `/api/search` | Search with filters and facets |
| GET | `/api/categories` | Category list |
| GET | `/api/categories/:slug/products` | Products in category |
| GET | `/api/shops/:slug` | Shop profile |
| GET | `/api/shops/:slug/products` | Shop product list |

### Authenticated API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/cart` | Get cart (grouped by shop) |
| POST | `/api/cart` | Add item to cart |
| PUT | `/api/cart/:id` | Update quantity |
| DELETE | `/api/cart/:id` | Remove from cart |
| POST | `/api/checkout` | Create orders (one per shop) |
| GET | `/api/orders` | Order history |
| GET | `/api/favorites` | User favorites (products and shops) |
| POST | `/api/favorites` | Add favorite |
| DELETE | `/api/favorites/:type/:id` | Remove favorite |
| POST | `/api/reviews` | Submit review (must have purchased) |

### Seller API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/shops` | Create shop |
| PUT | `/api/shops/:id` | Update shop |
| GET | `/api/shops/:id/orders` | Shop orders |
| GET | `/api/shops/:id/analytics` | Shop analytics |
| POST | `/api/shops/:id/products` | Create product |
| PUT | `/api/shops/:id/products/:pid` | Update product |
| DELETE | `/api/shops/:id/products/:pid` | Delete product |

### Health and Observability

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Liveness + service status |
| GET | `/metrics` | Prometheus metrics |

---

## Key Design Decisions

### 1. Orders Split by Seller

**Decision**: Create separate order records per seller during checkout.

Each seller handles their own fulfillment with different shipping timelines and locations. A unified order would require coordinating across independent sellers, leading to confusing order statuses ("partially shipped" when 1 of 3 sellers ships). Separate orders enable independent tracking, simpler dispute resolution (buyer disputes with one seller), and seller-specific shipping calculations. The trade-off is that buyers see multiple order confirmations and the platform must handle payment splitting across sellers. At production scale, Stripe Connect handles marketplace payouts; locally, payment is simulated.

### 2. Synonym-Enhanced Search

**Decision**: Custom Elasticsearch analyzer with synonym filters for handmade product terminology.

Exact-match search fails for Etsy because sellers describe identical products differently ("handmade" vs "handcrafted" vs "artisan"). The synonym filter maps these to equivalent terms at index time, improving recall without hurting precision. Combined with fuzzy matching (edit distance 2), this handles both vocabulary gaps and typos. The trade-off is manual synonym maintenance -- when new terminology emerges in the maker community, the synonym list must be updated manually. ML-based semantic search would handle this automatically but adds significant infrastructure complexity.

### 3. Unique Item Inventory

**Decision**: Individual product-level quantity tracking (often quantity=1) instead of aggregate inventory.

Handmade items are frequently one-of-a-kind. Once sold, there is no restocking -- the sale is lost forever. This makes inventory accuracy even more critical than for mass-produced goods. For unique items, a 15-minute cart reservation (at production scale) prevents the scenario where two buyers see "in stock," both add to cart, and one discovers during checkout that the item was sold. The trade-off is that cart reservations temporarily reduce availability for popular items -- if a buyer reserves a unique necklace and abandons their cart, no one else can buy it for 15 minutes.

---

## Caching and Edge Strategy

### Cache Architecture

```
[Browser] ──▶ [CDN/Edge] ──▶ [Load Balancer] ──▶ [App Server] ──▶ [Redis Cache] ──▶ [PostgreSQL/ES]
                 │                                      │
            Static assets                         Cache-aside pattern
            (images, CSS, JS)                     for dynamic data
```

### Redis/Valkey Caching Strategy

**Cache-Aside Pattern** (read-heavy data: product details, shop profiles):
1. Check Redis first (1ms)
2. On miss, query PostgreSQL (5ms) or Elasticsearch (50ms for similar products)
3. Populate cache with TTL

**Write-Through Pattern** (consistency-critical: cart contents, inventory counts):
1. Write to PostgreSQL first (source of truth)
2. Immediately update Redis cache

### Cache TTL Configuration

| Data Type | TTL | Pattern | Rationale |
|-----------|-----|---------|-----------|
| Product details | 5 min | Cache-aside | Products change rarely; 5 min staleness acceptable |
| Shop profiles | 10 min | Cache-aside | Shop info stable; longer TTL reduces DB load |
| Search results | 2 min | Cache-aside | Balance freshness with ES load |
| Cart contents | 30 min | Write-through | Must reflect user actions immediately |
| Session data | 24 hours | Write-through | Standard session lifetime |
| Trending products | 15 min | Cache-aside | Expensive aggregation |
| Inventory count | 30 sec | Cache-aside | Critical for "only 1 left" accuracy |

### Stampede Prevention

When a popular product's cache expires, hundreds of concurrent requests would all miss cache and hit the database simultaneously. A Redis-based lock (`SETNX` with 5-second TTL) ensures only one request fetches from the database while others wait and retry.

### Cache Invalidation

Event-driven invalidation on product update, product sold, new review, and checkout completion. Each event invalidates specific cache keys (product, shop product list, trending) to avoid stale data without full cache flushes.

---

## Consistency and Idempotency

### Checkout Idempotency

The checkout endpoint accepts an `Idempotency-Key` header. The middleware checks for existing completed operations and returns cached responses. Concurrent duplicate requests are rejected with 409 Conflict. Failed operations allow retry with the same key.

**Why This Matters for Etsy:**

Unique items (quantity=1) make duplicate orders catastrophic. If a double-click creates two orders for a one-of-a-kind handmade necklace, the second order is unfulfillable. Idempotency ensures the second request returns the existing order instead of creating a new one.

### Inventory Consistency

Checkout validates inventory and decrements quantities within a single PostgreSQL transaction. For unique items (quantity=1), this is effectively a compare-and-swap: the transaction checks `quantity > 0` and sets `quantity = 0` atomically.

---

## Observability

### Metrics (Prometheus)

Key metrics exposed at `GET /metrics`:

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `etsy_product_views_total` | Counter | category_id | Product page traffic |
| `etsy_search_latency_seconds` | Histogram | query_type | Search performance |
| `etsy_search_queries_total` | Counter | has_filters | Filter usage patterns |
| `etsy_orders_created_total` | Counter | status | Order volume |
| `etsy_order_value_dollars` | Histogram | - | Order value distribution |
| `etsy_cache_hits_total` | Counter | cache_type | Cache effectiveness |
| `etsy_cache_misses_total` | Counter | cache_type | Cache miss rate |
| `etsy_circuit_breaker_state` | Gauge | service | ES, payment health |
| `etsy_checkout_duration_seconds` | Histogram | - | Checkout SLO tracking |

### Structured Logging (Pino)

JSON-formatted logs with service name, environment, and ISO timestamps. Context-specific loggers for orders, search, and general application events.

### Health Checks

The `/api/health` endpoint reports:
- Overall status (`ok` or `degraded`)
- PostgreSQL connectivity and latency
- Redis connectivity and latency
- Circuit breaker states (Elasticsearch, payment)
- Uptime

### Graceful Degradation

SLO-driven degradation strategy:
- If personalization exceeds error budget, serve cached trending products
- If search exceeds budget, serve category listings from PostgreSQL
- If Elasticsearch is down, return "search temporarily unavailable" (never block checkout)

---

## Failure Handling

### Circuit Breakers

Circuit breakers (Opossum library) protect against cascading failures:

| Service | Timeout | Error Threshold | Reset Timeout | Fallback |
|---------|---------|-----------------|---------------|----------|
| Elasticsearch (search) | 3s | 50% of 10 requests | 15s | PostgreSQL ILIKE search |
| Elasticsearch (similar) | 3s | 50% of 10 requests | 15s | Return empty array |
| Payment gateway | 5s | 25% of 5 requests | 30s | Queue as payment_pending |

**Search Fallback:**

When the Elasticsearch circuit breaker opens, search degrades to PostgreSQL `ILIKE` queries. This provides basic text matching without synonyms, fuzzy matching, or facets -- but search remains functional rather than returning errors.

---

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless, scale behind load balancer. Sessions in Redis.
2. **PostgreSQL**: Read replicas for product browsing and shop pages. Writes (orders, inventory) to primary.
3. **Elasticsearch**: Add nodes, increase shard count (3 shards per 10M products, 1 replica each).
4. **Redis cluster**: Shard cache and session data across nodes.
5. **Shop-based sharding**: At extreme scale, shard PostgreSQL by shop_id for write-heavy operations.

### What Breaks First

1. **Elasticsearch indexing lag**: Product updates from thousands of sellers take seconds to appear in search. Solution: dedicated indexing pipeline with batched updates.
2. **Single PostgreSQL write primary**: Checkout transaction contention during peak sales. Solution: shard by shop_id.
3. **Similar products query latency**: `more_like_this` on 100M products is expensive. Solution: precompute and cache similar products.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Order structure | Split by seller | Single unified order | Independent fulfillment reality |
| Search | Synonyms + fuzzy matching | ML semantic search | Operationally simpler, debuggable |
| Inventory | Per-product quantity tracking | Aggregate inventory | Unique items require individual tracking |
| Caching | Redis cache-aside + stampede lock | No cache | 99% DB load reduction for popular products |
| Personalization | View history + favorites | Collaborative filtering | Works with sparse signals |
| Circuit breakers | Opossum library | Custom implementation | Battle-tested, metrics integration |
| Logging | Pino (JSON) | Morgan (text) | Structured for log aggregation |

---

## Implementation Notes

This section documents the actual local implementation and maps production-scale design to what runs on Docker + Node.js + React.

### Local Architecture

```
┌───────────────────┐         ┌────────────────────┐
│  React Frontend   │────────▶│  Express Backend   │
│  localhost:5173   │         │  localhost:3001     │
└───────────────────┘         └────────────────────┘
                                 │      │      │
                    ┌────────────┘      │      └────────────┐
                    ▼                   ▼                    ▼
            ┌──────────────┐  ┌──────────────┐  ┌────────────────┐
            │  PostgreSQL  │  │    Valkey     │  │ Elasticsearch  │
            │  :5432       │  │    :6379      │  │   :9200        │
            └──────────────┘  └──────────────┘  └────────────────┘
```

### Production-Grade Patterns Actually Implemented

| Pattern | File | Purpose |
|---------|------|---------|
| Cache-aside + stampede lock | `backend/src/shared/cache.ts` | Redis caching with lock-based stampede prevention |
| Idempotency middleware | `backend/src/shared/idempotency.ts` | Prevents duplicate orders on checkout retry |
| Circuit breaker | `backend/src/shared/circuit-breaker.ts` | Protects Elasticsearch and payment calls (Opossum) |
| Structured logging | `backend/src/shared/logger.ts` | Pino JSON logs with context-specific loggers |
| Prometheus metrics | `backend/src/shared/metrics.ts` | Product views, search latency, order counters, cache hit rates |
| Elasticsearch search | `backend/src/services/elasticsearch.ts` | Custom analyzer, synonym filter, function_score boosting |
| Redis sessions | `backend/src/services/redis.ts` | Session storage via connect-redis |
| Multi-seller checkout | `backend/src/routes/orders.ts` | Per-shop order creation within a transaction |
| Favorites | `backend/src/routes/favorites.ts` | Polymorphic favorites (products and shops) |
| View history | `backend/src/routes/products.ts` | Tracks product views for personalization |
| Similar products | `backend/src/routes/products.ts` | ES more_like_this query |
| Health checks | `backend/src/index.ts` | `/api/health` with DB, Redis, circuit breaker status |

### What Was Simplified or Substituted

| Production | Local | Reason |
|------------|-------|--------|
| CDN for product images | Direct URL references (picsum.photos) | No image storage infrastructure |
| Stripe Connect (marketplace payouts) | Simulated payment | No real payment splitting |
| Cart reservations (15 min for unique items) | No reservation | Simplified; checkout validates at purchase time |
| Message queue (order events) | Synchronous processing | No RabbitMQ/Kafka in docker-compose |
| Multi-region Elasticsearch | Single node, 1 shard, 0 replicas | Sufficient for local dev |
| Multiple API instances + LB | Single Express server (supports 3001-3003) | Can test with multiple ports |
| Kubernetes | docker-compose | Sufficient for local development |
| Rate limiting | No rate limiting | Not needed locally |

### What Was Omitted

- **Message queue**: No RabbitMQ or Kafka; order events processed synchronously
- **CDN**: No static asset caching or image optimization
- **Multi-region replication**: Single PostgreSQL and Elasticsearch instances
- **Kubernetes orchestration**: docker-compose only
- **Real payment processing**: No Stripe or payment gateway integration
- **OAuth / SSO**: Session-based auth only
- **Personalized homepage recommendations**: View history is tracked but no recommendation engine
- **"Because you viewed" suggestions**: Not implemented
- **Order archival**: No tiered storage or data lifecycle management
- **Audit logging**: No immutable audit trail (unlike Shopify and Amazon implementations)
- **Cart reservations**: Unique items are not reserved on add-to-cart
