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

### Cart Items Schema

```
┌─────────────────────────────────────────────────────────────────┐
│                         cart_items                               │
├─────────────────────────────────────────────────────────────────┤
│  id              │ SERIAL PRIMARY KEY                           │
│  user_id         │ INTEGER → users(id)                          │
│  product_id      │ INTEGER → products(id)                       │
│  quantity        │ INTEGER DEFAULT 1                            │
│  reserved_until  │ TIMESTAMP (for unique items)                 │
│  added_at        │ TIMESTAMP DEFAULT NOW()                      │
├─────────────────────────────────────────────────────────────────┤
│  UNIQUE(user_id, product_id)                                    │
│  INDEX: idx_cart_user ON cart_items(user_id)                    │
│  INDEX: idx_cart_product ON cart_items(product_id)              │
│  INDEX: idx_cart_reservation ON cart_items(reserved_until)      │
│         WHERE reserved_until IS NOT NULL                        │
└─────────────────────────────────────────────────────────────────┘
```

### Checkout Transaction Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                    Checkout Transaction                             │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 1. VALIDATION PHASE (Before Transaction)                    │   │
│  │    • Loop through each shop in cart                         │   │
│  │    • For each item: check available >= quantity             │   │
│  │    • Throw error if any item unavailable                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 2. BEGIN TRANSACTION                                         │   │
│  │    FOR EACH SHOP:                                            │   │
│  │      a. Insert order header (buyer_id, shop_id, totals)      │   │
│  │      b. For each item:                                       │   │
│  │         - Insert order_items with price_at_purchase          │   │
│  │         - Atomic inventory decrement with WHERE qty >= qty   │   │
│  │         - Throw if update returns 0 rows                     │   │
│  │      c. Increment shop.sales_count                           │   │
│  │    Clear cart_items for user                                 │   │
│  │ COMMIT TRANSACTION                                           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 3. POST-TRANSACTION                                          │   │
│  │    • Process single payment for total                        │   │
│  │    • Queue async notifications to sellers (non-blocking)     │   │
│  │    • Return array of created orders                          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

**Key Operations in Checkout:**
- Validate all items available before starting transaction
- Create one order per shop with line items
- Atomic inventory decrement: `WHERE quantity >= requested_quantity`
- Transaction rolls back if any decrement fails (returns 0 rows)
- Payment processed after successful transaction
- Seller notifications queued asynchronously

### Idempotency Middleware Flow

