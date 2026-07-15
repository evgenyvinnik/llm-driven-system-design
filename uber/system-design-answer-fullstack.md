# 🚗 Uber - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

---

## 🎯 Opening Statement

"I'll design a ride-hailing platform connecting riders with drivers in real-time. As a full-stack engineer, I'll focus on the end-to-end flow from user interaction through backend services, the API contract between frontend and backend, WebSocket integration for real-time updates, and how the geospatial matching system powers the map UI."

---

## 1️⃣ Requirements Clarification (3-4 minutes)

### ✅ Full-Stack Functional Requirements

| # | Requirement | Frontend | Backend |
|---|-------------|----------|---------|
| 1 | Ride Request Flow | Map UI, fare display, "Request" button | Fare calculation, idempotent insert, queue matching |
| 2 | Real-time Matching | "Searching" animation, driver info display | GEORADIUS query, scoring algorithm, offer broadcast |
| 3 | Live Location Tracking | Animate driver marker on map | Location ingestion, WebSocket broadcast |
| 4 | Dual Personas | Rider and Driver apps share components | Same API, different permissions |
| 5 | State Synchronization | Optimistic updates with rollback | Event broadcasting, status transitions |

### 📡 Integration Points

```
┌─────────────────────────────────────────────────────────────────┐
│                    INTEGRATION MATRIX                           │
├─────────────────┬──────────────────────┬────────────────────────┤
│ Feature         │ Frontend Need        │ Backend Responsibility │
├─────────────────┼──────────────────────┼────────────────────────┤
│ Fare estimation │ Show price before    │ Calculate distance,    │
│                 │ booking              │ apply surge multiplier │
├─────────────────┼──────────────────────┼────────────────────────┤
│ Driver matching │ Show "searching"     │ GEORADIUS query,       │
│                 │ animation            │ scoring algorithm      │
├─────────────────┼──────────────────────┼────────────────────────┤
│ Live tracking   │ Animate driver       │ Broadcast location     │
│                 │ marker               │ via WebSocket          │
├─────────────────┼──────────────────────┼────────────────────────┤
│ Status updates  │ Update UI state      │ Publish ride events    │
│                 │ immediately          │ to subscribers         │
├─────────────────┼──────────────────────┼────────────────────────┤
│ Payment capture │ Show confirmation    │ Idempotent charge,     │
│                 │                      │ circuit breaker        │
└─────────────────┴──────────────────────┴────────────────────────┘
```

---

## 2️⃣ High-Level Architecture (5 minutes)

```
┌───────────────────────────────────────────────────────────────────┐
│                       CLIENT APPLICATIONS                          │
│                                                                    │
│   ┌─────────────────────┐         ┌─────────────────────┐         │
│   │     RIDER APP       │         │     DRIVER APP      │         │
│   │                     │         │                     │         │
│   │  ┌─────┐  ┌──────┐ │         │  ┌─────┐  ┌──────┐  │         │
│   │  │ Map │  │Bottom│ │         │  │ Map │  │Offers│  │         │
│   │  │View │  │Sheet │ │         │  │View │  │Panel │  │         │
│   │  └──┬──┘  └──┬───┘ │         │  └──┬──┘  └──┬───┘  │         │
│   │     └────┬───┘     │         │     └────┬───┘      │         │
│   │          ▼         │         │          ▼          │         │
│   │   ┌───────────┐    │         │   ┌───────────┐     │         │
│   │   │Ride Store │    │         │   │Driver Store│    │         │
│   │   │ (Zustand) │    │         │   │ (Zustand) │     │         │
│   │   └─────┬─────┘    │         │   └─────┬─────┘     │         │
│   └─────────┼──────────┘         └─────────┼───────────┘         │
│             │                              │                      │
│             └──────────────┬───────────────┘                      │
│                            ▼                                      │
│              ┌──────────────────────────┐                         │
│              │     Service Layer         │                         │
│              │                          │                         │
│              │  ┌──────────┐ ┌───────┐  │                         │
│              │  │WebSocket │ │ REST  │  │                         │
│              │  │ Client   │ │ API   │  │                         │
│              │  └────┬─────┘ └───┬───┘  │                         │
│              └───────┼───────────┼──────┘                         │
└──────────────────────┼───────────┼────────────────────────────────┘
                       │           │
                       ▼           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          API GATEWAY                                 │
│  ┌────────────────┬──────────────┬───────────────┬───────────────┐  │
│  │ Authentication │ Rate Limiting│ Request Valid.│    Routing    │  │
│  └────────────────┴──────────────┴───────────────┴───────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │Ride Service │ │Location Svc │ │Pricing Svc  │
  │             │ │             │ │             │
  │• State mgmt │ │• Geo index  │ │• Fare calc  │
  │• Matching   │ │• GEORADIUS  │ │• Surge      │
  │• Idempotency│ │• Broadcast  │ │• Estimates  │
  └──────┬──────┘ └──────┬──────┘ └─────────────┘
         │               │
  ┌──────┴───────────────┴──────┐
  ▼                             ▼
┌──────────────┐        ┌──────────────┐
│  PostgreSQL  │        │ Redis Cluster│
│              │        │              │
│ • Users      │        │ • Geo index  │
│ • Rides      │        │ • Sessions   │
│ • Payments   │        │ • Surge data │
└──────────────┘        └──────────────┘
```

