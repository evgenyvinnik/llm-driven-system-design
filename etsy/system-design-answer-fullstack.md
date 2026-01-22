# Etsy - System Design Answer (Full-Stack Focus)

## 45-minute system design interview format - Full-Stack Engineer Position

---

## Opening Statement (2 minutes)

"Today I'll design a handmade and vintage marketplace like Etsy from a full-stack perspective. The key challenges span both frontend and backend: implementing multi-seller cart and checkout with proper transaction handling, building a search interface for non-standardized products that connects to Elasticsearch, handling one-of-a-kind inventory with real-time availability feedback, and creating personalized browsing experiences. I'll focus on the integration points between the React frontend and Express backend, ensuring data flows correctly for the unique multi-seller model."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Shop Management**: Sellers create shops with branding and list products
2. **Product Search**: Find products across varied terminology with filters
3. **Multi-Seller Cart**: Cart with items from multiple shops, checkout creates per-seller orders
4. **Favorites**: Save products and shops for later
5. **Personalization**: Recommendations based on browsing and favorites

### Non-Functional Requirements

- **Availability**: 99.9% for checkout flow
- **Latency**: < 200ms for search, < 100ms for cart operations
- **Consistency**: Strong consistency for inventory, eventual for search
- **Performance**: FCP < 1.5s, responsive UI for cart updates

### Full-Stack Integration Points

| Feature | Frontend Concern | Backend Concern | Integration |
|---------|------------------|-----------------|-------------|
| Multi-seller cart | Shop grouping UI | Transaction safety | Cart API with shop metadata |
| Search | Filters, facets, typeahead | Elasticsearch queries | Search API with aggregations |
| Checkout | Multi-order confirmation | Atomic order creation | Idempotent checkout endpoint |
| Inventory | "Only 1 left" messaging | Reservation system | Real-time availability checks |

---

## Step 2: System Architecture (6 minutes)

### Full-Stack Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    React Frontend (Vite)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Cart Store   │  │ Search Page  │  │ Product Page           │ │
│  │ (Zustand)    │  │ w/ Filters   │  │ w/ Add to Cart         │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Express Backend                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Cart Routes  │  │Search Routes │  │ Checkout Routes        │ │
│  │ /api/cart    │  │ /api/search  │  │ /api/checkout          │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
│         │                  │                     │              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Cart Service │  │Search Service│  │ Order Service          │ │
│  │ (grouped)    │  │ (ES client)  │  │ (transactions)         │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────┐ ┌──────────────┐ ┌────────────────────────────┐
│   PostgreSQL    │ │Elasticsearch │ │         Redis              │
│   - shops       │ │ - products   │ │ - sessions                 │
│   - products    │ │ - synonyms   │ │ - cart cache               │
│   - orders      │ │              │ │ - idempotency keys         │
│   - cart_items  │ │              │ │                            │
└─────────────────┘ └──────────────┘ └────────────────────────────┘
```

### Data Flow for Key Operations

**Search Flow:**
```
User types query → SearchBar (debounce 300ms)
    → GET /api/search?q=handmade+leather&category=jewelry
    → searchService.searchProducts(query, filters)
    → Elasticsearch with synonym analyzer
    → Return products + aggregations
    → Display ProductGrid + facets
```

**Add to Cart Flow:**
```
User clicks "Add to Cart" → addToCart(product)
    → POST /api/cart/items { productId, quantity }
    → Validate inventory (product.quantity >= requested)
    → Insert cart_items with shop_id
    → Invalidate cart cache
    → Return updated cart grouped by shop
    → Update CartStore (Zustand)
```

---

## Step 3: Multi-Seller Cart & Checkout (10 minutes)

### Backend: Cart API with Shop Grouping

```typescript
// backend/src/routes/cart.ts
import { Router } from 'express'
import { pool } from '../shared/db.js'
import { requireAuth } from '../shared/auth.js'
import { cache, invalidateCache } from '../shared/cache.js'

const router = Router()

