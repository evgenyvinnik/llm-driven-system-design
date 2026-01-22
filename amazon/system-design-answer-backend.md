# Amazon E-Commerce - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement

"Today I'll design the backend infrastructure for an e-commerce platform like Amazon. The key backend challenges are inventory management that prevents overselling under high concurrency, product search with faceted filtering at scale, and recommendation systems. I'll focus on database design, exactly-once semantics for order processing, caching strategies, and event-driven architecture for inventory updates."

---

## Requirements Clarification

### Functional Requirements

1. **Catalog**: Browse and search products across categories
2. **Cart**: Add items with inventory reservation
3. **Checkout**: Purchase with payment processing and exactly-once semantics
4. **Orders**: Track order status through fulfillment
5. **Recommendations**: "Customers also bought" suggestions

### Non-Functional Requirements

- **Availability**: 99.99% for browsing (revenue impact of downtime)
- **Consistency**: Strong consistency for inventory (no overselling)
- **Latency**: < 100ms for search results, < 10ms for inventory checks
- **Scale**: 100M products, 1M orders/day, 10K concurrent checkouts

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Products | 100M |
| Daily Orders | 1M (~12/second) |
| Peak Concurrent Users | 500K |
| Search QPS | 100K |
| Cart Read:Write Ratio | 10:1 |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway / Load Balancer                   │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Catalog Service│    │ Cart Service  │    │ Order Service │
│               │    │               │    │               │
│ - Products    │    │ - Add/remove  │    │ - Checkout    │
│ - Categories  │    │ - Reservation │    │ - Fulfillment │
│ - Search      │    │ - Expiration  │    │ - Tracking    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                  │
├─────────────┬─────────────┬─────────────┬───────────────────────┤
│ PostgreSQL  │Elasticsearch│   Valkey    │     Kafka             │
│ - Products  │ - Search    │ - Cart      │ - Order events        │
│ - Orders    │ - Facets    │ - Sessions  │ - Inventory updates   │
│ - Inventory │             │ - Dedup     │ - Recommendations     │
└─────────────┴─────────────┴─────────────┴───────────────────────┘
```

---

## Deep Dive 1: Reserved Inventory Model

### The Overselling Problem

Overselling occurs when:
1. Two users simultaneously check inventory (both see 1 available)
2. Both add to cart / checkout
3. Inventory becomes -1

### Solution: Reserved Inventory Pattern

```sql
CREATE TABLE inventory (
  product_id INTEGER REFERENCES products(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  quantity INTEGER DEFAULT 0,      -- Total physical stock
  reserved INTEGER DEFAULT 0,      -- Reserved by active carts
  PRIMARY KEY (product_id, warehouse_id)
);

-- Available = quantity - reserved
-- Invariant: reserved <= quantity
```

### Add to Cart with Reservation

```typescript
async function addToCart(userId: string, productId: string, quantity: number) {
  return await db.transaction(async (trx) => {
    // 1. Lock and check inventory
    const inventory = await trx('inventory')
      .where({ product_id: productId })
      .forUpdate()  // Row-level lock
      .first();

    const available = inventory.quantity - inventory.reserved;
    if (available < quantity) {
      throw new InsufficientInventoryError(productId, available, quantity);
    }

    // 2. Reserve inventory atomically
    await trx('inventory')
      .where({ product_id: productId })
      .increment('reserved', quantity);

    // 3. Add to cart with expiration
    await trx('cart_items')
      .insert({
        user_id: userId,
        product_id: productId,
        quantity,
        reserved_until: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
      })
      .onConflict(['user_id', 'product_id'])
      .merge({
        quantity: trx.raw('cart_items.quantity + ?', [quantity]),
        reserved_until: new Date(Date.now() + 30 * 60 * 1000)
      });

    return { success: true, expiresAt: new Date(Date.now() + 30 * 60 * 1000) };
  });
}
```

### Background Job: Release Expired Reservations

```typescript
// Run every minute via cron
async function releaseExpiredReservations() {
  const released = await db.transaction(async (trx) => {
    // Find and lock expired items
    const expired = await trx('cart_items')
      .where('reserved_until', '<', new Date())
      .forUpdate()
      .skipLocked()  // Non-blocking for concurrent job runs
      .select('product_id', db.raw('SUM(quantity) as total'));

    if (expired.length === 0) return 0;

    // Release reserved inventory
    for (const item of expired) {
      await trx('inventory')
        .where({ product_id: item.product_id })
        .decrement('reserved', item.total);
    }

    // Delete expired cart items
    const deleted = await trx('cart_items')
      .where('reserved_until', '<', new Date())
      .delete();

    return deleted;
  });

  logger.info({ released }, 'Released expired cart reservations');
  cartAbandonments.inc(released);
}
```

---

## Deep Dive 2: Exactly-Once Order Processing

### Multi-Layer Idempotency

```typescript
// Layer 1: Client-provided idempotency key
app.post('/api/orders', async (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Idempotency-Key header required' });
  }

  // Check for existing operation
  const existing = await redis.get(`idem:order:${idempotencyKey}`);
  if (existing) {
    const cached = JSON.parse(existing);
    if (cached.status === 'processing') {
      return res.status(409).json({ error: 'Order in progress', retryAfter: 5 });
    }
    return res.status(200).json(cached.response);
  }

  // Mark as processing
  await redis.setex(`idem:order:${idempotencyKey}`, 86400,
    JSON.stringify({ status: 'processing' }));

  try {
    const order = await processCheckout(req.body, idempotencyKey);

    // Cache successful response
    await redis.setex(`idem:order:${idempotencyKey}`, 86400,
      JSON.stringify({ status: 'completed', response: order }));

    return res.status(201).json(order);
  } catch (error) {
    await redis.setex(`idem:order:${idempotencyKey}`, 300,
      JSON.stringify({ status: 'failed', error: error.message }));
    throw error;
  }
});

