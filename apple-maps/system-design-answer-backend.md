# Apple Maps - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement (1 minute)

"I'll design Apple Maps from a backend perspective, focusing on the routing engine, traffic data pipeline, and map tile serving. The key challenges are computing optimal routes in under 500ms using graph algorithms with hierarchical preprocessing, aggregating real-time traffic from millions of GPS probes, and serving vector tiles efficiently at global scale.

As a backend engineer, I'll emphasize the graph database design, A* algorithm with Contraction Hierarchies, GPS probe ingestion pipeline, and the observability infrastructure needed to maintain SLIs."

## Requirements Clarification (3 minutes)

### Functional Requirements (Backend Scope)
- **Routing API**: Calculate optimal routes between coordinates with traffic-aware ETA
- **Traffic Pipeline**: Ingest and aggregate GPS probes from millions of devices
- **Map Matching**: Snap GPS coordinates to road network segments
- **Incident Detection**: Detect and propagate traffic incidents in real-time
- **Geocoding**: Convert addresses to coordinates and vice versa
- **POI Search**: Full-text search for points of interest

### Non-Functional Requirements
- **Latency**: < 500ms for route calculation (p95)
- **Throughput**: Process billions of GPS probes per day
- **Accuracy**: ETA within 10% of actual travel time
- **Availability**: 99.9% uptime for routing service

### Scale Estimates
- Road network: ~50 million road segments globally
- GPS probes: 10,000+ per second at peak
- Active navigators: Millions concurrent
- Traffic updates: Every minute per segment

## High-Level Architecture (5 minutes)

```
                              ┌─────────────────────────────────┐
                              │          API Gateway            │
                              │   (Rate Limiting, Auth, CDN)    │
                              └─────────────────────────────────┘
                                             │
            ┌────────────────────────────────┼────────────────────────────────┐
            │                                │                                │
            ▼                                ▼                                ▼
┌──────────────────────┐     ┌──────────────────────────┐     ┌─────────────────────┐
│   Routing Service    │     │    Traffic Service       │     │    Map Service      │
│                      │     │                          │     │                     │
│ - A* with CH         │     │ - GPS probe ingestion    │     │ - Tile generation   │
│ - Traffic-aware ETA  │     │ - Segment aggregation    │     │ - POI search        │
│ - Alternative routes │     │ - Incident detection     │     │ - Geocoding         │
│ - Maneuver gen       │     │ - Historical patterns    │     │ - Reverse geocode   │
└──────────────────────┘     └──────────────────────────┘     └─────────────────────┘
            │                                │                                │
            ▼                                ▼                                ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                    Data Layer                                        │
├────────────────────────┬─────────────────────────┬──────────────────────────────────┤
│ PostgreSQL + PostGIS   │    Redis/Valkey         │          MinIO (S3)              │
│ - road_nodes           │    - Traffic cache      │          - Vector tiles          │
│ - road_segments        │    - Probe dedup        │          - Tile bundles          │
│ - traffic_flow         │    - Session store      │          - Offline packages      │
│ - incidents            │    - Rate limiting      │                                  │
│ - pois                 │                         │                                  │
└────────────────────────┴─────────────────────────┴──────────────────────────────────┘
```

## Deep Dive: Routing Engine (10 minutes)

### Graph Data Model

The road network is represented as a directed graph stored in PostgreSQL with PostGIS:

