# Design DoorDash - Architecture

## System Overview

DoorDash is a three-sided marketplace connecting customers, restaurants, and delivery drivers. Core challenges involve real-time logistics, optimal driver matching, accurate ETA computation, and coordinating order state transitions across three independent actors. The system must handle high write throughput for location updates, maintain strong consistency for financial operations, and deliver sub-second real-time updates to all parties.

**Learning Goals:**
- Design real-time location tracking with geospatial indexing
- Build optimal order-driver matching algorithms
- Calculate accurate ETAs with multiple contributing factors
- Handle three-sided marketplace dynamics with complex authorization
- Implement event-driven architecture for decoupled order lifecycle management

---

## Requirements

### Functional Requirements

1. **Browse & Search**: Customers discover restaurants by location, cuisine, rating, and delivery time
2. **Order**: Customers build carts, place orders with delivery address and tip
3. **Restaurant Management**: Owners manage menus, hours, open/close status, and order acceptance
4. **Order Lifecycle**: Order flows through PLACED -> CONFIRMED -> PREPARING -> READY_FOR_PICKUP -> PICKED_UP -> DELIVERED
5. **Driver Matching**: Automatically assign the best available driver when an order is confirmed
6. **Real-Time Tracking**: Live driver location and order status updates for all parties
7. **ETA Calculation**: Multi-factor delivery time estimates that update as conditions change
8. **Ratings & Reviews**: Customers rate both restaurant and driver after delivery
9. **Payment**: Customer charge (subtotal + tax + delivery fee + tip), restaurant payout, driver pay

### Non-Functional Requirements

| Requirement | Target |
|---|---|
| Order API p99 latency | < 200ms |
| Location update latency (p95) | < 50ms |
| Driver match time (p95) | < 30 seconds |
| Availability (peak hours) | 99.99% |
| Scale | 1M orders/day, 100K concurrent drivers |
| Location update frequency | Every 10 seconds per active driver |
| WebSocket connection success | > 99.5% |

---

## Capacity Estimation

### Production Scale

| Metric | Estimate |
|---|---|
| Daily orders | 1M |
| Peak orders per second | ~30 (lunch/dinner rush) |
| Concurrent active drivers | 100K |
| Location updates per second | 10K (100K drivers / 10s interval) |
| Active WebSocket connections | 200K (customers + drivers + restaurant tablets) |
| Restaurant catalog | 500K restaurants, 50M menu items |
| Order event throughput | ~150K events/day (5-6 status transitions per order) |

### Storage Estimates

| Data | Size | Retention |
|---|---|---|
| Orders (1M/day) | ~1KB each = 1GB/day, 365GB/year | Indefinite |
| Location history (10K/s) | ~100B each = 86GB/day | 30 days hot, 1 year cold |
| Menu data | ~500GB total | Indefinite |
| Audit logs | ~200B each = 30GB/day | 1 year |

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client Layer                                   │
│     Customer App     │    Restaurant Tablet    │     Driver App          │
│  (React/Mobile)      │    (React/Tablet)       │   (React/Mobile)       │
└─────────┬────────────┴────────────┬────────────┴──────────┬─────────────┘
          │                         │                        │
          ▼                         ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          CDN / Edge                                      │
│   Static assets, menu images, restaurant photos (TTL: 1 hour)           │
└─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        API Gateway / Load Balancer                       │
│   Rate limiting, authentication, request routing, TLS termination       │
└───────┬──────────┬──────────┬──────────┬──────────┬─────────────────────┘
        │          │          │          │          │
        ▼          ▼          ▼          ▼          ▼
┌───────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────────┐
│  Order    │ │Restaurant│ │ Driver   │ │Delivery│ │   Payment    │
│  Service  │ │ Service  │ │ Service  │ │Service │ │   Service    │
│           │ │          │ │          │ │        │ │              │
│ - Create  │ │ - Menus  │ │ - Onboard│ │- Match │ │ - Charge     │
│ - Status  │ │ - Hours  │ │ - Location││- Batch │ │ - Payout     │
│ - History │ │ - Search │ │ - Status │ │- Route │ │ - Tips       │
│ - Cancel  │ │ - Ratings│ │ - Stats  │ │- ETA   │ │ - Refund     │
└─────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ └──────┬───────┘
      │            │            │            │             │
      ▼            ▼            ▼            ▼             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Event Bus (Kafka)                                 │
│  Topics: order-events, location-updates, dispatch-events,               │
│          payment-events, notification-events                            │
└─────────────────────────────────────────────────────────────────────────┘
      │            │            │            │             │
      ▼            ▼            ▼            ▼             ▼
