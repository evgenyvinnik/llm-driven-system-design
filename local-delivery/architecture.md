# Local Delivery Service - Architecture Design

## System Overview

A last-mile delivery platform for local goods and services, similar to DoorDash, Instacart, or Uber Eats. The core challenges are real-time driver location tracking, efficient driver-order matching, route optimization, and handling the three-sided marketplace dynamics between customers, merchants, and drivers.

## Requirements

### Functional Requirements

1. **Order placement** - Customers order from local merchants
2. **Driver matching** - Match orders to nearby available drivers
3. **Real-time tracking** - Live driver location and ETA updates
4. **Route optimization** - Efficient routing for deliveries
5. **Notifications** - Order status updates to all parties
6. **Ratings** - Two-way ratings for drivers and customers

### Non-Functional Requirements

- **Latency**: Driver match within 30 seconds, location updates every 3 seconds
- **Scale**: Designed for 1M orders/day, 100K concurrent drivers (local demo version)
- **Availability**: 99.99% for order placement
- **Accuracy**: ETA within 3 minutes 90% of the time

## Capacity Estimation

**Order volume (production):**
- 1 million orders per day
- Peak hours (lunch/dinner): 3x average = 35 orders/second
- Average order: $25, 3 items

**Driver fleet (production):**
- 100,000 active drivers
- 30% online at any time = 30,000 concurrent
- Location updates every 3 seconds = 10,000 updates/second

**Local demo:**
- 3 test merchants
- 3 test drivers
- Sample menu items

## High-Level Architecture

```
                                    ┌─────────────────────────────────┐
                                    │          Client Apps            │
                                    │   (Customer, Driver, Admin)     │
                                    └───────────────┬─────────────────┘
                                                    │
                                         ┌──────────┴──────────┐
                                         │                     │
                                    HTTPS│                     │WebSocket
                                         │                     │
                              ┌──────────▼──────────┐  ┌───────▼───────┐
                              │     API Server      │  │  WebSocket    │
                              │    (Express.js)     │  │   Handler     │
                              └──────────┬──────────┘  └───────┬───────┘
                                         │                     │
        ┌────────────────────────────────┼─────────────────────┼──────────┐
        │                                │                     │          │
┌───────▼───────┐            ┌───────────▼───────────┐  ┌──────▼──────┐  │
│ Auth Service  │            │   Location Service    │  │  Tracking   │  │
│               │            │                       │  │  Service    │  │
│ - Register    │            │ - Driver positions    │  │             │  │
│ - Login       │            │ - Geo indexing        │  │ - Pub/Sub   │  │
│ - Sessions    │            │ - Nearby search       │  │ - ETA       │  │
└───────────────┘            └───────────┬───────────┘  └─────────────┘  │
                                         │                               │
┌───────────────┐            ┌───────────▼───────────┐                   │
│ Order Service │            │   Matching Service    │                   │
│               │            │                       │                   │
│ - Create      │            │ - Driver selection    │                   │
│ - Update      │            │ - Scoring algorithm   │                   │
│ - History     │            │ - Offer management    │                   │
└───────┬───────┘            └───────────────────────┘                   │
        │                                                                 │
        └─────────────────────────────┬───────────────────────────────────┘
                                      │
                   ┌──────────────────┼──────────────────┐
                   │                  │                  │
            ┌──────▼──────┐   ┌───────▼───────┐  ┌──────▼──────┐
            │  PostgreSQL │   │     Redis     │  │   Redis     │
            │             │   │  (Geo Index)  │  │  (Pub/Sub)  │
            │ - Users     │   │               │  │             │
            │ - Orders    │   │ - Locations   │  │ - Events    │
            │ - Merchants │   │ - Sessions    │  │ - Updates   │
            └─────────────┘   └───────────────┘  └─────────────┘
```

### Core Components

1. **Auth Service**
   - User registration and login
   - Session-based authentication with Redis
   - Role-based access control (customer, driver, merchant, admin)

2. **Order Service**
   - Order lifecycle management
   - State machine (pending -> confirmed -> preparing -> picked_up -> delivered)
   - Order items and pricing

3. **Location Service**
   - Ingests driver location updates
   - Maintains real-time geo index in Redis
   - Supports nearby driver queries using GEORADIUS

4. **Matching Service**
   - Assigns orders to drivers
   - Scoring algorithm considers distance, rating, acceptance rate, current load
   - Handles driver acceptance/rejection with 30-second timeout

5. **Tracking Service**
   - Real-time location streaming to customers via WebSocket
   - ETA calculations based on Haversine distance
   - Redis Pub/Sub for message distribution

## Data Model

### PostgreSQL Schema

**Users Table**
- id, email, password_hash, name, phone, role
- Roles: customer, driver, merchant, admin

**Drivers Table**
- id (FK to users), vehicle_type, status, rating, total_deliveries
- current_lat, current_lng, location_updated_at

