# Shopify - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 1. Problem Statement (2 minutes)

We are designing a multi-tenant e-commerce platform where merchants create branded online stores, manage products, and customers complete purchases through a seamless checkout experience.

**Frontend Scope:**
- **Storefront Interface** - Customer-facing product browsing, cart, and checkout
- **Admin Dashboard** - Merchant product management, order fulfillment, analytics
- **Theme System** - Customizable branding per store
- **Real-time Updates** - Inventory availability, cart synchronization

---

## 2. Requirements Clarification (3 minutes)

**Functional Requirements:**
1. Responsive storefront with product catalog and search
2. Shopping cart with session persistence
3. Multi-step checkout with payment integration
4. Admin dashboard for product CRUD and order management
5. Store branding customization (colors, logo, theme)

**Non-Functional Requirements:**
- **Performance:** Product pages load under 2 seconds
- **Accessibility:** WCAG 2.1 AA compliance for storefront
- **Mobile-First:** 60%+ traffic expected from mobile devices
- **Offline Resilience:** Cart persists across sessions/page refreshes

**Clarifying Questions:**
- "Do we support multiple currencies/locales?" (Yes, format prices per store settings)
- "Is real-time inventory critical?" (Show availability, graceful degradation acceptable)
- "Do merchants need a mobile admin app?" (No, responsive web is sufficient)

---

## 3. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              Frontend Architecture                               │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────────┐
│                              Browser/Client                                       │
│  ┌───────────────────┐  ┌───────────────────┐  ┌────────────────────────────┐   │
│  │   Storefront App  │  │   Admin Dashboard │  │    Cart Session Storage    │   │
│  │                   │  │                   │  │                            │   │
│  │ - Product Grid    │  │ - Product CRUD    │  │ - localStorage backup      │   │
│  │ - Product Detail  │  │ - Order Mgmt      │  │ - Server sync on change    │   │
│  │ - Cart View       │  │ - Analytics       │  │ - Session ID in header     │   │
│  │ - Checkout Flow   │  │ - Settings        │  │                            │   │
│  └───────────────────┘  └───────────────────┘  └────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              State Management                                     │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                           Zustand Stores                                     │ │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────────────┐ │ │
│  │  │  useAuthStore   │  │ useStorefrontStore│  │     useStoreStore          │ │ │
│  │  │                 │  │                  │  │                             │ │ │
│  │  │ - user          │  │ - products       │  │ - currentStore              │ │ │
│  │  │ - token         │  │ - cart           │  │ - storeSettings             │ │ │
│  │  │ - login()       │  │ - store theme    │  │ - products (admin)          │ │ │
│  │  │ - logout()      │  │ - fetchProducts()│  │ - orders (admin)            │ │ │
│  │  └─────────────────┘  └──────────────────┘  └─────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              API Layer                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │                        services/api.ts                                       │ │
│  │                                                                              │ │
│  │  - Fetch wrapper with error handling                                         │ │
│  │  - Cart session ID attached to requests                                      │ │
│  │  - Idempotency key for checkout                                              │ │
│  │  - Optimistic updates with rollback                                          │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              Backend Services                                     │
│  ┌──────────────────┐  ┌───────────────────┐  ┌─────────────────────────────┐   │
│  │  Store Service   │  │  Product Service  │  │      Checkout Service       │   │
│  │  /api/stores     │  │  /api/products    │  │      /api/checkout          │   │
│  └──────────────────┘  └───────────────────┘  └─────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Deep Dives

### Deep Dive 1: Storefront Component Architecture (10 minutes)

**Component Hierarchy:**

```
StorefrontLayout
├── Header (logo, cart icon with badge, navigation)
├── Outlet (route content)
│   ├── ProductsView (product grid)
│   │   └── ProductCard (image, title, price, add to cart)
│   ├── ProductDetailView (single product with variants)
│   │   ├── ImageGallery
│   │   ├── VariantSelector
│   │   └── AddToCartButton
│   ├── CartView
│   │   ├── CartItem (per line item)
│   │   └── CartSummary (subtotal, checkout button)
│   ├── CheckoutView
│   │   ├── ShippingForm
│   │   ├── PaymentForm (Stripe Elements)
│   │   └── OrderSummary
│   └── SuccessView (order confirmation)
└── Footer (store info, links)
```

**ProductsView Implementation:**

