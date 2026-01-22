# Amazon E-Commerce Platform - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement

"Today I'll design an e-commerce platform like Amazon, focusing on end-to-end flows that span frontend and backend. The key technical challenges are building a responsive shopping experience with real-time inventory feedback, implementing a robust checkout flow that prevents overselling while maintaining excellent UX, and creating a search experience with faceted filtering that stays fast at scale. I'll walk through how these components integrate across the stack."

---

## Step 1: Requirements Clarification (3 minutes)

### Functional Requirements

1. **Product Discovery**: Search with faceted filtering, category browsing
2. **Shopping Cart**: Add/remove items with real-time inventory feedback
3. **Checkout Flow**: Multi-step process with payment integration
4. **Order Tracking**: View order history and status updates
5. **Recommendations**: "Also bought" suggestions on product pages

### Non-Functional Requirements

- **Availability**: 99.99% for browsing and cart operations
- **Consistency**: Strong consistency for inventory (no overselling)
- **Latency**: < 100ms for API responses, < 50ms for UI updates
- **Scale**: 100M products, 1M orders/day, 500K concurrent users

### End-to-End Scale Estimates

| Operation | Volume | E2E Latency Target |
|-----------|--------|-------------------|
| Product search | 100K QPS | < 300ms total |
| Add to cart | 10K QPS | < 200ms total |
| Checkout | 1K QPS | < 2s total |
| Page load | 500K concurrent | < 1s TTI |

---

## Step 2: High-Level Architecture (7 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND LAYER                                 │
│    React + TanStack Router + Zustand + TanStack Query                   │
├─────────────────────────────────────────────────────────────────────────┤
│  Product Search  │  Product Detail  │  Shopping Cart  │  Checkout Flow  │
│  - Faceted UI    │  - Image gallery │  - Cart sidebar │  - Multi-step   │
│  - Virtualized   │  - Recommendations  - Quantity      │  - Payment      │
│  - Infinite      │  - Reviews       │  - Inventory    │  - Confirmation │
└────────┬─────────┴────────┬─────────┴────────┬────────┴────────┬────────┘
         │                  │                  │                 │
         ▼                  ▼                  ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           API GATEWAY                                    │
│                    Rate Limiting + Auth + CORS                          │
└────────┬─────────────────┬─────────────────┬────────────────────────────┘
         │                 │                 │
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Catalog Service │ │  Cart Service   │ │  Order Service  │
│ - Search API    │ │ - Cart CRUD     │ │ - Checkout      │
│ - Product API   │ │ - Reservations  │ │ - Idempotency   │
│ - Recommendations│ │ - Inventory    │ │ - Order history │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                     │
├──────────────┬──────────────┬──────────────┬────────────────────────────┤
│  PostgreSQL  │ Elasticsearch│    Valkey    │          Kafka             │
│  - Products  │  - Search    │  - Sessions  │  - Order events            │
│  - Orders    │  - Facets    │  - Cart      │  - Inventory updates       │
│  - Inventory │              │  - Cache     │  - Recommendations         │
└──────────────┴──────────────┴──────────────┴────────────────────────────┘
```

### Why This Architecture?

**Separation of Concerns**: Each service handles one domain, enabling independent scaling and deployment.

**Optimistic UI**: Frontend assumes success and rolls back on failure, providing instant feedback.

**Event-Driven Updates**: Kafka enables async processing (recommendations, notifications) without blocking user flows.

---

## Step 3: End-to-End Add to Cart Flow (10 minutes)

This is the most critical user journey, requiring tight frontend-backend coordination.

### Data Flow Diagram

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   Browser    │   │   Cart API   │   │  PostgreSQL  │   │    Valkey    │
│   (React)    │   │  (Express)   │   │  (Inventory) │   │   (Cache)    │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │                  │
       │ 1. Click "Add"   │                  │                  │
       │ ──────────────▶  │                  │                  │
       │ 2. Optimistic    │                  │                  │
       │    UI Update     │                  │                  │
       │ ◀──────────────  │                  │                  │
       │                  │ 3. BEGIN TRANS   │                  │
       │                  │ ──────────────▶  │                  │
       │                  │ 4. SELECT...     │                  │
       │                  │    FOR UPDATE    │                  │
       │                  │ ──────────────▶  │                  │
       │                  │ 5. Check avail   │                  │
       │                  │ ◀──────────────  │                  │
       │                  │ 6. UPDATE        │                  │
       │                  │    reserved +=   │                  │
       │                  │ ──────────────▶  │                  │
       │                  │ 7. INSERT cart   │                  │
       │                  │ ──────────────▶  │                  │
       │                  │ 8. COMMIT        │                  │
       │                  │ ◀──────────────  │                  │
       │                  │                  │ 9. Invalidate    │
       │                  │                  │    cart cache    │
       │                  │ ─────────────────────────────────▶  │
       │ 10. Confirm      │                  │                  │
       │ ◀──────────────  │                  │                  │
```

