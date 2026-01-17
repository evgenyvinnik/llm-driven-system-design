# Uber System Design Interview Answer

## Opening Statement

"I'll be designing a ride-hailing platform like Uber that connects riders with drivers in real-time. This is a challenging system because it requires low-latency location matching, dynamic pricing, and high reliability. Let me start by clarifying requirements."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

Let me confirm what we need to build:

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
- **Availability**: 99.99% uptime (riders stranded is unacceptable)
- **Scale**: Support 1 million concurrent rides, 10 million daily active users
- **Location Updates**: Handle 5 million driver location updates per minute

---

## 2. Scale Estimation (2-3 minutes)

Let me work through the numbers:

**Users and Rides**
- 10 million DAU (50% riders, 50% drivers active at peak)
- 5 million rides per day
- Peak hours: 10x average = 500K concurrent rides

**Location Updates**
- 5 million active drivers
- Each driver sends location every 3 seconds
- 5M / 3 = 1.67 million location updates per second at peak

**Storage**
- Ride history: 5M rides/day x 1KB = 5GB/day
- Location logs (for ETA training): 1.67M/sec x 100 bytes = 167MB/sec = 14TB/day
  - We'll sample this rather than store all

**Bandwidth**
- Location updates: 1.67M/sec x 100 bytes = 167 MB/sec inbound
- Map data to drivers: significant, but CDN handles this

---

## 3. High-Level Design (8-10 minutes)

Let me draw the architecture:

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
           │                      │ - Geohash    │
           │                      │ - Driver locs│
           └──────────────────────┤              │
                                  └──────────────┘
                                          │
    ┌─────────────────────────────────────┼─────────────────────────────────────┐
    │                                     │                                     │
    ▼                                     ▼                                     ▼
┌──────────────┐                  ┌──────────────┐                  ┌──────────────┐
│  PostgreSQL  │                  │    Kafka     │                  │   Cassandra  │
│              │                  │              │                  │              │
│ - Users      │                  │ - Events     │                  │ - Ride logs  │
│ - Rides      │                  │ - Analytics  │                  │ - Location   │
│ - Payments   │                  │              │                  │   history    │
└──────────────┘                  └──────────────┘                  └──────────────┘
```

### Core Components

**1. API Gateway**
- Handles authentication for both riders and drivers
- Routes requests to appropriate services
- Rate limiting and request validation

**2. Ride Service**
- Manages the ride lifecycle: request, match, in-progress, completed
- Coordinates between rider, driver, and payment systems
- Stores ride state in PostgreSQL

**3. Location Service**
- Ingests driver location updates at massive scale
- Maintains real-time geospatial index
- Powers "find nearby drivers" queries

**4. Pricing Service**
- Calculates base fares using distance and time
- Implements surge pricing based on supply/demand ratio
- Provides fare estimates before booking

**5. Geo Index (Redis with Geospatial)**
- Stores driver locations using GEOADD
- Supports GEORADIUS queries for nearby drivers
- Updates millions of locations per minute

---

## 4. Deep Dive: Driver Location Tracking (7-8 minutes)

This is the most critical component. Let me explain my approach.

### The Challenge

We need to:
1. Ingest 1.67 million location updates per second
2. Query "find 10 nearest available drivers" in under 100ms
3. Keep data fresh (stale locations are useless)

### Geohashing Approach

I'll use geohashing to partition the world into cells:

```
Geohash precision:
- 4 chars: ~39km x 20km (too coarse)
- 5 chars: ~5km x 5km (good for initial filter)
- 6 chars: ~1.2km x 0.6km (good for ranking)
- 7 chars: ~150m x 150m (very precise)
```

**Storage Structure in Redis:**
```
# Use Redis Geo commands
GEOADD drivers:available {longitude} {latitude} {driver_id}

