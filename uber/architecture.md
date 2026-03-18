# Uber - Ride Hailing - Architecture Design

## System Overview

A ride-hailing platform connecting riders and drivers with real-time matching, location tracking, and dynamic pricing. This document describes the production-scale architecture (how Uber would work at millions of concurrent users) and the local implementation (what we actually built with Docker + Node.js + Express + React).

## Requirements

### Functional Requirements

1. **Rider Experience**
   - Request a ride from current location to destination
   - See nearby available drivers on a map
   - Get fare estimates with surge pricing before booking
   - Track driver location in real-time after matching
   - Rate drivers after trip completion

2. **Driver Experience**
   - Toggle availability status (online/offline)
   - Receive ride offers with passenger details, ETA, and estimated fare
   - Accept or decline ride offers within a countdown timer
   - Navigate through pickup, arrival, start, and complete states
   - View earnings and trip history

3. **Matching System**
   - Match riders with optimal nearby drivers using scoring algorithm
   - Handle surge pricing during high demand periods
   - Calculate ETAs based on distance and traffic estimates
   - Support multiple vehicle types (economy, comfort, premium, XL)

4. **Payment**
   - Hold authorization at ride request time
   - Calculate final fare based on actual distance and duration
   - Process driver payout after ride completion

5. **Safety**
   - Trip sharing with contacts
   - Emergency button integration
   - Driver identity verification

### Non-Functional Requirements

- **Latency**: Matching should complete within 3-5 seconds; location updates propagated within 1 second
- **Availability**: 99.99% uptime -- riders stranded without the app is a critical business risk
- **Scale**: 10M DAU, 5M rides/day, 1.67M location updates/second at peak
- **Consistency**: Strong consistency for ride state transitions and payments; eventual consistency for location updates
- **Durability**: Zero lost payments; ride history retained for regulatory compliance

## Capacity Estimation

### Production Scale

| Metric | Value | Derivation |
|--------|-------|------------|
| DAU | 10M | 50% riders, 50% drivers |
| Rides per day | 5M | ~58 rides/second average, ~175/s peak |
| Location updates/sec (peak) | 1.67M | 5M drivers updating every 3 seconds |
| Ride data storage | ~5 GB/day | ~1 KB per ride record |
| Location event storage | ~500 GB/day | If all updates are logged for analytics |
| WebSocket connections (peak) | ~3M concurrent | Active riders + online drivers |

### Local Development Scale

- 5-10 concurrent users (mix of riders and drivers)
- 3 active drivers sending location updates every 3-5 seconds
- Single PostgreSQL instance, single Redis instance
- All services running on localhost

## High-Level Architecture

### Production Architecture

```
┌──────────────┐                                              ┌──────────────┐
│  Rider App   │                                              │  Driver App  │
│  (Mobile)    │                                              │  (Mobile)    │
└──────┬───────┘                                              └──────┬───────┘
       │                                                             │
       │              ┌─────────────────┐                            │
       │              │   CDN (Maps +   │                            │
       │              │  Static Assets) │                            │
       │              └─────────────────┘                            │
       │                                                             │
       └────────────────────┬────────────────────────────────────────┘
                            │
                     ┌──────┴───────┐
                     │  API Gateway │
                     │  + Load      │
                     │  Balancer    │
                     └──────┬───────┘
                            │
      ┌─────────────────────┼─────────────────────┐
      │                     │                      │
      ▼                     ▼                      ▼
┌───────────┐        ┌────────────┐         ┌────────────┐
│ Ride      │        │ Location   │         │ Pricing    │
│ Service   │        │ Service    │         │ Service    │
│           │        │            │         │            │
│ - Request │        │ - Ingest   │         │ - Fare     │
│ - Match   │        │ - Geo query│         │ - Surge    │
│ - Status  │        │ - ETA      │         │ - Estimate │
└─────┬─────┘        └─────┬──────┘         └────────────┘
      │                     │
      │     ┌───────────────┼───────────────┐
      │     │               │               │
      │     ▼               ▼               ▼
      │ ┌─────────┐   ┌─────────┐   ┌──────────────┐
      │ │ Redis   │   │WebSocket│   │  Routing /   │
      │ │ Cluster │   │ Server  │   │  Maps API    │
      │ │         │   │         │   │              │
      │ │ - Geo   │   │ - Live  │   │ - ETA calc   │
      │ │ - Demand│   │   push  │   │ - Routes     │
      │ │ - Cache │   │ - Auth  │   │ - Geofencing │
      │ └─────────┘   └─────────┘   └──────────────┘
      │
      ├─────────────────────────────────┐
      │                                 │
      ▼                                 ▼
┌───────────┐                    ┌─────────────┐
│PostgreSQL │                    │    Kafka     │
│ (Sharded) │                    │             │
│           │                    │ - ride.events│
│ - Users   │                    │ - locations  │
│ - Rides   │                    │ - payments   │
│ - Payments│                    └──────┬──────┘
└───────────┘                           │
                          ┌─────────────┼─────────────┐
                          ▼             ▼             ▼
                    ┌───────────┐ ┌──────────┐ ┌──────────┐
                    │Notification│ │Analytics │ │ Payment  │
                    │  Worker   │ │  Worker  │ │ Worker   │
                    └───────────┘ └──────────┘ └──────────┘
```

## Core Components

### 1. Location Tracking Service

**Production design**: Drivers send GPS updates every 3-4 seconds over a persistent WebSocket connection. Each update is written to Redis using `GEOADD` for the geospatial index and published to Kafka `locations` topic for downstream consumers (analytics, ETA refinement, safety monitoring).

**Why Redis GeoSpatial?** Finding nearby drivers requires sub-millisecond queries across millions of locations. Redis `GEORADIUS` (or `GEOSEARCH` in Redis 6.2+) provides O(N+log(M)) performance where N is the number of results and M is the number of elements in the sorted set. PostgreSQL with PostGIS could handle this but adds 10-50x latency for the same query. Tile38 is purpose-built for geofencing but introduces operational complexity for a feature Redis handles natively.

**Location data flow:**

```
Driver App ──WebSocket──▶ Location Service ──▶ Redis GEOADD (hot index)
                                            ──▶ Kafka "locations" topic
                                            ──▶ PostgreSQL (async persist)
```

**Redis keys:**

```
drivers:available                          # Geo sorted set of all available drivers
driver:status:{driver_id}                  # "available" | "on_ride" | "offline"
driver:location:{driver_id}               # Hash: lat, lng, timestamp (60s TTL)
```

**Stale update handling**: Location updates older than 10 seconds are silently dropped. The `driver:location` hash includes a timestamp, and the 60-second TTL ensures stale entries auto-expire if a driver disconnects without going offline.

### 2. Matching Engine

**Production design**: When a rider requests a ride, the system publishes a matching request to a work queue. A pool of matching workers consume these requests, query Redis for nearby available drivers, score them, and offer the ride to the best candidate.

