# Design Amazon - Architecture

## System Overview

Amazon is an e-commerce platform handling massive product catalogs, real-time inventory, and complex order fulfillment. Core challenges involve inventory consistency, product search, and recommendation systems.

**Learning Goals:**
- Design inventory systems that prevent overselling
- Build product search with faceted filtering
- Implement "also bought" recommendations
- Handle order state machines

---

## Requirements

### Functional Requirements

1. **Catalog**: Browse and search products with faceted filtering
2. **Cart**: Add items, manage quantities with inventory reservation
3. **Checkout**: Purchase with payment processing and idempotency
4. **Orders**: Track order status through a state machine (pending -> confirmed -> shipped -> delivered)
5. **Recommendations**: "Customers also bought" personalized suggestions
6. **Reviews**: Product reviews with verified purchase badge

### Non-Functional Requirements

- **Availability**: 99.99% for browsing, 99.9% for checkout
- **Consistency**: Strong for inventory (no overselling under any circumstance)
- **Latency**: < 100ms for search, < 200ms for checkout
- **Scale**: 100M products, 1M orders/day, 10M DAU

---

## Capacity Estimation

### Production Scale

| Metric | Value | Derivation |
|--------|-------|------------|
| Products | 100M | Full catalog across all sellers |
| Active sellers | 1M | Marketplace sellers |
| Orders/day | 1M | ~12 orders/second average, 100/s peak |
| Search queries/second | 50,000 | Peak during sales events |
| Cart operations/second | 10,000 | Add, update, remove |

### Storage Estimates

| Data | Size | Growth |
|------|------|--------|
| Products + attributes | 500 GB | 100 GB/year |
| Orders (hot, < 2 years) | 2 TB | 1 TB/year |
| Orders (archive, 2-7 years) | 5 TB | Grows with archival |
| Elasticsearch index | 100 GB | Mirrors product catalog |
| Reviews | 200 GB | 50 GB/year |
| Recommendations cache | 10 GB | Recomputed nightly |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Client Layer                                  │
│     Product Pages  │  Search  │  Cart  │  Checkout  │  Order History     │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          API Gateway / LB                                │
│         Auth  │  Rate Limiting  │  Request Routing                       │
└──────────────────────────────────────────────────────────────────────────┘
        │                  │                  │                  │
        ▼                  ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
│   Catalog    │  │    Cart      │  │    Order     │  │  Recommendation  │
│   Service    │  │   Service    │  │   Service    │  │    Service       │
│              │  │              │  │              │  │                  │
│ - Products   │  │ - Add/remove │  │ - Checkout   │  │ - Also bought    │
│ - Categories │  │ - Quantities │  │ - Fulfillment│  │ - Nightly batch  │
│ - Search     │  │ - Inventory  │  │ - Tracking   │  │ - Redis cache    │
│ - Reviews    │  │   reservation│  │ - Archival   │  │                  │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────────┘
        │                  │                  │                  │
        ▼                  ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                           Data Layer                                     │
├────────────────┬────────────────┬────────────────┬───────────────────────┤
│   PostgreSQL   │ Elasticsearch  │  Valkey/Redis  │       Kafka           │
│  - Products    │  - Search      │  - Cart cache  │  - Order events       │
│  - Orders      │  - Facets      │  - Sessions    │  - Inventory updates  │
│  - Inventory   │  - Autocomplete│  - Recs cache  │  - Search sync        │
│  - Reviews     │                │  - Rate limits │                       │
└────────────────┴────────────────┴────────────────┴───────────────────────┘
```

---

## Core Components

### 1. Inventory Management

**Challenge**: Prevent overselling during high-concurrency checkout (flash sale: 1,000 units, 10,000 concurrent buyers).

**Approach: Reserved Inventory Model**

Inventory tracks two separate quantities: `quantity` (total stock) and `reserved` (locked in carts). Available inventory is `quantity - reserved`. When a user adds an item to their cart, the system atomically increments `reserved` within a transaction using `SELECT FOR UPDATE` to prevent race conditions. Reservations expire after 30 minutes; a background job releases expired reservations by decrementing `reserved`.

This approach avoids the "lost update" problem where two concurrent transactions both read the same available count and both succeed. With `SELECT FOR UPDATE`, the second transaction blocks until the first commits, ensuring serialized access to the inventory row.

**Why Reserved Model over Decrement-on-Add:**

Decrementing actual quantity when a user adds to cart means abandoned carts permanently reduce available stock until manually reconciled. The reserved model separates "intent to buy" from "actually bought." Reservations auto-expire, returning inventory to the pool without manual intervention. The trade-off is added complexity: a background job must reliably run, and the `reserved` column must never go negative (enforced by checking `quantity - reserved >= requested` before incrementing).

### 2. Product Search

**Elasticsearch Index** with faceted filtering:

Products are indexed with fields for full-text search (`title`, `description`), keyword facets (`category`, `brand`), numeric ranges (`price`, `rating`), and boolean filters (`in_stock`). Aggregations provide facet counts (how many products per category, per brand, per price range) alongside results.

**PostgreSQL Full-Text Search Fallback:**

When the Elasticsearch circuit breaker trips, search falls back to PostgreSQL's `tsvector` GIN index. This provides degraded but functional search (no facets, less relevance tuning) rather than complete search unavailability.

### 3. Recommendations

**Collaborative Filtering: "Also Bought"**

A nightly batch job computes co-purchase frequencies by joining `order_items` to itself on `order_id`. For each product, the job finds the top 20 products most frequently purchased in the same order, computes a normalized score, and upserts results into `product_recommendations`. Results are cached in Valkey for 24 hours for sub-millisecond retrieval.

**Why Batch Precompute over Real-Time ML:**

Real-time recommendation models (collaborative filtering with matrix factorization, or deep learning) require GPU infrastructure, model serving, and online feature stores. Batch precomputation is operationally simpler: a SQL query runs nightly, produces a lookup table, and caches it in Redis. The trade-off is staleness -- recommendations reflect yesterday's purchase patterns. For a product catalog where buying patterns change slowly, 24-hour staleness is acceptable. If a new product goes viral, it will appear in recommendations within one batch cycle.

---

## Database Schema

### Entity-Relationship Diagram

```
┌────────────────────────────┐           ┌────────────────────────────┐
│          USERS             │           │         SELLERS            │
│────────────────────────────│           │────────────────────────────│
│ PK id          SERIAL      │◄──1:1───▶│ PK id          SERIAL      │
│    email       UNIQUE      │           │ FK user_id     → users     │
│    password_hash           │           │    business_name           │
│    name                    │           │    rating DECIMAL(2,1)     │
│    role (user/admin/seller)│           └────────────────────────────┘
└────────────────────────────┘                       │ 1:N
         │ 1:N           │ 1:N                       ▼
         ▼               ▼               ┌────────────────────────────┐
