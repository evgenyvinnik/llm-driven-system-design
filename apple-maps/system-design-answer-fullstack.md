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
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              React Frontend                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ SearchBar   │  │ RoutePanel  │  │ NavPanel    │  │     MapRenderer         │ │
│  │             │  │             │  │             │  │     (MapLibre GL)       │ │
│  │ query ──────┼──┼─────────────┼──┼─────────────┼──┼───► Vector tiles        │ │
│  │             │  │ alternatives│  │ maneuvers   │  │     + Traffic overlay   │ │
│  │ results ◄───┼──┼─────────────┼──┼─────────────┼──┼───► Route polyline      │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                         │                        ▲              │
│                                         │ GPS position           │              │
│                                         ▼                        │              │
│                        ┌────────────────────────────────────┐    │              │
│                        │        Zustand Stores              │    │              │
│                        │  mapStore | routeStore | navStore  │────┘              │
│                        └────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────────┘
                                         │
                          TanStack Query │ (React Query)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              API Gateway                                         │
│                    (Rate Limiting, Auth, CDN for tiles)                          │
└─────────────────────────────────────────────────────────────────────────────────┘
                    │                     │                    │
                    ▼                     ▼                    ▼
         ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
         │  Routing Service │  │  Traffic Service │  │   Map Service    │
         │                  │  │                  │  │                  │
         │  /api/route      │  │  /api/traffic    │  │  /api/search     │
         │  /api/navigate   │  │  /api/probe      │  │  /api/geocode    │
         └──────────────────┘  └──────────────────┘  └──────────────────┘
                    │                     │                    │
                    ▼                     ▼                    ▼
         ┌─────────────────────────────────────────────────────────────┐
         │                      PostgreSQL + PostGIS                   │
         │  road_nodes | road_segments | traffic_flow | pois           │
         └─────────────────────────────────────────────────────────────┘
```

## End-to-End Flow 1: Search to Route (10 minutes)

### Sequence Diagram

```
User            SearchBar         API           Routing         Database
 │                 │               │               │               │
 │  Type "coffee"  │               │               │               │
 │────────────────►│               │               │               │
 │                 │  Debounce     │               │               │
 │                 │  (200ms)      │               │               │
 │                 │               │               │               │
 │                 │  GET /search  │               │               │
 │                 │──────────────►│               │               │
 │                 │               │  Full-text    │               │
 │                 │               │  query        │               │
 │                 │               │──────────────────────────────►│
 │                 │               │               │               │
 │                 │               │◄──────────────────────────────│
 │                 │◄──────────────│               │               │
 │                 │               │               │               │
 │  Select result  │               │               │               │
 │────────────────►│               │               │               │
 │                 │               │               │               │
 │                 │  POST /route  │               │               │
 │                 │──────────────►│               │               │
 │                 │               │  findRoute()  │               │
 │                 │               │──────────────►│               │
 │                 │               │               │  Get traffic  │
 │                 │               │               │──────────────►│
 │                 │               │               │◄──────────────│
 │                 │               │               │  A* search    │
 │                 │               │◄──────────────│               │
 │                 │◄──────────────│               │               │
 │                 │               │               │               │
 │  Show routes    │               │               │               │
 │◄────────────────│               │               │               │
```

### Frontend: SearchBar with Debounce

```tsx
import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDebounce } from '../hooks/useDebounce';
import { searchPlaces, type Place } from '../api/search';
import { useRouteStore } from '../stores/routeStore';