**Matching algorithm**: The scoring function combines two signals with weighted importance:

- **ETA score (60% weight)**: Lower ETA produces higher score. Normalized assuming a max 30-minute ETA: `etaScore = max(0, 1 - eta/30)`.
- **Rating score (40% weight)**: Higher rating is better. Normalized from the 3-5 rating scale: `ratingScore = (rating - 3) / 2`.
- **Final score**: `0.6 * etaScore + 0.4 * ratingScore`

Drivers are sorted by score descending. The top-scored driver receives the ride offer via WebSocket with a 15-second acceptance countdown. If declined or timed out, the next driver is offered. After 3 failed attempts, the ride is cancelled with "no drivers available."

**Why greedy matching over batch (Hungarian algorithm)?** Greedy matching completes in <100ms and is good enough for most scenarios. The Hungarian algorithm optimizes global assignment across all pending rides simultaneously, but requires batching requests (adding latency) and is O(n^3) complexity. At Uber's scale, a hybrid approach works: greedy for normal demand, batch optimization for surge zones where dozens of requests compete for the same drivers.

**Offer/accept/decline flow:**

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│  Rider   │     │   Matching   │     │   Driver     │
│ requests │────▶│   Worker     │────▶│  receives    │
│  ride    │     │  scores &    │     │  offer via   │
└──────────┘     │  selects     │     │  WebSocket   │
                 └──────┬───────┘     └──────┬───────┘
                        │                     │
                        │          ┌──────────┴──────────┐
                        │          │                     │
                        │    ┌─────┴─────┐         ┌────┴────┐
                        │    │  Accept   │         │ Decline │
                        │    │           │         │/Timeout │
                        │    └─────┬─────┘         └────┬────┘
                        │          │                    │
                        │          ▼                    ▼
                        │    ┌───────────┐       ┌───────────┐
                        │    │ Ride      │       │ Offer to  │
                        │    │ matched   │       │ next      │
                        │    │ (notify   │       │ driver    │
                        │    │  rider)   │       └───────────┘
                        │    └───────────┘
                        │
                        ▼
                  (after 3 failed
                   attempts)
                  ┌───────────┐
                  │ No drivers│
                  │ available │
                  └───────────┘
```

### 3. Surge Pricing

**Production design**: Surge pricing balances supply and demand in real-time. The system divides the map into geohash cells (~5km precision) and tracks demand (ride request count) and supply (available driver count) per cell.

**Surge multiplier calculation**: The ratio of available drivers to pending requests determines the multiplier:

| Supply/Demand Ratio | Surge Multiplier |
|----------------------|------------------|
| > 2.0 | 1.0x (normal) |
| 1.5 - 2.0 | 1.1x |
| 1.0 - 1.5 | 1.2x |
| 0.75 - 1.0 | 1.5x |
| 0.5 - 0.75 | 1.8x |
| 0.25 - 0.5 | 2.0x |
| < 0.25 | 2.5x (cap) |

**Why geohash over H3 hexagons?** Geohash is simpler to implement (pure string operations) and sufficient for our surge granularity. H3 hexagons provide more uniform area coverage and avoid edge effects at cell boundaries, making them better for production. The trade-off is implementation complexity: H3 requires a native library and more complex neighbor calculations, while geohash is a 30-line function.

**Demand tracking**: Each ride request increments a Redis counter keyed by geohash with a 5-minute TTL. Cancelled or matched rides decrement the counter. This provides a rolling demand window without requiring explicit cleanup.

### 4. Trip Lifecycle

The ride progresses through a strict state machine:

```
requested ──▶ matched ──▶ driver_arrived ──▶ picked_up ──▶ completed
    │             │              │
    ▼             ▼              ▼
cancelled     cancelled      cancelled
```

**State transition guarantees**: Each transition uses optimistic locking with a version check in PostgreSQL. The UPDATE query includes a WHERE clause on the current expected status, and if zero rows are affected, the transition is rejected (stale state or already transitioned). This prevents race conditions when, for example, a rider cancels while the driver simultaneously marks arrival.

**Concurrent driver matching**: When multiple matching workers target the same driver for different rides, the first `UPDATE drivers SET is_available = FALSE WHERE is_available = TRUE` wins. The losing request re-enters the matching queue to find another driver. The driver assignment and ride update are wrapped in a single PostgreSQL transaction.

### 5. Payment Processing

**Production design**: Payment follows a two-phase pattern:

1. **Authorization hold**: When a ride is requested, place a hold on the rider's payment method for the estimated fare + 20% buffer. This ensures funds are available without charging.
2. **Final capture**: When the ride completes, calculate the actual fare based on real distance/duration, capture the exact amount, and release the hold difference.
3. **Driver payout**: Aggregate completed ride earnings and process driver payouts on a scheduled basis (daily or weekly).

**Why hold-then-capture?** Direct charging at ride completion risks declined payments after the service is delivered. The hold pattern guarantees payment availability while allowing the final amount to differ from the estimate (traffic, route changes, wait time).

**Circuit breaker on payment gateway**: The payment service wraps external payment API calls in a circuit breaker. If the gateway fails (50% error rate over 5+ requests), the circuit opens and payments are queued for retry. The rider still completes the ride, and payment is captured within 1 hour. This prevents a payment outage from blocking the entire ride completion flow.

### 6. ETA Calculation

**Production design**: ETA combines routing engine data with real-time traffic conditions. The routing service provides distance and estimated travel time between two points, accounting for road topology, turn penalties, and current traffic.

**Local simplification**: ETA is calculated using Haversine distance with a fixed average speed of 30 km/h in urban areas: `etaMinutes = ceil(distanceKm / 30 * 60)`. This is accurate enough for demonstration but ignores roads, traffic, and one-way streets.

### 7. Maps and Geofencing

**Production design**: Integration with mapping services (Google Maps, Mapbox, or in-house routing like OSRM) provides:
- Route polylines for driver navigation
- Geocoding (address to coordinates and reverse)
- Geofenced zones for airport surcharges, restricted areas, and pricing regions
- Map tile rendering on client applications

**Local simplification**: No map integration. Locations are lat/lng coordinates with simulated addresses. The frontend uses text inputs instead of map-based location picking.

### 8. Safety Features

**Production design**:
- **Trip sharing**: Riders can share their live trip with contacts via a link showing real-time location
- **Emergency button**: One-tap connection to local emergency services with automatic location sharing
- **Driver verification**: Background checks, photo verification at login, document validation
- **Ride recording**: Optional audio recording during trips for dispute resolution

**Local simplification**: None of these are implemented. Authentication uses email/password with session tokens.

## Database Schema

### PostgreSQL Schema

```sql
-- Users table (both riders and drivers)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    user_type VARCHAR(10) NOT NULL CHECK (user_type IN ('rider', 'driver')),
    rating DECIMAL(2,1) DEFAULT 5.0,
    rating_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Drivers extended info
