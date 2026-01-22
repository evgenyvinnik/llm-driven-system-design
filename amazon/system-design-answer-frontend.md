# Amazon E-Commerce - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"Today I'll design the frontend architecture for an e-commerce platform like Amazon. The key frontend challenges are building a performant product browsing experience with faceted search, implementing a real-time shopping cart with inventory feedback, creating a seamless checkout flow, and displaying personalized recommendations. I'll focus on component architecture, state management patterns, and optimizing the critical rendering path for conversion."

---

## Requirements Clarification

### Functional Requirements

1. **Product Browsing**: Category navigation, search with filters, product detail pages
2. **Shopping Cart**: Add/remove items, quantity updates, inventory warnings
3. **Checkout Flow**: Multi-step checkout with address, payment, confirmation
4. **Order History**: View past orders and order status
5. **Recommendations**: Display "customers also bought" and personalized suggestions

### Non-Functional Requirements

- **Performance**: LCP < 2.5s for product pages, FID < 100ms
- **Responsiveness**: Full mobile support (60%+ of e-commerce traffic)
- **Accessibility**: WCAG 2.1 AA compliance
- **Offline Support**: Cart persistence, cached product data
- **Conversion Optimization**: Minimize checkout friction

### Scale Considerations

| Metric | Target |
|--------|--------|
| Product Pages | 100M+ (static generation not feasible) |
| Concurrent Users | 500K |
| Cart Updates | Real-time feedback |
| Search Results | < 200ms perceived latency |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    React Application                             │
├─────────────────────────────────────────────────────────────────┤
│  TanStack Router (file-based routing)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌────────────┐ │
│  │   Layout    │ │   Product   │ │    Cart     │ │  Checkout  │ │
│  │   Shell     │ │   Catalog   │ │   Drawer    │ │    Flow    │ │
│  └─────────────┘ └─────────────┘ └─────────────┘ └────────────┘ │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  State Management (Zustand)                                      │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │  cartStore  │ │ searchStore │ │  userStore  │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
├─────────────────────────────────────────────────────────────────┤
│  Data Layer                                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  TanStack Query (caching, prefetching, optimistic updates)  ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  API Client (fetch wrapper with retry, error handling)      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive 1: Product Search with Faceted Filtering

### Search Results Component

