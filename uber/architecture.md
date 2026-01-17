# Uber - Ride Hailing - Architecture Design

## System Overview

A ride-hailing platform connecting riders and drivers with real-time matching, location tracking, and dynamic pricing.

## Requirements

### Functional Requirements

1. **Rider Experience**
   - Request a ride from current location to destination
   - See nearby available drivers
   - Get fare estimate before booking
   - Track driver location in real-time
   - Rate drivers after trip completion

2. **Driver Experience**
   - Toggle availability status
   - Receive ride requests with passenger details
   - Navigate to pickup and dropoff locations
   - View earnings and trip history

3. **Matching System**
   - Match riders with optimal nearby drivers
   - Handle surge pricing during high demand
   - Calculate ETAs accurately

### Non-Functional Requirements

- **Latency**: Matching should complete within 3-5 seconds
- **Availability**: 99.99% uptime
- **Scale**: Support multiple concurrent rides locally
- **Location Updates**: Handle frequent driver location updates

## Capacity Estimation

For local development:
- 5-10 concurrent users
- 3 active drivers
- Location updates every 3 seconds

For production scale (reference):
- 10 million DAU (50% riders, 50% drivers)
- 5 million rides per day
- 1.67 million location updates per second at peak
- Storage: 5GB/day for ride history

## High-Level Architecture

```
                                 ┌─────────────────┐
                                 │   CDN (Maps)    │
                                 └────────┬────────┘
                                          │
    ┌──────────────┐              ┌───────┴────────┐              ┌──────────────┐
    │  Rider App   │──────────────│  API Gateway   │──────────────│  Driver App  │
    └──────────────┘              │  + Load Balancer│              └──────────────┘
                                  └───────┬────────┘
                                          │
           ┌──────────────────────────────┼──────────────────────────────┐
           │                              │                              │
           ▼                              ▼                              ▼
    ┌──────────────┐              ┌──────────────┐              ┌──────────────┐
    │ Ride Service │              │Location Service│             │ Pricing Svc  │
    │              │              │              │              │              │
    │ - Booking    │              │ - Driver locs │              │ - Fare calc  │
    │ - Status     │              │ - Geo queries │              │ - Surge      │
    │ - Matching   │              │ - ETA         │              │ - Estimates  │
    └──────┬───────┘              └──────┬───────┘              └──────────────┘
           │                              │
           │                              ▼
           │                      ┌──────────────┐
           │                      │  Geo Index   │
           │                      │   (Redis)    │
           │                      │              │
           │                      │ - GEOADD     │
           │                      │ - GEORADIUS  │
           └──────────────────────┤              │
                                  └──────────────┘
                                          │
    ┌─────────────────────────────────────┼─────────────────────────────────────┐
    │                                     │                                     │
    ▼                                     ▼                                     ▼
┌──────────────┐                  ┌──────────────┐                  ┌──────────────┐
│  PostgreSQL  │                  │   WebSocket  │                  │   Redis      │
│              │                  │   Server     │                  │              │
│ - Users      │                  │              │                  │ - Sessions   │
│ - Rides      │                  │ - Real-time  │                  │ - Geo index  │
│ - Payments   │                  │   updates    │                  │ - Demand     │
└──────────────┘                  └──────────────┘                  └──────────────┘
```

### Core Components

**1. API Gateway (Express)**
- Handles authentication for both riders and drivers
- Routes requests to appropriate services
- Rate limiting and request validation

**2. Ride Service**
- Manages the ride lifecycle: request, match, in-progress, completed
- Coordinates between rider, driver, and payment systems
- Stores ride state in PostgreSQL

**3. Location Service**
- Ingests driver location updates
- Maintains real-time geospatial index in Redis
- Powers "find nearby drivers" queries

**4. Pricing Service**
- Calculates base fares using distance and time
- Implements surge pricing based on supply/demand ratio
- Provides fare estimates before booking

**5. Geo Index (Redis with Geospatial)**
- Stores driver locations using GEOADD
- Supports GEORADIUS queries for nearby drivers
- Updates locations in real-time

## Data Model

### PostgreSQL Schema

```sql
-- Users table (both riders and drivers)
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    user_type VARCHAR(10) NOT NULL, -- 'rider' or 'driver'
    rating DECIMAL(2,1) DEFAULT 5.0,
    rating_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Drivers extended info
CREATE TABLE drivers (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    vehicle_type VARCHAR(20) NOT NULL, -- economy, comfort, premium, xl
    vehicle_make VARCHAR(50),
    vehicle_model VARCHAR(50),
    vehicle_color VARCHAR(30),
    license_plate VARCHAR(20) NOT NULL,
    is_available BOOLEAN DEFAULT FALSE,
    is_online BOOLEAN DEFAULT FALSE,
    current_lat DECIMAL(10,7),
    current_lng DECIMAL(10,7),
    total_rides INTEGER DEFAULT 0,
    total_earnings_cents INTEGER DEFAULT 0
);

-- Rides table
CREATE TABLE rides (
    id UUID PRIMARY KEY,
    rider_id UUID NOT NULL REFERENCES users(id),
    driver_id UUID REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'requested',
    pickup_lat DECIMAL(10,7) NOT NULL,
    pickup_lng DECIMAL(10,7) NOT NULL,
    pickup_address VARCHAR(500),
    dropoff_lat DECIMAL(10,7) NOT NULL,
    dropoff_lng DECIMAL(10,7) NOT NULL,
    dropoff_address VARCHAR(500),
    vehicle_type VARCHAR(20) NOT NULL,
    estimated_fare_cents INTEGER,
    final_fare_cents INTEGER,
    surge_multiplier DECIMAL(3,2) DEFAULT 1.00,
    distance_meters INTEGER,
    duration_seconds INTEGER,
    requested_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);
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
```

