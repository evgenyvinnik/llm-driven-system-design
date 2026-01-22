# Uber - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement

"I'll be designing a ride-hailing platform like Uber that connects riders with drivers in real-time. As a full-stack engineer, I'll focus on the end-to-end flow from user interaction through the backend, the API contract between frontend and backend, WebSocket integration for real-time updates, and how the geospatial matching system powers the map UI. The key challenge is ensuring the frontend remains responsive while the backend handles massive location update throughput."

---

## 1. Requirements Clarification (3-4 minutes)

### Full-Stack Functional Requirements

1. **End-to-End Ride Flow**
   - Rider selects pickup/dropoff on map -> API calculates fare estimate
   - Rider confirms -> Backend finds optimal driver via geo query
   - Driver accepts via WebSocket -> Rider sees driver on map in real-time
   - State transitions flow through backend and update frontend immediately

2. **Real-time Location Sync**
   - Driver app sends location every 3 seconds via WebSocket
   - Backend updates Redis geo index + broadcasts to rider
   - Rider map animates driver marker to new position

3. **Dual Persona Support**
   - Rider and Driver apps share core infrastructure
   - Different UI flows but same underlying API
   - Shared authentication and session management

### Integration Requirements

| Integration Point | Frontend Need | Backend Responsibility |
|-------------------|---------------|------------------------|
| Fare estimation | Show price before booking | Calculate distance, apply surge |
| Driver matching | Show "searching" animation | GEORADIUS query, scoring algorithm |
| Live tracking | Animate driver marker | Broadcast location via WebSocket |
| Status updates | Update UI state | Publish ride events |
| Payment capture | Show confirmation | Idempotent charge, circuit breaker |

---

## 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CLIENT APPLICATIONS                             │
│                                                                         │
│   ┌───────────────────────────┐     ┌───────────────────────────┐      │
│   │       RIDER APP           │     │       DRIVER APP          │      │
│   │                           │     │                           │      │
│   │  ┌─────────┐ ┌─────────┐ │     │  ┌─────────┐ ┌─────────┐ │      │
│   │  │ Map     │ │ Bottom  │ │     │  │ Map     │ │ Ride    │ │      │
│   │  │ View    │ │ Sheet   │ │     │  │ View    │ │ Offers  │ │      │
│   │  └─────────┘ └─────────┘ │     │  └─────────┘ └─────────┘ │      │
│   │       │           │      │     │       │           │      │      │
│   │       └─────┬─────┘      │     │       └─────┬─────┘      │      │
│   │             ▼            │     │             ▼            │      │
│   │      ┌───────────┐       │     │      ┌───────────┐       │      │
│   │      │ Ride Store│       │     │      │Driver Store│      │      │
│   │      │ (Zustand) │       │     │      │ (Zustand) │       │      │
│   │      └─────┬─────┘       │     │      └─────┬─────┘       │      │
│   └────────────┼─────────────┘     └────────────┼─────────────┘      │
│                │                                │                     │
│                └────────────────┬───────────────┘                     │
│                                 ▼                                     │
│                    ┌────────────────────────┐                         │
│                    │    Service Layer       │                         │
│                    │                        │                         │
│                    │ ┌──────────┐ ┌───────┐ │                         │
│                    │ │WebSocket │ │ REST  │ │                         │
│                    │ │ Client   │ │ API   │ │                         │
│                    │ └────┬─────┘ └───┬───┘ │                         │
│                    └──────┼───────────┼─────┘                         │
└───────────────────────────┼───────────┼───────────────────────────────┘
                            │           │
                            ▼           ▼
┌───────────────────────────────────────────────────────────────────────┐
│                          API GATEWAY                                  │
│                                                                       │
│   Authentication │ Rate Limiting │ Request Validation │ Routing      │
└───────────────────────────────────────────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │Ride Service │   │Location Svc │   │Pricing Svc  │
   │             │   │             │   │             │
   │- State mgmt │   │- Geo index  │   │- Fare calc  │
   │- Matching   │   │- GEORADIUS  │   │- Surge      │
   │- Idempotency│   │- Broadcast  │   │- Estimates  │
   └──────┬──────┘   └──────┬──────┘   └─────────────┘
          │                 │
   ┌──────┴─────────────────┴──────┐
   ▼                               ▼
┌──────────────┐           ┌──────────────┐
│  PostgreSQL  │           │ Redis Cluster│
│              │           │              │
│ - Users      │           │ - Geo index  │
│ - Rides      │           │ - Sessions   │
│ - Payments   │           │ - Surge data │
└──────────────┘           └──────────────┘
```

---

## 3. API Contract Design (6-7 minutes)

### Core Endpoints

```typescript
// Shared types between frontend and backend
interface LatLng {
  lat: number;
  lng: number;
}

interface Location extends LatLng {
  address: string;
  placeId?: string;
}

type VehicleType = 'economy' | 'comfort' | 'premium' | 'xl';

