# Uber - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Opening Statement

"I'll be designing the frontend for a ride-hailing platform like Uber. As a frontend engineer, I'll focus on the real-time map interactions, WebSocket-driven live tracking, state management for ride lifecycle, performance optimization for mobile-first users, and the distinct UX patterns for both rider and driver personas. The key challenge is providing smooth, real-time updates while handling unreliable mobile network conditions gracefully."

---

## 1. Requirements Clarification (3-4 minutes)

### Frontend-Focused Functional Requirements

1. **Rider App Interface**
   - Interactive map with pickup/dropoff location selection
   - Real-time driver tracking during ride
   - Fare estimation before booking
   - Ride status updates (matching, driver arriving, in progress)
   - Rating and feedback after completion

2. **Driver App Interface**
   - Toggle availability status
   - Incoming ride offer with accept/decline actions
   - Navigation view with turn-by-turn directions
   - Earnings dashboard and trip history

3. **Real-time Features**
   - Live driver location on map (updates every 3 seconds)
   - Push notifications for ride events
   - Connection status indicator
   - Automatic reconnection handling

4. **Offline Resilience**
   - Show cached ride state during connection loss
   - Queue actions for retry when online
   - Display last known driver position

### Non-Functional Requirements (Frontend Perspective)

| Requirement | Target | Justification |
|-------------|--------|---------------|
| Map render time | < 500ms | First impression on app open |
| Location update latency | < 1s | Real-time tracking feel |
| Interaction response | < 100ms | Touch responsiveness |
| Bundle size (initial) | < 150KB | Mobile data constraints |
| Offline tolerance | 30s | Tunnel/elevator scenarios |
| Battery efficiency | Low drain | Background location |

---

## 2. User Experience Deep Dive (5 minutes)

### Rider Journey Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        RIDER JOURNEY                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Home      │───▶│  Set        │───▶│  Confirm    │───▶│  Matching   │
│   Screen    │    │  Destination│    │  & Request  │    │  Animation  │
│             │    │             │    │             │    │             │
│ - Map view  │    │ - Search    │    │ - Fare est  │    │ - Searching │
│ - My loc    │    │ - Autocmpl  │    │ - Vehicle   │    │ - Progress  │
│ - Where to? │    │ - Recent    │    │ - Surge     │    │ - Cancel    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                                                               │
                                                               ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Rating    │◀───│   Trip      │◀───│   In Ride   │◀───│  Driver     │
│   Screen    │    │  Complete   │    │             │    │  Arriving   │
│             │    │             │    │             │    │             │
│ - Star rate │    │ - Fare      │    │ - Live map  │    │ - Driver    │
│ - Tip       │    │ - Receipt   │    │ - ETA       │    │   info      │
│ - Comment   │    │ - Tip       │    │ - Contact   │    │ - Live loc  │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

### Driver Journey Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                       DRIVER JOURNEY                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Offline   │───▶│   Online    │───▶│  Ride Offer │───▶│  Navigate   │
│   Mode      │    │   Waiting   │    │  (15s timer)│    │  to Pickup  │
│             │    │             │    │             │    │             │
│ - Go online │    │ - Heatmap   │    │ - Accept    │    │ - Route     │
│ - Earnings  │    │ - Requests  │    │ - Decline   │    │ - ETA       │
│ - History   │    │ - Stats     │    │ - Details   │    │ - Arrived   │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                                                               │
                                                               ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Complete  │◀───│   Navigate  │◀───│   Start     │◀───│  At Pickup  │
│   Screen    │    │  to Dropoff │    │   Ride      │    │             │
│             │    │             │    │             │    │             │
│ - Fare      │    │ - Route     │    │ - Slide to  │    │ - Rider pic │
│ - Rating    │    │ - ETA       │    │   start     │    │ - Contact   │
│ - Next ride │    │ - Arrive    │    │ - Wait      │    │ - Cancel    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

### Critical Interaction Patterns

| Interaction | Pattern | Rationale |
|-------------|---------|-----------|
| Pickup location | Pin drop + address search | Precision with fallback |
| Vehicle selection | Swipeable cards | One-handed operation |
| Ride confirmation | Bottom sheet + swipe | Prevent accidental taps |
| Driver accept | Countdown timer | Urgency, prevent stale offers |
| Status transitions | Slide-to-confirm | Deliberate action required |

---