export function SearchBar() {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 200);
  const { setDestination } = useRouteStore();

  const { data: results, isLoading } = useQuery({
    queryKey: ['places', debouncedQuery],
    queryFn: () => searchPlaces(debouncedQuery),
    enabled: debouncedQuery.length >= 2,
    staleTime: 60000,
  });

  const handleSelect = useCallback((place: Place) => {
    setDestination({
      lat: place.lat,
      lng: place.lng,
      name: place.name,
    });
    setQuery(place.name);
  }, [setDestination]);

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a place"
        className="w-full px-4 py-3 rounded-full border border-gray-300"
      />

      {results && results.length > 0 && (
        <ul className="absolute top-full mt-2 w-full bg-white rounded-lg shadow-lg">
          {results.map((place) => (
            <li key={place.id}>
              <button
                onClick={() => handleSelect(place)}
                className="w-full px-4 py-3 text-left hover:bg-gray-50"
              >
                <div className="font-medium">{place.name}</div>
                <div className="text-sm text-gray-500">{place.address}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

### Backend: Search API with PostGIS

```typescript
// backend/src/map/routes.ts
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../shared/db.js';

const router = Router();

const searchSchema = z.object({
  query: z.string().min(2).max(100),
  lat: z.number().optional(),
  lng: z.number().optional(),
  limit: z.number().min(1).max(50).default(20),
});

router.get('/search', async (req, res) => {
  const params = searchSchema.parse(req.query);

  const result = await pool.query(`
    SELECT
      id,
      name,
      category,
      address,
      lat,
      lng,
      rating,
      ${params.lat && params.lng ? `
        ST_Distance(
          location,
          ST_MakePoint($4, $3)::geography
        ) as distance
      ` : 'NULL as distance'}
    FROM pois
    WHERE to_tsvector('english', name) @@ plainto_tsquery('english', $1)
    ${params.lat && params.lng ? `
      AND ST_DWithin(
        location,
        ST_MakePoint($4, $3)::geography,
        50000  -- 50km radius
      )
    ` : ''}
    ORDER BY
      ${params.lat && params.lng ? 'distance ASC,' : ''}
      ts_rank(to_tsvector('english', name), plainto_tsquery('english', $1)) DESC,
      rating DESC NULLS LAST
    LIMIT $2
  `, [params.query, params.limit, params.lat, params.lng]);

  res.json({
    results: result.rows,
    count: result.rows.length,
  });
});

export default router;
```

### Frontend: Route Request after Selection

```tsx
import { useQuery } from '@tanstack/react-query';
import { useRouteStore } from '../stores/routeStore';
import { fetchRoute } from '../api/routing';

export function useRouteQuery() {
  const { origin, destination, options } = useRouteStore();

  return useQuery({
    queryKey: ['route', origin, destination, options],
    queryFn: async () => {
      const response = await fetch('/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin, destination, options }),
      });

      if (!response.ok) {
        throw new Error('Route calculation failed');
      }

      return response.json();
    },
    enabled: !!origin && !!destination,
    staleTime: 30000, // Cache for 30 seconds
    retry: 2,
  });
}
```

### Backend: Route Calculation with Traffic

```typescript
// backend/src/routing/routes.ts
import { Router } from 'express';
import { z } from 'zod';
import { RoutingEngine } from './engine.js';
import { TrafficService } from '../traffic/service.js';
import { routingDuration } from '../shared/metrics.js';

const router = Router();
const routingEngine = new RoutingEngine();
const trafficService = new TrafficService();

const routeSchema = z.object({
  origin: z.object({ lat: z.number(), lng: z.number() }),
  destination: z.object({ lat: z.number(), lng: z.number() }),
  options: z.object({
    avoidTolls: z.boolean().default(false),
    avoidHighways: z.boolean().default(false),
    alternatives: z.boolean().default(true),
  }).default({}),
});

router.post('/route', async (req, res) => {
  const timer = routingDuration.startTimer();
  const { origin, destination, options } = routeSchema.parse(req.body);

  try {
    // Get bounding box for traffic query
    const bounds = getBoundingBox(origin, destination);

    // Fetch current traffic data
    const trafficData = await trafficService.getTraffic(bounds);

    // Calculate primary route
    const primaryRoute = await routingEngine.findRoute(
      origin,
      destination,
      trafficData,
      options
    );

    if (!primaryRoute) {
      timer({ status: 'no_route' });
      return res.status(404).json({ error: 'No route found' });
    }

    // Calculate alternatives if requested
    let alternatives: Route[] = [];
    if (options.alternatives) {
      alternatives = await routingEngine.findAlternatives(
        origin,
        destination,
        primaryRoute,
        trafficData
      );
    }

    // Generate maneuvers for turn-by-turn
    const maneuvers = routingEngine.generateManeuvers(primaryRoute);

    timer({ status: 'success' });

    res.json({
      primaryRoute: {
        id: primaryRoute.id,
        polyline: encodePolyline(primaryRoute.path),
        distance: primaryRoute.distance,
        duration: primaryRoute.duration,
        trafficDelay: primaryRoute.trafficDelay,
        maneuvers,
        viaStreet: primaryRoute.viaStreet,
        hasTolls: primaryRoute.hasTolls,
        hasHighways: primaryRoute.hasHighways,
      },
      alternatives: alternatives.map(alt => ({
        id: alt.id,
        polyline: encodePolyline(alt.path),
        distance: alt.distance,
        duration: alt.duration,
        trafficDelay: alt.trafficDelay,
        viaStreet: alt.viaStreet,
      })),
    });
  } catch (error) {
    timer({ status: 'error' });
    throw error;
  }
});

export default router;
```

### Frontend: Display Route on Map

```tsx
import { Source, Layer } from 'react-map-gl';
import { useRouteQuery } from '../hooks/useRouteQuery';
import { decodePolyline } from '../utils/polyline';

export function RoutePolyline() {
  const { data: routeData } = useRouteQuery();

  if (!routeData?.primaryRoute) return null;

  const { primaryRoute, alternatives } = routeData;

  // Decode polyline to GeoJSON
  const primaryGeoJSON = {
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: decodePolyline(primaryRoute.polyline),
    },
    properties: { type: 'primary' },
  };

  const alternativeGeoJSON = {
    type: 'FeatureCollection' as const,
    features: alternatives.map((alt: Route) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: decodePolyline(alt.polyline),
      },
      properties: { type: 'alternative', id: alt.id },
    })),
  };

  return (
    <>
      {/* Alternative routes (render first, behind primary) */}
      <Source id="alternatives" type="geojson" data={alternativeGeoJSON}>
        <Layer
          id="alt-route-layer"
          type="line"
          paint={{
            'line-color': '#888888',
            'line-width': 6,
            'line-opacity': 0.5,
          }}
        />
      </Source>

      {/* Primary route */}
      <Source id="primary-route" type="geojson" data={primaryGeoJSON}>
        <Layer
          id="primary-route-outline"
          type="line"
          paint={{
            'line-color': '#1a56db',
            'line-width': 10,
            'line-opacity': 0.3,
          }}
        />
        <Layer
          id="primary-route-layer"
          type="line"
          paint={{
            'line-color': '#3b82f6',
            'line-width': 6,
          }}
        />
      </Source>

      {/* Maneuver markers */}
      <ManeuverMarkers maneuvers={primaryRoute.maneuvers} />
    </>
  );
}
```

## End-to-End Flow 2: Real-Time Navigation (10 minutes)

### Frontend: Navigation State Machine

```tsx
import { create } from 'zustand';
import type { Maneuver, Position, Route } from '../types';

interface NavigationState {
  isNavigating: boolean;
  route: Route | null;
  currentManeuverIndex: number;
  distanceToManeuver: number;
  eta: Date | null;
  progress: number; // 0-1

  // Actions
  startNavigation: (route: Route) => void;
  updatePosition: (position: Position) => void;
  stopNavigation: () => void;
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  isNavigating: false,
  route: null,
  currentManeuverIndex: 0,
  distanceToManeuver: 0,
  eta: null,
  progress: 0,

  startNavigation: (route) => {
    set({
      isNavigating: true,
      route,
      currentManeuverIndex: 0,
      distanceToManeuver: route.maneuvers[0]?.distance || 0,
      eta: new Date(Date.now() + route.duration * 1000),
      progress: 0,
    });
  },

  updatePosition: (position) => {
    const { route, currentManeuverIndex } = get();
    if (!route) return;

    // Calculate progress along route
    const { progress, distanceToManeuver, nextManeuverIndex, isOffRoute } =
      calculateRouteProgress(position, route, currentManeuverIndex);

    if (isOffRoute) {
      // Trigger reroute
      get().triggerReroute(position);
      return;
    }

    // Update ETA based on current progress and traffic
    const remainingDistance = route.distance * (1 - progress);
    const estimatedTime = remainingDistance / (position.speed || 13.9); // m/s

    set({
      progress,
      distanceToManeuver,
      currentManeuverIndex: nextManeuverIndex,
      eta: new Date(Date.now() + estimatedTime * 1000),
    });
  },

  stopNavigation: () => {
    set({
      isNavigating: false,
      route: null,
      currentManeuverIndex: 0,
      progress: 0,
    });
  },
}));

function calculateRouteProgress(
  position: Position,
  route: Route,
  currentIndex: number
): RouteProgress {
  const path = route.path;

  // Find closest point on route
  let minDistance = Infinity;
  let closestSegmentIndex = 0;
  let closestPointOnSegment: [number, number] = [0, 0];

  for (let i = 0; i < path.length - 1; i++) {
    const { distance, point } = pointToSegmentDistance(
      [position.lng, position.lat],
      path[i],
      path[i + 1]
    );

    if (distance < minDistance) {
      minDistance = distance;
      closestSegmentIndex = i;
      closestPointOnSegment = point;
    }
  }

  // Check if off route (> 50 meters from path)
  const isOffRoute = minDistance > 50;

  // Calculate progress
  let traveledDistance = 0;
  for (let i = 0; i < closestSegmentIndex; i++) {
    traveledDistance += haversineDistance(path[i], path[i + 1]);
  }
  traveledDistance += haversineDistance(path[closestSegmentIndex], closestPointOnSegment);

  const progress = traveledDistance / route.distance;

  // Find current maneuver
  let nextManeuverIndex = currentIndex;
  let distanceToManeuver = route.maneuvers[currentIndex].distance - traveledDistance;

  if (distanceToManeuver <= 0 && currentIndex < route.maneuvers.length - 1) {
    nextManeuverIndex = currentIndex + 1;
    distanceToManeuver = route.maneuvers[nextManeuverIndex].distance - traveledDistance;
  }

  return {
    progress,
    distanceToManeuver: Math.max(0, distanceToManeuver),
    nextManeuverIndex,
    isOffRoute,
  };
}
```

### Backend: Position Tracking and Rerouting

```typescript
// backend/src/navigation/routes.ts
import { Router } from 'express';
import { z } from 'zod';
import { RoutingEngine } from '../routing/engine.js';
import { TrafficService } from '../traffic/service.js';

const router = Router();
const routingEngine = new RoutingEngine();
const trafficService = new TrafficService();

const positionSchema = z.object({
  sessionId: z.string().uuid(),
  lat: z.number(),
  lng: z.number(),
  heading: z.number().min(0).max(360),
  speed: z.number().min(0), // m/s
  timestamp: z.number(),
});

router.post('/navigate/position', async (req, res) => {
  const position = positionSchema.parse(req.body);

  // Get active session
  const session = await getNavigationSession(position.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Check if on route
  const routeProgress = calculateRouteProgress(position, session.route);

  if (routeProgress.isOffRoute) {
    // Trigger reroute
    const newRoute = await routingEngine.findRoute(
      { lat: position.lat, lng: position.lng },
      session.destination,
      await trafficService.getTraffic(session.bounds),
      session.options
    );

    // Update session with new route
    await updateNavigationSession(position.sessionId, {
      route: newRoute,
      rerouteCount: session.rerouteCount + 1,
    });

    return res.json({
      action: 'reroute',
      route: {
        polyline: encodePolyline(newRoute.path),
        distance: newRoute.distance,
        duration: newRoute.duration,
        maneuvers: newRoute.maneuvers,
      },
    });
  }

  // Update ETA with current traffic
  const updatedETA = await calculateUpdatedETA(
    routeProgress.remainingPath,
    position.speed
  );

  res.json({
    action: 'continue',
    nextManeuver: session.route.maneuvers[routeProgress.nextManeuverIndex],
    distanceToManeuver: routeProgress.distanceToManeuver,
    eta: updatedETA,
    progress: routeProgress.progress,
  });
});

// Also submit GPS probe for traffic aggregation
router.post('/navigate/position', async (req, res, next) => {
  const position = positionSchema.parse(req.body);

  // Fire-and-forget GPS probe submission
  trafficService.processGPSProbe({
    deviceId: req.headers['x-device-id'] as string,
    latitude: position.lat,
    longitude: position.lng,
    speed: position.speed * 3.6, // Convert m/s to km/h
    heading: position.heading,
    timestamp: position.timestamp,
  }).catch(err => console.error('Probe processing error:', err));

  next();
});

export default router;
```

### Frontend: Position Update Hook

```tsx
import { useEffect, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigationStore } from '../stores/navigationStore';
import { updatePosition as apiUpdatePosition } from '../api/navigation';

export function useNavigationTracking() {
  const { isNavigating, route, updatePosition } = useNavigationStore();

  const positionMutation = useMutation({
    mutationFn: apiUpdatePosition,
    onSuccess: (data) => {
      if (data.action === 'reroute') {
        // Handle reroute from server
        useNavigationStore.getState().setRoute(data.route);
      }
    },
  });

  const handlePosition = useCallback(
    (position: GeolocationPosition) => {
      const { latitude, longitude, heading, speed } = position.coords;

      // Update local state immediately
      updatePosition({
        lat: latitude,
        lng: longitude,
        heading: heading ?? 0,
        speed: speed ?? 0,
        timestamp: position.timestamp,
      });

      // Send to server for ETA updates and GPS probe
      if (isNavigating && route) {
        positionMutation.mutate({
          sessionId: route.sessionId,
          lat: latitude,
          lng: longitude,
          heading: heading ?? 0,
          speed: speed ?? 0,
          timestamp: position.timestamp,
        });
      }
    },
    [isNavigating, route, updatePosition, positionMutation]
  );

  useEffect(() => {
    if (!isNavigating || !navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      handlePosition,
      (error) => console.error('Geolocation error:', error),
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 5000,
      }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [isNavigating, handlePosition]);
}
```

## End-to-End Flow 3: Traffic Overlay (5 minutes)

### Frontend: Traffic Layer with Polling

```tsx
import { useQuery } from '@tanstack/react-query';
import { Source, Layer } from 'react-map-gl';
import { useMapStore } from '../stores/mapStore';
import { fetchTraffic } from '../api/traffic';

export function TrafficOverlay() {
  const { bounds, zoom } = useMapStore();

  // Only fetch traffic at sufficient zoom level
  const shouldFetch = zoom >= 12;

  const { data: trafficData } = useQuery({
    queryKey: ['traffic', bounds],
    queryFn: () => fetchTraffic(bounds),
    enabled: shouldFetch,
    refetchInterval: 30000, // Poll every 30 seconds
    staleTime: 15000,
  });

  if (!shouldFetch || !trafficData) return null;

  const trafficGeoJSON = {
    type: 'FeatureCollection' as const,
    features: trafficData.segments.map(segment => ({
      type: 'Feature' as const,
      geometry: segment.geometry,
      properties: {
        congestion: segment.congestionLevel,
        speed: segment.speed,
      },
    })),
  };

  return (
    <Source id="traffic" type="geojson" data={trafficGeoJSON}>
      <Layer
        id="traffic-layer"
        type="line"
        paint={{
          'line-color': [
            'match',
            ['get', 'congestion'],
            'free', '#22c55e',
            'light', '#eab308',
            'moderate', '#f97316',
            'heavy', '#dc2626',
            '#888888',
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12, 2,
            16, 6,
          ],
          'line-opacity': 0.8,
        }}
      />
    </Source>
  );
}
```

### Backend: Traffic Aggregation from GPS Probes

```typescript
// backend/src/traffic/service.ts
import { pool } from '../shared/db.js';
import { redis } from '../shared/cache.js';

export class TrafficService {
  private segmentFlow = new Map<string, SegmentFlow>();

  async processGPSProbe(probe: GPSProbe): Promise<void> {
    // Idempotency check
    const idempotencyKey = `probe:${probe.deviceId}:${probe.timestamp}`;
    const exists = await redis.get(idempotencyKey);
    if (exists) return;
    await redis.setex(idempotencyKey, 3600, '1');

    // Map-match to road segment
    const segment = await this.mapMatch(probe.latitude, probe.longitude, probe.heading);
    if (!segment) return;

    // Update segment flow with EMA
    const current = this.segmentFlow.get(segment.id) || {
      speed: segment.freeFlowSpeed,
      samples: 0,
    };

    const alpha = 0.1;
    const newSpeed = alpha * probe.speed + (1 - alpha) * current.speed;

    this.segmentFlow.set(segment.id, {
      speed: newSpeed,
      samples: current.samples + 1,
      lastUpdate: probe.timestamp,
    });

    // Batch persist to database (every minute)
    await this.queueTrafficUpdate(segment.id, newSpeed);
  }

  async getTraffic(bounds: BoundingBox): Promise<TrafficData> {
    const result = await pool.query(`
      SELECT
        rs.id as segment_id,
        ST_AsGeoJSON(rs.geometry) as geometry,
        rs.free_flow_speed_kph,
        COALESCE(tf.speed_kph, rs.free_flow_speed_kph) as speed,
        CASE
          WHEN tf.speed_kph > rs.free_flow_speed_kph * 0.8 THEN 'free'
          WHEN tf.speed_kph > rs.free_flow_speed_kph * 0.5 THEN 'light'
          WHEN tf.speed_kph > rs.free_flow_speed_kph * 0.25 THEN 'moderate'
          ELSE 'heavy'
        END as congestion_level,
        tf.timestamp as last_update
      FROM road_segments rs
      LEFT JOIN LATERAL (
        SELECT speed_kph, timestamp
        FROM traffic_flow
        WHERE segment_id = rs.id
        ORDER BY timestamp DESC
        LIMIT 1
      ) tf ON true
      WHERE ST_Intersects(
        rs.geometry,
        ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
      )
    `, [bounds.west, bounds.south, bounds.east, bounds.north]);

    return {
      segments: result.rows.map(row => ({
        segmentId: row.segment_id,
        geometry: JSON.parse(row.geometry),
        speed: row.speed,
        freeFlowSpeed: row.free_flow_speed_kph,
        congestionLevel: row.congestion_level,
        lastUpdate: row.last_update,
      })),
    };
  }
}
```

## Trade-offs and Alternatives (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Route caching | 30s staleTime | Real-time | Traffic doesn't change that fast; reduces API load |
| Traffic polling | 30s interval | WebSocket | Simpler; sufficient freshness; less connection overhead |
| Position updates | Fire-and-forget | Await response | Don't block UI; server processes async |
| Reroute trigger | 50m off-route | 30m / 100m | Balance between sensitivity and GPS noise |
| Polyline encoding | Google polyline | GeoJSON | 10x smaller payload; standard format |
| Map rendering | MapLibre GL | Leaflet | WebGL for 60 FPS; vector tiles; 3D |

## Observability Integration

### Frontend Error Tracking

```tsx
// Error boundary with reporting
import * as Sentry from '@sentry/react';

export function NavigationErrorBoundary({ children }: { children: React.ReactNode }) {
  return (
    <Sentry.ErrorBoundary
      fallback={<NavigationErrorFallback />}
      onError={(error) => {
        Sentry.captureException(error, {
          tags: { feature: 'navigation' },
        });
      }}
    >
      {children}
    </Sentry.ErrorBoundary>
  );
}
```

### Backend Metrics

```typescript
// Prometheus metrics for fullstack correlation
const routeRequestDuration = new Histogram({
  name: 'route_request_duration_seconds',
  help: 'Route calculation time',
  labelNames: ['status', 'has_traffic'],
  buckets: [0.1, 0.25, 0.5, 1.0, 2.0, 5.0],
});

const trafficFreshness = new Gauge({
  name: 'traffic_data_freshness_seconds',
  help: 'Age of traffic data in seconds',
  labelNames: ['region'],
});
```

## Closing Summary (1 minute)

"Apple Maps as a fullstack system connects three key flows:

1. **Search to Route** - User input flows through debounced search to PostGIS full-text queries, then route calculation with A* and traffic-aware weights, returning polylines rendered on the map.

2. **Real-Time Navigation** - GPS positions update local state immediately for responsive UI, while server requests update ETA and detect off-route conditions for rerouting.

3. **Traffic Overlay** - GPS probes from all navigating devices aggregate into traffic flow data via exponential moving average, served to map clients polling every 30 seconds.

The main trade-off is freshness vs. performance. We accept 30-second traffic staleness to reduce API load, and fire-and-forget position updates to keep the navigation UI responsive."

## Future Enhancements (Fullstack)

1. **WebSocket for Navigation**: Real-time push for incidents and reroutes
2. **Offline Route Calculation**: Download graph subset to device
3. **Predictive ETA**: ML model incorporating historical patterns
4. **Collaborative Traffic**: Weight probes by device motion sensors
5. **Multi-stop Routing**: Optimize order for multiple destinations
