# Price Tracking Service - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

---

## 📋 Problem Statement

Design a price tracking service similar to CamelCamelCamel or Honey. This system monitors product prices across e-commerce sites, stores historical data, and alerts users when prices drop. The fullstack challenge is building a cohesive system where the scraping backend, time-series storage, and interactive frontend work together seamlessly.

---

## 🎯 Requirements Clarification (3 minutes)

### Functional Requirements
- **Product Tracking**: Users add products by URL
- **Price Scraping**: Periodic automated price extraction
- **Historical Charts**: Interactive price history visualization
- **Price Alerts**: Notifications when price drops below threshold
- **Admin Dashboard**: Manage scrapers, view system health

### Non-Functional Requirements
- **Freshness**: Popular products updated hourly
- **Scalability**: Support millions of tracked products
- **Reliability**: Graceful handling of site changes
- **Latency**: Dashboard loads under 2 seconds

### Scale Requirements
- 500,000 DAU, 10 million products
- 1,000 products/second scraping rate
- ~35 TB/year time-series storage

---

## 🏗️ High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         REACT FRONTEND                                   │
│   Dashboard  │  Price Charts  │  Alert Manager  │  Admin Panel          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ REST API
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         EXPRESS BACKEND                                  │
│   Auth  │  Products  │  Alerts  │  Admin  │  Price History              │
└─────────────────────────────────────────────────────────────────────────┘
        │                      │                      │
        ▼                      ▼                      ▼
   ┌─────────┐           ┌─────────────┐         ┌─────────┐
   │PostgreSQL│          │ TimescaleDB │         │  Redis  │
   │(Metadata)│          │  (Prices)   │         │ (Cache) │
   └─────────┘           └─────────────┘         └─────────┘
                               ▲
                               │
┌─────────────────────────────────────────────────────────────────────────┐
│                        RABBITMQ JOB QUEUE                                │
│   scrape.amazon  │  scrape.walmart  │  scrape.ebay  │  alerts.send      │
└─────────────────────────────────────────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌───────────┐    ┌───────────┐    ┌───────────┐
       │  Scraper  │    │  Scraper  │    │   Alert   │
       │  Worker   │    │  Worker   │    │  Worker   │
       └───────────┘    └───────────┘    └───────────┘
```

---

## 🔄 Deep Dive 1: End-to-End Add Product Flow (8 minutes)

### Complete Request Flow

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   Frontend   │      │   Backend    │      │  PostgreSQL  │      │   RabbitMQ   │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │                     │                     │                     │
       │  POST /api/products │                     │                     │
       │  { url }            │                     │                     │
       │─────────────────────▶                     │                     │
       │                     │                     │                     │
       │                     │  1. Validate URL    │                     │
       │                     │  2. Extract domain  │                     │
       │                     │                     │                     │
       │                     │  INSERT product     │                     │
       │                     │─────────────────────▶                     │
       │                     │                     │                     │
       │                     │  product record     │                     │
       │                     │◀─────────────────────                     │
       │                     │                     │                     │
       │                     │  Publish scrape job │                     │
       │                     │─────────────────────────────────────────▶│
       │                     │                     │                     │
       │  { product }        │                     │                     │
       │◀─────────────────────                     │                     │
       │                     │                     │                     │
       │  Add to UI state    │                     │                     │
       │  (optimistic)       │                     │                     │
       │                     │                     │                     │
```

### URL Validation and Domain Extraction

Adding a product is four steps. (1) **Validate**: parse the submitted URL's hostname and check it against the supported-domains list; an unsupported retailer returns 400 rather than queuing a scrape no parser can handle. (2) **Dedup**: `SELECT` the product by URL — if it already exists (another user tracks it), skip creation and jump straight to linking. (3) **Create**: `INSERT` the product with `status='pending'` and enqueue a high-priority job to `scrape.{domain}`. (4) **Link**: `INSERT INTO user_products ... ON CONFLICT DO NOTHING`, so many users can track the same product row without duplicating scrape work. The key idea: products are shared and scraped once; the user relationship is a separate many-to-many link.

### Supported Domains

| Domain | Parser Status | Rate Limit |
|--------|---------------|------------|
| amazon.com | Active | 60 RPM |
| walmart.com | Active | 120 RPM |
| bestbuy.com | Active | 90 RPM |
| target.com | Active | 60 RPM |
| ebay.com | Active | 60 RPM |