// GET /api/cart - Returns cart grouped by shop
router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.userId
  const cacheKey = `cart:${userId}`

  // Try cache first
  const cached = await cache.get(cacheKey)
  if (cached) {
    return res.json(JSON.parse(cached))
  }

  const { rows: items } = await pool.query(`
    SELECT
      ci.id as cart_item_id,
      ci.quantity,
      p.id as product_id,
      p.title,
      p.price,
      p.quantity as available_quantity,
      p.images[1] as image,
      s.id as shop_id,
      s.name as shop_name,
      s.shipping_policy
    FROM cart_items ci
    JOIN products p ON ci.product_id = p.id
    JOIN shops s ON p.shop_id = s.id
    WHERE ci.user_id = $1
    ORDER BY s.name, ci.created_at
  `, [userId])

  // Group by shop
  const byShop: Record<string, CartShopGroup> = {}

  for (const item of items) {
    if (!byShop[item.shop_id]) {
      byShop[item.shop_id] = {
        shopId: item.shop_id,
        shopName: item.shop_name,
        shippingPolicy: item.shipping_policy,
        items: [],
        subtotal: 0
      }
    }

    byShop[item.shop_id].items.push({
      cartItemId: item.cart_item_id,
      productId: item.product_id,
      title: item.title,
      price: parseFloat(item.price),
      quantity: item.quantity,
      availableQuantity: item.available_quantity,
      image: item.image
    })

    byShop[item.shop_id].subtotal += parseFloat(item.price) * item.quantity
  }

  const result = {
    shops: Object.values(byShop),
    itemTotal: items.reduce((sum, i) => sum + parseFloat(i.price) * i.quantity, 0),
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0)
  }

  // Cache for 5 minutes
  await cache.setex(cacheKey, 300, JSON.stringify(result))

  res.json(result)
})

// POST /api/cart/items - Add item to cart
router.post('/items', requireAuth, async (req, res) => {
  const userId = req.session.userId
  const { productId, quantity = 1 } = req.body

  // Check product availability
  const { rows: [product] } = await pool.query(
    'SELECT id, quantity, shop_id FROM products WHERE id = $1',
    [productId]
  )

  if (!product) {
    return res.status(404).json({ error: 'Product not found' })
  }

  if (product.quantity < quantity) {
    return res.status(400).json({
      error: 'Not enough inventory',
      available: product.quantity
    })
  }

  // Upsert cart item
  await pool.query(`
    INSERT INTO cart_items (user_id, product_id, quantity)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, product_id)
    DO UPDATE SET quantity = LEAST(
      cart_items.quantity + $3,
      (SELECT quantity FROM products WHERE id = $2)
    )
  `, [userId, productId, quantity])

  // Invalidate cart cache
  await invalidateCache(`cart:${userId}`)

  // Return updated cart
  const cart = await getCartForUser(userId)
  res.json(cart)
})

export default router
```

### Frontend: Cart Store with Shop Grouping

```typescript
// frontend/src/stores/cartStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '../services/api'

interface CartItem {
  cartItemId: string
  productId: string
  title: string
  price: number
  quantity: number
  availableQuantity: number
  image: string
}

interface CartShopGroup {
  shopId: string
  shopName: string
  items: CartItem[]
  subtotal: number
}

interface CartState {
  shops: CartShopGroup[]
  itemTotal: number
  itemCount: number
  isLoading: boolean
  error: string | null
}

interface CartActions {
  fetchCart: () => Promise<void>
  addItem: (productId: string, quantity?: number) => Promise<void>
  updateQuantity: (productId: string, quantity: number) => Promise<void>
  removeItem: (productId: string) => Promise<void>
  clearCart: () => void
}