## 3. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           RIDER/DRIVER APP                              │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐       │
│  │   Map Layer      │  │   UI Components  │  │  Notifications   │       │
│  │                  │  │                  │  │                  │       │
│  │ - Mapbox/Google  │  │ - Bottom Sheet   │  │ - Push Manager   │       │
│  │ - Driver markers │  │ - Vehicle Cards  │  │ - In-app alerts  │       │
│  │ - Route polyline │  │ - Status Bar     │  │ - Sound effects  │       │
│  │ - Pickup pin     │  │ - Rating Modal   │  │                  │       │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘       │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    State Management (Zustand)                │       │
│  │                                                              │       │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │       │
│  │  │ authStore   │  │ rideStore   │  │ locationStore│          │       │
│  │  │             │  │             │  │             │          │       │
│  │  │ - user      │  │ - status    │  │ - myLocation│          │       │
│  │  │ - token     │  │ - driver    │  │ - driverLoc │          │       │
│  │  │ - userType  │  │ - fare      │  │ - route     │          │       │
│  │  └─────────────┘  └─────────────┘  └─────────────┘          │       │
│  └──────────────────────────────────────────────────────────────┘       │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    Service Layer                             │       │
│  │                                                              │       │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │       │
│  │  │ WebSocket   │  │ REST API    │  │ Geolocation │          │       │
│  │  │ Client      │  │ Client      │  │ Manager     │          │       │
│  │  │             │  │             │  │             │          │       │
│  │  │ - reconnect │  │ - axios     │  │ - watch     │          │       │
│  │  │ - heartbeat │  │ - retry     │  │ - accuracy  │          │       │
│  │  │ - events    │  │ - cache     │  │ - battery   │          │       │
│  │  └─────────────┘  └─────────────┘  └─────────────┘          │       │
│  └──────────────────────────────────────────────────────────────┘       │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    Persistence Layer                         │       │
│  │                                                              │       │
│  │  IndexedDB (Ride History)  │  LocalStorage (Auth, Prefs)    │       │
│  └──────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
          ┌──────────────────┐            ┌──────────────────┐
          │   WebSocket      │            │   REST API       │
          │   Server         │            │                  │
          │                  │            │ - /rides         │
          │ - ride events    │            │ - /auth          │
          │ - driver loc     │            │ - /driver        │
          └──────────────────┘            └──────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Key Considerations |
|-----------|----------------|-------------------|
| Map Layer | Visualization, interaction | Memory-efficient markers |
| Bottom Sheet | Ride flow UI | Gesture handling |
| WebSocket Client | Real-time updates | Auto-reconnect |
| Location Manager | GPS tracking | Battery optimization |
| Ride Store | State machine | Persist across restarts |

---

## 4. Deep Dive: Interactive Map (8-10 minutes)

### Map Library Selection

| Library | Pros | Cons | Decision |
|---------|------|------|----------|
| **Mapbox GL** | Vector tiles, customization, offline | Commercial license | **Chosen** |
| Google Maps | Familiar, reliable | Per-load pricing | Alternative |
| Leaflet | Free, simple | No vector tiles | Too limited |
| Apple Maps | Native iOS | Not cross-platform | iOS-only option |

### Map Component Architecture

```tsx
interface MapProps {
  center: LatLng;
  zoom: number;
  onMapReady: () => void;
  onLocationSelect: (location: LatLng) => void;
}

function RideMap({ center, zoom, onMapReady, onLocationSelect }: MapProps) {
  const mapRef = useRef<MapRef>(null);
  const { driverLocation, route, pickupLocation, dropoffLocation } = useRideStore();
  const { nearbyDrivers } = useLocationStore();

  // Animate to new driver position smoothly
  useEffect(() => {
    if (driverLocation && mapRef.current) {
      mapRef.current.animateTo(driverLocation, { duration: 1000 });
    }
  }, [driverLocation]);

  return (
    <Map
      ref={mapRef}
      initialCenter={center}
      initialZoom={zoom}
      onLoad={onMapReady}
      onPress={onLocationSelect}
      style={mapStyles.darkMode}
    >
      {/* Nearby drivers (when searching) */}
      <DriverClusterLayer drivers={nearbyDrivers} />

      {/* Route polyline */}
      {route && <RoutePolyline coordinates={route.coordinates} />}

      {/* Pickup/Dropoff pins */}
      {pickupLocation && <PickupMarker location={pickupLocation} />}
      {dropoffLocation && <DropoffMarker location={dropoffLocation} />}

      {/* Active driver marker */}
      {driverLocation && (
        <DriverMarker
          location={driverLocation}
          heading={driverLocation.heading}
          animate
        />
      )}
    </Map>
  );
}
```

### Efficient Driver Markers