# Or manual geohash approach for more control
SET driver:location:{driver_id} {lat},{lng},{timestamp}
SADD geohash:u4pru:drivers {driver_id}
```

### Finding Nearby Drivers

```javascript
async function findNearbyDrivers(lat, lng, radiusKm = 5) {
  // Option 1: Redis GEORADIUS
  const drivers = await redis.georadius(
    'drivers:available',
    lng, lat,
    radiusKm, 'km',
    'WITHCOORD', 'WITHDIST',
    'COUNT', 20,
    'ASC'
  );

  return drivers;
}
```

### Handling Scale

With 5 million drivers updating every 3 seconds:
- Shard by geographic region (city or geohash prefix)
- Each shard handles ~100K-500K drivers
- Use consistent hashing for shard assignment

```javascript
function getLocationShard(lat, lng) {
  const geohash = encodeGeohash(lat, lng, 3); // 3-char = ~156km cells
  return consistentHash(geohash, NUM_SHARDS);
}
```

### Driver Update Flow

```
Driver App
    │
    ▼ (every 3 sec)
API Gateway
    │
    ▼
Location Service (stateless)
    │
    ├──▶ Redis Geo Update (sync)
    │
    └──▶ Kafka (async, for analytics)
```

---

## 5. Deep Dive: Ride Matching Algorithm (6-7 minutes)

### The Matching Problem

When a rider requests a ride, we need to find the best driver considering:
1. Distance to pickup
2. Driver rating
3. ETA (accounts for traffic)
4. Driver acceptance probability (historical data)

### Simple Distance-Based Matching

```javascript
async function matchRider(riderLat, riderLng) {
  // 1. Find nearby available drivers
  const candidates = await findNearbyDrivers(riderLat, riderLng, 5);

  if (candidates.length === 0) {
    return expandSearch(riderLat, riderLng); // Expand radius
  }

  // 2. Score each candidate
  const scored = await Promise.all(candidates.map(async driver => {
    const eta = await calculateETA(driver.lat, driver.lng, riderLat, riderLng);
    return {
      ...driver,
      eta,
      score: computeMatchScore(driver, eta)
    };
  }));

  // 3. Select best match
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

function computeMatchScore(driver, eta) {
  // Lower ETA is better (invert and normalize)
  const etaScore = Math.max(0, 1 - eta / 30); // 0-30 min range

  // Higher rating is better
  const ratingScore = (driver.rating - 3) / 2; // 3-5 range to 0-1

  // Acceptance rate matters
  const acceptScore = driver.acceptanceRate;

  // Weighted combination
  return (0.5 * etaScore) + (0.3 * ratingScore) + (0.2 * acceptScore);
}
```

### Dispatch with Batching

For high-demand periods, batch matching is more efficient:

```javascript
// Every 2 seconds, batch process pending requests
async function batchMatch(pendingRequests) {
  const allCandidates = new Map(); // driver -> [requests they could serve]

  for (const request of pendingRequests) {
    const nearby = await findNearbyDrivers(request.lat, request.lng);
    for (const driver of nearby) {
      if (!allCandidates.has(driver.id)) {
        allCandidates.set(driver.id, []);
      }
      allCandidates.get(driver.id).push(request);
    }
  }

  // Hungarian algorithm or greedy assignment
  return greedyAssignment(allCandidates);
}
```

### Handling No Available Drivers

1. Expand search radius progressively (5km -> 10km -> 15km)
2. Queue the request and retry every 30 seconds
3. Notify rider of wait time estimate
4. Trigger surge pricing if queue grows

---

## 6. Deep Dive: Surge Pricing (4-5 minutes)

### Why Surge Pricing?

- Increases supply (drivers come online for higher earnings)
- Decreases demand (price-sensitive riders wait)
- Balances the marketplace

### Implementation

```javascript
function calculateSurgeMultiplier(geohash) {
  // Get supply and demand in this area
  const availableDrivers = redis.scard(`available:${geohash}`);
  const pendingRequests = redis.llen(`queue:${geohash}`);
  const recentRequests = redis.get(`demand:${geohash}:last5min`);

  // Supply-demand ratio
  const supplyDemandRatio = availableDrivers / Math.max(pendingRequests, 1);

  // Surge tiers
  if (supplyDemandRatio > 2) return 1.0;      // Plenty of drivers
  if (supplyDemandRatio > 1) return 1.2;
  if (supplyDemandRatio > 0.5) return 1.5;
  if (supplyDemandRatio > 0.25) return 2.0;
  return 2.5;                                  // High demand
}
```

### Surge Zones

- Divide city into hexagonal zones (H3 library)
- Calculate surge independently per zone
- Smooth transitions at boundaries
- Update every 1-2 minutes

---

## 7. Data Model (3-4 minutes)

### PostgreSQL Schema (Transactional Data)

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  type VARCHAR(10) NOT NULL, -- 'rider' or 'driver'
  phone VARCHAR(20) UNIQUE,
  email VARCHAR(255),
  rating DECIMAL(2,1) DEFAULT 5.0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE drivers (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  vehicle_type VARCHAR(20),
  license_plate VARCHAR(20),
  is_available BOOLEAN DEFAULT FALSE,
  current_lat DECIMAL(10,7),
  current_lng DECIMAL(10,7)
);

CREATE TABLE rides (
  id UUID PRIMARY KEY,
  rider_id UUID REFERENCES users(id),
  driver_id UUID REFERENCES users(id),
  status VARCHAR(20), -- requested, matched, picked_up, completed, cancelled
  pickup_lat DECIMAL(10,7),
  pickup_lng DECIMAL(10,7),
  dropoff_lat DECIMAL(10,7),
  dropoff_lng DECIMAL(10,7),
  fare_cents INTEGER,
  surge_multiplier DECIMAL(3,2),
  distance_meters INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```

### Redis (Real-time State)

```
# Driver locations (geospatial index)
drivers:available -> GeoSet of {driver_id: (lat, lng)}

# Driver status
driver:{id}:status -> "available" | "on_ride" | "offline"

# Pending ride requests per zone
queue:{geohash} -> List of request_ids

# Demand counting
demand:{geohash}:last5min -> Integer (TTL 5 min)
```

---

## 8. Trade-offs and Alternatives (4-5 minutes)

### Location Storage: Redis vs Dedicated Geo Database

| Option | Pros | Cons |
|--------|------|------|
| Redis Geo | Fast, familiar, simple | Memory-bound, limited query types |
| PostGIS | Rich queries, persistent | Slower for high update rates |
| Tile38 | Purpose-built geo DB | Operational overhead, less mature |
| Elasticsearch | Flexible geo queries | Overkill for simple radius queries |

**Decision**: Redis for hot data, Cassandra for location history

### Matching: Greedy vs Optimal

| Approach | Pros | Cons |
|----------|------|------|
| Greedy (first match) | Simple, fast | Suboptimal global assignment |
| Batch Hungarian | Optimal matching | Adds latency (batching window) |
| ML-based | Considers many factors | Complex to train/maintain |

**Decision**: Start greedy, add batching for high-demand zones

### Consistency Model

- Driver location: eventual consistency is fine (3-second staleness OK)
- Ride state: strong consistency required (avoid double-booking)
- Payments: strong consistency with idempotency

---

## 9. Failure Handling (2-3 minutes)

### What if Redis fails?

- Redis Cluster with replicas across availability zones
- If primary fails, replica promotes in seconds
- Drivers re-send location immediately, rebuilding index
- Accept degraded matching during recovery

### What if a service fails mid-ride?

- Ride state persisted in PostgreSQL
- Stateless services can resume from last known state
- Mobile apps cache ride info locally
- Periodic state sync between app and server

### Driver goes offline mid-ride

- Detect via missing location updates (30-second threshold)
- Alert rider and ops team
- Attempt to contact driver
- Offer to find replacement driver if needed

---

## 10. Monitoring and Operations (2 minutes)

Key metrics to track:
- **Request-to-match time**: Target < 5 seconds
- **Match-to-pickup time**: Track by zone
- **Ride completion rate**: Detect failed rides
- **Driver utilization**: Optimize supply positioning
- **Surge frequency and duration**: Ensure fairness

Alerting:
- Matching latency > 10 seconds
- Available drivers drops below threshold per zone
- Failed ride rate spikes

---

## Summary

The key insights for Uber's system design are:

1. **Geospatial indexing is critical**: Redis Geo provides the sub-100ms queries needed for real-time matching

2. **Shard by geography**: Location updates naturally partition by city/region

3. **Eventual consistency for locations**: 3-second staleness is acceptable, enabling massive scale

4. **Surge pricing balances marketplace**: Simple supply/demand ratios calculated per zone

5. **Separate hot and cold paths**: Redis for real-time, Cassandra/PostgreSQL for persistence

The system handles 1M+ concurrent rides by combining specialized geo-databases, careful sharding, and accepting appropriate consistency trade-offs.