```
┌────────────────────────────────────────────────────────────────────┐
│               Idempotency Middleware for Checkout                   │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Request with Idempotency-Key header                              │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  Check Redis: idempotency:{prefix}:{key}                   │   │
│   └────────────────────────────────────────────────────────────┘   │
│                    │                                                │
│          ┌────────┴────────┬─────────────────┐                     │
│          ▼                 ▼                  ▼                     │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐        │
│   │ COMPLETED    │  │ PROCESSING   │  │ NOT FOUND        │        │
│   │              │  │              │  │                  │        │
│   │ Return cached│  │ Return 409   │  │ Set PROCESSING   │        │
│   │ response     │  │ "In progress"│  │ Continue request │        │
│   └──────────────┘  └──────────────┘  └────────┬─────────┘        │
│                                                 │                   │
│                                                 ▼                   │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  On Response: Cache {state: COMPLETED, statusCode, result} │   │
│   │  TTL: 24 hours                                              │   │
│   └────────────────────────────────────────────────────────────┘   │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive 2: Elasticsearch for Non-Standardized Products

"Handmade products are described inconsistently. 'Handmade leather wallet' and 'hand-crafted leather billfold' are the same product category but use different words."

### Custom Analyzer Configuration

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Etsy Elasticsearch Index                          │
├─────────────────────────────────────────────────────────────────────┤
│  ANALYZER: etsy_analyzer                                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  tokenizer: standard                                          │  │
│  │  filters: [lowercase, synonym_filter, stemmer]                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  SYNONYM FILTER MAPPINGS:                                            │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  handmade, handcrafted, artisan, homemade, hand-made          │  │
│  │  vintage, antique, retro, old, classic, secondhand            │  │
│  │  wallet, billfold, purse, cardholder, pocketbook              │  │
│  │  necklace, pendant, chain, choker, lariat                     │  │
│  │  earrings, studs, drops, hoops, dangles                       │  │
│  │  ring, band, signet, wedding band                             │  │
│  │  leather, genuine leather, real leather, cowhide, full grain  │  │
│  │  silver, sterling, 925, sterling silver                       │  │
│  │  gold, 14k, 18k, gold filled, gold plated                     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  FIELD MAPPINGS:                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  title           │ text, etsy_analyzer, boost: 3              │  │
│  │  description     │ text, etsy_analyzer                        │  │
│  │  tags            │ keyword (array)                            │  │
│  │  category        │ keyword                                    │  │
│  │  price           │ float                                      │  │
│  │  shop_id         │ keyword                                    │  │
│  │  shop_rating     │ float                                      │  │
│  │  shop_sales_count│ integer                                    │  │
│  │  is_vintage      │ boolean                                    │  │
│  │  quantity        │ integer                                    │  │
│  │  created_at      │ date                                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Search Query Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Search Query Components                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  MUST CLAUSE (Main Query):                                           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  multi_match:                                                 │  │
│  │    query: user_input                                          │  │
│  │    fields: [title^3, description, tags^2]                     │  │
│  │    fuzziness: AUTO                                            │  │
│  │    prefix_length: 2                                           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  FILTER CLAUSES (Applied conditionally):                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  • term: category (if specified)                              │  │
│  │  • range: price >= priceMin (if specified)                    │  │
│  │  • range: price <= priceMax (if specified)                    │  │
│  │  • term: is_vintage (if specified)                            │  │
│  │  • range: quantity > 0 (always - only in-stock items)         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  FUNCTION SCORE BOOSTS:                                              │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  1. Shop Rating Boost                                         │  │
│  │     field_value_factor: shop_rating                           │  │
│  │     factor: 1.5, modifier: sqrt, missing: 3.0                 │  │
│  │                                                               │  │
│  │  2. Sales Count Boost (trust signal)                          │  │
│  │     field_value_factor: shop_sales_count                      │  │
│  │     factor: 1.2, modifier: log1p, missing: 0                  │  │
│  │                                                               │  │
│  │  3. Recency Boost (new listings)                              │  │
│  │     gauss decay on created_at                                 │  │
│  │     origin: now, scale: 30d, decay: 0.5                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  AGGREGATIONS (Faceted search):                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  categories: terms on category field (size: 20)               │  │
│  │  price_ranges: buckets [Under $25, $25-$50, $50-$100, $100+]  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Search Result Caching Strategy

```
┌────────────────────────────────────────────────────────────────────┐
│                    Search Caching Flow                              │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Search Request (query, filters)                                   │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  Generate cache key: search:{hash(query + filters)}        │   │
│   └────────────────────────────────────────────────────────────┘   │
│                    │                                                │
│                    ▼                                                │
│          ┌────────────────────┐                                     │
│          │  Check Redis cache │                                     │
│          └─────────┬──────────┘                                     │
│                    │                                                │
│          ┌────────┴────────┐                                        │
│          ▼                 ▼                                        │
│    ┌──────────┐     ┌──────────────────────────────────────────┐   │
│    │ HIT      │     │ MISS                                     │   │
│    │          │     │                                          │   │
│    │ Increment│     │ Increment metrics.cacheMisses            │   │
│    │ cacheHits│     │ Query Elasticsearch                      │   │
│    │          │     │ Cache result with TTL: 120s (2 min)      │   │
│    │ Return   │     │ Return results                           │   │
│    │ cached   │     └──────────────────────────────────────────┘   │
│    └──────────┘                                                     │
│                                                                     │
│   "2-minute TTL balances freshness vs Elasticsearch load"           │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive 3: One-of-a-Kind Inventory Management

"Most Etsy items are unique. When quantity is 1, we need to prevent overselling while providing good UX."

### Products Schema with Quantity Tracking