## API Design

### Core Endpoints

**Authentication**
- `POST /api/auth/register/rider` - Register rider
- `POST /api/auth/register/driver` - Register driver
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/logout` - Logout

**Rides (Rider)**
- `POST /api/rides/estimate` - Get fare estimates
- `POST /api/rides/request` - Request a ride
- `GET /api/rides/:rideId` - Get ride status
- `POST /api/rides/:rideId/cancel` - Cancel ride
- `POST /api/rides/:rideId/rate` - Rate the ride

**Driver**
- `POST /api/driver/location` - Update location
- `POST /api/driver/online` - Go online
- `POST /api/driver/offline` - Go offline
- `POST /api/driver/rides/:rideId/accept` - Accept ride
- `POST /api/driver/rides/:rideId/arrived` - Notify arrival
- `POST /api/driver/rides/:rideId/start` - Start ride
- `POST /api/driver/rides/:rideId/complete` - Complete ride

### WebSocket Events

```javascript
// Client -> Server
{ type: 'auth', token: 'xxx' }
{ type: 'location_update', lat: 37.77, lng: -122.41 }

// Server -> Client (Driver)
{ type: 'ride_offer', rideId, rider, pickup, dropoff, estimatedFare, expiresIn }

// Server -> Client (Rider)
{ type: 'ride_matched', rideId, driver }
{ type: 'driver_arrived', rideId }
{ type: 'ride_started', rideId }
{ type: 'ride_completed', rideId, fare }
```

## Key Design Decisions

### Real-time Geo-matching

**Challenge**: Find nearby drivers quickly from millions of locations

**Solution**: Redis Geo commands

```javascript
// Store driver location
await redis.geoadd('drivers:available', lng, lat, driverId);

// Find 20 nearest drivers within 5km
const drivers = await redis.georadius(
  'drivers:available',
  lng, lat,
  5, 'km',
  'WITHCOORD', 'WITHDIST',
  'COUNT', 20,
  'ASC'
);
```

**Why Redis Geo?**
- O(log N) operations
- Built-in distance calculation
- Handles millions of updates
- Simple operational model

### Matching Algorithm

```javascript
function computeMatchScore(driver, eta) {
  // Lower ETA is better (invert and normalize)
  const etaScore = Math.max(0, 1 - eta / 30);

  // Higher rating is better
  const ratingScore = (driver.rating - 3) / 2;

  // Weighted combination
  return (0.6 * etaScore) + (0.4 * ratingScore);
}
```

### Surge Pricing

```javascript
function calculateSurge(availableDrivers, pendingRequests) {
  const ratio = availableDrivers / Math.max(pendingRequests, 1);

  if (ratio > 2) return 1.0;      // Plenty of drivers
  if (ratio > 1.5) return 1.1;
  if (ratio > 1) return 1.2;
  if (ratio > 0.75) return 1.5;
  if (ratio > 0.5) return 1.8;
  if (ratio > 0.25) return 2.0;
  return 2.5;                     // Very high demand
}
```

## Technology Stack

- **Application Layer**: Node.js + Express + WebSocket
- **Data Layer**: PostgreSQL (transactional), Redis (real-time)
- **Caching Layer**: Redis (sessions, geo index, demand counts)
- **Frontend**: React + TypeScript + Zustand + TanStack Router

## Scalability Considerations

1. **Shard by geography**: Location updates partition naturally by city/region
2. **Stateless services**: API servers can scale horizontally
3. **Redis Cluster**: For geo data at scale
4. **CDN for static assets**: Map tiles, images

## Trade-offs and Alternatives

| Decision | Alternative | Why We Chose This |
|----------|-------------|-------------------|
| Redis Geo | PostGIS, Tile38 | Simplicity, speed |
| Greedy matching | Hungarian algorithm | Fast enough for demo |
| Session auth | JWT | Simpler, Redis-based |
| WebSocket | SSE, Polling | Lower latency |

## Monitoring and Observability

Key metrics to track:
- Request-to-match time: Target < 5 seconds
- Match-to-pickup time: Track by zone
- Ride completion rate: Detect failed rides
- Driver utilization: Optimize supply positioning
- Surge frequency: Ensure fairness

## Security Considerations

- Password hashing with bcrypt
- Session tokens stored in Redis with expiry
- Input validation on all endpoints
- CORS configuration for frontend

## Future Optimizations

- [ ] Batch matching for high-demand zones
- [ ] ML-based ETA prediction
- [ ] Geofenced surge zones
- [ ] Driver routing optimization
- [ ] Ride pooling (shared rides)