┌─────────────┐  ┌─────────────┐         │        PRODUCTS            │
│ CART_ITEMS  │  │   REVIEWS   │         │────────────────────────────│
│─────────────│  │─────────────│         │ PK id          SERIAL      │
│ PK id       │  │ PK id       │         │ FK seller_id   → sellers   │
│ FK user_id  │  │ FK user_id  │         │ FK category_id → categories│
│ FK product_id│ │ FK product_id│        │    title, slug, price      │
│    quantity  │  │ FK order_id │         │    images TEXT[]            │
│    reserved  │  │    rating   │         │    attributes JSONB        │
│    _until    │  │    verified │         │    rating, review_count    │
│ UNIQUE(user, │  │    _purchase│         │    is_active               │
│   product)  │  └─────────────┘         └────────────────────────────┘
└─────────────┘                                      │ 1:N
                                                     ▼
┌────────────────────────────┐           ┌────────────────────────────┐
│       CATEGORIES           │           │        INVENTORY           │
│────────────────────────────│           │────────────────────────────│
│ PK id          SERIAL      │           │ PK (product_id, warehouse_id)│
│ FK parent_id   self-ref    │           │    quantity    INTEGER     │
│    name, slug UNIQUE       │           │    reserved   INTEGER     │
│    description             │           │    low_stock_threshold     │
└────────────────────────────┘           └────────────────────────────┘

┌────────────────────────────┐           ┌────────────────────────────┐
│         ORDERS             │           │       ORDER_ITEMS          │
│────────────────────────────│           │────────────────────────────│
│ PK id          SERIAL      │◄──1:N───▶│ PK id          SERIAL      │
│ FK user_id     SET NULL    │           │ FK order_id    CASCADE     │
│    status (state machine)  │           │ FK product_id  SET NULL    │
│    subtotal, tax, total    │           │    product_title (snapshot)│
│    shipping_address JSONB  │           │    quantity, price         │
│    payment_status          │           └────────────────────────────┘
│    idempotency_key         │
│    archive_status          │
└────────────────────────────┘
```

### Complete Table Definitions

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin', 'seller')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Sellers (extension of users with seller role)
CREATE TABLE sellers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  business_name VARCHAR(255) NOT NULL,
  description TEXT,
  rating DECIMAL(2, 1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Categories (hierarchical, self-referencing)
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT,
  image_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Warehouses
CREATE TABLE warehouses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  address JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Products
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER REFERENCES sellers(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  slug VARCHAR(500) UNIQUE NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  price DECIMAL(10, 2) NOT NULL,
  compare_at_price DECIMAL(10, 2),
  images TEXT[] DEFAULT '{}',
  attributes JSONB DEFAULT '{}',
  rating DECIMAL(2, 1) DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Inventory (composite key: product + warehouse)
CREATE TABLE inventory (
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE CASCADE,
  quantity INTEGER DEFAULT 0,
  reserved INTEGER DEFAULT 0,
  low_stock_threshold INTEGER DEFAULT 10,
  PRIMARY KEY (product_id, warehouse_id)
);

-- Cart items with inventory reservation
CREATE TABLE cart_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER DEFAULT 1 CHECK (quantity > 0),
  reserved_until TIMESTAMP,
  added_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

-- Orders (state machine with archival support)
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(30) DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded')),
  subtotal DECIMAL(10, 2) NOT NULL,
  tax DECIMAL(10, 2) DEFAULT 0,
  shipping_cost DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  shipping_address JSONB NOT NULL,
  billing_address JSONB,
  payment_method VARCHAR(50),
  payment_status VARCHAR(30) DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'completed', 'failed', 'refunded')),
  notes TEXT,
  idempotency_key VARCHAR(255),
  archive_status VARCHAR(20) DEFAULT 'active'
    CHECK (archive_status IN ('active', 'pending_archive', 'archived', 'anonymized')),
  archived_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Order items (denormalized product title for historical accuracy)
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_title VARCHAR(500) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews with verified purchase
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(255),
  content TEXT,
  helpful_count INTEGER DEFAULT 0,
  verified_purchase BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions
CREATE TABLE sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  data JSONB DEFAULT '{}',
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Precomputed recommendations
CREATE TABLE product_recommendations (
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  recommended_product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  score DECIMAL(5, 4) DEFAULT 0,
  recommendation_type VARCHAR(30) DEFAULT 'also_bought',
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (product_id, recommended_product_id, recommendation_type)
);

-- Idempotency keys (duplicate order prevention)
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  request_data JSONB,
  response JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Audit logs (immutable)
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMP DEFAULT NOW(),
  action VARCHAR(100) NOT NULL,
  actor_id INTEGER,
  actor_type VARCHAR(20) CHECK (actor_type IN ('user', 'admin', 'system', 'service')),
  resource_type VARCHAR(50),
  resource_id VARCHAR(100),
  old_value JSONB,
  new_value JSONB,
  ip_address INET,
  user_agent TEXT,
  correlation_id UUID,
  severity VARCHAR(20) DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical'))
);

-- Orders archive (cold storage)
CREATE TABLE orders_archive (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  user_id INTEGER,
  archive_data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL,
  archived_at TIMESTAMP DEFAULT NOW()
);

-- Search logs (analytics)
CREATE TABLE search_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  query TEXT,
  filters JSONB,
  results_count INTEGER,
  latency_ms INTEGER,
  engine VARCHAR(20),
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Index Strategy

```sql
-- Product discovery
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_seller ON products(seller_id);
CREATE INDEX idx_products_price ON products(price);
CREATE INDEX idx_products_rating ON products(rating);
CREATE INDEX idx_products_active ON products(is_active);

