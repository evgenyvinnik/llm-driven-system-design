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

1. **Catalog**: Browse and search products
2. **Cart**: Add items, manage quantities
3. **Checkout**: Purchase with payment
4. **Orders**: Track order status
5. **Recommendations**: Personalized suggestions

### Non-Functional Requirements

- **Availability**: 99.99% for browsing
- **Consistency**: Strong for inventory (no overselling)
- **Latency**: < 100ms for search
- **Scale**: 100M products, 1M orders/day

---

## High-Level Architecture

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
│ - Inventory │             │ - Inventory │                       │
└─────────────┴─────────────┴─────────────┴───────────────────────┘
```

---

## Core Components

### 1. Inventory Management

**Challenge**: Prevent overselling during high-concurrency checkout

**Approach: Optimistic Locking with Reserved Inventory**
```javascript
async function addToCart(userId, productId, quantity) {
  return await db.transaction(async (trx) => {
    // Check available inventory
    const product = await trx('inventory')
      .where({ product_id: productId })
      .first()

    const available = product.quantity - product.reserved
    if (available < quantity) {
      throw new Error('Insufficient inventory')
    }

    // Reserve inventory
    await trx('inventory')
      .where({ product_id: productId })
      .increment('reserved', quantity)

    // Add to cart with expiry
    await trx('cart_items').insert({
      user_id: userId,
      product_id: productId,
      quantity,
      reserved_until: new Date(Date.now() + 30 * 60 * 1000) // 30 min
    })
  })
}
```

**Background Job: Release Expired Reservations**
```javascript
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

### 2. Product Search

**Elasticsearch Index:**
```json
{
  "mappings": {
    "properties": {
      "title": { "type": "text", "analyzer": "standard" },
      "description": { "type": "text" },
      "category": { "type": "keyword" },
      "brand": { "type": "keyword" },
      "price": { "type": "float" },
      "attributes": { "type": "nested" },
      "rating": { "type": "float" },
      "in_stock": { "type": "boolean" }
    }
  }
}
```

**Faceted Search Query:**
```javascript
async function searchProducts(query, filters, facets) {
  const body = {
    query: {
      bool: {
        must: [
          { match: { title: query } }
        ],
        filter: [
          filters.category && { term: { category: filters.category } },
          filters.priceMin && { range: { price: { gte: filters.priceMin } } },
          filters.inStock && { term: { in_stock: true } }
        ].filter(Boolean)
      }
    },
    aggs: {
      categories: { terms: { field: "category" } },
      brands: { terms: { field: "brand" } },
      price_ranges: {
        range: {
          field: "price",
          ranges: [
            { to: 25 },
            { from: 25, to: 50 },
            { from: 50, to: 100 },
            { from: 100 }
          ]
        }
      }
    }
  }

  return await es.search({ index: 'products', body })
}
```

### 3. Recommendations

**Collaborative Filtering: "Also Bought"**
```sql
-- Find products frequently bought together
SELECT p2.product_id, COUNT(*) as frequency
FROM order_items o1
JOIN order_items o2 ON o1.order_id = o2.order_id
WHERE o1.product_id = $1
  AND o2.product_id != $1
GROUP BY p2.product_id
ORDER BY frequency DESC
LIMIT 10;
```

**Precomputed Recommendations:**
```javascript
// Batch job: Update recommendations nightly
async function updateProductRecommendations() {
  const products = await db('products').select('id')

  for (const product of products) {
    const alsoBought = await db.raw(`
      SELECT o2.product_id, COUNT(*) as freq
      FROM order_items o1
      JOIN order_items o2 ON o1.order_id = o2.order_id
      WHERE o1.product_id = ?
        AND o2.product_id != ?
      GROUP BY o2.product_id
      ORDER BY freq DESC
      LIMIT 20
    `, [product.id, product.id])

    await redis.set(
      `recs:${product.id}`,
      JSON.stringify(alsoBought.rows),
      'EX', 86400
    )
  }
}
```

---

## Database Schema

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

-- Inventory (per warehouse)
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

## Key Design Decisions

### 1. Reserved Inventory Model

**Decision**: Track reserved quantity separately from available

**Rationale**:
- Prevents overselling during checkout
- Allows cart expiration without order
- Clear separation of concerns

### 2. Elasticsearch for Search

**Decision**: Separate search index from PostgreSQL

**Rationale**:
- Full-text search with relevance scoring
- Faceted filtering (aggregations)
- Better performance than LIKE queries

### 3. Precomputed Recommendations

**Decision**: Batch compute "also bought" nightly

**Rationale**:
- Expensive to compute on-demand
- Recommendations don't need real-time freshness
- Cache in Valkey for fast retrieval

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Inventory | Reserved model | Decrement on add | Prevent overselling |
| Search | Elasticsearch | PostgreSQL FTS | Performance, facets |
| Recommendations | Batch precompute | Real-time ML | Simplicity, cost |
| Cart | Database + cache | Cache only | Durability |