// Layer 2: Database constraint
async function processCheckout(data: CheckoutData, idempotencyKey: string) {
  return await db.transaction(async (trx) => {
    // Check if order already exists (database-level dedup)
    const existingOrder = await trx('orders')
      .where({ idempotency_key: idempotencyKey })
      .first();

    if (existingOrder) {
      return existingOrder;
    }

    // Lock cart items
    const cartItems = await trx('cart_items')
      .where({ user_id: data.userId })
      .forUpdate();

    if (cartItems.length === 0) {
      throw new Error('Cart is empty');
    }

    // Verify inventory still available
    for (const item of cartItems) {
      const inv = await trx('inventory')
        .where({ product_id: item.product_id })
        .forUpdate()
        .first();

      if (inv.quantity < item.quantity) {
        throw new InsufficientInventoryError(item.product_id);
      }
    }

    // Create order with idempotency key
    const [order] = await trx('orders')
      .insert({
        user_id: data.userId,
        status: 'pending',
        total: data.total,
        shipping_address: data.shippingAddress,
        idempotency_key: idempotencyKey
      })
      .returning('*');

    // Convert reserved to sold
    for (const item of cartItems) {
      await trx('inventory')
        .where({ product_id: item.product_id })
        .decrement('quantity', item.quantity)
        .decrement('reserved', item.quantity);

      await trx('order_items').insert({
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        price: item.price
      });
    }

    // Clear cart
    await trx('cart_items').where({ user_id: data.userId }).delete();

    // Publish order event
    await kafka.send('order-events', {
      key: order.id.toString(),
      value: JSON.stringify({ type: 'order.created', order })
    });

    return order;
  });
}
```

---

## Deep Dive 3: Elasticsearch for Product Search

### Index Schema

```json
{
  "mappings": {
    "properties": {
      "title": { "type": "text", "analyzer": "english" },
      "description": { "type": "text", "analyzer": "english" },
      "category_id": { "type": "keyword" },
      "category_path": { "type": "keyword" },
      "brand": { "type": "keyword" },
      "price": { "type": "float" },
      "rating": { "type": "float" },
      "review_count": { "type": "integer" },
      "in_stock": { "type": "boolean" },
      "attributes": {
        "type": "nested",
        "properties": {
          "name": { "type": "keyword" },
          "value": { "type": "keyword" }
        }
      }
    }
  },
  "settings": {
    "number_of_shards": 5,
    "number_of_replicas": 1,
    "refresh_interval": "5s"
  }
}
```

### Faceted Search Implementation

```typescript
async function searchProducts(query: string, filters: SearchFilters, page: number = 0) {
  const body = {
    query: {
      function_score: {
        query: {
          bool: {
            must: query ? [{ multi_match: { query, fields: ['title^3', 'description'] }}] : [],
            filter: [
              filters.category && { term: { category_path: filters.category } },
              filters.priceMin && { range: { price: { gte: filters.priceMin } } },
              filters.priceMax && { range: { price: { lte: filters.priceMax } } },
              filters.inStock && { term: { in_stock: true } },
              filters.brands?.length && { terms: { brand: filters.brands } },
              filters.rating && { range: { rating: { gte: filters.rating } } }
            ].filter(Boolean)
          }
        },
        functions: [
          // Boost in-stock items
          { filter: { term: { in_stock: true } }, weight: 2 },
          // Boost by rating
          { field_value_factor: { field: 'rating', factor: 1.2, modifier: 'sqrt' } },
          // Boost by review count (popularity)
          { field_value_factor: { field: 'review_count', factor: 1.1, modifier: 'log1p' } }
        ],
        boost_mode: 'multiply'
      }
    },
    aggs: {
      categories: { terms: { field: 'category_path', size: 20 } },
      brands: { terms: { field: 'brand', size: 50 } },
      price_ranges: {
        range: {
          field: 'price',
          ranges: [
            { key: 'Under $25', to: 25 },
            { key: '$25-$50', from: 25, to: 50 },
            { key: '$50-$100', from: 50, to: 100 },
            { key: '$100-$200', from: 100, to: 200 },
            { key: 'Over $200', from: 200 }
          ]
        }
      },
      avg_rating: { avg: { field: 'rating' } }
    },
    from: page * 20,
    size: 20
  };

  const startTime = Date.now();
  const result = await es.search({ index: 'products', body });
  const latency = Date.now() - startTime;

  searchLatency.observe({ query_type: 'faceted' }, latency / 1000);

  return {
    products: result.hits.hits.map(h => ({ ...h._source, score: h._score })),
    facets: {
      categories: result.aggregations.categories.buckets,
      brands: result.aggregations.brands.buckets,
      priceRanges: result.aggregations.price_ranges.buckets
    },
    total: result.hits.total.value,
    latencyMs: latency
  };
}
```

### PostgreSQL Fallback (Circuit Breaker)

```typescript
const searchCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  successThreshold: 2,
  timeout: 10000
});