CREATE TABLE drivers (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('economy', 'comfort', 'premium', 'xl')),
    vehicle_make VARCHAR(50),
    vehicle_model VARCHAR(50),
    vehicle_color VARCHAR(30),
    license_plate VARCHAR(20) NOT NULL,
    is_available BOOLEAN DEFAULT FALSE,
    is_online BOOLEAN DEFAULT FALSE,
    current_lat DECIMAL(10,7),
    current_lng DECIMAL(10,7),
    total_rides INTEGER DEFAULT 0,
    total_earnings_cents INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Rides table
CREATE TABLE rides (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rider_id UUID NOT NULL REFERENCES users(id),
    driver_id UUID REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'matched', 'driver_arrived', 'picked_up', 'completed', 'cancelled')),
    pickup_lat DECIMAL(10,7) NOT NULL,
    pickup_lng DECIMAL(10,7) NOT NULL,
    pickup_address VARCHAR(500),
    dropoff_lat DECIMAL(10,7) NOT NULL,
    dropoff_lng DECIMAL(10,7) NOT NULL,
    dropoff_address VARCHAR(500),
    vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('economy', 'comfort', 'premium', 'xl')),
    estimated_fare_cents INTEGER,
    final_fare_cents INTEGER,
    surge_multiplier DECIMAL(3,2) DEFAULT 1.00,
    distance_meters INTEGER,
    duration_seconds INTEGER,
    rider_rating INTEGER CHECK (rider_rating >= 1 AND rider_rating <= 5),
    driver_rating INTEGER CHECK (driver_rating >= 1 AND driver_rating <= 5),
    cancellation_reason VARCHAR(255),
    cancelled_by VARCHAR(10) CHECK (cancelled_by IN ('rider', 'driver', 'system')),
    requested_at TIMESTAMP DEFAULT NOW(),
    matched_at TIMESTAMP,
    driver_arrived_at TIMESTAMP,
    picked_up_at TIMESTAMP,
    completed_at TIMESTAMP,
    cancelled_at TIMESTAMP
);

-- Ride location tracking (for ride history and analytics)
CREATE TABLE ride_locations (
    id SERIAL PRIMARY KEY,
    ride_id UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
    lat DECIMAL(10,7) NOT NULL,
    lng DECIMAL(10,7) NOT NULL,
    recorded_at TIMESTAMP DEFAULT NOW()
);

-- Payment methods
CREATE TABLE payment_methods (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('card', 'cash')),
    card_last_four VARCHAR(4),
    card_brand VARCHAR(20),
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Sessions, notifications, analytics tables
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    data JSONB,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE analytics_daily (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    metric_type VARCHAR(50) NOT NULL,
    count INTEGER DEFAULT 0,
    total_value DECIMAL(12,2) DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (date, metric_type)
);

CREATE TABLE analytics_hourly (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL,
    hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
    rides_completed INTEGER DEFAULT 0,
    revenue DECIMAL(12,2) DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (date, hour)
);

CREATE TABLE driver_earnings (
    id SERIAL PRIMARY KEY,
    driver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    rides_completed INTEGER DEFAULT 0,
    total_earnings DECIMAL(12,2) DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (driver_id, date)
);
```

**Key indexes:**

```sql
CREATE INDEX idx_drivers_availability ON drivers(is_online, is_available);
CREATE INDEX idx_drivers_location ON drivers(current_lat, current_lng) WHERE is_online = TRUE;
CREATE INDEX idx_rides_rider ON rides(rider_id);
CREATE INDEX idx_rides_driver ON rides(driver_id);
CREATE INDEX idx_rides_status ON rides(status);
CREATE INDEX idx_rides_requested_at ON rides(requested_at);
CREATE INDEX idx_sessions_token ON sessions(token);
```

### Redis (Real-time State)

```
# Driver locations (geospatial index)
GEOADD drivers:available {longitude} {latitude} {driver_id}

# Driver status
SET driver:status:{driver_id} "available" | "on_ride" | "offline"

# Driver location with timestamp
HSET driver:location:{driver_id} lat {lat} lng {lng} timestamp {ts}

# Demand counting per geohash
SET demand:{geohash} {count} EX 300

# Ride data for quick access
HSET ride:{ride_id} riderId status pickupLat pickupLng dropoffLat dropoffLng vehicleType createdAt

# Pending ride requests (sorted set by timestamp)
ZADD pending:requests {timestamp} {ride_id}
```

### Kafka Topics (Production) / RabbitMQ Queues (Local)

| Topic/Queue | Purpose | Consumers |
|-------------|---------|-----------|
| `matching.requests` | Ride requests waiting for driver matching | Matching workers |
| `ride.events` (fanout) | All ride lifecycle events | Notifications, Analytics, Billing |
| `notifications` | Push/SMS/email delivery | Notification worker |
| `analytics` | Event sink for data warehouse | Analytics worker |
| `dead.letter.queue` | Failed messages after max retries | Admin/manual review |

## API Design

### Authentication

```
POST /api/auth/register/rider    → Register as rider
POST /api/auth/register/driver   → Register as driver with vehicle info
POST /api/auth/login             → Login (returns session token)
GET  /api/auth/me                → Get current user profile
POST /api/auth/logout            → Destroy session
```

### Rides (Rider)

```
POST /api/rides/estimate         → Get fare estimates for all vehicle types
POST /api/rides/request          → Request a ride (idempotent with X-Idempotency-Key)
GET  /api/rides/:rideId          → Get ride status with driver info
POST /api/rides/:rideId/cancel   → Cancel ride (idempotent)
POST /api/rides/:rideId/rate     → Rate the driver (1-5 stars)
GET  /api/rides/history          → Rider's past rides
```

### Driver

```
POST /api/driver/online          → Go online (start receiving offers)
POST /api/driver/offline         → Go offline
POST /api/driver/location        → Update location (also via WebSocket)
POST /api/driver/rides/:rideId/accept    → Accept ride offer
POST /api/driver/rides/:rideId/arrived   → Notify arrival at pickup
POST /api/driver/rides/:rideId/start     → Start ride (rider picked up)
POST /api/driver/rides/:rideId/complete  → Complete ride at dropoff
GET  /api/driver/earnings        → Earnings summary
GET  /api/driver/history         → Trip history
```

### WebSocket Events

```
Client ──▶ Server:
  { type: "auth", token: "session-token" }
  { type: "location_update", lat: 37.77, lng: -122.41 }
  { type: "ping" }

Server ──▶ Driver:
  { type: "ride_offer", rideId, rider, pickup, dropoff, estimatedFare, expiresIn }