type RideStatus =
  | 'requested'
  | 'matching'
  | 'matched'
  | 'driver_arrived'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

// ==================== AUTHENTICATION ====================

// POST /api/auth/login
interface LoginRequest {
  email: string;
  password: string;
}

interface LoginResponse {
  user: {
    id: string;
    name: string;
    email: string;
    userType: 'rider' | 'driver';
    rating: number;
  };
  token: string; // Session token for WebSocket auth
}

// ==================== FARE ESTIMATION ====================

// POST /api/rides/estimate
interface EstimateRequest {
  pickup: LatLng;
  dropoff: LatLng;
}

interface EstimateResponse {
  estimates: Array<{
    vehicleType: VehicleType;
    displayName: string;
    baseFareCents: number;
    surgeMultiplier: number;
    finalFareCents: number;
    etaMinutes: number;
    distanceMeters: number;
    durationSeconds: number;
  }>;
  surgeZone?: {
    geohash: string;
    multiplier: number;
    expiresAt: number;
  };
}

// ==================== RIDE LIFECYCLE ====================

// POST /api/rides/request
// Headers: X-Idempotency-Key: <uuid>
interface RideRequest {
  pickup: Location;
  dropoff: Location;
  vehicleType: VehicleType;
}

interface RideResponse {
  rideId: string;
  status: RideStatus;
  estimatedFareCents: number;
  surgeMultiplier: number;
}

// GET /api/rides/:rideId
interface RideDetails {
  id: string;
  status: RideStatus;
  pickup: Location;
  dropoff: Location;
  vehicleType: VehicleType;
  estimatedFareCents: number;
  finalFareCents?: number;
  surgeMultiplier: number;
  driver?: {
    id: string;
    name: string;
    rating: number;
    vehicleMake: string;
    vehicleModel: string;
    vehicleColor: string;
    licensePlate: string;
    photoUrl?: string;
  };
  route?: {
    polyline: string; // Encoded polyline
    distanceMeters: number;
    durationSeconds: number;
  };
  timestamps: {
    requestedAt: string;
    matchedAt?: string;
    arrivedAt?: string;
    startedAt?: string;
    completedAt?: string;
  };
}

// POST /api/rides/:rideId/cancel
interface CancelResponse {
  success: boolean;
  cancellationFee?: number;
}

// POST /api/rides/:rideId/rate
interface RateRequest {
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
  tipCents?: number;
}

// ==================== DRIVER ENDPOINTS ====================

// POST /api/driver/online
// POST /api/driver/offline
interface DriverStatusResponse {
  isOnline: boolean;
  lastLocation?: LatLng;
}

// POST /api/driver/rides/:rideId/accept
// POST /api/driver/rides/:rideId/arrived
// POST /api/driver/rides/:rideId/start
// POST /api/driver/rides/:rideId/complete
interface RideTransitionResponse {
  success: boolean;
  newStatus: RideStatus;
  ride: RideDetails;
}

// GET /api/driver/nearby
interface NearbyDriversRequest {
  lat: number;
  lng: number;
  vehicleType?: VehicleType;
}

interface NearbyDriversResponse {
  drivers: Array<{
    id: string;
    location: LatLng;
    vehicleType: VehicleType;
    heading?: number;
  }>;
}
```

### WebSocket Message Types

```typescript
// ==================== CLIENT -> SERVER ====================

// Authentication
interface WsAuthMessage {
  type: 'auth';
  token: string;
}

// Driver location update (sent every 3 seconds)
interface WsLocationUpdate {
  type: 'location_update';
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  accuracy: number;
  timestamp: number;
}

// Heartbeat
interface WsPing {
  type: 'ping';
}

// ==================== SERVER -> CLIENT (RIDER) ====================

// Driver matched to ride
interface WsRideMatched {
  type: 'ride_matched';
  rideId: string;
  driver: {
    id: string;
    name: string;
    rating: number;
    vehicleMake: string;
    vehicleModel: string;
    vehicleColor: string;
    licensePlate: string;
    photoUrl?: string;
  };
  eta: number; // minutes
  route: {
    polyline: string;
    distanceMeters: number;
  };
}

// Driver location broadcast (sent to rider during active ride)
interface WsDriverLocation {
  type: 'driver_location';
  rideId: string;
  location: LatLng;
  heading?: number;
  eta?: number; // Updated ETA
}

// Status transitions
interface WsStatusUpdate {
  type: 'driver_arrived' | 'ride_started' | 'ride_completed';
  rideId: string;
  timestamp: number;
  data?: {
    finalFareCents?: number;
    distanceMeters?: number;
    durationSeconds?: number;
  };
}

// ==================== SERVER -> CLIENT (DRIVER) ====================