---

## 3️⃣ API Contract Design (6-7 minutes)

### 📋 Core Data Types

| Type | Fields | Usage |
|------|--------|-------|
| **LatLng** | lat, lng | All location references |
| **Location** | lat, lng, address, placeId | Pickup/dropoff points |
| **VehicleType** | economy, comfort, premium, xl | Ride tier selection |
| **RideStatus** | requested, matching, matched, driver_arrived, in_progress, completed, cancelled | State machine states |

### 🔌 REST Endpoints

```
┌─────────────────────────────────────────────────────────────────────┐
│                         REST API ENDPOINTS                          │
├──────────┬─────────────────────────┬────────────────────────────────┤
│  Method  │       Endpoint          │          Description           │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  POST    │ /api/auth/login         │ Returns user + session token   │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  POST    │ /api/rides/estimate     │ Fare estimate for route        │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  POST    │ /api/rides/request      │ Create ride (idempotency key)  │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  GET     │ /api/rides/:id          │ Get ride details + driver info │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  POST    │ /api/rides/:id/cancel   │ Cancel ride, return fee if any │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  POST    │ /api/rides/:id/rate     │ Rate driver + optional tip     │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  POST    │ /api/driver/online      │ Mark driver available          │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  POST    │ /api/driver/offline     │ Mark driver unavailable        │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  POST    │ /api/driver/rides/:id/  │ Accept, arrived, start,        │
│          │ {action}                │ complete transitions           │
├──────────┼─────────────────────────┼────────────────────────────────┤
│  GET     │ /api/driver/nearby      │ Nearby drivers for map preview │
└──────────┴─────────────────────────┴────────────────────────────────┘
```

### 📡 WebSocket Message Types

```
┌─────────────────────────────────────────────────────────────────────┐
│                      WEBSOCKET MESSAGES                             │
├──────────────────────────────────────────────────────────────────────┤
│                     CLIENT → SERVER                                  │
├─────────────────────┬────────────────────────────────────────────────┤
│ auth                │ Authenticate WebSocket connection with token  │
│ location_update     │ Driver sends lat/lng every 3 seconds          │
│ subscribe_ride      │ Rider subscribes to ride updates              │
│ ping                │ Keep-alive heartbeat                          │
├──────────────────────────────────────────────────────────────────────┤
│                     SERVER → RIDER                                   │
├─────────────────────┬────────────────────────────────────────────────┤
│ ride_matched        │ Driver assigned, includes ETA and route       │
│ driver_location     │ Real-time driver position updates             │
│ driver_arrived      │ Driver at pickup location                     │
│ ride_started        │ Trip has begun                                │
│ ride_completed      │ Trip finished, includes final fare            │
├──────────────────────────────────────────────────────────────────────┤
│                     SERVER → DRIVER                                  │
├─────────────────────┬────────────────────────────────────────────────┤
│ ride_offer          │ New ride request with pickup/fare/timer       │
│ offer_expired       │ Offer timeout or taken by another driver      │
└─────────────────────┴────────────────────────────────────────────────┘
```

---

## 4️⃣ End-to-End Flow: Ride Request (7-8 minutes)

### 🔄 Sequence Diagram