-- Full-text search fallback
CREATE INDEX idx_products_search ON products
  USING gin(to_tsvector('english', title || ' ' || COALESCE(description, '')));

-- Cart operations
CREATE INDEX idx_cart_user ON cart_items(user_id);
CREATE INDEX idx_cart_reserved ON cart_items(reserved_until);

-- Order management
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_idempotency ON orders(idempotency_key);
CREATE INDEX idx_orders_archive_status ON orders(archive_status);

-- Reviews
CREATE INDEX idx_reviews_product ON reviews(product_id);
CREATE INDEX idx_reviews_user ON reviews(user_id);

-- Categories
CREATE INDEX idx_categories_parent ON categories(parent_id);
CREATE INDEX idx_categories_slug ON categories(slug);

-- Observability tables
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, actor_type);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_correlation ON audit_logs(correlation_id);
```

### Why Tables Are Structured This Way

**Separate `sellers` from `users`**: Most users are buyers. Embedding seller fields in the users table wastes space and complicates queries. Seller-specific features (payout info, seller metrics) grow independently.

**Composite key for inventory `(product_id, warehouse_id)`**: Each product exists once per warehouse by definition. No surrogate key needed. Both lookup patterns (by product, by warehouse) use the composite index efficiently.

**Reserved inventory as separate column**: Tracking `quantity` and `reserved` separately allows the background job to release expired reservations without affecting real inventory. Available = quantity - reserved. The `reserved` column is incremented atomically during cart operations.

**Denormalized `product_title` in order_items**: Order history must show what the customer actually bought, not the current product name. If a product is renamed or deleted (FK SET NULL), the order remains meaningful.

**JSONB for addresses**: Order addresses are historical snapshots, not reusable entities. International addresses have varying formats. JSONB adapts without schema changes and travels with the order (no JOINs).

**Idempotency as dedicated table**: Tracks in-flight requests to handle concurrent duplicates. Stores cached responses for duplicate requests. Multi-resource -- can protect any operation, not just orders.

---

## API Design

### Customer API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login, create session |
| POST | `/api/auth/logout` | Destroy session |
| GET | `/api/products` | List products (paginated) |
| GET | `/api/products/:id` | Product detail + recommendations |
| GET | `/api/search` | Elasticsearch search with facets |
| GET | `/api/categories` | Category tree |
| GET | `/api/categories/:slug` | Products in category |
| GET | `/api/cart` | Get cart contents |
| POST | `/api/cart` | Add item to cart (reserves inventory) |
| PUT | `/api/cart/:id` | Update cart item quantity |
| DELETE | `/api/cart/:id` | Remove from cart (releases reservation) |
| POST | `/api/orders` | Checkout (idempotency key required) |
| GET | `/api/orders` | Order history |
| GET | `/api/orders/:id` | Order detail |
| POST | `/api/reviews` | Submit review |
| GET | `/api/reviews/product/:id` | Product reviews |

### Admin API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/admin/orders` | All orders (admin view) |
| PUT | `/api/admin/orders/:id/status` | Update order status |
| GET | `/api/admin/products` | Product management |
| PUT | `/api/admin/products/:id` | Update product |

### Health and Observability

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Simple liveness check |
| GET | `/api/health/detailed` | Full service status (DB, Redis, ES) |
| GET | `/api/health/ready` | Kubernetes readiness probe |
| GET | `/metrics` | Prometheus metrics |

---

## Key Design Decisions

### 1. Reserved Inventory Model

**Decision**: Track `reserved` quantity separately from `available`.

Decrementing actual inventory on "add to cart" means abandoned carts permanently lock stock. With the reserved model, a background job releases expired reservations every 5 minutes, automatically returning inventory to the pool. The trade-off is that the background job is a reliability dependency -- if it stops running, inventory gradually becomes unavailable as reservations accumulate. Monitoring `cart_items` with `reserved_until < NOW()` catches this failure mode.

