# Apple Maps - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design Apple Maps, a navigation platform serving millions of concurrent users with real-time routing and traffic. The key challenges are computing routes fast enough for interactive use, aggregating traffic data from millions of devices, and serving map tiles efficiently at global scale.

The core technical challenges are sub-500ms route calculation using graph algorithms with hierarchical preprocessing, real-time traffic aggregation from GPS probes, and vector tile delivery that works offline."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Route**: Calculate optimal routes between points
- **Navigate**: Turn-by-turn directions with real-time guidance
- **Traffic**: Show real-time traffic conditions
- **Search**: Find places, addresses, and businesses
- **Offline**: Download maps for offline navigation

### Non-Functional Requirements
- **Latency**: < 500ms for route calculation
- **Accuracy**: ETA within 10% of actual travel time
- **Scale**: Millions of concurrent navigators
- **Coverage**: Global map data

### Scale Estimates
- Road network: ~50 million road segments globally
- Active navigators: Millions at peak hours
- GPS probes: Billions of location updates per day
- Map tiles: Petabytes of vector data

## High-Level Architecture (5 minutes)

```
+----------------------------------------------------------+
|                     Client Layer                           |
|         iPhone | CarPlay | Apple Watch | Mac               |
+----------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------+
|                    API Gateway                             |
|            (Auth, Rate Limiting, CDN)                      |
+----------------------------------------------------------+
          |                    |                    |
          v                    v                    v
+------------------+  +------------------+  +------------------+
| Routing Service  |  | Traffic Service  |  |   Map Service    |
|                  |  |                  |  |                  |
| - Pathfinding    |  | - Aggregation    |  | - Tiles          |
| - ETA            |  | - Incidents      |  | - Search         |
| - Alternatives   |  | - Prediction     |  | - Geocoding      |
+------------------+  +------------------+  +------------------+
          |                    |                    |
          v                    v                    v
+----------------------------------------------------------+
|                      Data Layer                            |
|  Graph DB (roads) | Time-series (traffic) | PostgreSQL+S3  |
+----------------------------------------------------------+
```

### Core Components
1. **Routing Service** - Graph-based pathfinding with traffic-aware weights
2. **Traffic Service** - Aggregates GPS probes, detects incidents
3. **Map Service** - Vector tile generation and serving
4. **Navigation Service** - Real-time position tracking and rerouting
5. **Search/Geocoding** - Place search and address resolution

## Deep Dive: Routing Engine (8 minutes)

The routing engine must find optimal paths on a graph with 50+ million edges in under 500ms.

### The Problem with Naive Dijkstra

- 50 million road segments
- Coast-to-coast route might traverse 100,000+ edges
- Plain Dijkstra: O(E log V) = too slow for real-time

### Contraction Hierarchies

The key insight is preprocessing: we precompute "shortcut" edges that allow skipping intermediate nodes.

```
Before: A -- B -- C -- D -- E (5 edges)
After:  A ---- shortcut ---- E (1 edge with pre-computed weight)
```

**Preprocessing (offline, takes hours):**
1. Order nodes by importance (local roads < arterials < highways)
2. Contract least important nodes first
3. Add shortcut edges to preserve shortest paths
4. Result: Hierarchical graph with shortcuts

**Query (online, milliseconds):**
```javascript
async aStarHierarchical(origin, destination, graph, constraints) {
  const openSet = new PriorityQueue()
  const cameFrom = new Map()
  const gScore = new Map()

  const start = this.findNearestNode(origin)
  const goal = this.findNearestNode(destination)

  gScore.set(start, 0)
  openSet.enqueue(start, this.heuristic(start, goal))

  while (!openSet.isEmpty()) {
    const current = openSet.dequeue()

    if (current === goal) {
      return this.reconstructPath(cameFrom, current)
    }

    // Get edges INCLUDING hierarchical shortcuts
    const edges = graph.getEdges(current)

    for (const edge of edges) {
      // Apply user constraints
      if (constraints.avoidTolls && edge.isToll) continue
      if (constraints.avoidHighways && edge.isHighway) continue

      const tentativeG = gScore.get(current) + edge.weight

      if (tentativeG < (gScore.get(edge.target) || Infinity)) {
        cameFrom.set(edge.target, { node: current, edge })
        gScore.set(edge.target, tentativeG)
        openSet.enqueue(edge.target, tentativeG + this.heuristic(edge.target, goal))
      }
    }
  }
  return null  // No route found
}

heuristic(node, goal) {
  // Haversine distance / max highway speed
  const distance = haversine(node.lat, node.lon, goal.lat, goal.lon)
  const maxSpeed = 130  // km/h (highway speed)
  return distance / maxSpeed * 60  // minutes
}
```

