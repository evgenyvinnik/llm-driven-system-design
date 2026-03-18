# Local Delivery Service - Architecture Design

## System Overview

A last-mile delivery platform for local goods and services, similar to DoorDash, Instacart, or Uber Eats. The core challenges are real-time driver location tracking, efficient driver-order matching, route optimization, and handling the three-sided marketplace dynamics between customers, merchants, and drivers.

## Requirements

### Functional Requirements

1. **Order placement** - Customers browse merchant menus and place orders
2. **Driver matching** - Match orders to nearby available drivers using a scoring algorithm
3. **Real-time tracking** - Live driver location and ETA updates via WebSocket
4. **Route optimization** - Efficient routing for pickups and deliveries
5. **Notifications** - Order status updates to customers, merchants, and drivers
6. **Ratings** - Two-way ratings for drivers, customers, and merchants

### Non-Functional Requirements

- **Latency**: Driver match within 30 seconds, location updates every 3 seconds, p99 API response < 200ms
- **Scale**: 1M orders/day, 100K concurrent drivers, 10K location updates/second
- **Availability**: 99.99% for order placement (four nines)
- **Accuracy**: ETA within 3 minutes 90% of the time
- **Durability**: Zero order loss; idempotent order creation

## Capacity Estimation

### Production Scale

**Order volume:**
- 1 million orders per day
- Peak hours (lunch/dinner): 3x average = 35 orders/second
- Average order: $25, 3 items

**Driver fleet:**
- 100,000 active drivers
- 30% online at any time = 30,000 concurrent
- Location updates every 3 seconds = 10,000 updates/second

**Storage:**
- Orders: ~1KB each = 1GB/day, 365GB/year
- Driver location history: 10K updates/sec x 100 bytes = 1MB/s = 86GB/day
- Session tokens: 30K concurrent x 200 bytes = 6MB (Redis)

### Local Development Scale

- 3 test merchants with sample menus
- 3 test drivers with simulated locations
- ~10 concurrent users maximum

## High-Level Architecture

```
                                ┌─────────────────────────────────────┐
                                │            Client Apps               │
                                │   Customer    Driver    Admin        │
                                │   (React)     (React)   (React)     │
                                └────────────┬────────────────────────┘
                                             │
                                    ┌────────┴────────┐
                                    │   CDN / Edge    │
                                    │  (CloudFront)   │
                                    └────────┬────────┘
                                             │
                              ┌──────────────┴──────────────┐
                              │         API Gateway          │
                              │  (Rate limiting, Auth, TLS)  │
                              └──────┬──────────────┬───────┘
                                     │              │
                            HTTPS    │              │ WSS
                                     │              │
                  ┌──────────────────┼──────────────┼──────────────────┐
                  │                  │              │                  │
         ┌────────▼────────┐ ┌──────▼───────┐ ┌────▼──────┐ ┌────────▼────────┐
         │  Order Service  │ │  Location    │ │ Tracking  │ │  Notification   │
         │                 │ │  Service     │ │ Service   │ │  Service        │
         │ - Create order  │ │              │ │           │ │                 │
         │ - State machine │ │ - Geo index  │ │ - Pub/Sub │ │ - Push / SMS    │
         │ - Idempotency   │ │ - Nearby     │ │ - ETA     │ │ - Email         │
         └────────┬────────┘ │   search     │ │ - WS fan  │ └─────────────────┘
                  │          └──────┬───────┘ │   out     │
         ┌────────▼────────┐       │         └───────────┘
         │ Matching Service│       │
         │                 │       │
         │ - Driver scoring│       │
         │ - Sequential    │       │
         │   offers        │       │
         │ - Circuit       │       │
         │   breaker       │       │
         └────────┬────────┘       │
                  │                │
      ┌───────────┴────────────────┴───────────────────────┐
      │                    Data Layer                       │
      │                                                    │
      │  ┌────────────┐  ┌────────────┐  ┌──────────────┐ │
      │  │ PostgreSQL │  │   Redis    │  │    Kafka     │ │
      │  │ (Primary)  │  │  Cluster   │  │              │ │
      │  │            │  │            │  │ - Location   │ │
      │  │ - Users    │  │ - Geo idx  │  │   events     │ │
      │  │ - Orders   │  │ - Sessions │  │ - Order      │ │
      │  │ - Merchants│  │ - Pub/Sub  │  │   events     │ │
      │  │ - Ratings  │  │ - Cache    │  │ - Analytics  │ │
      │  └────────────┘  └────────────┘  └──────────────┘ │
      └────────────────────────────────────────────────────┘
```