With potentially hundreds of nearby drivers visible, we need marker clustering and efficient updates:

```tsx
function DriverClusterLayer({ drivers }: { drivers: Driver[] }) {
  // Use Mapbox's built-in clustering for efficiency
  const geoJsonData = useMemo(() => ({
    type: 'FeatureCollection',
    features: drivers.map(d => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [d.lng, d.lat]
      },
      properties: {
        id: d.id,
        vehicleType: d.vehicleType
      }
    }))
  }), [drivers]);

  return (
    <Source
      id="drivers"
      type="geojson"
      data={geoJsonData}
      cluster
      clusterMaxZoom={14}
      clusterRadius={50}
    >
      {/* Clustered markers */}
      <Layer
        id="clusters"
        type="circle"
        filter={['has', 'point_count']}
        paint={{
          'circle-color': '#000',
          'circle-radius': ['step', ['get', 'point_count'], 15, 10, 20, 30, 25]
        }}
      />

      {/* Individual driver markers */}
      <Layer
        id="unclustered-drivers"
        type="symbol"
        filter={['!', ['has', 'point_count']]}
        layout={{
          'icon-image': ['get', 'vehicleType'],
          'icon-size': 0.5,
          'icon-rotate': ['get', 'heading']
        }}
      />
    </Source>
  );
}
```

### Smooth Driver Animation

```tsx
function DriverMarker({ location, heading, animate }: DriverMarkerProps) {
  const [displayLocation, setDisplayLocation] = useState(location);
  const prevLocation = useRef(location);

  useEffect(() => {
    if (!animate) {
      setDisplayLocation(location);
      return;
    }

    // Animate between positions over 1 second
    const startTime = Date.now();
    const duration = 1000;
    const startLat = prevLocation.current.lat;
    const startLng = prevLocation.current.lng;
    const deltaLat = location.lat - startLat;
    const deltaLng = location.lng - startLng;

    function step() {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out cubic for natural movement
      const eased = 1 - Math.pow(1 - progress, 3);

      setDisplayLocation({
        lat: startLat + deltaLat * eased,
        lng: startLng + deltaLng * eased
      });

      if (progress < 1) {
        requestAnimationFrame(step);
      }
    }

    requestAnimationFrame(step);
    prevLocation.current = location;
  }, [location, animate]);

  return (
    <Marker
      coordinate={displayLocation}
      rotation={heading}
      anchor={{ x: 0.5, y: 0.5 }}
    >
      <CarIcon style={{ transform: `rotate(${heading}deg)` }} />
    </Marker>
  );
}
```

### Pickup Location Selection

```tsx
function PickupSelector({ onSelect }: { onSelect: (location: PickupLocation) => void }) {
  const [isDragging, setIsDragging] = useState(false);
  const [pinLocation, setPinLocation] = useState<LatLng | null>(null);
  const { reverseGeocode } = useGeocoding();

  const handleMapDrag = useCallback((center: LatLng) => {
    setIsDragging(true);
    setPinLocation(center);
  }, []);

  const handleMapDragEnd = useCallback(async (center: LatLng) => {
    setIsDragging(false);

    // Reverse geocode to get address
    const address = await reverseGeocode(center);

    onSelect({
      ...center,
      address: address.formatted,
      placeId: address.placeId
    });
  }, [onSelect, reverseGeocode]);

  return (
    <div className="relative h-full">
      <RideMap
        onDrag={handleMapDrag}
        onDragEnd={handleMapDragEnd}
      />

      {/* Floating pin in center */}
      <div className={cn(
        "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-full",
        "transition-transform duration-200",
        isDragging && "-translate-y-[calc(100%+8px)]" // Lift pin while dragging
      )}>
        <PickupPinIcon className="w-10 h-14 text-black" />
        {isDragging && (
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-black/20" />
        )}
      </div>
    </div>
  );
}
```

---

## 5. Deep Dive: WebSocket Real-time Layer (6-7 minutes)

### WebSocket Client Implementation

