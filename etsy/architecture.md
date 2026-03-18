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

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (RootComponent)
├── Header (navigation, search bar, cart badge, auth links, seller link)
├── <Outlet /> (route-specific content)
│   ├── index.tsx (HomePage)
│   │   ├── Category grid (emoji icons, links to category pages)
│   │   ├── ProductCard[] (trending products grid)
│   │   └── Sell CTA section
│   ├── search.tsx (SearchPage)
│   │   └── ProductCard[] (search results with filters)
│   ├── product.$productId.tsx (ProductDetailPage)
│   │   ├── Image gallery
│   │   ├── Shop info card
│   │   ├── Add to cart / favorite actions
│   │   └── Similar products (ES more_like_this)
│   ├── shop.$shopSlug.tsx (ShopPage)
│   │   └── ProductCard[] (shop's product listing)
│   ├── category.$categorySlug.tsx (CategoryPage)
│   │   └── ProductCard[] (category products)
│   ├── cart.tsx (CartPage)
│   │   └── Cart items grouped by shop
│   ├── checkout.tsx (CheckoutPage)
│   │   ├── Shipping address form
│   │   ├── Payment placeholder
│   │   └── Order summary (grouped by shop)
│   ├── orders.tsx (OrderHistoryPage)
│   ├── favorites.tsx (FavoritesPage)
│   ├── login.tsx / register.tsx (AuthPages)
│   ├── seller/dashboard.tsx (SellerDashboard)
│   ├── seller/create-shop.tsx (CreateShopPage)
│   └── seller/products.new.tsx (AddProductPage)
└── Footer (static footer with navigation links)
```

### Zustand Stores

**`authStore`** -- Manages user authentication with cookie-based sessions. Unlike the hotel-booking project which uses JWT, Etsy relies on HTTP-only cookies sent via `credentials: 'include'` on all fetch requests. The store does not persist anything to localStorage because the session cookie handles persistence automatically. The `checkAuth()` action calls `GET /api/auth/me` on app startup (invoked from `__root.tsx`). If the cookie is expired or invalid, the user is set to null.

**`cartStore`** -- Manages the multi-seller shopping cart state. The cart is server-authoritative: every mutation (add, update quantity, remove) sends a request to the backend and then re-fetches the entire cart. The `fetchCart()` action is called in the root component whenever `isAuthenticated` becomes true. The cart response groups items by shop, with per-shop subtotals and shipping, plus a summary object with grand totals. The store's `clearCart()` action both sends a DELETE to the server and sets local state to null.

There is no separate store for search state, favorites, or orders. These features use local `useState` within their route components.

### Routing

TanStack Router with file-based routing. Routes are organized into three groups:

- **Buyer routes**: `/` (home), `/search` (results with query params), `/product/$productId` (detail), `/shop/$shopSlug` (shop profile), `/category/$categorySlug` (category listing), `/cart`, `/checkout`, `/orders`, `/favorites`, `/login`, `/register`
- **Seller routes**: `/seller/dashboard`, `/seller/create-shop`, `/seller/products/new`

The root layout (`__root.tsx`) initializes both auth and cart state on mount. Auth check runs unconditionally; cart fetch runs only when authenticated. This ensures the cart badge in the header shows the correct count immediately after page load.

### Data Fetching

API communication flows through a lightweight HTTP client (`services/api.ts`) with typed `get`, `post`, `put`, and `delete` methods. All requests include `credentials: 'include'` for cookie-based session management. Data fetching is done in `useEffect` hooks. The homepage fetches trending products and categories in parallel via `Promise.all` to minimize loading time.

There is no client-side caching, no React Query, and no SWR. The search page re-fetches results when query parameters change (via URL search params). The product detail page fetches product info, shop info, and similar products on mount.

### Key UI Patterns

- **Multi-Seller Cart Grouping**: The cart page groups items by shop, showing each shop's name, individual item prices, and per-shop shipping costs. This mirrors the order creation flow where one order is created per shop. The checkout page shows the same grouping with a prominent note: "You will receive N separate shipment(s)."
- **Category Browsing with Emoji Icons**: The homepage renders categories as a responsive grid of circular icon buttons. Each category slug maps to a hardcoded emoji via `getCategoryEmoji()`. Clicking a category navigates to `/category/$categorySlug` which fetches products filtered by that category.
- **Favorite Toggle**: Product cards and product detail pages include a heart icon that toggles favorite status. Favoriting sends `POST /api/favorites` with the product ID and type. The favorite state is re-fetched per page load, not tracked globally (no favorites store).
- **Seller Dashboard**: The seller section provides a shop creation form, product listing management, and an analytics view showing order count and revenue. Sellers navigate between buyer and seller views via the header.
- **Checkout Flow**: The checkout page validates cart contents, collects a shipping address form, and creates orders via `POST /api/orders/checkout`. The response contains an array of `Order` objects (one per shop). On success, the cart is cleared and the user is redirected to the orders page.

---

## Deep Pattern Explanations

This section explains each production-grade backend pattern implemented in the project. Each explanation covers what the pattern is, why it exists, how it works in this project, and what would go wrong without it.

### RBAC (Role-Based Access Control)

**What it is**: RBAC is an authorization model where permissions are assigned to roles, and users are assigned to roles. Rather than checking individual permissions for each user, the system checks whether the user's role grants the required permission. Roles create a reusable, maintainable mapping between users and the actions they can perform.

**Why it exists**: Etsy has three distinct user personas: buyers, sellers (shop owners), and platform admins. Each needs different access. A buyer should be able to browse, favorite, and purchase, but should not be able to modify another seller's product prices. A seller should be able to manage their own shop and products, but should not be able to view other sellers' order data. Without RBAC, every endpoint would need custom authorization logic to determine who can do what.

**How it works here**: The `users` table has a `role` column defaulting to `user`. When a user creates a shop, they gain seller capabilities via ownership checks (the shop's `owner_id` matches their user ID) rather than a separate role. This means RBAC is combined with resource ownership: the API checks both "is this user authenticated?" and "does this user own this shop?" for seller endpoints. Admin routes check `role = 'admin'` for platform-level operations. The middleware pattern is: session validation (is the user logged in?) then role/ownership check (can this user access this resource?).

**What goes wrong without it**: A malicious user could call `PUT /api/shops/123/products/456` to modify another seller's product listing, changing prices, descriptions, or images. They could call `GET /api/shops/123/orders` to view a competitor's sales data. In a marketplace, this would destroy seller trust and make the platform unusable.

### Redis Cache-Aside

**What it is**: Cache-aside (also called "lazy loading") is a caching strategy where the application checks Redis before querying the database. If the data is in Redis (cache hit), it is returned immediately. If not (cache miss), the application queries PostgreSQL or Elasticsearch, stores the result in Redis with a TTL, and returns it. The database remains the source of truth; Redis is a performance optimization layer that the application manages explicitly.

**Why it exists**: Product detail pages, shop profiles, and search results are read far more often than they are written. A popular handmade necklace might be viewed 10,000 times per day but updated once. Without caching, every view generates a database query. At 10,000 search queries per second during the holiday season, the database cannot keep up with the combined load of search, product detail, and availability queries.

**How it works here**: The caching layer at `backend/src/shared/cache.ts` implements cache-aside with stampede prevention. Product details are cached with 5-minute TTL. Shop profiles use 10-minute TTL. Search results use 2-minute TTL (search relevance can change as new products are listed). Inventory counts use a short 30-second TTL because accuracy matters for "only 1 left" signals. Cart contents use write-through caching (written to both Redis and PostgreSQL on every update) because cart state must always reflect the user's latest actions.

**Stampede prevention**: When a popular product's cache expires, hundreds of concurrent requests would all miss cache and hit the database simultaneously. The implementation uses Redis `SETNX` with a 5-second TTL as a lock: only the first request to miss cache acquires the lock and fetches from the database. Subsequent requests wait briefly and retry, finding the now-populated cache. This converts a "thundering herd" of 100 database queries into 1 query plus 99 cache hits.

**What goes wrong without it**: During the holiday season, a viral TikTok features a handmade candle. 50,000 users visit the product page within an hour. Without caching, each visit generates 3+ database queries (product details, shop info, similar products). The database receives 150,000+ queries per hour for a single product, causing connection pool exhaustion and degraded performance for all other products on the platform.

### Circuit Breaker

**What it is**: A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing external service. Like an electrical circuit breaker, it "trips" when failure rates exceed a threshold, immediately rejecting subsequent requests without attempting the call. After a cooldown period, it allows limited test requests to check if the service has recovered. This prevents a single dependency failure from consuming all server resources and cascading into a total outage.

**Why it exists**: Etsy depends on Elasticsearch for search and "similar products" recommendations, and on a payment gateway for checkout. If Elasticsearch goes down, every search request would wait for the 3-second timeout before failing. At 10,000 search requests per second, that is 30,000 seconds of wasted capacity per second -- the server would be completely unresponsive within moments. The circuit breaker detects the failure pattern and fails fast, allowing the application to serve a degraded but functional experience.

**How it works here**: The project uses the Opossum library with three circuit breakers defined at `backend/src/shared/circuit-breaker.ts`. The Elasticsearch search breaker opens after 50% of the last 10 requests fail, with a 3-second timeout per request and a 15-second reset interval. When open, search falls back to PostgreSQL `ILIKE` queries, which provide basic text matching without synonyms, fuzzy matching, or relevance scoring. The Elasticsearch "similar products" breaker has the same thresholds but falls back to an empty array (showing no recommendations is better than crashing). The payment gateway breaker opens after 25% of 5 requests fail, queuing unpaid orders as `payment_pending` for later processing.

**What goes wrong without it**: Elasticsearch has a 2-minute outage during peak traffic. 10,000 search requests per second each wait 3 seconds for the timeout. The Node.js event loop is blocked processing 30,000 pending requests. The `/api/cart` and `/api/orders/checkout` endpoints (which do not use Elasticsearch) become unresponsive because they share the same event loop. Cart additions fail, checkouts timeout, and revenue is lost for operations that had nothing to do with search.

### Structured Logging

**What it is**: Structured logging means emitting log entries as machine-parseable JSON objects rather than free-form text strings. Each log entry has consistent, named fields (timestamp, level, message, service, requestId, plus domain-specific fields) that log aggregation systems can index, search, and visualize without regex parsing.

**Why it exists**: In a marketplace with thousands of concurrent sellers and buyers, debugging an issue like "seller's product is not appearing in search" requires tracing the product through multiple systems: product creation, Elasticsearch indexing, search query execution, and result ranking. With unstructured text logs, an engineer would need to grep for the product ID across multiple services and manually correlate log lines. Structured logging enables a query like "show all logs where `productId=789` and `service=elasticsearch` in the last hour."

**How it works here**: The project uses Pino for JSON logging at `backend/src/shared/logger.ts`. Three context-specific loggers are created: `orderLogger` (logs checkout operations with order IDs, shop IDs, and amounts), `searchLogger` (logs search queries with query text, filter count, result count, and duration), and `appLogger` (general application events). Each log entry includes the service name, environment, and ISO timestamp. Sensitive data (passwords, payment details) is excluded from logs.

**What goes wrong without it**: A seller reports that their product does not appear in search results. The support team searches logs for the product ID. With text logs like `"Indexed product 789 to Elasticsearch"`, they find the indexing log but cannot determine whether the index operation succeeded, how long it took, or whether the product's search fields (title, tags, description) were populated correctly. With structured logging, they query `productId=789 AND event=es_index` and immediately see the indexed document's field values.

### Prometheus Metrics

**What it is**: Prometheus is a time-series monitoring system that collects numerical metrics from applications at regular intervals. The application exposes a `/metrics` endpoint with current metric values. Metrics come in four types: counters (total request count), gauges (current connection count), histograms (latency distributions), and summaries (pre-computed percentiles). These metrics power dashboards for operational visibility and rules for automated alerting.

**Why it exists**: Logs capture individual events. Metrics capture system behavior over time. "What is the average order value this week?" "Is search latency increasing?" "What percentage of cache lookups are hits?" These aggregate questions cannot be answered by searching individual log entries. Metrics also enable SLO tracking: the Etsy architecture defines specific availability and latency targets for search (99.5%, 50ms p50) and checkout (99.95%, 100ms p50). Without metrics, there is no way to measure whether these targets are being met.

**How it works here**: The project uses `prom-client` at `backend/src/shared/metrics.ts` to expose 9 key metrics. Business metrics include `etsy_product_views_total` (counter by category, tracks traffic distribution), `etsy_search_queries_total` (counter by filter presence, measures search usage), `etsy_search_latency_seconds` (histogram by query type, monitors search SLO), `etsy_orders_created_total` (counter by status), and `etsy_order_value_dollars` (histogram, tracks revenue distribution). Infrastructure metrics include `etsy_cache_hits_total` and `etsy_cache_misses_total` (counters by cache type, measure cache effectiveness), `etsy_circuit_breaker_state` (gauge per service), and `etsy_checkout_duration_seconds` (histogram, monitors checkout SLO). The error budget thresholds (22 minutes/month for checkout, 3.6 hours/month for search) are monitored via these metrics.

**What goes wrong without it**: The Elasticsearch synonym filter is missing a new term ("cottagecore") that 5% of users search for. Search result quality drops for those queries, but no one notices because there is no metric tracking "zero-result search queries." The problem persists for months until a product manager manually searches for "cottagecore" and notices the poor results.

### Rate Limiting

**What it is**: Rate limiting restricts how many requests a client can make to an endpoint within a time window. When the limit is exceeded, subsequent requests receive a `429 Too Many Requests` response until the window resets. Limits are tracked per user (authenticated) or per IP address (unauthenticated) using atomic counters in Redis.

**Why it exists**: Marketplaces are attractive targets for scraping (competitors extracting pricing data), credential stuffing (testing stolen passwords against seller accounts), and inventory manipulation (bots adding items to cart to block legitimate buyers). Without rate limiting, these attacks consume server resources, degrade performance for legitimate users, and can cause real financial harm to sellers.

**How it works here**: The architecture defines rate limits but the local implementation omits enforcement (noted in the "What Was Simplified" section). At production scale, limits would include: login at 5 per minute per IP (prevents credential stuffing), search at 30 per minute per user (prevents catalog scraping), add-to-cart at 20 per minute per user (prevents inventory hoarding), and checkout at 5 per minute per user (prevents payment flooding). Each limit would use Redis sliding window counters with TTL-based expiration.

**What goes wrong without it**: A competitor deploys a scraping bot that calls `GET /api/search?q=*` with every possible filter combination, downloading the entire product catalog with prices. The Elasticsearch cluster is overwhelmed by the query volume, search latency for real users exceeds 5 seconds, and the scraper obtains competitive intelligence at zero cost.

### Idempotency

**What it is**: Idempotency means that performing the same operation multiple times produces the same result as performing it once. For API endpoints that create resources (orders, payments), this is achieved by associating each operation with a unique key. The first request with a given key executes normally and stores the result. Subsequent requests with the same key return the cached result without re-executing the operation.

**Why it exists**: Etsy's checkout creates multiple orders (one per seller) within a single database transaction. If the transaction succeeds but the HTTP response is lost, the user sees an error and clicks "Place Order" again. Without idempotency, the second click creates a second set of orders. The user is charged twice, sellers see duplicate orders, and inventory counts are decremented twice (potentially overselling for unique items with quantity=1).

**How it works here**: The checkout endpoint accepts an `Idempotency-Key` header. The middleware at `backend/src/shared/idempotency.ts` checks for an existing completed operation with that key. If found, the cached response is returned. If a concurrent duplicate request arrives while the first is still processing, it receives a `409 Conflict` response (preventing race conditions). If the first request fails, the key is cleared so the user can retry. This is especially critical for unique items: if a one-of-a-kind handmade ring has quantity=1, a duplicate order would try to set quantity to -1, which is both logically impossible and financially harmful to the seller.

**What goes wrong without it**: A buyer purchases a $500 handmade engagement ring. Network timeout. They click again. Two orders are created, each decrementing quantity by 1. The ring's quantity goes from 1 to -1. The seller receives two orders for an item they can only fulfill once. The second buyer either receives nothing (and leaves a 1-star review) or the seller is forced to refund one order and deal with a customer dispute.

### Health Checks

**What it is**: Health checks are dedicated HTTP endpoints that report whether the application and its dependencies are functioning correctly. They return structured status information for each component (database, cache, search engine, circuit breakers) with latency measurements. Infrastructure components (load balancers, container orchestrators, monitoring systems) consume health checks to make automated decisions about traffic routing and instance lifecycle.

**Why it exists**: An Etsy API server might be running but unable to serve useful responses because the PostgreSQL connection pool is full, the Redis cache is unreachable, or Elasticsearch is not responding. Without health checks, the load balancer treats this server as healthy and sends it traffic. Every request fails, but the load balancer does not know. Health checks make application-level health visible to infrastructure so it can take corrective action.

**How it works here**: The `/api/health` endpoint reports overall status (`ok` or `degraded`), PostgreSQL connectivity and latency (via `SELECT 1`), Redis connectivity and latency (via `PING`), and circuit breaker states for Elasticsearch and payment services. The response includes uptime for debugging. A `degraded` status is returned when any component is unhealthy but the server can still handle some requests (e.g., Elasticsearch is down but PostgreSQL is up, so cart and checkout still work). The load balancer polls health every 10 seconds and removes instances that return `error` status for 3 consecutive checks.

**What goes wrong without it**: An Elasticsearch node runs out of disk space. The Etsy API server's ES circuit breaker opens (search falls back to PostgreSQL). The server is functioning but with degraded search. Without health checks, the monitoring team does not know the breaker is open until users report poor search results. With health checks, the monitoring dashboard shows the ES circuit breaker as "open" immediately, triggering an alert to investigate the Elasticsearch cluster.

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
