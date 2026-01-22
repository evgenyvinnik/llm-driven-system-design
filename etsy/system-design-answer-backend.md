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

| Component | Purpose | Why This Choice |
|-----------|---------|-----------------|
| PostgreSQL | Shops, products, orders, users | ACID for inventory, relational integrity |
| Elasticsearch | Product search with synonyms | Fuzzy matching, synonym expansion |
| Redis | Session, cache, cart | Low-latency reads, cart state |

---

## Deep Dive 1: Multi-Seller Checkout with Transaction Safety

"The checkout flow is the most critical backend operation. A single cart can have items from multiple sellers, but we create separate orders per seller."

### Why Split Orders by Seller?

1. **Independent Fulfillment**: Each seller ships from their location
2. **Different Timelines**: Handmade items may have varying production times
3. **Dispute Resolution**: Issues are per-seller, not per-cart
4. **Payout Processing**: Sellers receive funds independently

### Checkout Transaction Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                    Checkout Transaction                             │
├────────────────────────────────────────────────────────────────────┤
│  1. VALIDATION (Before Transaction)                                 │
│     • Loop through each shop in cart                                │
│     • For each item: check available >= quantity                    │
│     • Throw error if any item unavailable                           │
├────────────────────────────────────────────────────────────────────┤
│  2. BEGIN TRANSACTION                                               │
│     FOR EACH SHOP:                                                  │
│       a. Insert order header (buyer_id, shop_id, totals)            │
│       b. Insert order_items with price_at_purchase                  │
│       c. Atomic decrement: WHERE quantity >= requested_quantity     │
│       d. Throw if update returns 0 rows                             │
│       e. Increment shop.sales_count                                 │
│     Clear cart_items for user                                       │
│  COMMIT TRANSACTION                                                 │
├────────────────────────────────────────────────────────────────────┤
│  3. POST-TRANSACTION                                                │
│     • Process single payment for total                              │
│     • Queue async notifications to sellers                          │
│     • Return array of created orders                                │
└────────────────────────────────────────────────────────────────────┘
```

### Idempotency Middleware

```
┌────────────────────────────────────────────────────────────────────┐
│               Idempotency Flow for Checkout                         │
├────────────────────────────────────────────────────────────────────┤
│  Request with Idempotency-Key header                                │
│         │                                                           │
│         ▼                                                           │
│  Check Redis: idempotency:{prefix}:{key}                            │
│         │                                                           │
│    ┌────┴────┬──────────────┬────────────────┐                      │
│    ▼         ▼              ▼                ▼                      │
│ COMPLETED  PROCESSING    NOT FOUND                                  │
│    │          │             │                                       │
│ Return     Return 409    Set PROCESSING ──▶ Execute ──▶ Cache result│
│ cached     "In progress"              TTL: 24 hours                 │
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
│  tokenizer: standard | filters: [lowercase, synonym_filter, stemmer] │
│                                                                      │
│  SYNONYM MAPPINGS:                                                   │
│  • handmade, handcrafted, artisan, homemade, hand-made               │
│  • vintage, antique, retro, old, classic, secondhand                 │
│  • wallet, billfold, purse, cardholder, pocketbook                   │
│  • necklace, pendant, chain, choker, lariat                          │
│  • leather, genuine leather, real leather, cowhide, full grain       │
│  • silver, sterling, 925, sterling silver                            │
│  • gold, 14k, 18k, gold filled, gold plated                          │
│                                                                      │
│  FIELD MAPPINGS:                                                     │
│  • title: text, etsy_analyzer, boost: 3                              │
│  • description: text, etsy_analyzer                                  │
│  • tags: keyword (array)                                             │
│  • category: keyword                                                 │
│  • price, shop_rating, shop_sales_count, quantity, created_at        │
└─────────────────────────────────────────────────────────────────────┘
```

### Search Query Structure

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Search Query Components                          │
├─────────────────────────────────────────────────────────────────────┤
│  MUST: multi_match (query: user_input, fields: [title^3, desc, tags^2])│
│        fuzziness: AUTO, prefix_length: 2                             │
│                                                                      │
│  FILTERS: category, price range, is_vintage, quantity > 0           │
│                                                                      │
│  FUNCTION SCORE BOOSTS:                                              │
│  1. Shop Rating: field_value_factor: shop_rating (factor: 1.5, sqrt) │
│  2. Sales Count: field_value_factor: shop_sales_count (factor: 1.2)  │
│  3. Recency: gauss decay on created_at (scale: 30d, decay: 0.5)      │
│                                                                      │
│  AGGREGATIONS:                                                       │
│  • categories: terms (size: 20)                                      │
│  • price_ranges: buckets [Under $25, $25-$50, $50-$100, $100+]       │
└─────────────────────────────────────────────────────────────────────┘
```

### Search Caching (2-minute TTL)

- Generate cache key: `search:{hash(query + filters)}`
- Cache HIT: Return cached results, increment cacheHits
- Cache MISS: Query Elasticsearch, cache with TTL: 120s

---

## Deep Dive 3: One-of-a-Kind Inventory Management

"Most Etsy items are unique. When quantity is 1, we need to prevent overselling while providing good UX."

### Add to Cart with Reservation