```tsx
/**
 * Product grid with responsive layout.
 * Fetches products on mount and displays in a responsive grid.
 */
export function ProductsView({ subdomain }: ProductsViewProps) {
  const { products, fetchProducts, isLoading, error } = useStorefrontStore();

  useEffect(() => {
    fetchProducts(subdomain);
  }, [subdomain, fetchProducts]);

  if (isLoading) return <LoadingSpinner />;
  if (error) return <EmptyState message="Failed to load products" />;
  if (products.length === 0) return <EmptyState message="No products found" />;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      {products.map(product => (
        <ProductCard
          key={product.id}
          product={product}
          onAddToCart={handleAddToCart}
          onSelect={() => navigate(`/store/${subdomain}/product/${product.id}`)}
        />
      ))}
    </div>
  );
}
```

**ProductCard with Theme Support:**

```tsx
interface ProductCardProps {
  product: Product;
  primaryColor: string;  // From store theme
  onSelectProduct: () => void;
  onAddToCart: () => void;
}

export function ProductCard({ product, primaryColor, onSelectProduct, onAddToCart }: ProductCardProps) {
  const { title, price, images, inventory_quantity } = product;
  const isOutOfStock = inventory_quantity === 0;

  return (
    <div
      className="group border rounded-lg overflow-hidden hover:shadow-lg transition-shadow"
      onClick={onSelectProduct}
    >
      {/* Product Image */}
      <div className="aspect-square bg-gray-100 relative overflow-hidden">
        {images[0] ? (
          <img
            src={images[0]}
            alt={title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
            loading="lazy"
          />
        ) : (
          <ImagePlaceholderIcon className="w-16 h-16 absolute inset-0 m-auto text-gray-300" />
        )}
        {isOutOfStock && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            <span className="text-white font-medium">Out of Stock</span>
          </div>
        )}
      </div>

      {/* Product Info */}
      <div className="p-4">
        <h3 className="font-medium text-gray-900 truncate">{title}</h3>
        <p className="text-lg font-semibold mt-1">{formatPrice(price)}</p>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onAddToCart();
          }}
          disabled={isOutOfStock}
          className="w-full mt-3 py-2 px-4 rounded-md text-white transition-colors disabled:opacity-50"
          style={{ backgroundColor: primaryColor }}
        >
          {isOutOfStock ? 'Out of Stock' : 'Add to Cart'}
        </button>
      </div>
    </div>
  );
}
```

**Theme Application:**

```tsx
// Store theme from API response
interface StoreTheme {
  primaryColor: string;      // Button colors, accents
  backgroundColor: string;   // Page background
  textColor: string;         // Primary text
  logoUrl: string;           // Header logo
  fontFamily: string;        // Custom font
}

// Apply theme via CSS custom properties
function StorefrontLayout({ theme }: { theme: StoreTheme }) {
  return (
    <div
      style={{
        '--primary-color': theme.primaryColor,
        '--bg-color': theme.backgroundColor,
        '--text-color': theme.textColor,
        fontFamily: theme.fontFamily,
      } as React.CSSProperties}
      className="min-h-screen"
    >
      <Header logo={theme.logoUrl} />
      <main className="container mx-auto px-4 py-8">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
```

---

### Deep Dive 2: Cart State Management and Persistence (8 minutes)

**Problem:** Cart must persist across page refreshes, browser tabs, and even after the user closes the browser and returns later.

**Solution Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Cart Synchronization Flow                            │
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌────────────────────────┐ │
│  │   User Action    │ -> │   Zustand Store  │ -> │   localStorage Cache   │ │
│  │  (Add to cart)   │    │   (cart state)   │    │   (backup persistence) │ │
│  └──────────────────┘    └──────────────────┘    └────────────────────────┘ │
│           │                      │                         │                 │
│           │                      ▼                         │                 │
│           │              ┌──────────────────┐              │                 │
│           │              │   API Request    │              │                 │
│           │              │   POST /cart     │              │                 │
│           │              │   X-Cart-Session │              │                 │
│           │              └──────────────────┘              │                 │
│           │                      │                         │                 │
│           │                      ▼                         │                 │
│           │              ┌──────────────────┐              │                 │
│           │              │   Server Cart    │ <────────────┘                 │
│           │              │   (Valkey/Redis) │   (Restore on new session)    │
│           │              └──────────────────┘                                │
│           ▼                                                                  │
│    Optimistic UI Update (immediate feedback)                                 │
│    + Rollback if API fails                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Zustand Store Implementation:**

