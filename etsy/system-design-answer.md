# System Design Interview: Etsy - Handmade & Vintage Marketplace

## Opening Statement

"Today I'll design a marketplace for handmade and vintage goods like Etsy. Unlike Amazon's standardized catalog, Etsy has highly varied products with unique descriptions, often one-of-a-kind items. The key technical challenges are building search relevance for non-standardized products, handling multi-seller carts and orders, implementing personalization with sparse user signals, and managing inventory where most items have quantity of 1."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Shops**: Sellers create and manage their shops with branding
2. **Products**: List handmade or vintage items with detailed descriptions
3. **Search**: Find products across varied terminology
4. **Cart**: Multi-seller cart with combined checkout
5. **Personalization**: Favorites, recommendations based on browsing

### Non-Functional Requirements

- **Availability**: 99.9% for search and browsing
- **Latency**: < 200ms for search results
- **Scale**: 100M+ products, 5M active sellers
- **Uniqueness**: Most items have quantity 1 (one-of-a-kind)

### Key Differences from Amazon

| Aspect | Amazon | Etsy |
|--------|--------|------|
| Products | Standardized | Highly varied |
| Inventory | Thousands per SKU | Often just 1 |
| Descriptions | Template-based | Freeform, creative |
| Fulfillment | Centralized | Each seller ships |

---

## Step 2: High-Level Architecture (6 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Client Layer                                 │
│    React + Shop Pages + Search + Multi-Seller Cart              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Shop Service  │    │Product Service│    │ Order Service │
│               │    │               │    │               │
│ - Branding    │    │ - Listings    │    │ - Multi-seller│
│ - Settings    │    │ - Search      │    │ - Fulfillment │
│ - Analytics   │    │ - Inventory   │    │ - Tracking    │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │           Elasticsearch                       │
│   - Shops       │           - Product search                    │
│   - Products    │           - Synonyms                          │
│   - Orders      │           - Fuzzy matching                    │
│   - Favorites   │                                               │
└─────────────────┴───────────────────────────────────────────────┘
```

### Why This Architecture?

**Search is Critical**: With non-standardized product descriptions, search must handle synonyms (handmade vs handcrafted vs artisan), misspellings, and varied terminology.

**Multi-Seller Orders**: A single checkout can result in multiple orders (one per seller), each with independent fulfillment and tracking.

**Per-Shop Context**: Unlike Amazon, each shop has its own branding, policies, and shipping rules.

---

## Step 3: Multi-Seller Cart & Checkout (10 minutes)

### Cart Structure

A single cart contains items from multiple sellers:

```javascript
async function getCartSummary(userId) {
  const items = await db('cart_items')
    .join('products', 'cart_items.product_id', 'products.id')
    .join('shops', 'products.shop_id', 'shops.id')
    .where({ 'cart_items.user_id': userId })
    .select(
      'cart_items.*',
      'products.title',
      'products.price',
      'products.quantity as available',
      'shops.name as shop_name',
      'shops.id as shop_id',
      'shops.shipping_policy'
    )

  // Group items by shop
  const byShop = items.reduce((acc, item) => {
    if (!acc[item.shop_id]) {
      acc[item.shop_id] = {
        shop_id: item.shop_id,
        shop_name: item.shop_name,
        shipping_policy: item.shipping_policy,
        items: [],
        subtotal: 0
      }
    }
    acc[item.shop_id].items.push(item)
    acc[item.shop_id].subtotal += item.price * item.quantity
    return acc
  }, {})

  // Calculate shipping per shop
  for (const shopId of Object.keys(byShop)) {
    byShop[shopId].shipping = calculateShipping(byShop[shopId])
  }

  return {
    shops: Object.values(byShop),
    itemTotal: items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    shippingTotal: Object.values(byShop).reduce((sum, s) => sum + s.shipping, 0)
  }
}
```

### Checkout Creates Multiple Orders

```javascript
async function checkout(userId, paymentMethodId) {
  const cart = await getCartSummary(userId)

  // Validate all items still available
  for (const shop of cart.shops) {
    for (const item of shop.items) {
      if (item.available < item.quantity) {
        throw new Error(`${item.title} is no longer available`)
      }
    }
  }

  // Create one order per shop
  const orders = []

  await db.transaction(async (trx) => {
    for (const shop of cart.shops) {
      const order = await trx('orders').insert({
        buyer_id: userId,
        shop_id: shop.shop_id,
        subtotal: shop.subtotal,
        shipping: shop.shipping,
        total: shop.subtotal + shop.shipping,
        status: 'pending'
      }).returning('*')

      for (const item of shop.items) {
        await trx('order_items').insert({
          order_id: order[0].id,
          product_id: item.product_id,
          quantity: item.quantity,
          price: item.price
        })

        // Decrement inventory
        await trx('products')
          .where({ id: item.product_id })
          .decrement('quantity', item.quantity)
      }

      orders.push(order[0])
    }

    // Clear cart
    await trx('cart_items').where({ user_id: userId }).delete()
  })

  // Process payment (single charge for all orders)
  await processPayment(userId, paymentMethodId, cart.itemTotal + cart.shippingTotal)

  // Notify each seller
  for (const order of orders) {
    await notifySeller(order.shop_id, order)
  }

  return orders
}
```

### Why Split Orders by Seller?

- Each seller handles their own fulfillment
- Different shipping origins and timelines
- Simpler dispute resolution (buyer vs specific seller)
- Sellers receive payout independently

---

## Step 4: Search for Non-Standardized Products (12 minutes)

This is where Etsy differs most from traditional e-commerce.

### The Challenge

Handmade products are described inconsistently:
- "Handmade leather wallet" vs "Hand-crafted leather billfold"
- "Vintage 1970s dress" vs "Retro seventies frock"
- Misspellings are common in handwritten descriptions

### Synonym-Enhanced Search

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
            "vintage, antique, retro, old, classic",
            "wallet, billfold, purse, cardholder",
            "necklace, pendant, chain, choker",
            "earrings, studs, drops, hoops",
            "ring, band, signet",
            "leather, genuine leather, real leather, cowhide",
            "silver, sterling, 925"
          ]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "etsy_analyzer"
      },
      "description": {
        "type": "text",
        "analyzer": "etsy_analyzer"
      },
      "tags": {
        "type": "keyword"
      },
      "category": {
        "type": "keyword"
      },
      "price": {
        "type": "float"
      },
      "shop_id": {
        "type": "keyword"
      },
      "is_vintage": {
        "type": "boolean"
      }
    }
  }
}
```