```
┌─────────────────────────────────────────────────────────────────┐
│                          products                                │
├─────────────────────────────────────────────────────────────────┤
│  id              │ SERIAL PRIMARY KEY                           │
│  shop_id         │ INTEGER → shops(id)                          │
│  title           │ VARCHAR(200) NOT NULL                        │
│  description     │ TEXT                                         │
│  price           │ DECIMAL(10, 2) NOT NULL                      │
│  quantity        │ INTEGER DEFAULT 1 (often 1 for handmade)     │
│  category_id     │ INTEGER → categories(id)                     │
│  tags            │ TEXT[]                                       │
│  images          │ TEXT[]                                       │
│  is_vintage      │ BOOLEAN DEFAULT FALSE                        │
│  created_at      │ TIMESTAMP DEFAULT NOW()                      │
│  updated_at      │ TIMESTAMP DEFAULT NOW()                      │
├─────────────────────────────────────────────────────────────────┤
│  INDEX: idx_products_quantity ON products(quantity)             │
│         WHERE quantity <= 3 (partial index for low-inventory)   │
└─────────────────────────────────────────────────────────────────┘
```

### Add to Cart with Reservation Logic

```
┌────────────────────────────────────────────────────────────────────┐
│                    Add to Cart Flow                                 │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   addToCart(userId, productId, quantity)                           │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  1. Fetch product from database                            │   │
│   │     If not found: throw NotFoundError                      │   │
│   │     If quantity < requested: throw ConflictError           │   │
│   └────────────────────────────────────────────────────────────┘   │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  2. For unique items (qty = 1):                            │   │
│   │     Check for existing reservation by OTHER users          │   │
│   │     WHERE reserved_until > NOW() AND user_id != current    │   │
│   │                                                            │   │
│   │     If reserved: return {                                  │   │
│   │       success: false,                                      │   │
│   │       message: "Someone else is checking out...",          │   │
│   │       reservedUntil: timestamp                             │   │
│   │     }                                                      │   │
│   └────────────────────────────────────────────────────────────┘   │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  3. Upsert cart item:                                      │   │
│   │     • For qty=1: set reserved_until = NOW() + 15 minutes   │   │
│   │     • For qty>1: reserved_until = NULL                     │   │
│   │     • ON CONFLICT (user_id, product_id): merge quantity    │   │
│   └────────────────────────────────────────────────────────────┘   │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  4. Invalidate cart cache: redis.del(cart:{userId})        │   │
│   │     Return { success: true, reservedUntil }                │   │
│   └────────────────────────────────────────────────────────────┘   │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### Reservation Cleanup Worker

```
┌────────────────────────────────────────────────────────────────────┐
│              Reservation Cleanup (Runs Every Minute)                │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   CRON: * * * * * (every minute)                                   │
│                                                                     │
│   DELETE FROM cart_items                                           │
│   WHERE reserved_until < NOW()                                     │
│     AND reserved_until IS NOT NULL                                 │
│   RETURNING *                                                      │
│                                                                     │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  On completion:                                            │   │
│   │  • Log: "Cleaned up {count} expired reservations"          │   │
│   │  • Increment metrics.reservationsExpired by count          │   │
│   └────────────────────────────────────────────────────────────┘   │
│                                                                     │
│   "15-minute timeout balances conversion with fairness"            │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive 4: Caching Strategy for Popular Listings

"Popular products receive disproportionate traffic. A trending item might get thousands of views while most products get a handful."