```typescript
interface CartItem {
  variantId: number;
  productId: number;
  title: string;
  variantTitle: string;
  price: number;
  quantity: number;
  imageUrl?: string;
  maxQuantity: number;  // Inventory limit
}

interface StorefrontStore {
  // Cart state
  cart: CartItem[];
  cartSessionId: string | null;
  cartTotal: number;
  isCartLoading: boolean;
  cartError: string | null;

  // Actions
  addToCart: (product: Product, variantId: number, quantity?: number) => Promise<void>;
  updateQuantity: (variantId: number, quantity: number) => Promise<void>;
  removeFromCart: (variantId: number) => Promise<void>;
  clearCart: () => void;

  // Sync
  initializeCart: (subdomain: string) => Promise<void>;
  syncCartWithServer: () => Promise<void>;
}

export const useStorefrontStore = create<StorefrontStore>()(
  persist(
    (set, get) => ({
      cart: [],
      cartSessionId: null,
      cartTotal: 0,
      isCartLoading: false,
      cartError: null,

      addToCart: async (product, variantId, quantity = 1) => {
        const { cart, cartSessionId } = get();
        const existingItem = cart.find(item => item.variantId === variantId);

        // Optimistic update
        const newCart = existingItem
          ? cart.map(item =>
              item.variantId === variantId
                ? { ...item, quantity: item.quantity + quantity }
                : item
            )
          : [...cart, {
              variantId,
              productId: product.id,
              title: product.title,
              variantTitle: product.variants.find(v => v.id === variantId)?.title || '',
              price: product.variants.find(v => v.id === variantId)?.price || product.price,
              quantity,
              imageUrl: product.images[0],
              maxQuantity: product.variants.find(v => v.id === variantId)?.inventory_quantity || 99,
            }];

        set({ cart: newCart, cartTotal: calculateTotal(newCart) });

        // Sync with server
        try {
          await api.addToCart(cartSessionId, variantId, quantity);
        } catch (error) {
          // Rollback on failure
          set({ cart, cartTotal: calculateTotal(cart), cartError: 'Failed to add item' });
          throw error;
        }
      },

      updateQuantity: async (variantId, quantity) => {
        const { cart, cartSessionId } = get();
        const previousCart = [...cart];

        // Optimistic update
        const newCart = quantity === 0
          ? cart.filter(item => item.variantId !== variantId)
          : cart.map(item =>
              item.variantId === variantId
                ? { ...item, quantity: Math.min(quantity, item.maxQuantity) }
                : item
            );

        set({ cart: newCart, cartTotal: calculateTotal(newCart) });

        try {
          await api.updateCartItem(cartSessionId, variantId, quantity);
        } catch (error) {
          set({ cart: previousCart, cartTotal: calculateTotal(previousCart) });
          throw error;
        }
      },

      initializeCart: async (subdomain) => {
        set({ isCartLoading: true });

        // Check for existing session
        let sessionId = get().cartSessionId || localStorage.getItem(`cart_session_${subdomain}`);

        if (sessionId) {
          try {
            const serverCart = await api.getCart(subdomain, sessionId);
            set({
              cart: serverCart.items,
              cartSessionId: sessionId,
              cartTotal: serverCart.total,
              isCartLoading: false
            });
            return;
          } catch {
            // Session expired, will create new one
          }
        }

        // Create new session
        const { sessionId: newSessionId } = await api.createCartSession(subdomain);
        localStorage.setItem(`cart_session_${subdomain}`, newSessionId);
        set({ cartSessionId: newSessionId, cart: [], cartTotal: 0, isCartLoading: false });
      },
    }),
    {
      name: 'shopify-cart',
      partialize: (state) => ({
        cart: state.cart,
        cartSessionId: state.cartSessionId
      }),
    }
  )
);
```

**Cart Session Header Injection:**

```typescript
// services/api.ts
const apiClient = {
  fetch: async (url: string, options: RequestInit = {}) => {
    const cartSessionId = useStorefrontStore.getState().cartSessionId;

    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (cartSessionId) {
      headers['X-Cart-Session'] = cartSessionId;
    }

    const response = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      throw new ApiError(response.status, await response.text());
    }

    return response.json();
  },
};
```

