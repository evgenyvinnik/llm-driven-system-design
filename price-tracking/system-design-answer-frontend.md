# Price Tracking Service - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 📋 Problem Statement

Design a price tracking service similar to CamelCamelCamel or Honey. This system monitors product prices across e-commerce sites, stores historical data, and alerts users when prices drop. The frontend challenge is building an intuitive dashboard with interactive price charts, responsive design, and efficient rendering for large datasets.

---

## 🎯 Requirements Clarification (3 minutes)

### Functional Requirements
- **Product Tracking**: Users add products from various e-commerce sites
- **Price History Charts**: Interactive visualizations of price trends
- **Alert Management**: Configure and manage price drop alerts
- **Product Dashboard**: View all tracked products with current prices
- **Admin Interface**: Monitor scraper health and system statistics

### UI/UX Requirements
- Responsive design for desktop and mobile
- Interactive charts with zoom, tooltips, and range selection
- Real-time price update indicators
- Intuitive alert configuration with quick-set options
- Fast initial load and smooth scrolling with large product lists

### Non-Functional Requirements
- Dashboard loads in under 2 seconds
- Charts render smoothly with 1000+ data points
- Offline-capable for viewing cached data
- Accessible (WCAG 2.1 AA compliance)

---

## 🏗️ High-Level Frontend Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         FRONTEND APPLICATION                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────┐ │
│  │  Product List  │  │  Price Charts  │  │     Alert Manager          │ │
│  │  (Virtualized) │  │  (Recharts)    │  │     (Modal Forms)          │ │
│  │                │  │                │  │                            │ │
│  │  - Card grid   │  │  - Line chart  │  │  - Target price input      │ │
│  │  - Lazy images │  │  - Range brush │  │  - Alert type selection    │ │
│  │  - Sort/filter │  │  - Tooltips    │  │  - Quick-set buttons       │ │
│  └────────────────┘  └────────────────┘  └────────────────────────────┘ │
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────┐ │
│  │  Add Product   │  │  Product       │  │     Admin Dashboard        │ │
│  │  Form          │  │  Detail View   │  │     (Stats/Config)         │ │
│  │                │  │                │  │                            │ │
│  │  - URL paste   │  │  - Full info   │  │  - Scraper health          │ │
│  │  - Validation  │  │  - History     │  │  - Domain stats            │ │
│  │  - Domain icon │  │  - Actions     │  │  - Queue depth             │ │
│  └────────────────┘  └────────────────┘  └────────────────────────────┘ │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                           STATE MANAGEMENT                               │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                         ZUSTAND STORE                             │   │
│  │                                                                   │   │
│  │   products[]     alerts[]      selectedProduct    ui preferences │   │
│  │   isLoading      error         priceHistory{}     sortOrder      │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                            API SERVICE LAYER                             │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Fetch wrapper with auth headers, error handling, retry logic     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ REST API (JSON)
                                    ▼
                        ┌───────────────────────┐
                        │    Express Backend    │
                        └───────────────────────┘
```

---

## 📊 Deep Dive 1: Price History Charts (8 minutes)

### Chart Component Architecture

```
┌─ PRICE CHART ───────────────────────────────────────────────┐
│  [7d] [30d] [90d] [1y] [All]        range → filters series  │
│                                                              │
│  LOWEST $24.99    AVERAGE $32.50    HIGHEST $45.00          │
│   (green)          (neutral)         (red)                   │
│                                                              │
│  $50 ┤        ╭─╮                                            │
│  $40 ┤       ╱   ╲     ╭──╮                                  │
│  $30 ┤──────╱─────╲───╱────╲───────  Target $28 (dashed)     │
│  $20 ┤────╱────────╲──────── ╲                               │
│      └──┬────┬────┬────┬────┬──                              │
│        Jan  Feb  Mar  Apr  May                               │
│                                                              │
│  [===== brush selector =====]   drag to zoom a date range    │
│                                                              │
│  hover tooltip → "March 15, 2024 · $29.99 · −5.2% ↓"        │
└──────────────────────────────────────────────────────────────┘
```

The target line is the element doing the most work: it turns the chart from a history into an answer to the question the user actually has, which is "am I close yet?" Everything else on the panel is context for that one comparison.

### Chart Data Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  API Fetch   │────▶│   Raw Data   │────▶│   Filter     │
│  /history    │     │  (1000+ pts) │     │   by Range   │
└──────────────┘     └──────────────┘     └──────────────┘
                                                  │
                                                  ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Render     │◀────│   Memoized   │◀────│  Downsample  │
│   Chart      │     │   Data       │     │  if > 500pts │
└──────────────┘     └──────────────┘     └──────────────┘
```

