# System Design Interview: Amazon - E-Commerce Platform

## Opening Statement

"Today I'll design an e-commerce platform like Amazon, focusing on the core challenges of inventory management that prevents overselling, product search with faceted filtering, and recommendation systems. The key technical problems are maintaining inventory consistency under high concurrency, building search that handles 100 million products with sub-second response times, and generating 'also bought' recommendations at scale."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Catalog**: Browse and search products across categories
2. **Cart**: Add items, manage quantities, save for later
3. **Checkout**: Purchase with payment processing
4. **Orders**: Track order status through fulfillment
5. **Recommendations**: Personalized product suggestions

### Non-Functional Requirements

- **Availability**: 99.99% for browsing (revenue impact of downtime is massive)
- **Consistency**: Strong consistency for inventory (absolutely no overselling)
- **Latency**: < 100ms for search results
- **Scale**: 100 million products, 1 million orders per day

### Scale Estimates

| Metric | Estimate |
|--------|----------|
| Products | 100M |
| Daily Orders | 1M |
| Peak Concurrent Users | 500K |
| Search QPS | 100K |
| Cart Read:Write Ratio | 10:1 |

---

## Step 2: High-Level Architecture (7 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Client Layer                                 │
│        React + Product pages + Cart + Checkout                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Catalog Service│    │ Cart Service  │    │ Order Service │
│               │    │               │    │               │
│ - Products    │    │ - Add/remove  │    │ - Checkout    │
│ - Categories  │    │ - Quantities  │    │ - Fulfillment │
│ - Search      │    │ - Inventory   │    │ - Tracking    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────┬─────────────┬─────────────┬───────────────────────┤
│ PostgreSQL  │Elasticsearch│   Valkey    │     Kafka             │
│ - Products  │ - Search    │ - Cart      │ - Order events        │
│ - Orders    │ - Facets    │ - Sessions  │ - Inventory updates   │
│ - Inventory │             │ - Cache     │                       │
└─────────────┴─────────────┴─────────────┴───────────────────────┘
```

### Why This Architecture?

**Separated Search**: Elasticsearch is purpose-built for full-text search with faceted filtering. PostgreSQL's full-text search can't match it at 100M products.

**Cart in Valkey**: Cart operations are frequent and latency-sensitive. Valkey handles high read/write throughput with millisecond latency.

**Event-Driven Inventory**: Kafka enables async inventory updates across systems while maintaining ordering guarantees.

---

## Step 3: Inventory Management Deep Dive (12 minutes)

This is the most critical component. Overselling means angry customers and operational chaos.

### The Reserved Inventory Model

```sql
CREATE TABLE inventory (
  product_id INTEGER REFERENCES products(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  quantity INTEGER DEFAULT 0,      -- Total physical stock
  reserved INTEGER DEFAULT 0,      -- Reserved by carts
  PRIMARY KEY (product_id, warehouse_id)
);

-- Available = quantity - reserved
```

**Why Reserved Model?**

When a user adds to cart, we don't decrement inventory immediately. Instead:
1. We increment `reserved`
2. If they checkout, we decrement both `quantity` and `reserved`
3. If they abandon cart, we just decrement `reserved`

This prevents the scenario where inventory goes negative due to abandoned carts.

### Add to Cart Flow

```javascript
async function addToCart(userId, productId, quantity) {
  return await db.transaction(async (trx) => {
    // 1. Check available inventory
    const product = await trx('inventory')
      .where({ product_id: productId })
      .first()

    const available = product.quantity - product.reserved
    if (available < quantity) {
      throw new Error('Insufficient inventory')
    }

    // 2. Reserve the inventory
    await trx('inventory')
      .where({ product_id: productId })
      .increment('reserved', quantity)

    // 3. Add to cart with expiration
    await trx('cart_items').insert({
      user_id: userId,
      product_id: productId,
      quantity,
      reserved_until: new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
    })
  })
}
```

### Background Job: Release Expired Reservations

```javascript
// Run every minute
async function releaseExpiredReservations() {
  const expired = await db('cart_items')
    .where('reserved_until', '<', new Date())
    .select('product_id', 'quantity')

  for (const item of expired) {
    await db('inventory')
      .where({ product_id: item.product_id })
      .decrement('reserved', item.quantity)
  }

  await db('cart_items')
    .where('reserved_until', '<', new Date())
    .delete()
}
```

### Flash Sale Problem

**Scenario**: 1000 units, 10000 concurrent buyers clicking "Add to Cart"

**Solution**: Optimistic locking with retry

```javascript
async function addToCartWithRetry(userId, productId, quantity, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await addToCart(userId, productId, quantity)
    } catch (error) {
      if (error.message === 'Insufficient inventory') {
        throw error // Don't retry if genuinely out of stock
      }
      if (i === retries - 1) throw error
      await sleep(Math.random() * 100) // Random backoff
    }
  }
}
```

For extreme cases (PS5 launches), consider queue-based approaches where users join a virtual queue.

---

## Step 4: Product Search Deep Dive (10 minutes)

### Elasticsearch Index Mapping

```json
{
  "mappings": {
    "properties": {
      "title": { "type": "text", "analyzer": "standard" },
      "description": { "type": "text" },
      "category": { "type": "keyword" },
      "brand": { "type": "keyword" },
      "price": { "type": "float" },
      "rating": { "type": "float" },
      "in_stock": { "type": "boolean" },
      "attributes": {
        "type": "nested",
        "properties": {
          "name": { "type": "keyword" },
          "value": { "type": "keyword" }
        }
      }
    }
  }
}
```

### Faceted Search Implementation

```javascript
async function searchProducts(query, filters) {
  const body = {
    query: {
      bool: {
        must: [
          { match: { title: query } }
        ],
        filter: [
          filters.category && { term: { category: filters.category } },
          filters.priceMin && { range: { price: { gte: filters.priceMin } } },
          filters.priceMax && { range: { price: { lte: filters.priceMax } } },
          filters.inStock && { term: { in_stock: true } },
          filters.brand && { terms: { brand: filters.brand } }
        ].filter(Boolean)
      }
    },
    aggs: {
      categories: { terms: { field: "category", size: 20 } },
      brands: { terms: { field: "brand", size: 20 } },
      price_ranges: {
        range: {
          field: "price",
          ranges: [
            { key: "Under $25", to: 25 },
            { key: "$25-$50", from: 25, to: 50 },
            { key: "$50-$100", from: 50, to: 100 },
            { key: "Over $100", from: 100 }
          ]
        }
      },
      avg_rating: { avg: { field: "rating" } }
    },
    size: 20,
    from: filters.page * 20
  }

  return await es.search({ index: 'products', body })
}
```

### Search Relevance Tuning

```javascript
// Boost factors for ranking
const searchQuery = {
  function_score: {
    query: { match: { title: query } },
    functions: [
      {
        filter: { term: { in_stock: true } },
        weight: 2  // Boost in-stock items
      },
      {
        field_value_factor: {
          field: "rating",
          factor: 1.2,
          modifier: "sqrt"  // Higher rating = higher rank
        }
      },
      {
        gauss: {
          created_at: {
            origin: "now",
            scale: "30d"  // Newer products get slight boost
          }
        }
      }
    ]
  }
}
```

---

## Step 5: Recommendations System (7 minutes)

### Collaborative Filtering: "Customers Also Bought"

```sql
-- Find products frequently bought together
SELECT o2.product_id, COUNT(*) as frequency
FROM order_items o1
JOIN order_items o2 ON o1.order_id = o2.order_id
WHERE o1.product_id = $1
  AND o2.product_id != $1
