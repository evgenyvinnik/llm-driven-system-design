# Design Apple Maps - Architecture

## System Overview

Apple Maps is a navigation platform with real-time traffic and routing. Core challenges involve route computation, traffic processing, and map data management.

**Learning Goals:**
- Build graph-based routing algorithms
- Design real-time traffic aggregation
- Implement tile-based map serving
- Handle GPS data at scale

---

## Requirements

### Functional Requirements

1. **Route**: Calculate routes between points
2. **Navigate**: Turn-by-turn directions
3. **Traffic**: Show real-time traffic conditions
4. **Search**: Find places and addresses
5. **Offline**: Download maps for offline use

### Non-Functional Requirements

- **Latency**: < 500ms for route calculation
- **Accuracy**: ETA within 10% of actual
- **Scale**: Millions of concurrent navigators
- **Coverage**: Global map data

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│          iPhone │ CarPlay │ Apple Watch │ Mac                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│               (Auth, Rate Limiting, CDN)                        │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ Routing Service│    │Traffic Service│    │  Map Service  │
│               │    │               │    │               │
│ - Pathfinding │    │ - Aggregation │    │ - Tiles       │
│ - ETA         │    │ - Incidents   │    │ - Search      │
│ - Alternatives│    │ - Prediction  │    │ - Geocoding   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   Graph DB      │   Time-series     │      PostgreSQL + S3      │
│   - Road graph  │   - Traffic flow  │      - POI data           │
│   - Hierarchy   │   - GPS traces    │      - Map tiles          │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Routing Engine

**Graph-Based Pathfinding:**
```javascript
class RoutingEngine {
  constructor(graph) {
    this.graph = graph // Road network graph
    this.trafficService = new TrafficService()
  }

  async findRoute(origin, destination, options = {}) {
    const { avoidTolls, avoidHighways, departureTime } = options

    // Get current traffic conditions
    const trafficData = await this.trafficService.getTraffic(
      this.getBoundingBox(origin, destination)
    )

    // Apply traffic to edge weights
    const weightedGraph = this.applyTrafficWeights(this.graph, trafficData)

    // Run A* with hierarchical decomposition
    const route = await this.aStarHierarchical(
      origin,
      destination,
      weightedGraph,
      { avoidTolls, avoidHighways }
    )

    // Calculate ETA
    const eta = this.calculateETA(route, trafficData, departureTime)

    // Find alternative routes
    const alternatives = await this.findAlternatives(
      origin,
      destination,
      route,
      weightedGraph
    )

    return {
      route,
      eta,
      distance: this.calculateDistance(route),
      alternatives
    }
  }

  async aStarHierarchical(origin, destination, graph, constraints) {
    // Use Contraction Hierarchies for speed
    // Precomputed shortcut edges allow skipping intermediate nodes

    const openSet = new PriorityQueue()
    const cameFrom = new Map()
    const gScore = new Map()
    const fScore = new Map()

    const start = this.findNearestNode(origin)
    const goal = this.findNearestNode(destination)

    gScore.set(start, 0)
    fScore.set(start, this.heuristic(start, goal))
    openSet.enqueue(start, fScore.get(start))

    while (!openSet.isEmpty()) {
      const current = openSet.dequeue()

      if (current === goal) {
        return this.reconstructPath(cameFrom, current)
      }

      // Get edges (including hierarchical shortcuts)
      const edges = graph.getEdges(current)

      for (const edge of edges) {
        // Apply constraints
        if (constraints.avoidTolls && edge.isToll) continue
        if (constraints.avoidHighways && edge.isHighway) continue

        const tentativeG = gScore.get(current) + edge.weight

        if (tentativeG < (gScore.get(edge.target) || Infinity)) {
          cameFrom.set(edge.target, { node: current, edge })
          gScore.set(edge.target, tentativeG)
          fScore.set(edge.target, tentativeG + this.heuristic(edge.target, goal))

          openSet.enqueue(edge.target, fScore.get(edge.target))
        }
      }
    }

    return null // No route found
  }

  async findAlternatives(origin, destination, primaryRoute, graph) {
    // Penalty method: penalize edges in primary route
    const penalizedGraph = this.penalizeEdges(graph, primaryRoute)

    const alt1 = await this.aStarHierarchical(origin, destination, penalizedGraph, {})

    // Further penalize for second alternative
    const penalizedGraph2 = this.penalizeEdges(penalizedGraph, alt1)
    const alt2 = await this.aStarHierarchical(origin, destination, penalizedGraph2, {})

    return [alt1, alt2].filter(r => r && this.isDifferentEnough(r, primaryRoute))
  }
}
```

### 2. Traffic Service