### Data Downsampling Strategy

For charts with thousands of data points, we downsample to maintain performance:

| Data Points | Strategy | Result |
|-------------|----------|--------|
| < 500 | No downsampling | Render all points |
| 500 - 2000 | LTTB algorithm | Preserve visual shape |
| > 2000 | Bucket averaging | Max 500 points |

**LTTB (Largest Triangle Three Buckets)**: Preserves significant price changes while reducing points. Each bucket keeps the point that creates the largest triangle with its neighbors - this maintains price spikes and drops visually.

### Chart Library Alternatives

| Library | ✅/❌ | Reason |
|---------|-------|--------|
| Recharts | ✅ Chosen | React-native, declarative API, good time-series support |
| D3.js | ❌ | Too low-level, requires more code for basic charts |
| Chart.js | ❌ | Canvas-based, harder to customize in React |
| Victory | ❌ | Good but less community support than Recharts |
| Nivo | ❌ | Beautiful but heavier bundle size |

---

## 📋 Deep Dive 2: Product Dashboard with Virtual Scrolling (6 minutes)

### Why Virtualization?

```
WITHOUT VIRTUALIZATION                 WITH VIRTUALIZATION
┌──────────────────────┐              ┌──────────────────────┐
│ Product 1    [DOM]   │              │                      │
│ Product 2    [DOM]   │              │ (above viewport -    │
│ Product 3    [DOM]   │              │  no DOM nodes)       │
│ Product 4    [DOM]   │              │                      │
│ Product 5    [DOM]   │              ├──────────────────────┤
│ ...                  │              │ Product 47   [DOM]   │◀── Visible
│ ...                  │              │ Product 48   [DOM]   │
│ Product 997  [DOM]   │              │ Product 49   [DOM]   │
│ Product 998  [DOM]   │              │ Product 50   [DOM]   │
│ Product 999  [DOM]   │              │ Product 51   [DOM]   │
│ Product 1000 [DOM]   │              ├──────────────────────┤
└──────────────────────┘              │                      │
                                      │ (below viewport -    │
1000 DOM nodes = SLOW                 │  no DOM nodes)       │
Memory: ~200MB                        │                      │
                                      └──────────────────────┘

                                      ~10 DOM nodes = FAST
                                      Memory: ~5MB
```

