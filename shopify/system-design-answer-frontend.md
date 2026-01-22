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
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Browser/Client                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────┐  ┌───────────────────┐  ┌────────────────────────┐   │
│  │   Storefront App  │  │   Admin Dashboard │  │  Cart Session Storage  │   │
│  │                   │  │                   │  │                        │   │
│  │ - Product Grid    │  │ - Product CRUD    │  │ - localStorage backup  │   │
│  │ - Product Detail  │  │ - Order Mgmt      │  │ - Server sync on change│   │
│  │ - Cart View       │  │ - Analytics       │  │ - Session ID in header │   │
│  │ - Checkout Flow   │  │ - Settings        │  │                        │   │
│  └───────────────────┘  └───────────────────┘  └────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              State Management                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                           Zustand Stores                                 │ │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────────┐ │ │
│  │  │  useAuthStore   │  │useStorefrontStore│  │     useStoreStore       │ │ │
│  │  │ - user          │  │ - products       │  │ - currentStore          │ │ │
│  │  │ - token         │  │ - cart           │  │ - storeSettings         │ │ │
│  │  │ - login()       │  │ - store theme    │  │ - products (admin)      │ │ │
│  │  │ - logout()      │  │ - fetchProducts()│  │ - orders (admin)        │ │ │
│  │  └─────────────────┘  └──────────────────┘  └─────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              API Layer                                        │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                        services/api.ts                                   │ │
│  │  - Fetch wrapper with error handling                                     │ │
│  │  - Cart session ID attached to requests                                  │ │
│  │  - Idempotency key for checkout                                          │ │
│  │  - Optimistic updates with rollback                                      │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Backend Services                                 │
│  ┌──────────────────┐  ┌───────────────────┐  ┌─────────────────────────┐   │
│  │  Store Service   │  │  Product Service  │  │    Checkout Service     │   │
│  │  /api/stores     │  │  /api/products    │  │    /api/checkout        │   │
│  └──────────────────┘  └───────────────────┘  └─────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Deep Dives

### Deep Dive 1: Storefront Component Architecture (10 minutes)

**Component Hierarchy:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           StorefrontLayout                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Header (logo, cart icon with badge, navigation)                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Outlet (route content)                                                │  │
│  │  ├── ProductsView ──▶ ProductCard[] (image, title, price, add to cart)│  │
│  │  ├── ProductDetailView                                                 │  │
│  │  │   ├── ImageGallery                                                  │  │
│  │  │   ├── VariantSelector                                               │  │
│  │  │   └── AddToCartButton                                               │  │
│  │  ├── CartView                                                          │  │
│  │  │   ├── CartItem (per line item)                                      │  │
│  │  │   └── CartSummary (subtotal, checkout button)                       │  │
│  │  ├── CheckoutView                                                      │  │
│  │  │   ├── ShippingForm                                                  │  │
│  │  │   ├── PaymentForm (Stripe Elements)                                 │  │
│  │  │   └── OrderSummary                                                  │  │
│  │  └── SuccessView (order confirmation)                                  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  Footer (store info, links)                                            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**ProductsView Behavior:**
- Fetches products on mount using subdomain parameter
- Displays responsive grid (1 column mobile, 2 tablet, 3-4 desktop)
- Shows loading spinner, error state, or empty state as appropriate
- Each ProductCard handles add-to-cart with event propagation stopped

**ProductCard with Theme Support:**
- Receives primaryColor from store theme
- Displays product image with lazy loading and hover zoom effect
- Shows "Out of Stock" overlay when inventory is zero
- Add to Cart button uses theme's primary color

**Theme Application via CSS Custom Properties:**
- Store theme includes: primaryColor, backgroundColor, textColor, logoUrl, fontFamily
- Applied via inline style with CSS custom properties
- Components reference `--primary-color`, `--bg-color`, `--text-color`

---

### Deep Dive 2: Cart State Management and Persistence (8 minutes)

**Problem:** Cart must persist across page refreshes, browser tabs, and even after the user closes the browser and returns later.