### Frontend Optimistic Update Pattern

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    OPTIMISTIC UI UPDATE                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  USER CLICKS "ADD PRODUCT"                                               │
│           │                                                              │
│           ▼                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  1. Create temporary product with loading state                    │ │
│  │                                                                    │ │
│  │     {                                                              │ │
│  │       id: "temp-1703548123456",                                    │ │
│  │       url: "https://amazon.com/dp/...",                           │ │
│  │       title: "Loading...",                                        │ │
│  │       currentPrice: null,                                         │ │
│  │       status: "pending",                                          │ │
│  │       isLoading: true                                             │ │
│  │     }                                                              │ │
│  │                                                                    │ │
│  │  2. Prepend to products list (user sees immediately)              │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│           │                                                              │
│           ▼                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  3. Send POST /api/products to backend                             │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│           │                                                              │
│           ├─────────────────────────────────────────┐                   │
│           │                                         │                   │
│           ▼ SUCCESS                                 ▼ FAILURE           │
│  ┌──────────────────────┐                   ┌──────────────────────┐   │
│  │  Replace temp with   │                   │  Remove temp from    │   │
│  │  real product data   │                   │  products list       │   │
│  │                      │                   │                      │   │
│  │  Set isLoading=false │                   │  Show error toast    │   │
│  └──────────────────────┘                   └──────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Deep Dive 2: Price History API and Chart Integration (8 minutes)

### Time-Series Query Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PRICE HISTORY ENDPOINT                                │
│                    GET /api/products/:id/history                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Query Parameters:                                                       │
│  ┌────────────────┬──────────────────┬─────────────────────────────┐    │
│  │ Parameter      │ Default          │ Options                     │    │
│  ├────────────────┼──────────────────┼─────────────────────────────┤    │
│  │ range          │ 30d              │ 7d, 30d, 90d, 1y, all       │    │
│  │ resolution     │ daily            │ hourly, daily               │    │
│  └────────────────┴──────────────────┴─────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Resolution Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    RESOLUTION SELECTION                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐                                                         │
│  │ resolution  │                                                         │
│  │  parameter  │                                                         │
│  └──────┬──────┘                                                         │
│         │                                                                │
│         ├─────────────────────────────────────────┐                     │
│         │                                         │                     │
│         ▼ hourly                                  ▼ daily               │
│  ┌────────────────────────────────┐     ┌────────────────────────────┐  │
│  │  Query raw price_history       │     │  Query continuous aggregate │  │
│  │  table with time_bucket        │     │  price_daily (pre-computed) │  │
│  │                                │     │                             │  │
│  │  - More granular               │     │  - Much faster              │  │
│  │  - More data points            │     │  - Less data transfer       │  │
│  │  - Use for 7d range            │     │  - Use for 30d+ ranges      │  │
│  └────────────────────────────────┘     └────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Backend Query Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Request    │────▶│ Check Redis  │────▶│   Cache      │────▶│   Return     │
│   comes in   │     │   cache      │     │   HIT?       │     │   cached     │
└──────────────┘     └──────────────┘     └───────┬──────┘     └──────────────┘
                                                  │
                                                  │ MISS
                                                  ▼
                                         ┌──────────────┐
                                         │ Query        │
                                         │ TimescaleDB  │
                                         └──────┬───────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │ Transform    │
                                         │ to JSON      │
                                         └──────┬───────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │ Cache result │
                                         │ (5 min TTL)  │
                                         └──────┬───────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │ Return to    │
                                         │ client       │
                                         └──────────────┘