### Virtual List Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        PRODUCT LIST CONTAINER                            │
│                       (fixed height: 600px)                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  parentRef (scroll container)                                            │
│  │                                                                       │
│  ▼                                                                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Virtual Content Container                                         │  │
│  │  height: getTotalSize() ← sum of all item heights                 │  │
│  │                                                                    │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  │  Spacer: translateY(virtualRow.start)                       │  │  │
│  │  │  ├─────────────────────────────────────────────────────────┤  │  │
│  │  │  │ ┌─────────────────────────────────────────────────────┐ │  │  │
│  │  │  │ │  PRODUCT CARD (overscan -2)                         │ │  │  │
│  │  │  │ │  [Image] Title                    $29.99            │ │  │  │
│  │  │  │ │          amazon.com               -5.2% ↓           │ │  │  │
│  │  │  │ └─────────────────────────────────────────────────────┘ │  │  │
│  │  │  │ ┌─────────────────────────────────────────────────────┐ │  │  │
│  │  │  │ │  PRODUCT CARD (overscan -1)                         │ │  │  │
│  │  │  │ │  [Image] Title                    $45.00            │ │  │  │
│  │  │  │ │          walmart.com              +2.1% ↑           │ │  │  │
│  │  │  │ └─────────────────────────────────────────────────────┘ │  │  │
│  │  │  ├─────── VISIBLE VIEWPORT ─────────────────────────────┤  │  │
│  │  │  │ ┌─────────────────────────────────────────────────────┐ │  │  │
│  │  │  │ │  PRODUCT CARD (visible 0)                          │ │  │  │
│  │  │  │ └─────────────────────────────────────────────────────┘ │  │  │
│  │  │  │ ┌─────────────────────────────────────────────────────┐ │  │  │
│  │  │  │ │  PRODUCT CARD (visible 1)                          │ │  │  │
│  │  │  │ └─────────────────────────────────────────────────────┘ │  │  │
│  │  │  │           ... more visible cards ...                    │  │  │
│  │  │  ├─────────────────────────────────────────────────────────┤  │  │
│  │  │  │  PRODUCT CARD (overscan +1)                             │  │  │
│  │  │  │  PRODUCT CARD (overscan +2)                             │  │  │
│  │  │  └─────────────────────────────────────────────────────────┘  │  │
│  │  │                                                              │  │
│  │  │  (remaining virtual height - no DOM)                         │  │
│  │  │                                                              │  │
│  │  └───────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Product Card Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           PRODUCT CARD                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────┐  ┌──────────────────────────────────┐  ┌────────────────┐ │
│  │          │  │  Sony WH-1000XM5 Headphones      │  │   $278.00      │ │
│  │  [IMG]   │  │  amazon.com                      │  │   -12.3% ↓     │ │
│  │  64x64   │  │  Last updated: 2 hours ago       │  │   (green)      │ │
│  │  lazy    │  │                                  │  │                │ │
│  └──────────┘  └──────────────────────────────────┘  └────────────────┘ │
│                                                                     [●]  │
│                                                            alert active  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Virtualization Library Alternatives

| Library | ✅/❌ | Reason |
|---------|-------|--------|
| @tanstack/react-virtual | ✅ Chosen | Modern API, active maintenance, headless |
| react-window | ❌ | Good but older, less flexible |
| react-virtualized | ❌ | Heavy, complex API |
| Native intersection observer | ❌ | Too manual, reinventing the wheel |

---

## 🔔 Deep Dive 3: Alert Management UI (6 minutes)

### Alert Modal Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ALERT MODAL                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─── Current Price Reference ──────────────────────────────────────┐   │
│  │                                                                   │   │
│  │   Current price:  $349.99                                        │   │
│  │   Historical low: $279.99 (March 2024)                           │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─── Alert Type Selection ─────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │   Alert when price is:                                           │   │
│  │                                                                   │   │
│  │   ┌─────────┐  ┌─────────┐  ┌────────────┐                       │   │
│  │   │  BELOW  │  │  ABOVE  │  │ CHANGES BY │                       │   │
│  │   │ (active)│  │         │  │     %      │                       │   │
│  │   └─────────┘  └─────────┘  └────────────┘                       │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─── Target Price Input ───────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │   Target price:  $ [ 299.99          ]                           │   │
│  │                                                                   │   │
│  │   Quick set:  [ -10% ]  [ -20% ]  [ -30% ]                       │   │
│  │               ($314.99) ($279.99) ($244.99)                       │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─── Additional Options ───────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │   [✓] Also notify me on any price drop                           │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─── Actions ──────────────────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │          [ Cancel ]              [ Create Alert ]                 │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Alert Types Explained

| Type | Trigger Condition | Use Case |
|------|-------------------|----------|
| Below | price < target | "Alert me when under $300" |
| Above | price > target | Stock alerts, arbitrage |
| Change % | abs(change) > threshold | Unusual price movement |