```sql
-- Graph vertices (intersections and endpoints)
CREATE TABLE road_nodes (
  id BIGSERIAL PRIMARY KEY,
  location GEOGRAPHY(Point, 4326) NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  is_intersection BOOLEAN DEFAULT FALSE
);

-- Graph edges (road segments)
CREATE TABLE road_segments (
  id BIGSERIAL PRIMARY KEY,
  start_node_id BIGINT NOT NULL REFERENCES road_nodes(id),
  end_node_id BIGINT NOT NULL REFERENCES road_nodes(id),
  geometry GEOGRAPHY(LineString, 4326) NOT NULL,
  street_name VARCHAR(200),
  road_class VARCHAR(50),  -- highway, arterial, local
  length_meters DOUBLE PRECISION,
  free_flow_speed_kph INTEGER DEFAULT 50,
  is_toll BOOLEAN DEFAULT FALSE,
  is_one_way BOOLEAN DEFAULT FALSE,
  turn_restrictions JSONB DEFAULT '[]'
);

-- Spatial indexes for efficient queries
CREATE INDEX idx_nodes_location ON road_nodes USING GIST(location);
CREATE INDEX idx_segments_geo ON road_segments USING GIST(geometry);
CREATE INDEX idx_segments_start ON road_segments(start_node_id);
CREATE INDEX idx_segments_end ON road_segments(end_node_id);
```

### A* Algorithm with Traffic-Aware Weights

```typescript
class RoutingEngine {
  private graph: RoadGraph;
  private trafficService: TrafficService;

  async findRoute(
    origin: Coordinate,
    destination: Coordinate,
    options: RouteOptions
  ): Promise<Route> {
    // Get current traffic for bounding box
    const bounds = this.getBoundingBox(origin, destination);
    const trafficData = await this.trafficService.getTraffic(bounds);

    // Apply traffic weights to graph edges
    const weightedGraph = this.applyTrafficWeights(this.graph, trafficData);

    // Find nearest graph nodes to origin/destination
    const startNode = await this.findNearestNode(origin);
    const goalNode = await this.findNearestNode(destination);

    // Run A* with hierarchical shortcuts
    const path = await this.aStarHierarchical(
      startNode,
      goalNode,
      weightedGraph,
      options
    );

    // Generate maneuvers for turn-by-turn
    const maneuvers = this.generateManeuvers(path);

    return {
      path,
      maneuvers,
      distance: this.calculateDistance(path),
      eta: this.calculateETA(path, trafficData),
    };
  }

  private async aStarHierarchical(
    start: Node,
    goal: Node,
    graph: WeightedGraph,
    options: RouteOptions
  ): Promise<Path | null> {
    const openSet = new PriorityQueue<Node>();
    const cameFrom = new Map<Node, { node: Node; edge: Edge }>();
    const gScore = new Map<Node, number>();

    gScore.set(start, 0);
    openSet.enqueue(start, this.heuristic(start, goal));

    while (!openSet.isEmpty()) {
      const current = openSet.dequeue();

      if (current === goal) {
        return this.reconstructPath(cameFrom, current);
      }

      // Get edges including hierarchical shortcuts
      const edges = graph.getEdges(current);

      for (const edge of edges) {
        // Apply user constraints
        if (options.avoidTolls && edge.isToll) continue;
        if (options.avoidHighways && edge.isHighway) continue;

        const tentativeG = gScore.get(current)! + edge.weight;

        if (tentativeG < (gScore.get(edge.target) ?? Infinity)) {
          cameFrom.set(edge.target, { node: current, edge });
          gScore.set(edge.target, tentativeG);
          openSet.enqueue(
            edge.target,
            tentativeG + this.heuristic(edge.target, goal)
          );
        }
      }
    }

    return null; // No route found
  }

  private heuristic(node: Node, goal: Node): number {
    // Haversine distance / max highway speed (admissible heuristic)
    const distance = haversineDistance(
      node.lat, node.lng,
      goal.lat, goal.lng
    );
    const maxSpeed = 130; // km/h (highway speed)
    return (distance / 1000 / maxSpeed) * 60; // minutes
  }

  private applyTrafficWeights(
    graph: RoadGraph,
    trafficData: TrafficData[]
  ): WeightedGraph {
    const weighted = graph.clone();

    for (const traffic of trafficData) {
      const edge = weighted.getEdge(traffic.segmentId);
      if (!edge) continue;

      // Calculate travel time based on current speed
      const freeFlowTime = edge.lengthMeters / (edge.freeFlowSpeed / 3.6);
      const currentTime = edge.lengthMeters / (traffic.speedKph / 3.6);

      edge.weight = currentTime; // seconds
      edge.congestionLevel = traffic.congestionLevel;
    }

    return weighted;
  }
}
```