```tsx
// components/search/SearchResults.tsx
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSearchParams } from '@tanstack/react-router';
import { useSearchProducts } from '../../hooks/useSearchProducts';

interface SearchFilters {
  query: string;
  category?: string;
  priceMin?: number;
  priceMax?: number;
  brands?: string[];
  rating?: number;
  inStock?: boolean;
}

export function SearchResults() {
  const [searchParams, setSearchParams] = useSearchParams();
  const parentRef = useRef<HTMLDivElement>(null);

  const filters: SearchFilters = {
    query: searchParams.get('q') || '',
    category: searchParams.get('category') || undefined,
    priceMin: searchParams.get('priceMin') ? Number(searchParams.get('priceMin')) : undefined,
    priceMax: searchParams.get('priceMax') ? Number(searchParams.get('priceMax')) : undefined,
    brands: searchParams.getAll('brand'),
    rating: searchParams.get('rating') ? Number(searchParams.get('rating')) : undefined,
    inStock: searchParams.get('inStock') === 'true'
  };

  const { data, isLoading, isFetchingNextPage, fetchNextPage, hasNextPage } = useSearchProducts(filters);

  const allProducts = data?.pages.flatMap(page => page.products) || [];

  const virtualizer = useVirtualizer({
    count: hasNextPage ? allProducts.length + 1 : allProducts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 280, // Product card height
    overscan: 5,
  });

  // Infinite scroll trigger
  useEffect(() => {
    const lastItem = virtualizer.getVirtualItems().at(-1);
    if (!lastItem) return;

    if (lastItem.index >= allProducts.length - 1 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [virtualizer.getVirtualItems(), hasNextPage, isFetchingNextPage, fetchNextPage, allProducts.length]);

  if (isLoading) {
    return <SearchResultsSkeleton />;
  }

  return (
    <div className="flex gap-6">
      {/* Facets sidebar */}
      <aside className="w-64 shrink-0">
        <FacetsSidebar
          facets={data?.pages[0]?.facets}
          activeFilters={filters}
          onFilterChange={(key, value) => {
            setSearchParams(prev => {
              const next = new URLSearchParams(prev);
              if (value === null) {
                next.delete(key);
              } else if (Array.isArray(value)) {
                next.delete(key);
                value.forEach(v => next.append(key, v));
              } else {
                next.set(key, String(value));
              }
              return next;
            });
          }}
        />
      </aside>

      {/* Results grid */}
      <main className="flex-1">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-gray-600">
            {data?.pages[0]?.total.toLocaleString()} results
            {filters.query && ` for "${filters.query}"`}
          </p>
          <SortDropdown />
        </div>

        <div
          ref={parentRef}
          className="h-[calc(100vh-200px)] overflow-auto"
        >
          <div
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            <div
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualizer.getVirtualItems()[0]?.start ?? 0}px)`
              }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const product = allProducts[virtualItem.index];
                if (!product) {
                  return <ProductCardSkeleton key={virtualItem.key} />;
                }
                return (
                  <ProductCard
                    key={product.id}
                    product={product}
                    data-index={virtualItem.index}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
```

### Facets Sidebar

```tsx
// components/search/FacetsSidebar.tsx
interface FacetsSidebarProps {
  facets: SearchFacets | undefined;
  activeFilters: SearchFilters;
  onFilterChange: (key: string, value: string | string[] | null) => void;
}

export function FacetsSidebar({ facets, activeFilters, onFilterChange }: FacetsSidebarProps) {
  return (
    <div className="space-y-6">
      {/* Category facet */}
      {facets?.categories && (
        <FacetSection title="Category">
          {facets.categories.map(cat => (
            <FacetCheckbox
              key={cat.key}
              label={cat.key}
              count={cat.doc_count}
              checked={activeFilters.category === cat.key}
              onChange={(checked) => onFilterChange('category', checked ? cat.key : null)}
            />
          ))}
        </FacetSection>
      )}

      {/* Price range facet */}
      <FacetSection title="Price">
        <PriceRangeSlider
          min={0}
          max={1000}
          value={[activeFilters.priceMin || 0, activeFilters.priceMax || 1000]}
          onChange={([min, max]) => {
            onFilterChange('priceMin', min > 0 ? String(min) : null);
            onFilterChange('priceMax', max < 1000 ? String(max) : null);
          }}
        />
        {facets?.priceRanges?.map(range => (
          <button
            key={range.key}
            className="block text-sm text-blue-600 hover:underline"
            onClick={() => {
              onFilterChange('priceMin', range.from ? String(range.from) : null);
              onFilterChange('priceMax', range.to ? String(range.to) : null);
            }}
          >
            {range.key} ({range.doc_count})
          </button>
        ))}
      </FacetSection>

      {/* Brand facet */}
      {facets?.brands && (
        <FacetSection title="Brand">
          {facets.brands.slice(0, 10).map(brand => (
            <FacetCheckbox
              key={brand.key}
              label={brand.key}
              count={brand.doc_count}
              checked={activeFilters.brands?.includes(brand.key) || false}
              onChange={(checked) => {
                const newBrands = checked
                  ? [...(activeFilters.brands || []), brand.key]
                  : (activeFilters.brands || []).filter(b => b !== brand.key);
                onFilterChange('brand', newBrands.length > 0 ? newBrands : null);
              }}
            />
          ))}
        </FacetSection>
      )}

      {/* Rating filter */}
      <FacetSection title="Customer Rating">
        {[4, 3, 2, 1].map(rating => (
          <button
            key={rating}
            className={cn(
              'flex items-center gap-2 py-1',
              activeFilters.rating === rating && 'font-semibold'
            )}
            onClick={() => onFilterChange('rating', activeFilters.rating === rating ? null : String(rating))}
          >
            <StarRating rating={rating} size="sm" />
            <span className="text-sm">& up</span>
          </button>
        ))}
      </FacetSection>

      {/* In stock filter */}
      <FacetSection title="Availability">
        <FacetCheckbox
          label="In Stock Only"
          checked={activeFilters.inStock || false}
          onChange={(checked) => onFilterChange('inStock', checked ? 'true' : null)}
        />
      </FacetSection>

      {/* Clear filters */}
      {Object.values(activeFilters).some(v => v !== undefined && v !== '' && (!Array.isArray(v) || v.length > 0)) && (
        <button
          className="text-sm text-blue-600 hover:underline"
          onClick={() => {
            Object.keys(activeFilters).forEach(key => onFilterChange(key, null));
          }}
        >
          Clear all filters
        </button>
      )}
    </div>
  );
}
```

---

## Deep Dive 2: Shopping Cart with Real-Time Inventory

### Cart Store (Zustand)

```typescript
// stores/cartStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface CartItem {
  productId: string;
  title: string;
  price: number;
  quantity: number;
  image: string;
  maxQuantity: number;
  reservedUntil: Date | null;
}