### 2. Elasticsearch with PostgreSQL Fallback

**Decision**: Primary search via Elasticsearch with circuit-breaker-protected fallback to PostgreSQL full-text search.

Elasticsearch provides relevance scoring, faceted aggregations (category counts, price ranges, brand filters), and sub-50ms query latency at 100M products. PostgreSQL's `tsvector` GIN index provides basic text search but lacks faceted aggregations and performs poorly at scale. The circuit breaker trips after 3 consecutive Elasticsearch failures and routes search to PostgreSQL. Users get degraded search (no facets, slower, less relevant) but search never becomes completely unavailable. The trade-off is maintaining two search paths and accepting that the fallback provides a noticeably worse experience.

### 3. Precomputed Recommendations

**Decision**: Nightly batch SQL job computing "also bought" relationships.

Real-time collaborative filtering requires ML infrastructure (model training, feature stores, model serving) that costs significantly more to operate than a nightly SQL batch. The co-purchase frequency query joins `order_items` to itself, computes normalized scores, and stores results in `product_recommendations`. Cached in Valkey for 24-hour TTL. The trade-off is 24-hour staleness -- a product that goes viral today will not appear in recommendations until tomorrow's batch run.

---

## Consistency and Idempotency

### Inventory Consistency

Cart operations use `SELECT FOR UPDATE` within a transaction to serialize access to inventory rows. This prevents two concurrent buyers from both reading "10 available" and both succeeding:

```sql
BEGIN;
SELECT quantity - reserved AS available FROM inventory
  WHERE product_id = $1 FOR UPDATE;
-- If available >= requested:
UPDATE inventory SET reserved = reserved + $quantity
  WHERE product_id = $1 AND quantity - reserved >= $quantity;
INSERT INTO cart_items (user_id, product_id, quantity, reserved_until)
  VALUES ($user, $1, $quantity, NOW() + INTERVAL '30 minutes')
  ON CONFLICT (user_id, product_id) DO UPDATE SET
    quantity = cart_items.quantity + EXCLUDED.quantity,
    reserved_until = NOW() + INTERVAL '30 minutes';
COMMIT;
```

### Checkout Idempotency

1. Client generates unique `Idempotency-Key` header (e.g., `order-user123-1705432800-abc123`)
2. Server checks `idempotency_keys` table via `INSERT ... ON CONFLICT DO NOTHING`
3. If key exists with `status = 'completed'`, return cached response
4. If key exists with `status = 'processing'`, return 409 Conflict
5. Process order within transaction, update key to `completed` with cached response
6. Failed processing updates key to `failed`, allowing retry with same key

### Order Archival

Orders older than 2 years with terminal status (delivered, cancelled, refunded) are archived:
1. Serialize full order with items to JSONB
2. Insert into `orders_archive`
3. Anonymize PII in original order (set `shipping_address` to `{"anonymized": true}`)
4. Mark `archive_status = 'archived'`

This keeps the hot `orders` table small and fast while maintaining legal compliance (7-year retention).

---

## Observability

### Metrics (Prometheus)

Key metrics exposed at `GET /metrics`:

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `http_request_duration_seconds` | Histogram | method, route, status_code | API latency tracking |
| `inventory_reservations_total` | Counter | product_id, status | Track reservation success/failure |
| `cart_abandonments_total` | Counter | - | Expired reservation count |
| `order_value_dollars` | Histogram | - | Order value distribution |
| `search_latency_seconds` | Histogram | query_type | ES vs PG fallback performance |
| `circuit_breaker_state` | Gauge | service | ES, payment, recommendation health |

### SLI/SLO Dashboard

| SLI | Target | Warning | Critical |
|-----|--------|---------|----------|
| Search p99 latency | < 100ms | > 150ms | > 300ms |
| Checkout success rate | > 99% | < 98% | < 95% |
| Inventory accuracy | 100% | < 99.9% | < 99% |
| API availability | 99.9% | < 99.5% | < 99% |
| Cart reservation success | > 95% | < 90% | < 80% |

### Structured Logging (Pino)

JSON-formatted logs with correlation IDs for distributed tracing. Each request gets a child logger with `correlationId`, `userId`, `method`, and `path`. Log levels: debug (dev only), info, warn, error.

### Audit Logging

Immutable `audit_logs` table captures order lifecycle events (`order.created`, `order.cancelled`, `order.refunded`), inventory changes (`inventory.adjusted`, `inventory.reserved`), and admin actions (`product.price_changed`, `product.deleted`). Each entry includes `old_value`/`new_value` JSONB for forensic reconstruction. `correlation_id` UUID links related events across service boundaries.

---

## Failure Handling

### Circuit Breakers

| Service | Timeout | Error Threshold | Reset Timeout | Fallback |
|---------|---------|-----------------|---------------|----------|
| Elasticsearch | 5s | 60% of 10 requests | 10s | PostgreSQL full-text search |
| Payment gateway | 30s | 30% of 3 requests | 60s | Queue as payment_pending |
| Recommendation | 5s | 50% of 3 requests | 5s | Return empty array |

### Retry Strategy

Exponential backoff with jitter for transient failures:
- Base delay: 100ms, factor: 2x, max delay: 5s
- Retry on: `ECONNRESET`, HTTP 5xx
- Do not retry: 4xx errors, business logic failures

### Background Job Resilience

