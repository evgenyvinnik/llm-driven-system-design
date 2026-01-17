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

## Consistency and Idempotency Semantics

### Write Consistency Model

This system uses different consistency levels based on data criticality:

| Data Type | Consistency | Rationale |
|-----------|-------------|-----------|
| Road graph (nodes, segments) | Strong (PostgreSQL transactions) | Infrequent writes, correctness critical |
| Traffic flow | Eventual (last-write-wins) | High write volume, stale data acceptable for seconds |
| Incidents | Eventual with conflict resolution | Multiple sources may report same incident |
| POIs | Strong (PostgreSQL transactions) | User-facing data, consistency matters |
| User saved places | Strong (PostgreSQL transactions) | Must not lose user data |

### Idempotency Implementation

**GPS Probe Ingestion (Idempotent)**:
```javascript
// Each probe has a composite key: deviceId + timestamp
// Duplicate probes are ignored via UPSERT
async function ingestProbe(probe) {
  const idempotencyKey = `${probe.deviceId}:${probe.timestamp}`;

  // Redis check for recent duplicates (24h TTL)
  const exists = await redis.get(`probe:${idempotencyKey}`);
  if (exists) {
    return { status: 'duplicate', processed: false };
  }

  await redis.setex(`probe:${idempotencyKey}`, 86400, '1');
  await processProbe(probe);
  return { status: 'processed', processed: true };
}
```

**Incident Reports (Conflict Resolution)**:
```javascript
// Multiple users may report same incident
// Merge strategy: earliest report wins, aggregate confidence
async function reportIncident(report) {
  const existing = await findNearbyIncident(report.location, 100); // 100m radius

  if (existing) {
    // Merge: increase confidence, update last_seen
    await db.query(`
      UPDATE incidents
      SET confidence = LEAST(confidence + 0.1, 1.0),
          sample_count = sample_count + 1,
          last_reported_at = NOW()
      WHERE id = $1
    `, [existing.id]);
    return { action: 'merged', incidentId: existing.id };
  }

  // New incident with idempotency key
  const idempotencyKey = report.clientRequestId;
  const result = await db.query(`
    INSERT INTO incidents (id, segment_id, location, type, reported_at, idempotency_key)
    VALUES ($1, $2, $3, $4, NOW(), $5)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `, [uuid(), report.segmentId, report.location, report.type, idempotencyKey]);

  return { action: result.rowCount ? 'created' : 'duplicate' };
}
```

### Replay Handling

For queue-based processing (GPS probes, traffic updates):

1. **At-least-once delivery**: RabbitMQ with manual acknowledgment
2. **Deduplication window**: Redis set with 24h TTL for probe IDs
3. **Idempotent writes**: PostgreSQL UPSERT for traffic_flow table

```sql
-- Traffic flow upsert (idempotent)
INSERT INTO traffic_flow (segment_id, timestamp, speed_kph, sample_count)
VALUES ($1, date_trunc('minute', $2), $3, 1)
ON CONFLICT (segment_id, timestamp) DO UPDATE SET
  speed_kph = (traffic_flow.speed_kph * traffic_flow.sample_count + EXCLUDED.speed_kph)
              / (traffic_flow.sample_count + 1),
  sample_count = traffic_flow.sample_count + 1;
```

---

## Observability

### Metrics (Prometheus Format)

**Routing Service Metrics**:
```prometheus
# Route calculation latency
routing_request_duration_seconds{route_type="primary|alternative"}

# Route success/failure
routing_requests_total{status="success|no_route|error"}

# Graph operations
routing_nodes_visited_total
routing_path_length_meters

# Cache effectiveness
tile_cache_hits_total
tile_cache_misses_total
```

**Traffic Service Metrics**:
```prometheus
# Probe ingestion rate
traffic_probes_ingested_total
traffic_probes_duplicates_total

# Aggregation lag
traffic_segment_staleness_seconds{segment_id}

# Incident detection
traffic_incidents_detected_total{type="congestion|accident|road_work"}
traffic_incidents_false_positives_total
```