**Merchants Table**
- id, name, address, lat, lng, category, avg_prep_time_minutes, rating, is_open

**Orders Table**
- id, customer_id, merchant_id, driver_id, status
- delivery_address, delivery_lat, delivery_lng
- subtotal, delivery_fee, tip, total
- timestamps for each state transition

**Order Items Table**
- id, order_id, menu_item_id, name, quantity, unit_price

### Redis Data Structures

```
# Driver locations (geo index)
drivers:locations          -> GEOADD (lng, lat, driver_id)

# Driver metadata
driver:{id}                -> HASH (lat, lng, status, updated_at)

# Active orders by driver
driver:{id}:orders         -> SET [order_ids]

# Session storage
session:{token}            -> JSON (userId, expiresAt)

# Real-time location pubsub
driver:{id}:location       -> PUBSUB channel
order:{id}:status          -> PUBSUB channel
```

## API Design

### Customer API
- `GET /api/v1/merchants` - Browse nearby merchants
- `GET /api/v1/merchants/:id/menu` - Get menu
- `POST /api/v1/orders` - Place order
- `GET /api/v1/orders/:id` - Get order details
- WebSocket: Subscribe to order tracking

### Driver API
- `POST /api/v1/driver/go-online` - Start accepting orders
- `POST /api/v1/driver/go-offline` - Stop accepting orders
- `POST /api/v1/driver/location` - Update location
- `POST /api/v1/driver/offers/:id/accept` - Accept order
- `POST /api/v1/driver/orders/:id/delivered` - Complete delivery

### Admin API
- `GET /api/v1/admin/stats` - Dashboard statistics
- `GET /api/v1/admin/orders` - View all orders
- `GET /api/v1/admin/drivers` - View all drivers

## Key Design Decisions

### 1. Real-time Driver Location with Redis Geo

Using Redis GEOADD/GEORADIUS for driver location tracking:
- Sub-millisecond query times for nearby driver searches
- Efficient for real-time matching requirements
- Location updates published via Redis Pub/Sub

### 2. Scoring-based Driver Matching

Driver selection algorithm considers multiple factors:
- Distance to pickup (40% weight)
- Driver rating (25% weight)
- Acceptance rate (20% weight)
- Current order load (15% weight)

### 3. WebSocket for Real-time Updates

- Customers subscribe to order updates
- Drivers receive new offers in real-time
- Location updates streamed to tracking subscribers

### 4. Session-based Authentication

- Tokens stored in Redis with TTL
- Fast validation without database queries
- Easy session invalidation on logout

## Technology Stack

- **Frontend**: React 19, TypeScript, Vite, Tanstack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, WebSocket (ws library)
- **Database**: PostgreSQL 16
- **Cache/Geo**: Redis 7
- **Containerization**: Docker Compose

## Scalability Considerations

### Geographic Sharding (Production)
- Partition by city/region
- Each region has its own Redis instance for geo queries
- Cross-region queries routed appropriately

### Horizontal Scaling
- Stateless API servers behind load balancer
- Redis Cluster for geo operations
- PostgreSQL read replicas for query scaling

### Current Local Setup
- Single PostgreSQL instance
- Single Redis instance
- Multiple API server instances on different ports

## Trade-offs and Alternatives

| Decision | Trade-off |
|----------|-----------|
| Redis geo-index | Fast queries, but data loss risk on failure |
| 3-second location updates | Accuracy vs. bandwidth/battery |
| Sequential driver offers | Fair, but slower matching |
| Session tokens in Redis | Fast validation, but requires Redis availability |

### Alternatives Considered

1. **PostgreSQL PostGIS for locations**
   - More durable
   - Slower for real-time queries
   - Better for historical analysis

2. **JWT for authentication**
   - Stateless
   - Cannot revoke tokens instantly
   - More complex refresh flow

3. **Socket.io instead of WebSocket**
   - More features (rooms, acknowledgments)
   - Higher overhead
   - Native WebSocket sufficient for our needs

## Monitoring and Observability

### Metrics to Track
- Order placement rate
- Driver acceptance rate
- Average delivery time
- ETA accuracy
- WebSocket connection count
- Redis geo query latency

### Health Checks
- `/health` endpoint checks PostgreSQL and Redis connectivity

## Security Considerations

- Password hashing with bcrypt
- Session tokens with expiration
- Role-based access control
- Input validation on all endpoints
- CORS configuration for frontend

## Future Optimizations

- [ ] Add Prometheus + Grafana for monitoring
- [ ] Implement surge pricing based on demand/supply
- [ ] Add multi-stop route optimization (TSP)
- [ ] Machine learning for demand prediction
- [ ] Implement push notifications
- [ ] Add payment integration (Stripe)
- [ ] Performance testing with k6 or Artillery