### Core Components

1. **Order Service** - Manages order lifecycle with a state machine (`pending` -> `confirmed` -> `preparing` -> `ready_for_pickup` -> `driver_assigned` -> `picked_up` -> `in_transit` -> `delivered`). Uses idempotency keys to prevent duplicate orders on network retry.

2. **Location Service** - Ingests driver location updates at 10K/second. Maintains a real-time geo-index in Redis using `GEOADD`/`GEORADIUS`. Supports nearby driver queries with sub-millisecond latency.

3. **Matching Service** - Assigns orders to drivers using a scoring algorithm that weighs distance (40%), rating (25%), acceptance rate (20%), and current load (15%). Offers are sent sequentially with a 30-second acceptance timeout. Protected by a circuit breaker to prevent cascade failures.

4. **Tracking Service** - Streams real-time driver location to customers via WebSocket. Calculates ETA using Haversine distance. Uses Redis Pub/Sub for message distribution across server instances.

5. **Notification Service** - Sends order status updates to all parties (push notifications, SMS, email). Decoupled via Kafka for reliable async delivery.

## Database Schema

### Entity-Relationship Diagram

```
                                    ┌─────────────────────────┐
                                    │      users              │
                                    │─────────────────────────│
                                    │ id (PK, UUID)           │
                                    │ email (UNIQUE)          │
                                    │ password_hash           │
                                    │ name, phone             │
                                    │ role (customer/driver/  │
                                    │       merchant/admin)   │
                                    │ created_at, updated_at  │
                                    └───────────┬─────────────┘
                                                │
              ┌─────────────────────────────────┼─────────────────────────────────┐
              │                                 │                                 │
              │ 1:1 (id = users.id)             │ 1:N (owner_id)                  │ 1:N (user_id)
              ▼                                 │                                 ▼
┌─────────────────────────────┐                 │                   ┌─────────────────────────────┐
│       drivers               │                 │                   │       sessions              │
│─────────────────────────────│                 │                   │─────────────────────────────│
│ id (PK, FK -> users)        │                 │                   │ id (PK, UUID)               │
│ vehicle_type                │                 │                   │ user_id (FK -> users)       │
│ license_plate               │                 │                   │ token (UNIQUE)              │
│ status                      │                 │                   │ expires_at                  │
│ rating, total_deliveries    │                 │                   │ created_at                  │
│ acceptance_rate             │                 │                   └─────────────────────────────┘
│ current_lat, current_lng    │                 │
│ location_updated_at         │                 ▼
│ created_at, updated_at      │   ┌─────────────────────────────┐
└──────────────┬──────────────┘   │       merchants             │
               │                  │─────────────────────────────│
               │                  │ id (PK, UUID)               │
               │                  │ owner_id (FK -> users)      │
               │                  │ name, description           │
               │                  │ address, lat, lng           │
               │                  │ category                    │
               │                  │ avg_prep_time_minutes       │
               │                  │ rating, is_open             │
               │                  │ opens_at, closes_at         │
               │                  │ created_at, updated_at      │
               │                  └──────────────┬──────────────┘
               │                                 │
               │  1:N (driver_id)                │  1:N (merchant_id)
               │                                 ▼
               │                  ┌─────────────────────────────┐
               │                  │       menu_items            │
               │                  │─────────────────────────────│
               │                  │ id (PK, UUID)               │
               │                  │ merchant_id (FK)            │
               │                  │ name, description, price    │
               │                  │ category, image_url         │
               │                  │ is_available                │
               │                  │ created_at, updated_at      │
               │                  └──────────────┬──────────────┘
               │                                 │
               │                                 │  N:1 (menu_item_id)
               ▼                                 │
┌─────────────────────────────┐                  │
│       orders                │◄─────────────────┘
│─────────────────────────────│
│ id (PK, UUID)               │
│ customer_id (FK -> users)   │
│ merchant_id (FK)            │
│ driver_id (FK -> drivers)   │
│ status                      │
│ delivery_address/lat/lng    │
│ subtotal, delivery_fee, tip │
│ total                       │
│ estimated_delivery_time     │
│ actual_delivery_time        │
│ archived_at, retention_days │
│ timestamps (created, etc.)  │
└──────────────┬──────────────┘
               │
               │  1:N (order_id)
    ┌──────────┼──────────┬───────────────┐
    ▼          ▼          ▼               ▼
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────────┐
│order_items │ │driver_offers│ │  ratings   │ │driver_location_history │
│────────────│ │────────────│ │────────────│ │────────────────────────│
│id (PK)     │ │id (PK)     │ │id (PK)     │ │id (PK)                 │
│order_id FK │ │order_id FK │ │order_id FK │ │driver_id (FK -> drivers)│
│menu_item_id│ │driver_id FK│ │rater_id FK │ │lat, lng                │
│name, qty   │ │status      │ │rated_user  │ │speed, heading          │
│unit_price  │ │offered_at  │ │rated_merch │ │recorded_at             │
│special_inst│ │expires_at  │ │rating 1-5  │ └────────────────────────┘
│created_at  │ │responded_at│ │comment     │
└────────────┘ └────────────┘ │created_at  │
                              └────────────┘

┌─────────────────────────────┐  ┌─────────────────────────────┐  ┌─────────────────────────────┐
│     delivery_zones          │  │     idempotency_keys        │  │     retention_policies      │
│─────────────────────────────│  │─────────────────────────────│  │─────────────────────────────│
│ id (PK, UUID)               │  │ key (PK, VARCHAR(64))       │  │ id (PK, UUID)               │
│ name                        │  │ user_id (FK -> users)       │  │ table_name (UNIQUE)         │
│ center_lat, center_lng      │  │ operation                   │  │ hot_storage_days            │
│ radius_km                   │  │ response (JSONB)            │  │ warm_storage_days           │
│ is_active                   │  │ status                      │  │ archive_enabled             │
│ base_delivery_fee           │  │ created_at, expires_at      │  │ last_cleanup_at             │
│ per_km_fee                  │  └─────────────────────────────┘  │ created_at, updated_at      │
│ created_at                  │                                   └─────────────────────────────┘
└─────────────────────────────┘
```