### Traffic-Aware Edge Weights

Edge weights aren't static - they change with traffic:

```javascript
applyTrafficWeights(graph, trafficData) {
  for (const segment of trafficData) {
    const edge = graph.getEdge(segment.segmentId)
    if (!edge) continue

    // Calculate travel time based on current speed
    const freeFlowTime = edge.length / edge.freeFlowSpeed
    const currentTime = edge.length / segment.currentSpeed

    // Update edge weight
    edge.weight = currentTime

    // Also store congestion level for display
    edge.congestionLevel = segment.congestionLevel
  }
  return graph
}
```

### Alternative Routes

Users want to see options. We use a penalty method:

```javascript
async findAlternatives(origin, destination, primaryRoute, graph) {
  const alternatives = []

  // Penalize edges in primary route
  const penalizedGraph = this.penalizeEdges(graph, primaryRoute, 1.5)
  const alt1 = await this.aStarHierarchical(origin, destination, penalizedGraph, {})

  if (alt1 && this.isDifferentEnough(alt1, primaryRoute)) {
    alternatives.push(alt1)

    // Further penalize for second alternative
    const penalizedGraph2 = this.penalizeEdges(penalizedGraph, alt1, 1.5)
    const alt2 = await this.aStarHierarchical(origin, destination, penalizedGraph2, {})

    if (alt2 && this.isDifferentEnough(alt2, primaryRoute)) {
      alternatives.push(alt2)
    }
  }

  return alternatives
}

isDifferentEnough(route1, route2) {
  const overlap = this.calculateOverlap(route1, route2)
  return overlap < 0.7  // At least 30% different
}
```

## Deep Dive: Real-Time Traffic (7 minutes)

Traffic data comes from millions of iPhones sending anonymous GPS probes.

### GPS Probe Aggregation

```javascript
class TrafficService {
  constructor() {
    this.segmentFlow = new Map()  // segmentId -> { speed, samples }
  }

  async processGPSProbe(probe) {
    const { latitude, longitude, speed, heading, timestamp } = probe

    // Map-match to road segment
    const segment = await this.mapMatch(latitude, longitude, heading)
    if (!segment) return

    // Update segment flow with exponential moving average
    const current = this.segmentFlow.get(segment.id) || {
      speed: segment.freeFlowSpeed,
      samples: 0
    }

    const alpha = 0.1  // Smoothing factor
    const newSpeed = alpha * speed + (1 - alpha) * current.speed

    this.segmentFlow.set(segment.id, {
      speed: newSpeed,
      samples: current.samples + 1,
      lastUpdate: timestamp
    })

    // Detect possible incident
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
}
```

### Map Matching

Raw GPS has errors. We need to snap points to the road network:

```javascript
async mapMatch(lat, lon, heading) {
  // Find candidate road segments within 50m
  const candidates = await db.query(`
    SELECT * FROM road_segments
    WHERE ST_DWithin(
      geometry,
      ST_Point($1, $2)::geography,
      50  -- meters
    )
  `, [lon, lat])

  // Score candidates by distance and heading
  let bestScore = Infinity
  let bestSegment = null

  for (const segment of candidates.rows) {
    const distance = this.distanceToSegment(lat, lon, segment)
    const headingDiff = Math.abs(this.normalizeAngle(heading - segment.bearing))

    // Combined score (lower is better)
    const score = distance + headingDiff * 0.5

    if (score < bestScore) {
      bestScore = score
      bestSegment = segment
    }
  }

  return bestSegment
}
```

### Incident Detection

```javascript
async detectIncident(segment, probe) {
  // Get recent probes on this segment
  const recentProbes = await this.getRecentProbes(segment.id, 5)  // 5 minutes

  const slowCount = recentProbes.filter(p =>
    p.speed < segment.freeFlowSpeed * 0.3
  ).length

  // Multiple slow reports = likely incident
  if (slowCount >= 5) {
    const incident = {
      id: uuid(),
      segmentId: segment.id,
      type: 'congestion',
      severity: slowCount > 10 ? 'high' : 'moderate',
      location: { lat: probe.latitude, lon: probe.longitude },
      reportedAt: Date.now()
    }

    await this.publishIncident(incident)
    // This updates routing weights and notifies active navigators
  }
}
```