### Contraction Hierarchies (Preprocessing)

For production-scale routing, we precompute shortcut edges:

```typescript
class ContractionHierarchies {
  // Preprocess graph (offline, takes hours for full map)
  async buildHierarchy(graph: RoadGraph): Promise<HierarchicalGraph> {
    // 1. Order nodes by importance
    const nodeOrder = this.computeNodeOrder(graph);

    // 2. Contract nodes in order
    for (const node of nodeOrder) {
      const shortcuts = this.contractNode(graph, node);

      // Add shortcut edges that preserve shortest paths
      for (const shortcut of shortcuts) {
        graph.addShortcut(shortcut);
      }
    }

    return graph;
  }

  private computeNodeOrder(graph: RoadGraph): Node[] {
    // Heuristic: contract less important nodes first
    // Local roads < collectors < arterials < highways
    return graph.nodes.sort((a, b) => {
      const importanceA = this.nodeImportance(graph, a);
      const importanceB = this.nodeImportance(graph, b);
      return importanceA - importanceB;
    });
  }

  private nodeImportance(graph: RoadGraph, node: Node): number {
    // Factors: edge difference, contracted neighbors, road class
    const edges = graph.getEdges(node);
    const highwayEdges = edges.filter(e => e.roadClass === 'highway');

    return (
      edges.length * 10 +
      highwayEdges.length * 100 // Highways are more important
    );
  }

  private contractNode(graph: RoadGraph, node: Node): Shortcut[] {
    const shortcuts: Shortcut[] = [];
    const incoming = graph.getIncomingEdges(node);
    const outgoing = graph.getOutgoingEdges(node);

    // For each pair of incoming/outgoing edges
    for (const inEdge of incoming) {
      for (const outEdge of outgoing) {
        // Check if shortcut is needed to preserve shortest path
        const directPath = inEdge.weight + outEdge.weight;
        const witnessPath = this.findWitnessPath(
          graph, inEdge.source, outEdge.target, node
        );

        if (!witnessPath || witnessPath > directPath) {
          shortcuts.push({
            source: inEdge.source,
            target: outEdge.target,
            weight: directPath,
            via: node,
          });
        }
      }
    }

    return shortcuts;
  }
}
```

### Alternative Routes with Penalty Method

```typescript
async findAlternatives(
  origin: Coordinate,
  destination: Coordinate,
  primaryRoute: Route
): Promise<Route[]> {
  const alternatives: Route[] = [];

  // Penalize edges in primary route
  const penalizedGraph = this.penalizeEdges(
    this.graph,
    primaryRoute,
    1.5 // 50% penalty
  );

  const alt1 = await this.findRoute(origin, destination, penalizedGraph);

  if (alt1 && this.isDifferentEnough(alt1, primaryRoute)) {
    alternatives.push(alt1);

    // Further penalize for second alternative
    const penalizedGraph2 = this.penalizeEdges(penalizedGraph, alt1, 1.5);
    const alt2 = await this.findRoute(origin, destination, penalizedGraph2);

    if (alt2 && this.isDifferentEnough(alt2, primaryRoute)) {
      alternatives.push(alt2);
    }
  }

  return alternatives;
}

private isDifferentEnough(route1: Route, route2: Route): boolean {
  const overlap = this.calculateOverlap(route1, route2);
  return overlap < 0.7; // At least 30% different
}
```

## Deep Dive: Traffic Service (8 minutes)

### GPS Probe Ingestion Pipeline