async function searchWithFallback(query: string, filters: SearchFilters) {
  try {
    return await searchCircuitBreaker.execute(() => searchProducts(query, filters));
  } catch (error) {
    if (error.message === 'Circuit breaker is OPEN') {
      logger.warn('Elasticsearch circuit open, falling back to PostgreSQL');
      return await pgFallbackSearch(query, filters);
    }
    throw error;
  }
}

async function pgFallbackSearch(query: string, filters: SearchFilters) {
  const products = await db('products')
    .select('products.*')
    .where('is_active', true)
    .andWhere(function() {
      if (query) {
        this.whereRaw(
          `to_tsvector('english', title || ' ' || COALESCE(description, ''))
           @@ plainto_tsquery('english', ?)`,
          [query]
        );
      }
    })
    .andWhere(function() {
      if (filters.category) this.where('category_id', filters.category);
      if (filters.priceMin) this.where('price', '>=', filters.priceMin);
      if (filters.priceMax) this.where('price', '<=', filters.priceMax);
    })
    .orderByRaw(query ?
      `ts_rank(to_tsvector('english', title), plainto_tsquery('english', ?)) DESC` :
      'rating DESC',
      query ? [query] : []
    )
    .limit(20);

  return { products, facets: {}, total: products.length, fallback: true };
}
```

---

## Deep Dive 4: Recommendation Engine

### Batch Computation of "Also Bought"

```typescript
// Nightly batch job
async function computeAlsoBoughtRecommendations() {
  const batchSize = 100;
  let offset = 0;

  while (true) {
    const products = await db('products')
      .where('is_active', true)
      .orderBy('id')
      .offset(offset)
      .limit(batchSize);

    if (products.length === 0) break;

    for (const product of products) {
      const alsoBought = await db.raw(`
        SELECT
          oi2.product_id,
          COUNT(*) as frequency,
          COUNT(*)::DECIMAL / (
            SELECT COUNT(DISTINCT order_id)
            FROM order_items WHERE product_id = ?
          ) as score
        FROM order_items oi1
        JOIN order_items oi2 ON oi1.order_id = oi2.order_id
        WHERE oi1.product_id = ?
          AND oi2.product_id != ?
          AND oi1.created_at > NOW() - INTERVAL '90 days'
        GROUP BY oi2.product_id
        ORDER BY frequency DESC
        LIMIT 20
      `, [product.id, product.id, product.id]);

      // Cache in Valkey with 24-hour TTL
      if (alsoBought.rows.length > 0) {
        await redis.setex(
          `recs:also_bought:${product.id}`,
          86400,
          JSON.stringify(alsoBought.rows)
        );
      }

      // Also store in PostgreSQL for durability
      await db('product_recommendations')
        .where({ product_id: product.id, recommendation_type: 'also_bought' })
        .delete();

      if (alsoBought.rows.length > 0) {
        await db('product_recommendations').insert(
          alsoBought.rows.map(r => ({
            product_id: product.id,
            recommended_product_id: r.product_id,
            recommendation_type: 'also_bought',
            score: r.score
          }))
        );
      }
    }

    offset += batchSize;
    logger.info({ processed: offset }, 'Recommendation batch progress');
  }
}
```

### Real-Time Recommendation Retrieval

```typescript
async function getAlsoBoughtRecommendations(productId: string): Promise<Product[]> {
  // Try cache first
  const cached = await redis.get(`recs:also_bought:${productId}`);
  if (cached) {
    const recs = JSON.parse(cached);
    return await db('products')
      .whereIn('id', recs.map(r => r.product_id))
      .where('is_active', true);
  }

  // Fallback to database
  const recs = await db('product_recommendations')
    .where({ product_id: productId, recommendation_type: 'also_bought' })
    .orderBy('score', 'desc')
    .limit(10);

  const products = await db('products')
    .whereIn('id', recs.map(r => r.recommended_product_id))
    .where('is_active', true);

  return products;
}
```

---

## Deep Dive 5: Data Lifecycle and Archival

### Retention Policies

```typescript
const RetentionPolicies = {
  ORDERS: {
    hotStorageDays: 730,        // 2 years in PostgreSQL
    archiveRetentionDays: 2555, // 7 years total (legal requirement)
    anonymizeAfterDays: 2555
  },
  CART_ITEMS: {
    reservationMinutes: 30
  },
  AUDIT_LOGS: {
    hotStorageDays: 365,
    archiveRetentionDays: 1095  // 3 years
  },
  SEARCH_LOGS: {
    retentionDays: 90
  }
};
```

### Order Archival Process

```typescript
async function archiveOldOrders() {
  const cutoffDate = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000); // 2 years
  const batchSize = 1000;

  while (true) {
    const ordersToArchive = await db('orders')
      .where('created_at', '<', cutoffDate)
      .whereNull('archived_at')
      .whereIn('status', ['delivered', 'cancelled', 'refunded'])
      .limit(batchSize);

    if (ordersToArchive.length === 0) break;

    for (const order of ordersToArchive) {
      // Get full order with items
      const items = await db('order_items').where({ order_id: order.id });

      const archiveData = {
        order: { ...order },
        items: items
      };

      // Insert into archive table
      await db('orders_archive').insert({
        order_id: order.id,
        user_id: order.user_id,
        archive_data: archiveData,
        created_at: order.created_at,
        archived_at: new Date()
      });

      // Anonymize original order (keep for reference)
      await db('orders')
        .where({ id: order.id })
        .update({
          archived_at: new Date(),
          archive_status: 'archived',
          shipping_address: { anonymized: true },
          billing_address: null,
          notes: null
        });
    }

    logger.info({ archived: ordersToArchive.length }, 'Archived orders batch');
  }
}
```

---

## Deep Dive 6: Observability

### Prometheus Metrics

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

// Order metrics
const ordersTotal = new Counter({
  name: 'orders_total',
  help: 'Total orders processed',
  labelNames: ['status'] // 'success', 'failed', 'duplicate'
});

const orderValue = new Histogram({
  name: 'order_value_dollars',
  help: 'Distribution of order values',
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500]
});

// Inventory metrics
const inventoryReservations = new Counter({
  name: 'inventory_reservations_total',
  help: 'Inventory reservation attempts',
  labelNames: ['status'] // 'success', 'insufficient', 'error'
});

const cartAbandonments = new Counter({
  name: 'cart_abandonments_total',
  help: 'Carts expired due to reservation timeout'
});

// Search metrics
const searchLatency = new Histogram({
  name: 'search_latency_seconds',
  help: 'Search query latency',
  labelNames: ['query_type', 'engine'], // engine: elasticsearch, postgres
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1]
});

// Circuit breaker state
const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service']
});
```