GROUP BY o2.product_id
ORDER BY frequency DESC
LIMIT 10;
```

### Precomputed Recommendations

Computing these on-demand would be too slow. We batch compute nightly:

```javascript
async function updateProductRecommendations() {
  const products = await db('products').select('id')

  for (const product of products) {
    const alsoBought = await db.raw(`
      SELECT o2.product_id, COUNT(*) as freq
      FROM order_items o1
      JOIN order_items o2 ON o1.order_id = o2.order_id
      WHERE o1.product_id = ?
        AND o2.product_id != ?
        AND o1.created_at > NOW() - INTERVAL '90 days'
      GROUP BY o2.product_id
      ORDER BY freq DESC
      LIMIT 20
    `, [product.id, product.id])

    // Cache in Valkey for 24 hours
    await redis.set(
      `recs:also_bought:${product.id}`,
      JSON.stringify(alsoBought.rows),
      'EX', 86400
    )
  }
}
```

### Personalized Homepage

```javascript
async function getPersonalizedRecommendations(userId) {
  // Get user's recent views and purchases
  const recentProducts = await getRecentUserActivity(userId)

  // Get recommendations for each
  const recommendations = []
  for (const productId of recentProducts) {
    const recs = await redis.get(`recs:also_bought:${productId}`)
    if (recs) {
      recommendations.push(...JSON.parse(recs))
    }
  }

  // Deduplicate and filter already purchased
  const purchased = await getUserPurchases(userId)
  return recommendations
    .filter(r => !purchased.includes(r.product_id))
    .slice(0, 20)
}
```

---

## Step 6: Database Schema (3 minutes)

```sql
-- Products
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER REFERENCES sellers(id),
  title VARCHAR(500) NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES categories(id),
  price DECIMAL(10, 2) NOT NULL,
  images TEXT[],
  attributes JSONB,
  rating DECIMAL(2, 1),
  review_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Inventory per warehouse