### Frontend Implementation

**CartStore (Zustand with persist)**:
- State: `items[]`, `isLoading`, `error`
- Methods: `addItem`, `removeItem`, `updateQuantity`, `clearCart`, `getTotal`

**addItem() Flow**:
1. Store previous items for rollback
2. Optimistic update: add item immediately with 30-min reservation
3. POST to `/api/cart/items`
4. On success: update `reservedUntil` from server response
5. On failure: rollback to previous items, set error

**Rollback Pattern**:
```
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ previousItems │    │   API Call    │    │   Result      │
│    stored     │──▶ │   attempt     │──▶ │               │
└───────────────┘    └───────────────┘    └───────────────┘
                            │                     │
                            │                     ▼
                            │              ┌─────────────┐
                            │              │   Success   │──▶ Update reservedUntil
                            │              └─────────────┘
                            │                     │
                            │              ┌─────────────┐
                            └─────────────▶│   Failure   │──▶ Restore previousItems
                                           └─────────────┘
```

### Backend Implementation

**POST /items Endpoint**:
1. Get connection from pool, BEGIN transaction
2. Lock inventory row with `SELECT ... FOR UPDATE`
3. Check `available = quantity - reserved`
4. If insufficient: throw `InsufficientInventoryError`
5. UPDATE `reserved += quantity`
6. INSERT/UPSERT cart item with `reserved_until`
7. COMMIT transaction
8. Invalidate cart cache in Redis
9. Return cart item

**Error Response**:
- 409 Conflict: `INSUFFICIENT_INVENTORY` with available count
- Frontend can show "Only X units available"

### Error Handling Across the Stack

**Frontend handleAddToCart()**:
- On `InsufficientInventoryError`: toast "Only X available", invalidate product query
- On `ReservationExpiredError`: toast "Expired, try again"
- On generic error: toast "Failed, try again"

---

## Step 4: Search with Faceted Filtering (8 minutes)

### End-to-End Flow

```
User types "wireless headphones"
        │
        ▼
┌──────────────────┐
│ SearchInput.tsx  │──▶ debounce(300ms) ──▶ URL update
│ - Controlled     │                       /search?q=wireless+headphones
│ - Debounced      │
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ useSearchQuery   │──▶ GET /api/search?q=...
│ - Cache 5min     │    TanStack Query
│ - Stale-while-   │
│   revalidate     │
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ Catalog Service  │──▶ Elasticsearch
│ - ES query build │    products index
│ - Aggregations   │
│ - Circuit breaker│
└──────────────────┘
        │
        ▼
┌──────────────────┐
│ SearchResults    │◀── Response:
│ - Virtualized    │    - products[]
│ - Facets sidebar │    - facets{}
│ - Infinite scroll│    - totalCount
└──────────────────┘
```

### Frontend: Search Component

**SearchPage component**:
- Uses `useSearchParams` for URL state
- Extracts: `query`, `category`, `priceMin`, `priceMax`, `brands[]`
- Uses `useInfiniteQuery` for paginated results
- `getNextPageParam`: returns page number if `hasMore`
- `staleTime`: 5 minutes