```

### Cache Key Strategy

| Cache Key Pattern | TTL | Description |
|-------------------|-----|-------------|
| `prices:{productId}:7d:hourly` | 5 min | Recent data, updates often |
| `prices:{productId}:30d:daily` | 15 min | Medium range |
| `prices:{productId}:1y:daily` | 1 hour | Historical, rarely changes |

### Frontend Chart Integration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PRICE CHART COMPONENT                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─── State Management ─────────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │   data[]        → Price history array from API                   │   │
│  │   range         → Currently selected range (7d, 30d, etc.)       │   │
│  │   isLoading     → Show skeleton while fetching                   │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─── useEffect: Fetch on range/productId change ────────────────────┐  │
│  │                                                                    │  │
│  │   1. Set isLoading = true                                         │  │
│  │   2. Fetch /api/products/{id}/history?range={range}               │  │
│  │   3. Set data = response                                          │  │
│  │   4. Set isLoading = false                                        │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌─── useMemo: Calculate statistics ─────────────────────────────────┐  │
│  │                                                                    │  │
│  │   min  = Math.min(...data.map(d => d.low))                        │  │
│  │   max  = Math.max(...data.map(d => d.high))                       │  │
│  │   avg  = sum(prices) / count                                      │  │
│  │   curr = data[last].price                                         │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌─── Render ────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │   ┌──────────────────────────────────────────────────────────┐    │  │
│  │   │  [ 7d ]  [ 30d ]  [ 90d ]  [ 1y ]     ← Range buttons    │    │  │
│  │   └──────────────────────────────────────────────────────────┘    │  │
│  │                                                                    │  │
│  │   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                             │  │
│  │   │ Curr │ │ Low  │ │ Avg  │ │ High │     ← Statistics cards     │  │
│  │   │$29.99│ │$24.99│ │$32.50│ │$45.00│                             │  │
│  │   └──────┘ └──────┘ └──────┘ └──────┘                             │  │
│  │                                                                    │  │
│  │   ┌──────────────────────────────────────────────────────────┐    │  │
│  │   │                                                          │    │  │
│  │   │    Line chart with:                                      │    │  │
│  │   │    - X axis: dates                                       │    │  │
│  │   │    - Y axis: prices                                      │    │  │
│  │   │    - Target price reference line (dashed green)          │    │  │
│  │   │    - Tooltip on hover                                    │    │  │
│  │   │                                                          │    │  │
│  │   └──────────────────────────────────────────────────────────┘    │  │
│  │                                                                    │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Response Data Shape

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         API RESPONSE                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  [                                                                       │
│    {                                                                     │
│      time: "2024-01-15T00:00:00Z",    ← ISO timestamp                   │
│      price: 29.99,                     ← Average for period             │
│      low: 28.50,                       ← Min for period                 │
│      high: 31.00                       ← Max for period                 │
│    },                                                                    │
│    ...                                                                   │
│  ]                                                                       │
│                                                                          │
│  Typical sizes:                                                          │
│  - 7 days hourly:  168 points                                           │
│  - 30 days daily:   30 points                                           │
│  - 1 year daily:   365 points                                           │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🔔 Deep Dive 3: Alert System End-to-End (6 minutes)

### Alert Trigger Flow

```
scrape new price ──▶ compare with stored current_price
                          │
                     changePercent = (new − old) / old × 100
                          │
                     significant? (>0.5%)  ──no──▶ stop
                          │ yes
                          ▼
              for each active alert on this product
                          │
   ┌──────────────────────┼──────────────────────┐
   ▼                      ▼                      ▼
'below'               'above'              'change_pct'
new ≤ target          new ≥ target         |change%| ≥ threshold
   └──────────────────────┼──────────────────────┘
                          │ triggered
                          ▼
        publish to alerts.send  { alertId, userId, productId,
                                  productTitle, oldPrice, newPrice,
                                  email, pushToken }
                          │
                          ▼
             update alerts.last_triggered_at
```

**The 0.5% significance floor is the part that makes this usable.** Retailers nudge prices constantly — a few cents on a $400 item — and an alert system that fires on every movement teaches users to ignore it, which is the same as having no alerts. Filtering at the *detection* step rather than the delivery step also means the noise never reaches the queue, so the cost is paid once by the scraper instead of once per subscribed user.

`last_triggered_at` is the other half of that: it's what stops a price hovering either side of a threshold from firing repeatedly.
### Alert Worker Processing

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   RabbitMQ   │────▶│    Alert     │────▶│   Delivery   │
│ alerts.send  │     │   Worker     │     │   Method     │
└──────────────┘     └──────────────┘     └──────────────┘
                                                 │
                           ┌─────────────────────┼─────────────────────┐
                           │                     │                     │
                           ▼                     ▼                     ▼
                    ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
                    │    Email     │      │    Push      │      │   In-App     │
                    │ (SendGrid)   │      │ (Firebase)   │      │ (WebSocket)  │
                    └──────────────┘      └──────────────┘      └──────────────┘
```

### Frontend Alert Management UI

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ALERT SECTION                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─── Header ───────────────────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │   Price Alerts                                    [ + Add Alert ] │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─── Alert List ───────────────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │   ┌────────────────────────────────────────────────────────────┐ │   │
│  │   │  Alert when below $299.99                           [🗑️]   │ │   │
│  │   │  ✓ Target reached!  (green background)                    │ │   │
│  │   └────────────────────────────────────────────────────────────┘ │   │
│  │                                                                   │   │
│  │   ┌────────────────────────────────────────────────────────────┐ │   │
│  │   │  Alert when above $450.00                           [🗑️]   │ │   │
│  │   │  (gray background - not triggered)                        │ │   │
│  │   └────────────────────────────────────────────────────────────┘ │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─── Empty State ──────────────────────────────────────────────────┐   │
│  │                                                                   │   │
│  │   No alerts set. Add one to get notified when the price drops!  │   │
│  │                                                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Alert State Computation

