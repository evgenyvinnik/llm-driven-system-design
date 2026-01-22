# Etsy (Handmade Marketplace) - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction

"Today I'll design a marketplace for handmade and vintage goods like Etsy. I'll focus on the backend challenges: building search relevance for non-standardized products with Elasticsearch synonyms, handling multi-seller cart and checkout with transaction safety, inventory management for one-of-a-kind items, and caching strategies for popular listings. The key difference from Amazon is that most products are unique with quantity of 1."

---

## Step 1: Requirements Clarification

### Functional Requirements

"Let me confirm what we're building:

1. **Shops**: Sellers create and manage their shops with branding
2. **Products**: List handmade or vintage items with detailed descriptions
3. **Search**: Find products across varied terminology and misspellings
4. **Multi-Seller Cart**: Cart with items from multiple shops
5. **Checkout**: Single payment creates separate orders per seller
6. **Personalization**: Favorites-based recommendations with sparse signals

Should I focus on search relevance or the checkout flow first?"

### Non-Functional Requirements

"For a marketplace backend:

- **Availability**: 99.9% for search and browsing, 99.95% for checkout
- **Search Latency**: < 200ms p95 for search results
- **Checkout Latency**: < 500ms p99 for order creation
- **Consistency**: Strong consistency for inventory and orders
- **Unique Inventory**: Most items have quantity 1"

---

## Step 2: High-Level Architecture

```
                    ┌─────────────────┐
                    │  Load Balancer  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
    ┌─────────▼────┐  ┌─────▼─────┐  ┌─────▼─────┐
    │ API Server 1 │  │ API Server│  │ API Server│
    │   (Express)  │  │     2     │  │     3     │
    └──────┬───────┘  └─────┬─────┘  └─────┬─────┘
           │                │              │
           └────────────────┼──────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
    ┌────▼────┐       ┌─────▼─────┐      ┌─────▼─────┐
    │PostgreSQL│       │ Elastic- │      │  Redis    │
    │  (Data)  │       │  search  │      │ (Cache)   │
    └──────────┘       └──────────┘      └───────────┘
```

### Component Responsibilities

| Component | Purpose | Why This Choice |
|-----------|---------|-----------------|
| PostgreSQL | Shops, products, orders, users | ACID for inventory, relational integrity |
| Elasticsearch | Product search with synonyms | Fuzzy matching, synonym expansion |
| Redis | Session, cache, cart | Low-latency reads, cart state |
| Express.js | API routing, business logic | Familiar, async I/O |

---

## Deep Dive 1: Multi-Seller Checkout with Transaction Safety

"The checkout flow is the most critical backend operation. A single cart can have items from multiple sellers, but we create separate orders per seller."

### Why Split Orders by Seller?

1. **Independent Fulfillment**: Each seller ships from their location
2. **Different Timelines**: Handmade items may have varying production times
3. **Dispute Resolution**: Issues are per-seller, not per-cart
4. **Payout Processing**: Sellers receive funds independently

### Cart Structure in PostgreSQL

```sql
CREATE TABLE cart_items (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER DEFAULT 1,
    reserved_until TIMESTAMP, -- For unique items
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

CREATE INDEX idx_cart_user ON cart_items(user_id);
CREATE INDEX idx_cart_product ON cart_items(product_id);
CREATE INDEX idx_cart_reservation ON cart_items(reserved_until) WHERE reserved_until IS NOT NULL;
```

### Checkout Transaction Logic