```typescript
class TrafficService {
  private segmentFlow = new Map<string, SegmentFlow>();
  private redis: Redis;

  async processGPSProbe(probe: GPSProbe): Promise<void> {
    const { deviceId, latitude, longitude, speed, heading, timestamp } = probe;

    // Idempotency check - deduplicate probes
    const idempotencyKey = `probe:${deviceId}:${timestamp}`;
    const exists = await this.redis.get(idempotencyKey);
    if (exists) {
      return; // Duplicate probe
    }
    await this.redis.setex(idempotencyKey, 3600, '1'); // 1 hour TTL

    // Map-match to road segment
    const segment = await this.mapMatch(latitude, longitude, heading);
    if (!segment) return;

    // Update segment flow with exponential moving average
    const current = this.segmentFlow.get(segment.id) || {
      speed: segment.freeFlowSpeed,
      samples: 0,
    };

    const alpha = 0.1; // Smoothing factor
    const newSpeed = alpha * speed + (1 - alpha) * current.speed;

    this.segmentFlow.set(segment.id, {
      speed: newSpeed,
      samples: current.samples + 1,
      lastUpdate: timestamp,
    });

    // Detect possible incident
    if (speed < segment.freeFlowSpeed * 0.3 && current.samples > 10) {
      await this.detectIncident(segment, probe);
    }

    // Persist to database (batched)
    await this.queueTrafficUpdate(segment.id, newSpeed, timestamp);
  }

  async getTraffic(boundingBox: BoundingBox): Promise<TrafficData[]> {
    const segments = await this.getSegmentsInBounds(boundingBox);

    return segments.map(segment => {
      const flow = this.segmentFlow.get(segment.id);

      if (!flow || this.isStale(flow.lastUpdate)) {
        // Use historical/predicted traffic
        return {
          segmentId: segment.id,
          speed: this.getHistoricalSpeed(segment.id),
          confidence: 'low',
        };
      }

      return {
        segmentId: segment.id,
        speed: flow.speed,
        congestionLevel: this.calculateCongestion(
          flow.speed,
          segment.freeFlowSpeed
        ),
        confidence: flow.samples > 5 ? 'high' : 'medium',
      };
    });
  }

  private calculateCongestion(
    currentSpeed: number,
    freeFlowSpeed: number
  ): CongestionLevel {
    const ratio = currentSpeed / freeFlowSpeed;
    if (ratio > 0.8) return 'free';
    if (ratio > 0.5) return 'light';
    if (ratio > 0.25) return 'moderate';
    return 'heavy';
  }
}
```

### Map Matching Algorithm

```typescript
async mapMatch(
  lat: number,
  lon: number,
  heading: number
): Promise<RoadSegment | null> {
  // Find candidate road segments within 50m
  const candidates = await db.query<RoadSegment[]>(`
    SELECT
      id, start_node_id, end_node_id,
      street_name, free_flow_speed_kph,
      ST_Azimuth(
        ST_StartPoint(geometry::geometry),
        ST_EndPoint(geometry::geometry)
      ) * 180 / PI() as bearing
    FROM road_segments
    WHERE ST_DWithin(
      geometry,
      ST_Point($1, $2)::geography,
      50  -- meters
    )
  `, [lon, lat]);

  if (candidates.length === 0) return null;

  // Score candidates by distance and heading
  let bestScore = Infinity;
  let bestSegment: RoadSegment | null = null;

  for (const segment of candidates) {
    const distance = await this.distanceToSegment(lat, lon, segment);
    const headingDiff = Math.abs(this.normalizeAngle(heading - segment.bearing));

    // Combined score (lower is better)
    const score = distance + headingDiff * 0.5;

    if (score < bestScore) {
      bestScore = score;
      bestSegment = segment;
    }
  }

  return bestSegment;
}

private normalizeAngle(angle: number): number {
  while (angle > 180) angle -= 360;
  while (angle < -180) angle += 360;
  return angle;
}
```

### Incident Detection