### Complete PostgreSQL Schema

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users: Central identity table for all user types
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(20) NOT NULL CHECK (role IN ('customer', 'driver', 'merchant', 'admin')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Drivers: Extended profile for users with role='driver'
CREATE TABLE drivers (
    id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('bicycle', 'motorcycle', 'car', 'van')),
    license_plate VARCHAR(20),
    status VARCHAR(20) NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'available', 'busy')),
    rating DECIMAL(3,2) DEFAULT 5.00,
    total_deliveries INTEGER DEFAULT 0,
    acceptance_rate DECIMAL(5,4) DEFAULT 1.0000,
    current_lat DECIMAL(10,8),
    current_lng DECIMAL(11,8),
    location_updated_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Merchants: Business profiles
CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    address TEXT NOT NULL,
    lat DECIMAL(10,8) NOT NULL,
    lng DECIMAL(11,8) NOT NULL,
    category VARCHAR(50) NOT NULL,
    avg_prep_time_minutes INTEGER DEFAULT 15,
    rating DECIMAL(3,2) DEFAULT 5.00,
    is_open BOOLEAN DEFAULT true,
    opens_at TIME DEFAULT '09:00',
    closes_at TIME DEFAULT '22:00',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Menu Items: Products available from merchants
CREATE TABLE menu_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    category VARCHAR(50),
    image_url TEXT,
    is_available BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Orders: Core transaction table
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES users(id) ON DELETE SET NULL,
    merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
    driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','confirmed','preparing','ready_for_pickup',
                          'driver_assigned','picked_up','in_transit','delivered','cancelled')),
    delivery_address TEXT NOT NULL,
    delivery_lat DECIMAL(10,8) NOT NULL,
    delivery_lng DECIMAL(11,8) NOT NULL,
    delivery_instructions TEXT,
    subtotal DECIMAL(10,2) NOT NULL,
    delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
    tip DECIMAL(10,2) DEFAULT 0,
    total DECIMAL(10,2) NOT NULL,
    estimated_prep_time_minutes INTEGER,
    estimated_delivery_time TIMESTAMP,
    actual_delivery_time TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP,
    picked_up_at TIMESTAMP,
    delivered_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    cancellation_reason TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    archived_at TIMESTAMP,
    retention_days INTEGER DEFAULT 90
);