---

### Deep Dive 3: Checkout Flow with Payment Integration (8 minutes)

**Multi-Step Checkout Design:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Checkout Flow Steps                                 │
│                                                                              │
│  Step 1: Information     Step 2: Shipping     Step 3: Payment               │
│  ┌─────────────────┐    ┌─────────────────┐   ┌─────────────────────────┐   │
│  │ Email           │    │ Shipping Method │   │ Card Details            │   │
│  │ Shipping Addr   │    │ ○ Standard $5   │   │ (Stripe Elements)       │   │
│  │ Phone (optional)│    │ ● Express $15   │   │ ┌───────────────────┐   │   │
│  └─────────────────┘    └─────────────────┘   │ │ 4242 4242 4242... │   │   │
│                                                │ └───────────────────┘   │   │
│                                                │ Pay $X.XX              │   │
│                                                └─────────────────────────┘   │
│                                                                              │
│  ◄ Back                                        Continue / Place Order ►     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**CheckoutView Implementation:**

```tsx
type CheckoutStep = 'information' | 'shipping' | 'payment';

interface CheckoutFormData {
  email: string;
  shippingAddress: {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  phone?: string;
  shippingMethod: 'standard' | 'express';
}

export function CheckoutView({ subdomain }: CheckoutViewProps) {
  const [step, setStep] = useState<CheckoutStep>('information');
  const [formData, setFormData] = useState<CheckoutFormData>(initialFormData);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { cart, cartTotal, cartSessionId, clearCart } = useStorefrontStore();
  const stripe = useStripe();
  const elements = useElements();
  const navigate = useNavigate();

  // Generate idempotency key once per checkout attempt
  const idempotencyKey = useMemo(() =>
    `checkout_${cartSessionId}_${Date.now()}`,
    [cartSessionId]
  );

  const handleSubmit = async () => {
    if (!stripe || !elements) return;

    setIsProcessing(true);
    setError(null);

    try {
      // 1. Create payment intent on server
      const { clientSecret, orderId } = await api.createCheckout(subdomain, {
        email: formData.email,
        shippingAddress: formData.shippingAddress,
        shippingMethod: formData.shippingMethod,
        idempotencyKey,
      });

      // 2. Confirm payment with Stripe
      const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret,
        confirmParams: {
          return_url: `${window.location.origin}/store/${subdomain}/success?order=${orderId}`,
        },
        redirect: 'if_required',
      });

      if (stripeError) {
        setError(stripeError.message || 'Payment failed');
        return;
      }

      if (paymentIntent?.status === 'succeeded') {
        clearCart();
        navigate(`/store/${subdomain}/success?order=${orderId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-5 gap-8">
      {/* Checkout Form - 3 columns */}
      <div className="lg:col-span-3">
        <StepIndicator currentStep={step} />

        {step === 'information' && (
          <InformationStep
            formData={formData}
            onChange={setFormData}
            onContinue={() => setStep('shipping')}
          />
        )}

        {step === 'shipping' && (
          <ShippingStep
            formData={formData}
            onChange={setFormData}
            onBack={() => setStep('information')}
            onContinue={() => setStep('payment')}
          />
        )}

        {step === 'payment' && (
          <PaymentStep
            isProcessing={isProcessing}
            error={error}
            onBack={() => setStep('shipping')}
            onSubmit={handleSubmit}
          />
        )}
      </div>

      {/* Order Summary - 2 columns */}
      <div className="lg:col-span-2">
        <OrderSummary
          cart={cart}
          subtotal={cartTotal}
          shippingCost={formData.shippingMethod === 'express' ? 15 : 5}
        />
      </div>
    </div>
  );
}
```

**Stripe Elements Integration:**

```tsx
// PaymentStep with Stripe Elements
function PaymentStep({ isProcessing, error, onBack, onSubmit }: PaymentStepProps) {
  const [isCardComplete, setIsCardComplete] = useState(false);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Payment</h2>

      <div className="bg-white border rounded-lg p-4">
        <PaymentElement
          onChange={(e) => setIsCardComplete(e.complete)}
          options={{
            layout: 'tabs',
            defaultValues: {
              billingDetails: {
                name: '', // Will be filled from shipping
              },
            },
          }}
        />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="flex justify-between">
        <button
          onClick={onBack}
          className="text-gray-600 hover:text-gray-900"
        >
          <BackArrowIcon className="w-4 h-4 inline mr-2" />
          Back to shipping
        </button>

        <button
          onClick={onSubmit}
          disabled={!isCardComplete || isProcessing}
          className="bg-blue-600 text-white py-3 px-8 rounded-lg font-medium
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isProcessing ? (
            <>
              <LoadingSpinner size="sm" className="inline mr-2" />
              Processing...
            </>
          ) : (
            'Place Order'
          )}
        </button>
      </div>
    </div>
  );
}
```

---

### Deep Dive 4: Admin Dashboard Architecture (8 minutes)

**Tab-Based Navigation:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Admin Dashboard Layout                                                      │
│                                                                              │
│  ┌───────────┐  ┌─────────────────────────────────────────────────────────┐ │
│  │ Sidebar   │  │  Main Content Area                                      │ │
│  │           │  │                                                         │ │
│  │ Dashboard │  │  ┌─────────────────────────────────────────────────────┐│ │
│  │ Products  │  │  │  ProductsTab                                        ││ │
│  │ Orders    │  │  │  ┌─────────────────────────────────────────────────┐││ │
│  │ Customers │  │  │  │ Product Table                                   │││ │
│  │ Settings  │  │  │  │ ┌───────┬──────┬───────┬────────┬────────────┐ │││ │
│  │           │  │  │  │ │ Image │ Name │ Price │ Status │ Actions    │ │││ │
│  │           │  │  │  │ ├───────┼──────┼───────┼────────┼────────────┤ │││ │
│  │           │  │  │  │ │ [img] │ T... │ $29   │ Active │ Edit | Del │ │││ │
│  │           │  │  │  │ └───────┴──────┴───────┴────────┴────────────┘ │││ │
│  │           │  │  │  │                                                 │││ │
│  │           │  │  │  │ [+ Add Product]                                 │││ │
│  │           │  │  │  └─────────────────────────────────────────────────┘││ │
│  │           │  │  └─────────────────────────────────────────────────────┘│ │
│  └───────────┘  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Admin Route Implementation:**

```tsx
// routes/admin/$storeId.tsx
export function AdminDashboard() {
  const { storeId } = useParams({ from: '/admin/$storeId' });
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const { user, isAuthenticated } = useAuthStore();
  const { currentStore, fetchStore, isLoading } = useStoreStore();

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login', { replace: true });
    }
  }, [isAuthenticated]);

  // Load store data
  useEffect(() => {
    fetchStore(storeId);
  }, [storeId, fetchStore]);

  if (isLoading) return <LoadingSpinner fullScreen />;

  return (
    <AdminLayout
      store={currentStore}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      {activeTab === 'dashboard' && <DashboardTab storeId={storeId} />}
      {activeTab === 'products' && <ProductsTab storeId={storeId} />}
      {activeTab === 'orders' && <OrdersTab storeId={storeId} />}
      {activeTab === 'customers' && <CustomersTab storeId={storeId} />}
      {activeTab === 'settings' && <SettingsTab storeId={storeId} />}
    </AdminLayout>
  );
}
```

**ProductsTab with CRUD Operations:**

```tsx
export function ProductsTab({ storeId }: ProductsTabProps) {
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    loadProducts();
  }, [storeId]);

  const loadProducts = async () => {
    setIsLoading(true);
    try {
      const data = await api.getAdminProducts(storeId);
      setProducts(data);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (productId: number) => {
    if (!confirm('Are you sure you want to delete this product?')) return;

    try {
      await api.deleteProduct(storeId, productId);
      setProducts(products.filter(p => p.id !== productId));
    } catch (error) {
      alert('Failed to delete product');
    }
  };

  const handleStatusToggle = async (product: Product) => {
    const newStatus = product.status === 'active' ? 'draft' : 'active';

    // Optimistic update
    setProducts(products.map(p =>
      p.id === product.id ? { ...p, status: newStatus } : p
    ));

    try {
      await api.updateProduct(storeId, product.id, { status: newStatus });
    } catch {
      // Rollback
      setProducts(products.map(p =>
        p.id === product.id ? { ...p, status: product.status } : p
      ));
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Products</h1>
        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg"
        >
          + Add Product
        </button>
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : products.length === 0 ? (
        <EmptyState
          title="No products yet"
          description="Add your first product to start selling"
          action={{ label: 'Add Product', onClick: () => setShowCreateModal(true) }}
        />
      ) : (
        <ProductTable
          products={products}
          onEdit={setEditingProduct}
          onDelete={handleDelete}
          onStatusToggle={handleStatusToggle}
        />
      )}

      {showCreateModal && (
        <ProductFormModal
          onClose={() => setShowCreateModal(false)}
          onSave={async (data) => {
            const newProduct = await api.createProduct(storeId, data);
            setProducts([...products, newProduct]);
            setShowCreateModal(false);
          }}
        />
      )}

      {editingProduct && (
        <ProductFormModal
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onSave={async (data) => {
            const updated = await api.updateProduct(storeId, editingProduct.id, data);
            setProducts(products.map(p => p.id === updated.id ? updated : p));
            setEditingProduct(null);
          }}
        />
      )}
    </div>
  );
}
```

**OrdersTab with Status Management:**

```tsx
function StatusBadge({ status }: { status: OrderStatus }) {
  const colors = {
    pending: 'bg-yellow-100 text-yellow-800',
    processing: 'bg-blue-100 text-blue-800',
    shipped: 'bg-purple-100 text-purple-800',
    delivered: 'bg-green-100 text-green-800',
    cancelled: 'bg-red-100 text-red-800',
  };

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${colors[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export function OrdersTab({ storeId }: OrdersTabProps) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState<OrderStatus | 'all'>('all');

  const filteredOrders = filter === 'all'
    ? orders
    : orders.filter(o => o.status === filter);

  const handleFulfill = async (orderId: number) => {
    await api.fulfillOrder(storeId, orderId);
    setOrders(orders.map(o =>
      o.id === orderId ? { ...o, status: 'shipped' } : o
    ));
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Orders</h1>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as OrderStatus | 'all')}
          className="border rounded-lg px-3 py-2"
        >
          <option value="all">All Orders</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="shipped">Shipped</option>
          <option value="delivered">Delivered</option>
        </select>
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b">
            <th className="text-left py-3">Order</th>
            <th className="text-left py-3">Customer</th>
            <th className="text-left py-3">Total</th>
            <th className="text-left py-3">Status</th>
            <th className="text-left py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredOrders.map(order => (
            <tr key={order.id} className="border-b">
              <td className="py-3">#{order.order_number}</td>
              <td className="py-3">{order.customer_email}</td>
              <td className="py-3">{formatPrice(order.total)}</td>
              <td className="py-3"><StatusBadge status={order.status} /></td>
              <td className="py-3">
                {order.status === 'processing' && (
                  <button
                    onClick={() => handleFulfill(order.id)}
                    className="text-blue-600 hover:underline"
                  >
                    Mark Shipped
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

---

## 5. Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux | Simpler API, less boilerplate, sufficient for app scale |
| Cart Persistence | localStorage + Server | Server only | Works offline, faster initial loads, server is source of truth |
| Payment UI | Stripe Elements | Custom form | PCI compliance handled by Stripe, reduced liability |
| Styling | Tailwind CSS | CSS Modules | Rapid development, consistent utility classes |
| Routing | Tanstack Router | React Router | Type-safe params, file-based routes |
| Form Handling | Controlled inputs | React Hook Form | Simpler for multi-step checkout, explicit state |
| Admin Layout | Tab-based | Route-based | Faster navigation, preserves scroll position |

---

## 6. Future Enhancements

1. **Real-time Inventory Updates**
   - WebSocket connection for live stock levels
   - Show "Only X left!" warnings dynamically
   - Disable add-to-cart instantly when sold out

2. **Product Image Gallery**
   - Swipeable carousel on mobile
   - Zoom functionality on desktop
   - Lazy loading with blur-up placeholders

3. **Search and Filtering**
   - Debounced search input
   - Faceted filtering (price range, category, in-stock)
   - Search suggestions with product thumbnails

4. **Accessibility Improvements**
   - Focus trap in modals
   - Keyboard navigation for product grid
   - Screen reader announcements for cart updates
   - Color contrast verification for custom themes

5. **Performance Optimizations**
   - Product grid virtualization for large catalogs
   - Skeleton loading states
   - Image srcset for responsive images
   - Service worker for offline browsing

6. **Analytics Integration**
   - Add-to-cart event tracking
   - Checkout funnel analysis
   - Product view heatmaps
