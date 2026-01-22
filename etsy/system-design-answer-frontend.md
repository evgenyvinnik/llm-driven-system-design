# Etsy - System Design Answer (Frontend Focus)

## 45-minute system design interview format - Frontend Engineer Position

---

## Opening Statement (2 minutes)

"Today I'll design a handmade and vintage marketplace like Etsy from a frontend perspective. Unlike traditional e-commerce with uniform product catalogs, Etsy features highly varied products with unique descriptions and one-of-a-kind items. The key frontend challenges are building an effective search interface for non-standardized products, implementing a multi-seller cart with clear shop grouping, handling sold-out states for unique items, and creating personalized browsing experiences with limited user signals."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements (Frontend-Focused)

1. **Shop Storefront**: Seller branding with banner, logo, and product gallery
2. **Product Discovery**: Search with filters, category browsing, personalized feed
3. **Multi-Seller Cart**: Items grouped by shop with per-shop shipping
4. **Checkout Flow**: Multi-order creation with clear seller separation
5. **Favorites & Personalization**: Wishlists for products and shops

### Non-Functional Requirements

- **Performance**: First Contentful Paint < 1.5s, Time to Interactive < 3s
- **Responsiveness**: Mobile-first design for browse-heavy marketplace
- **Accessibility**: WCAG 2.1 AA compliance for product discovery
- **Offline**: Cart persists locally for browsing continuation

### Key UI Differences from Amazon

| Aspect | Amazon | Etsy |
|--------|--------|------|
| Product cards | Uniform layout | Varied image ratios, handmade aesthetic |
| Cart display | Single seller assumed | Grouped by shop with shipping breakdown |
| Search results | Standardized facets | Creative filters (style, occasion, color) |
| Inventory UI | "In Stock" / "Out of Stock" | "Only 1 left", "Sold", unique item messaging |

---

## Step 2: Component Architecture (6 minutes)

### High-Level Component Tree

```
┌─────────────────────────────────────────────────────────────────┐
│                              App                                │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │                          Header                             │ │
│ │  ┌──────────────────┐  ┌─────────────┐  ┌────────────────┐  │ │
│ │  │    SearchBar     │  │ CategoryNav │  │ CartIcon+Badge │  │ │
│ │  │ ├─ SearchInput   │  └─────────────┘  └────────────────┘  │ │
│ │  │ └─ FilterDropdown│                                       │ │
│ │  └──────────────────┘                                       │ │
│ └─────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                           Routes                                │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │
│  │  HomePage  │ │ SearchPage │ │ProductPage │ │  CartPage   │  │
│  │ ├Feed      │ │ ├Filters   │ │ ├Gallery   │ │ ├ByShop     │  │
│  │ ├Trending  │ │ ├Grid      │ │ ├Details   │ │ └Summary    │  │
│  │ └FavShops  │ │ └Pagination│ │ └Similar   │ │             │  │
│  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### State Management with Zustand

**CartStore Interface:**
- `items: CartItem[]` - Array of cart items
- `addItem(item)` - Add item, respecting maxQuantity for unique items
- `removeItem(productId)` - Remove item from cart
- `updateQuantity(productId, quantity)` - Update quantity within limits
- `getItemsByShop()` - Returns Map of shopId to CartItem[]
- `getTotalByShop()` - Returns Map of shopId to subtotal
- `getGrandTotal()` - Returns total across all shops
- `clearCart()` - Empty the cart

**CartItem Properties:**
- productId, shopId, shopName, title, price, image
- quantity, maxQuantity (often 1 for unique items)

**Persistence:** Uses Zustand persist middleware with localStorage key "etsy-cart"

---

## Step 3: Multi-Seller Cart UI (10 minutes)

### Cart Grouped by Shop

The cart must clearly show items grouped by seller since each seller ships independently.

```
┌───────────────────────────────────────────────────────────────┐
│                    Your cart (3 items)                        │
├───────────────────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ 🏪 Vintage Treasures                  Ships from Portland │ │
│ ├───────────────────────────────────────────────────────────┤ │
│ │ ┌──────┐ Antique Brass Lamp              Qty: 1   $45.00  │ │
│ │ │ [img]│ One of a kind item              [Remove]         │ │
│ │ └──────┘                                                  │ │
│ ├───────────────────────────────────────────────────────────┤ │
│ │                          Subtotal (1 item)        $45.00  │ │
│ └───────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ 🏪 Handmade Jewelry Co                 Ships from Austin  │ │
│ ├───────────────────────────────────────────────────────────┤ │
│ │ ┌──────┐ Silver Moon Earrings            Qty: [2▼] $24.00 │ │
│ │ │ [img]│ $12.00 each                     [Remove]         │ │
│ │ └──────┘                                                  │ │
│ ├───────────────────────────────────────────────────────────┤ │
│ │                          Subtotal (2 items)       $24.00  │ │
│ └───────────────────────────────────────────────────────────┘ │
├───────────────────────────────────────────────────────────────┤
│  ⚠️ Your order will ship from 2 different shops.             │
│     Shipping costs calculated at checkout.                   │
├───────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐  │
│  │             [ Proceed to checkout ]                     │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