### Alert Rules

```yaml
groups:
  - name: amazon-ecommerce
    rules:
      - alert: HighCheckoutFailureRate
        expr: rate(orders_total{status="failed"}[5m]) / rate(orders_total[5m]) > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Checkout failure rate above 5%"

      - alert: InventoryOversell
        expr: increase(inventory_oversell_total[1h]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Inventory oversell detected - immediate investigation required"

      - alert: SearchLatencyHigh
        expr: histogram_quantile(0.99, rate(search_latency_seconds_bucket[5m])) > 0.3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Search p99 latency above 300ms"

      - alert: ElasticsearchCircuitOpen
        expr: circuit_breaker_state{service="elasticsearch"} == 2
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Elasticsearch circuit breaker is open"
```

---

## Database Schema Highlights

```sql
-- Core tables with indexes
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER REFERENCES sellers(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  slug VARCHAR(500) UNIQUE NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  price DECIMAL(10,2) NOT NULL,
  rating DECIMAL(2,1) DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_price ON products(price);
CREATE INDEX idx_products_rating ON products(rating);
CREATE INDEX idx_products_search ON products
  USING gin(to_tsvector('english', title || ' ' || COALESCE(description, '')));

-- Orders with idempotency
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(30) DEFAULT 'pending',
  total DECIMAL(10,2) NOT NULL,
  shipping_address JSONB NOT NULL,
  idempotency_key VARCHAR(255) UNIQUE,
  archive_status VARCHAR(20) DEFAULT 'active',
  archived_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_orders_idempotency ON orders(idempotency_key);
CREATE INDEX idx_orders_archive_status ON orders(archive_status);
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Inventory model | Reserved quantity | Decrement on add | Prevents overselling, allows cart expiration |
| Search engine | Elasticsearch + PG fallback | PostgreSQL only | Performance at scale, but graceful degradation |
| Recommendations | Batch precompute | Real-time ML | Simplicity, cache-friendly, acceptable staleness |
| Order idempotency | Redis + PostgreSQL | PostgreSQL only | Fast duplicate detection, durable backup |
| Cart storage | PostgreSQL + cache | Redis only | Durability for inventory reservations |
| Archival | Tiered (hot/warm/cold) | Keep all in PostgreSQL | Cost efficiency, query performance |

---

## Future Backend Enhancements

1. **Kafka for Async Processing**: Decouple checkout from inventory updates, enable event sourcing
2. **Read Replicas**: Distribute catalog reads across PostgreSQL replicas
3. **Sharding**: Partition orders by user_id or date for horizontal scaling
4. **ML Recommendations**: Replace batch collaborative filtering with real-time models
5. **Geo-Distributed Inventory**: Multi-region inventory with eventual consistency
6. **Rate Limiting**: Token bucket rate limiter for flash sale protection
7. **Saga Pattern**: Distributed transaction for checkout across services