```
Frontend computes trigger state in real-time:

┌──────────────────────────────────────────────────────────────────┐
│                                                                   │
│  isTriggered = (alert.alertType === 'below')                     │
│    ? product.currentPrice <= alert.targetPrice                   │
│    : product.currentPrice >= alert.targetPrice                   │
│                                                                   │
│  If isTriggered:                                                  │
│    - Show green background                                        │
│    - Display "Target reached!" message                           │
│                                                                   │
│  Else:                                                            │
│    - Show gray background                                         │
│    - No message                                                   │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🔐 Deep Dive 4: Session Management (5 minutes)

### Session Architecture

The browser holds only a signed, HttpOnly cookie (`connect.sid = s:<sessionId>.<signature>`) — the session ID is a lookup key, nothing sensitive. Redis holds the actual session record under `sess:<sessionId>` (`{ userId, role, createdAt }`). Every authenticated request presents the cookie; middleware resolves it against Redis and attaches the user. Because the payload lives server-side, a logout is a single Redis `DEL` — the cookie is instantly worthless.

### Cookie Configuration

| Setting | Value | Purpose |
|---------|-------|---------|
| secure | true (prod) | Only send over HTTPS |
| httpOnly | true | Prevent XSS access |
| sameSite | lax | CSRF protection |
| maxAge | 24 hours | Session duration |

### Login Flow

Login posts `{email, password}`; the backend selects the user by email, runs `bcrypt.compare`, and on success writes a session record to Redis and returns a `Set-Cookie` plus the user object. The frontend stashes the user in its Zustand auth store. That store holds just `user` and `isLoading`, with `checkSession()` (GET `/auth/me`), `login()`, and `logout()` actions; on app mount it calls `checkSession()` once and shows a loading screen until the session is resolved, so a returning user with a valid cookie is silently restored rather than bounced to login.

### Session vs JWT Comparison

| Aspect | Session (Chosen) | JWT |
|--------|------------------|-----|
| Storage | Server (Redis) | Client (localStorage) |
| Revocation | ✅ Instant | ❌ Must wait for expiry |
| Size | Small cookie | Large token |
| Stateless | ❌ | ✅ |
| Complexity | ✅ Simple | ❌ Refresh token logic |

---

## 👨‍💼 Deep Dive 5: Admin Dashboard (5 minutes)

### Admin API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/admin/stats | System overview |
| GET | /api/admin/scrapers | Scraper configs |
| PATCH | /api/admin/scrapers/:domain | Update config |
| GET | /api/admin/users | User management |
| POST | /api/admin/scrapers/:domain/retry | Force retry failed |

### Stats Aggregation

The stats endpoint fans out several independent aggregates in parallel (`COUNT(*)` of products, users, and active alerts) plus a per-domain `GROUP BY domain` that computes total tracked products, `COUNT(*) FILTER (WHERE status='ok')` vs `'fail'`, and average price-age. Running them concurrently rather than sequentially keeps the dashboard load fast; the per-domain roll-up is what powers the scraper-health view. Results feed a stats-card row (products, users, alerts, scrape rate) and a **scraper health table** — one row per domain with product count, extraction success %, average data age, and a status badge — so an operator can spot a domain whose parser has silently broken (e.g. a retailer at 65% success is failing) at a glance.

### Status Badge Logic

| Success Rate | Status | Color |
|--------------|--------|-------|
| ≥ 95% | OK | Green |
| 80-95% | WARN | Yellow |
| < 80% | FAIL | Red |

### Scraper Config Update Flow

Editing a domain's config (`PATCH /api/admin/scrapers/:domain`) writes the new selectors/rate-limit to PostgreSQL and then deletes the cached config key in Redis, so the next scrape for that domain fetches the fresh configuration rather than a stale cached copy. This is the operator's lever when a retailer changes its markup: update the selectors and the fleet picks them up on the next cycle without a redeploy.

---

## ⚖️ Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| API Style | ✅ REST | ❌ GraphQL | Simpler for CRUD, caching-friendly |
| Time-Series | ✅ TimescaleDB | ❌ InfluxDB | SQL, joins with relational data |
| Charts | ✅ Recharts | ❌ D3 | React-native, easier integration |
| State | ✅ Zustand | ❌ Redux | Simpler API, less boilerplate |
| Sessions | ✅ Redis-backed | ❌ JWT | Server-side control, easy revocation |
| Queue | ✅ RabbitMQ | ❌ Redis BullMQ | Dedicated queue, better persistence |
| Validation | ✅ Zod | ❌ Yup | TypeScript inference, smaller bundle |
| Auth Middleware | ✅ Session check | ❌ Token verify | Simpler, consistent with session approach |

---

## 🚀 Future Fullstack Enhancements

1. **WebSocket Price Updates**: Real-time price notifications pushed to frontend
2. **Browser Extension**: Quick add while browsing e-commerce sites
3. **Email Templates**: Rich HTML notifications with price charts embedded
4. **Multi-Currency**: Automatic conversion and display preferences
5. **Price Predictions**: ML model for buy/wait recommendations
6. **Bulk Import**: CSV upload for tracking multiple products
7. **Share Lists**: Public price tracking lists with shareable URLs
8. **Mobile App**: React Native app with push notifications