Server ──▶ Rider:
  { type: "ride_matched", rideId, driver }
  { type: "driver_arrived", rideId }
  { type: "ride_started", rideId }
  { type: "ride_completed", rideId, fare }
  { type: "ride_cancelled", rideId, cancelledBy, reason }
  { type: "no_drivers_available", rideId }

Server ──▶ Both:
  { type: "auth_success", userId }
  { type: "connected", timestamp }
  { type: "pong", timestamp }
```

## Frontend Architecture

The frontend is a React 19 + TypeScript application built with Vite, using TanStack Router for file-based routing and Zustand for global state management. The application serves two distinct personas (rider and driver) within a single codebase, with role-based routing and a WebSocket service that provides real-time updates for both.

### Component Hierarchy

```
__root.tsx (role-based navigation + Outlet)
├── index.tsx           → Landing page / role-based redirect
├── login.tsx           → Unified login for riders and drivers
├── register.tsx        → Registration with rider/driver selection
├── rider.tsx           → Rider dashboard (pickup/dropoff, estimates, ride status)
│   └── rider/history.tsx → Ride history with pagination
├── driver.tsx          → Driver dashboard (online/offline, ride offers, trip lifecycle)
│   ├── driver/earnings.tsx → Earnings by period (today/week/month)
│   └── driver/history.tsx  → Completed trip history
```

The root layout provides role-based navigation -- after login, the root route detects the user type (`rider` or `driver`) from the auth store and renders the appropriate navigation links.

### Routing with TanStack Router

TanStack Router's file-based routing maps each file to a URL path. Nested routes like `driver/earnings.tsx` create nested URL segments (`/driver/earnings`). The `$` prefix creates dynamic segments (not used here since rides are accessed via store state rather than URL parameters).

There are no route guards enforcing authentication at the router level. Instead, each page component checks `useAuthStore().user` and redirects to `/login` if null. The `checkAuth` method is called on app startup to restore the session from a persisted localStorage token.

### State Management (Zustand Stores)

Three Zustand stores manage global state, each handling a distinct concern:

**`authStore`** -- Manages user session with persistence middleware. The store persists only the JWT token to `localStorage` (not the full user object) via Zustand's `persist` middleware with `partialize`. On app startup, `checkAuth` reads the token from localStorage, validates it with the backend (`GET /api/auth/me`), and reconnects the WebSocket. On login/register, the store saves the token and immediately connects the WebSocket for real-time updates. On logout, it clears the token, disconnects the WebSocket, and resets user state.

**`rideStore`** -- Manages the complete rider-side ride lifecycle. Tracks pickup/dropoff locations, fare estimates for all vehicle types, the selected vehicle type, the current active ride, ride status, and nearby driver positions. The store registers WebSocket event handlers at initialization time (outside the store creation function) to react to server-pushed events: `ride_matched` updates the ride with driver info, `driver_arrived`/`ride_started`/`ride_completed` transition the ride status, `ride_cancelled` clears the ride and shows an error, and `no_drivers_available` notifies the user. This event-driven pattern means the rider UI updates instantly when the driver accepts, arrives, or completes -- no polling required.

**`driverStore`** -- Manages driver availability and trip progression. Tracks online/offline status, current location, active ride assignment, pending ride offers with expiration timestamps, and earnings data. The store sends location updates through both WebSocket (for real-time tracking with low latency) and HTTP API (for reliable persistence). Ride offers arrive via WebSocket with an `expiresIn` countdown -- the UI shows a timer based on `offerExpiresAt`, and declining fires an API call but does not wait for a response (fire-and-forget pattern for responsiveness).

### WebSocket Service

The WebSocket service (`services/websocket.ts`) is implemented as a singleton class that provides bidirectional real-time communication between the frontend and backend.

**Connection lifecycle**: The service connects when the user logs in, authenticates by sending the JWT token as the first message, and automatically reconnects on disconnection with linear backoff (delay increases by 1 second per attempt, up to 5 attempts). The connection URL derives from `window.location` to work seamlessly with the Vite development proxy.

**Message routing**: Incoming messages are JSON-parsed and routed to handlers registered via the `on(type, handler)` method. Stores subscribe to specific event types (`ride_offer`, `ride_matched`, etc.) during initialization. A wildcard `'*'` handler can be registered for debugging/logging all messages. The `off(type, handler)` method allows cleanup when components unmount.

**Outbound messages**: The service provides typed methods for common operations: `sendLocationUpdate(lat, lng)` for driver position updates and `ping()` for keepalive.

### Data Fetching Pattern

Data flows through: **Component -> Store action -> API Service -> Backend -> Store update -> Component re-render**.

The API service (`services/api.ts`) is organized by domain (`auth`, `rides`, `driver`) and attaches the JWT token from localStorage to every request via an `Authorization: Bearer` header. The generic `request<T>()` helper handles JSON serialization, error extraction, and type casting.

For the rider flow: the component calls a store action (e.g., `requestRide()`), which calls the API service (`api.rides.request()`), receives the response, and updates the store state. The component re-renders reactively because it subscribes to the store via Zustand's hook.

For real-time updates: the WebSocket pushes events directly to store handlers, which update state, triggering component re-renders without any component involvement.

**Dual-channel location updates**: The driver store sends location updates through both WebSocket and HTTP API simultaneously. WebSocket provides low-latency delivery for real-time tracking, while the HTTP API provides reliable persistence even if the WebSocket connection is momentarily interrupted. The HTTP call fails silently -- location updates are not critical enough to show errors to the driver.

### Key UI Patterns

**Ride offer countdown**: When a driver receives a ride offer via WebSocket, the store records `offerExpiresAt = Date.now() + expiresIn * 1000`. The driver UI component uses this timestamp to render a countdown timer. When the timer reaches zero, the offer is automatically declined. This creates urgency for drivers to respond while ensuring the system can offer the ride to the next driver.

**Fare estimate display**: When the rider enters pickup and dropoff locations, `fetchEstimates()` calls the backend which returns estimates for all vehicle types (economy, comfort, premium, XL) with surge multipliers. The rider selects a vehicle type, and the selected estimate updates in the store. This avoids separate API calls per vehicle type.

**Trip lifecycle state machine on the driver side**: The driver UI renders different action buttons based on the current ride status: "Accept" when a ride offer is pending, "Arrived" when matched (driving to pickup), "Start Ride" when at pickup, and "Complete" when rider is picked up. Each transition calls a store action that hits the API and optimistically updates the local ride status.

---

## Deep Pattern Explanations

This section explains each production-grade pattern used in the architecture, what problem it solves, and how it works in this system.

### Redis Geospatial Indexing

**The problem**: When a rider requests a ride, the system needs to find nearby available drivers within seconds. With 5M drivers updating their locations every 3 seconds, a traditional database query (`SELECT * FROM drivers WHERE distance(lat, lng, ?, ?) < 5`) would require computing the Haversine formula for every row. Even with a spatial index, PostgreSQL/PostGIS adds 10-50x latency compared to an in-memory solution.

**How it works**: Redis provides native geospatial commands built on sorted sets. `GEOADD drivers:available longitude latitude driverId` stores a driver's location. `GEOSEARCH drivers:available FROMLONLAT lng lat BYRADIUS 5 km COUNT 20 ASC WITHDIST` returns the 20 nearest drivers within 5km, sorted by distance, with the distance included. Under the hood, Redis encodes lat/lng into a 52-bit geohash stored as the sorted set score, enabling efficient range queries.

**Why Redis over PostGIS for this use case**: Driver locations are ephemeral hot data -- they change every 3 seconds and only matter while the driver is online. Redis keeps everything in memory with sub-millisecond query times. PostGIS would require disk I/O and connection pool management for data that is overwritten seconds later. The trade-off is that Redis stores all data in memory (~200MB for 5M drivers), but this is well within a single instance's capacity.

### WebSocket Bidirectional Communication

**The problem**: Ride-hailing requires both server-to-client push (ride offers to drivers, status updates to riders) and client-to-server push (driver location updates every 3 seconds). With HTTP polling at 1-second intervals, 3M concurrent users would generate 3M requests/second just for status checks -- overwhelming the API servers with requests that return "no change" 99% of the time.

**How it works**: A WebSocket connection is a persistent, full-duplex TCP connection established via an HTTP upgrade handshake. Once connected, both client and server can send messages at any time without the overhead of HTTP headers on each message. In this project, after the WebSocket connection opens, the client sends an `auth` message with the JWT token. The server validates the token and associates the connection with a user ID, enabling targeted message delivery.

**Connection management at scale**: WebSocket connections are stateful -- each server instance holds a subset of active connections. To send a message to a specific user, the system needs to know which server holds their connection. In production, this is solved with Redis Pub/Sub: each server subscribes to a channel, and when a message needs to reach a user, it is published to the channel where the correct server receives it. The local implementation runs a single server instance, avoiding this complexity.

**Reconnection with exponential backoff**: When the connection drops (network change, server restart), the client attempts to reconnect with increasing delays (1s, 2s, 3s, 4s, 5s) up to 5 attempts. This prevents thundering herd -- if a server restarts and 50K clients all reconnect simultaneously, staggered delays spread the reconnection load over several seconds.

### Idempotency Keys

**The problem**: A rider taps "Request Ride" on a mobile app. The request is sent, but the network is slow and no response comes back. The app shows a spinner for 5 seconds and times out. Did the ride get created or not? The user taps again. Without idempotency protection, the system creates two rides and potentially charges the rider twice.

**How it works**: The client generates a unique UUID for each logical operation and sends it as the `X-Idempotency-Key` header. The server middleware (`backend/src/middleware/idempotency.ts`) follows this flow:

1. Check Redis for `idempotency:{operation}:{userId}:{key}`
2. If key exists with a completed response: return the cached response (the ride was already created)
3. If key exists as "pending": return 409 Conflict (the first request is still processing)
4. If key does not exist: set a "pending" marker with NX (only-set-if-not-exists) and 60s TTL, then process the request
5. After processing: cache the response with a 24-hour TTL
6. If Redis is unavailable: proceed without idempotency protection (fail-open for availability)

The NX flag on the Redis SET command prevents a race condition where two identical requests arrive simultaneously -- only the first one succeeds in setting the pending marker.

### Circuit Breaker Pattern

**The problem**: If Redis becomes slow (network issues, memory pressure), every matching request waits for the timeout. These waiting requests consume server resources, causing the API to become unresponsive even for endpoints that do not need Redis (like login or ride history). One failing dependency takes down the entire system.

**How it works**: The circuit breaker (`backend/src/utils/circuitBreaker.ts`) uses the Opossum library and operates in three states:

- **CLOSED**: Requests flow normally. The breaker tracks the failure rate over a rolling window (e.g., 10 seconds with 50% threshold over 5+ requests).
- **OPEN**: When failures exceed the threshold, the circuit opens. All subsequent requests fail immediately (< 1ms) with a fallback response. For Redis geo operations, the fallback returns an empty driver list. The user sees "No drivers available" -- a degraded but honest response rather than a hanging spinner.
- **HALF-OPEN**: After a reset timeout (15 seconds), the breaker allows one probe request through. If it succeeds, the circuit closes. If it fails, the circuit opens again for another reset period.

Circuit breaker state transitions are emitted as Prometheus metrics, enabling alerts when circuits open (indicating a dependency failure).

### Surge Pricing with Geohash Partitioning

**The problem**: Dynamic pricing needs to balance supply (available drivers) and demand (ride requests) in real-time, but the supply/demand ratio varies by location. A concert venue might have surge while a neighborhood 2km away has normal pricing.

**How it works**: The map is divided into geohash cells (~5km precision). A geohash encodes a geographic coordinate into a string (e.g., "9q8yy") where each character narrows the area. Ride requests increment a Redis counter keyed by geohash (`demand:9q8yy`) with a 5-minute TTL, creating a rolling demand window. Supply is counted by running `GEORADIUS` within the same geohash area. The supply/demand ratio maps to a surge multiplier table (ratio > 2.0 = 1.0x, ratio < 0.25 = 2.5x cap).

**Why geohash over H3 hexagons**: Geohash is implementable with pure string operations (30 lines of code). H3 hexagons provide more uniform area coverage and avoid edge effects at cell boundaries, but require a native C library and more complex neighbor calculations. For surge pricing granularity, the imprecision of geohash boundaries is acceptable.

### Optimistic Locking for State Transitions

**The problem**: The ride state machine has strict transitions (requested -> matched -> driver_arrived -> picked_up -> completed). When a rider cancels while the matching engine simultaneously assigns a driver, both operations try to update the same ride. Without protection, the ride could end up in an inconsistent state -- cancelled but with a driver assigned.

**How it works**: Every state transition includes a WHERE clause on the expected current status:

```sql
UPDATE rides SET status = 'matched', driver_id = $1
WHERE id = $2 AND status = 'requested'
RETURNING *;
```

If zero rows are returned, the transition is rejected -- someone else already changed the status. The caller can then check the current status and respond appropriately (e.g., the matching engine re-enqueues the ride request to find another driver).

This is "optimistic" because it allows parallel reads (no locks held during the read phase) and only detects conflicts at write time. The alternative, pessimistic locking (`SELECT ... FOR UPDATE`), would serialize all operations on the same ride, creating a bottleneck under high concurrency.

### Structured Logging (Pino)

**The problem**: `console.log("Ride created")` is useless in production. When debugging why a ride matching failed at 3 AM, you need to search millions of log lines by ride ID, user ID, or error type. Plain text logs cannot be searched by field, have no severity levels, and cannot be ingested by log aggregation systems (ELK, Datadog).

**How it works**: Pino outputs JSON-formatted log lines with structured fields: `{"level":"info","time":1710000000,"service":"matching","rideId":"abc","msg":"Driver matched"}`. Each field is searchable. Service-specific loggers (`createModuleLogger('matching')`) tag all logs from a module, enabling filtering by component. Request logging middleware captures HTTP method, path, status code, and duration for every request.

### Prometheus Metrics (RED Method)

**The problem**: You need to answer "how is the system performing right now?" in real-time. Logs tell you what happened to individual requests; metrics give aggregate views. Without metrics, you discover problems when users complain, not when they start.

**How it works**: The backend exposes 20+ custom metrics on `/metrics` in Prometheus exposition format. Three metric types are used:
- **Counter** (monotonically increasing): `uber_ride_requests_total` -- counts total ride requests, partitioned by vehicle type and status. Rate of change tells you requests/second.
- **Histogram** (distribution of values): `uber_ride_matching_duration_seconds` -- tracks how long matching takes. Prometheus computes percentiles (p50, p95, p99) from histogram buckets.
- **Gauge** (current value): `uber_drivers_online_total` -- how many drivers are online right now.

The **RED method** monitors three signals per service: Rate (requests/second), Errors (error rate), and Duration (latency percentiles). Alerting rules fire when these deviate from baseline.

### Health Checks (Liveness vs Readiness)

**The problem**: Load balancers need to know which server instances can handle traffic. A process might be running but unable to serve requests because Redis is down. Sending traffic to this instance would result in errors for every matching request.

**How it works**: Three endpoints serve different purposes:
- **`/health/live`**: Returns 200 if the process is running. Used by Kubernetes as a liveness probe -- if this fails, the container is restarted. Does NOT check external dependencies, because a Redis outage should not trigger mass container restarts.
- **`/health/ready`**: Checks that PostgreSQL and Redis are responsive. Used as a readiness probe -- if this fails, the load balancer stops sending traffic but does not restart the instance. When dependencies recover, the instance automatically becomes ready again.
- **`/health`**: Detailed status with latency measurements for each dependency, circuit breaker states, and memory usage. Used for dashboards and debugging, not for automated decisions.

### Async Queue Processing (RabbitMQ)

**The problem**: When a rider requests a ride, the system needs to find a driver, send notifications, and record analytics. If all of this happens synchronously in the API request handler, the rider waits 2-5 seconds for a response. If the notification service is slow, the entire ride request is delayed.

**How it works**: The ride request API immediately creates the ride in PostgreSQL, publishes a matching request to the `matching.requests` queue, and returns a response to the rider in < 200ms. A separate matching worker consumes from the queue, finds nearby drivers, scores them, and sends a ride offer via WebSocket. The worker operates independently -- if it crashes, the message stays in the queue and is reprocessed.

A fanout exchange (`ride.events.fanout`) broadcasts ride lifecycle events to multiple queues: notifications (to alert drivers/riders), analytics (to record metrics), and potentially billing (future). Each consumer reads independently at its own pace.

**Dead letter queue**: Messages that fail after 3 retries (with exponential backoff delays of 2s, 4s, 8s) are routed to the `dead.letter.queue` for manual review. This prevents poison messages from blocking the queue while preserving them for debugging.

---

## Key Design Decisions

### Redis Geo vs PostGIS vs Tile38

**Chosen: Redis Geo.** For the primary use case of "find 20 nearest available drivers within 5km," Redis GEORADIUS provides sub-millisecond responses at millions of entries. PostGIS handles complex spatial queries (polygons, intersections) but adds 10-50x latency for simple radius searches. Tile38 is purpose-built for geofencing and real-time spatial data but introduces another operational dependency. Redis is already in the stack for caching and sessions, making it the lowest-complexity choice.

**Trade-off**: Redis Geo stores everything in memory. At 5M drivers with 8 bytes per coordinate pair + member overhead, the geo index consumes ~200MB -- well within a single Redis instance. If we needed complex geofencing (airport zones, restricted areas), Tile38 or PostGIS would be necessary.

### WebSocket vs Server-Sent Events vs Polling

**Chosen: WebSocket.** The ride-hailing use case requires bidirectional real-time communication. Drivers send location updates (client-to-server) and receive ride offers (server-to-client) on the same connection. SSE only supports server-to-client push, which would require a separate HTTP channel for location updates. Polling at 1-second intervals creates 60 requests/minute per user; at 3M concurrent users, that is 3M requests/second just for status checks.

**Trade-off**: WebSocket connections are stateful, which complicates horizontal scaling. Each server instance holds a subset of connections, so sending a message to a specific user requires knowing which server holds their connection. In production, this is solved with a pub/sub layer (Redis Pub/Sub or a dedicated message broker) that routes messages to the correct server. Our local implementation sidesteps this by running a single server instance.

### RabbitMQ (Local) vs Kafka (Production)

**Chosen locally: RabbitMQ.** For local development with low throughput, RabbitMQ provides simpler setup and built-in features (dead letter queues, message TTL, management UI). In production, Kafka would be preferred for ride events because: (1) events are append-only and naturally ordered, (2) multiple consumers need independent read positions, (3) event replay capability is needed for analytics backfills, and (4) Kafka handles 1M+ messages/second per partition.

**Trade-off**: RabbitMQ is a traditional message broker (push-based, messages deleted after acknowledgment). Kafka is a distributed log (pull-based, messages retained for configurable duration). For matching requests (work queue semantics), RabbitMQ's model is actually a better fit. For ride events (fan-out to multiple consumers), Kafka's consumer group model is superior.

### Session Auth vs JWT

**Chosen: Session-based auth with Redis.** Session tokens stored in Redis provide immediate revocation (critical when a user reports a stolen device), simple implementation, and no token size overhead. JWTs are stateless but require complex revocation (blacklists, short expiry + refresh tokens) and carry payload in every request.

## Consistency and Idempotency

### Consistency Model by Operation

| Operation | Consistency | Rationale |
|-----------|-------------|-----------|
| Ride request | Strong (PostgreSQL transaction) | Must prevent double-booking |
| Driver location update | Eventual (Redis overwrite) | Latest location always wins |
| Ride state transition | Strong (optimistic locking) | State machine must be atomic |
| Payment capture | Strong (external idempotency) | Financial correctness required |
| Driver availability toggle | Eventual (Redis + DB sync) | Small delay acceptable |
| Rating submission | Strong (constraint check) | One rating per ride per party |

### Idempotency Key Strategy

All mutating API endpoints accept an `X-Idempotency-Key` header (client-generated UUID). The middleware uses Redis to track processed requests:

1. Check Redis for existing response with key `idempotency:{operation}:{userId}:{key}`
2. If found and completed: return cached response (prevents duplicate charges)
3. If found as "pending": return 409 (request in progress)
4. If not found: set "pending" marker (60s TTL, NX), process request, cache response (24h TTL)
5. If Redis is unavailable: proceed without idempotency (fail-open for availability)

### Ride State Machine Conflicts

State transitions use optimistic locking:

```sql
UPDATE rides
SET status = 'matched', driver_id = $1, matched_at = NOW()
WHERE id = $2 AND status = 'requested'
RETURNING *;
```

If zero rows are updated, the transition is rejected. This handles:
- Rider cancels while matching is in progress
- Two matching workers try to assign different drivers to the same ride
- Driver marks arrival while rider cancels

## Async Queue Architecture

### Queue Topology

```
                            ┌──────────────────────┐
                            │  ride.events.fanout  │ (fanout exchange)
                            └──────────┬───────────┘
           ┌───────────────────────────┼───────────────────────────┐
           ▼                           ▼                           ▼
   ┌───────────────┐           ┌───────────────┐           ┌───────────────┐
   │ notifications │           │   analytics   │           │  (billing -   │
   │    queue      │           │    queue      │           │   future)     │
   └───────┬───────┘           └───────┬───────┘           └───────────────┘
           ▼                           ▼
   ┌───────────────┐           ┌───────────────┐
   │  Notification │           │  Analytics    │
   │  Worker       │           │  Worker       │
   └───────────────┘           └───────────────┘

   ┌───────────────────┐
   │  matching.requests │ (work queue, single consumer per message)
   └─────────┬─────────┘
             ▼
   ┌───────────────┐
   │  Matching     │
   │  Worker(s)    │
   └───────────────┘
