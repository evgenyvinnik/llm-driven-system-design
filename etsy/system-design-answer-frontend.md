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
App
├── Header
│   ├── SearchBar
│   │   ├── SearchInput (with typeahead)
│   │   └── FilterDropdown
│   ├── CategoryNav
│   └── CartIcon (with badge)
├── Routes
│   ├── HomePage
│   │   ├── PersonalizedFeed
│   │   ├── TrendingCategories
│   │   └── FavoriteShops
│   ├── SearchPage
│   │   ├── SearchFilters (sidebar)
│   │   ├── ProductGrid
│   │   └── Pagination
│   ├── ProductPage
│   │   ├── ImageGallery
│   │   ├── ProductDetails
│   │   ├── ShopPreview
│   │   ├── SimilarItems
│   │   └── AddToCartButton
│   ├── ShopPage
│   │   ├── ShopBanner
│   │   ├── ShopInfo
│   │   └── ShopProductGrid
│   ├── CartPage
│   │   ├── CartByShop (grouped sections)
│   │   └── CartSummary
│   └── CheckoutPage
│       ├── ShopOrderSection (per seller)
│       ├── PaymentForm
│       └── OrderConfirmation
└── Footer
```

### State Management with Zustand

```typescript
// stores/cartStore.ts
interface CartItem {
  productId: string
  shopId: string
  shopName: string
  title: string
  price: number
  image: string
  quantity: number
  maxQuantity: number // Often 1 for unique items
}

interface CartStore {
  items: CartItem[]
  addItem: (item: CartItem) => void
  removeItem: (productId: string) => void
  updateQuantity: (productId: string, quantity: number) => void
  getItemsByShop: () => Map<string, CartItem[]>
  getTotalByShop: () => Map<string, number>
  getGrandTotal: () => number
  clearCart: () => void
}

export const useCartStore = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],

      addItem: (item) => set((state) => {
        const existing = state.items.find(i => i.productId === item.productId)
        if (existing) {
          // Don't exceed max quantity (important for unique items)
          const newQty = Math.min(existing.quantity + 1, item.maxQuantity)
          return {
            items: state.items.map(i =>
              i.productId === item.productId
                ? { ...i, quantity: newQty }
                : i
            )
          }
        }
        return { items: [...state.items, item] }
      }),

      getItemsByShop: () => {
        const byShop = new Map<string, CartItem[]>()
        get().items.forEach(item => {
          const shopItems = byShop.get(item.shopId) || []
          shopItems.push(item)
          byShop.set(item.shopId, shopItems)
        })
        return byShop
      },

      getTotalByShop: () => {
        const totals = new Map<string, number>()
        get().items.forEach(item => {
          const current = totals.get(item.shopId) || 0
          totals.set(item.shopId, current + item.price * item.quantity)
        })
        return totals
      },
      // ...
    }),
    { name: 'etsy-cart' }
  )
)
```

---

## Step 3: Multi-Seller Cart UI (10 minutes)

### Cart Grouped by Shop

The cart must clearly show items grouped by seller since each seller ships independently.

```tsx
// components/cart/CartPage.tsx
function CartPage() {
  const { items, getItemsByShop, getTotalByShop, getGrandTotal } = useCartStore()
  const itemsByShop = getItemsByShop()
  const totalsByShop = getTotalByShop()

  if (items.length === 0) {
    return <EmptyCartState />
  }

  return (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">
        Your cart ({items.length} {items.length === 1 ? 'item' : 'items'})
      </h1>

      {/* Each shop gets its own section */}
      <div className="space-y-6">
        {Array.from(itemsByShop.entries()).map(([shopId, shopItems]) => (
          <CartShopSection
            key={shopId}
            shopId={shopId}
            shopName={shopItems[0].shopName}
            items={shopItems}
            subtotal={totalsByShop.get(shopId) || 0}
          />
        ))}
      </div>

      {/* Order summary */}
      <CartSummary
        shopCount={itemsByShop.size}
        itemTotal={getGrandTotal()}
      />
    </div>
  )
}