```
 Rider App          API Gateway            Matching Worker          Driver App
    │                    │                       │                      │
    │ POST /rides/request (X-Idempotency-Key)    │                      │
    ├───────────────────►│ insert ride(requested)│                      │
    │                    │ publish to match queue │                      │
    │ 202 {rideId, status:matching}              │                      │
    │◄───────────────────┤                       │                      │
    │  store → matching, show "Searching"        │                      │
    │                    │   ── async matching ──│ GEORADIUS 5km        │
    │                    │                       │ score (ETA+rating)   │
    │                    │                       │ offer via WS ───────►│ modal
    │                    │                       │                      │ +15s timer
    │                    │ POST /driver/rides/:id/accept                │
    │                    │◄─────────────────────────────────────────────┤
    │                    │ UPDATE rides SET status='matched'            │
    │                    │   WHERE status='matching' (optimistic lock)  │
    │                    │ ZREM drivers:available                       │
    │  WsRideMatched (driver info, ETA)          │                      │
    │◄───────────────────┤ store → matched, show driver card           │
    │                    │                       │                      │
```

### 🎯 Key Integration Points

| Step | Frontend Action | Backend Action | Data Flow |
|------|-----------------|----------------|-----------|
| 1 | User taps "Request Ride" | - | UI triggers mutation |
| 2 | Store: status → 'requesting' | - | Optimistic UI update |
| 3 | POST with idempotency key | Validate, insert, queue | Request → Response |
| 4 | Store: status → 'matching' | Status transition | 202 Accepted |
| 5 | Show pulsing animation | GEORADIUS + scoring | Async processing |
| 6 | - | WebSocket to driver | Offer with timer |
| 7 | - | Driver accepts | Status → 'matched' |
| 8 | Receive WsRideMatched | Broadcast to rider | WebSocket push |
| 9 | Show driver card + ETA | - | UI update |

---

## 5️⃣ Real-time Location Broadcasting (6-7 minutes)

### 📍 Location Update Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                     LOCATION BROADCAST FLOW                          │
└──────────────────────────────────────────────────────────────────────┘

┌─────────────┐                                        ┌─────────────┐
│ Driver App  │                                        │ Rider App   │
│             │                                        │             │
│ Geolocation │                                        │ Map View    │
│ watchPosition                                        │             │
│ every 3s    │                                        │ Animate     │
│             │                                        │ marker      │
└──────┬──────┘                                        └──────▲──────┘
       │                                                      │
       │ WsLocationUpdate                                     │
       │ { lat, lng, heading,                                 │
       │   speed, accuracy }                                  │
       ▼                                                      │
┌─────────────────────────────────────────────────────────────┴───────┐
│                        WEBSOCKET SERVER                             │
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐ │
│  │  Connection Map │    │ Subscription Map│    │  Active Rides   │ │
│  │                 │    │                 │    │                 │ │
│  │ userId→WebSocket│    │ rideId→Set<uid> │    │ driverId→rideId │ │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘ │
│           │                      │                      │          │
│           ▼                      ▼                      ▼          │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                    MESSAGE HANDLER                          │    │
│  │                                                            │    │
│  │  1. Update Redis geo index (GEOADD)                        │    │
│  │  2. Lookup active ride for driver                          │    │
│  │  3. Get subscribers for ride                               │    │
│  │  4. Calculate updated ETA                                  │    │
│  │  5. Broadcast WsDriverLocation to subscribers              │    │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                        ┌─────────────────────┐
                        │    Redis Cluster    │
                        │                     │
                        │ GEOADD drivers:     │
                        │   active            │
                        │   <lng> <lat>       │
                        │   <driver_id>       │
                        └─────────────────────┘
```

### 🔄 Frontend WebSocket Integration

```
┌─────────────────────────────────────────────────────────────────────┐
│                    FRONTEND WEBSOCKET FLOW                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    WebSocket Provider                          │ │
│  │                                                                │ │
│  │  On connect:                                                   │ │
│  │    1. Authenticate with session token                         │ │
│  │    2. Re-subscribe to active ride if exists                   │ │
│  │    3. Restore pending subscriptions                           │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              │                                      │
│              ┌───────────────┴───────────────┐                      │
│              ▼                               ▼                      │
│  ┌─────────────────────────┐    ┌─────────────────────────┐        │
│  │     RIDER HANDLERS      │    │    DRIVER HANDLERS      │        │
│  │                         │    │                         │        │
│  │ ride_matched:           │    │ ride_offer:             │        │
│  │   → Set driver info     │    │   → Show offer modal    │        │
│  │   → Set status          │    │   → Start countdown     │        │
│  │   → Subscribe to ride   │    │                         │        │
│  │                         │    │ offer_expired:          │        │
│  │ driver_location:        │    │   → Clear modal         │        │
│  │   → Update marker pos   │    │   → Show "missed" toast │        │
│  │   → Update ETA          │    │                         │        │
│  │                         │    │                         │        │
│  │ driver_arrived:         │    │                         │        │
│  │   → Status → arrived    │    │                         │        │
│  │   → Push notification   │    │                         │        │
│  └─────────────────────────┘    └─────────────────────────┘        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 🔄 Alternatives: Real-time Updates

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **WebSocket per user** | Targeted delivery, auth per connection | Higher connection count | ✅ Chosen |
| **Shared broadcast room** | Fewer connections | Complex filtering client-side | ❌ |
| **HTTP polling** | Simple, no persistent connections | Latency, bandwidth | ❌ |
| **Server-Sent Events** | Simpler than WS | One-directional only | ❌ |

