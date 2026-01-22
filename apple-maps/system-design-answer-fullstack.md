# Apple Maps - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Opening Statement (1 minute)

"I'll design Apple Maps as a fullstack system, focusing on the end-to-end flows that connect the React frontend to the routing backend. The key challenges are computing routes in under 500ms, displaying real-time traffic overlays, and providing seamless turn-by-turn navigation with live rerouting.

As a fullstack engineer, I'll emphasize how the frontend search experience triggers geocoding APIs, how route calculations flow from user input to polyline rendering, and how GPS probes from millions of devices aggregate into the traffic overlay displayed on the map."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Search to Navigate**: User searches for destination, sees route options, starts navigation
- **Real-Time Traffic**: Traffic overlay updates every 30 seconds from GPS probes
- **Turn-by-Turn**: Maneuvers displayed with distance countdown and ETA updates
- **Rerouting**: Detect off-route and recalculate path automatically

### Non-Functional Requirements
- **Latency**: < 500ms for route calculation (p95)
- **Freshness**: Traffic data within 1 minute of reality
- **Availability**: 99.9% uptime for routing service
- **Performance**: 60 FPS map interactions on mobile

### User Journeys
1. Search for coffee shop, see on map, get directions
2. Start navigation, see turn-by-turn, ETA updates with traffic
3. Miss a turn, get automatically rerouted
4. See traffic jam ahead, receive alternate route suggestion

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             React Frontend                                   │
│                                                                              │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌────────────────┐  │
│   │  SearchBar  │   │ RoutePanel  │   │  NavPanel   │   │  MapRenderer   │  │
│   │             │   │             │   │             │   │  (MapLibre GL) │  │
│   │  query ─────┼───┼─────────────┼───┼─────────────┼───┼─▶ Vector tiles │  │
│   │             │   │ alternatives│   │ maneuvers   │   │   + Traffic    │  │
│   │  results ◀──┼───┼─────────────┼───┼─────────────┼───┼─▶ Route line   │  │
│   └─────────────┘   └─────────────┘   └─────────────┘   └────────────────┘  │
│                                              │                   ▲          │
│                                              │ GPS position      │          │
│                                              ▼                   │          │
│                        ┌────────────────────────────────────────┐│          │
│                        │           Zustand Stores               ││          │
│                        │  mapStore | routeStore | navStore      │┘          │
│                        └────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────────────┘
                                         │
                          TanStack Query │ (React Query)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API Gateway                                     │
│                    (Rate Limiting, Auth, CDN for tiles)                      │
└─────────────────────────────────────────────────────────────────────────────┘
                    │                     │                    │
                    ▼                     ▼                    ▼
         ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
         │  Routing Service │  │  Traffic Service │  │   Map Service    │
         │                  │  │                  │  │                  │
         │  /api/route      │  │  /api/traffic    │  │  /api/search     │
         │  /api/navigate   │  │  /api/probe      │  │  /api/geocode    │
         └──────────────────┘  └──────────────────┘  └──────────────────┘
                    │                     │                    │
                    └─────────────────────┼────────────────────┘
                                          │
                                          ▼
         ┌─────────────────────────────────────────────────────────────┐
         │                   PostgreSQL + PostGIS                       │
         │       road_nodes | road_segments | traffic_flow | pois      │
         └─────────────────────────────────────────────────────────────┘
```

---

## End-to-End Flow 1: Search to Route (10 minutes)

### Sequence Diagram

```
┌────────┐      ┌───────────┐       ┌─────────┐      ┌─────────┐      ┌──────────┐
│  User  │      │ SearchBar │       │   API   │      │ Routing │      │ Database │
└───┬────┘      └─────┬─────┘       └────┬────┘      └────┬────┘      └────┬─────┘
    │                 │                  │                │                │
    │ Type "coffee"   │                  │                │                │
    │────────────────▶│                  │                │                │
    │                 │                  │                │                │
    │                 │ Debounce 200ms   │                │                │
    │                 │ ────────────────▶│                │                │
    │                 │                  │                │                │
    │                 │ GET /search      │                │                │
    │                 │─────────────────▶│ Full-text      │                │
    │                 │                  │ query ─────────────────────────▶│
    │                 │                  │                │                │
    │                 │                  │◀────────────────────────────────│
    │                 │◀─────────────────│                │                │
    │                 │                  │                │                │
    │ Select result   │                  │                │                │
    │────────────────▶│                  │                │                │
    │                 │                  │                │                │
    │                 │ POST /route      │                │                │
    │                 │─────────────────▶│ findRoute()    │                │
    │                 │                  │───────────────▶│ Get traffic    │
    │                 │                  │                │───────────────▶│
    │                 │                  │                │◀───────────────│
    │                 │                  │                │ A* search      │
    │                 │                  │◀───────────────│                │
    │                 │◀─────────────────│                │                │
    │                 │                  │                │                │
    │ Show routes     │                  │                │                │
    │◀────────────────│                  │                │                │
    │                 │                  │                │                │