// components/cart/CartShopSection.tsx
function CartShopSection({
  shopId,
  shopName,
  items,
  subtotal
}: CartShopSectionProps) {
  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Shop header */}
      <div className="bg-gray-50 px-4 py-3 border-b flex items-center justify-between">
        <Link
          to="/shop/$shopId"
          params={{ shopId }}
          className="font-medium hover:underline flex items-center gap-2"
        >
          <StorefrontIcon className="w-4 h-4" />
          {shopName}
        </Link>
        <span className="text-sm text-gray-600">
          Ships from {shopName}
        </span>
      </div>

      {/* Shop items */}
      <div className="divide-y">
        {items.map((item) => (
          <CartItemRow key={item.productId} item={item} />
        ))}
      </div>

      {/* Shop subtotal */}
      <div className="bg-gray-50 px-4 py-3 border-t flex justify-between">
        <span className="text-sm text-gray-600">
          Subtotal ({items.length} {items.length === 1 ? 'item' : 'items'})
        </span>
        <span className="font-medium">${subtotal.toFixed(2)}</span>
      </div>
    </div>
  )
}
```

### Cart Item with Unique Item Handling

```tsx
// components/cart/CartItemRow.tsx
function CartItemRow({ item }: { item: CartItem }) {
  const { updateQuantity, removeItem } = useCartStore()
  const isUniqueItem = item.maxQuantity === 1

  return (
    <div className="p-4 flex gap-4">
      {/* Product image */}
      <Link to="/product/$productId" params={{ productId: item.productId }}>
        <img
          src={item.image}
          alt={item.title}
          className="w-24 h-24 object-cover rounded"
        />
      </Link>

      {/* Product details */}
      <div className="flex-1">
        <Link
          to="/product/$productId"
          params={{ productId: item.productId }}
          className="font-medium hover:underline line-clamp-2"
        >
          {item.title}
        </Link>

        <div className="mt-2 flex items-center gap-4">
          {/* Quantity selector - disabled for unique items */}
          {isUniqueItem ? (
            <span className="text-sm text-gray-600">
              One of a kind item
            </span>
          ) : (
            <select
              value={item.quantity}
              onChange={(e) => updateQuantity(item.productId, Number(e.target.value))}
              className="border rounded px-2 py-1"
            >
              {Array.from({ length: item.maxQuantity }, (_, i) => i + 1).map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}

          <button
            onClick={() => removeItem(item.productId)}
            className="text-sm text-red-600 hover:underline"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Price */}
      <div className="text-right">
        <span className="font-medium">${(item.price * item.quantity).toFixed(2)}</span>
        {item.quantity > 1 && (
          <div className="text-sm text-gray-500">
            ${item.price.toFixed(2)} each
          </div>
        )}
      </div>
    </div>
  )
}
```

### Cart Summary with Multi-Seller Shipping

```tsx
// components/cart/CartSummary.tsx
function CartSummary({ shopCount, itemTotal }: CartSummaryProps) {
  return (
    <div className="mt-6 border rounded-lg p-4">
      <div className="space-y-2">
        <div className="flex justify-between">
          <span>Item(s) total</span>
          <span>${itemTotal.toFixed(2)}</span>
        </div>

        {shopCount > 1 && (
          <div className="text-sm text-gray-600 bg-amber-50 p-2 rounded">
            Your order will ship from {shopCount} different shops.
            Shipping costs calculated at checkout.
          </div>
        )}
      </div>

      <Link
        to="/checkout"
        className="mt-4 block w-full bg-orange-500 text-white text-center
                   py-3 rounded-full font-medium hover:bg-orange-600"
      >
        Proceed to checkout
      </Link>
    </div>
  )
}
```

---

## Step 4: Search Interface for Non-Standardized Products (10 minutes)

### Search with Typeahead

```tsx
// components/search/SearchBar.tsx
function SearchBar() {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const navigate = useNavigate()

  // Debounced typeahead
  const debouncedQuery = useDebounce(query, 300)

  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setSuggestions([])
      return
    }

    fetchSuggestions(debouncedQuery).then(setSuggestions)
  }, [debouncedQuery])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) {
      navigate({ to: '/search', search: { q: query.trim() } })
      setShowSuggestions(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="relative flex-1 max-w-2xl">
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setShowSuggestions(true)}
          placeholder="Search for anything"
          className="w-full pl-4 pr-12 py-2 border-2 border-gray-300
                     rounded-full focus:border-orange-500 focus:outline-none"
        />
        <button
          type="submit"
          className="absolute right-2 top-1/2 -translate-y-1/2
                     bg-orange-500 text-white p-2 rounded-full"
        >
          <SearchIcon className="w-4 h-4" />
        </button>
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <SearchSuggestions
          suggestions={suggestions}
          onSelect={(suggestion) => {
            navigate({ to: '/search', search: { q: suggestion.text } })
            setShowSuggestions(false)
          }}
        />
      )}
    </form>
  )
}
```

### Search Results with Creative Filters

```tsx
// routes/search.tsx
function SearchPage() {
  const { q, category, minPrice, maxPrice, style } = Route.useSearch()
  const [filters, setFilters] = useState({
    category: category || '',
    priceRange: { min: minPrice, max: maxPrice },
    style: style || '',
    isVintage: false,
    freeShipping: false
  })

  const { data, isLoading } = useQuery({
    queryKey: ['search', q, filters],
    queryFn: () => searchProducts(q, filters)
  })

  return (
    <div className="flex gap-6 max-w-7xl mx-auto p-4">
      {/* Filters sidebar */}
      <aside className="w-64 flex-shrink-0 hidden md:block">
        <SearchFilters
          filters={filters}
          facets={data?.facets}
          onChange={setFilters}
        />
      </aside>

      {/* Results */}
      <main className="flex-1">
        <SearchHeader query={q} resultCount={data?.total} />

        {isLoading ? (
          <ProductGridSkeleton />
        ) : (
          <>
            <ProductGrid products={data?.products} />
            <Pagination
              current={data?.page}
              total={data?.totalPages}
            />
          </>
        )}
      </main>
    </div>
  )
}