**Virtualization with TanStack Virtual**:
- `count`: products + 1 (for loading indicator)
- `estimateSize`: 280px per row
- `overscan`: 5 items

**Infinite Scroll Trigger**:
- Watch last virtual item index
- If near end and `hasNextPage`: call `fetchNextPage()`

**Facets Sidebar**:
- Receives `facets` from first page response
- `selected` state from URL params
- `onChange` updates URL params

### Backend: Search API with Fallback

**GET / Handler**:
1. Try Elasticsearch with circuit breaker
2. Build ES query with filters
3. Extract products and facets from response
4. Log search for analytics
5. If circuit open: fallback to PostgreSQL FTS

**Elasticsearch Query Structure**:
- `function_score` for relevance boosting
- `bool.must`: fuzzy match on title
- `bool.filter`: category, price range, brand terms
- Boost factors: in_stock (2x), rating (sqrt, 1.2x)

**Aggregations**:
- `categories`: top 20 terms
- `brands`: top 20 terms
- `price_ranges`: Under $25, $25-50, $50-100, Over $100
- `avg_rating`: average value

**Fallback Strategy**:
```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Elasticsearch  │──X──│ Circuit Breaker │──▶  │  PostgreSQL FTS │
│    Primary      │     │     OPEN        │     │    Fallback     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

---

## Step 5: Checkout Flow (10 minutes)

### Multi-Step Process Overview

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Step 1    │ ─▶ │   Step 2    │ ─▶ │   Step 3    │ ─▶ │   Step 4    │
│  Shipping   │    │   Payment   │    │   Review    │    │ Confirmation│
│             │    │             │    │             │    │             │
│ - Address   │    │ - Card form │    │ - Summary   │    │ - Order ID  │
│ - Validation│    │ - Stripe    │    │ - Edit      │    │ - Email     │
│ - Save      │    │   Elements  │    │ - Place     │    │ - Next steps│
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

### Frontend: Checkout State Machine

**CheckoutFlow component**:
- Uses XState machine for flow control
- Generates `idempotencyKey` on mount
- Renders step indicator with completion status
- Conditionally renders step components

**Step Indicator**:
- Shows checkmark for completed steps
- Highlights current step
- Numbered circles for pending steps

**State Machine Definition**:

```
┌────────────┐    SUBMIT_SHIPPING     ┌────────────┐
│  shipping  │ ─────────────────────▶ │  payment   │
└────────────┘                        └────────────┘
                                            │
                    BACK                    │ SUBMIT_PAYMENT
                    ◀───────────────────────┘
                                            │
                                            ▼
                                      ┌────────────┐
                                      │   review   │
                                      │  ┌──────┐  │
                                      │  │ idle │  │
                                      │  └──┬───┘  │
                                      │     │ PLACE_ORDER
                                      │     ▼      │
                                      │ ┌────────┐ │
                                      │ │placing │ │
                                      │ └──┬─────┘ │
                                      └────┼───────┘
                           onDone ─────────┘└────────── onError
                              │                            │
                              ▼                            ▼
                       ┌─────────────┐              ┌───────────┐
                       │confirmation │              │   error   │
                       │   (final)   │              │  (RETRY)  │
                       └─────────────┘              └───────────┘