**Solution Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Cart Synchronization Flow                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌────────────────────────┐ │
│  │   User Action    │───▶│   Zustand Store  │───▶│   localStorage Cache   │ │
│  │  (Add to cart)   │    │   (cart state)   │    │   (backup persistence) │ │
│  └──────────────────┘    └────────┬─────────┘    └────────────────────────┘ │
│                                   │                         │                │
│                                   ▼                         │                │
│                          ┌──────────────────┐               │                │
│                          │   API Request    │               │                │
│                          │   POST /cart     │               │                │
│                          │   X-Cart-Session │               │                │
│                          └────────┬─────────┘               │                │
│                                   │                         │                │
│                                   ▼                         │                │
│                          ┌──────────────────┐               │                │
│                          │   Server Cart    │◀──────────────┘                │
│                          │  (Valkey/Redis)  │  (Restore on new session)     │
│                          └──────────────────┘                                │
│                                                                              │
│  Optimistic UI Update (immediate feedback) + Rollback if API fails          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Zustand Store with Persist Middleware:**

| State Property | Type | Purpose |
|---------------|------|---------|
| cart | CartItem[] | Current cart items |
| cartSessionId | string | Session ID for server sync |
| cartTotal | number | Computed total |
| isCartLoading | boolean | Loading state |
| cartError | string | Error message |

**Cart Actions:**
- **addToCart**: Optimistic update, then sync to server, rollback on failure
- **updateQuantity**: Clamp to maxQuantity, optimistic update pattern
- **removeFromCart**: Filter item, sync deletion
- **initializeCart**: Check localStorage for existing session, restore from server or create new

**Cart Session Header Injection:**
- API client wrapper automatically attaches X-Cart-Session header
- Session ID stored in both Zustand state and localStorage
- Fallback to localStorage on page reload before Zustand rehydrates

---

### Deep Dive 3: Checkout Flow with Payment Integration (8 minutes)

**Multi-Step Checkout Design:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Checkout Flow Steps                                 │
├─────────────────────────────────────────────────────────────────────────────┤
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
│  ◀ Back                                        Continue / Place Order ▶     │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Checkout State Machine:**

| Step | Form Fields | Validation | Next Action |
|------|-------------|------------|-------------|
| information | email, address, phone | Required fields, valid email | Continue to shipping |
| shipping | shipping method selection | Required selection | Continue to payment |
| payment | Stripe card element | Card complete, no errors | Place Order |

**Payment Flow:**

```
┌─────────────┐    ┌──────────────────┐    ┌───────────────┐    ┌──────────────┐
│ User clicks │───▶│ Create checkout  │───▶│ Confirm with  │───▶│ Navigate to  │
│ Place Order │    │ on server (gets  │    │ Stripe        │    │ success page │
│             │    │ clientSecret,    │    │ (confirmPaymt)│    │ Clear cart   │
│             │    │ orderId)         │    │               │    │              │
└─────────────┘    └──────────────────┘    └───────────────┘    └──────────────┘
```

**Idempotency Key Generation:**
- Format: `checkout_{cartSessionId}_{timestamp}`
- Generated once per checkout attempt with useMemo
- Prevents duplicate charges on network retry

**Stripe Elements Integration:**
- PaymentElement with layout: 'tabs'
- onChange handler tracks completion state
- Disabled submit button until card is complete
- Error display in red alert box

**Error Handling:**
- Stripe errors displayed inline
- Server errors caught and shown
- Processing state with spinner prevents double-submit

---

### Deep Dive 4: Admin Dashboard Architecture (8 minutes)

**Tab-Based Navigation Layout:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Admin Dashboard Layout                                                      │
├─────────────────────────────────────────────────────────────────────────────┤
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

**Admin Dashboard Components:**

| Tab | Purpose | Key Features |
|-----|---------|--------------|
| Dashboard | Overview metrics | Revenue, orders, top products |
| Products | Product CRUD | Table view, create/edit modal, status toggle |
| Orders | Order fulfillment | Status filter, fulfill action |
| Customers | Customer list | Email, order count |
| Settings | Store configuration | Theme, domain, payment |

**ProductsTab CRUD Operations:**

| Operation | UI Trigger | Optimistic Update | Rollback |
|-----------|-----------|-------------------|----------|
| Create | Modal form submit | Add to list | Remove from list |
| Update | Modal form submit | Replace in list | Restore original |
| Delete | Confirm dialog | Remove from list | Re-add to list |
| Status Toggle | Toggle button | Flip status | Flip back |

**OrdersTab Status Management:**

| Status | Badge Color | Available Action |
|--------|-------------|------------------|
| pending | Yellow | - |
| processing | Blue | Mark Shipped |
| shipped | Purple | - |
| delivered | Green | - |
| cancelled | Red | - |

**Orders Filter:**
- Dropdown with "All Orders" plus each status option
- Client-side filtering from loaded orders array
- Filter updates displayed list immediately

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