```tsx
class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private heartbeatInterval: number | null = null;
  private messageQueue: Message[] = [];
  private eventHandlers: Map<string, Set<(data: any) => void>> = new Map();

  constructor(private url: string) {}

  connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.url}?token=${token}`);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.flushQueue();
        resolve();
      };

      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      };

      this.ws.onclose = (event) => {
        this.stopHeartbeat();
        if (!event.wasClean) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        reject(new Error('WebSocket connection failed'));
      };
    });
  }

  private handleMessage(message: { type: string; payload: any }) {
    const handlers = this.eventHandlers.get(message.type);
    if (handlers) {
      handlers.forEach(handler => handler(message.payload));
    }
  }

  on(event: string, handler: (data: any) => void) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  send(type: string, payload: any) {
    const message = { type, payload };

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue for later
      this.messageQueue.push(message);
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('connection_failed');
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    setTimeout(() => {
      this.connect(this.getStoredToken());
    }, delay);
  }

  private flushQueue() {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const message = this.messageQueue.shift()!;
      this.ws.send(JSON.stringify(message));
    }
  }
}
```

### WebSocket Event Handlers in Store

```tsx
// In ride store
interface RideState {
  status: RideStatus;
  rideId: string | null;
  driver: DriverInfo | null;
  driverLocation: LatLng | null;
  eta: number | null;
  fare: FareInfo | null;
}

const useRideStore = create<RideState & RideActions>((set, get) => ({
  status: 'idle',
  rideId: null,
  driver: null,
  driverLocation: null,
  eta: null,
  fare: null,

  // Initialize WebSocket listeners
  initializeWebSocket: () => {
    const ws = getWebSocketClient();

    ws.on('ride_matched', (payload) => {
      set({
        status: 'matched',
        rideId: payload.rideId,
        driver: payload.driver,
        eta: payload.eta
      });

      // Trigger notification
      showNotification('Driver on the way!', {
        body: `${payload.driver.name} will arrive in ${payload.eta} minutes`
      });
    });

    ws.on('driver_location', (payload) => {
      set({ driverLocation: payload.location });
    });

    ws.on('driver_arrived', (payload) => {
      set({ status: 'driver_arrived' });
      showNotification('Driver has arrived!', {
        body: 'Your driver is waiting at the pickup location'
      });
    });

    ws.on('ride_started', (payload) => {
      set({ status: 'in_progress' });
    });

    ws.on('ride_completed', (payload) => {
      set({
        status: 'completed',
        fare: payload.fare
      });
    });
  },

  // Cleanup
  disconnectWebSocket: () => {
    getWebSocketClient().disconnect();
  }
}));
```

### Connection Status UI

```tsx
function ConnectionStatus() {
  const [status, setStatus] = useState<'connected' | 'reconnecting' | 'offline'>('connected');
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  useEffect(() => {
    const ws = getWebSocketClient();

    const unsubConnected = ws.on('connected', () => {
      setStatus('connected');
    });

    const unsubReconnecting = ws.on('reconnecting', () => {
      setStatus('reconnecting');
    });

    const unsubOffline = ws.on('connection_failed', () => {
      setStatus('offline');
    });

    // Track last update time
    const unsubAny = ws.on('driver_location', () => {
      setLastUpdate(new Date());
    });

    return () => {
      unsubConnected();
      unsubReconnecting();
      unsubOffline();
      unsubAny();
    };
  }, []);

  if (status === 'connected') return null;

  return (
    <div className={cn(
      "fixed top-0 left-0 right-0 py-2 px-4 text-center text-sm font-medium z-50",
      status === 'reconnecting' && "bg-yellow-500 text-black",
      status === 'offline' && "bg-red-500 text-white"
    )}>
      {status === 'reconnecting' && (
        <>
          <RefreshIcon className="inline-block w-4 h-4 animate-spin mr-2" />
          Reconnecting...
        </>
      )}
      {status === 'offline' && (
        <>
          <WifiOffIcon className="inline-block w-4 h-4 mr-2" />
          Connection lost. Last update: {formatTimeAgo(lastUpdate)}
        </>
      )}
    </div>
  );
}
```

---

## 6. Deep Dive: State Management (5-6 minutes)

### Store Architecture

```tsx
// Auth store - user session
interface AuthState {
  user: User | null;
  userType: 'rider' | 'driver' | null;
  isAuthenticated: boolean;
}

const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      userType: null,
      isAuthenticated: false,

      login: async (credentials: Credentials) => {
        const response = await api.post('/auth/login', credentials);
        set({
          user: response.user,
          userType: response.user.userType,
          isAuthenticated: true
        });
      },

      logout: () => {
        set({ user: null, userType: null, isAuthenticated: false });
      }
    }),
    { name: 'auth-store' }
  )
);

// Location store - GPS and nearby drivers
interface LocationState {
  myLocation: LatLng | null;
  accuracy: number | null;
  nearbyDrivers: Driver[];
  isWatching: boolean;
}