### Alert Form Validation Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  User Input  │────▶│   Zod        │────▶│   Valid?     │
│  target=$299 │     │   Schema     │     │              │
└──────────────┘     └──────────────┘     └───────┬──────┘
                                                   │
                     ┌─────────────────────────────┴─────┐
                     │                                   │
                     ▼                                   ▼
              ┌──────────────┐                   ┌──────────────┐
              │   Yes:       │                   │   No:        │
              │   Submit to  │                   │   Show error │
              │   API        │                   │   message    │
              └──────────────┘                   └──────────────┘
```

### Validation Rules

| Field | Rule | Error Message |
|-------|------|---------------|
| targetPrice | positive number | "Price must be positive" |
| targetPrice | < 1,000,000 | "Price too high" |
| alertType | enum | "Select alert type" |
| percentage (if %) | 1-100 | "Invalid percentage" |

---

## ➕ Deep Dive 4: Add Product Form (5 minutes)

### URL Validation Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ADD PRODUCT FORM                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─── URL Input ────────────────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │  Paste product URL:                                              │   │
│  │                                                                   │   │
│  │  ┌────────────────────────────────────────────────────┐ ┌──────┐ │   │
│  │  │ https://amazon.com/dp/B09XS7JWHH                   │ │Track │ │   │
│  │  │                                               [✓]  │ │Price │ │   │
│  │  └────────────────────────────────────────────────────┘ └──────┘ │   │
│  │                                                                   │   │
│  │  Supported: amazon.com, walmart.com, bestbuy.com, target.com     │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Domain Validation Process

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  User pastes     │────▶│  Parse URL       │────▶│  Extract domain  │
│  product URL     │     │  (try/catch)     │     │  (hostname)      │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                                                           │
                                                           ▼
                                                  ┌──────────────────┐
                                                  │  Check against   │
                                                  │  SUPPORTED_LIST  │
                                                  └──────────────────┘
                                                           │
                         ┌─────────────────────────────────┴─────┐
                         │                                       │
                         ▼                                       ▼
                  ┌─────────────┐                         ┌─────────────┐
                  │  Supported  │                         │    Not      │
                  │  ✓ green    │                         │  Supported  │
                  │  Enable btn │                         │  ✗ red      │
                  └─────────────┘                         │  Disable btn│
                                                          └─────────────┘
```

### Supported Domains Table

| Domain | Parser Status | Notes |
|--------|---------------|-------|
| amazon.com | Active | Multiple country variants |
| walmart.com | Active | Pickup prices vary |
| bestbuy.com | Active | Member pricing different |
| target.com | Active | Circle prices supported |
| ebay.com | Active | Buy-it-now only |
| newegg.com | Planned | Electronics focus |

### Add Product Success Flow

```
User submits URL
       │
       ▼
┌──────────────────┐
│  Show loading    │
│  spinner on btn  │
└──────────────────┘
       │
       ▼
┌──────────────────┐     ┌──────────────────┐
│  POST /products  │────▶│  Backend scrapes │
│  { url: "..." }  │     │  initial price   │
└──────────────────┘     └──────────────────┘
       │                          │
       │                          │ (2-5 seconds)
       │                          │
       ▼                          ▼
┌──────────────────┐     ┌──────────────────┐
│  Response with   │◀────│  Return product  │
│  new product     │     │  with price      │
└──────────────────┘     └──────────────────┘
       │
       ▼
┌──────────────────┐
│  Add to list     │
│  (prepend)       │
│  Clear input     │
│  Show success    │
└──────────────────┘
```

---

## 🗄️ Deep Dive 5: State Management (5 minutes)

### Zustand Store Architecture