// Incoming ride offer
interface WsRideOffer {
  type: 'ride_offer';
  rideId: string;
  rider: {
    name: string;
    rating: number;
  };
  pickup: Location;
  dropoff: Location;
  estimatedFareCents: number;
  surgeMultiplier: number;
  distanceToPickup: number; // meters
  eta: number; // minutes to pickup
  expiresIn: number; // seconds until offer expires
}

// Offer timeout/cancelled
interface WsOfferExpired {
  type: 'offer_expired';
  rideId: string;
  reason: 'timeout' | 'cancelled' | 'accepted_by_other';
}
```

---

## 4. End-to-End Flow: Ride Request (7-8 minutes)

### Sequence Diagram

```
┌────────┐     ┌────────┐     ┌────────┐     ┌────────┐     ┌────────┐
│ Rider  │     │Frontend│     │ API    │     │ Redis  │     │WebSocket│
│  App   │     │ Store  │     │Gateway │     │ Geo    │     │ Server │
└───┬────┘     └───┬────┘     └───┬────┘     └───┬────┘     └───┬────┘
    │              │              │              │              │
    │ Tap "Request │              │              │              │
    │ Ride"        │              │              │              │
    ├─────────────▶│              │              │              │
    │              │              │              │              │
    │              │ Set status:  │              │              │
    │              │ 'requesting' │              │              │
    │              ├──────────────│              │              │
    │              │              │              │              │
    │              │ POST /rides/request         │              │
    │              │ + X-Idempotency-Key        │              │
    │              ├─────────────▶│              │              │
    │              │              │              │              │
    │              │              │ Check idempotency           │
    │              │              ├─────────────▶│              │
    │              │              │              │              │
    │              │              │ Insert ride (status: requested)
    │              │              ├──────────────│              │
    │              │              │              │              │
    │              │              │ Publish to matching queue   │
    │              │              ├──────────────│──────────────│
    │              │              │              │              │
    │              │ 202 Accepted │              │              │
    │              │ {rideId, status: 'matching'}│              │
    │              │◀─────────────┤              │              │
    │              │              │              │              │
    │              │ Set status:  │              │              │
    │              │ 'matching'   │              │              │
    │              ├──────────────│              │              │
    │              │              │              │              │
    │ Show         │              │              │              │
    │ "Searching..." animation    │              │              │
    │◀─────────────┤              │              │              │
    │              │              │              │              │
    │              │              │              │              │
    │  ─ ─ ─ ─ ─ ─ ─ ─ ─ MATCHING WORKER ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
    │              │              │              │              │
    │              │              │ GEORADIUS    │              │
    │              │              │ find nearby  │              │
    │              │              ├─────────────▶│              │
    │              │              │              │              │
    │              │              │ [driver1, driver2, driver3] │
    │              │              │◀─────────────┤              │
    │              │              │              │              │
    │              │              │ Score & select best driver  │
    │              │              ├──────────────│              │
    │              │              │              │              │
    │              │              │ Send ride offer to driver   │
    │              │              ├──────────────│──────────────▶
    │              │              │              │              │
    │              │              │              │              │
┌───┴────┐     ┌───┴────┐     ┌───┴────┐     ┌───┴────┐     ┌───┴────┐
│ Driver │     │Driver  │     │        │     │        │     │        │
│  App   │     │ Store  │     │        │     │        │     │        │
└───┬────┘     └───┬────┘     └───┬────┘     └───┬────┘     └───┬────┘
    │              │              │              │              │
    │              │ WsRideOffer  │              │              │
    │◀─────────────│◀─────────────│◀─────────────│◀─────────────┤
    │              │              │              │              │
    │ Show ride    │              │              │              │
    │ offer modal  │              │              │              │
    ├──────────────│              │              │              │
    │              │              │              │              │
    │ Driver taps  │              │              │              │
    │ "Accept"     │              │              │              │
    ├─────────────▶│              │              │              │
    │              │              │              │              │
    │              │ POST /driver/rides/:id/accept              │
    │              ├─────────────▶│              │              │
    │              │              │              │              │
    │              │              │ UPDATE rides SET            │
    │              │              │ status='matched',           │
    │              │              │ driver_id=$1                │
    │              │              │ WHERE status='requested'    │
    │              │              ├──────────────│              │
    │              │              │              │              │
    │              │              │ ZREM drivers:available      │
    │              │              ├─────────────▶│              │
    │              │              │              │              │
    │              │              │ Broadcast WsRideMatched     │
    │              │              │ to rider                    │
    │              │              ├──────────────│──────────────▶
    │              │              │              │              │
    │              │ 200 OK       │              │              │
    │              │◀─────────────┤              │              │
    │              │              │              │              │
    │              │              │              │              │