const useLocationStore = create<LocationState>((set, get) => ({
  myLocation: null,
  accuracy: null,
  nearbyDrivers: [],
  isWatching: false,

  startWatching: () => {
    if (get().isWatching) return;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        set({
          myLocation: {
            lat: position.coords.latitude,
            lng: position.coords.longitude
          },
          accuracy: position.coords.accuracy
        });
      },
      (error) => console.error('Geolocation error:', error),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 3000 }
    );

    set({ isWatching: true, watchId });
  },

  stopWatching: () => {
    const { watchId } = get();
    if (watchId) {
      navigator.geolocation.clearWatch(watchId);
      set({ isWatching: false, watchId: null });
    }
  },

  fetchNearbyDrivers: async (location: LatLng) => {
    const drivers = await api.get('/driver/nearby', {
      params: { lat: location.lat, lng: location.lng }
    });
    set({ nearbyDrivers: drivers });
  }
}));

// Ride store - current ride state
interface RideState {
  status: 'idle' | 'estimating' | 'requesting' | 'matching' | 'matched' |
          'driver_arrived' | 'in_progress' | 'completed' | 'cancelled';
  rideId: string | null;
  pickup: Location | null;
  dropoff: Location | null;
  vehicleType: VehicleType | null;
  estimate: FareEstimate | null;
  driver: DriverInfo | null;
  driverLocation: LatLng | null;
  route: Route | null;
}

const useRideStore = create<RideState>((set, get) => ({
  // ... state fields

  setPickup: (location: Location) => {
    set({ pickup: location });
    get().fetchEstimateIfReady();
  },

  setDropoff: (location: Location) => {
    set({ dropoff: location });
    get().fetchEstimateIfReady();
  },

  fetchEstimateIfReady: async () => {
    const { pickup, dropoff } = get();
    if (!pickup || !dropoff) return;

    set({ status: 'estimating' });

    try {
      const estimates = await api.post('/rides/estimate', {
        pickup: { lat: pickup.lat, lng: pickup.lng },
        dropoff: { lat: dropoff.lat, lng: dropoff.lng }
      });
      set({ estimate: estimates, status: 'idle' });
    } catch (error) {
      set({ status: 'idle' });
      toast.error('Failed to get fare estimate');
    }
  },

  requestRide: async () => {
    const { pickup, dropoff, vehicleType } = get();
    if (!pickup || !dropoff || !vehicleType) return;

    set({ status: 'requesting' });

    try {
      const response = await api.post('/rides/request', {
        pickup,
        dropoff,
        vehicleType,
        idempotencyKey: generateIdempotencyKey()
      });

      set({ rideId: response.rideId, status: 'matching' });
    } catch (error) {
      set({ status: 'idle' });
      throw error;
    }
  },

  cancelRide: async () => {
    const { rideId, status } = get();
    if (!rideId || !['matching', 'matched', 'driver_arrived'].includes(status)) return;

    await api.post(`/rides/${rideId}/cancel`);
    set({ status: 'cancelled' });
  },

  reset: () => {
    set({
      status: 'idle',
      rideId: null,
      pickup: null,
      dropoff: null,
      vehicleType: null,
      estimate: null,
      driver: null,
      driverLocation: null,
      route: null
    });
  }
}));
```

### Derived State Selectors

```tsx
// Memoized selectors for computed values
const selectIsRideActive = (state: RideState) =>
  ['matching', 'matched', 'driver_arrived', 'in_progress'].includes(state.status);

const selectCanCancel = (state: RideState) =>
  ['matching', 'matched', 'driver_arrived'].includes(state.status);

const selectEta = (state: RideState) => {
  if (!state.driverLocation || !state.pickup) return null;

  // Simple estimate based on current distance
  const distance = calculateDistance(state.driverLocation, state.pickup);
  return Math.ceil(distance / 0.5); // ~30 km/h city speed
};

// Usage in component
function RideStatusBar() {
  const isActive = useRideStore(selectIsRideActive);
  const canCancel = useRideStore(selectCanCancel);
  const eta = useRideStore(selectEta);

  // Component logic
}
```

---

## 7. Deep Dive: Driver App Specifics (5-6 minutes)

### Location Tracking for Drivers

```tsx
class DriverLocationManager {
  private watchId: number | null = null;
  private lastUpdate: number = 0;
  private updateInterval = 3000; // 3 seconds
  private ws: WebSocketClient;

  constructor(ws: WebSocketClient) {
    this.ws = ws;
  }