```javascript
async function checkout(userId, paymentMethodId) {
  const cart = await getCartSummary(userId);

  // Validation phase (before transaction)
  for (const shop of cart.shops) {
    for (const item of shop.items) {
      if (item.available < item.quantity) {
        throw new Error(`${item.title} is no longer available`);
      }
    }
  }

  // Create orders atomically - one per seller
  const orders = await db.transaction(async (trx) => {
    const createdOrders = [];

    for (const shop of cart.shops) {
      // Create order header
      const [order] = await trx('orders').insert({
        buyer_id: userId,
        shop_id: shop.shop_id,
        subtotal: shop.subtotal,
        shipping: shop.shipping,
        total: shop.subtotal + shop.shipping,
        status: 'pending'
      }).returning('*');

      // Create order items and decrement inventory
      for (const item of shop.items) {
        await trx('order_items').insert({
          order_id: order.id,
          product_id: item.product_id,
          quantity: item.quantity,
          price_at_purchase: item.price
        });

        // Atomic inventory decrement with check
        const updated = await trx('products')
          .where({ id: item.product_id })
          .where('quantity', '>=', item.quantity)
          .decrement('quantity', item.quantity);

        if (updated === 0) {
          throw new Error(`Insufficient inventory for ${item.title}`);
        }
      }

      // Update shop sales count
      await trx('shops')
        .where({ id: shop.shop_id })
        .increment('sales_count', shop.items.length);

      createdOrders.push(order);
    }

    // Clear cart
    await trx('cart_items').where({ user_id: userId }).delete();

    return createdOrders;
  });

  // Process single payment for total (after successful transaction)
  await processPayment(userId, paymentMethodId, cart.total);

  // Async notifications to sellers (non-blocking)
  for (const order of orders) {
    notificationQueue.publish('order.created', { orderId: order.id });
  }

  return orders;
}
```

### Idempotency for Checkout

```javascript
// Middleware to prevent duplicate orders
export function idempotencyMiddleware(keyPrefix = 'checkout') {
  return async (req, res, next) => {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
      return next(); // Optional for non-critical endpoints
    }

    const cacheKey = `idempotency:${keyPrefix}:${idempotencyKey}`;
    const existing = await redis.get(cacheKey);

    if (existing) {
      const { statusCode, result, state } = JSON.parse(existing);

      if (state === 'COMPLETED') {
        // Return cached response
        return res.status(statusCode).json(result);
      } else if (state === 'PROCESSING') {
        // Request is still being processed
        return res.status(409).json({ error: 'Request already in progress' });
      }
    }

    // Mark as processing
    await redis.setex(cacheKey, 86400, JSON.stringify({ state: 'PROCESSING' }));

    // Capture response to cache
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      redis.setex(cacheKey, 86400, JSON.stringify({
        state: 'COMPLETED',
        statusCode: res.statusCode,
        result: data
      }));
      return originalJson(data);
    };

    next();
  };
}
```

---

## Deep Dive 2: Elasticsearch for Non-Standardized Products

"Handmade products are described inconsistently. 'Handmade leather wallet' and 'hand-crafted leather billfold' are the same product category but use different words."