The expired reservation cleanup job runs every 5 minutes using `FOR UPDATE SKIP LOCKED` to prevent conflicting with concurrent cleanup runs. If the job fails, reservations remain locked longer than intended but are eventually cleaned up on the next successful run.

---

## Scalability Considerations

### Horizontal Scaling Path

1. **API servers**: Stateless, scale behind load balancer. Sessions in Valkey.
2. **PostgreSQL**: Read replicas for product browsing. Writes (inventory, orders) to primary only.
3. **Elasticsearch**: Add nodes to the cluster, increase shard count (3 shards per 10M products).
4. **Valkey**: Cluster mode for recommendation and session data.
5. **Inventory sharding**: Shard by product_id ranges across multiple PostgreSQL instances.

### What Breaks First

1. **Single PostgreSQL write primary**: Inventory updates during flash sales saturate write capacity. Solution: shard inventory by product_id.
2. **Elasticsearch indexing lag**: Product updates take seconds to appear in search. Solution: dedicated indexing pipeline with batched bulk updates.
3. **Recommendation batch job duration**: Nightly job exceeds the nightly window as order volume grows. Solution: incremental updates instead of full recompute.

### Data Lifecycle

| Data | Hot Storage | Archive Trigger | Cold Storage |
|------|------------|-----------------|-------------|
| Orders | PostgreSQL (< 2 years) | Weekly batch job | orders_archive table (JSONB) |
| Search logs | PostgreSQL (90 days) | Daily cleanup | Deleted |
| Idempotency keys | PostgreSQL (24 hours) | Hourly cleanup | Deleted |
| Cart reservations | PostgreSQL (30 minutes) | Every 5 minutes | Deleted |
| Audit logs | PostgreSQL (1 year) | Yearly archival | Cold storage (3 years total) |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Inventory model | Reserved quantity | Decrement on add | Prevents overselling; auto-release on abandonment |
| Search | Elasticsearch + PG fallback | PostgreSQL FTS only | Facets, relevance scoring, sub-100ms at scale |
| Recommendations | Nightly batch SQL | Real-time ML | 100x simpler ops; 24h staleness acceptable |
| Cart storage | PostgreSQL + Valkey cache | Valkey only | Durability across restarts; cache for speed |
| Order archival | Tiered (hot/warm/cold) | Keep all in PostgreSQL | Query performance; storage cost at scale |
| Circuit breakers | Opossum library | Custom implementation | Battle-tested; metrics integration |
| Audit trail | PostgreSQL table | Log files | Queryable, relational, transactional |

---

## Frontend Architecture

### Technology Stack

React 19 + TypeScript + Vite + TanStack Router (file-based routing) + Zustand (state management) + Tailwind CSS.

### Component Hierarchy

```
__root.tsx (Header with search bar + category nav + cart badge)
├── index.tsx              → HomePage: hero banner, category grid, featured products, deals section
├── search.tsx             → SearchPage: faceted sidebar filters + product grid + pagination
├── product.$id.tsx        → ProductPage: image gallery, price, reviews, recommendations
├── category.$slug.tsx     → CategoryPage: products filtered by category
├── cart.tsx               → CartPage: item list with quantity controls + order summary
├── checkout.tsx           → CheckoutPage: shipping form, payment mock, order placement
├── orders.tsx             → OrdersPage: order history list
├── orders.$id.tsx         → OrderDetailPage: single order with items and status
└── login.tsx              → Login/register form
```

### Zustand Stores

**`authStore`** -- manages user authentication with session persistence via `zustand/persist` middleware. The session ID is stored in `localStorage` and attached to every API request as an `X-Session-Id` header (rather than using cookies). The `checkAuth()` action validates the session on app load by calling `/api/auth/me` and clears the stored session if it has expired. The `partialize` option ensures only `sessionId` is persisted (not the user object), so stale user data is always refreshed from the server on reload.

**`cartStore`** -- manages the shopping cart globally. Stores `items` (array of cart items with product details and stock info), `subtotal` (computed server-side), `itemCount` (total quantity across all items), and loading/error states. Every cart mutation (`addToCart`, `updateQuantity`, `removeItem`, `clearCart`) sends a request to the server and replaces the entire local cart state with the server's response. This server-authoritative approach ensures the cart always reflects current inventory and pricing -- the server validates stock availability and recalculates totals on every operation. The trade-off is that every interaction requires a network round-trip, but this prevents the overselling problem that would occur if the client maintained its own cart state independently.

### Routing and URL-Driven Search

The search page (`search.tsx`) uses TanStack Router's `validateSearch` to parse URL query parameters (`q`, `category`, `minPrice`, `maxPrice`, `inStock`, `sortBy`, `page`) into typed search state. All filter changes call `navigate()` with updated search params, which triggers a re-render and a new API call. This URL-driven approach means:

1. Search results are bookmarkable and shareable
2. The browser back button works naturally (previous filter state is restored)
3. No Zustand store is needed for search state -- the URL is the single source of truth

The `updateFilter()` helper resets pagination to page 0 whenever a filter changes, ensuring users see the first page of results after narrowing their search.

### Faceted Search with Elasticsearch Aggregations

The search page receives `aggregations` alongside `products` from the search API. Aggregations are Elasticsearch's way of computing summaries over the result set -- category counts, price range buckets, and brand distributions. The frontend renders these as interactive filter panels:

- **Category facets**: Buttons showing category names with document counts (e.g., "Electronics (42)"). Clicking a category adds it as a URL filter; clicking again removes it.
- **Price range facets**: Pre-computed price buckets (e.g., "Under $25", "$25-$50"). Clicking a bucket sets `minPrice` and `maxPrice` URL params.
- **In-stock toggle**: A checkbox that adds `inStock=true` to the URL.