export const useCartStore = create<CartState & CartActions>()(
  persist(
    (set, get) => ({
      shops: [],
      itemTotal: 0,
      itemCount: 0,
      isLoading: false,
      error: null,

      fetchCart: async () => {
        set({ isLoading: true, error: null })
        try {
          const response = await api.get('/cart')
          set({
            shops: response.data.shops,
            itemTotal: response.data.itemTotal,
            itemCount: response.data.itemCount,
            isLoading: false
          })
        } catch (error) {
          set({ error: 'Failed to load cart', isLoading: false })
        }
      },

      addItem: async (productId, quantity = 1) => {
        set({ isLoading: true })
        try {
          const response = await api.post('/cart/items', { productId, quantity })
          set({
            shops: response.data.shops,
            itemTotal: response.data.itemTotal,
            itemCount: response.data.itemCount,
            isLoading: false
          })
        } catch (error: any) {
          if (error.response?.data?.available !== undefined) {
            throw new Error(`Only ${error.response.data.available} available`)
          }
          throw error
        }
      },

      // ...other actions
    }),
    { name: 'etsy-cart' }
  )
)
```

### Backend: Checkout with Transaction

```typescript
// backend/src/routes/checkout.ts
import { Router } from 'express'
import { pool } from '../shared/db.js'
import { requireAuth } from '../shared/auth.js'
import { idempotencyMiddleware } from '../shared/idempotency.js'

const router = Router()

// POST /api/checkout - Create orders from cart
router.post('/',
  requireAuth,
  idempotencyMiddleware({ ttl: 86400 }), // 24-hour idempotency
  async (req, res) => {
    const userId = req.session.userId
    const { shippingAddress, paymentMethodId } = req.body

    const client = await pool.connect()

    try {
      await client.query('BEGIN')

      // Lock and fetch cart items with current inventory
      const { rows: cartItems } = await client.query(`
        SELECT
          ci.product_id,
          ci.quantity as requested,
          p.quantity as available,
          p.price,
          p.title,
          p.shop_id,
          s.name as shop_name
        FROM cart_items ci
        JOIN products p ON ci.product_id = p.id
        JOIN shops s ON p.shop_id = s.id
        WHERE ci.user_id = $1
        FOR UPDATE OF p  -- Lock product rows
      `, [userId])

      if (cartItems.length === 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Cart is empty' })
      }

      // Validate all items have sufficient inventory
      const unavailable = cartItems.filter(item => item.available < item.requested)
      if (unavailable.length > 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: 'Some items are no longer available',
          unavailableItems: unavailable.map(item => ({
            productId: item.product_id,
            title: item.title,
            requested: item.requested,
            available: item.available
          }))
        })
      }

      // Group by shop
      const byShop = cartItems.reduce((acc, item) => {
        if (!acc[item.shop_id]) {
          acc[item.shop_id] = { shopName: item.shop_name, items: [] }
        }
        acc[item.shop_id].items.push(item)
        return acc
      }, {} as Record<string, { shopName: string; items: typeof cartItems }>)

      // Create one order per shop
      const orders = []

      for (const [shopId, { shopName, items }] of Object.entries(byShop)) {
        const subtotal = items.reduce(
          (sum, item) => sum + parseFloat(item.price) * item.requested,
          0
        )
        const shipping = calculateShipping(items) // Based on shop policy

        // Create order
        const { rows: [order] } = await client.query(`
          INSERT INTO orders (buyer_id, shop_id, subtotal, shipping, total, status, shipping_address)
          VALUES ($1, $2, $3, $4, $5, 'pending', $6)
          RETURNING id, created_at
        `, [userId, shopId, subtotal, shipping, subtotal + shipping, shippingAddress])

        // Create order items
        for (const item of items) {
          await client.query(`
            INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase)
            VALUES ($1, $2, $3, $4)
          `, [order.id, item.product_id, item.requested, item.price])

          // Decrement inventory
          await client.query(`
            UPDATE products
            SET quantity = quantity - $1
            WHERE id = $2
          `, [item.requested, item.product_id])
        }

        // Update shop sales count
        await client.query(`
          UPDATE shops
          SET sales_count = sales_count + $1
          WHERE id = $2
        `, [items.length, shopId])

        orders.push({
          orderId: order.id,
          shopId,
          shopName,
          subtotal,
          shipping,
          total: subtotal + shipping,
          itemCount: items.length,
          createdAt: order.created_at
        })
      }

      // Clear cart
      await client.query('DELETE FROM cart_items WHERE user_id = $1', [userId])

      await client.query('COMMIT')

      // Process payment (outside transaction - can retry separately)
      const totalAmount = orders.reduce((sum, o) => sum + o.total, 0)
      await processPayment(userId, paymentMethodId, totalAmount)

      // Notify sellers (async - don't block response)
      notifySellers(orders).catch(err => console.error('Notification error:', err))

      // Invalidate caches
      await invalidateCache(`cart:${userId}`)

      res.json({
        success: true,
        orders,
        totalPaid: totalAmount
      })

    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
)