```

### Frontend: SearchBar with Debounce

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SearchBar Component                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   State: query (string)                                                     │
│   Hook: useDebounce(query, 200ms) ──▶ debouncedQuery                        │
│                                                                              │
│   TanStack Query:                                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  queryKey: ['places', debouncedQuery]                               │   │
│   │  queryFn: searchPlaces(debouncedQuery)                              │   │
│   │  enabled: debouncedQuery.length >= 2                                │   │
│   │  staleTime: 60000 (1 minute cache)                                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   On select: setDestination({ lat, lng, name })                             │
│                                                                              │
│   UI:                                                                        │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  [Search for a place________________]                               │   │
│   │                                                                     │   │
│   │   Starbucks - 123 Main St           ◀── Click triggers route       │   │
│   │   Blue Bottle Coffee - 456 Oak Ave                                  │   │
│   │   Local Coffee Shop - 789 Elm Blvd                                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Search API with PostGIS

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GET /search Handler                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Input validation (zod):                                                   │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  query: string (2-100 chars)                                        │   │
│   │  lat: number (optional, user location)                              │   │
│   │  lng: number (optional, user location)                              │   │
│   │  limit: number (1-50, default 20)                                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   PostGIS Query:                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  SELECT id, name, category, address, lat, lng, rating,             │   │
│   │         ST_Distance(location, user_point) as distance              │   │
│   │  FROM pois                                                          │   │
│   │  WHERE to_tsvector('english', name) @@                             │   │
│   │        plainto_tsquery('english', $query)                          │   │
│   │  AND ST_DWithin(location, user_point, 50000m)  -- 50km radius      │   │
│   │  ORDER BY distance ASC, ts_rank(...) DESC, rating DESC             │   │
│   │  LIMIT $limit                                                       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Response: { results: [...], count: N }                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Route Request Hook

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           useRouteQuery Hook                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Reads from routeStore: origin, destination, options                       │
│                                                                              │
│   TanStack Query:                                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  queryKey: ['route', origin, destination, options]                  │   │
│   │  queryFn: POST /api/route with body                                │   │
│   │  enabled: origin && destination exist                               │   │
│   │  staleTime: 30000 (30 seconds - traffic changes)                   │   │
│   │  retry: 2                                                           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Body: { origin: {lat, lng}, destination: {lat, lng}, options }            │
│   Options: { avoidTolls, avoidHighways, alternatives: true }                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Route Calculation with Traffic

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           POST /route Handler                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  1. Get bounding box for traffic query                              │   │
│   │     bounds = getBoundingBox(origin, destination)                    │   │
│   │                                                                     │   │
│   │  2. Fetch current traffic data                                      │   │
│   │     trafficData = trafficService.getTraffic(bounds)                │   │
│   │                                                                     │   │
│   │  3. Calculate primary route (A* with traffic weights)              │   │
│   │     primaryRoute = routingEngine.findRoute(                        │   │
│   │       origin, destination, trafficData, options                    │   │
│   │     )                                                               │   │
│   │                                                                     │   │
│   │  4. Calculate alternatives (if requested)                          │   │
│   │     alternatives = routingEngine.findAlternatives(...)             │   │
│   │                                                                     │   │
│   │  5. Generate turn-by-turn maneuvers                                │   │
│   │     maneuvers = routingEngine.generateManeuvers(primaryRoute)      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Response:                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  primaryRoute: {                                                    │   │
│   │    id, polyline (encoded), distance, duration,                     │   │
│   │    trafficDelay, maneuvers[], viaStreet,                           │   │
│   │    hasTolls, hasHighways                                            │   │
│   │  }                                                                  │   │
│   │  alternatives: [{ id, polyline, distance, duration, viaStreet }]   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Route Display on Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           RoutePolyline Component                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Uses: react-map-gl (MapLibre GL wrapper)                                  │
│                                                                              │
│   Data transformation:                                                       │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  polyline (encoded string) ──▶ decodePolyline() ──▶ GeoJSON         │   │
│   │                                                                     │   │
│   │  GeoJSON FeatureCollection:                                         │   │
│   │    { type: "LineString", coordinates: [[lng, lat], ...] }          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Layer stack (back to front):                                              │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Layer 1: Alternative routes (gray, 6px, 50% opacity)              │   │
│   │  Layer 2: Primary route outline (dark blue, 10px, 30% opacity)     │   │
│   │  Layer 3: Primary route line (blue, 6px, 100% opacity)             │   │
│   │  Layer 4: Maneuver markers (turn icons at each instruction)        │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## End-to-End Flow 2: Real-Time Navigation (10 minutes)

### Navigation State Machine

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Navigation Store (Zustand)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   State:                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  isNavigating: boolean                                              │   │
│   │  route: Route | null                                                │   │
│   │  currentManeuverIndex: number                                       │   │
│   │  distanceToManeuver: number (meters)                               │   │
│   │  eta: Date | null                                                   │   │
│   │  progress: number (0-1)                                             │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Actions:                                                                   │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  startNavigation(route)                                             │   │
│   │    Sets initial state, calculates first ETA                        │   │
│   │                                                                     │   │
│   │  updatePosition(position)                                           │   │
│   │    Calculates progress along route                                  │   │
│   │    Updates distanceToManeuver                                       │   │
│   │    Advances maneuverIndex when passed                              │   │
│   │    Triggers reroute if off-route                                   │   │
│   │                                                                     │   │
│   │  stopNavigation()                                                   │   │
│   │    Clears all navigation state                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Route Progress Calculation

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        calculateRouteProgress()                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Input: position {lat, lng}, route, currentManeuverIndex                   │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  1. Find closest point on route                                     │   │
│   │                                                                     │   │
│   │     For each segment [i, i+1] in route.path:                       │   │
│   │       Calculate perpendicular distance to segment                  │   │
│   │       Track minimum distance and closest point                     │   │
│   │                                                                     │   │
│   │  2. Check if off-route (distance > 50 meters)                      │   │
│   │     If yes: return { isOffRoute: true } ──▶ trigger reroute        │   │
│   │                                                                     │   │
│   │  3. Calculate traveled distance                                     │   │
│   │     Sum haversine distances from start to closest segment          │   │
│   │     Add partial segment to closest point                           │   │
│   │                                                                     │   │
│   │  4. Calculate progress                                              │   │
│   │     progress = traveledDistance / route.distance                   │   │
│   │                                                                     │   │
│   │  5. Find current maneuver                                           │   │
│   │     distanceToManeuver = maneuver.distance - traveledDistance      │   │
│   │     If distanceToManeuver <= 0: advance to next maneuver           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Output: { progress, distanceToManeuver, nextManeuverIndex, isOffRoute }   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Position Tracking and Rerouting

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     POST /navigate/position Handler                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Input validation:                                                          │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  sessionId: UUID                                                    │   │
│   │  lat, lng: number                                                   │   │
│   │  heading: 0-360 degrees                                             │   │
│   │  speed: m/s                                                         │   │
│   │  timestamp: epoch ms                                                │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Processing:                                                                │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  1. Get active navigation session                                   │   │
│   │                                                                     │   │
│   │  2. Calculate route progress                                        │   │
│   │                                                                     │   │
│   │  3. If off-route:                                                   │   │
│   │     ├── Calculate new route from current position                  │   │
│   │     ├── Update session with new route                              │   │
│   │     └── Return { action: 'reroute', route: {...} }                 │   │
│   │                                                                     │   │
│   │  4. If on-route:                                                    │   │
│   │     ├── Update ETA based on remaining distance + speed             │   │
│   │     └── Return { action: 'continue', nextManeuver, eta, progress } │   │
│   │                                                                     │   │
│   │  5. Fire-and-forget: Submit GPS probe for traffic aggregation     │   │
│   │     trafficService.processGPSProbe({                               │   │
│   │       deviceId, lat, lng, speed_kph, heading, timestamp            │   │
│   │     })                                                              │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend: Position Update Hook

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       useNavigationTracking Hook                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Uses: navigator.geolocation.watchPosition()                               │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  On position update:                                                │   │
│   │                                                                     │   │
│   │  1. Update local state immediately (responsive UI)                 │   │
│   │     updatePosition({ lat, lng, heading, speed })                   │   │
│   │                                                                     │   │
│   │  2. Send to server (async, don't block UI)                         │   │
│   │     positionMutation.mutate({ sessionId, lat, lng, ... })          │   │
│   │                                                                     │   │
│   │  3. On server response:                                            │   │
│   │     If action === 'reroute':                                       │   │
│   │       setRoute(response.route)  ──▶ update map with new path       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Geolocation options:                                                       │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  enableHighAccuracy: true                                           │   │
│   │  maximumAge: 1000ms (accept positions up to 1s old)                │   │
│   │  timeout: 5000ms                                                    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Cleanup: clearWatch() on unmount or navigation stop                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## End-to-End Flow 3: Traffic Overlay (5 minutes)

### Frontend: Traffic Layer with Polling

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TrafficOverlay Component                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Reads from mapStore: bounds, zoom                                         │
│                                                                              │
│   TanStack Query:                                                            │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  queryKey: ['traffic', bounds]                                      │   │
│   │  queryFn: fetchTraffic(bounds)                                      │   │
│   │  enabled: zoom >= 12 (only show at sufficient zoom)                │   │
│   │  refetchInterval: 30000 (poll every 30 seconds)                    │   │
│   │  staleTime: 15000                                                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Traffic GeoJSON:                                                           │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  FeatureCollection of LineStrings                                  │   │
│   │  properties: { congestion: 'free'|'light'|'moderate'|'heavy' }     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Layer styling:                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  line-color based on congestion:                                   │   │
│   │    free     ──▶ #22c55e (green)                                    │   │
│   │    light    ──▶ #eab308 (yellow)                                   │   │
│   │    moderate ──▶ #f97316 (orange)                                   │   │
│   │    heavy    ──▶ #dc2626 (red)                                      │   │
│   │                                                                     │   │
│   │  line-width based on zoom: 2px at z12, 6px at z16                  │   │
│   │  line-opacity: 0.8                                                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend: Traffic Aggregation from GPS Probes

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TrafficService                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   processGPSProbe(probe):                                                   │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  1. Idempotency check                                               │   │
│   │     key = probe:{deviceId}:{timestamp}                              │   │
│   │     If exists in Redis: return (duplicate)                         │   │
│   │     Else: set with 1-hour TTL                                      │   │
│   │                                                                     │   │
│   │  2. Map-match to road segment                                       │   │
│   │     segment = mapMatch(lat, lng, heading)                          │   │
│   │     Uses PostGIS nearest segment with heading filter               │   │
│   │                                                                     │   │
│   │  3. Update segment flow with EMA (Exponential Moving Average)      │   │
│   │     alpha = 0.1                                                     │   │
│   │     newSpeed = alpha * probe.speed + (1 - alpha) * currentSpeed    │   │
│   │                                                                     │   │
│   │  4. Queue batch persist (every minute)                             │   │
│   │     Write aggregated speeds to traffic_flow table                  │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   getTraffic(bounds):                                                       │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  Query road_segments with latest traffic_flow                      │   │
│   │                                                                     │   │
│   │  Congestion level calculation:                                      │   │
│   │    speed > 80% of free_flow ──▶ 'free'                             │   │
│   │    speed > 50% of free_flow ──▶ 'light'                            │   │
│   │    speed > 25% of free_flow ──▶ 'moderate'                         │   │
│   │    speed <= 25% of free_flow ──▶ 'heavy'                           │   │
│   │                                                                     │   │
│   │  Return segments as GeoJSON with congestion properties             │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs and Alternatives (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Route caching | 30s staleTime | Real-time | Traffic doesn't change that fast; reduces API load |
| Traffic polling | 30s interval | WebSocket | Simpler; sufficient freshness; less connection overhead |
| Position updates | Fire-and-forget | Await response | Don't block UI; server processes async |
| Reroute trigger | 50m off-route | 30m / 100m | Balance between sensitivity and GPS noise |
| Polyline encoding | Google polyline | GeoJSON | 10x smaller payload; standard format |
| Map rendering | MapLibre GL | Leaflet | WebGL for 60 FPS; vector tiles; 3D |

---

## Observability Integration

### Frontend Error Tracking

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Error Boundary                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Wrap navigation components with Sentry.ErrorBoundary                      │
│                                                                              │
│   On error:                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  captureException(error, {                                          │   │
│   │    tags: { feature: 'navigation' }                                  │   │
│   │  })                                                                 │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   Fallback UI: NavigationErrorFallback component                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Backend Metrics

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Prometheus Metrics                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   route_request_duration_seconds (Histogram)                                │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  labels: { status, has_traffic }                                    │   │
│   │  buckets: [0.1, 0.25, 0.5, 1.0, 2.0, 5.0]                          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   traffic_data_freshness_seconds (Gauge)                                    │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  labels: { region }                                                 │   │
│   │  Value: age of oldest traffic data in region                       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Closing Summary (1 minute)

"Apple Maps as a fullstack system connects three key flows:

1. **Search to Route** - User input flows through debounced search to PostGIS full-text queries, then route calculation with A* and traffic-aware weights, returning polylines rendered on the map.

2. **Real-Time Navigation** - GPS positions update local state immediately for responsive UI, while server requests update ETA and detect off-route conditions for rerouting.

3. **Traffic Overlay** - GPS probes from all navigating devices aggregate into traffic flow data via exponential moving average, served to map clients polling every 30 seconds.

The main trade-off is freshness vs. performance. We accept 30-second traffic staleness to reduce API load, and fire-and-forget position updates to keep the navigation UI responsive."

---

## Future Enhancements (Fullstack)

1. **WebSocket for Navigation**: Real-time push for incidents and reroutes
2. **Offline Route Calculation**: Download graph subset to device
3. **Predictive ETA**: ML model incorporating historical patterns
4. **Collaborative Traffic**: Weight probes by device motion sensors
5. **Multi-stop Routing**: Optimize order for multiple destinations