CREATE TABLE inventory (
  product_id INTEGER REFERENCES products(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  quantity INTEGER DEFAULT 0,
  reserved INTEGER DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id)
);

-- Shopping Cart
CREATE TABLE cart_items (
  user_id INTEGER REFERENCES users(id),
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER DEFAULT 1,
  reserved_until TIMESTAMP,
  added_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending',
  total DECIMAL(10, 2),
  shipping_address JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE order_items (
  order_id INTEGER REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER,
  price DECIMAL(10, 2),
  PRIMARY KEY (order_id, product_id)
);
```

---

## Step 7: Key Design Decisions & Trade-offs (5 minutes)

### Decision 1: Reserved Inventory Model

**Alternative**: Decrement inventory immediately on add-to-cart

**Why Reserved is Better**:
- Abandoned carts don't permanently lock inventory
- Automatic cleanup via expiration
- Clear audit trail of what's reserved vs. sold

**Trade-off**: Slight complexity in checkout (must handle reservation expiry)

### Decision 2: Elasticsearch for Search

**Alternative**: PostgreSQL full-text search

**Why Elasticsearch**:
- Purpose-built for search with relevance scoring
- Native faceted filtering (aggregations)
- Horizontal scaling for 100M products
- Sub-100ms response times

**Trade-off**: Additional system to maintain, eventual consistency with PostgreSQL

### Decision 3: Batch Recommendations

**Alternative**: Real-time ML model

**Why Batch**:
- "Also bought" doesn't need real-time freshness
- Dramatically simpler to implement
- Cache-friendly (24-hour TTL)

**Trade-off**: Recommendations won't include today's purchases until tomorrow

---

## Step 8: Handling Consistency (3 minutes)

### Inventory: Strong Consistency Required

```javascript
async function checkout(userId, cartId) {
  return await db.transaction(async (trx) => {
    const cartItems = await trx('cart_items')
      .where({ user_id: userId })
      .forUpdate() // Lock rows

    for (const item of cartItems) {
      // Verify still available (someone else might have bought)
      const inv = await trx('inventory')
        .where({ product_id: item.product_id })
        .first()

      if (inv.quantity < item.quantity) {
        throw new Error(`${item.product_id} no longer available`)
      }

      // Decrement both quantity and reserved
      await trx('inventory')
        .where({ product_id: item.product_id })
        .decrement('quantity', item.quantity)
        .decrement('reserved', item.quantity)
    }

    // Create order...
  })
}
```

### Search: Eventual Consistency Acceptable

Product updates flow to Elasticsearch asynchronously. A 5-second delay in search results is acceptable because:
- Product pages show real-time inventory from PostgreSQL
- Users understand search results are slightly stale

---

## Closing Summary

I've designed an e-commerce platform with three core systems:

1. **Inventory Management**: Reserved inventory model with database transactions preventing overselling, background cleanup of expired reservations, and optimistic locking for high-concurrency scenarios

2. **Product Search**: Elasticsearch-powered full-text search with faceted filtering, relevance boosting based on stock status and ratings, eventually consistent with source of truth

3. **Recommendations**: Batch-computed "also bought" using collaborative filtering, cached in Valkey for fast retrieval, refreshed nightly

**Key trade-offs:**
- Reserved vs. immediate decrement (flexibility vs. simplicity)
- Elasticsearch vs. PostgreSQL FTS (performance vs. operational complexity)
- Batch vs. real-time recommendations (simplicity vs. freshness)

**What would I add with more time?**
- Fraud detection on checkout
- Multi-warehouse inventory optimization
- Real-time personalization using recent browsing behavior
