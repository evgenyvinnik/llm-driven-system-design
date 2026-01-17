# Design Etsy - Architecture

## System Overview

Etsy is a marketplace for handmade and vintage goods. Unlike Amazon's uniform catalog, Etsy has highly varied products with unique descriptions requiring sophisticated search and personalization.

**Learning Goals:**
- Build multi-seller marketplace architecture
- Design personalization with sparse signals
- Handle unique/one-of-a-kind inventory
- Implement search relevance for varied content

---

## Core Components

### 1. Multi-Seller Cart

**Challenge**: Cart contains items from multiple sellers

```javascript
// Group cart by seller for checkout
async function getCartSummary(userId) {
  const items = await db('cart_items')
    .join('products', 'cart_items.product_id', 'products.id')
    .join('shops', 'products.shop_id', 'shops.id')
    .where({ 'cart_items.user_id': userId })
    .select('cart_items.*', 'products.title', 'products.price', 'shops.name as shop_name', 'shops.id as shop_id')

  // Group by shop
  const byShop = items.reduce((acc, item) => {
    if (!acc[item.shop_id]) {
      acc[item.shop_id] = { shop_name: item.shop_name, items: [], subtotal: 0 }
    }
    acc[item.shop_id].items.push(item)
    acc[item.shop_id].subtotal += item.price * item.quantity
    return acc
  }, {})

  return { shops: Object.values(byShop), total: items.reduce((sum, i) => sum + i.price * i.quantity, 0) }
}
```

### 2. Search Relevance

**Handmade Product Search Challenges:**
- Varied terminology (handmade, handcrafted, artisan)
- Misspellings in descriptions
- Unique product names

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
            "handmade, handcrafted, artisan, homemade",
            "vintage, antique, retro, old"
          ]
        }
      }
    }
  }
}
```

### 3. Personalization

**Sparse Signal Handling:**
```javascript
// For users with limited history, fall back to category-based
async function getPersonalizedFeed(userId) {
  const history = await getUserHistory(userId)

  if (history.views.length < 5) {
    // Cold start: Show trending in broad categories
    return getTrendingProducts()
  }

  // Extract preferences from history
  const categories = extractTopCategories(history)
  const priceRange = extractPriceRange(history)
  const styles = extractStyles(history)

  // Find similar products
  return findSimilarProducts({ categories, priceRange, styles })
}
```

---

## Database Schema

```sql
-- Shops
CREATE TABLE shops (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  banner_image VARCHAR(500),
  logo_image VARCHAR(500),
  rating DECIMAL(2, 1),
  sales_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Products
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER DEFAULT 1, -- Often 1 for handmade
  category_id INTEGER REFERENCES categories(id),
  tags TEXT[],
  images TEXT[],
  is_vintage BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Favorites (items and shops)
CREATE TABLE favorites (
  user_id INTEGER REFERENCES users(id),
  favoritable_type VARCHAR(20), -- 'product' or 'shop'
  favoritable_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, favoritable_type, favoritable_id)
);
```

---

## Key Design Decisions

### 1. Orders Split by Seller

**Decision**: Create separate order records per seller

**Rationale**:
- Each seller handles own fulfillment
- Different shipping timelines
- Simpler dispute resolution

### 2. Synonym-Enhanced Search

**Decision**: Use synonym filters for product search

**Rationale**:
- Handmade products described inconsistently
- Improves recall without hurting precision

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Order structure | Split by seller | Single order | Fulfillment reality |
| Search | Synonyms + fuzzy | Exact match | Product variety |
| Inventory | Individual tracking | Aggregate | Unique items |