// components/search/SearchFilters.tsx
function SearchFilters({ filters, facets, onChange }: SearchFiltersProps) {
  return (
    <div className="space-y-6">
      {/* Category facet */}
      <FilterSection title="Category">
        {facets?.categories.map((cat) => (
          <label key={cat.key} className="flex items-center gap-2">
            <input
              type="radio"
              name="category"
              checked={filters.category === cat.key}
              onChange={() => onChange({ ...filters, category: cat.key })}
            />
            <span>{cat.key}</span>
            <span className="text-gray-500 text-sm">({cat.doc_count})</span>
          </label>
        ))}
      </FilterSection>

      {/* Price range */}
      <FilterSection title="Price">
        <div className="space-y-2">
          {[
            { label: 'Under $25', min: 0, max: 25 },
            { label: '$25 to $50', min: 25, max: 50 },
            { label: '$50 to $100', min: 50, max: 100 },
            { label: 'Over $100', min: 100, max: undefined }
          ].map((range) => (
            <label key={range.label} className="flex items-center gap-2">
              <input
                type="radio"
                name="price"
                checked={
                  filters.priceRange.min === range.min &&
                  filters.priceRange.max === range.max
                }
                onChange={() => onChange({
                  ...filters,
                  priceRange: { min: range.min, max: range.max }
                })}
              />
              <span>{range.label}</span>
            </label>
          ))}
        </div>
      </FilterSection>

      {/* Style filter - unique to handmade marketplaces */}
      <FilterSection title="Style">
        {['Minimalist', 'Bohemian', 'Vintage', 'Modern', 'Rustic'].map((style) => (
          <label key={style} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filters.style === style}
              onChange={() => onChange({
                ...filters,
                style: filters.style === style ? '' : style
              })}
            />
            <span>{style}</span>
          </label>
        ))}
      </FilterSection>

      {/* Toggle filters */}
      <FilterSection title="Options">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.isVintage}
            onChange={(e) => onChange({ ...filters, isVintage: e.target.checked })}
          />
          <span>Vintage items only</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={filters.freeShipping}
            onChange={(e) => onChange({ ...filters, freeShipping: e.target.checked })}
          />
          <span>Free shipping</span>
        </label>
      </FilterSection>
    </div>
  )
}
```

### Product Card with Handmade Aesthetic

```tsx
// components/product/ProductCard.tsx
function ProductCard({ product }: { product: Product }) {
  const { addFavorite, removeFavorite, isFavorited } = useFavoritesStore()
  const favorited = isFavorited(product.id)

  return (
    <div className="group relative">
      {/* Product image with aspect ratio handling */}
      <Link to="/product/$productId" params={{ productId: product.id }}>
        <div className="aspect-square overflow-hidden rounded-lg bg-gray-100">
          <img
            src={product.images[0]}
            alt={product.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
          />
        </div>
      </Link>

      {/* Favorite button */}
      <button
        onClick={() => favorited ? removeFavorite(product.id) : addFavorite(product.id)}
        className="absolute top-2 right-2 p-2 bg-white rounded-full shadow
                   opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
      >
        <HeartIcon className={cn('w-5 h-5', favorited && 'fill-red-500 text-red-500')} />
      </button>

      {/* Product info */}
      <div className="mt-2">
        <Link
          to="/product/$productId"
          params={{ productId: product.id }}
          className="text-sm line-clamp-2 hover:underline"
        >
          {product.title}
        </Link>

        <div className="mt-1 flex items-center gap-2">
          <span className="font-medium">${product.price.toFixed(2)}</span>
          {product.originalPrice && (
            <span className="text-sm text-gray-500 line-through">
              ${product.originalPrice.toFixed(2)}
            </span>
          )}
        </div>

        {/* Shop and rating */}
        <div className="mt-1 flex items-center gap-1 text-sm text-gray-600">
          <Link
            to="/shop/$shopId"
            params={{ shopId: product.shopId }}
            className="hover:underline"
          >
            {product.shopName}
          </Link>
          {product.shopRating && (
            <>
              <span>-</span>
              <StarIcon className="w-3 h-3 fill-yellow-400" />
              <span>{product.shopRating.toFixed(1)}</span>
            </>
          )}
        </div>

        {/* Inventory status */}
        {product.quantity === 1 && (
          <div className="mt-1 text-xs text-orange-600 font-medium">
            Only 1 available
          </div>
        )}
        {product.quantity === 0 && (
          <div className="mt-1 text-xs text-gray-500">
            Sold
          </div>
        )}
      </div>
    </div>
  )
}
```

---

## Step 5: Product Page with Unique Item Handling (8 minutes)

### Product Page Layout

```tsx
// routes/product.$productId.tsx
function ProductPage() {
  const { productId } = Route.useParams()
  const { data: product, isLoading } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => fetchProduct(productId)
  })

  if (isLoading) return <ProductPageSkeleton />
  if (!product) return <NotFound />

  const isSold = product.quantity === 0

  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="grid md:grid-cols-2 gap-8">
        {/* Image gallery */}
        <ImageGallery images={product.images} isSold={isSold} />

        {/* Product details */}
        <div>
          {/* Shop info */}
          <ShopPreview
            shopId={product.shopId}
            shopName={product.shopName}
            shopRating={product.shopRating}
            salesCount={product.shopSalesCount}
          />

          <h1 className="mt-4 text-2xl font-bold">{product.title}</h1>

          <div className="mt-2 flex items-center gap-4">
            <span className="text-2xl font-bold">${product.price.toFixed(2)}</span>
            {product.isVintage && (
              <span className="bg-amber-100 text-amber-800 px-2 py-1 rounded text-sm">
                Vintage
              </span>
            )}
          </div>

          {/* Stock status */}
          <ProductStockStatus product={product} />

          {/* Add to cart */}
          <AddToCartSection product={product} />

          {/* Description */}
          <div className="mt-6 prose prose-sm">
            <h3>Description</h3>
            <p>{product.description}</p>
          </div>

          {/* Shipping info */}
          <ShippingInfo shippingPolicy={product.shippingPolicy} />
        </div>
      </div>

      {/* Similar items */}
      <SimilarProducts productId={productId} />

      {/* More from this shop */}
      <MoreFromShop shopId={product.shopId} />
    </div>
  )
}
```

### Sold Item Handling

```tsx
// components/product/ProductStockStatus.tsx
function ProductStockStatus({ product }: { product: Product }) {
  if (product.quantity === 0) {
    return (
      <div className="mt-4 p-4 bg-gray-100 rounded-lg">
        <div className="flex items-center gap-2 text-gray-600">
          <SoldIcon className="w-5 h-5" />
          <span className="font-medium">This item has sold</span>
        </div>
        <p className="mt-2 text-sm text-gray-500">
          This was a one-of-a-kind item. Check out similar items below or
          explore more from this shop.
        </p>
      </div>
    )
  }

  if (product.quantity === 1) {
    return (
      <div className="mt-4 flex items-center gap-2 text-orange-600">
        <ExclamationIcon className="w-5 h-5" />
        <span className="font-medium">Only 1 available - don't miss it!</span>
      </div>
    )
  }

  if (product.quantity <= 5) {
    return (
      <div className="mt-4 text-sm text-gray-600">
        Only {product.quantity} left in stock
      </div>
    )
  }

  return null
}