```typescript
async detectIncident(segment: RoadSegment, probe: GPSProbe): Promise<void> {
  // Get recent probes on this segment
  const recentProbes = await this.getRecentProbes(segment.id, 5); // 5 minutes

  const slowCount = recentProbes.filter(p =>
    p.speed < segment.freeFlowSpeed * 0.3
  ).length;

  // Multiple slow reports = likely incident
  if (slowCount >= 5) {
    // Check for existing nearby incident to merge
    const existing = await this.findNearbyIncident(
      probe.latitude,
      probe.longitude,
      100 // 100m radius
    );

    if (existing) {
      // Merge: increase confidence
      await db.query(`
        UPDATE incidents
        SET confidence = LEAST(confidence + 0.1, 1.0),
            sample_count = sample_count + 1,
            last_reported_at = NOW()
        WHERE id = $1
      `, [existing.id]);
    } else {
      // Create new incident
      const incident = {
        id: uuid(),
        segmentId: segment.id,
        type: 'congestion',
        severity: slowCount > 10 ? 'high' : 'moderate',
        location: { lat: probe.latitude, lon: probe.longitude },
        reportedAt: Date.now(),
      };

      await db.query(`
        INSERT INTO incidents (id, segment_id, type, severity, location, reported_at)
        VALUES ($1, $2, $3, $4, ST_Point($5, $6)::geography, NOW())
      `, [
        incident.id,
        incident.segmentId,
        incident.type,
        incident.severity,
        probe.longitude,
        probe.latitude,
      ]);

      // Notify routing service to update weights
      await this.publishIncident(incident);
    }
  }
}
```

### Traffic Flow Persistence with UPSERT

```sql
-- Idempotent traffic update (batched writes)
INSERT INTO traffic_flow (segment_id, timestamp, speed_kph, congestion_level, sample_count)
VALUES ($1, date_trunc('minute', $2), $3, $4, 1)
ON CONFLICT (segment_id, date_trunc('minute', timestamp)) DO UPDATE SET
  speed_kph = (traffic_flow.speed_kph * traffic_flow.sample_count + EXCLUDED.speed_kph)
              / (traffic_flow.sample_count + 1),
  sample_count = traffic_flow.sample_count + 1,
  congestion_level = CASE
    WHEN (traffic_flow.speed_kph * traffic_flow.sample_count + EXCLUDED.speed_kph)
         / (traffic_flow.sample_count + 1) > $5 * 0.8 THEN 'free'
    WHEN ... THEN 'light'
    WHEN ... THEN 'moderate'
    ELSE 'heavy'
  END;
```

## Deep Dive: Observability (5 minutes)

### Prometheus Metrics

```typescript
import { Registry, Histogram, Counter, Gauge } from 'prom-client';

const registry = new Registry();

// Route calculation latency
const routingDuration = new Histogram({
  name: 'routing_calculation_duration_seconds',
  help: 'Route calculation time in seconds',
  labelNames: ['route_type', 'status'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
  registers: [registry],
});

// GPS probe ingestion rate
const probesIngested = new Counter({
  name: 'traffic_probes_ingested_total',
  help: 'Total GPS probes processed',
  labelNames: ['status'],
  registers: [registry],
});

// Circuit breaker state
const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=open, 0.5=half-open)',
  labelNames: ['name'],
  registers: [registry],
});

// Usage in routing service
async function handleRouteRequest(req: Request, res: Response) {
  const timer = routingDuration.startTimer();

  try {
    const route = await routingEngine.findRoute(
      req.body.origin,
      req.body.destination,
      req.body.options
    );

    timer({ route_type: 'primary', status: 'success' });
    res.json(route);
  } catch (error) {
    timer({ route_type: 'primary', status: 'error' });
    throw error;
  }
}
```

### Health Checks