Each facet updates the URL, which triggers a new search, which returns new aggregations reflecting the narrowed result set. This creates a drill-down experience where available filters update dynamically based on the current selection.

### Product Detail Page

The `product.$id.tsx` route is the most data-rich page in the application. It fetches three data sources in parallel:

1. **Product data**: title, price, description, attributes (JSONB), stock quantity, seller info, images
2. **Recommendations**: "Customers also bought" products from the precomputed `product_recommendations` table
3. **Reviews**: Customer reviews with a summary (average rating, rating distribution histogram)

The page implements several e-commerce patterns:

- **Image gallery**: Multi-image display with thumbnail selectors. The selected image index is managed via `useState`.
- **Breadcrumb navigation**: Category-aware breadcrumbs (Home > Category > Product) using the product's `category_slug` and `category_name` fields.
- **Stock urgency**: When `stock_quantity < 10`, an orange "Only X left - order soon!" message creates urgency.
- **Discount display**: When `compare_at_price > price`, the page shows the percentage savings and a strikethrough original price.
- **Add-to-cart feedback**: After a successful add, a green confirmation bar appears for 3 seconds with a "View Cart" link, then auto-dismisses.

### Cart and Checkout Flow

The cart page displays items in a list with quantity selectors (dropdown, max 10 or available stock), delete buttons, and per-item totals. A sticky order summary sidebar shows subtotal, estimated shipping (free over $50), estimated tax (8%), and order total. The "Proceed to Checkout" button navigates to `/checkout`.

The checkout page collects a shipping address (street, city, state, ZIP, country) and shows a mock payment method (demo VISA card). The order summary sidebar is replicated here with a scrollable item list. On submission, `api.createOrder()` sends the address and payment method to the backend. The backend atomically converts cart reservations into an order, deducts inventory, and returns the created order. The frontend navigates to `/orders/$id` to show the order confirmation.

This flow demonstrates the inventory reservation pattern: items in the cart have reserved inventory (30-minute expiry), and checkout converts those reservations into permanent deductions.

### Data Fetching Patterns

The API client (`services/api.ts`) uses a session-header approach rather than cookies: the `request()` helper reads `sessionId` from `localStorage` and attaches it as an `X-Session-Id` header on every request. This pattern works with APIs that do not set cookies (e.g., stateless session validation via a database lookup).

**Parallel fetching**: The home page, product page, and category page all use `Promise.all` to fetch independent data sources simultaneously.

**Cart state synchronization**: Every cart mutation returns the complete cart state from the server, and the frontend replaces its entire cart state with the response. This "replace all" approach avoids incremental state drift between client and server.

### Recommendations Display

The product page fetches "Customers also bought" recommendations and displays them in a horizontal 5-column grid below the product details. Each recommendation shows a thumbnail, title (truncated to 2 lines via `line-clamp-2`), and price. Clicking a recommendation navigates to that product's detail page via TanStack Router's `Link` component. Recommendations are pre-computed by a nightly batch job and cached in Valkey, so the fetch is sub-millisecond.

### Loading States and Skeleton Screens

Every page renders skeleton placeholders during data loading using Tailwind's `animate-pulse` class. The home page shows a full-width gray rectangle for the hero banner and a 4-column grid of gray rectangles for products. The search page shows a 3-column grid of skeleton cards. The product page shows a 2-column layout skeleton (image square + text blocks). These skeletons provide visual stability during loading, preventing layout shift when real content arrives.

### Key UI Patterns

- **Global header**: Persistent header with logo, search bar (navigates to `/search` with query), category navigation links, and cart badge showing `cartStore.itemCount`
- **Product cards**: Reusable `ProductCard` component showing image, title (2-line clamp), star rating, review count, price, and discount badge. Used on home page, search results, and category pages.
- **Review system**: `ReviewCard` component showing star rating, reviewer name, date, title, content, and "Helpful" button. `ReviewSummaryCard` shows average rating, total review count, and star-distribution histogram (5-star to 1-star bar chart).
- **Deals section**: Filters products where `compare_at_price > price` and shows discount percentage badges
- **Sticky sidebar**: Cart and checkout pages use `sticky top-4` on the order summary sidebar so it stays visible while scrolling through items

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in this project. Each explanation assumes no prior knowledge of the pattern.

### Role-Based Access Control (RBAC)

RBAC restricts what actions a user can perform based on their assigned role. Instead of maintaining a permission list per user (which becomes unmanageable at scale), you define roles, assign permissions to roles, and assign roles to users.

In this project, there are three roles: `user`, `seller`, and `admin`. A `user` can browse products, manage their cart, place orders, and write reviews. A `seller` inherits all user capabilities and can additionally manage their product listings and view their sales. An `admin` inherits all capabilities and can additionally manage all products, update order statuses, and access the admin dashboard.

The role is stored in the `users` table as a `CHECK` constraint (`role IN ('user', 'admin', 'seller')`), which means the database itself rejects invalid role values. On the backend, authentication middleware reads the session, loads the user's role, and attaches it to the request context. Route-level middleware then checks the role against the endpoint's requirements. For example, `PUT /api/admin/orders/:id/status` requires `role = 'admin'`.

On the frontend, the header conditionally renders admin links only when `user.role === 'admin'`. However, client-side role checks are a UI convenience, not a security boundary -- the backend enforces role requirements regardless of what the frontend sends.