// components/product/AddToCartSection.tsx
function AddToCartSection({ product }: { product: Product }) {
  const [quantity, setQuantity] = useState(1)
  const { addItem, items } = useCartStore()
  const navigate = useNavigate()

  const inCart = items.some(i => i.productId === product.id)
  const isSold = product.quantity === 0
  const isUniqueItem = product.quantity === 1

  const handleAddToCart = () => {
    addItem({
      productId: product.id,
      shopId: product.shopId,
      shopName: product.shopName,
      title: product.title,
      price: product.price,
      image: product.images[0],
      quantity,
      maxQuantity: product.quantity
    })
  }

  if (isSold) {
    return (
      <button
        disabled
        className="mt-4 w-full py-3 bg-gray-300 text-gray-500
                   rounded-full cursor-not-allowed"
      >
        Sold out
      </button>
    )
  }

  if (inCart) {
    return (
      <button
        onClick={() => navigate({ to: '/cart' })}
        className="mt-4 w-full py-3 border-2 border-black text-black
                   rounded-full font-medium hover:bg-gray-100"
      >
        View in cart
      </button>
    )
  }

  return (
    <div className="mt-4 space-y-3">
      {/* Quantity selector - only for non-unique items */}
      {!isUniqueItem && (
        <div className="flex items-center gap-4">
          <label className="text-sm text-gray-600">Quantity</label>
          <select
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className="border rounded px-3 py-2"
          >
            {Array.from({ length: Math.min(product.quantity, 10) }, (_, i) => i + 1)
              .map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      )}

      <button
        onClick={handleAddToCart}
        className="w-full py-3 bg-black text-white rounded-full
                   font-medium hover:bg-gray-800"
      >
        Add to cart
      </button>
    </div>
  )
}
```

---

## Step 6: Favorites & Personalization UI (5 minutes)

### Favorites Store

```typescript
// stores/favoritesStore.ts
interface FavoritesStore {
  productIds: Set<string>
  shopIds: Set<string>
  addProductFavorite: (productId: string) => void
  removeProductFavorite: (productId: string) => void
  addShopFavorite: (shopId: string) => void
  removeShopFavorite: (shopId: string) => void
  isProductFavorited: (productId: string) => boolean
  isShopFavorited: (shopId: string) => boolean
}

export const useFavoritesStore = create<FavoritesStore>()(
  persist(
    (set, get) => ({
      productIds: new Set(),
      shopIds: new Set(),

      addProductFavorite: async (productId) => {
        set((state) => ({
          productIds: new Set([...state.productIds, productId])
        }))
        // Sync to server
        await api.post('/favorites/products', { productId })
      },

      removeProductFavorite: async (productId) => {
        set((state) => {
          const newSet = new Set(state.productIds)
          newSet.delete(productId)
          return { productIds: newSet }
        })
        await api.delete(`/favorites/products/${productId}`)
      },

      isProductFavorited: (productId) => get().productIds.has(productId),
      isShopFavorited: (shopId) => get().shopIds.has(shopId),
      // ...
    }),
    {
      name: 'etsy-favorites',
      storage: createJSONStorage(() => localStorage)
    }
  )
)
```

### Personalized Home Feed

```tsx
// components/home/PersonalizedFeed.tsx
function PersonalizedFeed() {
  const { isAuthenticated } = useAuthStore()
  const { data, isLoading } = useQuery({
    queryKey: ['personalized-feed'],
    queryFn: fetchPersonalizedFeed,
    enabled: isAuthenticated
  })

  // Fall back to trending for anonymous users
  if (!isAuthenticated) {
    return <TrendingProducts />
  }

  if (isLoading) return <ProductGridSkeleton />

  return (
    <section>
      <h2 className="text-xl font-bold mb-4">Picked for you</h2>
      {data?.sections.map((section) => (
        <div key={section.title} className="mb-8">
          <h3 className="text-lg font-medium mb-3">{section.title}</h3>
          <ProductGrid products={section.products} />
        </div>
      ))}
    </section>
  )
}
```

---

## Step 7: Performance Optimizations (3 minutes)

### Image Optimization for Product Gallery

```tsx
// components/product/ImageGallery.tsx
function ImageGallery({ images, isSold }: ImageGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  return (
    <div className="space-y-4">
      {/* Main image */}
      <div className={cn(
        "aspect-square overflow-hidden rounded-lg",
        isSold && "relative"
      )}>
        <img
          src={images[selectedIndex]}
          alt="Product"
          loading="eager" // Main image loads immediately
          className={cn(
            "w-full h-full object-cover",
            isSold && "opacity-50"
          )}
        />
        {isSold && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="bg-white/90 px-4 py-2 rounded-full font-medium">
              Sold
            </span>
          </div>
        )}
      </div>

      {/* Thumbnails */}
      <div className="grid grid-cols-5 gap-2">
        {images.map((image, index) => (
          <button
            key={index}
            onClick={() => setSelectedIndex(index)}
            className={cn(
              "aspect-square overflow-hidden rounded border-2",
              selectedIndex === index ? "border-black" : "border-transparent"
            )}
          >
            <img
              src={image}
              alt={`Product thumbnail ${index + 1}`}
              loading="lazy" // Lazy load thumbnails
              className="w-full h-full object-cover"
            />
          </button>
        ))}
      </div>
    </div>
  )
}
```

### Virtualized Product Grid

```tsx
// components/product/VirtualizedProductGrid.tsx
function VirtualizedProductGrid({ products }: { products: Product[] }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const COLUMNS = 4
  const ROW_HEIGHT = 320

  const rowCount = Math.ceil(products.length / COLUMNS)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 2
  })

  return (
    <div ref={parentRef} className="h-screen overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative'
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * COLUMNS
          const rowProducts = products.slice(startIndex, startIndex + COLUMNS)

          return (
            <div
              key={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
              className="grid grid-cols-4 gap-4"
            >
              {rowProducts.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

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

Unlike Amazon where Prime handles shipping, Etsy buyers need to understand:
- Items ship from different locations
- Shipping costs are per-seller
- Delivery times vary by shop

The grouped cart UI makes these realities explicit, reducing checkout surprise.

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