```typescript
app.get('/health', async (req, res) => {
  const checks = {
    database: await checkPostgres(),
    cache: await checkRedis(),
    routingGraph: await checkRoutingGraph(),
    trafficData: await checkTrafficFreshness(),
  };

  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
    circuitBreakers: {
      routing_graph_load: circuitBreakers.graphLoad.status,
      geocoding: circuitBreakers.geocoding.status,
    },
  });
});

async function checkRoutingGraph(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const nodeCount = routingEngine.graph.nodeCount();
    if (nodeCount < 100) {
      return { status: 'degraded', message: 'Graph appears incomplete' };
    }
    return { status: 'healthy', nodes: nodeCount, latencyMs: Date.now() - start };
  } catch (error) {
    return { status: 'unhealthy', error: error.message };
  }
}

async function checkTrafficFreshness(): Promise<HealthCheck> {
  const result = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE timestamp > NOW() - INTERVAL '5 minutes') as fresh
    FROM traffic_flow
  `);

  const freshnessRatio = result.rows[0].fresh / result.rows[0].total;

  return {
    status: freshnessRatio > 0.8 ? 'healthy' : 'degraded',
    freshnessRatio: `${Math.round(freshnessRatio * 100)}%`,
  };
}
```

### Circuit Breaker Pattern

```typescript
import CircuitBreaker from 'opossum';

const routingGraphBreaker = new CircuitBreaker(
  async () => routingEngine.loadGraph(),
  {
    timeout: 5000, // 5 second timeout
    errorThresholdPercentage: 50,
    resetTimeout: 30000, // 30 seconds before trying again
  }
);

routingGraphBreaker.on('open', () => {
  logger.warn('Routing graph circuit breaker opened');
  circuitBreakerState.set({ name: 'routing_graph_load' }, 1);
});

routingGraphBreaker.on('close', () => {
  logger.info('Routing graph circuit breaker closed');
  circuitBreakerState.set({ name: 'routing_graph_load' }, 0);
});

routingGraphBreaker.fallback(async () => {
  // Return stale cached graph if available
  return cachedGraph;
});
```

## Trade-offs and Alternatives (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Routing algorithm | Contraction Hierarchies | Plain Dijkstra | 1000x speedup for long routes; preprocessing done offline |
| Traffic source | GPS probe aggregation | Road sensors | Coverage everywhere users drive; no sensor installation |
| Graph storage | PostgreSQL + PostGIS | Neo4j | PostGIS spatial indexes; familiar SQL; simpler ops |
| Traffic consistency | Eventual (EMA) | Strong | High write volume; stale data acceptable for seconds |
| Probe deduplication | Redis with TTL | Database unique constraint | Performance at 10K+ probes/second |
| Map format | Vector tiles | Raster tiles | Smaller downloads; client-side styling; smooth rotation |

## Closing Summary (1 minute)

"The Apple Maps backend is built around three core innovations:

1. **Contraction Hierarchies** - By preprocessing shortcut edges during offline computation, we achieve millisecond route queries instead of seconds. The preprocessing takes hours but is done once when map data updates.

2. **GPS Probe Aggregation** - Traffic data comes from exponential moving average of anonymous GPS probes. The key insight is requiring multiple slow reports before flagging incidents, reducing false positives.

3. **Observability-First Design** - Every routing request is instrumented with Prometheus histograms, circuit breakers protect against cascade failures, and health checks enable automated failover.

The main trade-off is preprocessing time vs. query speed. For a navigation service where route calculation must be sub-second, this investment in offline preprocessing is essential."

## Future Enhancements (Backend)

1. **ML-based ETA Prediction**: Train models on historical trip data for more accurate arrival times
2. **Kafka for Probe Ingestion**: Replace direct database writes with event streaming for higher throughput
3. **ClickHouse for Traffic Analytics**: Columnar storage for traffic pattern analysis
4. **Geographic Sharding**: Partition road graph by H3 cells for horizontal scaling
5. **Hidden Markov Model Map Matching**: More accurate GPS-to-road snapping for sparse or noisy data