**Real-Time Traffic Aggregation:**
```javascript
class TrafficService {
  constructor() {
    this.segmentFlow = new Map() // segmentId -> { speed, confidence }
    this.incidents = new Map() // location -> incident
  }

  async processGPSProbe(probe) {
    const { deviceId, latitude, longitude, speed, heading, timestamp } = probe

    // Map-match to road segment
    const segment = await this.mapMatch(latitude, longitude, heading)
    if (!segment) return

    // Update segment flow (exponential moving average)
    const current = this.segmentFlow.get(segment.id) || { speed: segment.freeFlowSpeed, samples: 0 }

    const alpha = 0.1 // Smoothing factor
    const newSpeed = alpha * speed + (1 - alpha) * current.speed

    this.segmentFlow.set(segment.id, {
      speed: newSpeed,
      samples: current.samples + 1,
      lastUpdate: timestamp
    })

    // Detect anomalies (possible incident)
    if (speed < segment.freeFlowSpeed * 0.3 && current.samples > 10) {
      await this.detectIncident(segment, probe)
    }
  }

  async getTraffic(boundingBox) {
    const segments = await this.getSegmentsInBounds(boundingBox)

    return segments.map(segment => {
      const flow = this.segmentFlow.get(segment.id)

      if (!flow || this.isStale(flow.lastUpdate)) {
        // Use historical/predicted traffic
        return {
          segmentId: segment.id,
          speed: this.getHistoricalSpeed(segment.id),
          confidence: 'low'
        }
      }

      return {
        segmentId: segment.id,
        speed: flow.speed,
        congestionLevel: this.calculateCongestion(flow.speed, segment.freeFlowSpeed),
        confidence: flow.samples > 5 ? 'high' : 'medium'
      }
    })
  }

  calculateCongestion(currentSpeed, freeFlowSpeed) {
    const ratio = currentSpeed / freeFlowSpeed

    if (ratio > 0.8) return 'free'
    if (ratio > 0.5) return 'light'
    if (ratio > 0.25) return 'moderate'
    return 'heavy'
  }

  async detectIncident(segment, probe) {
    // Aggregate reports from multiple devices
    const recentProbes = await this.getRecentProbes(segment.id, 5) // Last 5 minutes

    const slowCount = recentProbes.filter(p =>
      p.speed < segment.freeFlowSpeed * 0.3
    ).length

    if (slowCount > 5) {
      // Likely incident
      const incident = {
        id: uuid(),
        segmentId: segment.id,
        type: 'congestion',
        severity: 'moderate',
        location: { lat: probe.latitude, lon: probe.longitude },
        reportedAt: Date.now()
      }

      await this.publishIncident(incident)
    }
  }
}
```

### 3. Map Tile Service

**Vector Tile Generation:**
```javascript
class TileService {
  constructor() {
    this.tileCache = new LRUCache({ max: 10000 })
  }

  async getTile(z, x, y, style) {
    const cacheKey = `${z}/${x}/${y}/${style}`

    // Check cache
    const cached = this.tileCache.get(cacheKey)
    if (cached) return cached

    // Generate tile
    const tile = await this.generateTile(z, x, y, style)

    // Cache
    this.tileCache.set(cacheKey, tile)

    return tile
  }

  async generateTile(z, x, y, style) {
    const bounds = this.tileToBounds(z, x, y)

    // Query features in bounds at appropriate zoom
    const features = await this.queryFeatures(bounds, z)

    // Convert to vector tile format (MVT)
    const tile = {
      layers: {}
    }

    // Roads layer
    tile.layers.roads = features
      .filter(f => f.type === 'road')
      .map(f => this.simplify(f, z))

    // Buildings layer (only at high zoom)
    if (z >= 15) {
      tile.layers.buildings = features.filter(f => f.type === 'building')
    }

    // Labels
    tile.layers.labels = this.generateLabels(features, z)

    // POIs
    if (z >= 14) {
      tile.layers.pois = features.filter(f => f.type === 'poi')
    }

    // Encode as protobuf
    return this.encodeAsMVT(tile)
  }

  simplify(feature, zoom) {
    // Douglas-Peucker simplification based on zoom
    const tolerance = 1 / Math.pow(2, zoom)
    return {
      ...feature,
      geometry: simplify(feature.geometry, tolerance)
    }
  }
}
```

### 4. Turn-by-Turn Navigation