### Redis Cache-Aside

Cache-aside is a caching strategy where the application checks a cache before querying the database. On a cache hit, the cached value is returned immediately (saving the database round-trip). On a cache miss, the application queries the database, writes the result to the cache with a TTL, and returns the result.

In this project, cache-aside is used for three data types:

1. **Sessions**: When a request arrives with an `X-Session-Id` header, the server first checks Valkey for the session data. If cached, authentication completes in < 1ms. If not cached (cold start, after Valkey restart), the server queries the `sessions` table, caches the result, and proceeds.

2. **Recommendations**: The nightly batch job computes "also bought" relationships and stores them in the `product_recommendations` table. Results are cached in Valkey with a 24-hour TTL. Since recommendations change only once per day (after the batch run), the TTL matches the refresh cycle, and nearly all recommendation reads are cache hits.

3. **Cart data**: Cart contents are cached in Valkey for fast retrieval. Every cart mutation invalidates the cache and writes new state, ensuring consistency.

The "aside" means the cache sits alongside the database -- the database is always the source of truth. If Valkey is down, the application falls back to direct database queries, which are slower but correct. This fail-open behavior is preferable to making the entire application unavailable when the cache is down.

### Circuit Breaker

A circuit breaker prevents an application from repeatedly calling a failing service. Without a circuit breaker, if Elasticsearch goes down, every search request would wait for the full 5-second timeout before failing. With 50,000 concurrent search queries per second, this means 50,000 threads blocked for 5 seconds each, which can exhaust the application's connection pool and crash it -- a cascading failure.

The circuit breaker has three states:

- **CLOSED** (normal): Requests pass through. The breaker tracks failures. When failures exceed a threshold (e.g., 60% of the last 10 requests fail), the breaker trips to OPEN.
- **OPEN** (tripped): Requests immediately fail without calling the downstream service. A fallback response is returned instead. This protects both the application (no wasted resources) and the failing service (no additional load while it recovers).
- **HALF-OPEN** (testing): After a reset timeout (e.g., 10 seconds), the breaker allows one test request through. If it succeeds, the breaker closes. If it fails, the breaker re-opens.

In this project, three circuit breakers protect critical paths:

- **Elasticsearch** (search): Falls back to PostgreSQL full-text search using a `tsvector` GIN index. The fallback provides degraded search (no facets, lower relevance) but search remains functional.
- **Payment gateway**: Falls back to queuing the order as `payment_pending`. This means the customer's order is created but payment is not confirmed until the gateway recovers.
- **Recommendations**: Falls back to returning an empty array. The product page simply does not show the "Customers also bought" section.

The implementation uses the Opossum library (`backend/src/shared/circuitBreaker.ts`). Opossum exposes Prometheus metrics for each breaker's state, enabling dashboards that show when and how often breakers trip.

### Structured Logging

Structured logging emits log entries as JSON objects rather than freeform text. This makes logs machine-parseable, which is essential for a production system handling thousands of requests per second.

Consider a checkout failure. With freeform logging, the operator sees:

```
ERROR: Order creation failed for user 123 - insufficient inventory for product 456
```

With structured logging, the same event produces:

```json
{"level":"error","action":"order.create","userId":123,"productId":456,"reason":"insufficient_inventory","correlationId":"abc-123","timestamp":"2024-01-15T10:30:00Z"}
```

The structured version enables querying: "show me all `order.create` failures with `reason=insufficient_inventory` in the last hour, grouped by `productId`." This reveals patterns (e.g., product 456 is consistently oversold because the reservation cleanup job is delayed).

In this project, structured logging uses Pino (`backend/src/shared/logger.ts`). Every request gets a `correlationId` UUID that is attached to all log entries for that request. This `correlationId` is also stored in the `audit_logs` table, enabling correlation between application logs and the audit trail. Related events across service boundaries (e.g., an order creation that triggers a recommendation recomputation) share the same `correlationId`.

### Prometheus Metrics

Prometheus is a time-series monitoring system that scrapes application metrics via HTTP. The application exposes counters, gauges, and histograms at `GET /metrics`, and Prometheus periodically fetches this data.

Key metrics in this project:

- `inventory_reservations_total{product_id, status}` (Counter): Tracks how many inventory reservations succeed vs. fail. A high failure rate for a specific product means it is frequently out of stock.
- `cart_abandonments_total` (Counter): Counts expired cart reservations (the background job releases them). A high abandonment rate might indicate the 30-minute reservation window is too short.
- `order_value_dollars` (Histogram): Tracks order value distribution across buckets. Useful for detecting anomalies (e.g., a sudden spike in $0 orders might indicate a pricing bug).
- `search_latency_seconds{query_type}` (Histogram): Tracks search latency, labeled by whether Elasticsearch or the PostgreSQL fallback was used. This shows the performance impact when the circuit breaker trips.
- `circuit_breaker_state{service}` (Gauge): Shows whether each circuit breaker is open (1) or closed (0).

SLIs are derived from these metrics. For example, the checkout success rate SLI is computed as `rate(checkouts_total{status="success"}[5m]) / rate(checkouts_total[5m])` with a 99% target. An alert fires when this drops below 98%.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. In an e-commerce context, it prevents bots from scraping the product catalog, price monitoring scripts from overwhelming search, and automated checkout tools from buying all flash-sale inventory.