interface CartStore {
  items: CartItem[];
  isOpen: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  openCart: () => void;
  closeCart: () => void;
  addItem: (product: Product, quantity: number) => Promise<void>;
  updateQuantity: (productId: string, quantity: number) => Promise<void>;
  removeItem: (productId: string) => Promise<void>;
  clearCart: () => void;
  syncWithServer: () => Promise<void>;

  // Computed
  totalItems: () => number;
  subtotal: () => number;
  hasExpiredReservations: () => boolean;
}

export const useCartStore = create<CartStore>()(
  persist(
    (set, get) => ({
      items: [],
      isOpen: false,
      isLoading: false,
      error: null,

      openCart: () => set({ isOpen: true }),
      closeCart: () => set({ isOpen: false }),

      addItem: async (product, quantity) => {
        set({ isLoading: true, error: null });

        try {
          const response = await fetch('/api/cart/items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productId: product.id, quantity })
          });

          if (!response.ok) {
            const error = await response.json();
            if (error.code === 'INSUFFICIENT_INVENTORY') {
              throw new Error(`Only ${error.available} available`);
            }
            throw new Error(error.message);
          }

          const { item, expiresAt } = await response.json();

          set(state => {
            const existingIndex = state.items.findIndex(i => i.productId === product.id);
            if (existingIndex >= 0) {
              const newItems = [...state.items];
              newItems[existingIndex] = {
                ...newItems[existingIndex],
                quantity: newItems[existingIndex].quantity + quantity,
                reservedUntil: new Date(expiresAt)
              };
              return { items: newItems, isLoading: false, isOpen: true };
            }
            return {
              items: [...state.items, {
                productId: product.id,
                title: product.title,
                price: product.price,
                quantity,
                image: product.images[0],
                maxQuantity: item.maxQuantity,
                reservedUntil: new Date(expiresAt)
              }],
              isLoading: false,
              isOpen: true
            };
          });
        } catch (error) {
          set({ error: error.message, isLoading: false });
          throw error;
        }
      },

      updateQuantity: async (productId, quantity) => {
        const prevItems = get().items;
        const item = prevItems.find(i => i.productId === productId);
        if (!item) return;

        // Optimistic update
        set(state => ({
          items: state.items.map(i =>
            i.productId === productId ? { ...i, quantity } : i
          )
        }));

        try {
          const response = await fetch(`/api/cart/items/${productId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity })
          });

          if (!response.ok) {
            // Rollback on failure
            set({ items: prevItems });
            const error = await response.json();
            set({ error: error.message });
          }
        } catch (error) {
          set({ items: prevItems, error: error.message });
        }
      },

      removeItem: async (productId) => {
        const prevItems = get().items;

        // Optimistic removal
        set(state => ({
          items: state.items.filter(i => i.productId !== productId)
        }));

        try {
          await fetch(`/api/cart/items/${productId}`, { method: 'DELETE' });
        } catch (error) {
          set({ items: prevItems, error: error.message });
        }
      },

      clearCart: () => set({ items: [] }),

      syncWithServer: async () => {
        try {
          const response = await fetch('/api/cart');
          if (response.ok) {
            const { items } = await response.json();
            set({ items: items.map(mapApiItemToCartItem) });
          }
        } catch (error) {
          console.error('Failed to sync cart:', error);
        }
      },

      totalItems: () => get().items.reduce((sum, i) => sum + i.quantity, 0),
      subtotal: () => get().items.reduce((sum, i) => sum + i.price * i.quantity, 0),
      hasExpiredReservations: () => get().items.some(i =>
        i.reservedUntil && new Date(i.reservedUntil) < new Date()
      )
    }),
    {
      name: 'amazon-cart',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ items: state.items })
    }
  )
);
```

### Cart Drawer Component

```tsx
// components/cart/CartDrawer.tsx
import { useCartStore } from '../../stores/cartStore';

export function CartDrawer() {
  const {
    items,
    isOpen,
    closeCart,
    updateQuantity,
    removeItem,
    subtotal,
    hasExpiredReservations
  } = useCartStore();

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && closeCart()}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Shopping Cart ({items.length})</SheetTitle>
        </SheetHeader>

        {hasExpiredReservations() && (
          <Alert variant="warning" className="mt-4">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Some items in your cart may no longer be reserved. Complete checkout soon.
            </AlertDescription>
          </Alert>
        )}

        <div className="mt-6 flex-1 overflow-auto">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <ShoppingBag className="h-16 w-16 text-gray-300" />
              <p className="mt-4 text-gray-500">Your cart is empty</p>
              <Button variant="link" onClick={closeCart}>
                Continue Shopping
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-gray-200">
              {items.map(item => (
                <CartItemRow
                  key={item.productId}
                  item={item}
                  onQuantityChange={(qty) => updateQuantity(item.productId, qty)}
                  onRemove={() => removeItem(item.productId)}
                />
              ))}
            </ul>
          )}
        </div>

        {items.length > 0 && (
          <div className="border-t pt-4 mt-4">
            <div className="flex justify-between text-lg font-semibold">
              <span>Subtotal</span>
              <span>${subtotal().toFixed(2)}</span>
            </div>
            <p className="text-sm text-gray-500 mt-1">
              Shipping and taxes calculated at checkout
            </p>
            <Button
              className="w-full mt-4"
              size="lg"
              asChild
            >
              <Link to="/checkout" onClick={closeCart}>
                Proceed to Checkout
              </Link>
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CartItemRow({ item, onQuantityChange, onRemove }: CartItemRowProps) {
  const isLowStock = item.maxQuantity <= 3;
  const isExpired = item.reservedUntil && new Date(item.reservedUntil) < new Date();

  return (
    <li className={cn('flex py-4 gap-4', isExpired && 'opacity-60')}>
      <img
        src={item.image}
        alt={item.title}
        className="h-20 w-20 object-cover rounded"
      />
      <div className="flex-1 min-w-0">
        <Link
          to={`/products/${item.productId}`}
          className="font-medium text-gray-900 hover:text-blue-600 line-clamp-2"
        >
          {item.title}
        </Link>
        <p className="mt-1 text-lg font-semibold">${item.price.toFixed(2)}</p>

        {isLowStock && !isExpired && (
          <p className="text-sm text-orange-600">Only {item.maxQuantity} left</p>
        )}

        {isExpired && (
          <p className="text-sm text-red-600">Reservation expired - verify availability</p>
        )}

        <div className="mt-2 flex items-center gap-4">
          <QuantitySelector
            value={item.quantity}
            max={item.maxQuantity}
            onChange={onQuantityChange}
            disabled={isExpired}
          />
          <button
            onClick={onRemove}
            className="text-sm text-red-600 hover:underline"
          >
            Remove
          </button>
        </div>
      </div>
    </li>
  );
}
```

---

## Deep Dive 3: Product Detail Page

### Product Page Component

```tsx
// routes/products/$productId.tsx
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCartStore } from '../../stores/cartStore';

export function ProductPage() {
  const { productId } = useParams({ from: '/products/$productId' });
  const addItem = useCartStore(state => state.addItem);
  const [selectedQuantity, setSelectedQuantity] = useState(1);
  const [addingToCart, setAddingToCart] = useState(false);

  const { data: product, isLoading } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => fetchProduct(productId),
  });

  const { data: recommendations } = useQuery({
    queryKey: ['recommendations', productId],
    queryFn: () => fetchRecommendations(productId),
    enabled: !!product,
  });

  const handleAddToCart = async () => {
    if (!product) return;
    setAddingToCart(true);
    try {
      await addItem(product, selectedQuantity);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setAddingToCart(false);
    }
  };

  if (isLoading) {
    return <ProductPageSkeleton />;
  }

  if (!product) {
    return <NotFound message="Product not found" />;
  }

  const inStock = product.availableQuantity > 0;
  const lowStock = product.availableQuantity > 0 && product.availableQuantity <= 5;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <Breadcrumbs items={product.categoryPath} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mt-6">
        {/* Image gallery */}
        <ProductImageGallery images={product.images} title={product.title} />

        {/* Product info */}
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold text-gray-900">
            {product.title}
          </h1>

          <div className="mt-2 flex items-center gap-4">
            <StarRating rating={product.rating} />
            <Link
              to={`/products/${productId}/reviews`}
              className="text-blue-600 hover:underline"
            >
              {product.reviewCount.toLocaleString()} reviews
            </Link>
          </div>

          <div className="mt-4">
            {product.compareAtPrice && (
              <p className="text-gray-500 line-through">
                ${product.compareAtPrice.toFixed(2)}
              </p>
            )}
            <p className="text-3xl font-bold text-gray-900">
              ${product.price.toFixed(2)}
            </p>
          </div>

          {/* Availability */}
          <div className="mt-4">
            {inStock ? (
              <div className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-600" />
                <span className="text-green-600 font-medium">
                  {lowStock ? `Only ${product.availableQuantity} left` : 'In Stock'}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <XCircle className="h-5 w-5 text-red-600" />
                <span className="text-red-600 font-medium">Out of Stock</span>
              </div>
            )}
          </div>

          {/* Add to cart */}
          {inStock && (
            <div className="mt-6 flex items-center gap-4">
              <QuantitySelector
                value={selectedQuantity}
                max={Math.min(product.availableQuantity, 10)}
                onChange={setSelectedQuantity}
              />
              <Button
                size="lg"
                onClick={handleAddToCart}
                disabled={addingToCart}
                className="flex-1"
              >
                {addingToCart ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  'Add to Cart'
                )}
              </Button>
            </div>
          )}

          {/* Product attributes */}
          {product.attributes && Object.keys(product.attributes).length > 0 && (
            <div className="mt-6 border-t pt-6">
              <h3 className="font-semibold mb-3">Product Details</h3>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(product.attributes).map(([key, value]) => (
                  <Fragment key={key}>
                    <dt className="text-gray-500">{key}</dt>
                    <dd className="text-gray-900">{value}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      <div className="mt-12">
        <h2 className="text-xl font-bold mb-4">About this item</h2>
        <div
          className="prose max-w-none"
          dangerouslySetInnerHTML={{ __html: product.description }}
        />
      </div>

      {/* Recommendations */}
      {recommendations && recommendations.length > 0 && (
        <section className="mt-12">
          <h2 className="text-xl font-bold mb-4">Customers also bought</h2>
          <ProductCarousel products={recommendations} />
        </section>
      )}

      {/* Reviews section */}
      <section className="mt-12">
        <ProductReviews productId={productId} />
      </section>
    </div>
  );
}
```

### Image Gallery with Zoom

```tsx
// components/product/ProductImageGallery.tsx
export function ProductImageGallery({ images, title }: ProductImageGalleryProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomPosition, setZoomPosition] = useState({ x: 0, y: 0 });

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isZoomed) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setZoomPosition({ x, y });
  };

  return (
    <div className="flex gap-4">
      {/* Thumbnail strip */}
      <div className="flex flex-col gap-2">
        {images.map((image, index) => (
          <button
            key={index}
            onClick={() => setSelectedIndex(index)}
            className={cn(
              'w-16 h-16 border-2 rounded overflow-hidden',
              selectedIndex === index ? 'border-blue-500' : 'border-gray-200'
            )}
          >
            <img
              src={image}
              alt={`${title} - Image ${index + 1}`}
              className="w-full h-full object-cover"
            />
          </button>
        ))}
      </div>

      {/* Main image */}
      <div
        className="relative flex-1 aspect-square overflow-hidden rounded-lg cursor-zoom-in"
        onMouseEnter={() => setIsZoomed(true)}
        onMouseLeave={() => setIsZoomed(false)}
        onMouseMove={handleMouseMove}
      >
        <img
          src={images[selectedIndex]}
          alt={title}
          className={cn(
            'w-full h-full object-contain transition-transform duration-200',
            isZoomed && 'scale-150'
          )}
          style={isZoomed ? {
            transformOrigin: `${zoomPosition.x}% ${zoomPosition.y}%`
          } : undefined}
        />
      </div>
    </div>
  );
}
```

---

## Deep Dive 4: Checkout Flow

### Multi-Step Checkout

```tsx
// routes/checkout.tsx
type CheckoutStep = 'shipping' | 'payment' | 'review';

export function CheckoutPage() {
  const [step, setStep] = useState<CheckoutStep>('shipping');
  const [shippingAddress, setShippingAddress] = useState<Address | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const { items, subtotal } = useCartStore();
  const navigate = useNavigate();

  const { mutate: placeOrder, isPending } = useMutation({
    mutationFn: createOrder,
    onSuccess: (order) => {
      useCartStore.getState().clearCart();
      navigate({ to: '/orders/$orderId/confirmation', params: { orderId: order.id } });
    },
    onError: (error) => {
      toast.error(error.message);
    }
  });

  if (items.length === 0) {
    return <EmptyCartRedirect />;
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Progress indicator */}
      <CheckoutProgress currentStep={step} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-8">
        <div className="lg:col-span-2">
          {step === 'shipping' && (
            <ShippingStep
              address={shippingAddress}
              onComplete={(address) => {
                setShippingAddress(address);
                setStep('payment');
              }}
            />
          )}

          {step === 'payment' && (
            <PaymentStep
              paymentMethod={paymentMethod}
              onComplete={(method) => {
                setPaymentMethod(method);
                setStep('review');
              }}
              onBack={() => setStep('shipping')}
            />
          )}

          {step === 'review' && (
            <ReviewStep
              items={items}
              shippingAddress={shippingAddress!}
              paymentMethod={paymentMethod!}
              onPlaceOrder={() => {
                placeOrder({
                  items: items.map(i => ({ productId: i.productId, quantity: i.quantity })),
                  shippingAddress: shippingAddress!,
                  paymentMethod: paymentMethod!
                });
              }}
              onBack={() => setStep('payment')}
              isProcessing={isPending}
            />
          )}
        </div>

        {/* Order summary sidebar */}
        <aside>
          <OrderSummary
            items={items}
            subtotal={subtotal()}
            shipping={shippingAddress ? calculateShipping(shippingAddress) : null}
          />
        </aside>
      </div>
    </div>
  );
}
```

### Shipping Address Form

```tsx
// components/checkout/ShippingStep.tsx
const addressSchema = z.object({
  fullName: z.string().min(1, 'Name is required'),
  addressLine1: z.string().min(1, 'Address is required'),
  addressLine2: z.string().optional(),
  city: z.string().min(1, 'City is required'),
  state: z.string().min(1, 'State is required'),
  zipCode: z.string().regex(/^\d{5}(-\d{4})?$/, 'Invalid ZIP code'),
  country: z.string().min(1, 'Country is required'),
  phone: z.string().regex(/^\+?[\d\s-()]+$/, 'Invalid phone number')
});

export function ShippingStep({ address, onComplete }: ShippingStepProps) {
  const { data: savedAddresses } = useQuery({
    queryKey: ['addresses'],
    queryFn: fetchSavedAddresses
  });

  const form = useForm({
    resolver: zodResolver(addressSchema),
    defaultValues: address || {}
  });

  return (
    <div>
      <h2 className="text-xl font-bold mb-6">Shipping Address</h2>

      {savedAddresses && savedAddresses.length > 0 && (
        <div className="mb-6">
          <h3 className="font-medium mb-3">Saved Addresses</h3>
          <div className="grid gap-3">
            {savedAddresses.map(addr => (
              <button
                key={addr.id}
                onClick={() => {
                  form.reset(addr);
                  onComplete(addr);
                }}
                className="text-left p-4 border rounded-lg hover:border-blue-500"
              >
                <p className="font-medium">{addr.fullName}</p>
                <p className="text-sm text-gray-600">
                  {addr.addressLine1}, {addr.city}, {addr.state} {addr.zipCode}
                </p>
              </button>
            ))}
          </div>
          <Separator className="my-6">or enter a new address</Separator>
        </div>
      )}

      <form onSubmit={form.handleSubmit(onComplete)} className="space-y-4">
        <FormField
          control={form.control}
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Full Name</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="name" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* More form fields... */}

        <Button type="submit" className="w-full">
          Continue to Payment
        </Button>
      </form>
    </div>
  );
}
```

---

## Deep Dive 5: Performance Optimization

### Route Prefetching

```tsx
// components/ProductCard.tsx
import { useRouter } from '@tanstack/react-router';

export function ProductCard({ product }: ProductCardProps) {
  const router = useRouter();

  const handleMouseEnter = () => {
    // Prefetch product detail page on hover
    router.preloadRoute({
      to: '/products/$productId',
      params: { productId: product.id }
    });
  };

  return (
    <Link
      to={`/products/${product.id}`}
      className="group block"
      onMouseEnter={handleMouseEnter}
    >
      {/* Card content */}
    </Link>
  );
}
```

### Image Optimization

```tsx
// components/OptimizedImage.tsx
interface OptimizedImageProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
}

export function OptimizedImage({ src, alt, width, height, priority = false }: OptimizedImageProps) {
  const [isLoaded, setIsLoaded] = useState(false);

  // Generate srcset for responsive images
  const sizes = [0.5, 1, 1.5, 2];
  const srcSet = sizes
    .map(scale => `${src}?w=${Math.round(width * scale)} ${scale}x`)
    .join(', ');

  return (
    <div className="relative overflow-hidden" style={{ aspectRatio: `${width}/${height}` }}>
      {/* Blur placeholder */}
      {!isLoaded && (
        <div className="absolute inset-0 bg-gray-200 animate-pulse" />
      )}

      <img
        src={src}
        srcSet={srcSet}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? 'eager' : 'lazy'}
        decoding={priority ? 'sync' : 'async'}
        onLoad={() => setIsLoaded(true)}
        className={cn(
          'w-full h-full object-cover transition-opacity duration-300',
          isLoaded ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  );
}
```

### Service Worker for Offline Cart

```typescript
// sw.ts
const CACHE_NAME = 'amazon-v1';
const STATIC_ASSETS = [
  '/',
  '/cart',
  '/offline.html'
];

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;

  // Handle cart API when offline
  if (request.url.includes('/api/cart') && request.method === 'GET') {
    event.respondWith(
      fetch(request).catch(() => {
        // Return cached cart data when offline
        return caches.match('/api/cart') || new Response(
          JSON.stringify({ items: [] }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Handle product pages with stale-while-revalidate
  if (request.url.includes('/api/products/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request).then(response => {
          cache.put(request, response.clone());
          return response;
        });

        return cached || networkPromise;
      })
    );
  }
});
```

---

## State Management Summary

```typescript
// Store organization
stores/
├── cartStore.ts      // Shopping cart with persistence
├── userStore.ts      // Auth state and user preferences
├── searchStore.ts    // Recent searches, filter preferences
└── uiStore.ts        // UI state (modals, drawers)

// TanStack Query for server state
hooks/
├── useProduct.ts          // Single product query
├── useSearchProducts.ts   // Infinite search results
├── useRecommendations.ts  // Product recommendations
├── useOrders.ts           // Order history
└── useCheckout.ts         // Checkout mutations
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State management | Zustand + TanStack Query | Redux | Simpler for cart, Query handles server cache |
| Routing | TanStack Router | React Router | Type-safe, file-based, better prefetching |
| Cart persistence | LocalStorage + API | Cookie | Larger capacity, works offline |
| Image loading | Lazy + blur placeholder | Eager | Better LCP for visible, saves bandwidth |
| Search virtualization | @tanstack/virtual | windowing | Better for variable heights |
| Form handling | React Hook Form + Zod | Formik | Better TypeScript, validation co-location |

---

## Future Frontend Enhancements

1. **React Server Components**: Server-render product pages for better SEO and LCP
2. **Streaming SSR**: Progressive hydration for faster TTI
3. **View Transitions API**: Smooth page transitions between products
4. **Web Push Notifications**: Order status updates, price drop alerts
5. **AR Product Preview**: 3D product visualization using WebXR
6. **Voice Search**: Web Speech API for hands-free shopping
7. **Accessibility Audit**: Full screen reader testing, keyboard navigation improvements