**Infrastructure Metrics**:
```prometheus
# Database connections
postgres_connections_active
postgres_query_duration_seconds{query_type}

# Queue depth (RabbitMQ)
rabbitmq_queue_messages{queue="gps_probes"}
rabbitmq_consumers_active

# Redis cache
redis_memory_used_bytes
redis_keyspace_hits_total
redis_keyspace_misses_total
```

### Logging Strategy

**Structured Log Format**:
```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "service": "routing",
  "trace_id": "abc123",
  "span_id": "def456",
  "user_id": "anonymized-hash",
  "event": "route_calculated",
  "duration_ms": 145,
  "origin_tile": "12/1234/5678",
  "destination_tile": "12/1235/5679",
  "distance_km": 15.3,
  "traffic_delay_minutes": 5
}
```

**Log Levels by Event**:
| Event | Level | Retention |
|-------|-------|-----------|
| Route calculated | INFO | 7 days |
| Route failed (no path) | WARN | 30 days |
| Database error | ERROR | 90 days |
| Incident detected | INFO | 30 days |
| GPS probe ingested | DEBUG | 1 day |

### Distributed Tracing

**Trace Propagation** (OpenTelemetry):
```javascript
// Example trace for route request
async function handleRouteRequest(req, res) {
  const span = tracer.startSpan('route_request', {
    attributes: {
      'http.method': 'POST',
      'route.origin': hashLocation(req.body.origin),
      'route.destination': hashLocation(req.body.destination)
    }
  });

  try {
    // Child span for traffic fetch
    const trafficSpan = tracer.startSpan('fetch_traffic', { parent: span });
    const traffic = await trafficService.getTraffic(bounds);
    trafficSpan.end();

    // Child span for A* execution
    const routingSpan = tracer.startSpan('astar_routing', { parent: span });
    const route = await routingEngine.findRoute(origin, dest, traffic);
    routingSpan.setAttribute('nodes_visited', route.nodesVisited);
    routingSpan.end();

    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    throw error;
  } finally {
    span.end();
  }
}
```

### SLI Dashboards

**Primary Dashboard Panels**:

1. **Route Latency (p50, p95, p99)**
   - Target: p95 < 500ms, p99 < 1000ms
   - Alert if p95 > 750ms for 5 minutes

2. **Route Success Rate**
   - Target: > 99.5% successful routes
   - Alert if < 99% for 5 minutes

3. **Traffic Data Freshness**
   - Target: 90% of segments updated within 5 minutes
   - Alert if < 80% fresh for 10 minutes

4. **ETA Accuracy**
   - Compare predicted vs actual arrival times
   - Target: 90% within 10% of actual
   - Weekly review (not alertable)

### Alert Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Route p95 latency | > 500ms | > 1000ms | Scale routing workers |
| Route error rate | > 1% | > 5% | Page on-call, check DB |
| Probe ingestion lag | > 1 min | > 5 min | Check RabbitMQ, scale consumers |
| Postgres connections | > 80% | > 95% | Investigate connection leaks |
| Redis memory | > 80% | > 95% | Evict stale keys, add capacity |
| Disk usage (tiles) | > 70% | > 85% | Archive old tiles to S3 |

### Audit Logging

**Auditable Events** (written to separate audit log):
```javascript
const auditLog = {
  // Admin actions
  'map_data.import': { retention: '1 year', pii: false },
  'incident.manual_create': { retention: '1 year', pii: true },
  'incident.manual_resolve': { retention: '1 year', pii: true },
  'poi.create': { retention: '1 year', pii: false },
  'poi.update': { retention: '1 year', pii: false },
  'poi.delete': { retention: '1 year', pii: false },

  // User data access (for compliance)
  'user.saved_places.export': { retention: '2 years', pii: true },
  'user.location_history.access': { retention: '2 years', pii: true }
};

async function audit(event, actor, details) {
  await db.query(`
    INSERT INTO audit_log (event, actor_id, actor_type, details, ip_address, timestamp)
    VALUES ($1, $2, $3, $4, $5, NOW())
  `, [event, actor.id, actor.type, JSON.stringify(details), actor.ip]);
}
```