  startTracking() {
    // High accuracy for driver tracking
    this.watchId = navigator.geolocation.watchPosition(
      this.handlePositionUpdate.bind(this),
      this.handleError.bind(this),
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 2000
      }
    );
  }

  private handlePositionUpdate(position: GeolocationPosition) {
    const now = Date.now();

    // Throttle updates to every 3 seconds
    if (now - this.lastUpdate < this.updateInterval) return;

    const location = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      heading: position.coords.heading || 0,
      speed: position.coords.speed || 0,
      accuracy: position.coords.accuracy,
      timestamp: now
    };

    // Send via WebSocket
    this.ws.send('location_update', location);

    // Update local store
    useDriverStore.getState().setMyLocation(location);

    this.lastUpdate = now;
  }

  private handleError(error: GeolocationPositionError) {
    console.error('Location error:', error);

    // Show user-friendly message
    if (error.code === error.PERMISSION_DENIED) {
      toast.error('Location permission required to receive rides');
    } else if (error.code === error.POSITION_UNAVAILABLE) {
      toast.error('Unable to get your location. Check GPS settings.');
    }
  }

  stopTracking() {
    if (this.watchId) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}
```

### Ride Offer Component

```tsx
function RideOffer({ offer, onAccept, onDecline }: RideOfferProps) {
  const [timeLeft, setTimeLeft] = useState(15); // 15 second timer
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    timerRef.current = window.setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          onDecline();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Play notification sound
    playRideOfferSound();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [offer.id, onDecline]);

  const handleAccept = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    onAccept();
  };

  return (
    <motion.div
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      className="fixed inset-x-0 bottom-0 bg-white rounded-t-3xl shadow-2xl p-6"
    >
      {/* Timer ring */}
      <div className="absolute -top-12 left-1/2 -translate-x-1/2">
        <CircularProgress
          value={(timeLeft / 15) * 100}
          size={80}
          strokeWidth={4}
          className="text-green-500"
        >
          <span className="text-xl font-bold">{timeLeft}</span>
        </CircularProgress>
      </div>

      {/* Pickup info */}
      <div className="mt-8 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-3 h-3 rounded-full bg-green-500 mt-1.5" />
          <div>
            <p className="font-medium">{offer.pickup.address}</p>
            <p className="text-sm text-gray-500">{offer.eta} min away</p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="w-3 h-3 rounded-full bg-red-500 mt-1.5" />
          <div>
            <p className="font-medium">{offer.dropoff.address}</p>
            <p className="text-sm text-gray-500">{offer.distance} km trip</p>
          </div>
        </div>
      </div>

      {/* Fare estimate */}
      <div className="mt-4 text-center">
        <p className="text-3xl font-bold">
          ${(offer.estimatedFare / 100).toFixed(2)}
        </p>
        {offer.surgeMultiplier > 1 && (
          <p className="text-sm text-orange-500 font-medium">
            {offer.surgeMultiplier}x surge pricing
          </p>
        )}
      </div>

      {/* Action buttons */}
      <div className="mt-6 flex gap-4">
        <button
          onClick={onDecline}
          className="flex-1 py-4 rounded-xl border-2 border-gray-200 text-gray-600 font-semibold"
        >
          Decline
        </button>
        <button
          onClick={handleAccept}
          className="flex-1 py-4 rounded-xl bg-black text-white font-semibold"
        >
          Accept
        </button>
      </div>
    </motion.div>
  );
}
```

### Slide-to-Confirm Actions

```tsx
function SlideToConfirm({ onConfirm, label }: SlideToConfirmProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragX, setDragX] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const threshold = 0.85; // 85% of track width

  const handleDragEnd = () => {
    const trackWidth = trackRef.current?.offsetWidth || 300;
    const progress = dragX / (trackWidth - 56); // 56 = thumb width

    if (progress >= threshold) {
      onConfirm();
    } else {
      // Animate back to start
      setDragX(0);
    }
    setIsDragging(false);
  };

  return (
    <div
      ref={trackRef}
      className="relative h-14 bg-green-500 rounded-full overflow-hidden"
    >
      {/* Track label */}
      <div className="absolute inset-0 flex items-center justify-center text-white font-semibold">
        {label}
      </div>

      {/* Draggable thumb */}
      <motion.div
        drag="x"
        dragConstraints={{ left: 0, right: (trackRef.current?.offsetWidth || 300) - 56 }}
        dragElastic={0}
        onDragStart={() => setIsDragging(true)}
        onDrag={(_, info) => setDragX(info.point.x)}
        onDragEnd={handleDragEnd}
        animate={{ x: isDragging ? undefined : 0 }}
        className="absolute left-1 top-1 w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center cursor-grab active:cursor-grabbing"
      >
        <ChevronRightIcon className="w-6 h-6 text-green-500" />
      </motion.div>
    </div>
  );
}