### Cart Item Row Behavior

**Unique Item (maxQuantity = 1):**
- Quantity selector disabled
- Shows "One of a kind item" label
- Only remove option available

**Standard Item:**
- Dropdown selector: 1 to maxQuantity (capped at 10)
- Shows "each" price when quantity > 1
- Remove button

---

## Step 4: Search Interface for Non-Standardized Products (10 minutes)

### Search with Typeahead Flow

```
User types ──▶ Debounce (300ms) ──▶ Fetch suggestions ──▶ Show dropdown
                                                              │
Submit ◀────────────────────── Select suggestion ◀────────────┘
   │
   ▼
Navigate to /search?q={query}
```

### Search Results Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Search: "handmade candles"                     │
│                         12,458 results                              │
├────────────────┬────────────────────────────────────────────────────┤
│   FILTERS      │              PRODUCT GRID                          │
│ ┌────────────┐ │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│ │ Category   │ │  │ [image] │ │ [image] │ │ [image] │ │ [image] │  │
│ │ ○ Home     │ │  │ Title...│ │ Title...│ │ Title...│ │ Title...│  │
│ │ ○ Gifts    │ │  │ $18.00  │ │ $24.50  │ │ $15.00  │ │ $32.00  │  │
│ │ ○ Decor    │ │  │ Shop ★  │ │ Shop ★  │ │ Shop ★  │ │ Shop ★  │  │
│ ├────────────┤ │  │Only 1!  │ │         │ │         │ │ Sold    │  │
│ │ Price      │ │  └─────────┘ └─────────┘ └─────────┘ └─────────┘  │
│ │ ○ Under $25│ │                                                    │
│ │ ○ $25-$50  │ │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│ │ ○ $50-$100 │ │  │  ...    │ │  ...    │ │  ...    │ │  ...    │  │
│ │ ○ Over $100│ │  └─────────┘ └─────────┘ └─────────┘ └─────────┘  │
│ ├────────────┤ │                                                    │
│ │ Style      │ │                    ◀ 1 2 3 4 5 ▶                   │
│ │ □ Minimalist                                                      │
│ │ □ Bohemian │ │                                                    │
│ │ □ Vintage  │ │                                                    │
│ │ □ Modern   │ │                                                    │
│ │ □ Rustic   │ │                                                    │
│ ├────────────┤ │                                                    │
│ │ Options    │ │                                                    │
│ │ □ Vintage  │ │                                                    │
│ │ □ Free Ship│ │                                                    │
│ └────────────┘ │                                                    │
└────────────────┴────────────────────────────────────────────────────┘
```

### Filter Types (Unique to Handmade Marketplaces)

**Category Facets:** Radio buttons with doc_count from Elasticsearch aggregations

**Price Range:** Predefined ranges (Under $25, $25-$50, $50-$100, Over $100)

**Style Filters:** Checkboxes for aesthetic categories (Minimalist, Bohemian, Vintage, Modern, Rustic)

**Toggle Options:** Vintage items only, Free shipping

### Product Card Structure

```
┌─────────────────────────────┐
│ ┌─────────────────────────┐ │
│ │                         │ │
│ │      [Product Image]    │◀── aspect-square, object-cover
│ │                     [♡] │◀── Favorite button (opacity on hover)
│ └─────────────────────────┘ │
│ Product title (2 lines max) │◀── line-clamp-2
│ $45.00  ~~$55.00~~          │◀── Price + original if discounted
│ ShopName - ★ 4.8            │◀── Shop link + rating
│ Only 1 available            │◀── Scarcity indicator (orange)
└─────────────────────────────┘
```

**Inventory Status Display:**
- quantity === 1: "Only 1 available" (orange)
- quantity === 0: "Sold" (gray)
- quantity > 1 && <= 5: No indicator (optional "X left")

---

## Step 5: Product Page with Unique Item Handling (8 minutes)

### Product Page Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ ┌──────────────────────────┐  ┌──────────────────────────────────┐ │
│ │                          │  │ 🏪 Vintage Treasures             │ │
│ │                          │  │    ★ 4.9 (2,341 sales)           │ │
│ │     [Main Product        │  ├──────────────────────────────────┤ │
│ │         Image]           │  │ Antique Brass Reading Lamp       │ │
│ │                          │  │                                  │ │
│ │                          │  │ $125.00  [Vintage]               │ │
│ │                          │  │                                  │ │
│ │                          │  │ ⚠️ Only 1 available -            │ │
│ │                          │  │    don't miss it!                │ │
│ └──────────────────────────┘  ├──────────────────────────────────┤ │
│ [thumb1][thumb2][thumb3]...   │ ┌──────────────────────────────┐ │ │
│                               │ │     [ Add to cart ]          │ │ │
│                               │ └──────────────────────────────┘ │ │
│                               ├──────────────────────────────────┤ │
│                               │ Description                      │ │
│                               │ Beautiful antique brass lamp...  │ │
│                               ├──────────────────────────────────┤ │
│                               │ Shipping                         │ │
│                               │ Ships from Portland, OR          │ │
│                               │ Estimated 3-5 business days      │ │
│                               └──────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│                       Similar items you may like                    │
│   [card] [card] [card] [card] [card]                               │
├─────────────────────────────────────────────────────────────────────┤
│                       More from this shop                           │
│   [card] [card] [card] [card] [card]                               │
└─────────────────────────────────────────────────────────────────────┘
```