---

## Failure Handling

### Retry Strategy with Idempotency

**HTTP Client Retries**:
```javascript
const retryConfig = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504]
};

async function fetchWithRetry(url, options, idempotencyKey) {
  let lastError;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          'Idempotency-Key': idempotencyKey,
          'X-Request-Attempt': attempt
        }
      });

      if (response.ok) return response;

      if (!retryConfig.retryableStatusCodes.includes(response.status)) {
        throw new Error(`Non-retryable status: ${response.status}`);
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < retryConfig.maxRetries) {
      const delay = Math.min(
        retryConfig.initialDelayMs * Math.pow(retryConfig.backoffMultiplier, attempt),
        retryConfig.maxDelayMs
      );
      await sleep(delay + Math.random() * 100); // Jitter
    }
  }

  throw lastError;
}
```

**Queue Consumer Retries**:
```javascript
// RabbitMQ dead letter queue for failed messages
const queueConfig = {
  queue: 'gps_probes',
  deadLetterExchange: 'gps_probes_dlx',
  maxRetries: 3,
  retryDelays: [1000, 5000, 30000] // 1s, 5s, 30s
};

async function processWithRetry(message) {
  const retryCount = message.properties.headers['x-retry-count'] || 0;

  try {
    await processProbe(JSON.parse(message.content));
    channel.ack(message);
  } catch (error) {
    if (retryCount >= queueConfig.maxRetries) {
      // Send to dead letter queue for manual inspection
      channel.nack(message, false, false);
      await alertSlack(`Probe processing failed after ${retryCount} retries`);
    } else {
      // Requeue with delay
      channel.nack(message, false, false);
      setTimeout(() => {
        channel.publish('', 'gps_probes', message.content, {
          headers: { 'x-retry-count': retryCount + 1 }
        });
      }, queueConfig.retryDelays[retryCount]);
    }
  }
}
```

### Circuit Breaker Pattern

```javascript
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;

    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 3;
    this.timeout = options.timeout || 30000; // 30s before trying again
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.successCount = 0;
      }
    }
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}

// Usage for external traffic data provider
const externalTrafficBreaker = new CircuitBreaker('external_traffic', {
  failureThreshold: 5,
  timeout: 60000
});

async function getExternalTrafficData(bounds) {
  return externalTrafficBreaker.execute(async () => {
    return await fetch(`https://traffic-provider.com/api/v1/flow?bounds=${bounds}`);
  });
}
```

### Graceful Degradation

```javascript
class RoutingService {
  async findRoute(origin, destination, options) {
    let trafficData;

    // Try real-time traffic, fall back to historical
    try {
      trafficData = await this.trafficBreaker.execute(() =>
        this.trafficService.getTraffic(bounds)
      );
    } catch (error) {
      console.warn('Traffic service unavailable, using historical data');
      trafficData = await this.getHistoricalTraffic(bounds, new Date());
      // Add warning to response
      options.degraded = { traffic: 'historical' };
    }

    // Try primary routing, fall back to simpler algorithm
    try {
      return await this.aStarHierarchical(origin, destination, trafficData);
    } catch (error) {
      if (error.message.includes('timeout')) {
        console.warn('Hierarchical routing timeout, falling back to basic A*');
        options.degraded = { ...options.degraded, routing: 'basic' };
        return await this.basicAStar(origin, destination);
      }
      throw error;
    }
  }
}
```

### Local Development Disaster Recovery

For this learning project, we simulate multi-region patterns locally:

**Backup Strategy**:
```bash
# Automated daily backup (cron job in development)
#!/bin/bash
BACKUP_DIR="./backups/$(date +%Y-%m-%d)"
mkdir -p $BACKUP_DIR