## Deep Dive: Turn-by-Turn Navigation (5 minutes)

### Maneuver Generation

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
            instruction: this.generateInstruction(turnType, nextEdge.streetName),
            distance: cumulativeDistance,
            location: edge.endPoint
          })
          cumulativeDistance = 0
        }
      } else {
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
    const absAngle = Math.abs(angle)
    if (absAngle < 15) return 'straight'
    if (absAngle < 45) return angle > 0 ? 'slight-right' : 'slight-left'
    if (absAngle < 120) return angle > 0 ? 'right' : 'left'
    if (absAngle < 160) return angle > 0 ? 'sharp-right' : 'sharp-left'
    return 'u-turn'
  }
}
```

### Real-Time Position Tracking

```javascript
async trackPosition(userId, position, activeRoute) {
  // Map-match current position
  const matched = await this.mapMatch(position)

  // Check if on route
  const routeProgress = this.calculateRouteProgress(matched, activeRoute)

  if (!routeProgress.onRoute) {
    // Off route - trigger reroute
    const newRoute = await this.routingService.findRoute(
      position,
      activeRoute.destination,
      activeRoute.options
    )
    return { action: 'reroute', newRoute }
  }

  // Get next maneuver
  const nextManeuver = this.getNextManeuver(routeProgress, activeRoute.maneuvers)

  // Update ETA based on current traffic
  const updatedETA = this.updateETA(routeProgress, activeRoute)

  return {
    action: 'continue',
    nextManeuver,
    distanceToNext: routeProgress.distanceToNextManeuver,
    eta: updatedETA,
    currentStreet: matched.streetName
  }
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. Contraction Hierarchies vs Plain Dijkstra

**Chose: Contraction Hierarchies**
- Pro: 1000x+ speedup for long routes
- Pro: Still produces optimal paths
- Con: Preprocessing takes hours (done offline)
- Con: More complex to update for road changes
- Alternative: Plain Dijkstra (simple but too slow for real-time)

### 2. GPS Probe Aggregation vs Sensor-Only Traffic

**Chose: GPS probe aggregation**
- Pro: Coverage everywhere users drive (no sensor installation)
- Pro: Self-updating as road conditions change
- Con: Depends on sufficient probe density
- Con: Privacy considerations
- Alternative: Road sensors (more accurate but expensive, limited coverage)

### 3. Vector Tiles vs Raster Tiles

**Chose: Vector tiles**
- Pro: Smaller download size
- Pro: Client-side styling (dark mode, etc.)
- Pro: Smooth rotation without quality loss
- Con: Requires more client-side processing
- Alternative: Pre-rendered raster tiles (simpler but larger, less flexible)

### Database Schema

```sql
-- Road Segments (graph edges)
CREATE TABLE road_segments (
  id BIGINT PRIMARY KEY,
  start_node_id BIGINT NOT NULL,
  end_node_id BIGINT NOT NULL,
  geometry GEOGRAPHY(LineString) NOT NULL,
  street_name VARCHAR(200),
  road_class VARCHAR(50),  -- highway, arterial, local
  length_meters DECIMAL,
  free_flow_speed_kph INTEGER,
  is_toll BOOLEAN DEFAULT FALSE,
  is_one_way BOOLEAN DEFAULT FALSE
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
  reported_at TIMESTAMP,
  resolved_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE
);
```

## Closing Summary (1 minute)

"Apple Maps is built around three key technical innovations:

1. **Contraction Hierarchies** - Preprocessing creates shortcut edges that allow A* to find optimal routes in milliseconds instead of seconds. The trade-off is preprocessing time, but this is done offline.

2. **GPS Probe Aggregation** - Millions of iPhones provide anonymous speed data that's aggregated into real-time traffic. The key insight is using exponential moving averages and requiring multiple slow reports before flagging incidents.

3. **Vector Tiles** - Rather than pre-rendered images, we send vector data that clients render. This enables smaller downloads, smooth rotation, and style customization.

The main trade-off is preprocessing time vs. query speed. By investing hours in building contraction hierarchies, we achieve millisecond route queries. Similarly, by continuously aggregating GPS probes, we get real-time traffic without deploying physical sensors."