### Custom Analyzer with Synonyms

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
            "handmade, handcrafted, artisan, homemade, hand-made",
            "vintage, antique, retro, old, classic, secondhand",
            "wallet, billfold, purse, cardholder, pocketbook",
            "necklace, pendant, chain, choker, lariat",
            "earrings, studs, drops, hoops, dangles",
            "ring, band, signet, wedding band",
            "leather, genuine leather, real leather, cowhide, full grain",
            "silver, sterling, 925, sterling silver",
            "gold, 14k, 18k, gold filled, gold plated"
          ]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "title": { "type": "text", "analyzer": "etsy_analyzer", "boost": 3 },
      "description": { "type": "text", "analyzer": "etsy_analyzer" },
      "tags": { "type": "keyword" },
      "category": { "type": "keyword" },
      "price": { "type": "float" },
      "shop_id": { "type": "keyword" },
      "shop_rating": { "type": "float" },
      "shop_sales_count": { "type": "integer" },
      "is_vintage": { "type": "boolean" },
      "quantity": { "type": "integer" },
      "created_at": { "type": "date" }
    }
  }
}
```

### Search Query with Ranking

```javascript
async function searchProducts(query, filters = {}) {
  const must = [];
  const filter = [];

  // Main query with fuzzy matching
  if (query) {
    must.push({
      multi_match: {
        query: query,
        fields: ['title^3', 'description', 'tags^2'],
        fuzziness: 'AUTO',
        prefix_length: 2
      }
    });
  }

  // Apply filters
  if (filters.category) {
    filter.push({ term: { category: filters.category } });
  }
  if (filters.priceMin !== undefined) {
    filter.push({ range: { price: { gte: filters.priceMin } } });
  }
  if (filters.priceMax !== undefined) {
    filter.push({ range: { price: { lte: filters.priceMax } } });
  }
  if (filters.isVintage !== undefined) {
    filter.push({ term: { is_vintage: filters.isVintage } });
  }
  // Only show in-stock items
  filter.push({ range: { quantity: { gt: 0 } } });

  const body = {
    query: {
      function_score: {
        query: {
          bool: { must, filter }
        },
        functions: [
          // Boost by seller rating
          {
            field_value_factor: {
              field: 'shop_rating',
              factor: 1.5,
              modifier: 'sqrt',
              missing: 3.0
            }
          },
          // Boost by sales count (trust signal)
          {
            field_value_factor: {
              field: 'shop_sales_count',
              factor: 1.2,
              modifier: 'log1p',
              missing: 0
            }
          },
          // Recency boost for new listings
          {
            gauss: {
              created_at: {
                origin: 'now',
                scale: '30d',
                decay: 0.5
              }
            }
          }
        ],
        score_mode: 'multiply',
        boost_mode: 'multiply'
      }
    },
    aggs: {
      categories: { terms: { field: 'category', size: 20 } },
      price_ranges: {
        range: {
          field: 'price',
          ranges: [
            { key: 'Under $25', to: 25 },
            { key: '$25-$50', from: 25, to: 50 },
            { key: '$50-$100', from: 50, to: 100 },
            { key: 'Over $100', from: 100 }
          ]
        }
      }
    },
    size: filters.limit || 20,
    from: filters.offset || 0
  };

  return await esClient.search({ index: 'products', body });
}
```

### Search Result Caching

```javascript
async function searchWithCache(query, filters) {
  // Cache key includes all search parameters
  const cacheKey = `search:${hashObject({ query, filters })}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    metrics.cacheHits.inc({ type: 'search' });
    return JSON.parse(cached);
  }

  metrics.cacheMisses.inc({ type: 'search' });
  const results = await searchProducts(query, filters);

  // Cache for 2 minutes (balance freshness vs ES load)
  await redis.setex(cacheKey, 120, JSON.stringify(results));

  return results;
}
```

---

## Deep Dive 3: One-of-a-Kind Inventory Management

"Most Etsy items are unique. When quantity is 1, we need to prevent overselling while providing good UX."

### Inventory Reservation System

```sql
-- Products table with quantity tracking
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    shop_id INTEGER REFERENCES shops(id),
    title VARCHAR(200) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    quantity INTEGER DEFAULT 1,  -- Often 1 for handmade
    category_id INTEGER REFERENCES categories(id),
    tags TEXT[],
    images TEXT[],
    is_vintage BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for low-inventory queries
CREATE INDEX idx_products_quantity ON products(quantity) WHERE quantity <= 3;
```

### Add to Cart with Reservation

```javascript
async function addToCart(userId, productId, quantity = 1) {
  const product = await db('products').where({ id: productId }).first();

  if (!product) {
    throw new NotFoundError('Product not found');
  }

  if (product.quantity < quantity) {
    throw new ConflictError('Insufficient inventory');
  }

  // For unique items (qty=1), check if reserved by someone else
  if (product.quantity === 1) {
    const existingReservation = await db('cart_items')
      .where({ product_id: productId })
      .where('reserved_until', '>', new Date())
      .whereNot({ user_id: userId })
      .first();

    if (existingReservation) {
      return {
        success: false,
        message: 'Someone else is checking out with this item. It may become available soon.',
        reservedUntil: existingReservation.reserved_until
      };
    }
  }

  // Upsert cart item with 15-minute reservation for unique items
  const reservationDuration = product.quantity === 1 ? 15 * 60 * 1000 : null;
  const reservedUntil = reservationDuration
    ? new Date(Date.now() + reservationDuration)
    : null;

  await db('cart_items')
    .insert({
      user_id: userId,
      product_id: productId,
      quantity: quantity,
      reserved_until: reservedUntil,
      added_at: new Date()
    })
    .onConflict(['user_id', 'product_id'])
    .merge({
      quantity: quantity,
      reserved_until: reservedUntil
    });

  // Invalidate cart cache
  await redis.del(`cart:${userId}`);

  return { success: true, reservedUntil };
}
```

### Reservation Cleanup Worker

```javascript
// Run every minute to clean expired reservations
async function cleanupExpiredReservations() {
  const expired = await db('cart_items')
    .where('reserved_until', '<', new Date())
    .whereNotNull('reserved_until')
    .delete()
    .returning('*');

  if (expired.length > 0) {
    logger.info({ count: expired.length }, 'Cleaned up expired reservations');
    metrics.reservationsExpired.inc(expired.length);
  }
}

// Schedule with node-cron
cron.schedule('* * * * *', cleanupExpiredReservations);
```

---

## Deep Dive 4: Caching Strategy for Popular Listings

"Popular products receive disproportionate traffic. A trending item might get thousands of views while most products get a handful."

### Cache Architecture

```javascript
// Cache configuration by data type
const CACHE_CONFIG = {
  product: {
    ttl: 300,      // 5 minutes
    pattern: 'product:{id}'
  },
  shop: {
    ttl: 600,      // 10 minutes
    pattern: 'shop:{id}'
  },
  cart: {
    ttl: 1800,     // 30 minutes
    pattern: 'cart:{userId}'
  },
  search: {
    ttl: 120,      // 2 minutes
    pattern: 'search:{hash}'
  },
  trending: {
    ttl: 900,      // 15 minutes (expensive aggregation)
    pattern: 'trending:{category}'
  }
};
```

### Cache-Aside with Stampede Prevention

```javascript
async function getProductWithCache(productId) {
  const cacheKey = `product:${productId}`;
  const lockKey = `lock:product:${productId}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    metrics.cacheHits.inc({ type: 'product' });
    return JSON.parse(cached);
  }

  // Acquire lock to prevent thundering herd
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');

  if (!acquired) {
    // Another process is fetching, wait and retry
    await sleep(50);
    return getProductWithCache(productId);
  }

  try {
    metrics.cacheMisses.inc({ type: 'product' });

    const product = await db('products')
      .join('shops', 'products.shop_id', 'shops.id')
      .where({ 'products.id': productId })
      .select(
        'products.*',
        'shops.name as shop_name',
        'shops.rating as shop_rating'
      )
      .first();

    if (product) {
      await redis.setex(cacheKey, CACHE_CONFIG.product.ttl, JSON.stringify(product));
    }

    return product;
  } finally {
    await redis.del(lockKey);
  }
}
```

### Cache Invalidation on Updates

```javascript
async function updateProduct(productId, updates) {
  await db('products')
    .where({ id: productId })
    .update({ ...updates, updated_at: new Date() });

  // Invalidate caches
  const product = await db('products').where({ id: productId }).first();

  await Promise.all([
    redis.del(`product:${productId}`),
    redis.del(`shop:${product.shop_id}:products`),
    // Invalidate search caches for affected category
    redis.keys(`search:*`).then(keys =>
      keys.length > 0 ? redis.del(keys) : null
    )
  ]);

  // Update Elasticsearch
  await esClient.update({
    index: 'products',
    id: productId,
    body: { doc: updates }
  });
}
```

---

## Deep Dive 5: Database Schema and Indexing

### Complete Schema

```sql
-- Users
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Shops (sellers)
CREATE TABLE shops (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER UNIQUE REFERENCES users(id),
    name VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    banner_image VARCHAR(500),
    logo_image VARCHAR(500),
    rating DECIMAL(2, 1) DEFAULT 0,
    sales_count INTEGER DEFAULT 0,
    shipping_policy JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Categories
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    parent_id INTEGER REFERENCES categories(id),
    slug VARCHAR(100) UNIQUE NOT NULL
);