# PostgreSQL backup
pg_dump -h localhost -U maps_user maps_db > "$BACKUP_DIR/maps_db.sql"

# Redis backup (RDB snapshot)
redis-cli BGSAVE
cp /var/lib/redis/dump.rdb "$BACKUP_DIR/redis.rdb"

# Compress and optionally upload to MinIO (S3-compatible)
tar -czf "$BACKUP_DIR.tar.gz" "$BACKUP_DIR"
mc cp "$BACKUP_DIR.tar.gz" minio/backups/

# Retain last 7 days locally
find ./backups -mtime +7 -delete
```

**Restore Testing** (run monthly):
```bash
#!/bin/bash
# Test restore to verify backups are valid

# 1. Start fresh containers
docker-compose -f docker-compose.restore-test.yml up -d

# 2. Restore PostgreSQL
docker exec -i restore_postgres psql -U maps_user maps_db < backups/latest/maps_db.sql

# 3. Restore Redis
docker cp backups/latest/redis.rdb restore_redis:/data/dump.rdb
docker restart restore_redis

# 4. Run smoke tests
npm run test:smoke -- --target=restore

# 5. Cleanup
docker-compose -f docker-compose.restore-test.yml down -v
```

**Simulated Region Failover** (for learning):
```yaml
# docker-compose.multi-region.yml
version: '3.8'
services:
  # Primary region
  routing-primary:
    build: ./backend
    environment:
      - REGION=primary
      - DATABASE_URL=postgres://localhost:5432/maps_primary
    ports:
      - "3001:3000"

  # Secondary region (simulated)
  routing-secondary:
    build: ./backend
    environment:
      - REGION=secondary
      - DATABASE_URL=postgres://localhost:5433/maps_secondary
      - READ_REPLICA=true
    ports:
      - "3002:3000"

  # Load balancer with health checks
  haproxy:
    image: haproxy:latest
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg
    ports:
      - "3000:3000"

# haproxy.cfg includes:
# - Health check every 5s
# - Failover to secondary if primary fails 3 checks
# - Sticky sessions for active navigation
```

### Health Checks

```javascript
// Comprehensive health check endpoint
app.get('/health', async (req, res) => {
  const checks = {
    database: await checkPostgres(),
    redis: await checkRedis(),
    rabbitmq: await checkRabbitMQ(),
    routing_graph: await checkRoutingGraph()
  };

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks
  });
});

async function checkPostgres() {
  const start = Date.now();
  try {
    await db.query('SELECT 1');
    return { status: 'healthy', latency_ms: Date.now() - start };
  } catch (error) {
    return { status: 'unhealthy', error: error.message };
  }
}

async function checkRoutingGraph() {
  // Verify graph is loaded and queryable
  const start = Date.now();
  try {
    const nodeCount = routingEngine.graph.nodeCount();
    if (nodeCount < 100) {
      return { status: 'degraded', message: 'Graph appears incomplete' };
    }
    return { status: 'healthy', nodes: nodeCount, latency_ms: Date.now() - start };
  } catch (error) {
    return { status: 'unhealthy', error: error.message };
  }
}
```

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Routing | Contraction hierarchies | Plain Dijkstra | Speed |
| Traffic | GPS probe aggregation | Sensor only | Coverage, cost |
| Map format | Vector tiles | Raster | Flexibility, size |
| ETA | ML prediction | Simple calculation | Accuracy |
| Traffic consistency | Eventual (last-write-wins) | Strong consistency | High write throughput |
| Probe deduplication | Redis with TTL | Database unique constraint | Performance at scale |
| Circuit breaker timeout | 30 seconds | Shorter/longer | Balance between recovery and availability |
| Backup frequency | Daily | Hourly | Sufficient for learning project, low data change rate |