-- Order Items: Line items within orders
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price DECIMAL(10,2) NOT NULL,
    special_instructions TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver Offers: Assignment tracking
CREATE TABLE driver_offers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
    offered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    responded_at TIMESTAMP
);

-- Ratings: Two-way ratings for completed deliveries
CREATE TABLE ratings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    rater_id UUID REFERENCES users(id) ON DELETE SET NULL,
    rated_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    rated_merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Delivery Zones: Geographic areas with pricing
CREATE TABLE delivery_zones (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    center_lat DECIMAL(10,8) NOT NULL,
    center_lng DECIMAL(11,8) NOT NULL,
    radius_km DECIMAL(5,2) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    base_delivery_fee DECIMAL(10,2) DEFAULT 2.99,
    per_km_fee DECIMAL(10,2) DEFAULT 0.50,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sessions: Authentication sessions
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Driver Location History: Time-series for analytics
CREATE TABLE driver_location_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
    lat DECIMAL(10,8) NOT NULL,
    lng DECIMAL(11,8) NOT NULL,
    speed DECIMAL(6,2),
    heading DECIMAL(5,2),
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Idempotency Keys: Prevent duplicate operations
CREATE TABLE idempotency_keys (
    key VARCHAR(64) PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation VARCHAR(50) NOT NULL,
    response JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'failed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL
);

-- Retention Policies: Data lifecycle configuration
CREATE TABLE retention_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name VARCHAR(100) UNIQUE NOT NULL,
    hot_storage_days INTEGER NOT NULL DEFAULT 30,
    warm_storage_days INTEGER NOT NULL DEFAULT 365,
    archive_enabled BOOLEAN DEFAULT true,
    last_cleanup_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Database Indexes

| Index Name | Table | Columns | Type | Purpose |
|------------|-------|---------|------|---------|
| idx_orders_status | orders | status | B-tree | Filter by order status |
| idx_orders_customer | orders | customer_id | B-tree | Customer order history |
| idx_orders_driver | orders | driver_id | Partial (active statuses) | Active driver orders |
| idx_orders_merchant | orders | merchant_id | B-tree | Merchant order history |
| idx_orders_created | orders | created_at DESC | B-tree | Recent orders listing |
| idx_orders_archive | orders | created_at, archived_at | Partial (not archived) | Archive job queries |
| idx_drivers_status | drivers | status | B-tree | Available driver lookup |
| idx_drivers_location | drivers | current_lat, current_lng | Partial (available) | Nearby driver search |
| idx_merchants_location | merchants | lat, lng | B-tree | Nearby merchant search |
| idx_merchants_category | merchants | category | B-tree | Category filtering |
| idx_menu_items_merchant | menu_items | merchant_id | B-tree | Menu listing |
| idx_driver_offers_order | driver_offers | order_id | B-tree | Offers per order |
| idx_driver_offers_driver | driver_offers | driver_id | B-tree | Offers per driver |
| idx_sessions_token | sessions | token | B-tree | Session lookup |
| idx_driver_location_history | driver_location_history | driver_id, recorded_at DESC | B-tree | Driver path queries |
| idx_idempotency_keys_expires | idempotency_keys | expires_at | B-tree | Cleanup job |

### Foreign Key Cascade Behaviors

| Parent Table | Child Table | FK Column | ON DELETE | Rationale |
|-------------|-------------|-----------|-----------|-----------|
| users | drivers | id | CASCADE | Driver profile meaningless without user |
| users | merchants | owner_id | SET NULL | Keep merchant for business continuity |
| users | orders | customer_id | SET NULL | Preserve order history |
| users | sessions | user_id | CASCADE | Sessions deleted with user |
| drivers | orders | driver_id | SET NULL | Preserve order history |
| drivers | driver_offers | driver_id | CASCADE | Offers are driver-specific |
| drivers | driver_location_history | driver_id | CASCADE | History is driver-specific |
| merchants | menu_items | merchant_id | CASCADE | Menu belongs to merchant |
| merchants | orders | merchant_id | SET NULL | Preserve order history |
| orders | order_items | order_id | CASCADE | Items belong to order |
| orders | driver_offers | order_id | CASCADE | Offers are order-specific |
| orders | ratings | order_id | CASCADE | Rating belongs to order |
| menu_items | order_items | menu_item_id | SET NULL | Preserve ordered item history |

### Redis Data Structures

```
# Driver locations (geo index)
drivers:locations          -> GEOADD (lng, lat, driver_id)

# Driver metadata
driver:{id}                -> HASH (lat, lng, status, updated_at)

# Active orders by driver
driver:{id}:orders         -> SET [order_ids]

# Session storage
session:{token}            -> JSON (userId, role, expiresAt)

# Real-time location pub/sub
driver:{id}:location       -> PUBSUB channel
order:{id}:status          -> PUBSUB channel

# Message replay (WebSocket reconnect)
order:{id}:events          -> XADD stream (MAXLEN 100)
```

### Data Flow Between Tables

**Order Placement Flow:**
```
1. Customer selects items from menu_items
2. Order created in orders with customer_id, merchant_id, status='pending'
3. Order items copied to order_items with denormalized name/price
4. Matching service finds nearby drivers (via Redis GEORADIUS)
5. Driver offers created in driver_offers with 30-second expiry
6. When driver accepts, orders.driver_id set, status='driver_assigned'
7. Status transitions recorded via timestamp columns
8. Rating created in ratings after delivery
```

**Driver Location Flow:**
```
1. Driver logs in, session created in sessions + Redis
2. Driver goes online, drivers.status='available'
3. Location updates: Redis GEOADD (real-time) + drivers.current_lat/lng (persistent)
4. Historical points logged to driver_location_history
5. Retention job archives location history after 7 days
```

## API Design

### Customer API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/merchants` | Browse nearby merchants |
| GET | `/api/v1/merchants/:id/menu` | Get merchant menu |
| POST | `/api/v1/orders` | Place order (idempotent with `X-Idempotency-Key`) |
| GET | `/api/v1/orders/:id` | Get order details |
| GET | `/api/v1/orders` | Order history |
| WebSocket | `/ws` | Subscribe to order tracking updates |

### Driver API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/driver/go-online` | Start accepting orders |
| POST | `/api/v1/driver/go-offline` | Stop accepting orders |
| POST | `/api/v1/driver/location` | Update driver location |
| POST | `/api/v1/driver/offers/:id/accept` | Accept order offer |
| POST | `/api/v1/driver/offers/:id/reject` | Reject order offer |
| POST | `/api/v1/driver/orders/:id/picked-up` | Mark order picked up |
| POST | `/api/v1/driver/orders/:id/delivered` | Complete delivery |

### Admin API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/stats` | Dashboard statistics |
| GET | `/api/v1/admin/orders` | View all orders |
| GET | `/api/v1/admin/drivers` | View all drivers |
| GET | `/metrics` | Prometheus metrics |
| GET | `/health` | Health check |

## Key Design Decisions

### 1. Redis Geo-Index for Driver Locations vs PostgreSQL PostGIS

**Chosen: Redis GEOADD/GEORADIUS.** Driver location queries happen during the critical path of order matching -- every second of delay means a hungrier customer. Redis provides sub-millisecond geo queries compared to PostgreSQL PostGIS at ~5-10ms. With 10K location updates per second, Redis handles the write throughput without breaking a sweat.

**Trade-off acknowledged:** Redis is volatile. If Redis crashes, the geo-index is lost and all drivers appear offline. Recovery requires drivers to re-authenticate and send a new location update. PostgreSQL stores the last-known location as a fallback for rebuilding, but there is a brief outage window. This is acceptable because the location data has a 3-second shelf life anyway.

### 2. Sequential Driver Offers vs Broadcast

**Chosen: Sequential offers with 30-second timeout.** When an order is ready, the matching service selects the top-scoring driver and sends a single offer. If declined or expired, it moves to the next candidate. Broadcasting to all nearby drivers creates a thundering herd -- 50 drivers racing to accept one order leads to 49 wasted API calls, potential double-assignments, and UI confusion. Sequential offers are fairer (higher-rated drivers get first pick) and eliminate race conditions entirely.

**Trade-off acknowledged:** Sequential offers are slower. In the worst case, cycling through 5 drivers with 30-second timeouts takes 2.5 minutes. We mitigate this by reducing timeout to 15 seconds after the second rejection and by using circuit breakers to skip drivers who are consistently unresponsive.

### 3. WebSocket for Real-time Updates vs Polling

**Chosen: Native WebSocket (ws library) with Redis Pub/Sub.** A delivery tracking page needs sub-second location updates. Polling at 1-second intervals creates 60 requests per minute per customer; with 10K concurrent tracking sessions, that is 600K requests per minute hitting the API. WebSocket delivers push updates with a single persistent connection. Redis Pub/Sub distributes messages across multiple API server instances, so any server can serve any client.

**Trade-off acknowledged:** WebSocket connections are stateful, complicating horizontal scaling. We need heartbeat mechanisms to detect stale connections (30-second ping interval), graceful reconnection logic when clients switch networks, and message replay via Redis Streams for missed updates during reconnection.

### 4. Session-Based Authentication vs JWT

**Chosen: Session tokens stored in Redis.** Session-based auth enables instant token revocation on logout or account compromise -- a single Redis `DEL` invalidates the session immediately. JWT tokens are irrevocable until expiry, which is unacceptable for a delivery platform where compromised driver accounts can steal orders. Redis lookup adds ~0.5ms per request, which is negligible compared to the security benefit.

## Consistency and Idempotency

### Consistency Model

| Entity | Consistency | Rationale |
|--------|-------------|-----------|
| Orders | Strong (PostgreSQL transactions) | State transitions must be atomic; no duplicate orders or lost payments |
| Driver locations | Eventual (Redis, 3-second lag) | Stale location is tolerable; freshness traded for throughput |
| Session tokens | Eventual (Redis, TTL-based) | Logout propagation within seconds is acceptable |
| Ratings | Eventual (async write) | Ratings can lag behind order completion |

### Idempotency Keys

Order creation uses client-generated idempotency keys to prevent duplicate orders on network retries:

1. Client sends `X-Idempotency-Key` header (UUID v4) with order request
2. Server checks if key exists in `idempotency_keys` table
3. If found with `status='completed'`: return cached response (200 OK)
4. If found with `status='pending'`: reject as concurrent request (409 Conflict)
5. If not found: create pending record, execute order creation, cache response
6. Keys expire after 24 hours via cleanup job

**Order status transitions** use optimistic locking:
```sql
UPDATE orders
SET status = 'picked_up', picked_up_at = NOW()
WHERE id = $1 AND status = 'preparing'
RETURNING *;
```
If affected rows = 0, the transition was already applied or invalid.

### Conflict Resolution

| Scenario | Resolution |
|----------|------------|
| Two drivers accept same order | First `UPDATE` wins (PostgreSQL row lock); second gets "already assigned" |
| Driver goes offline with active order | Order stays assigned; admin can reassign after 10-min timeout |
| Simultaneous location updates | Redis `GEOADD` is atomic; latest timestamp wins |
| Duplicate order submission | Idempotency key returns cached response |

## Security

- **Password hashing**: bcrypt with cost factor 12
- **Session tokens**: Cryptographically random, stored in Redis with 24h TTL
- **Role-based access control**: Middleware checks user role before endpoint access
- **Input validation**: All endpoints validate and sanitize inputs
- **CORS**: Restricted to known frontend origins
- **Rate limiting**: Per-IP and per-user limits on order creation

## Observability

### Metrics (Prometheus)

| Metric | Type | Labels | Purpose |
|--------|------|--------|---------|
| `delivery_orders_created_total` | Counter | merchant_category | Order creation rate |
| `delivery_orders_completed_total` | Counter | status | Completion/cancellation rates |
| `delivery_order_duration_seconds` | Histogram | status | End-to-end order time |
| `delivery_driver_matching_duration_seconds` | Histogram | - | Matching algorithm latency |
| `delivery_driver_assignments_total` | Counter | result (accepted/rejected/expired) | Driver acceptance tracking |
| `delivery_http_request_duration_seconds` | Histogram | method, route, status_code | API latency |
| `delivery_circuit_breaker_state` | Gauge | name | Circuit breaker health |
| `delivery_db_query_duration_seconds` | Histogram | operation, table | Database performance |
| `delivery_redis_operation_duration_seconds` | Histogram | operation | Redis performance |

### Health Checks

- `GET /health` checks PostgreSQL and Redis connectivity
- Returns `{ status, postgres, redis, latency_ms }` for load balancer integration

### Structured Logging

JSON-structured logs via Pino with service/module context, request correlation IDs, and configurable log levels. Child loggers for each module (orders, drivers, matching, auth) enable filtered log analysis.

## Failure Handling

### Circuit Breaker (Matching Service)

The driver matching service wraps external calls with an Opossum circuit breaker:
- **Closed**: Normal operation; 5-second timeout per request
- **Open**: After 50% failure rate over 5+ requests; fails fast for 10 seconds
- **Half-open**: Allows one test request; closes on success, reopens on failure

This prevents the matching service from hanging when a downstream dependency (Redis geo-query or PostgreSQL) is degraded, allowing orders to queue rather than timeout.

### Graceful Degradation

| Failure | Degradation |
|---------|-------------|
| Redis down | Sessions fall back to PostgreSQL lookup; geo-queries unavailable; matching paused |
| PostgreSQL down | Read from Redis cache for active orders; new orders rejected with 503 |
| WebSocket disconnect | Client auto-reconnects; missed messages replayed from Redis Stream |
| Matching service circuit open | Orders queue in `pending` state; admin notification sent |

## Scalability Considerations

### Geographic Sharding

At production scale, partition by metro area. Each region gets its own Redis instance for geo-queries (drivers don't cross regions). Cross-region orders route through a regional gateway.

### Horizontal Scaling Path

1. **API servers**: Stateless, behind a load balancer. Add instances to handle more concurrent connections
2. **Redis**: Redis Cluster with hash-slot sharding for geo data. Pub/Sub scales via Redis Streams with consumer groups
3. **PostgreSQL**: Read replicas for dashboard/analytics queries. Write primary handles order mutations. Table partitioning by month for orders
4. **Kafka**: Decouple location ingestion and notification delivery from the critical order path

### Data Lifecycle

| Data Type | Hot Storage | Warm Storage | Archive | Deletion |
|-----------|-------------|--------------|---------|----------|
| Active orders | PostgreSQL | - | - | - |
| Completed orders | PostgreSQL (30 days) | Partitioned (1 year) | MinIO CSV (7 years) | After 7 years |
| Driver locations (Redis) | Current only | - | - | Overwritten continuously |
| Driver location history | PostgreSQL (7 days) | - | Aggregated to MinIO | After 30 days |
| Session tokens | Redis (24h TTL) | - | - | Auto-expire |
| Idempotency keys | PostgreSQL (24h) | - | - | Daily cleanup job |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Driver geo-index | Redis GEOADD | PostgreSQL PostGIS | Sub-ms queries for real-time matching at 10K updates/sec |
| Driver offers | Sequential | Broadcast | Fair, no race conditions; slower worst-case mitigated by timeout reduction |
| Real-time updates | WebSocket + Pub/Sub | HTTP polling | Push model avoids 600K req/min at 10K concurrent trackers |
| Authentication | Session tokens | JWT | Instant revocation for compromised driver accounts |
| Location update frequency | 3 seconds | 1 second / 10 seconds | Balanced accuracy vs bandwidth/battery; ETA within 3 min target |
| Order idempotency | DB-backed keys | Redis-only keys | Durable across Redis restart; 24h TTL prevents unbounded growth |

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + React.

### Local Setup Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    localhost                                       │
│                                                                   │
│  ┌──────────────┐    HTTP     ┌──────────────────────────────┐   │
│  │   Frontend   │ ──────────▶ │      Backend (Express)       │   │
│  │  Vite + React│             │        Port 3000             │   │
│  │  Port 5173   │ ◀─── WS ── │                              │   │
│  │              │             │  ┌──────────┐ ┌───────────┐  │   │
│  │  - Customer  │             │  │  Auth    │ │ Location  │  │   │
│  │    view      │             │  │  Routes  │ │ Service   │  │   │
│  │  - Driver    │             │  ├──────────┤ ├───────────┤  │   │
│  │    dashboard │             │  │  Order   │ │ Matching  │  │   │
│  │  - Admin     │             │  │  Routes  │ │ Service   │  │   │
│  │    dashboard │             │  ├──────────┤ ├───────────┤  │   │
│  │              │             │  │  Driver  │ │ WebSocket │  │   │
│  │              │             │  │  Routes  │ │ Handler   │  │   │
│  └──────────────┘             │  └──────────┘ └───────────┘  │   │
│                               └──────────┬───────────────────┘   │
│                                          │                        │
│                            ┌─────────────┴─────────────┐         │
│                            │                           │         │
│                     ┌──────▼──────┐            ┌───────▼──────┐  │
│                     │  PostgreSQL │            │    Valkey    │  │
│                     │  Port 5432  │            │  Port 6379   │  │
│                     │             │            │              │  │
│                     │  delivery   │            │  - Geo index │  │
│                     │  DB (13     │            │  - Sessions  │  │
│                     │  tables)    │            │  - Pub/Sub   │  │
│                     └─────────────┘            └──────────────┘  │
│                                                                   │
│  Docker Compose containers: delivery-postgres, delivery-redis     │
└──────────────────────────────────────────────────────────────────┘
```

### Production-Grade Patterns Implemented

| Pattern | Library | File Path | Why It Matters |
|---------|---------|-----------|----------------|
| Circuit breaker | Opossum | `backend/src/shared/circuitBreaker.ts` | Prevents cascade failures when matching service is overwhelmed; auto-recovers after 10s cooldown |
| Idempotency keys | Custom (PostgreSQL-backed) | `backend/src/shared/idempotency.ts` | Prevents duplicate orders on network retry; 24h TTL with status tracking (pending/completed/failed) |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | 25+ metrics covering orders, deliveries, driver assignments, circuit breaker, HTTP, DB, and Redis |
| Structured logging | Pino | `backend/src/shared/logger.ts` | JSON logs with module context (orders, drivers, matching, auth); pretty-print in dev, machine-parseable in prod |
| Data retention | Custom cleanup jobs | `backend/src/shared/retention.ts` | Configurable per-table retention (orders 30d, locations 7d, sessions 1d); `npm run db:cleanup` runs all jobs |
| WebSocket real-time | ws (native) | `backend/src/websocket/` | Driver location streaming and order status updates via Redis Pub/Sub |
| Geo-indexing | Redis GEOADD | `backend/src/services/driverService.ts` | Sub-millisecond nearby driver search with GEORADIUS |
| Health checks | Custom | `backend/src/routes/` | `/health` endpoint checks PostgreSQL and Redis connectivity |

### Simplifications from Production Design

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| API Gateway (Kong/Envoy) | Express middleware (CORS, auth) | No centralized rate limiting or TLS termination |
| CDN (CloudFront) | Vite dev server serves assets directly | No edge caching |
| Kafka for event streaming | Redis Pub/Sub | No event persistence or replay beyond 1h Redis Stream |
| Multiple microservices | Single Express process with route-based modules | No independent scaling |
| Redis Cluster | Single Valkey instance | No sharding; single point of failure |
| PostgreSQL read replicas | Single PostgreSQL instance | All reads and writes on same instance |
| Geographic sharding | Single region (test data) | No multi-region support |
| Notification service (SMS/push) | WebSocket-only notifications | No out-of-app notifications |
| OAuth/SSO | Session-based auth with bcrypt | Simpler but no third-party auth |

### What Was Omitted

- CDN and edge caching for static assets
- Multi-region deployment and geographic sharding
- Kubernetes orchestration and auto-scaling
- Payment processing and financial ledger
- Surge pricing and demand prediction
- ML-based ETA estimation (using Haversine distance instead)
- Message queue (Kafka/RabbitMQ) for async processing
- Grafana dashboards (metrics exposed at `/metrics` but no visualization)
- Distributed tracing (OpenTelemetry)
- Map visualization in the frontend (coordinates only, no map tiles)