-- Products
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    quantity INTEGER DEFAULT 1,
    category_id INTEGER REFERENCES categories(id),
    tags TEXT[],
    images TEXT[],
    is_vintage BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_products_shop ON products(shop_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_price ON products(price);
CREATE INDEX idx_products_created ON products(created_at DESC);

-- Orders (one per shop per checkout)
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    buyer_id INTEGER REFERENCES users(id),
    shop_id INTEGER REFERENCES shops(id),
    subtotal DECIMAL(10, 2) NOT NULL,
    shipping DECIMAL(10, 2) NOT NULL,
    total DECIMAL(10, 2) NOT NULL,
    status VARCHAR(30) DEFAULT 'pending',
    tracking_number VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_orders_buyer ON orders(buyer_id);
CREATE INDEX idx_orders_shop ON orders(shop_id);
CREATE INDEX idx_orders_status ON orders(status);

-- Order Items
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id),
    quantity INTEGER NOT NULL,
    price_at_purchase DECIMAL(10, 2) NOT NULL
);

-- Favorites (polymorphic)
CREATE TABLE favorites (
    user_id INTEGER REFERENCES users(id),
    favoritable_type VARCHAR(20) NOT NULL, -- 'product' or 'shop'
    favoritable_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, favoritable_type, favoritable_id)
);