┌───────────┐ ┌──────────┐ ┌──────────────┐ ┌────────────────────────────┐
│WebSocket  │ │Notifica- │ │  Analytics   │ │    Surge Pricing           │
│Gateway    │ │tion Svc  │ │  Service     │ │    Service                 │
│           │ │          │ │              │ │                            │
│- Order    │ │- Push    │ │- Delivery    │ │- Demand-based fees         │
│  updates  │ │- SMS     │ │  metrics     │ │- Driver incentives         │
│- Driver   │ │- Email   │ │- ETA tuning  │ │- Zone-based multipliers    │
│  location │ │          │ │- Dashboards  │ │                            │
└───────────┘ └──────────┘ └──────────────┘ └────────────────────────────┘
      │            │            │
      ▼            ▼            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Data Layer                                       │
├──────────────┬──────────────┬───────────────────────────────────────────┤
│  PostgreSQL  │  Redis/Valkey│       Object Storage (S3)                 │
│              │              │                                           │
│ - Orders     │ - Driver     │ - Menu images                             │
│ - Users      │   locations  │ - Restaurant photos                       │
│ - Restaurants│   (GEOSEARCH)│ - Receipt PDFs                            │
│ - Menu items │ - Sessions   │                                           │
│ - Reviews    │ - Cache      │                                           │
│ - Payments   │ - Idempotency│                                           │
│ - Audit logs │   keys       │                                           │
└──────────────┴──────────────┴───────────────────────────────────────────┘
```

---

## Core Components

### 1. Order Flow

The complete lifecycle of an order involves coordination across all three sides of the marketplace:

1. **Customer places order** (PLACED): Order created with items, delivery address, tip. Idempotency key prevents duplicate charges on retry. Restaurant notified via WebSocket.
2. **Restaurant confirms** (CONFIRMED): Restaurant acknowledges the order. Triggers automatic driver matching.
3. **Restaurant prepares** (PREPARING): Restaurant starts cooking. Prep time countdown begins for ETA.
4. **Food ready** (READY_FOR_PICKUP): Restaurant marks food as ready. Driver notified to head to restaurant.
5. **Driver picks up** (PICKED_UP): Driver confirms pickup. ETA recalculated based on delivery distance only.
6. **Driver delivers** (DELIVERED): Driver confirms delivery. Driver marked available for new orders. Delivery metrics recorded.

Each transition is protected by a state machine that validates allowed transitions and authorization (customers can only cancel in PLACED status, restaurant owners control CONFIRMED through READY_FOR_PICKUP, drivers control PICKED_UP and DELIVERED).

### 2. Driver Location Tracking

Drivers send GPS coordinates every 10 seconds while online. This data serves three purposes:

**Real-time geospatial indexing** (Redis GEOSEARCH): The primary query path for finding nearby available drivers. Redis GEOADD stores each driver's position, and GEOSEARCH finds drivers within a radius sorted by distance. Sub-millisecond query latency is critical since matching happens on every confirmed order.

**Customer tracking** (WebSocket broadcast): When a driver has an active order, every location update is broadcast to the customer tracking that order. This enables the live map experience.

**Location history** (PostgreSQL, async): Location history is written asynchronously to PostgreSQL for ETA model training and dispute resolution. This is partitioned by time for efficient cleanup.

If Redis is unavailable, the system falls back to a PostgreSQL query with Haversine distance calculation -- slower but functional.

### 3. Driver Matching Algorithm

When an order is confirmed, the matching service finds the best driver:

1. **Find candidates**: Query Redis GEOSEARCH for active, available drivers within 5km of the restaurant (limit 20)
2. **Score each driver** using a weighted formula:
   - Distance to restaurant (highest weight): `100 - distance * 10` -- closer drivers mean faster pickup
   - Driver rating: `rating * 5` -- higher-rated drivers provide better service
   - Experience: `min(total_deliveries / 10, 20)` -- more experienced drivers are more reliable
3. **Assign highest-scoring driver**: Update the order with driver_id, mark driver unavailable
4. **Calculate ETA**: Compute multi-factor ETA based on driver-to-restaurant distance, remaining prep time, and restaurant-to-customer distance
5. **Notify driver**: Push order details and ETA via WebSocket

The entire matching process is protected by a circuit breaker (10s timeout, 50% error threshold, 30s reset). If matching fails, the order remains in CONFIRMED status and can be retried.

### 4. Dispatch Optimization

At production scale, naive one-order-per-driver matching leaves significant efficiency on the table:

**Order batching**: When multiple orders are ready at the same restaurant or nearby restaurants, a single driver can pick up 2-3 orders if the combined route adds minimal delay. The batching algorithm calculates combined route efficiency and only batches when the additional delivery time is under 5 minutes per order.

**Multi-stop deliveries**: For batched orders, the routing engine optimizes the delivery sequence to minimize total distance. The driver sees a multi-stop route with navigation instructions for each delivery.

**Demand-based rebalancing**: During peak hours, the dispatch system can suggest drivers reposition to high-demand zones where they are more likely to receive orders quickly.

### 5. Restaurant Management

Restaurants have two distinct operational concerns:

**Menu management**: Restaurant owners create, update, and disable menu items with name, description, price, and category. Menu data is cached in Redis with a 5-minute TTL using cache-aside pattern. Updates immediately invalidate the cache so customers see fresh data.

**Order throttling**: When a restaurant is overwhelmed (too many active orders), the system can temporarily increase estimated prep times or pause new order acceptance. This prevents quality degradation and inaccurate ETAs.

**Open/close toggle**: Restaurants can instantly go offline, which removes them from search results and prevents new orders.

### 6. Real-Time Tracking

The system uses WebSocket connections for bidirectional real-time communication:

**Channel-based subscriptions**: Clients subscribe to specific channels (e.g., `order:123`, `driver:456:orders`, `restaurant:789:orders`). The server only sends messages to subscribers of relevant channels.

**Order status updates**: Every status transition broadcasts the updated order to the customer, restaurant, and driver channels simultaneously.

**Driver location updates**: Every 10-second GPS update from a driver broadcasts to the customer tracking that driver's active order. The update includes latitude, longitude, and timestamp.

**Connection management**: Heartbeat/ping-pong mechanism detects stale connections. On reconnect, clients re-subscribe and fetch current state to avoid missing updates during disconnection.

### 7. ETA Calculation

ETA computation combines multiple time components, some of which overlap:

**Time to restaurant**: Haversine distance from driver's current position to restaurant, converted to drive time using average city driving speed (25 km/h for cars), multiplied by a traffic factor based on time of day (1.5x during rush hours 7-9 AM and 5-7 PM, 1.3x during lunch rush 11 AM-1 PM, 1.1x on weekends).

**Preparation time**: Restaurant's configured prep time minus elapsed time since the order was confirmed. If the driver arrives before food is ready, they wait.

**Delivery time**: Haversine distance from restaurant to customer's delivery address, converted using the same traffic-adjusted route time calculation.

**Buffer**: 3 minutes for pickup handoff + 2 minutes for delivery handoff.

**Total**: `max(time_to_restaurant, prep_time) + pickup_buffer + delivery_time + dropoff_buffer`. The `max()` reflects that driver travel and food preparation happen in parallel.

ETAs are recalculated at every status transition and driver location update, giving customers progressively more accurate estimates.

### 8. Payment

Payment involves three financial flows:

**Customer charge**: subtotal (sum of item prices) + tax (percentage of subtotal) + delivery fee (restaurant-configured, potentially surge-adjusted) + tip (customer-specified). Charged at order placement with idempotency protection.

**Restaurant payout**: subtotal minus platform commission. Settled on a daily or weekly cadence depending on restaurant agreement.

**Driver pay**: delivery fee + tip + any surge/incentive bonuses. Tips are passed through to drivers in full.

### 9. Surge / Dynamic Pricing

When demand exceeds driver supply in a zone, delivery fees increase:

- Monitor order-to-driver ratio per geo zone in real-time
- When ratio exceeds threshold (e.g., 3:1), apply a multiplier to delivery fees (1.2x-2.5x)
- Show surge indicator to customers before they place orders
- Simultaneously offer bonuses to drivers in nearby zones to increase supply
- Surge decays automatically as supply-demand rebalances

### 10. Search and Discovery

Restaurant search combines multiple signals:

**Geo filtering**: Only show restaurants that deliver to the customer's location. Use Redis GEOSEARCH or PostGIS for radius queries.

**Filters**: Cuisine type, minimum rating, maximum delivery time, price range, currently open.

**Ranking**: Combine relevance (text match), rating (weighted by rating count), delivery time estimate, and platform-specific signals (conversion rate, completion rate).

**Text search**: ILIKE queries for name/description matching in the local implementation. At production scale, Elasticsearch with analyzers for typo tolerance and synonym matching.

---

## Database Schema

```sql
-- Users table (customers, restaurant owners, drivers)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(20) DEFAULT 'customer'
    CHECK (role IN ('customer', 'restaurant_owner', 'driver', 'admin')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Restaurants
CREATE TABLE restaurants (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  address VARCHAR(500) NOT NULL,
  lat DECIMAL(10, 8) NOT NULL,
  lon DECIMAL(11, 8) NOT NULL,
  cuisine_type VARCHAR(50),
  rating DECIMAL(2, 1) DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  prep_time_minutes INTEGER DEFAULT 20,
  is_open BOOLEAN DEFAULT TRUE,
  image_url VARCHAR(500),
  delivery_fee DECIMAL(10, 2) DEFAULT 2.99,
  min_order DECIMAL(10, 2) DEFAULT 10.00,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Menu Items
CREATE TABLE menu_items (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  category VARCHAR(50),
  image_url VARCHAR(500),
  is_available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Drivers
CREATE TABLE drivers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  vehicle_type VARCHAR(50) DEFAULT 'car'
    CHECK (vehicle_type IN ('car', 'bike', 'scooter', 'walk')),
  license_plate VARCHAR(20),
  is_active BOOLEAN DEFAULT FALSE,
  is_available BOOLEAN DEFAULT TRUE,
  current_lat DECIMAL(10, 8),
  current_lon DECIMAL(11, 8),
  rating DECIMAL(2, 1) DEFAULT 5.0,
  rating_count INTEGER DEFAULT 0,
  total_deliveries INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Orders
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE SET NULL,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  status VARCHAR(30) DEFAULT 'PLACED'
    CHECK (status IN ('PLACED', 'CONFIRMED', 'PREPARING',
      'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED', 'COMPLETED', 'CANCELLED')),
  subtotal DECIMAL(10, 2) NOT NULL,
  delivery_fee DECIMAL(10, 2) NOT NULL,
  tax DECIMAL(10, 2) NOT NULL,
  tip DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  delivery_address JSONB NOT NULL,
  delivery_instructions TEXT,
  estimated_delivery_at TIMESTAMP,
  placed_at TIMESTAMP DEFAULT NOW(),
  confirmed_at TIMESTAMP,
  preparing_at TIMESTAMP,
  ready_at TIMESTAMP,
  picked_up_at TIMESTAMP,
  delivered_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  cancel_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Order Items
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
  name VARCHAR(200) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  special_instructions TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews
CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE UNIQUE,
  customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restaurant_rating INTEGER CHECK (restaurant_rating >= 1 AND restaurant_rating <= 5),
  restaurant_comment TEXT,
  driver_rating INTEGER CHECK (driver_rating >= 1 AND driver_rating <= 5),
  driver_comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sessions (for auth)
CREATE TABLE sessions (
  id VARCHAR(255) PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit logs
CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  actor_type VARCHAR(20) NOT NULL
    CHECK (actor_type IN ('customer', 'driver', 'restaurant', 'admin', 'system')),
  actor_id INTEGER,
  changes JSONB,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX idx_restaurants_location ON restaurants(lat, lon);
CREATE INDEX idx_restaurants_cuisine ON restaurants(cuisine_type);
CREATE INDEX idx_restaurants_is_open ON restaurants(is_open);
CREATE INDEX idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX idx_menu_items_category ON menu_items(category);
CREATE INDEX idx_drivers_location ON drivers(current_lat, current_lon);
CREATE INDEX idx_drivers_active_available ON drivers(is_active, is_available);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX idx_orders_driver ON orders(driver_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_actor ON audit_logs(actor_type, actor_id);
```

---

## API Design

### Customer APIs

```
GET    /api/restaurants                        → Browse restaurants (filters: cuisine, search, lat/lon/radius)
GET    /api/restaurants/:id                    → Get restaurant with menu (cache-aside, 5min TTL)
GET    /api/restaurants/meta/cuisines          → Get cuisine types for filter pills (cached 10min)
POST   /api/orders                             → Place order (requires X-Idempotency-Key header)
GET    /api/orders                             → List customer's order history
GET    /api/orders/:id                         → Get order details with items, driver, ETA
PATCH  /api/orders/:id/status                  → Cancel order (status=CANCELLED, PLACED only)
```

### Restaurant Owner APIs

```
GET    /api/restaurants/owner/my-restaurants   → List owned restaurants
POST   /api/restaurants                        → Create restaurant
PUT    /api/restaurants/:id                    → Update restaurant details
POST   /api/restaurants/:id/menu               → Add menu item
PUT    /api/restaurants/:restaurantId/menu/:itemId → Update menu item
DELETE /api/restaurants/:restaurantId/menu/:itemId → Remove menu item
GET    /api/orders/restaurant/:restaurantId    → Get restaurant's active orders
PATCH  /api/orders/:id/status                  → Confirm/Prepare/Ready transitions
```

### Driver APIs

```
POST   /api/drivers/location                   → Update GPS location (every 10s)
POST   /api/drivers/status                     → Go online/offline
GET    /api/drivers/orders                     → Get active deliveries
GET    /api/drivers/stats                      → Today's stats (deliveries, fees, tips)
POST   /api/drivers/orders/:orderId/pickup     → Confirm pickup
POST   /api/drivers/orders/:orderId/deliver    → Confirm delivery
```

### Auth APIs

```
POST   /api/auth/register                      → Create account (customer/driver/restaurant_owner)
POST   /api/auth/login                         → Session-based login (cookie)
POST   /api/auth/logout                        → Destroy session
GET    /api/auth/me                            → Get current user
```

### System APIs

```
GET    /health                                 → Comprehensive health check (Postgres, Redis, Kafka)
GET    /health/live                            → Liveness probe
GET    /health/ready                           → Readiness probe (Postgres + Redis connectivity)
GET    /metrics                                → Prometheus metrics endpoint
WS     /ws                                     → WebSocket (subscribe/unsubscribe to channels)
```

---

## Key Design Decisions

### 1. Redis GEOSEARCH for Driver Locations vs PostGIS

**Decision**: Store real-time driver locations in Redis with geo indexing, not PostgreSQL PostGIS.

**Why Redis works**: Driver location updates arrive at 10K/second (100K active drivers, every 10 seconds). Each update needs to be both written and queryable within milliseconds. Redis GEOADD/GEOSEARCH provides sub-millisecond spatial queries with O(N+log(M)) complexity. The data is inherently ephemeral -- if a driver stops sending updates, their position is stale within 30 seconds.

**Why PostGIS fails here**: PostgreSQL handles 10K writes/second fine, but every write contends for index updates on the spatial index. More critically, the GEOSEARCH query during driver matching would compete with the write load, introducing latency spikes during peak matching. PostGIS is excellent for static or slowly-changing spatial data (restaurant locations), but not for high-frequency updates.

**What we give up**: Redis is single-threaded and in-memory. A Redis failure means losing all driver positions until drivers send their next update (10 seconds). We mitigate this by also writing positions to PostgreSQL asynchronously for the fallback query path.

### 2. Score-Based Matching vs Auction-Based Matching

**Decision**: Use a deterministic scoring algorithm rather than an auction where drivers bid on orders.

**Why scoring works**: The scoring formula (distance 60%, rating 25%, experience 15%) produces predictable, explainable assignments. When a customer complains about a slow delivery, we can show exactly why a specific driver was chosen. The algorithm runs in under 100ms because it only evaluates the 20 nearest drivers.

**Why auction fails here**: An auction requires drivers to actively bid, introducing 10-30 seconds of latency per match while waiting for bids. During peak hours with 30 orders/second, this creates a backlog. Drivers might also game the system by selectively bidding on high-tip orders, leaving low-tip customers waiting. Uber tried auction-based matching early on and abandoned it for similar reasons.

**What we give up**: Scoring doesn't account for driver preferences (maybe a driver knows a neighborhood well, or prefers certain restaurant types). A hybrid approach where drivers can set preferences that influence scoring would be a future improvement.

### 3. Kafka for Event Streaming vs Direct Push

**Decision**: Publish all order and location events to Kafka topics rather than making synchronous calls between services.

**Why Kafka works**: Order lifecycle events (created, confirmed, picked up, delivered) need to reach multiple consumers: the notification service (push/SMS), the analytics pipeline (ETA model training), the payment service (charge/payout triggers), and the real-time WebSocket gateway. Kafka's consumer group model lets each consumer process events independently at its own pace. If the notification service goes down, order processing continues and notifications catch up when it recovers.

**Why direct push fails**: A synchronous call chain (Order Service -> Notification Service -> Analytics Service) means a slow notification service blocks order confirmation. With 1M orders/day generating 5-6 events each, that is 5-6M inter-service calls that all need to succeed. Any single failure in the chain cascades.

**What we give up**: Kafka adds operational complexity (ZooKeeper, broker management, topic configuration) and introduces eventual consistency for downstream consumers. A notification might arrive 1-2 seconds after the status change rather than instantly. For a food delivery app, this latency is acceptable.

### 4. Multi-Factor ETA vs ML-Based Prediction

**Decision**: Use a deterministic multi-factor ETA (distance, prep time, traffic multiplier, buffer) rather than a machine learning model.

**Why deterministic works**: The formula is transparent and debuggable. When ETAs are consistently 5 minutes late, we can identify the specific factor (prep time underestimated, traffic multiplier too low) and adjust it. The calculation takes microseconds with no model serving infrastructure needed.

**Why ML fails initially**: An ML model needs months of historical delivery data to train on, and the model's predictions are opaque -- when ETAs are wrong, it is hard to know why. ML models also require serving infrastructure (model registry, feature store, inference endpoints) that adds significant operational cost before the data exists to justify it.

**What we give up**: The deterministic approach cannot capture complex patterns (this restaurant is always 5 minutes late on Friday nights, this neighborhood has construction delays). Once sufficient delivery history accumulates, an ML model trained on historical data can progressively replace or augment the deterministic approach. The `eta_accuracy_minutes` metric tracks accuracy to inform this decision.

---

## Consistency and Idempotency

### Write Consistency Model

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Order placement | Strong (PostgreSQL transaction) | Payment tied to order creation, no duplicates allowed |
| Order status transitions | Strong with optimistic locking | State machine integrity requires atomic transition from expected state |
| Driver location updates | Eventual (Redis primary, PostgreSQL async) | High frequency, 10-second staleness acceptable |
| Menu/price updates | Eventual with explicit cache invalidation | Restaurant can tolerate brief inconsistency during invalidation |
| Driver matching | Optimistic with conflict detection | Race conditions handled: if driver becomes unavailable between query and assignment, retry with next candidate |

### Idempotency Keys

All mutating API endpoints require client-generated idempotency keys via the `X-Idempotency-Key` header. The flow:

1. Client generates a UUID for each action (e.g., placing an order)
2. Server checks Redis for existing response cached under that key
3. If found, return the cached response (cache hit)
4. If not found, process the request, cache the response with 24-hour TTL
5. On validation errors or server errors, the key is cleared so the client can retry with corrected data

This prevents duplicate charges when network issues cause request retries.

### Order State Machine Conflict Resolution

Status transitions use optimistic locking: the UPDATE query includes `WHERE status = $expected_status`. If the row was already modified by another actor (e.g., restaurant cancels while driver tries to pick up), the update affects zero rows and the caller receives a conflict error with the current status.

### Kafka Consumer Deduplication

Kafka provides at-least-once delivery. Consumers use event-id-based deduplication: before processing, check Redis for `processed:{eventId}`. If present, skip. If absent, set the key with 7-day TTL and process.

---

## Caching and Edge Strategy

### Cache Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            CDN Edge                                      │
│   Static assets, menu images, restaurant photos                         │
│   TTL: 1 hour, purge on update via versioned URLs                       │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Application Cache (Redis/Valkey)                     │
│   Menu data, restaurant info, sessions, geospatial, idempotency keys   │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     PostgreSQL (Source of Truth)                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Cache Strategy by Data Type

| Data | Pattern | TTL | Invalidation |
|------|---------|-----|-------------|
| Restaurant + menu | Cache-aside | 5 min | Explicit purge on restaurant/menu update |
| Cuisine list | Cache-aside | 10 min | Background refresh |
| Driver locations | Write-through | 30s auto-expire | Overwrite on every update |
| Order status | No cache | N/A | Real-time via WebSocket |
| User sessions | Write-through | 24 hours | Delete on logout |
| Idempotency keys | Write-through | 24 hours | Clear on validation/server error |
| Nearby restaurants | Cache-aside (by geohash cell) | 2 min | Background refresh |

Cache hit/miss rates are tracked via Prometheus counters (`cache_hits_total`, `cache_misses_total`) per cache type.

---

## Observability

### Metrics (Prometheus)

Key metrics exposed at `/metrics`:

**HTTP metrics**: `http_request_duration_seconds` (histogram by method/route/status), `http_requests_total` (counter)

**Order metrics**: `orders_total` (counter by status/restaurant), `orders_active` (gauge by status), `order_status_transitions_total` (counter by from/to status), `order_placement_duration_seconds` (histogram)

**Delivery metrics**: `delivery_duration_minutes` (histogram of actual delivery times), `eta_accuracy_minutes` (histogram of estimated vs actual, positive = late)

**Driver metrics**: `drivers_active` (gauge), `drivers_available` (gauge), `driver_match_duration_seconds` (histogram), `driver_assignments_total` (counter by result: success/no_drivers/error), `driver_location_updates_total` (counter)

**Infrastructure metrics**: `cache_hits_total` / `cache_misses_total` (by cache type), `circuit_breaker_state` (gauge: 0=closed, 1=open, 2=half-open), `circuit_breaker_failures_total`, `idempotency_hits_total`

### SLI/SLO Definitions

| SLI | Target SLO | Alert Threshold |
|-----|------------|-----------------|
| Order API p99 latency | < 200ms | > 500ms for 5 min |
| Order placement success rate | > 99.9% | < 99% for 2 min |
| Driver location update p95 | < 50ms | > 100ms for 5 min |
| Driver match time p95 | < 30s | > 60s for 5 min |
| WebSocket connection success | > 99.5% | < 98% for 5 min |
| Kafka consumer lag | < 1000 messages | > 5000 for 5 min |

### Structured Logging (Pino)

Every log entry includes structured fields: `level`, `time`, `service`, `requestId`, `msg`. Business events add contextual fields (orderId, customerId, restaurantId, driverId, status transitions). Request logging middleware assigns a unique requestId per request and logs completion with status code, duration, and user ID.

### Audit Logging

Critical business events are recorded in the `audit_logs` table with:
- `event_type`: ORDER_CREATED, ORDER_STATUS_CHANGED, ORDER_CANCELLED, DRIVER_ASSIGNED
- `actor_type` + `actor_id`: Who performed the action (customer, driver, restaurant, admin, system)
- `changes`: JSON before/after state diff
- `metadata`: IP address, user agent, idempotency key

This provides an immutable record for dispute resolution in the three-sided marketplace.

---

## Failure Handling

### Circuit Breakers (Opossum)

| Operation | Timeout | Error Threshold | Reset |
|-----------|---------|-----------------|-------|
| Driver matching | 10s | 50% | 30s |
| Payment processing | 5s | 30% | 60s |

When a circuit opens, the operation returns a fallback immediately (driver matching: `{ matched: false, queued: true }`). Circuit state is tracked as a Prometheus gauge for dashboard visibility.

### Graceful Degradation

- **Redis down**: Driver location falls back to PostgreSQL query with Haversine calculation. Menu caching disabled, every request hits PostgreSQL.
- **Kafka down**: Events are skipped (fire-and-forget). Order flow continues without event publishing. Logged as warnings. Analytics and notifications degrade but core order flow is unaffected.
- **WebSocket disconnected**: Clients poll REST endpoints for status updates until reconnected.

### Graceful Shutdown

On SIGTERM: stop accepting new connections, finish in-flight requests (30s timeout), close PostgreSQL pool, close Redis connection, disconnect Kafka producer, then exit. Forced exit after 30 seconds.

---

## Scalability Considerations

### What Breaks First

1. **Driver location writes** (10K/s): Redis single-node handles this comfortably (~100K ops/s). Beyond 500K concurrent drivers, shard driver locations across multiple Redis instances by driver ID hash.

2. **PostgreSQL order writes** (30 orders/s peak): A single PostgreSQL instance handles this easily. At 10x scale, read replicas for order history queries. At 100x, partition the orders table by month.

3. **WebSocket connections** (200K): A single server handles ~50K connections. Use a WebSocket gateway cluster (4+ nodes) with Redis Pub/Sub to fan out messages across nodes.

4. **Driver matching** (30 matches/s): CPU-bound scoring of 20 drivers per match. A single node handles hundreds of matches/second. Shard by geographic region for independent scaling.

### Horizontal Scaling Path

- **API servers**: Stateless, scale behind load balancer. Session state in Redis.
- **WebSocket gateway**: Scale independently from API servers. Use Redis Pub/Sub for cross-node message routing.
- **Kafka**: Add partitions per topic. Partition `order-events` by order ID, `location-updates` by driver ID.
- **PostgreSQL**: Read replicas for analytics and order history. Vertical scaling first, then sharding by region if needed.
- **Redis**: Cluster mode for driver locations if needed. Separate Redis instances for cache vs geo vs sessions.

### Geographic Sharding

At continental scale, shard the entire system by metropolitan area. Each metro has its own:
- Order/Restaurant/Driver databases
- Redis instances for locations
- Kafka clusters for local events
- API server fleet

Cross-metro operations (user traveling to another city) route to the appropriate shard via the API gateway.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Location store | Redis GEOSEARCH | PostGIS | Sub-ms latency for 10K updates/s; ephemeral data fits in-memory model |
| Driver matching | Score-based algorithm | Auction-based bidding | Deterministic, < 100ms, no driver wait time; auction adds 10-30s latency |
| ETA computation | Multi-factor formula | ML model | Transparent, debuggable, zero training data needed; ML added later with data |
| Event streaming | Kafka | Synchronous RPC | Decoupled consumers, replay capability, no cascade failures |
| Session auth | Redis + cookie | JWT | Immediate revocation on logout, simpler token management |
| Cache invalidation | Explicit purge + TTL | Event-driven invalidation | Simpler, sufficient for menu update frequency |
| Order state machine | Optimistic locking | Pessimistic row locks | Concurrent actors rarely conflict; retries cheaper than lock waits |

---

## Implementation Notes

This section documents the mapping between the production architecture above and what is actually built in the local implementation.

### Local Architecture

```
┌───────────────────────┐        ┌───────────────────────────────┐
│   React Frontend      │        │    Express Backend             │
│   (Vite, port 5173)   │───────▶│    (single process, port 3000)│
│                       │  HTTP  │                               │
│ - Home (browse)       │  + WS  │ Routes:                       │
│ - Restaurant page     │        │   /api/auth                   │
│ - Cart + checkout     │        │   /api/restaurants             │
│ - Order tracking      │        │   /api/orders                  │
│ - Driver dashboard    │        │   /api/drivers                 │
│ - Restaurant dashboard│        │                               │
│                       │        │ WebSocket: /ws                 │
└───────────────────────┘        └──────┬───────┬───────┬────────┘
                                        │       │       │
                                        ▼       ▼       ▼
                                 ┌──────────┐ ┌─────┐ ┌─────┐
                                 │PostgreSQL│ │Redis│ │Kafka│
                                 │port 5432 │ │6379 │ │9092 │
                                 └──────────┘ └─────┘ └─────┘
```

### Production-Grade Patterns Actually Implemented

**Idempotency for order placement** -- The `X-Idempotency-Key` header is required on POST /api/orders. Keys are stored in Redis with 24-hour TTL. Validation and server errors clear the key to allow retry. This prevents duplicate charges when network issues cause retries. See `backend/src/shared/idempotency.ts`.

**Cache-aside for restaurant/menu data** -- Restaurant details with full menus are cached in Redis under `cache:restaurant_full:{id}` with 5-minute TTL. Cache is explicitly invalidated on restaurant update, menu item add/update/delete. Cuisine list cached under `cache:cuisines` with 10-minute TTL. Cache hits and misses tracked via Prometheus counters. See `backend/src/shared/cache.ts` and `backend/src/routes/restaurants.ts`.

**Circuit breaker for driver matching** -- Driver matching uses Opossum with 10-second timeout and 50% error threshold. When the circuit opens, matching returns a fallback result immediately instead of hanging. Circuit state transitions are logged and tracked as Prometheus gauges. See `backend/src/shared/circuit-breaker.ts`.

**Prometheus metrics** -- 20+ metrics covering HTTP latency, order lifecycle, delivery duration, ETA accuracy, driver operations, cache performance, and circuit breaker state. All exposed at `/metrics` in Prometheus exposition format. See `backend/src/shared/metrics.ts`.

**Structured logging with Pino** -- All log output is structured JSON with service name, request ID, and contextual business fields. Request logging middleware tracks duration and status code per request. See `backend/src/shared/logger.ts`.

**Audit logging** -- Every order creation, status change, and driver assignment writes to the `audit_logs` table with actor type/ID, before/after state diff, IP address, and user agent. See `backend/src/shared/audit.ts`.

**Health check endpoints** -- Three tiers: `/health/live` (process running), `/health/ready` (Postgres + Redis connected), `/health` (comprehensive with latency measurements, memory usage, Kafka status). See `backend/src/index.ts`.

**Kafka event streaming** -- Three topics (`order-events`, `location-updates`, `dispatch-events`) with KafkaJS producer. Kafka initialization is non-blocking; if Kafka is unavailable, events are skipped with warnings but order flow continues. See `backend/src/shared/kafka.ts`.

**WebSocket real-time updates** -- Channel-based pub/sub with subscribe/unsubscribe/ping messages. Order status changes, driver location updates, and new order notifications broadcast to relevant channels. See `backend/src/websocket.ts`.

**Redis GEOSEARCH for driver matching** -- Drivers' GPS positions stored with GEOADD, queried with GEOSEARCH for nearest-driver matching. Falls back to PostgreSQL with Haversine distance calculation if Redis is unavailable. See `backend/src/routes/orders/driver-matching.ts`.

**Multi-factor ETA calculation** -- Haversine distance, traffic-adjusted route times (rush hour 1.5x, lunch 1.3x, weekend 1.1x), restaurant prep time, and handoff buffers. Driver travel and prep time run in parallel via `max()`. Recalculated at every status transition. See `backend/src/utils/geo.ts`.

**Graceful shutdown** -- SIGTERM handler closes HTTP server, waits for in-flight requests, then closes PostgreSQL pool, Redis connection, and Kafka producer in order. 30-second forced shutdown timeout. See `backend/src/index.ts`.

### What Was Simplified

| Production | Local Implementation |
|---|---|
| Separate microservices (Order, Restaurant, Driver, Delivery, Payment) | Single Express process with route modules |
| API Gateway with rate limiting and TLS | Direct HTTP to Express |
| Payment service (Stripe/PayPal integration) | Pricing calculated but no actual payment processing |
| PostGIS with `GEOGRAPHY` type | Lat/lon stored as DECIMAL columns with Haversine in application code |
| CDN for images | `image_url` column stores URLs, no actual image hosting |
| Elasticsearch for restaurant search | PostgreSQL ILIKE queries |
| Redis Cluster for high availability | Single Redis/Valkey instance |
| WebSocket gateway cluster with Redis Pub/Sub fan-out | Single WebSocket server in-process |
| Kafka consumer services (notifications, analytics) | Producer-only; no consumers implemented |
| OAuth/SSO authentication | Session-based auth with bcrypt passwords |
| Map integration for driver tracking | Lat/lon coordinates displayed as text |
| Surge pricing engine | Static delivery fees per restaurant |

### What Was Omitted

- CDN and edge caching
- Multi-region deployment
- Kubernetes orchestration
- Database sharding and read replicas
- Push notifications (mobile/browser)
- Route optimization and navigation
- Order batching for multi-stop deliveries
- Driver incentive/bonus system
- Restaurant commission management
- Refund and dispute resolution
- ML-based ETA prediction
- A/B testing infrastructure
- Fraud detection