**Maneuver Generation:**
```javascript
class NavigationService {
  generateManeuvers(route) {
    const maneuvers = []
    let cumulativeDistance = 0

    for (let i = 0; i < route.edges.length; i++) {
      const edge = route.edges[i]
      const nextEdge = route.edges[i + 1]

      cumulativeDistance += edge.distance

      if (nextEdge) {
        const turnAngle = this.calculateTurnAngle(edge, nextEdge)
        const turnType = this.classifyTurn(turnAngle)

        if (turnType !== 'straight') {
          maneuvers.push({
            type: turnType,
            instruction: this.generateInstruction(edge, nextEdge, turnType),
            distance: cumulativeDistance,
            location: edge.endPoint,
            streetName: nextEdge.streetName
          })

          cumulativeDistance = 0
        }
      } else {
        // Final destination
        maneuvers.push({
          type: 'arrive',
          instruction: 'You have arrived at your destination',
          distance: cumulativeDistance,
          location: edge.endPoint
        })
      }
    }

    return maneuvers
  }

  classifyTurn(angle) {
    // Angle in degrees, positive = right, negative = left
    const absAngle = Math.abs(angle)

    if (absAngle < 15) return 'straight'
    if (absAngle < 45) return angle > 0 ? 'slight-right' : 'slight-left'
    if (absAngle < 120) return angle > 0 ? 'right' : 'left'
    if (absAngle < 160) return angle > 0 ? 'sharp-right' : 'sharp-left'
    return 'u-turn'
  }

  generateInstruction(currentEdge, nextEdge, turnType) {
    const turnPhrase = {
      'slight-right': 'Keep right onto',
      'slight-left': 'Keep left onto',
      'right': 'Turn right onto',
      'left': 'Turn left onto',
      'sharp-right': 'Turn sharp right onto',
      'sharp-left': 'Turn sharp left onto',
      'u-turn': 'Make a U-turn onto'
    }

    return `${turnPhrase[turnType]} ${nextEdge.streetName}`
  }

  // Real-time position tracking
  async trackPosition(userId, position, activeRoute) {
    // Map-match current position
    const matched = await this.mapMatch(position)

    // Check if on route
    const routeProgress = this.calculateRouteProgress(matched, activeRoute)

    if (!routeProgress.onRoute) {
      // Off route - trigger reroute
      return {
        action: 'reroute',
        currentPosition: matched
      }
    }

    // Get next maneuver
    const nextManeuver = this.getNextManeuver(routeProgress, activeRoute.maneuvers)

    // Update ETA based on current progress
    const updatedETA = this.updateETA(routeProgress, activeRoute)

    return {
      action: 'continue',
      nextManeuver,
      distanceToNext: routeProgress.distanceToNextManeuver,
      eta: updatedETA,
      currentStreet: matched.streetName
    }
  }
}
```

---

## Database Schema

```sql
-- Road Segments (graph edges)
CREATE TABLE road_segments (
  id BIGINT PRIMARY KEY,
  start_node_id BIGINT NOT NULL,
  end_node_id BIGINT NOT NULL,
  geometry GEOGRAPHY(LineString) NOT NULL,
  street_name VARCHAR(200),
  road_class VARCHAR(50), -- highway, arterial, local, etc.
  length_meters DECIMAL,
  free_flow_speed_kph INTEGER,
  is_toll BOOLEAN DEFAULT FALSE,
  is_one_way BOOLEAN DEFAULT FALSE,
  turn_restrictions JSONB
);

CREATE INDEX idx_segments_nodes ON road_segments(start_node_id, end_node_id);
CREATE INDEX idx_segments_geo ON road_segments USING GIST(geometry);

-- Road Nodes (graph vertices)
CREATE TABLE road_nodes (
  id BIGINT PRIMARY KEY,
  location GEOGRAPHY(Point) NOT NULL,
  is_intersection BOOLEAN DEFAULT FALSE
);

-- Traffic Flow (time-series)
CREATE TABLE traffic_flow (
  segment_id BIGINT REFERENCES road_segments(id),
  timestamp TIMESTAMP,
  speed_kph DECIMAL,
  sample_count INTEGER,
  PRIMARY KEY (segment_id, timestamp)
);

-- Incidents
CREATE TABLE incidents (
  id UUID PRIMARY KEY,
  segment_id BIGINT REFERENCES road_segments(id),
  type VARCHAR(50),
  severity VARCHAR(20),
  location GEOGRAPHY(Point),
  description TEXT,
  reported_at TIMESTAMP,
  resolved_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE
);

-- Points of Interest
CREATE TABLE pois (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(100),
  location GEOGRAPHY(Point) NOT NULL,
  address JSONB,
  phone VARCHAR(50),
  hours JSONB,
  rating DECIMAL,
  review_count INTEGER
);

CREATE INDEX idx_pois_location ON pois USING GIST(location);
CREATE INDEX idx_pois_category ON pois(category);
```

---

## Key Design Decisions

### 1. Contraction Hierarchies

**Decision**: Precompute hierarchical shortcuts for routing

**Rationale**:
- Orders of magnitude faster routing
- Can still incorporate real-time traffic
- Trade storage for speed

### 2. GPS Probe Aggregation

**Decision**: Aggregate anonymous GPS probes for traffic

**Rationale**:
- Real-time traffic from actual drivers
- Privacy-preserving (aggregated, not individual)
- Self-updating as road conditions change

### 3. Vector Tiles

**Decision**: Serve vector tiles, not raster

**Rationale**:
- Smaller download size
- Client-side styling
- Rotation without quality loss

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Routing | Contraction hierarchies | Plain Dijkstra | Speed |
| Traffic | GPS probe aggregation | Sensor only | Coverage, cost |
| Map format | Vector tiles | Raster | Flexibility, size |
| ETA | ML prediction | Simple calculation | Accuracy |