CREATE INDEX idx_favorites_user ON favorites(user_id);
CREATE INDEX idx_favorites_target ON favorites(favoritable_type, favoritable_id);

-- Reviews
CREATE TABLE reviews (
    id SERIAL PRIMARY KEY,
    order_id INTEGER UNIQUE REFERENCES orders(id),
    reviewer_id INTEGER REFERENCES users(id),
    shop_id INTEGER REFERENCES shops(id),
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_reviews_shop ON reviews(shop_id);
```

---

## Trade-offs Discussion

| Decision | Chosen | Alternative | Why This Choice |
|----------|--------|-------------|-----------------|
| Order structure | Split by seller | Single order | Each seller ships independently |
| Inventory check | In transaction | Optimistic locking | Strong consistency for qty=1 items |
| Search | Elasticsearch + synonyms | PostgreSQL full-text | Better fuzzy matching for varied terms |
| Cart reservation | 15-min timeout | No reservation | Prevents overselling unique items |
| Cache invalidation | Event-driven | TTL only | Accuracy for inventory counts |

---

## Observability and Monitoring

### Key Metrics

```javascript
// Prometheus metrics
const metrics = {
  // Business metrics
  ordersCreated: new Counter({ name: 'etsy_orders_total', labelNames: ['status'] }),
  orderValue: new Histogram({ name: 'etsy_order_value_dollars', buckets: [10, 25, 50, 100, 250, 500] }),
  productViews: new Counter({ name: 'etsy_product_views_total', labelNames: ['category'] }),

  // Performance metrics
  searchLatency: new Histogram({
    name: 'etsy_search_latency_seconds',
    labelNames: ['has_filters'],
    buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1]
  }),
  checkoutLatency: new Histogram({
    name: 'etsy_checkout_latency_seconds',
    buckets: [0.1, 0.2, 0.3, 0.5, 1, 2]
  }),

  // Cache metrics
  cacheHits: new Counter({ name: 'etsy_cache_hits_total', labelNames: ['type'] }),
  cacheMisses: new Counter({ name: 'etsy_cache_misses_total', labelNames: ['type'] }),

  // Inventory metrics
  reservationsCreated: new Counter({ name: 'etsy_reservations_created_total' }),
  reservationsExpired: new Counter({ name: 'etsy_reservations_expired_total' }),
  inventoryConflicts: new Counter({ name: 'etsy_inventory_conflicts_total' })
};
```

### Circuit Breaker for External Services

```javascript
const circuitConfigs = {
  elasticsearch: {
    timeout: 3000,
    errorThresholdPercentage: 50,
    resetTimeout: 15000,
    volumeThreshold: 10,
    fallback: async (query, filters) => {
      // Fall back to PostgreSQL ILIKE
      return db('products')
        .where('title', 'ILIKE', `%${query}%`)
        .limit(20);
    }
  },
  payment: {
    timeout: 5000,
    errorThresholdPercentage: 25,
    resetTimeout: 30000,
    volumeThreshold: 5,
    fallback: null // No fallback - fail checkout
  }
};
```

---

## Future Enhancements

### Backend Improvements

1. **Event Sourcing for Orders**: Audit trail for disputes
2. **Read Replicas**: Scale product reads
3. **Elasticsearch Cluster**: Multiple shards for larger catalog
4. **Background Jobs with RabbitMQ**: Order notifications, analytics
5. **Rate Limiting**: Per-seller API limits

---

## Summary

"This design addresses Etsy's unique backend challenges:

1. **Multi-Seller Checkout**: Atomic transaction creates separate orders per seller with inventory validation
2. **Synonym Search**: Elasticsearch with custom analyzer handles varied terminology
3. **Inventory Reservation**: 15-minute locks prevent overselling unique items
4. **Caching Strategy**: Stampede prevention and event-driven invalidation

The key backend insight is that unique inventory (qty=1) requires different handling than traditional e-commerce. Reservation timeouts balance conversion with fairness.

What aspects of the checkout transaction or search relevance would you like me to elaborate on?"