### Product Stock Status States

**Sold (quantity = 0):**
```
┌────────────────────────────────────────┐
│ 🚫 This item has sold                  │
│                                        │
│ This was a one-of-a-kind item. Check   │
│ out similar items below or explore     │
│ more from this shop.                   │
└────────────────────────────────────────┘
```

**Last One (quantity = 1):**
```
⚠️ Only 1 available - don't miss it!
```

**Low Stock (quantity <= 5):**
```
Only 3 left in stock
```

### Add to Cart Section States

```
State: isSold
┌──────────────────────────────────────┐
│ [ Sold out ] (disabled, gray)        │
└──────────────────────────────────────┘

State: inCart
┌──────────────────────────────────────┐
│ [ View in cart ] (outline button)    │
└──────────────────────────────────────┘

State: isUniqueItem (quantity = 1)
┌──────────────────────────────────────┐
│ [ Add to cart ] (no qty selector)    │
└──────────────────────────────────────┘

State: Standard Item
┌──────────────────────────────────────┐
│ Quantity: [1▼]                       │
│ [ Add to cart ]                      │
└──────────────────────────────────────┘
```

---

## Step 6: Favorites & Personalization UI (5 minutes)

### Favorites Store Interface

**FavoritesStore:**
- `productIds: Set<string>` - Favorited product IDs
- `shopIds: Set<string>` - Favorited shop IDs
- `addProductFavorite(productId)` - Optimistic add + API sync
- `removeProductFavorite(productId)` - Optimistic remove + API delete
- `addShopFavorite(shopId)` - Add shop to favorites
- `removeShopFavorite(shopId)` - Remove shop from favorites
- `isProductFavorited(productId)` - Check if favorited
- `isShopFavorited(shopId)` - Check if favorited