### Cache Configuration by Data Type

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cache TTL Configuration                       │
├──────────────┬─────────────────────┬────────────────────────────┤
│  Data Type   │  TTL                │  Cache Key Pattern         │
├──────────────┼─────────────────────┼────────────────────────────┤
│  product     │  5 minutes (300s)   │  product:{id}              │
│  shop        │  10 minutes (600s)  │  shop:{id}                 │
│  cart        │  30 minutes (1800s) │  cart:{userId}             │
│  search      │  2 minutes (120s)   │  search:{hash}             │
│  trending    │  15 minutes (900s)  │  trending:{category}       │
│              │  (expensive aggreg) │                            │
└──────────────┴─────────────────────┴────────────────────────────┘
```

### Cache-Aside with Stampede Prevention

```
┌────────────────────────────────────────────────────────────────────┐
│            getProductWithCache - Thundering Herd Prevention         │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   getProductWithCache(productId)                                   │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  1. Check Redis: product:{productId}                       │   │
│   └────────────────────────────────────────────────────────────┘   │
│                    │                                                │
│          ┌────────┴────────┐                                        │
│          ▼                 ▼                                        │
│    ┌──────────┐     ┌──────────────────────────────────────────┐   │
│    │ HIT      │     │ MISS                                     │   │
│    │          │     │                                          │   │
│    │ Increment│     │ 2. Try to acquire lock:                  │   │
│    │ cacheHits│     │    SET lock:product:{id} 1 EX 5 NX       │   │
│    │          │     │                                          │   │
│    │ Return   │     │    ┌──────────┬────────────────────┐     │   │
│    │ cached   │     │    ▼          ▼                    │     │   │
│    └──────────┘     │  ACQUIRED   NOT ACQUIRED           │     │   │
│                     │    │          │                    │     │   │
│                     │    │          │ Wait 50ms          │     │   │
│                     │    │          │ Retry recursively  │     │   │
│                     │    │          └────────────────────┘     │   │
│                     │    ▼                                     │   │
│                     │  3. Query PostgreSQL:                    │   │
│                     │     products JOIN shops                  │   │
│                     │     SELECT products.*, shops.name,       │   │
│                     │            shops.rating                  │   │
│                     │                                          │   │
│                     │  4. Cache result with TTL: 300s          │   │
│                     │                                          │   │
│                     │  5. Delete lock                          │   │
│                     │                                          │   │
│                     │  Return product                          │   │
│                     └──────────────────────────────────────────┘   │
│                                                                     │
│   "Lock prevents multiple DB queries when cache expires"            │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### Cache Invalidation on Updates