---

## 6️⃣ Error Handling Across Stack (5-6 minutes)

### ⚠️ Standardized Error Response

Every error returns a consistent envelope: a machine-readable `code`, a human `message`, a `retryable` boolean, and an optional `retryAfter` (seconds). The client branches on `code` and `retryable` rather than parsing prose, so error handling stays uniform across every endpoint.

### 📋 Error Codes

| Code | HTTP | Description | Retryable |
|------|------|-------------|-----------|
| VALIDATION_ERROR | 400 | Invalid request data | No |
| UNAUTHORIZED | 401 | Session expired | No |
| RIDE_NOT_FOUND | 404 | Ride doesn't exist | No |
| INVALID_STATE_TRANSITION | 409 | Wrong status for action | No |
| DRIVER_UNAVAILABLE | 409 | Driver busy/offline | Yes |
| SERVICE_UNAVAILABLE | 503 | High demand | Yes |
| MATCHING_TIMEOUT | 504 | No drivers found | Yes |
| PAYMENT_FAILED | 402 | Card declined | No |

### 🔄 Frontend Error Handling

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ERROR HANDLING FLOW                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  API Response                                                       │
│       │                                                             │
│       ▼                                                             │
│  ┌─────────────┐                                                    │
│  │ Is network  │ ──Yes──► Show "No internet" toast                  │
│  │ error?      │          Suggest checking connection               │
│  └──────┬──────┘                                                    │
│         │ No                                                        │
│         ▼                                                           │
│  ┌─────────────┐                                                    │
│  │ UNAUTHORIZED│ ──Yes──► Logout user, redirect to login            │
│  │ code?       │                                                    │
│  └──────┬──────┘                                                    │
│         │ No                                                        │
│         ▼                                                           │
│  ┌─────────────┐                                                    │
│  │ retryable?  │ ──Yes──► Wait retryAfter seconds                   │
│  │             │          Auto-retry the request                    │
│  └──────┬──────┘                                                    │
│         │ No                                                        │
│         ▼                                                           │
│  Show error toast with message                                      │
│  Reset relevant store state                                         │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 🔁 WebSocket Reconnection