| Slice | Contents | Persisted? |
|-------|----------|------------|
| Server state | `products[]`, `alerts[]`, `priceHistory{}` (cached by productId) | No — always refetched |
| UI state | `selectedProduct`, `isLoading`, `error`, `sortOrder`, `filterDomain` | Only the user's *choices*: selectedProduct, sortOrder, filterDomain |
| Product actions | `fetchProducts`, `addProduct(url)`, `removeProduct(id)` (optimistic), `selectProduct(p)` | — |
| Alert actions | `fetchAlerts`, `createAlert`, `updateAlert`, `deleteAlert` | — |

> "The persistence split is the part I'd call out. Persisting `products` would mean a returning user sees yesterday's prices as though they were current — on a price tracker, stale data isn't a stale UI, it's a wrong answer. So server state is always refetched and only the user's own choices survive a reload.

### Optimistic Update Pattern

Deleting a product snapshots the current `products` array, removes the item from the UI immediately (no spinner), then fires the API `DELETE`. On success there's nothing more to do; on failure the store restores the snapshot and shows an error toast. Because a delete almost always succeeds, optimizing for the common case makes the UI feel instant, and the rollback path keeps it honest when the rare failure happens.

### State Management Alternatives

| Library | ✅/❌ | Reason |
|---------|-------|--------|
| Zustand | ✅ Chosen | Simple API, minimal boilerplate, good TypeScript |
| Redux Toolkit | ❌ | Overkill for this app size |
| React Context | ❌ | Re-render issues with frequent updates |
| Jotai | ❌ | Similar to Zustand, less popular |
| TanStack Query | ❌ | Would use for data fetching, not global state |

---

## 📱 Deep Dive 6: Responsive Design (4 minutes)

### Breakpoint Strategy

| Breakpoint | Width | Layout |
|------------|-------|--------|
| Mobile | < 640px | Single column, modal details |
| Tablet | 640-1023px | Two column, side panel |
| Desktop | ≥ 1024px | Three column, inline details |

### Responsive Layout Pattern

The layout collapses across the breakpoints above. **Mobile** is a single scrolling column of product cards; tapping one opens a full-screen modal holding the chart and alert form (no room for a side panel). **Tablet** becomes a two-pane list + detail panel, so a selected product's chart and alerts sit beside the list. **Desktop** widens the same two panes into a sidebar list + roomy main detail area with chart and alert form stacked. Crucially the detail view is one component throughout — only its container (modal vs. panel) changes — so there's a single code path for product detail, not three.

### Mobile-First Approach

CSS is authored mobile-first: the base `.product-grid` is a single-column grid, and `min-width` media queries progressively add columns (two at ~640px, a sidebar+main ratio at ~1024px). Starting from the constrained layout and adding space as it becomes available is more robust than starting wide and clawing columns back — the default state is the one that always works.

---

## ⚖️ Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| Charts | ✅ Recharts | ❌ D3, Chart.js | React-native API, good time-series |
| State | ✅ Zustand | ❌ Redux, Context | Simple, minimal boilerplate |
| Virtualization | ✅ TanStack Virtual | ❌ react-window | Modern API, headless |
| Styling | ✅ Tailwind CSS | ❌ CSS Modules | Rapid development, consistent |
| Data Fetching | ✅ Custom hooks | ❌ TanStack Query | Simpler for this scale |
| Routing | ✅ TanStack Router | ❌ React Router | Type-safe routes |
| Validation | ✅ Zod | ❌ Yup, manual | TypeScript inference |
| Date Handling | ✅ date-fns | ❌ Moment, Day.js | Tree-shakeable, immutable |

---

## 🚀 Future Frontend Enhancements

1. **Browser Extension**: Quick add products while browsing e-commerce sites
2. **WebSocket Updates**: Real-time price change notifications pushed to client
3. **Progressive Web App**: Offline viewing of tracked products and charts
4. **Comparison View**: Compare price history of multiple products on same chart
5. **Export/Share**: Export price history data as CSV, share tracking lists
6. **Dark Mode**: Theme toggle with system preference detection
7. **Accessibility Audit**: Full WCAG 2.1 AA compliance verification
8. **Performance Monitoring**: Track Core Web Vitals, chart render times