```

### Delivery Semantics

| Queue | Semantics | Ack Strategy | Retry Policy |
|-------|-----------|--------------|--------------|
| matching.requests | At-least-once | Manual ack after match | 3 retries with exponential backoff, then DLQ |
| notifications | At-least-once | Manual ack after send | 3 retries, then DLQ |
| analytics | At-most-once | Auto ack | No retries (best effort) |

### Backpressure Handling

- **Prefetch limit**: Channel prefetch set to 10, preventing workers from buffering too many messages
- **Queue TTL**: Matching requests expire after 5 minutes (stale ride requests are no longer relevant)
- **Dead letter exchange**: Failed messages after max retries are routed to `dead.letter.queue` for admin review

## Observability

### Prometheus Metrics

The backend exposes a `/metrics` endpoint with comprehensive instrumentation:

**Ride metrics:**
- `uber_ride_requests_total{vehicle_type, status}` -- ride request count by type and outcome
- `uber_ride_matching_duration_seconds{vehicle_type, success}` -- matching latency histogram
- `uber_rides_by_status{status}` -- current rides by status (gauge)
- `uber_ride_fare_cents{vehicle_type}` -- fare distribution histogram

**Driver metrics:**
- `uber_drivers_online_total{vehicle_type}` -- online driver count by vehicle type
- `uber_drivers_available_total{vehicle_type}` -- available (not on ride) driver count
- `uber_driver_location_updates_total` -- total location update count

**Surge metrics:**
- `uber_surge_multiplier{geohash}` -- current surge multiplier by zone
- `uber_surge_events_total{multiplier_range}` -- ride requests with surge pricing

**Infrastructure metrics:**
- `uber_circuit_breaker_state{circuit, state}` -- circuit breaker status
- `uber_circuit_breaker_requests_total{circuit, result}` -- circuit breaker request outcomes
- `uber_geo_query_duration_seconds{operation, success}` -- Redis geo query latency
- `uber_queue_messages_published_total{queue, event_type}` -- queue throughput
- `uber_queue_depth{queue}` -- current queue depth
- `uber_http_requests_total{method, path, status_code}` -- HTTP request count
- `uber_http_request_duration_seconds{method, path}` -- HTTP latency histogram
- `uber_idempotency_hits_total{operation}` -- duplicate request prevention count
- `uber_service_health{service}` -- dependency health status

### Health Check Endpoints

| Endpoint | Purpose | What it checks |
|----------|---------|----------------|
| `GET /health` | Detailed status | PostgreSQL, Redis, RabbitMQ latency; circuit breaker states; memory usage |
| `GET /health/live` | Liveness probe | Is the process running? |
| `GET /health/ready` | Readiness probe | Are critical dependencies (PostgreSQL, Redis) responsive? |

### Structured Logging

All services use Pino for structured JSON logging with service-specific loggers (e.g., `location-service`, `matching-service`, `ride-lifecycle`). Request logging middleware captures method, path, status, and duration for every HTTP request.

## Failure Handling

### Circuit Breakers

Circuit breakers (using Opossum) wrap calls to external dependencies to prevent cascade failures:

| Service | Timeout | Error Threshold | Reset Timeout | Fallback |
|---------|---------|-----------------|---------------|----------|
| Redis geo operations | 3s | 50% over 5 requests | 15s | Return empty driver list |
| Payment gateway | 10s | 50% | 30s | Queue payment for later |
| Routing/ETA API | 3s | 70% | 15s | Return cached or estimated ETA |
| Push notifications | 2s | 80% | 10s | Queue in Redis |

**How circuit breakers prevent cascade failures**: If Redis becomes slow (network issues, memory pressure), every matching request waits for the timeout. These waiting requests consume thread pool capacity, causing the API to become unresponsive even for endpoints that do not need Redis. The circuit breaker detects the 50% failure rate, opens the circuit, and subsequent requests fail immediately (<1ms) with a fallback response instead of waiting 3 seconds. The "no drivers nearby" fallback is better UX than a timeout error. After 15 seconds, the circuit tries one request (half-open state), and if it succeeds, normal operation resumes.

### Retry Strategy

All retries use exponential backoff with jitter to prevent thundering herd:

- **API layer**: 3 retries, base delay 100ms, max delay 5s
- **Queue consumers**: 3 retries, delays of 2s/4s/8s, then DLQ
- **Database writes**: 2 retries, base delay 100ms (for transient connection errors)
- **RabbitMQ connection**: 5 retries, base delay 1s, max delay 10s

### Graceful Degradation

| Failure | Degradation | User Impact |
|---------|-------------|-------------|
| Redis down | PostgreSQL bounding-box query for nearby drivers | Matching takes 2-5s instead of <1s |
| RabbitMQ down | Server starts without queue support, logs warning | Matching works synchronously (slower) |
| WebSocket server down | Client reconnects with exponential backoff (5 attempts) | Brief interruption in real-time updates |
| Payment gateway down | Ride completes, payment queued for retry | Payment processed within 1 hour |

### Graceful Shutdown

The server handles SIGTERM/SIGINT by: (1) stopping new connection acceptance, (2) closing RabbitMQ connection, (3) allowing 1 second for in-flight requests, (4) force-exit after 10 seconds.

## Scalability Considerations

### What Breaks First

1. **Location updates** (1.67M/s): Redis handles this on a single instance up to ~500K ops/s. Beyond that, shard by city/region using Redis Cluster with geographic hash slots.

2. **WebSocket connections** (3M concurrent): A single server handles ~50K connections. Deploy 60+ WebSocket servers behind a load balancer with sticky sessions. Use Redis Pub/Sub to route messages to the correct server.

3. **Matching workers**: CPU-bound scoring scales linearly with workers. Deploy 10-50 matching workers consuming from the same queue with prefetch limits.

4. **PostgreSQL writes**: Ride creation at 175/s is manageable. At higher scale, partition the rides table by `requested_at` (monthly) and shard by city using Citus or manual application-level sharding.

### Horizontal Scaling Path

```
Single instance ──▶ Separate services ──▶ Sharded by geography
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  Location Service  Ride Service    Pricing Service
  (per-city Redis)  (per-city PG)   (global, cached)