```
┌─────────────────────────────────────────────────────────────────────┐
│                   RECONNECTION STRATEGY                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Connection closed unexpectedly                                     │
│       │                                                             │
│       ▼                                                             │
│  Calculate delay: min(1000 × 2^attempt, 30000ms)                    │
│       │                                                             │
│       ▼                                                             │
│  Emit 'reconnecting' event to UI                                    │
│  Show "Reconnecting..." indicator                                   │
│       │                                                             │
│       ▼                                                             │
│  Attempt reconnect after delay                                      │
│       │                                                             │
│       ├──Success──► Reset attempt counter                           │
│       │             Re-authenticate with token                      │
│       │             Re-subscribe to active ride                     │
│       │             Emit 'connected'                                │
│       │                                                             │
│       └──Failure──► Increment attempt counter                       │
│                     Loop back to calculate delay                    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7️⃣ State Synchronization (4-5 minutes)

### 🔄 Optimistic Updates with Rollback

On a user action like Cancel Ride, `onMutate` snapshots the current status and optimistically flips the store to `cancelled` so the UI responds instantly. If the API call succeeds we invalidate the cache to confirm; if it fails, `onError` rolls the status back to the snapshot and surfaces a "Failed to cancel" toast. The user never waits on the network for feedback, and a rejected mutation leaves the store exactly where it started.

### 🔄 Reconciling WebSocket and REST State

The store is the single source of truth, fed by three inputs: WebSocket events (immediate push), a REST poll every 10s as a fallback, and local optimistic user actions. Reconciliation defines a status order — matching → matched → driver_arrived → in_progress → completed — and only ever moves *forward*: if the REST poll reports a status ahead of the store (a WebSocket event was dropped), the store advances to match REST and logs the divergence. It never regresses to a stale WebSocket message, which is how we avoid flicker when a late event races a poll.

### 📴 Offline Action Queue

| Scenario | Action | Behavior |
|----------|--------|----------|
| Submit rating offline | Enqueue locally | Retry when online |
| Location update offline | Skip (stale) | Don't queue, resume live |
| Cancel ride offline | Enqueue | Process within 5 minutes |
| Stale action (> 5 min) | Discard | Action no longer relevant |

---

## 8️⃣ Testing Strategy (3-4 minutes)

### 🧪 Testing Layers

The pyramid: ~100+ **unit tests** (matching/scoring algorithm, store reducers, component rendering), ~20 **integration tests** (API endpoints, DB transactions, status-transition guards), and ~5 **E2E tests** (the full ride flow plus WebSocket delivery). The weight sits at the base because the pure functions — scoring, surge, fare math — are the cheapest to test exhaustively and where a regression is most costly.

### 🔄 E2E Test Flow

| Step | Actor | Action | Verification |
|------|-------|--------|--------------|
| 1 | Rider | POST /rides/request | 202 status, rideId returned |
| 2 | Driver | Receive WS ride_offer | Contains correct rideId |
| 3 | Driver | POST /driver/rides/:id/accept | 200 status |
| 4 | Rider | Receive WS ride_matched | Contains driver info |
| 5 | Driver | POST arrived, start, complete | Status transitions |
| 6 | Rider | Receive WS ride_completed | Contains final fare |

### 🧩 Component Test Cases

| Component | Test Case | Expected Behavior |
|-----------|-----------|-------------------|
| MatchingScreen | status='matching' | Show pulsing animation |
| MatchingScreen | Cancel button tap | Call cancel mutation |
| DriverCard | driver prop | Display name, rating, vehicle |
| RideOffer | 15s countdown | Auto-dismiss on timeout |
| Map | driver_location event | Animate marker to new position |

---

## 9️⃣ Trade-offs Discussion (3-4 minutes)

### 🔌 API Design Choices

| Decision | Alternative | Trade-off |
|----------|-------------|-----------|
| **REST + WebSocket** | GraphQL subscriptions | REST simpler for mobile caching; WS for real-time ✅ |
| **Idempotency keys** | Server-generated IDs | Client control, retries work correctly ✅ |
| **202 for ride request** | 201 with polling | Indicates async processing ✅ |
| **Typed shared interfaces** | No shared types | Compile-time contract validation ✅ |

### 📦 State Management

| Decision | Alternative | Trade-off |
|----------|-------------|-----------|
| **Zustand stores** | Redux | Less boilerplate, easier for small teams ✅ |
| **Optimistic updates** | Wait for server | Better UX, rollback complexity ✅ |
| **REST polling backup** | WebSocket only | Reliability vs. extra requests ✅ |
| **Local offline queue** | Require connectivity | Better mobile UX ✅ |

### 📡 Real-time Architecture

| Decision | Alternative | Trade-off |
|----------|-------------|-----------|
| **3-second location interval** | 1-second | Battery vs. smoothness ✅ |
| **Server-side subscriptions** | Client topic subscription | Centralized auth control ✅ |
| **Exponential backoff reconnect** | Fixed interval | Prevents thundering herd ✅ |

---

## 🎯 Summary

### Key Full-Stack Insights

| Insight | Implementation |
|---------|----------------|
| **API contract is the integration point** | Shared TypeScript interfaces ensure type safety across stack |
| **Idempotency prevents duplicates** | Idempotency keys in ride requests prevent double-booking |
| **WebSocket + REST hybrid** | Real-time via WS, polling as reliability backup |
| **Optimistic updates with rollback** | Immediate UI feedback, revert on server rejection |
| **Standardized error handling** | Error codes with retryable flags at every layer |
| **State reconciliation** | Compare WS and REST states, use "later" status as truth |

### 🏗️ Architecture Summary

```
┌─────────────────────────────────────────────────────────────────────┐
│                    FULL-STACK INTEGRATION                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  FRONTEND                    BACKEND                                │
│  ────────                    ───────                                │
│                                                                     │
│  Zustand Store ◄─────────── WebSocket Events (push)                 │
│       │                           ▲                                 │
│       │                           │                                 │
│       ▼                           │                                 │
│  REST Mutations ──────────► Express Routes                          │
│       │                           │                                 │
│       │                           ▼                                 │
│       │                     PostgreSQL + Redis                      │
│       │                           │                                 │
│       ▼                           │                                 │
│  React Query Cache ◄────── REST Polling (backup)                    │
│                                                                     │
│  Key Pattern: Optimistic update → Server confirm → Reconcile        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```