```

**Context**:
- `shippingAddress`, `paymentMethod`, `orderId`, `error`, `completedSteps[]`

### Backend: Idempotent Order Creation

**POST / Handler** (11-step process):

1. **Idempotency Check**: Query existing order by key, return cached response
2. **BEGIN Transaction**: Get pooled connection
3. **Get Cart with Lock**: `SELECT ... FOR UPDATE OF inventory`
4. **Verify Availability**: Check all items still available
5. **Calculate Totals**: subtotal + tax (8%) + shipping ($5.99 or free over $50)
6. **Process Payment**: Stripe with `payment-{idempotencyKey}`
7. **Create Order**: INSERT with status `confirmed`
8. **Copy Items**: INSERT order_items FROM cart_items
9. **Commit Inventory**: UPDATE quantity - X, reserved - X
10. **Clear Cart**: DELETE cart_items
11. **COMMIT + Events**: Cache response, emit to Kafka

**Error Handling**:
- 402 Payment Required: `PAYMENT_FAILED`
- Rollback on any error
- Audit log for failed checkouts

---

## Step 6: Data Synchronization Strategy (5 minutes)

### Real-Time Inventory Updates

**Kafka Consumer** (`inventory-sync` group):
- On `INVENTORY_UPDATED`: Update ES document, invalidate Redis cache

**Frontend WebSocket Hook** (`useInventoryUpdates`):
- Subscribe to product IDs
- On message: update query cache with new availability
- If cart item became unavailable: show warning toast

### Search Index Synchronization

**syncProductToElasticsearch()** Background Job:
- Query product with inventory, category, seller joins
- If deleted: remove from index
- Otherwise: index with all searchable fields

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  PostgreSQL │──▶ │  Background │──▶ │Elasticsearch│
│   (source)  │    │    Job      │    │   (index)   │
└─────────────┘    └─────────────┘    └─────────────┘
        │                                    │
        │         ┌─────────────┐            │
        └────────▶│   Valkey    │◀───────────┘
                  │   (cache)   │
                  └─────────────┘
```

---

## Step 7: Key Design Decisions & Trade-offs

### Decision 1: Optimistic UI Updates

| Aspect | Chosen Approach | Alternative | Rationale |
|--------|-----------------|-------------|-----------|
| Cart Operations | Optimistic update | Wait for server | User perceives instant response |
| Rollback | Client-side state restoration | Server push | Simpler, works offline |
| Trade-off | Brief inconsistency on failure | Slower perceived performance | UX wins for common success case |

### Decision 2: State Machine for Checkout

| Aspect | Chosen Approach | Alternative | Rationale |
|--------|-----------------|-------------|-----------|
| Flow Control | XState machine | useState flags | Clear states, impossible transitions prevented |
| Persistence | Context in machine | localStorage | Survives refresh, tracks progress |
| Trade-off | Learning curve | Simpler but error-prone | Correctness for critical flow |

### Decision 3: Search Fallback Strategy

| Aspect | Chosen Approach | Alternative | Rationale |
|--------|-----------------|-------------|-----------|
| Primary Search | Elasticsearch | PostgreSQL FTS | Performance, faceted filtering |
| Fallback | PostgreSQL FTS on circuit open | Return error | Degraded but available |
| Trade-off | Maintain two search impls | Single point of failure | Availability over consistency |

### Decision 4: Inventory Reservation Model

| Aspect | Chosen Approach | Alternative | Rationale |
|--------|-----------------|-------------|-----------|
| Cart Inventory | Reserve on add | Decrement on add | Prevents false out-of-stock |
| Expiration | 30-minute TTL | No expiration | Balance UX vs. availability |
| Trade-off | Background cleanup job | Simpler but inventory locks | Fairness to all users |

---

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Optimistic UI | Instant feedback, better UX | Rollback complexity, brief inconsistency |
| Reserved inventory | Accurate availability, no overselling | Cleanup job needed, complexity |
| State machine checkout | Predictable flow, easy debugging | Learning curve, more code |
| ES + PG fallback | High availability, fast search | Two systems to maintain |
| Idempotency keys | Exactly-once orders, safe retries | Key storage overhead, 24h TTL management |
| WebSocket inventory | Real-time updates, better UX | Connection management, scaling |

---

## Future Fullstack Enhancements

1. **Progressive Web App**: Offline cart access, push notifications for order updates
2. **Server-Sent Events**: Alternative to WebSocket for inventory updates, simpler scaling
3. **GraphQL Federation**: Unified API across services with client-driven queries
4. **Edge Caching**: CDN caching for product pages with stale-while-revalidate
5. **A/B Testing Infrastructure**: Feature flags for checkout flow experiments
6. **Micro-Frontends**: Independent deployment of search, cart, checkout modules