```
┌────────────────────────────────────────────────────────────────────┐
│                    Add to Cart Flow                                 │
├────────────────────────────────────────────────────────────────────┤
│  addToCart(userId, productId, quantity)                             │
│         │                                                           │
│         ▼                                                           │
│  1. Fetch product, validate quantity available                      │
│         │                                                           │
│         ▼                                                           │
│  2. For unique items (qty = 1):                                     │
│     Check existing reservation by OTHER users                       │
│     WHERE reserved_until > NOW() AND user_id != current             │
│     If reserved: return { success: false, reservedUntil }           │
│         │                                                           │
│         ▼                                                           │
│  3. Upsert cart item:                                               │
│     • For qty=1: set reserved_until = NOW() + 15 minutes            │
│     • For qty>1: reserved_until = NULL                              │
│         │                                                           │
│         ▼                                                           │
│  4. Invalidate cart cache, return { success: true }                 │
└────────────────────────────────────────────────────────────────────┘
```

### Reservation Cleanup Worker (Every Minute)

```
DELETE FROM cart_items
WHERE reserved_until < NOW() AND reserved_until IS NOT NULL
RETURNING *

"15-minute timeout balances conversion with fairness"
```

---

## Deep Dive 4: Caching Strategy for Popular Listings

"Popular products receive disproportionate traffic. A trending item might get thousands of views while most products get a handful."

### Cache TTL Configuration

| Data Type | TTL | Cache Key Pattern |
|-----------|-----|-------------------|
| product | 5 min | product:{id} |
| shop | 10 min | shop:{id} |
| cart | 30 min | cart:{userId} |
| search | 2 min | search:{hash} |
| trending | 15 min | trending:{category} |

### Cache-Aside with Stampede Prevention

```
┌────────────────────────────────────────────────────────────────────┐
│            getProductWithCache - Thundering Herd Prevention         │
├────────────────────────────────────────────────────────────────────┤
│  1. Check Redis: product:{productId}                                │
│         │                                                           │
│    ┌────┴────┐                                                      │
│    ▼         ▼                                                      │
│  HIT      MISS                                                      │
│    │         │                                                      │
│ Return    2. Try acquire lock: SET lock:product:{id} 1 EX 5 NX      │
│ cached       │                                                      │
│         ┌────┴────┐                                                 │
│      ACQUIRED  NOT ACQUIRED                                         │
│         │         │                                                 │
│      Query DB   Wait 50ms, retry                                    │
│      Cache TTL: 300s                                                │
│      Delete lock                                                    │
│                                                                     │
│  "Lock prevents multiple DB queries when cache expires"             │
└────────────────────────────────────────────────────────────────────┘
```

### Cache Invalidation on Updates

1. UPDATE products SET {...updates}
2. Parallel invalidation: DEL product:{id}, shop:{shopId}:products, search:*
3. Update Elasticsearch index

---

## Deep Dive 5: Database Schema

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           Database Schema                                  │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  users                    shops                     categories             │
│  ┌───────────────┐        ┌─────────────────┐       ┌────────────────┐    │
│  │ id (PK)       │───┐    │ id (PK)         │       │ id (PK)        │    │
│  │ email, pass   │   │    │ owner_id (FK)───│───────│ name, parent_id│    │
│  │ display_name  │   │    │ name, rating    │       └────────────────┘    │
│  └───────────────┘   │    │ sales_count     │              ▲              │
│                      └───▶│ shipping_policy │              │              │
│                           └────────┬────────┘              │              │
│                                    │                       │              │
│                                    ▼                       │              │
│  products                                                  │              │
│  ┌────────────────────────────────────────────────────────┐│              │
│  │ id (PK) | shop_id (FK) | title | description | price   ││              │
│  │ quantity | category_id (FK)─────────────────────────────┘│              │
│  │ tags[] | images[] | is_vintage | created_at | updated_at │              │
│  └───────────────────────────────────────────────────────────┘             │
│                      │                                                     │
│                      ▼                                                     │
│  orders              order_items          favorites        reviews         │
│  ┌────────────┐      ┌──────────────┐     ┌──────────┐    ┌──────────────┐│
│  │ id (PK)    │◀─────│ order_id(FK) │     │user_id(PK│    │ id (PK)      ││
│  │ buyer_id   │      │ product_id   │     │fav_type  │    │ order_id(UNQ)││
│  │ shop_id    │      │ quantity     │     │fav_id    │    │ rating (1-5) ││
│  │ total      │      │ price_at_buy │     └──────────┘    │ comment      ││
│  │ status     │      └──────────────┘                     └──────────────┘│
│  └────────────┘                                                            │
│                                                                            │
│  cart_items: user_id, product_id, quantity, reserved_until, added_at       │
│  UNIQUE(user_id, product_id) | INDEX: idx_cart_reservation                 │
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

```
┌────────────────────────────────────────────────────────────────────┐
│                    Prometheus Metrics                               │
├────────────────────────────────────────────────────────────────────┤
│  BUSINESS: etsy_orders_total, etsy_order_value_dollars (Histogram) │
│  PERFORMANCE: etsy_search_latency_seconds, checkout_latency        │
│  CACHE: etsy_cache_hits_total, etsy_cache_misses_total             │
│  INVENTORY: reservations_created, reservations_expired, conflicts  │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│                    Circuit Breakers                                 │
├────────────────────────────────────────────────────────────────────┤
│  ELASTICSEARCH: timeout 3s, threshold 50%, reset 15s               │
│  fallback: PostgreSQL ILIKE search (degraded)                       │
│                                                                     │
│  PAYMENT: timeout 5s, threshold 25%, reset 30s                      │
│  fallback: null (checkout fails - no fallback for payments)         │
└────────────────────────────────────────────────────────────────────┘
```

---

## Future Enhancements

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