// Usage
<SlideToConfirm
  label="Slide to start ride"
  onConfirm={() => transitionRide('start')}
/>
```

---

## 8. Performance Optimization (4-5 minutes)

### Bundle Splitting Strategy

```tsx
// Route-based code splitting
const routes = [
  {
    path: '/',
    component: lazy(() => import('./pages/RiderHome'))
  },
  {
    path: '/ride/:id',
    component: lazy(() => import('./pages/ActiveRide'))
  },
  {
    path: '/driver',
    component: lazy(() => import('./pages/DriverDashboard'))
  },
  {
    path: '/driver/earnings',
    component: lazy(() => import('./pages/DriverEarnings'))
  }
];

// Heavy component lazy loading
const MapView = lazy(() => import('./components/MapView'));
const RatingModal = lazy(() => import('./components/RatingModal'));
```

### Map Performance

```tsx
// Debounce nearby driver fetches during map movement
const useDebouncedMapCenter = (center: LatLng, delay = 500) => {
  const [debouncedCenter, setDebouncedCenter] = useState(center);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedCenter(center);
    }, delay);

    return () => clearTimeout(timer);
  }, [center, delay]);

  return debouncedCenter;
};

// Only fetch drivers when map stops moving
function RiderMap() {
  const [mapCenter, setMapCenter] = useState(initialCenter);
  const debouncedCenter = useDebouncedMapCenter(mapCenter, 500);
  const { fetchNearbyDrivers } = useLocationStore();

  useEffect(() => {
    fetchNearbyDrivers(debouncedCenter);
  }, [debouncedCenter]);

  // ...
}
```

### Battery Optimization for Drivers

```tsx
const useAdaptiveLocationAccuracy = () => {
  const [accuracy, setAccuracy] = useState<'high' | 'low'>('high');
  const rideStatus = useDriverStore(state => state.currentRideStatus);

  useEffect(() => {
    // Use high accuracy only during active ride
    if (rideStatus === 'in_progress' || rideStatus === 'navigating_to_pickup') {
      setAccuracy('high');
    } else {
      setAccuracy('low');
    }
  }, [rideStatus]);

  return {
    enableHighAccuracy: accuracy === 'high',
    timeout: accuracy === 'high' ? 5000 : 15000,
    maximumAge: accuracy === 'high' ? 2000 : 10000
  };
};
```

### Memory Management for Long Sessions

```tsx
// Clean up old driver location history to prevent memory leaks
const useDriverLocationBuffer = (maxEntries = 100) => {
  const locationsRef = useRef<LatLng[]>([]);

  const addLocation = useCallback((location: LatLng) => {
    locationsRef.current.push(location);

    // Keep only recent locations
    if (locationsRef.current.length > maxEntries) {
      locationsRef.current = locationsRef.current.slice(-maxEntries);
    }
  }, [maxEntries]);

  return { addLocation, locations: locationsRef.current };
};
```

---

## 9. Accessibility Implementation (3-4 minutes)

### Screen Reader Support

```tsx
function RideStatus({ status, driver, eta }: RideStatusProps) {
  // Announce status changes
  useEffect(() => {
    const message = getStatusAnnouncement(status, driver, eta);
    announceToScreenReader(message);
  }, [status]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Ride status: ${status}`}
    >
      <StatusIcon status={status} aria-hidden="true" />
      <span className="sr-only">{getStatusAnnouncement(status, driver, eta)}</span>
      <p className="text-lg font-semibold">{getStatusText(status)}</p>
      {driver && (
        <p aria-label={`Driver: ${driver.name}, rating ${driver.rating} stars`}>
          {driver.name} - {driver.rating} stars
        </p>
      )}
    </div>
  );
}

function getStatusAnnouncement(status: string, driver: DriverInfo | null, eta: number | null) {
  switch (status) {
    case 'matching':
      return 'Looking for a driver near you';
    case 'matched':
      return `${driver?.name} accepted your ride. Arriving in ${eta} minutes`;
    case 'driver_arrived':
      return `Your driver ${driver?.name} has arrived. Look for a ${driver?.vehicleColor} ${driver?.vehicleModel}`;
    case 'in_progress':
      return 'Your ride is in progress';
    case 'completed':
      return 'You have arrived at your destination';
    default:
      return '';
  }
}
```

### Touch Target Sizes

```tsx
// Minimum 44x44 touch targets for accessibility
const ActionButton = ({ onClick, children, ...props }: ActionButtonProps) => (
  <button
    onClick={onClick}
    className="min-h-[44px] min-w-[44px] px-6 py-3 flex items-center justify-center"
    {...props}
  >
    {children}
  </button>
);

// Map controls with proper sizing
function MapControls() {
  return (
    <div className="absolute right-4 bottom-32 flex flex-col gap-2">
      <button
        aria-label="Zoom in"
        className="w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center"
      >
        <PlusIcon className="w-6 h-6" />
      </button>
      <button
        aria-label="Zoom out"
        className="w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center"
      >
        <MinusIcon className="w-6 h-6" />
      </button>
      <button
        aria-label="Center on my location"
        className="w-12 h-12 bg-white rounded-full shadow-lg flex items-center justify-center"
      >
        <LocateIcon className="w-6 h-6" />
      </button>
    </div>
  );
}
```

### Reduced Motion Support

```tsx
const useReducedMotion = () => {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mediaQuery.matches);

    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return reducedMotion;
};

// Apply to driver marker animation
function DriverMarker({ location }: DriverMarkerProps) {
  const reducedMotion = useReducedMotion();

  return (
    <Marker
      coordinate={location}
      // Skip animation for reduced motion preference
      animate={!reducedMotion}
      animationDuration={reducedMotion ? 0 : 1000}
    >
      <CarIcon />
    </Marker>
  );
}
```

---

## 10. Trade-offs and Alternatives (3-4 minutes)

### Map Library Selection

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Mapbox GL** | Vector tiles, offline, custom styling | Commercial license cost | **Chosen** for flexibility |
| Google Maps | Reliability, familiarity | Per-load pricing | Alternative |
| Apple MapKit | Native iOS performance | iOS only | iOS secondary option |

### State Management

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Zustand** | Simple, lightweight, hooks-based | Less structure | **Chosen** |
| Redux Toolkit | Structured, middleware | Boilerplate | For larger teams |
| Jotai/Recoil | Atomic, fine-grained | Learning curve | Alternative |

### Real-time Communication

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **WebSocket** | Low latency, bidirectional | Connection management | **Chosen** |
| Server-Sent Events | Simpler, auto-reconnect | Unidirectional only | Not sufficient |
| Polling | Simplest implementation | High latency, wasteful | Fallback only |

### Animation Library

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| **Framer Motion** | Declarative, gesture support | Bundle size | **Chosen** for gestures |
| CSS Transitions | No extra bundle | Limited control | Simple animations |
| React Spring | Physics-based | Steeper learning curve | Alternative |

---

## 11. Future Enhancements (2-3 minutes)

### Progressive Web App

```typescript
// Service worker for offline ride state
const rideCache = new Cache('ride-state-v1');

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/rides/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache ride state
          rideCache.put(event.request, response.clone());
          return response;
        })
        .catch(() => rideCache.match(event.request))
    );
  }
});
```

### AR Navigation for Drivers

```typescript
// Future: AR overlay for driver navigation
interface ARNavigationProps {
  route: Route;
  currentLocation: LatLng;
  heading: number;
}

// Would use device camera + gyroscope to overlay turn arrows
```

### Predictive UI

```typescript
// Pre-fetch likely destinations based on user history
const usePredictiveDestinations = () => {
  const { user } = useAuthStore();
  const currentTime = new Date();

  const predictions = useMemo(() => {
    // Morning -> likely going to work
    // Evening -> likely going home
    // Weekend evening -> likely entertainment venues
    return getPredictedDestinations(user.history, currentTime);
  }, [user.history, currentTime.getHours()]);

  return predictions;
};
```

---

## Summary

The key frontend engineering insights for a ride-hailing app:

1. **Map performance is critical**: Use vector tiles, marker clustering, and debounced data fetching to handle potentially hundreds of visible drivers

2. **Smooth animations create trust**: Animate driver markers between positions rather than jumping; users expect real-time feel

3. **WebSocket with fallback**: Auto-reconnect with exponential backoff; queue messages during disconnection; show connection status

4. **State machine for ride lifecycle**: The ride store must handle all state transitions and persist across app restarts

5. **Gesture-driven interactions**: Slide-to-confirm for destructive actions; countdown timers for driver acceptance create urgency

6. **Battery-conscious tracking**: Adaptive location accuracy based on ride state; high accuracy only when actively navigating

The frontend must handle the inherently unreliable nature of mobile networks while providing a smooth, real-time experience that riders and drivers can trust with their safety.