```
┌────────────────────────────────────────────────────────────────────┐
│              updateProduct - Cache Invalidation                     │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   updateProduct(productId, updates)                                │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  1. UPDATE products SET {...updates, updated_at: NOW()}    │   │
│   │     WHERE id = productId                                   │   │
│   └────────────────────────────────────────────────────────────┘   │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  2. Invalidate caches (parallel):                          │   │
│   │     • DEL product:{productId}                              │   │
│   │     • DEL shop:{shopId}:products                           │   │
│   │     • DEL search:* (all search caches)                     │   │
│   └────────────────────────────────────────────────────────────┘   │
│                    │                                                │
│                    ▼                                                │
│   ┌────────────────────────────────────────────────────────────┐   │
│   │  3. Update Elasticsearch index:                            │   │
│   │     POST /products/_update/{productId}                     │   │
│   │     body: { doc: updates }                                 │   │
│   └────────────────────────────────────────────────────────────┘   │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive 5: Database Schema

### Complete Entity Relationships

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           Database Schema                                  │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐                │
│  │   users     │      │   shops     │      │ categories  │                │
│  ├─────────────┤      ├─────────────┤      ├─────────────┤                │
│  │ id (PK)     │──┐   │ id (PK)     │      │ id (PK)     │                │
│  │ email       │  │   │ owner_id ───│──────│ name        │                │
│  │ password    │  │   │ name        │      │ parent_id   │────┐           │
│  │ display_name│  │   │ description │      │ slug        │    │ (self)    │
│  │ created_at  │  │   │ banner      │      └─────────────┘    │           │
│  └─────────────┘  │   │ logo        │           ▲             │           │
│        │          │   │ rating      │           │             │           │
│        │          └──▶│ sales_count │           │             │           │
│        │              │ shipping    │           │             │           │
│        │              │ created_at  │           │             │           │
│        │              └──────┬──────┘           │             │           │
│        │                     │                  │             │           │
│        │                     ▼                  │             │           │
│        │              ┌─────────────┐           │             │           │
│        │              │  products   │           │             │           │
│        │              ├─────────────┤           │             │           │
│        │              │ id (PK)     │           │             │           │
│        │              │ shop_id ────│───────────│             │           │
│        │              │ title       │           │             │           │
│        │              │ description │           │             │           │
│        │              │ price       │           │             │           │
│        │              │ quantity    │           │             │           │
│        │              │ category_id │───────────┘             │           │
│        │              │ tags[]      │                         │           │
│        │              │ images[]    │                         │           │
│        │              │ is_vintage  │                         │           │
│        │              │ created_at  │                         │           │
│        │              │ updated_at  │                         │           │
│        │              └──────┬──────┘                                     │
│        │                     │                                            │
│        ▼                     ▼                                            │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐               │
│  │   orders    │      │ order_items │      │  favorites  │               │
│  ├─────────────┤      ├─────────────┤      ├─────────────┤               │
│  │ id (PK)     │◀─────│ order_id    │      │ user_id (PK)│               │
│  │ buyer_id    │      │ product_id  │      │ fav_type(PK)│               │
│  │ shop_id     │      │ quantity    │      │ fav_id (PK) │               │
│  │ subtotal    │      │ price_at_   │      │ created_at  │               │
│  │ shipping    │      │   purchase  │      └─────────────┘               │
│  │ total       │      └─────────────┘                                    │
│  │ status      │                                                         │
│  │ tracking    │      ┌─────────────┐                                    │
│  │ created_at  │      │  reviews    │                                    │
│  │ updated_at  │      ├─────────────┤                                    │
│  └─────────────┘      │ id (PK)     │                                    │
│                       │ order_id ───│───── (UNIQUE, 1 review per order)  │
│                       │ reviewer_id │                                    │
│                       │ shop_id     │                                    │
│                       │ rating (1-5)│                                    │
│                       │ comment     │                                    │
│                       │ created_at  │                                    │
│                       └─────────────┘                                    │
│                                                                           │
│  KEY INDEXES:                                                             │
│  • products: (shop_id), (category_id), (price), (created_at DESC)        │
│  • orders: (buyer_id), (shop_id), (status)                               │
│  • favorites: (user_id), (favoritable_type, favoritable_id)              │
│  • reviews: (shop_id)                                                    │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
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

### Key Metrics Categories

```
┌────────────────────────────────────────────────────────────────────┐
│                    Prometheus Metrics                               │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  BUSINESS METRICS:                                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  etsy_orders_total (Counter, labels: [status])               │  │
│  │  etsy_order_value_dollars (Histogram)                        │  │
│  │    buckets: [10, 25, 50, 100, 250, 500]                      │  │
│  │  etsy_product_views_total (Counter, labels: [category])      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  PERFORMANCE METRICS:                                               │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  etsy_search_latency_seconds (Histogram, labels: [filters])  │  │
│  │    buckets: [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1]              │  │
│  │  etsy_checkout_latency_seconds (Histogram)                   │  │
│  │    buckets: [0.1, 0.2, 0.3, 0.5, 1, 2]                       │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  CACHE METRICS:                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  etsy_cache_hits_total (Counter, labels: [type])             │  │
│  │  etsy_cache_misses_total (Counter, labels: [type])           │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  INVENTORY METRICS:                                                 │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  etsy_reservations_created_total (Counter)                   │  │
│  │  etsy_reservations_expired_total (Counter)                   │  │
│  │  etsy_inventory_conflicts_total (Counter)                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### Circuit Breaker Configuration

```
┌────────────────────────────────────────────────────────────────────┐
│                    Circuit Breaker Configs                          │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ELASTICSEARCH:                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  timeout: 3000ms                                             │  │
│  │  errorThresholdPercentage: 50%                               │  │
│  │  resetTimeout: 15000ms                                       │  │
│  │  volumeThreshold: 10 requests                                │  │
│  │  fallback: PostgreSQL ILIKE search (degraded experience)     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  PAYMENT PROVIDER:                                                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  timeout: 5000ms                                             │  │
│  │  errorThresholdPercentage: 25%                               │  │
│  │  resetTimeout: 30000ms                                       │  │
│  │  volumeThreshold: 5 requests                                 │  │
│  │  fallback: null (checkout fails - no fallback for payments)  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
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