export default router
```

### Frontend: Checkout Flow

```tsx
// frontend/src/routes/checkout.tsx
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useCartStore } from '../stores/cartStore'
import { api } from '../services/api'

function CheckoutPage() {
  const { shops, itemTotal, clearCart } = useCartStore()
  const navigate = useNavigate()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress | null>(null)

  // Generate idempotency key for this checkout attempt
  const [idempotencyKey] = useState(() =>
    `checkout:${Date.now()}:${crypto.randomUUID()}`
  )

  const handleCheckout = async () => {
    if (!shippingAddress) {
      setError('Please enter shipping address')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const response = await api.post('/checkout', {
        shippingAddress,
        paymentMethodId: 'pm_xxx' // From payment form
      }, {
        headers: { 'Idempotency-Key': idempotencyKey }
      })

      clearCart()
      navigate({
        to: '/orders/confirmation',
        search: { orderIds: response.data.orders.map(o => o.orderId).join(',') }
      })

    } catch (err: any) {
      if (err.response?.data?.unavailableItems) {
        // Handle inventory issues
        setError(
          'Some items are no longer available: ' +
          err.response.data.unavailableItems.map(i => i.title).join(', ')
        )
      } else {
        setError('Checkout failed. Please try again.')
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Checkout</h1>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded text-red-700">
          {error}
        </div>
      )}

      {/* Orders will be created per shop */}
      <div className="mb-6">
        <h2 className="text-lg font-medium mb-2">
          Your order will be shipped from {shops.length} {shops.length === 1 ? 'shop' : 'shops'}
        </h2>

        {shops.map((shop) => (
          <CheckoutShopSection
            key={shop.shopId}
            shop={shop}
          />
        ))}
      </div>

      {/* Shipping address */}
      <ShippingAddressForm
        value={shippingAddress}
        onChange={setShippingAddress}
      />

      {/* Payment */}
      <PaymentSection />

      {/* Order summary */}
      <div className="mt-6 border-t pt-6">
        <div className="flex justify-between text-lg font-medium">
          <span>Total</span>
          <span>${itemTotal.toFixed(2)}</span>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          + shipping calculated per shop
        </p>

        <button
          onClick={handleCheckout}
          disabled={isSubmitting}
          className="mt-4 w-full py-3 bg-orange-500 text-white rounded-full
                     font-medium hover:bg-orange-600 disabled:opacity-50"
        >
          {isSubmitting ? 'Processing...' : 'Place order'}
        </button>
      </div>
    </div>
  )
}