### Fuzzy Matching for Typos

```javascript
async function searchProducts(query, filters) {
  const body = {
    query: {
      bool: {
        must: [
          {
            multi_match: {
              query: query,
              fields: ["title^3", "description", "tags^2"],
              fuzziness: "AUTO",  // Handles typos
              prefix_length: 2    // First 2 chars must match
            }
          }
        ],
        filter: [
          filters.category && { term: { category: filters.category } },
          filters.priceMin && { range: { price: { gte: filters.priceMin } } },
          filters.priceMax && { range: { price: { lte: filters.priceMax } } },
          filters.isVintage !== undefined && { term: { is_vintage: filters.isVintage } }
        ].filter(Boolean)
      }
    },
    aggs: {
      categories: { terms: { field: "category", size: 20 } },
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
      }
    }
  }

  return await es.search({ index: 'products', body })
}
```

### Search Ranking Factors

```javascript
// Boost factors in Elasticsearch
{
  function_score: {
    query: baseQuery,
    functions: [
      // Higher seller rating = higher rank
      {
        field_value_factor: {
          field: "shop_rating",
          factor: 1.5,
          modifier: "sqrt"
        }
      },
      // More sales = more trust
      {
        field_value_factor: {
          field: "shop_sales_count",
          factor: 1.2,
          modifier: "log1p"
        }
      },
      // Recency boost for new listings
      {
        gauss: {
          created_at: {
            origin: "now",
            scale: "30d"
          }
        }
      }
    ]
  }
}
```

---

## Step 5: Personalization with Sparse Signals (8 minutes)

Many Etsy users browse without purchasing. We need to personalize with limited data.

### Building User Preferences

```javascript
async function getUserPreferences(userId) {
  // Collect all signals
  const favorites = await db('favorites')
    .where({ user_id: userId })
    .join('products', 'favorites.product_id', 'products.id')

  const views = await db('view_history')
    .where({ user_id: userId })
    .orderBy('viewed_at', 'desc')
    .limit(50)
    .join('products', 'view_history.product_id', 'products.id')

  const purchases = await db('order_items')
    .join('orders', 'order_items.order_id', 'orders.id')
    .where({ 'orders.buyer_id': userId })
    .join('products', 'order_items.product_id', 'products.id')

  // Extract patterns
  return {
    categories: extractTopCategories([...favorites, ...views, ...purchases]),
    priceRange: extractPriceRange([...favorites, ...purchases]),
    styles: extractStyles([...favorites, ...views]),  // vintage, minimalist, etc.
    favoriteShops: favorites.map(f => f.shop_id)
  }
}
```

### Handling Cold Start

```javascript
async function getPersonalizedFeed(userId) {
  const preferences = await getUserPreferences(userId)

  // Cold start: Not enough data
  if (preferences.categories.length < 3) {
    // Show trending products across all categories
    return await getTrendingProducts()
  }

  // Warm user: Use preferences
  return await findMatchingProducts({
    categories: preferences.categories,
    priceRange: preferences.priceRange,
    styles: preferences.styles,
    excludeViewed: true
  })
}
```

### Favorites as Strong Signal

Favorites are explicit signals of interest:

```sql
CREATE TABLE favorites (
  user_id INTEGER REFERENCES users(id),
  favoritable_type VARCHAR(20), -- 'product' or 'shop'
  favoritable_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, favoritable_type, favoritable_id)
);
```

```javascript
// Use favorites to power "You might also like"
async function getSimilarToFavorites(userId) {
  const favoriteProducts = await db('favorites')
    .where({ user_id: userId, favoritable_type: 'product' })
    .limit(10)

  // Find products similar to favorites
  const similar = []
  for (const fav of favoriteProducts) {
    const product = await getProduct(fav.favoritable_id)
    const matches = await es.search({
      index: 'products',
      body: {
        query: {
          more_like_this: {
            fields: ['title', 'description', 'tags'],
            like: [{ _id: fav.favoritable_id }],
            min_term_freq: 1
          }
        }
      }
    })
    similar.push(...matches.hits.hits)
  }

  return dedupeAndRank(similar)
}
```

---

## Step 6: One-of-a-Kind Inventory (5 minutes)

Most Etsy items are unique. Inventory handling differs from traditional e-commerce.

### Inventory Model

```sql
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
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Handling "Last One" Scenarios

```javascript
async function addToCart(userId, productId) {
  const product = await db('products').where({ id: productId }).first()

  if (product.quantity < 1) {
    throw new Error('This item is no longer available')
  }

  // Check if already in someone else's cart
  const existingReservation = await db('cart_items')
    .where({ product_id: productId })
    .where('reserved_until', '>', new Date())
    .first()

  if (existingReservation && existingReservation.user_id !== userId) {
    // Item is reserved by someone else
    return {
      success: false,
      message: 'Someone else is checking out with this item. It may become available soon.'
    }
  }

  // Add to cart with short reservation (15 min for unique items)
  await db('cart_items').insert({
    user_id: userId,
    product_id: productId,
    quantity: 1,
    reserved_until: new Date(Date.now() + 15 * 60 * 1000)
  })

  return { success: true }
}
```

### No "Similar Items" Fallback

Unlike Amazon, when a unique item sells, there's no substitute. The UX must handle this gracefully:

```javascript
// When viewing a sold item
async function getSoldItemPage(productId) {
  const product = await db('products')
    .where({ id: productId })
    .first()

  // Show the item but marked as sold
  const response = {
    product,
    status: 'sold',
    message: 'This item has sold'
  }

  // Suggest similar items from same shop
  response.moreFromShop = await db('products')
    .where({ shop_id: product.shop_id, quantity: { '>': 0 } })
    .limit(6)

  // Suggest similar items from other shops
  response.similarItems = await findSimilarProducts(product)

  return response
}
```

---

## Step 7: Database Schema (2 minutes)

```sql
-- Shops (sellers)
CREATE TABLE shops (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  banner_image VARCHAR(500),
  logo_image VARCHAR(500),
  rating DECIMAL(2, 1),
  sales_count INTEGER DEFAULT 0,
  shipping_policy JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Products
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER DEFAULT 1,
  category_id INTEGER REFERENCES categories(id),
  tags TEXT[],
  images TEXT[],
  is_vintage BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Orders (one per shop per checkout)
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  buyer_id INTEGER REFERENCES users(id),
  shop_id INTEGER REFERENCES shops(id),
  subtotal DECIMAL(10, 2),
  shipping DECIMAL(10, 2),
  total DECIMAL(10, 2),
  status VARCHAR(30) DEFAULT 'pending',
  tracking_number VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Step 8: Key Design Decisions & Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Order structure | Split by seller | Single order | Each seller handles fulfillment |
| Search | Synonyms + fuzzy | Exact match | Products described inconsistently |
| Inventory | Individual tracking | Aggregate | Most items are unique |
| Personalization | Favorites-based | Collaborative filtering | Sparse purchase data |

### Why Not Collaborative Filtering?

Traditional "customers who bought X also bought Y" works poorly because:
- Most items sell once (quantity 1)
- Purchase frequency is low (infrequent, considered purchases)
- Favorites provide stronger signal than purchases

---

## Closing Summary

I've designed a handmade/vintage marketplace with four core systems:

1. **Multi-Seller Cart & Checkout**: Single cart with items from multiple shops, creating separate orders per seller with independent fulfillment

2. **Search with Synonyms**: Elasticsearch-powered search with synonym expansion and fuzzy matching to handle varied terminology and typos

3. **Sparse Signal Personalization**: Recommendation system based on favorites, views, and purchase patterns with cold-start fallback to trending

4. **Unique Item Inventory**: Short reservation windows and graceful handling of sold-out items with similar product suggestions

**Key trade-offs:**
- Split orders per seller (complexity vs. fulfillment reality)
- Synonym-heavy search (recall vs. precision)
- Favorites over purchases for personalization (explicit vs. implicit signals)

**What would I add with more time?**
- Shop analytics dashboard for sellers
- Conversation/negotiation for custom orders
- Bulk listing tools for high-volume sellers