```

### Multi-Region Strategy

Each city operates as a mostly-independent deployment. Cross-region concerns (user accounts, payment) use a global database with read replicas per region. Location data and ride state are city-local (a ride in San Francisco never needs data from New York).

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Geo index | Redis Geo | PostGIS, Tile38 | Sub-ms queries, already in stack, sufficient for radius search |
| Real-time transport | WebSocket | SSE, Polling | Bidirectional needed for location + offers |
| Matching strategy | Greedy scoring | Hungarian algorithm | <100ms latency, good enough for most demand |
| Surge zones | Geohash (~5km) | H3 hexagons | Simpler implementation, no native library needed |
| Message queue (local) | RabbitMQ | Kafka | Simpler setup, built-in DLQ, sufficient for dev |
| Message queue (prod) | Kafka | RabbitMQ | Higher throughput, event replay, consumer groups |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler token management |
| State transitions | Optimistic locking | Pessimistic locks | Parallel reads, conflicts resolved at write time |

## Implementation Notes

This section documents what was actually built locally vs the production architecture described above.

### Local Architecture

```
┌──────────────────┐                    ┌──────────────────┐
│  Rider Frontend  │                    │ Driver Frontend  │
│  (React + Vite)  │                    │ (React + Vite)   │
│  :5173           │                    │  :5173           │
└────────┬─────────┘                    └────────┬─────────┘
         │                                       │
         └───────────────┬───────────────────────┘
                         │
              ┌──────────┴──────────┐
              │  Express + WS       │
              │  :3000              │
              │                     │
              │  Routes:            │
              │  /api/auth/*        │
              │  /api/rides/*       │
              │  /api/driver/*      │
              │  /health, /metrics  │
              │  WebSocket /ws      │
              └──────────┬──────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  PostgreSQL  │  │ Redis/Valkey │  │  RabbitMQ    │
│  :5432       │  │  :6379       │  │  :5672       │
│              │  │              │  │  :15672 (UI) │
│  uber_db     │  │  Geo index   │  │              │
│              │  │  Sessions    │  │  Exchanges:  │
│              │  │  Demand      │  │  ride.events │
│              │  │  Ride cache  │  │  uber.direct │
│              │  │  Idempotency │  │  DLX         │
└──────────────┘  └──────────────┘  └──────────────┘
```

### Production-Grade Patterns Actually Implemented

**Idempotency middleware** (`backend/src/middleware/idempotency.ts`): Prevents duplicate ride requests when mobile clients retry on network timeouts. Uses Redis with pending markers (60s) and response caching (24h). Scoped per user to prevent cross-user key collisions. Fails open if Redis is unavailable.

**Circuit breakers** (`backend/src/utils/circuitBreaker.ts`): Wraps Redis geo operations with Opossum circuit breaker. When Redis is slow or down, the circuit opens and returns empty driver lists instead of timing out every request. Exposes circuit state via Prometheus metrics for monitoring.

**Retry with exponential backoff** (`backend/src/utils/circuitBreaker.ts`): Generic `withRetry` function used for database writes, location persistence, and RabbitMQ connections. Includes jitter to prevent thundering herd on recovery.

**Prometheus metrics** (`backend/src/utils/metrics.ts`): 20+ custom metrics covering rides, drivers, surge, geo queries, circuit breakers, queues, HTTP, idempotency, and service health. Exposed on `/metrics` endpoint, ready for Grafana dashboards.

**Structured logging** (`backend/src/utils/logger.ts`): Pino-based loggers with service-specific context. Request logging middleware tracks method, path, status, and duration.

**Health checks** (`backend/src/utils/health.ts`): Three-tier health check system (detailed/liveness/readiness) checking PostgreSQL, Redis, and RabbitMQ. Reports circuit breaker states and memory usage. Compatible with Kubernetes probe configuration.

**Async queue processing** (`backend/src/utils/queue.ts`): Full RabbitMQ integration with exchanges (fanout, direct, DLX), durable queues, prefetch limits, retry with exponential backoff, and dead letter routing. Three separate workers for matching, notifications, and analytics.

**Geohash-based surge pricing** (`backend/src/services/pricingService.ts`): Custom geohash encoder partitions the map into ~5km zones. Demand counters with 5-minute TTL provide rolling demand windows. Supply counted via Redis GEORADIUS.

**Modular matching service** (`backend/src/services/matching/`): Decomposed into scoring, driver-finder, allocation, ride-lifecycle, and ride-status modules. Uses dependency injection to break circular dependencies between modules.

### What Was Simplified or Substituted

- **No map integration**: Locations are lat/lng coordinates; the frontend uses text inputs with simulated geocoding (random coordinates near San Francisco)
- **Simulated location**: Driver location updates use random perturbations around a fixed point instead of real GPS
- **Session auth for OAuth/JWT**: Simple email/password with session tokens in PostgreSQL, no social login or phone verification
- **Single server instance**: No load balancer; all API routes, WebSocket, and matching run in one Express process
- **Valkey for Redis**: Using Valkey (Redis fork) via Docker, functionally identical for our use case
- **Haversine ETA**: Fixed 30 km/h average speed instead of routing engine with traffic data
- **Geohash neighbors simplified**: `getGeohashNeighbors()` returns only the same cell instead of computing actual 8 neighbors

### What Was Omitted

- **CDN**: No static asset distribution; Vite dev server serves everything
- **Multi-region**: No geographic redundancy or failover
- **Kubernetes**: Docker Compose only, no orchestration
- **Database sharding**: Single PostgreSQL instance, no partitioning
- **Payment integration**: Fare is calculated but no actual payment gateway
- **Map/routing engine**: No OSRM, Google Maps, or Mapbox integration
- **Safety features**: No trip sharing, emergency button, or driver verification
- **Ride pooling**: Single-rider rides only
- **ML-based ETA**: No machine learning models for traffic prediction
- **Rate limiting**: No per-user or per-IP rate limiting on API endpoints