**Persistence:** Zustand persist with localStorage, syncs to server on add/remove

### Personalized Home Feed

```
User authenticated? ──▶ Yes ──▶ Fetch personalized feed
        │                              │
        ▼                              ▼
       No                    ┌─────────────────────────┐
        │                    │   Picked for you        │
        ▼                    │   ┌──────────────────┐  │
┌───────────────────┐        │   │ Because you liked│  │
│  Trending Products│        │   │ [card][card]...  │  │
│  (anonymous users)│        │   ├──────────────────┤  │
└───────────────────┘        │   │ From your shops  │  │
                             │   │ [card][card]...  │  │
                             │   └──────────────────┘  │
                             └─────────────────────────┘
```

---

## Step 7: Performance Optimizations (3 minutes)

### Image Loading Strategy

**Main Product Image:** `loading="eager"` - Loads immediately for LCP

**Thumbnails:** `loading="lazy"` - Deferred until viewport approach

**Sold Item Overlay:**
```
┌─────────────────────────┐
│                         │
│   [image opacity: 50%]  │
│        ┌───────┐        │
│        │ Sold  │        │
│        └───────┘        │
│                         │
└─────────────────────────┘
```

### Virtualized Product Grid

For large search results, use TanStack Virtual:

```
┌─────────────────────────────────────────────────┐
│ Visible Viewport                                │
│ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐        │
│ │ Row 5 │ │       │ │       │ │       │ ◀─ Rendered
│ └───────┘ └───────┘ └───────┘ └───────┘        │
│ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐        │
│ │ Row 6 │ │       │ │       │ │       │ ◀─ Rendered
│ └───────┘ └───────┘ └───────┘ └───────┘        │
│ ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐        │
│ │ Row 7 │ │       │ │       │ │       │ ◀─ Rendered
│ └───────┘ └───────┘ └───────┘ └───────┘        │
└─────────────────────────────────────────────────┘
          Rows 1-4: Not rendered (above viewport)
          Rows 8+: Not rendered (below viewport)
```

**Configuration:**
- COLUMNS = 4
- ROW_HEIGHT = 320px
- overscan = 2 (buffer rows above/below)

---

## Step 8: Key Design Decisions & Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Cart grouping | By shop in UI | Flat list | Reflects multi-seller shipping reality |
| Favorites sync | Optimistic + persist | Server-first | Instant feedback, works offline |
| Sold items | Keep visible + alternatives | Hide completely | SEO value, shop discovery |
| Search filters | Custom facets (style, occasion) | Standard e-commerce filters | Matches handmade product nature |
| Image loading | Eager main / lazy thumbnails | All lazy | Balance LCP with bandwidth |

### Why Shop Grouping in Cart?

"Unlike Amazon where Prime handles shipping, Etsy buyers need to understand:
- Items ship from different locations
- Shipping costs are per-seller
- Delivery times vary by shop

The grouped cart UI makes these realities explicit, reducing checkout surprise."

---

## Closing Summary

I've designed the frontend for a handmade marketplace with five core systems:

1. **Multi-Seller Cart UI**: Items grouped by shop with clear shipping implications, unique item quantity handling, and per-seller subtotals

2. **Search Interface**: Typeahead with creative filters (style, occasion), faceted navigation, and product cards with handmade aesthetic

3. **Unique Item Handling**: "Only 1 left" urgency, graceful sold-out states with alternatives, disabled quantity selectors for one-of-a-kind items

4. **Favorites & Personalization**: Optimistic updates with local persistence, personalized home feed with cold-start fallback

5. **Performance Optimization**: Virtualized product grids, image loading strategies, Zustand with persistence for cart state

**Key trade-offs:**
- Shop-grouped cart (clarity vs. simplicity)
- Visible sold items (discovery vs. frustration)
- Custom filters (relevance vs. familiar UX)

**What would I add with more time?**
- Drag-and-drop favoriting to collections
- Image zoom with gesture support on mobile
- A/B testing framework for search ranking UI
- Real-time inventory updates via WebSocket