┌───┴────┐     ┌───┴────┐     ┌───┴────┐     ┌───┴────┐     ┌───┴────┐
│ Rider  │     │ Rider  │     │        │     │        │     │        │
│  App   │     │ Store  │     │        │     │        │     │        │
└───┬────┘     └───┬────┘     └───┬────┘     └───┬────┘     └───┬────┘
    │              │              │              │              │
    │              │ WsRideMatched│              │              │
    │◀─────────────│◀─────────────│◀─────────────│◀─────────────┤
    │              │              │              │              │
    │              │ Set status:  │              │              │
    │              │ 'matched',   │              │              │
    │              │ driver info  │              │              │
    │              ├──────────────│              │              │
    │              │              │              │              │
    │ Show driver  │              │              │              │
    │ info, ETA    │              │              │              │
    │◀─────────────┤              │              │              │
    │              │              │              │              │
```

### Frontend Implementation

```tsx
// Ride request hook
function useRequestRide() {
  const { pickup, dropoff, vehicleType, setStatus, setRideId } = useRideStore();
  const { mutateAsync } = useMutation({
    mutationFn: async () => {
      const idempotencyKey = crypto.randomUUID();

      const response = await api.post('/rides/request', {
        pickup,
        dropoff,
        vehicleType
      }, {
        headers: { 'X-Idempotency-Key': idempotencyKey }
      });

      return response.data;
    },
    onMutate: () => {
      setStatus('requesting');
    },
    onSuccess: (data) => {
      setRideId(data.rideId);
      setStatus('matching');
    },
    onError: () => {
      setStatus('idle');
    }
  });

  return mutateAsync;
}