function CheckoutShopSection({ shop }: { shop: CartShopGroup }) {
  return (
    <div className="border rounded-lg mb-4">
      <div className="bg-gray-50 px-4 py-3 border-b">
        <span className="font-medium">{shop.shopName}</span>
      </div>
      <div className="p-4">
        {shop.items.map((item) => (
          <div key={item.productId} className="flex gap-4 py-2">
            <img
              src={item.image}
              alt={item.title}
              className="w-16 h-16 object-cover rounded"
            />
            <div className="flex-1">
              <p className="font-medium">{item.title}</p>
              <p className="text-sm text-gray-600">Qty: {item.quantity}</p>
            </div>
            <span>${(item.price * item.quantity).toFixed(2)}</span>
          </div>
        ))}
        <div className="border-t mt-2 pt-2 flex justify-between">
          <span>Subtotal</span>
          <span className="font-medium">${shop.subtotal.toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}

export default CheckoutPage
```

---

## Step 4: Search Integration (8 minutes)

### Backend: Search Service with Elasticsearch

```typescript
// backend/src/services/searchService.ts
import { Client } from '@elastic/elasticsearch'
import { config } from '../shared/config.js'

const esClient = new Client({ node: config.elasticsearchUrl })

interface SearchFilters {
  category?: string
  minPrice?: number
  maxPrice?: number
  isVintage?: boolean
}

export async function searchProducts(query: string, filters: SearchFilters = {}) {
  const must = []
  const filter = []

  // Main query with fuzzy matching and synonym support
  if (query) {
    must.push({
      multi_match: {
        query,
        fields: ['title^3', 'description', 'tags^2'],
        fuzziness: 'AUTO',
        prefix_length: 2
      }
    })
  }

  // Apply filters
  if (filters.category) {
    filter.push({ term: { category: filters.category } })
  }
  if (filters.minPrice !== undefined) {
    filter.push({ range: { price: { gte: filters.minPrice } } })
  }
  if (filters.maxPrice !== undefined) {
    filter.push({ range: { price: { lte: filters.maxPrice } } })
  }
  if (filters.isVintage !== undefined) {
    filter.push({ term: { is_vintage: filters.isVintage } })
  }

  // Only show in-stock items
  filter.push({ range: { quantity: { gt: 0 } } })

  const response = await esClient.search({
    index: 'products',
    body: {
      query: {
        function_score: {
          query: {
            bool: { must, filter }
          },
          functions: [
            // Boost by shop rating
            {
              field_value_factor: {
                field: 'shop_rating',
                factor: 1.5,
                modifier: 'sqrt',
                missing: 3
              }
            },
            // Boost by sales count
            {
              field_value_factor: {
                field: 'shop_sales_count',
                factor: 1.2,
                modifier: 'log1p',
                missing: 0
              }
            }
          ],
          score_mode: 'multiply'
        }
      },
      aggs: {
        categories: {
          terms: { field: 'category', size: 20 }
        },
        price_ranges: {
          range: {
            field: 'price',
            ranges: [
              { key: 'Under $25', to: 25 },
              { key: '$25 to $50', from: 25, to: 50 },
              { key: '$50 to $100', from: 50, to: 100 },
              { key: 'Over $100', from: 100 }
            ]
          }
        }
      },
      size: 24,
      from: 0
    }
  })

  return {
    products: response.hits.hits.map(hit => ({
      id: hit._id,
      score: hit._score,
      ...hit._source
    })),
    total: response.hits.total.value,
    facets: {
      categories: response.aggregations.categories.buckets,
      priceRanges: response.aggregations.price_ranges.buckets
    }
  }
}
```

### Backend: Search Route

```typescript
// backend/src/routes/search.ts
import { Router } from 'express'
import { searchProducts } from '../services/searchService.js'
import { cache } from '../shared/cache.js'

const router = Router()

// GET /api/search
router.get('/', async (req, res) => {
  const { q, category, minPrice, maxPrice, isVintage, page = 1 } = req.query

  // Cache key based on all parameters
  const cacheKey = `search:${JSON.stringify({ q, category, minPrice, maxPrice, isVintage, page })}`

  // Try cache (2-minute TTL for search results)
  const cached = await cache.get(cacheKey)
  if (cached) {
    return res.json(JSON.parse(cached))
  }

  const results = await searchProducts(q as string, {
    category: category as string,
    minPrice: minPrice ? Number(minPrice) : undefined,
    maxPrice: maxPrice ? Number(maxPrice) : undefined,
    isVintage: isVintage === 'true'
  })

  await cache.setex(cacheKey, 120, JSON.stringify(results))

  res.json(results)
})

export default router
```

### Frontend: Search Page with Filters

```tsx
// frontend/src/routes/search.tsx
import { useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../services/api'

export const Route = createFileRoute('/search')({
  validateSearch: (search) => ({
    q: (search.q as string) || '',
    category: search.category as string | undefined,
    minPrice: search.minPrice as number | undefined,
    maxPrice: search.maxPrice as number | undefined,
    isVintage: search.isVintage as boolean | undefined
  })
})

function SearchPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()

  const { data, isLoading } = useQuery({
    queryKey: ['search', search],
    queryFn: () => api.get('/search', { params: search }).then(r => r.data),
    enabled: !!search.q
  })

  const updateFilter = (key: string, value: any) => {
    navigate({
      to: '/search',
      search: { ...search, [key]: value }
    })
  }

  return (
    <div className="max-w-7xl mx-auto p-4 flex gap-6">
      {/* Filters sidebar */}
      <aside className="w-64 flex-shrink-0">
        {/* Category filter */}
        {data?.facets?.categories && (
          <FilterSection title="Category">
            {data.facets.categories.map((cat) => (
              <label key={cat.key} className="flex items-center gap-2 py-1">
                <input
                  type="radio"
                  name="category"
                  checked={search.category === cat.key}
                  onChange={() => updateFilter('category', cat.key)}
                />
                <span>{cat.key}</span>
                <span className="text-gray-500 text-sm">({cat.doc_count})</span>
              </label>
            ))}
          </FilterSection>
        )}

        {/* Price filter */}
        {data?.facets?.priceRanges && (
          <FilterSection title="Price">
            {data.facets.priceRanges.map((range) => (
              <label key={range.key} className="flex items-center gap-2 py-1">
                <input
                  type="radio"
                  name="price"
                  checked={search.minPrice === range.from && search.maxPrice === range.to}
                  onChange={() => updateFilter('minPrice', range.from)}
                />
                <span>{range.key}</span>
                <span className="text-gray-500 text-sm">({range.doc_count})</span>
              </label>
            ))}
          </FilterSection>
        )}

        {/* Vintage toggle */}
        <FilterSection title="Options">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={search.isVintage || false}
              onChange={(e) => updateFilter('isVintage', e.target.checked || undefined)}
            />
            <span>Vintage items only</span>
          </label>
        </FilterSection>
      </aside>

      {/* Results */}
      <main className="flex-1">
        <div className="mb-4">
          <h1 className="text-xl font-medium">
            {data?.total?.toLocaleString() || 0} results for "{search.q}"
          </h1>
        </div>

        {isLoading ? (
          <ProductGridSkeleton />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {data?.products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
```

---

## Step 5: Inventory & Real-Time Availability (6 minutes)

### Backend: Inventory Check on Add to Cart

```typescript
// backend/src/routes/cart.ts (enhanced)

router.post('/items', requireAuth, async (req, res) => {
  const userId = req.session.userId
  const { productId, quantity = 1 } = req.body

  const client = await pool.connect()

  try {
    // Lock the product row to prevent race conditions
    const { rows: [product] } = await client.query(`
      SELECT id, title, quantity, price, shop_id
      FROM products
      WHERE id = $1
      FOR UPDATE
    `, [productId])

    if (!product) {
      return res.status(404).json({ error: 'Product not found' })
    }

    // Check current cart quantity for this product
    const { rows: [existing] } = await client.query(`
      SELECT quantity FROM cart_items
      WHERE user_id = $1 AND product_id = $2
    `, [userId, productId])

    const currentInCart = existing?.quantity || 0
    const totalRequested = currentInCart + quantity

    if (product.quantity < totalRequested) {
      return res.status(400).json({
        error: product.quantity === 0
          ? 'This item is no longer available'
          : `Only ${product.quantity} available`,
        available: product.quantity,
        inCart: currentInCart
      })
    }

    // Upsert cart item
    await client.query(`
      INSERT INTO cart_items (user_id, product_id, quantity)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, product_id)
      DO UPDATE SET quantity = cart_items.quantity + $3
    `, [userId, productId, quantity])

    await client.query('COMMIT')

    // Invalidate and return cart
    await invalidateCache(`cart:${userId}`)
    const cart = await getCartForUser(userId)

    res.json(cart)

  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
})

// GET /api/products/:id/availability - Real-time inventory check
router.get('/products/:id/availability', async (req, res) => {
  const { id } = req.params
  const userId = req.session?.userId

  const { rows: [product] } = await pool.query(`
    SELECT quantity FROM products WHERE id = $1
  `, [id])

  if (!product) {
    return res.status(404).json({ error: 'Product not found' })
  }

  let inCart = 0
  if (userId) {
    const { rows: [cartItem] } = await pool.query(`
      SELECT quantity FROM cart_items WHERE user_id = $1 AND product_id = $2
    `, [userId, id])
    inCart = cartItem?.quantity || 0
  }

  res.json({
    available: product.quantity,
    inCart,
    canAddMore: product.quantity > inCart
  })
})
```

### Frontend: Add to Cart with Availability Feedback

```tsx
// frontend/src/components/product/AddToCartButton.tsx
import { useState } from 'react'
import { useCartStore } from '../../stores/cartStore'

interface AddToCartButtonProps {
  product: {
    id: string
    title: string
    quantity: number // Available inventory
    price: number
    image: string
    shopId: string
    shopName: string
  }
}

function AddToCartButton({ product }: AddToCartButtonProps) {
  const { addItem, shops } = useCartStore()
  const [isAdding, setIsAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Check if already in cart
  const inCart = shops
    .flatMap(s => s.items)
    .find(i => i.productId === product.id)

  const isUniqueItem = product.quantity === 1
  const isSoldOut = product.quantity === 0

  const handleAdd = async () => {
    setIsAdding(true)
    setError(null)

    try {
      await addItem(product.id, 1)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsAdding(false)
    }
  }

  if (isSoldOut) {
    return (
      <button
        disabled
        className="w-full py-3 bg-gray-200 text-gray-500 rounded-full cursor-not-allowed"
      >
        Sold out
      </button>
    )
  }

  if (inCart && isUniqueItem) {
    return (
      <Link
        to="/cart"
        className="block w-full py-3 text-center border-2 border-black
                   rounded-full font-medium hover:bg-gray-100"
      >
        View in cart
      </Link>
    )
  }

  return (
    <div>
      <button
        onClick={handleAdd}
        disabled={isAdding}
        className="w-full py-3 bg-black text-white rounded-full
                   font-medium hover:bg-gray-800 disabled:opacity-50"
      >
        {isAdding ? 'Adding...' : inCart ? 'Add another' : 'Add to cart'}
      </button>

      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}

      {isUniqueItem && !inCart && (
        <p className="mt-2 text-sm text-orange-600">
          Only 1 available - this is a one-of-a-kind item
        </p>
      )}
    </div>
  )
}
```

---

## Step 6: Favorites & Personalization (5 minutes)

### Backend: Favorites API

```typescript
// backend/src/routes/favorites.ts
import { Router } from 'express'
import { pool } from '../shared/db.js'
import { requireAuth } from '../shared/auth.js'

const router = Router()

// GET /api/favorites - Get user's favorites
router.get('/', requireAuth, async (req, res) => {
  const userId = req.session.userId

  const { rows: products } = await pool.query(`
    SELECT p.*, s.name as shop_name, s.rating as shop_rating
    FROM favorites f
    JOIN products p ON f.favoritable_id = p.id AND f.favoritable_type = 'product'
    JOIN shops s ON p.shop_id = s.id
    WHERE f.user_id = $1
    ORDER BY f.created_at DESC
  `, [userId])

  const { rows: shops } = await pool.query(`
    SELECT s.*
    FROM favorites f
    JOIN shops s ON f.favoritable_id = s.id AND f.favoritable_type = 'shop'
    WHERE f.user_id = $1
    ORDER BY f.created_at DESC
  `, [userId])

  res.json({ products, shops })
})

// POST /api/favorites/products/:id
router.post('/products/:id', requireAuth, async (req, res) => {
  const userId = req.session.userId
  const productId = req.params.id

  await pool.query(`
    INSERT INTO favorites (user_id, favoritable_type, favoritable_id)
    VALUES ($1, 'product', $2)
    ON CONFLICT DO NOTHING
  `, [userId, productId])

  res.json({ success: true })
})

// DELETE /api/favorites/products/:id
router.delete('/products/:id', requireAuth, async (req, res) => {
  const userId = req.session.userId
  const productId = req.params.id

  await pool.query(`
    DELETE FROM favorites
    WHERE user_id = $1 AND favoritable_type = 'product' AND favoritable_id = $2
  `, [userId, productId])

  res.json({ success: true })
})

export default router
```

### Backend: Personalized Feed

```typescript
// backend/src/routes/feed.ts
import { Router } from 'express'
import { pool } from '../shared/db.js'
import { searchService } from '../services/searchService.js'

const router = Router()

// GET /api/feed - Personalized product feed
router.get('/', async (req, res) => {
  const userId = req.session?.userId

  // For anonymous users, return trending
  if (!userId) {
    const trending = await getTrendingProducts()
    return res.json({ sections: [{ title: 'Trending now', products: trending }] })
  }

  // Get user signals
  const { rows: favorites } = await pool.query(`
    SELECT p.category_id, p.tags, p.price
    FROM favorites f
    JOIN products p ON f.favoritable_id = p.id AND f.favoritable_type = 'product'
    WHERE f.user_id = $1
  `, [userId])

  const { rows: views } = await pool.query(`
    SELECT p.category_id, p.tags, p.price
    FROM view_history vh
    JOIN products p ON vh.product_id = p.id
    WHERE vh.user_id = $1
    ORDER BY vh.viewed_at DESC
    LIMIT 50
  `, [userId])

  // Cold start check
  if (favorites.length < 3 && views.length < 5) {
    const trending = await getTrendingProducts()
    return res.json({ sections: [{ title: 'Popular right now', products: trending }] })
  }

  // Extract preferences
  const topCategories = extractTopCategories([...favorites, ...views])
  const avgPrice = extractAveragePrice([...favorites, ...views])

  // Build personalized sections
  const sections = []

  // "Because you favorited..."
  if (favorites.length > 0) {
    const similar = await findSimilarToFavorites(userId, favorites.slice(0, 5))
    sections.push({ title: 'Based on your favorites', products: similar })
  }

  // Category-based
  for (const category of topCategories.slice(0, 2)) {
    const products = await searchService.searchProducts('', {
      category: category.name,
      maxPrice: avgPrice * 1.5
    })
    sections.push({
      title: `More in ${category.name}`,
      products: products.products.slice(0, 8)
    })
  }

  res.json({ sections })
})

export default router
```

---

## Step 7: Key Design Decisions & Trade-offs (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Cart storage | Server-side (PostgreSQL) | Client-side only | Multi-device sync, inventory validation |
| Checkout transaction | Single DB transaction | Saga pattern | Simpler for single-DB setup |
| Search caching | 2-minute TTL | Real-time | Balance freshness vs. ES load |
| Idempotency | Redis with 24h TTL | Database table | Fast lookups, auto-expiry |
| Favorites sync | Optimistic UI + server | Server-first | Instant feedback, eventual consistency OK |

### Full-Stack Considerations

**Frontend-Backend Contract:**
- Cart API returns grouped-by-shop structure to avoid client-side grouping
- Search API returns aggregations for faceted navigation
- Error responses include actionable data (e.g., `available` quantity)

**State Synchronization:**
- Zustand persists cart locally as cache
- `fetchCart()` on app mount syncs server state
- Optimistic updates for favorites, server confirmation follows

---

## Closing Summary

I've designed a full-stack handmade marketplace with five integrated systems:

1. **Multi-Seller Cart**: Backend groups items by shop with transaction-safe checkout creating per-seller orders, frontend displays clear shop separation with shipping implications

2. **Search Integration**: Elasticsearch with synonym analyzer and fuzzy matching, frontend faceted filters driven by backend aggregations, 2-minute cache for performance

3. **Inventory Management**: Row-level locking on add-to-cart prevents overselling, real-time availability feedback in UI, graceful handling of sold-out items

4. **Checkout Flow**: Idempotent endpoint prevents double-orders, atomic transaction creates orders and decrements inventory, frontend shows multi-shop order confirmation

5. **Personalization**: Server-side preference extraction from favorites and views, cold-start fallback to trending, frontend renders sectioned feed

**Key integration patterns:**
- API returns pre-computed structures (grouped cart, aggregations)
- Optimistic UI with server confirmation for non-critical operations
- Idempotency keys generated client-side for payment-critical flows

**What would I add with more time?**
- WebSocket for real-time inventory updates
- Search suggestions API with typeahead
- Order status tracking with seller updates
- A/B testing framework for personalization algorithms