Note: rate limiting is listed under "What Was Omitted" in this project's implementation notes. The architecture describes the pattern because a production deployment would require it, but the local implementation does not include per-user or per-IP rate limits. At production scale, rate limits would be applied at the API gateway layer using sliding window counters in Valkey, with different limits per endpoint (e.g., 100 searches/minute vs. 10 checkout attempts/minute).

### Idempotency

Idempotency ensures that retrying the same operation produces the same result. In e-commerce, this prevents the most dangerous failure mode: charging a customer twice for the same order.

The checkout endpoint requires an `Idempotency-Key` header (e.g., `order-user123-1705432800-abc123`). The flow:

1. The server attempts `INSERT INTO idempotency_keys (key, status) VALUES ($key, 'processing') ON CONFLICT DO NOTHING`.
2. If the insert succeeds (new key), proceed with order creation.
3. If the insert does nothing (key exists), check the existing record's status:
   - `status = 'completed'`: Return the cached response (duplicate request handled).
   - `status = 'processing'`: Return 409 Conflict (concurrent duplicate detected).
   - `status = 'failed'`: Allow retry by updating status to `'processing'`.

The implementation (`backend/src/shared/idempotency.ts`) stores both the request parameters and the response in the idempotency record. This means a successful retry returns exactly the same response as the original request, including the same order ID and total.

Keys have a 24-hour TTL enforced by an hourly cleanup job. The table uses a single-column primary key (`VARCHAR(255)`) rather than a composite key, making lookups fast.

### Health Checks

Health checks are HTTP endpoints that report service status. They are consumed by three types of systems:

1. **Load balancers**: Route traffic only to healthy instances. An unhealthy instance is removed from the pool until it recovers.
2. **Container orchestrators** (Kubernetes): Restart containers that fail liveness checks. Delay traffic to containers that fail readiness checks (still initializing).
3. **Monitoring dashboards**: Show real-time service health for operators.

In this project, three health check endpoints are implemented:

- `GET /api/health` (liveness): Returns 200 if the HTTP server is responsive. No dependency checks -- just confirms the process is alive.
- `GET /api/health/ready` (readiness): Returns 200 only when PostgreSQL, Valkey, and Elasticsearch connections are established. A newly started instance returns 503 until all connections are ready.
- `GET /api/health/detailed`: Returns per-dependency status as a JSON object: `{"postgres":"healthy","redis":"healthy","elasticsearch":"degraded","overall":"degraded"}`. Each dependency is tested with a lightweight operation (`SELECT 1`, `PING`, `GET _cluster/health`) with a 2-second timeout.

The detailed endpoint distinguishes between "unhealthy" (critical dependency down -- PostgreSQL) and "degraded" (non-critical dependency down -- Elasticsearch, which has a PostgreSQL fallback). This helps operators prioritize their response: "unhealthy" means pages are broken, "degraded" means some features are slower.

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
| Idempotency | `backend/src/shared/idempotency.ts` | Duplicate order prevention with Redis + PostgreSQL |
| Circuit breaker | `backend/src/shared/circuitBreaker.ts` | Protects ES, payment, and recommendation calls (Opossum) |
| Retry with backoff | `backend/src/shared/retry.ts` | Exponential backoff with jitter for transient failures |
| Structured logging | `backend/src/shared/logger.ts` | Pino JSON logging with correlation IDs |
| Prometheus metrics | `backend/src/shared/metrics.ts` | Request duration, order value, search latency, circuit state |
| Audit logging | `backend/src/shared/audit.ts` | Immutable audit trail for orders and inventory |
| Order archival | `backend/src/shared/archival.ts` | Tiered storage with JSONB archive and PII anonymization |
| Elasticsearch sync | `backend/src/utils/syncElasticsearch.ts` | Bulk index products from PostgreSQL to ES |
| Background jobs | `backend/src/services/backgroundJobs.ts` | Reservation cleanup, recommendation computation |
| Reserved inventory | `backend/src/routes/cart.ts` | SELECT FOR UPDATE with 30-min reservation expiry |
| PostgreSQL FTS fallback | `backend/src/routes/search.ts` | Degraded search when ES circuit breaker trips |
| Health checks | `backend/src/routes/` | `/api/health`, `/api/health/detailed`, `/api/health/ready` |

### What Was Simplified or Substituted

| Production | Local | Reason |
|------------|-------|--------|
| Kafka (event streaming) | No message queue | Events processed synchronously in same process |
| Multi-warehouse inventory | Single warehouse | Sufficient for demonstrating reserved model |
| Real payment gateway | Simulated payment | No Stripe/PayPal account needed |
| CDN + edge caching | Direct API calls | No CDN infrastructure locally |
| Multiple API instances + LB | Single Express server (supports 3001-3003) | Can test with multiple ports |
| Kubernetes | docker-compose | Sufficient for local development |
| Multi-region PostgreSQL | Single PostgreSQL instance | No replication locally |
| ML recommendation model | SQL co-purchase query | Demonstrates the concept without GPU |

### What Was Omitted

- **Kafka**: No event streaming; order events are processed synchronously
- **CDN**: No static asset caching or geographic distribution
- **Multi-region replication**: Single PostgreSQL instance
- **Kubernetes orchestration**: docker-compose only
- **Real payment processing**: Simulated; no Stripe integration
- **OAuth / SSO**: Session-based auth only
- **Product image storage**: URLs stored as text arrays; no MinIO/S3
- **Sharding**: Single database instance
- **Rate limiting**: No per-user or per-IP rate limits