// Matching animation component
function MatchingScreen() {
  const status = useRideStore(state => state.status);
  const cancelRide = useCancelRide();

  if (status !== 'matching') return null;

  return (
    <div className="fixed inset-0 bg-white flex flex-col items-center justify-center">
      {/* Pulsing radar animation */}
      <div className="relative w-48 h-48">
        <motion.div
          className="absolute inset-0 rounded-full border-2 border-black"
          animate={{ scale: [1, 1.5, 1], opacity: [1, 0, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
        <motion.div
          className="absolute inset-8 rounded-full border-2 border-black"
          animate={{ scale: [1, 1.3, 1], opacity: [1, 0, 1] }}
          transition={{ duration: 2, repeat: Infinity, delay: 0.3 }}
        />
        <div className="absolute inset-16 rounded-full bg-black flex items-center justify-center">
          <CarIcon className="w-8 h-8 text-white" />
        </div>
      </div>

      <p className="mt-8 text-xl font-medium">Finding your driver...</p>
      <p className="text-gray-500 mt-2">This usually takes less than a minute</p>

      <button
        onClick={() => cancelRide()}
        className="mt-8 px-6 py-3 text-red-500 font-medium"
      >
        Cancel request
      </button>
    </div>
  );
}
```

### Backend Implementation

```typescript
// Ride request handler
app.post('/rides/request', idempotencyMiddleware, async (req, res) => {
  const { pickup, dropoff, vehicleType } = req.body;
  const riderId = req.userId;

  // Validate inputs
  if (!isValidLocation(pickup) || !isValidLocation(dropoff)) {
    return res.status(400).json({ error: 'Invalid locations' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Calculate fare estimate
    const estimate = await pricingService.calculateFare(pickup, dropoff, vehicleType);

    // Insert ride
    const result = await client.query(`
      INSERT INTO rides (
        id, rider_id, status, vehicle_type,
        pickup_lat, pickup_lng, pickup_address,
        dropoff_lat, dropoff_lng, dropoff_address,
        estimated_fare_cents, surge_multiplier
      ) VALUES (
        gen_random_uuid(), $1, 'requested', $2,
        $3, $4, $5,
        $6, $7, $8,
        $9, $10
      ) RETURNING *
    `, [
      riderId, vehicleType,
      pickup.lat, pickup.lng, pickup.address,
      dropoff.lat, dropoff.lng, dropoff.address,
      estimate.finalFareCents, estimate.surgeMultiplier
    ]);

    const ride = result.rows[0];

    // Publish to matching queue
    await publishToQueue('matching.requests', {
      requestId: ride.id,
      rideId: ride.id,
      pickupLocation: { lat: pickup.lat, lng: pickup.lng },
      vehicleType,
      maxWaitSeconds: 120,
      attempt: 1
    });

    await client.query('COMMIT');

    // Update ride status to matching
    await pool.query(`
      UPDATE rides SET status = 'matching' WHERE id = $1
    `, [ride.id]);

    res.status(202).json({
      rideId: ride.id,
      status: 'matching',
      estimatedFareCents: estimate.finalFareCents,
      surgeMultiplier: estimate.surgeMultiplier
    });

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

// Matching worker
async function processMatchRequest(message: MatchingRequest) {
  const { rideId, pickupLocation, vehicleType, attempt } = message;

  // Check if ride still needs matching
  const ride = await getRide(rideId);
  if (ride.status !== 'matching') {
    return; // Already matched or cancelled
  }

  // Find nearby drivers
  const candidates = await locationService.findNearbyDrivers(
    pickupLocation.lat,
    pickupLocation.lng,
    vehicleType,
    5 // 5km radius
  );

  if (candidates.length === 0) {
    // Expand search or notify rider
    if (attempt < 3) {
      await requeueWithBackoff(message, attempt);
    } else {
      await notifyNoDrivers(rideId);
    }
    return;
  }

  // Score and select best driver
  const scored = await Promise.all(
    candidates.map(async (driver) => {
      const driverInfo = await getDriverInfo(driver.memberId);
      const eta = await calculateETA(driver, pickupLocation);
      return {
        ...driver,
        ...driverInfo,
        eta,
        score: computeMatchScore(driverInfo, eta)
      };
    })
  );

  scored.sort((a, b) => b.score - a.score);

  // Send offer to top candidate
  const topDriver = scored[0];
  await sendRideOffer(topDriver.id, ride, topDriver.eta);

  // Set timeout for offer expiration
  setTimeout(async () => {
    await handleOfferTimeout(rideId, topDriver.id, scored.slice(1));
  }, 15000);
}
```

---

## 5. Real-time Location Broadcasting (6-7 minutes)

### Driver -> Server -> Rider Flow

```typescript
// WebSocket server handling
class RideWebSocketServer {
  private connections = new Map<string, WebSocket>(); // userId -> socket
  private rideSubscriptions = new Map<string, Set<string>>(); // rideId -> Set<userId>

  handleConnection(ws: WebSocket, userId: string, userType: 'rider' | 'driver') {
    this.connections.set(userId, ws);

    ws.on('message', async (data) => {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'location_update':
          if (userType === 'driver') {
            await this.handleDriverLocationUpdate(userId, message);
          }
          break;

        case 'subscribe_ride':
          if (userType === 'rider') {
            this.subscribeToRide(userId, message.rideId);
          }
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    });

    ws.on('close', () => {
      this.connections.delete(userId);
      this.cleanupSubscriptions(userId);
    });
  }

  async handleDriverLocationUpdate(driverId: string, message: WsLocationUpdate) {
    // Update Redis geo index
    await locationService.updateDriverLocation(driverId, {
      lat: message.lat,
      lng: message.lng,
      heading: message.heading,
      speed: message.speed,
      timestamp: message.timestamp
    });

    // Find if driver has an active ride
    const activeRide = await getDriverActiveRide(driverId);
    if (!activeRide) return;

    // Broadcast to subscribed rider
    const subscribers = this.rideSubscriptions.get(activeRide.id);
    if (!subscribers) return;

    const locationUpdate: WsDriverLocation = {
      type: 'driver_location',
      rideId: activeRide.id,
      location: { lat: message.lat, lng: message.lng },
      heading: message.heading,
      eta: await calculateETA(
        { lat: message.lat, lng: message.lng },
        activeRide.status === 'matched'
          ? { lat: activeRide.pickup_lat, lng: activeRide.pickup_lng }
          : { lat: activeRide.dropoff_lat, lng: activeRide.dropoff_lng }
      )
    };

    for (const userId of subscribers) {
      const socket = this.connections.get(userId);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(locationUpdate));
      }
    }
  }

  subscribeToRide(userId: string, rideId: string) {
    if (!this.rideSubscriptions.has(rideId)) {
      this.rideSubscriptions.set(rideId, new Set());
    }
    this.rideSubscriptions.get(rideId)!.add(userId);
  }

  async broadcastRideEvent(rideId: string, event: WsStatusUpdate) {
    const subscribers = this.rideSubscriptions.get(rideId);
    if (!subscribers) return;

    for (const userId of subscribers) {
      const socket = this.connections.get(userId);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    }
  }
}
```

### Frontend WebSocket Integration

```tsx
// WebSocket context and provider
const WebSocketContext = createContext<WebSocketClient | null>(null);

function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuthStore();
  const [client, setClient] = useState<WebSocketClient | null>(null);
  const rideStore = useRideStore();

  useEffect(() => {
    if (!user || !token) return;

    const ws = new WebSocketClient(WS_URL);
    ws.connect(token);

    // Set up event handlers based on user type
    if (user.userType === 'rider') {
      ws.on('ride_matched', (data: WsRideMatched) => {
        rideStore.setDriver(data.driver);
        rideStore.setStatus('matched');
        rideStore.setRoute(decodePolyline(data.route.polyline));

        // Subscribe to location updates
        ws.send('subscribe_ride', { rideId: data.rideId });
      });

      ws.on('driver_location', (data: WsDriverLocation) => {
        rideStore.setDriverLocation(data.location);
        if (data.eta) {
          rideStore.setEta(data.eta);
        }
      });

      ws.on('driver_arrived', () => {
        rideStore.setStatus('driver_arrived');
        showNotification('Your driver has arrived!');
      });

      ws.on('ride_started', () => {
        rideStore.setStatus('in_progress');
      });

      ws.on('ride_completed', (data) => {
        rideStore.setStatus('completed');
        rideStore.setFinalFare(data.data?.finalFareCents);
      });
    }

    if (user.userType === 'driver') {
      ws.on('ride_offer', (data: WsRideOffer) => {
        useDriverStore.getState().setCurrentOffer(data);
      });

      ws.on('offer_expired', (data: WsOfferExpired) => {
        const currentOffer = useDriverStore.getState().currentOffer;
        if (currentOffer?.rideId === data.rideId) {
          useDriverStore.getState().clearOffer();
        }
      });
    }

    setClient(ws);

    return () => {
      ws.disconnect();
    };
  }, [user, token]);

  return (
    <WebSocketContext.Provider value={client}>
      {children}
    </WebSocketContext.Provider>
  );
}

// Custom hook for WebSocket
function useWebSocket() {
  const client = useContext(WebSocketContext);
  if (!client) {
    throw new Error('useWebSocket must be used within WebSocketProvider');
  }
  return client;
}
```

### Driver Location Sender

```tsx
// Driver app location tracking
function useDriverLocationTracking() {
  const ws = useWebSocket();
  const { isOnline } = useDriverStore();
  const watchIdRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number>(0);

  useEffect(() => {
    if (!isOnline) {
      if (watchIdRef.current) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const now = Date.now();

        // Throttle to every 3 seconds
        if (now - lastUpdateRef.current < 3000) return;
        lastUpdateRef.current = now;

        const update: WsLocationUpdate = {
          type: 'location_update',
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          heading: position.coords.heading ?? undefined,
          speed: position.coords.speed ?? undefined,
          accuracy: position.coords.accuracy,
          timestamp: now
        };

        ws.send('location_update', update);
      },
      (error) => {
        console.error('Location error:', error);
      },
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 2000
      }
    );

    return () => {
      if (watchIdRef.current) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, [isOnline, ws]);
}
```

---

## 6. Error Handling Across Stack (5-6 minutes)

### API Error Responses

```typescript
// Standardized error response format
interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
    retryable: boolean;
    retryAfter?: number; // seconds
  };
}

// Error codes
const ErrorCodes = {
  // Client errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RIDE_NOT_FOUND: 'RIDE_NOT_FOUND',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  DRIVER_UNAVAILABLE: 'DRIVER_UNAVAILABLE',

  // Server errors
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  MATCHING_TIMEOUT: 'MATCHING_TIMEOUT',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

// Backend error middleware
function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  logger.error('Request error', { error: err, path: req.path });

  if (err instanceof ValidationError) {
    return res.status(400).json({
      error: {
        code: ErrorCodes.VALIDATION_ERROR,
        message: err.message,
        details: err.details,
        retryable: false
      }
    });
  }

  if (err instanceof StateTransitionError) {
    return res.status(409).json({
      error: {
        code: ErrorCodes.INVALID_STATE_TRANSITION,
        message: `Cannot transition from ${err.fromState} to ${err.toState}`,
        retryable: false
      }
    });
  }

  if (err instanceof ServiceUnavailableError) {
    return res.status(503).json({
      error: {
        code: ErrorCodes.SERVICE_UNAVAILABLE,
        message: 'High demand in your area. Please try again.',
        retryable: true,
        retryAfter: err.retryAfter || 30
      }
    });
  }

  // Default to internal error
  return res.status(500).json({
    error: {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Something went wrong. Please try again.',
      retryable: true
    }
  });
}
```

### Frontend Error Handling

```tsx
// API client with error handling
const api = axios.create({
  baseURL: API_URL,
  timeout: 10000
});

api.interceptors.response.use(
  response => response,
  async (error: AxiosError<ApiError>) => {
    const apiError = error.response?.data?.error;

    if (!apiError) {
      // Network error
      if (!navigator.onLine) {
        toast.error('No internet connection. Please check your network.');
        throw new OfflineError();
      }

      toast.error('Connection error. Please try again.');
      throw error;
    }

    // Handle specific error codes
    switch (apiError.code) {
      case ErrorCodes.UNAUTHORIZED:
        useAuthStore.getState().logout();
        throw error;

      case ErrorCodes.SERVICE_UNAVAILABLE:
        toast.error(apiError.message);
        if (apiError.retryable && apiError.retryAfter) {
          // Schedule retry
          await sleep(apiError.retryAfter * 1000);
          return api.request(error.config!);
        }
        throw error;

      case ErrorCodes.MATCHING_TIMEOUT:
        toast.error('No drivers available. Please try again.');
        useRideStore.getState().reset();
        throw error;

      case ErrorCodes.PAYMENT_FAILED:
        toast.error('Payment failed. Please update your payment method.');
        throw error;

      default:
        toast.error(apiError.message);
        throw error;
    }
  }
);
```

### WebSocket Reconnection

```tsx
// Reconnection with state recovery
class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private pendingSubscriptions: string[] = [];

  async connect(token: string) {
    try {
      this.ws = new WebSocket(`${WS_URL}?token=${token}`);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;

        // Re-subscribe to active ride
        const activeRideId = useRideStore.getState().rideId;
        if (activeRideId) {
          this.send('subscribe_ride', { rideId: activeRideId });
        }

        // Restore pending subscriptions
        this.pendingSubscriptions.forEach(rideId => {
          this.send('subscribe_ride', { rideId });
        });
        this.pendingSubscriptions = [];

        this.emit('connected');
      };

      this.ws.onclose = (event) => {
        if (!event.wasClean) {
          this.scheduleReconnect(token);
        }
      };

    } catch (error) {
      this.scheduleReconnect(token);
    }
  }

  private scheduleReconnect(token: string) {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    setTimeout(() => {
      this.connect(token);
    }, delay);
  }
}
```

---

## 7. State Synchronization (4-5 minutes)

### Optimistic Updates with Rollback

```tsx
// Cancel ride with optimistic update
function useCancelRide() {
  const queryClient = useQueryClient();
  const { rideId, status, setStatus } = useRideStore();

  return useMutation({
    mutationFn: async () => {
      return api.post(`/rides/${rideId}/cancel`);
    },
    onMutate: async () => {
      // Snapshot current state for rollback
      const previousStatus = status;

      // Optimistic update
      setStatus('cancelled');

      return { previousStatus };
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousStatus) {
        setStatus(context.previousStatus);
      }
      toast.error('Failed to cancel ride');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rides', rideId] });
    }
  });
}
```

### Reconciling WebSocket and REST State

```tsx
// Hook to sync ride state from multiple sources
function useRideStateSync() {
  const { rideId, status } = useRideStore();
  const queryClient = useQueryClient();

  // Periodic REST polling as fallback
  const { data: rideData } = useQuery({
    queryKey: ['rides', rideId],
    queryFn: () => api.get(`/rides/${rideId}`).then(r => r.data),
    enabled: !!rideId && ['matching', 'matched', 'in_progress'].includes(status),
    refetchInterval: 10000, // Poll every 10 seconds as backup
    staleTime: 3000
  });

  // Reconcile if REST data differs from store
  useEffect(() => {
    if (!rideData) return;

    const wsStatus = status;
    const restStatus = rideData.status;

    // If REST status is "ahead" of WebSocket status, update store
    const statusOrder = ['matching', 'matched', 'driver_arrived', 'in_progress', 'completed'];
    const wsIndex = statusOrder.indexOf(wsStatus);
    const restIndex = statusOrder.indexOf(restStatus);

    if (restIndex > wsIndex) {
      logger.warn('State divergence detected, reconciling', { wsStatus, restStatus });
      useRideStore.getState().setStatus(restStatus);

      if (rideData.driver) {
        useRideStore.getState().setDriver(rideData.driver);
      }
    }
  }, [rideData, status]);
}
```

### Offline Action Queue

```tsx
// Queue actions when offline
class OfflineActionQueue {
  private queue: Array<{ action: string; payload: any; timestamp: number }> = [];
  private isOnline = navigator.onLine;

  constructor() {
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.isOnline = false);
  }

  enqueue(action: string, payload: any) {
    this.queue.push({
      action,
      payload,
      timestamp: Date.now()
    });
    this.persist();
  }

  private async handleOnline() {
    this.isOnline = true;

    // Process queued actions
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;

      // Skip stale actions (older than 5 minutes)
      if (Date.now() - item.timestamp > 5 * 60 * 1000) {
        continue;
      }

      try {
        await this.executeAction(item.action, item.payload);
      } catch (error) {
        // Re-queue on failure
        this.queue.unshift(item);
        break;
      }
    }

    this.persist();
  }

  private async executeAction(action: string, payload: any) {
    switch (action) {
      case 'update_location':
        await api.post('/driver/location', payload);
        break;
      case 'rate_ride':
        await api.post(`/rides/${payload.rideId}/rate`, payload);
        break;
    }
  }

  private persist() {
    localStorage.setItem('offline_queue', JSON.stringify(this.queue));
  }
}
```

---

## 8. Testing Strategy (3-4 minutes)

### Integration Test Example

```typescript
// Test ride request flow end-to-end
describe('Ride Request Flow', () => {
  let riderToken: string;
  let driverToken: string;
  let driverWs: WebSocket;
  let riderWs: WebSocket;

  beforeAll(async () => {
    // Setup test users
    riderToken = await loginAs('rider@test.com');
    driverToken = await loginAs('driver@test.com');

    // Put driver online
    await api.post('/driver/online', {}, {
      headers: { Authorization: `Bearer ${driverToken}` }
    });

    // Update driver location near test pickup
    await api.post('/driver/location', {
      lat: 37.7749,
      lng: -122.4194
    }, {
      headers: { Authorization: `Bearer ${driverToken}` }
    });

    // Connect WebSockets
    driverWs = await connectWebSocket(driverToken);
    riderWs = await connectWebSocket(riderToken);
  });

  it('should complete full ride flow', async () => {
    // 1. Rider requests ride
    const requestResponse = await api.post('/rides/request', {
      pickup: { lat: 37.7749, lng: -122.4194, address: '123 Test St' },
      dropoff: { lat: 37.7849, lng: -122.4094, address: '456 Dest Ave' },
      vehicleType: 'economy'
    }, {
      headers: {
        Authorization: `Bearer ${riderToken}`,
        'X-Idempotency-Key': 'test-key-1'
      }
    });

    expect(requestResponse.status).toBe(202);
    expect(requestResponse.data.status).toBe('matching');
    const rideId = requestResponse.data.rideId;

    // 2. Wait for driver to receive offer
    const offer = await waitForWsMessage(driverWs, 'ride_offer', 5000);
    expect(offer.rideId).toBe(rideId);

    // 3. Driver accepts
    const acceptResponse = await api.post(`/driver/rides/${rideId}/accept`, {}, {
      headers: { Authorization: `Bearer ${driverToken}` }
    });
    expect(acceptResponse.data.newStatus).toBe('matched');

    // 4. Rider receives matched notification
    const matched = await waitForWsMessage(riderWs, 'ride_matched', 5000);
    expect(matched.rideId).toBe(rideId);
    expect(matched.driver.name).toBeTruthy();

    // 5. Driver arrives
    await api.post(`/driver/rides/${rideId}/arrived`, {}, {
      headers: { Authorization: `Bearer ${driverToken}` }
    });

    const arrived = await waitForWsMessage(riderWs, 'driver_arrived', 5000);
    expect(arrived.rideId).toBe(rideId);

    // 6. Start ride
    await api.post(`/driver/rides/${rideId}/start`, {}, {
      headers: { Authorization: `Bearer ${driverToken}` }
    });

    // 7. Complete ride
    const completeResponse = await api.post(`/driver/rides/${rideId}/complete`, {}, {
      headers: { Authorization: `Bearer ${driverToken}` }
    });

    const completed = await waitForWsMessage(riderWs, 'ride_completed', 5000);
    expect(completed.data.finalFareCents).toBeGreaterThan(0);
  });
});
```

### Component Test

```tsx
// Test matching screen behavior
describe('MatchingScreen', () => {
  it('should show searching animation during matching', () => {
    useRideStore.setState({ status: 'matching' });

    render(<MatchingScreen />);

    expect(screen.getByText('Finding your driver...')).toBeInTheDocument();
    expect(screen.getByText('Cancel request')).toBeInTheDocument();
  });

  it('should allow cancellation', async () => {
    const cancelMock = vi.fn();
    vi.mocked(useCancelRide).mockReturnValue({ mutateAsync: cancelMock });

    useRideStore.setState({ status: 'matching', rideId: 'ride-123' });

    render(<MatchingScreen />);

    await userEvent.click(screen.getByText('Cancel request'));

    expect(cancelMock).toHaveBeenCalled();
  });
});
```

---

## 9. Trade-offs Discussion (3-4 minutes)

### API Design Choices

| Decision | Alternative | Trade-off |
|----------|-------------|-----------|
| **REST + WebSocket** | GraphQL subscriptions | REST simpler for mobile caching; WS for real-time |
| **Idempotency keys** | Server-generated request IDs | Client control, works with retries |
| **202 for ride request** | 201 with polling | Indicates async processing, cleaner semantics |

### State Management

| Decision | Alternative | Trade-off |
|----------|-------------|-----------|
| **Zustand stores** | Redux | Less boilerplate, easier for small teams |
| **Optimistic updates** | Wait for server | Better UX, complexity in rollback |
| **REST polling backup** | WebSocket only | Reliability vs. extra requests |

### Real-time Architecture

| Decision | Alternative | Trade-off |
|----------|-------------|-----------|
| **WebSocket per user** | Shared broadcast | Targeted delivery, higher connection count |
| **3-second location interval** | 1-second | Battery vs. smoothness |
| **Server-side subscription management** | Client-side topic subscription | Centralized control, easier auth |

---

## Summary

The key full-stack engineering insights for a ride-hailing platform:

1. **API contract is the integration point**: Well-defined TypeScript interfaces shared between frontend and backend ensure type safety across the stack

2. **Idempotency prevents duplicate charges**: Mobile networks cause retries; idempotency keys in API requests prevent double-booking

3. **WebSocket + REST hybrid**: Real-time updates via WebSocket, with REST polling as backup for reliability

4. **State synchronization is critical**: Frontend must reconcile WebSocket events with REST data; handle reconnection gracefully

5. **Optimistic updates with rollback**: Show immediate feedback but be ready to revert if server rejects the action

6. **Error handling spans the stack**: Standardized error codes, retryable indicators, and user-friendly messages at each layer

The system achieves real-time responsiveness while maintaining reliability through redundant state synchronization and careful error handling at every integration point.
