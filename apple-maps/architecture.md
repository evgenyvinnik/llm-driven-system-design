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

1. **Route**: Calculate routes between points with turn-by-turn directions
2. **Navigate**: Real-time turn-by-turn navigation with rerouting
3. **Traffic**: Show real-time traffic conditions and incidents
4. **Search**: Find places and addresses with full-text search
5. **Offline**: Download maps for offline use

### Non-Functional Requirements

- **Latency**: p95 < 500ms for route calculation, p99 < 1s
- **Accuracy**: ETA within 10% of actual arrival time
- **Scale**: 10M+ concurrent navigators, 500M daily route requests
- **Availability**: 99.99% uptime (< 4.3 minutes downtime/month)
- **Coverage**: Global map data, 200+ countries
- **Throughput**: 1M+ GPS probe ingestions per second

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
│                    CDN / Edge Network                            │
│         (Map tiles, static assets, geo-distributed)             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                   │
│             (Auth, Rate Limiting, Geo-routing)                  │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Routing Service│    │Traffic Service│    │  Map Service   │
│               │    │               │    │                │
│ - A* / CH     │    │ - Aggregation │    │ - Vector tiles │
│ - ETA         │    │ - Incidents   │    │ - Search       │
│ - Alternatives│    │ - Prediction  │    │ - Geocoding    │
│ - Maneuvers   │    │ - Map-match   │    │ - POIs         │
└───────┬───────┘    └───────┬───────┘    └───────┬────────┘
        │                    │                     │
        ▼                    ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                  │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │   Kafka / Stream  │     Object Storage (S3)   │
│   + PostGIS     │   - GPS probes    │     - Map tiles           │
│   - Road graph  │   - Traffic events│     - Offline packs       │
│   - POI data    │                   │                           │
├─────────────────┼───────────────────┼───────────────────────────┤
│   Redis/Valkey  │   ClickHouse      │     Elasticsearch         │
│   - Tile cache  │   - Traffic hist. │     - POI full-text       │
│   - Sessions    │   - Analytics     │     - Geocoding           │
│   - Rate limits │   - Probe archive │     - Address search      │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Routing Engine

The routing engine uses A* with Contraction Hierarchies (CH) for sub-second route calculation across millions of road segments.

**Algorithm Pipeline:**
1. Snap origin/destination to nearest road nodes using a KNN spatial query on a GIST index
2. Load the road graph into memory (nodes as array indices, edges with time-based weights)
3. Apply real-time traffic weights to edge costs (distance / current_speed)
4. Execute bidirectional A* with hierarchical shortcuts (Contraction Hierarchies)
5. Reconstruct path and generate turn-by-turn maneuvers from bearing changes
6. Calculate ETA using traffic-adjusted edge travel times
7. Find alternatives using edge penalty method (penalize primary route edges by 2x, re-run A*)

**Contraction Hierarchies** precompute shortcut edges that skip intermediate nodes. At query time, the search only expands upward in the hierarchy from both directions, reducing visited nodes from millions to thousands. The trade-off is preprocessing time (hours for a continental graph) and storage (2-3x more edges), but query time drops from seconds to milliseconds.

**Maneuver Generation** classifies turns by computing the bearing difference between consecutive edges: < 15 degrees = straight, 15-45 = slight turn, 45-120 = normal turn, 120-160 = sharp turn, > 160 = U-turn. Each maneuver includes a human-readable instruction referencing the next street name.

**Heuristic**: Haversine distance divided by maximum road speed (130 km/h highway) provides an admissible, consistent heuristic for A*.

### 2. Traffic Service

Processes millions of anonymous GPS probes per second into real-time traffic conditions.

**Probe Ingestion Pipeline:**
1. GPS probes arrive via Kafka (partitioned by geographic region, H3 cell)
2. Map-matching snaps each probe to the nearest road segment using a Hidden Markov Model with Viterbi decoding, considering heading, speed, and road connectivity
3. Probes are aggregated per segment using an exponential moving average (alpha = 0.1) for smoothing
4. Congestion level is derived from the ratio of observed speed to free-flow speed: > 80% = free, 50-80% = light, 25-50% = moderate, < 25% = heavy
5. Anomaly detection triggers incident creation when 5+ probes report < 30% free-flow speed within 5 minutes

**Traffic Freshness**: Segments with no probes in the last 10 minutes fall back to historical speed patterns (day-of-week + hour-of-day averages from ClickHouse). The response includes a `confidence` field: high (> 5 recent samples), medium (1-5 samples), low (historical only).

### 3. Map Tile Service

Serves vector tiles in Mapbox Vector Tile (MVT/protobuf) format.

**Tile generation** follows the standard z/x/y slippy map scheme. Layers are filtered by zoom level: roads always visible, buildings at z >= 15, labels at z >= 12, POIs at z >= 14. Geometry is simplified using the Douglas-Peucker algorithm with tolerance proportional to 1/2^zoom.

**Caching strategy**: Tiles are content-addressed and cached at multiple layers -- CDN edge (7 days, immutable), Redis/Valkey (LRU, 10K tiles), and client-side (persistent cache). Tile invalidation is rare since road geometry changes infrequently; when it does, tile hashes change and CDN serves fresh versions.

### 4. Search and Geocoding

POI search combines full-text search (PostgreSQL GIN index on `to_tsvector('english', name)`) with spatial proximity ranking. Results are scored by a weighted combination of text relevance, distance penalty (km), rating bonus, and popularity (log of review count).

Geocoding (address to coordinates) uses a structured address parser with fallback to full-text search. Reverse geocoding (coordinates to address) uses the nearest POI or road segment within a radius.

---

## Database Schema

### Entity-Relationship Diagram

```
                                ROAD NETWORK GRAPH
    ┌─────────────────────────────────────────────────────────────┐
    │                                                             │
    │   ┌──────────────────┐        ┌──────────────────────┐     │
    │   │   road_nodes     │        │   road_segments      │     │
    │   ├──────────────────┤        ├──────────────────────┤     │
    │   │ PK id (BIGSERIAL)│◄───────┤ FK start_node_id     │     │
    │   │    location      │◄───────┤ FK end_node_id       │     │
    │   │    lat, lng      │        │ PK id (BIGSERIAL)    │     │
    │   │    is_intersection│       │    geometry          │     │
    │   └──────────────────┘        │    street_name       │     │
    │                               │    road_class        │     │
    │                               │    length_meters     │     │
    │                               │    free_flow_speed   │     │
    │                               │    is_toll, is_one_way│    │
    │                               │    turn_restrictions  │     │
    │                               └──────────┬───────────┘     │
    └──────────────────────────────────────────┼─────────────────┘
                                               │
                 ┌─────────────────────────────┼──────────────┐
                 ▼                             ▼              │
    ┌──────────────────────┐      ┌──────────────────────┐    │
    │   traffic_flow       │      │   incidents          │    │
    ├──────────────────────┤      ├──────────────────────┤    │
    │ PK id                │      │ PK id (UUID)         │    │
    │ FK segment_id        │      │ FK segment_id        │    │
    │    timestamp          │      │    type, severity    │    │
    │    speed_kph         │      │    location (geo)    │    │
    │    congestion_level  │      │    lat, lng          │    │
    │    sample_count      │      │    description       │    │
    └──────────────────────┘      │    is_active         │    │
                                  └──────────────────────┘    │
                                                              │
    ┌──────────────────────┐      ┌──────────────────────┐    │
    │   pois               │      │ navigation_sessions  │    │
    ├──────────────────────┤      ├──────────────────────┤    │
    │ PK id (UUID)         │      │ PK id (UUID)         │    │
    │    name              │      │    user_id           │    │
    │    category          │      │    origin/dest lat/lng│   │
    │    location (geo)    │      │    route_data (JSONB) │   │
    │    lat, lng          │      │    status            │    │
    │    address, rating   │      │    started_at        │    │
    │    hours (JSONB)     │      │    completed_at      │    │
    └──────────────────────┘      └──────────────────────┘    │
```

### Table Definitions

```sql
-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Road Nodes (graph vertices)
CREATE TABLE road_nodes (
  id BIGSERIAL PRIMARY KEY,
  location GEOGRAPHY(Point, 4326) NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  is_intersection BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_nodes_location ON road_nodes USING GIST(location);
CREATE INDEX idx_nodes_lat_lng ON road_nodes(lat, lng);

-- Road Segments (graph edges)
CREATE TABLE road_segments (
  id BIGSERIAL PRIMARY KEY,
  start_node_id BIGINT NOT NULL REFERENCES road_nodes(id),
  end_node_id BIGINT NOT NULL REFERENCES road_nodes(id),
  geometry GEOGRAPHY(LineString, 4326) NOT NULL,
  street_name VARCHAR(200),
  road_class VARCHAR(50),
  length_meters DOUBLE PRECISION,
  free_flow_speed_kph INTEGER DEFAULT 50,
  is_toll BOOLEAN DEFAULT FALSE,
  is_one_way BOOLEAN DEFAULT FALSE,
  turn_restrictions JSONB DEFAULT '[]'
);

CREATE INDEX idx_segments_nodes ON road_segments(start_node_id, end_node_id);
CREATE INDEX idx_segments_geo ON road_segments USING GIST(geometry);
CREATE INDEX idx_segments_start ON road_segments(start_node_id);
CREATE INDEX idx_segments_end ON road_segments(end_node_id);

-- Traffic Flow (time-series traffic conditions)
CREATE TABLE traffic_flow (
  id BIGSERIAL PRIMARY KEY,
  segment_id BIGINT REFERENCES road_segments(id),
  timestamp TIMESTAMP DEFAULT NOW(),
  speed_kph DOUBLE PRECISION,
  congestion_level VARCHAR(20),
  sample_count INTEGER DEFAULT 1
);

CREATE INDEX idx_traffic_segment ON traffic_flow(segment_id);
CREATE INDEX idx_traffic_timestamp ON traffic_flow(timestamp);

-- Incidents
CREATE TABLE incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id BIGINT REFERENCES road_segments(id),
  type VARCHAR(50),
  severity VARCHAR(20),
  location GEOGRAPHY(Point, 4326),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  description TEXT,
  reported_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_incidents_location ON incidents USING GIST(location);
CREATE INDEX idx_incidents_active ON incidents(is_active) WHERE is_active = TRUE;

-- Points of Interest
CREATE TABLE pois (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  category VARCHAR(100),
  location GEOGRAPHY(Point, 4326) NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  address TEXT,
  phone VARCHAR(50),
  hours JSONB,
  rating DOUBLE PRECISION,
  review_count INTEGER DEFAULT 0
);

CREATE INDEX idx_pois_location ON pois USING GIST(location);
CREATE INDEX idx_pois_category ON pois(category);
CREATE INDEX idx_pois_name ON pois USING gin(to_tsvector('english', name));

-- Navigation Sessions
CREATE TABLE navigation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(100),
  origin_lat DOUBLE PRECISION,
  origin_lng DOUBLE PRECISION,
  destination_lat DOUBLE PRECISION,
  destination_lng DOUBLE PRECISION,
  route_data JSONB,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  status VARCHAR(20) DEFAULT 'active'
);

CREATE INDEX idx_nav_sessions_user ON navigation_sessions(user_id);
CREATE INDEX idx_nav_sessions_status ON navigation_sessions(status);
```

### Schema Design Rationale

**Dual Coordinate Storage (lat/lng + GEOGRAPHY)**: Both `road_nodes` and `pois` store coordinates twice. The `GEOGRAPHY` column is required for accurate spatial queries (ST_Distance, ST_DWithin) via GIST indexes. The separate `lat`/`lng` columns allow fast bounding-box queries without PostGIS overhead and direct JSON serialization. The ~16 bytes per row trade-off is negligible given read frequency.

**BIGSERIAL for Graph IDs, UUID for User-Facing Entities**: Graph algorithms need dense sequential IDs for array indexing in memory. POIs, incidents, and sessions use UUIDs to prevent sequential enumeration attacks in API responses and support distributed ID generation.

**JSONB for Flexible Data**: `turn_restrictions` (variable per segment), `hours` (highly variable structure), and `route_data` (opaque client payload) all use JSONB because their schemas vary and they are rarely queried directly.

**Partial Index for Active Incidents**: `WHERE is_active = TRUE` keeps the index 10-50x smaller than a full index. Since 99% of queries filter for active incidents, resolved ones are excluded automatically.

**Denormalized congestion_level**: Pre-computed at write time from speed_kph / free_flow_speed to avoid JOINs with road_segments on every traffic query. Adds ~20 bytes per row but saves a JOIN on high-frequency reads.

### Foreign Key Relationships

| Child Table | Column | Parent Table | ON DELETE | Rationale |
|-------------|--------|--------------|-----------|-----------|
| `road_segments` | `start_node_id` | `road_nodes` | NO ACTION | Prevent accidental cascading deletion of road network graph |
| `road_segments` | `end_node_id` | `road_nodes` | NO ACTION | Same -- graph integrity requires explicit cleanup |
| `traffic_flow` | `segment_id` | `road_segments` | NO ACTION | Preserve historical traffic data for analytics |
| `incidents` | `segment_id` | `road_segments` | SET NULL | Incident remains valid at its geographic point even if road geometry changes |

### Data Retention

| Table | Retention | Strategy |
|-------|-----------|----------|
| road_nodes, road_segments | Permanent | Core graph data |
| traffic_flow | 7 days live + 1 year aggregated | Roll up to hourly after 7 days |
| incidents | 90 days active + archive | Move resolved to cold storage |
| navigation_sessions | 30 days | Delete or anonymize |
| pois | Permanent | Soft delete for removed POIs |

### Scalability Patterns

**Time-Based Partitioning for traffic_flow**: Partition by timestamp (monthly) to enable fast time-range queries and efficient retention cleanup. Old partitions can be detached and archived.

**Geographic Sharding for road_nodes/road_segments**: At global scale, partition by H3 or S2 cell. Each region's graph is self-contained for routing within that region; cross-region routes use a coarser inter-region graph.

**Read Replicas for POI Search**: POI data is read-heavy with infrequent writes. Route search queries to read replicas to offload the primary.

---

## API Design

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/routes/calculate` | Calculate route between origin and destination |
| GET | `/api/routes/:id` | Get route details by session ID |
| GET | `/api/search` | Search POIs by name, category, and location |
| GET | `/api/search/geocode` | Convert address to coordinates |
| POST | `/api/traffic/probe` | Submit GPS probe (idempotent) |
| GET | `/api/traffic/flow` | Get traffic conditions for bounding box |
| GET | `/api/traffic/incidents` | Get active incidents in area |
| POST | `/api/traffic/incidents` | Report a traffic incident (idempotent) |
| GET | `/api/map/nodes` | Get road nodes in bounding box |
| GET | `/api/map/segments` | Get road segments in bounding box |
| GET | `/api/map/pois` | Get POIs in bounding box |
| GET | `/health` | Full system health check |
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe |
| GET | `/metrics` | Prometheus metrics endpoint |

---

## Key Design Decisions

### 1. Contraction Hierarchies vs Plain A*

Precomputing hierarchical shortcuts reduces route calculation from O(n log n) to O(k log k) where k << n. A continental graph with 100M nodes can be queried in under 100ms. The trade-off is preprocessing time (2-4 hours for a full rebuild) and 2-3x storage for shortcut edges. Traffic updates are handled by adjusting edge weights at query time rather than rebuilding the hierarchy -- this works because the topology is static; only the weights change.

### 2. GPS Probe Aggregation vs Fixed Sensors

Crowd-sourced GPS probes from millions of devices provide far greater coverage than fixed sensor infrastructure. The trade-off is data quality -- probes from consumer devices have GPS errors of 5-15 meters, requiring map-matching to snap to road segments. We mitigate this with a Hidden Markov Model that considers road connectivity and heading. The aggregate statistics converge to accurate values with as few as 5 probes per segment per minute.

### 3. Vector Tiles vs Raster Tiles

Vector tiles (MVT/protobuf) are 3-5x smaller than raster PNGs, support client-side styling (dark mode, accessibility), and maintain sharpness at any zoom/rotation. The trade-off is client-side rendering complexity -- the client needs a GPU-accelerated renderer. For Apple Maps, this is acceptable since all target platforms (iOS, macOS) have Metal-capable GPUs.

---

## Consistency and Idempotency

### Write Consistency Model

| Data Type | Consistency | Rationale |
|-----------|-------------|-----------|
| Road graph | Strong (PostgreSQL transactions) | Infrequent writes, correctness critical |
| Traffic flow | Eventual (last-write-wins) | High write volume, stale data acceptable for seconds |
| Incidents | Eventual with merge | Multiple sources may report same incident |
| POIs | Strong (PostgreSQL transactions) | User-facing data, consistency matters |
| Navigation sessions | Strong | Must not lose active navigation state |

### Idempotency Implementation

**GPS Probe Ingestion**: Each probe is identified by a composite key of `deviceId + timestamp`. Redis stores a deduplication window with 1-hour TTL. Duplicate probes return the cached result without reprocessing. The PostgreSQL UPSERT aggregates duplicate probes by averaging speeds weighted by sample count.

**Incident Reports**: Multiple users may report the same incident. Reports within 100m radius of an existing active incident are merged by incrementing the confidence score and sample count. New incidents use a client-provided `idempotencyKey` with a PostgreSQL `ON CONFLICT DO NOTHING` to prevent duplicates.

### Replay Handling

For queue-based processing (GPS probes via Kafka):
1. **At-least-once delivery** with manual offset commits
2. **Deduplication window** in Redis (24h TTL) for probe IDs
3. **Idempotent writes** via PostgreSQL UPSERT for traffic_flow

---

## Observability

### Metrics (Prometheus)

**Routing Metrics:**
- `routing_calculation_duration_seconds` -- histogram with buckets 50ms to 5s, labels by route_type and status
- `routing_requests_total` -- counter with success/no_route/error status
- `routing_nodes_visited_total` -- gauge for algorithm efficiency tracking

**Traffic Metrics:**
- `traffic_probes_ingested_total` -- counter, regional breakdown
- `traffic_probes_duplicates_total` -- counter for dedup monitoring
- `traffic_incidents_detected_total` -- counter by type

**Infrastructure Metrics:**
- `http_request_duration_seconds` -- histogram by method, route, status_code
- `cache_hits_total` / `cache_misses_total` -- counter by cache_name
- `circuit_breaker_state` -- gauge (0=closed, 1=open, 2=half-open)

### Alert Thresholds

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Route p95 latency | > 500ms | > 1000ms | Scale routing workers |
| Route error rate | > 1% | > 5% | Page on-call, check DB |
| Probe ingestion lag | > 1 min | > 5 min | Check Kafka, scale consumers |
| Postgres connections | > 80% | > 95% | Investigate connection leaks |
| Redis memory | > 80% | > 95% | Evict stale keys, add capacity |

### Structured Logging

JSON-formatted logs with consistent fields: `timestamp`, `level`, `service`, `requestId`, `event`. Request middleware attaches a correlation ID for tracing across log entries. Sensitive data (cookies, auth headers) is automatically redacted. Development uses pretty-printing; production emits raw JSON for log aggregators.

### Health Checks

Three-tier health check system:
- **`GET /health/live`** -- liveness probe, returns 200 if process is running
- **`GET /health/ready`** -- readiness probe, checks PostgreSQL and Redis connectivity
- **`GET /health`** -- full check including routing graph loaded, traffic freshness, circuit breaker states

---

## Failure Handling

### Circuit Breaker Pattern

Separate circuit breakers isolate failures across dependencies:
- **Routing Graph Load**: protects against database overload during graph queries, fallback returns cached stale graph
- **Geocoding**: isolates geocoding failures from routing, 5s timeout
- **Nearest Node**: separate breaker for expensive spatial queries

State machine: CLOSED --(5 failures)--> OPEN --(30s timeout)--> HALF-OPEN --(3 successes)--> CLOSED. A single failure in HALF-OPEN returns to OPEN.

### Graceful Degradation

When the traffic service is unavailable, the routing engine falls back to historical traffic patterns (day-of-week + hour averages from ClickHouse). The response includes a `degraded: { traffic: "historical" }` field so the client can display a warning. When hierarchical routing times out, it falls back to basic A* which is slower but more reliable.

### Retry Strategy

HTTP retries use exponential backoff (100ms base, 2x multiplier, 5s max) with jitter. Only 5xx and 408/429 status codes are retried. All retryable operations include idempotency keys to ensure safe replay. Queue consumer retries use a dead-letter queue after 3 failed attempts.

### Graceful Shutdown

On SIGTERM/SIGINT: stop accepting new requests, wait for in-flight requests to complete (max 10s timeout), close database pool, disconnect Redis, then exit.

---

## Scalability Considerations

### What Breaks First

1. **Route calculation CPU** -- A* is CPU-bound. Horizontal scaling by adding routing worker instances behind a load balancer. Each instance loads the graph into memory independently.
2. **Traffic flow write volume** -- At 1M probes/second, a single PostgreSQL becomes a bottleneck. Solution: Kafka for buffering, geographic partitioning (H3 cells), and ClickHouse for historical analytics.
3. **Tile serving bandwidth** -- Vector tiles at global scale require a CDN with edge caching. Origin servers handle cache misses only.
4. **POI search latency** -- Full-text search with spatial filtering is expensive. Solution: Elasticsearch cluster with geographic sharding, read replicas for PostgreSQL fallback.

### Horizontal Scaling Path

- **Routing**: Stateless workers, each loads full graph into memory (~4GB for a country). Shard by geographic region for global scale.
- **Traffic**: Kafka partitions by H3 cell, consumers process in parallel. ClickHouse for historical roll-ups.
- **Tiles**: CDN absorbs 99%+ of reads. Origin is a stateless tile renderer reading from PostGIS.
- **Search**: Elasticsearch cluster with index sharding by region.

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Routing algorithm | Contraction Hierarchies | Plain Dijkstra/A* | Orders-of-magnitude faster queries; worth preprocessing cost |
| Traffic source | GPS probe aggregation | Fixed sensors | Coverage at scale, self-updating |
| Map format | Vector tiles (MVT) | Raster tiles (PNG) | 3-5x smaller, client-side styling, rotation-safe |
| ETA prediction | ML model + historical patterns | Simple distance/speed | 10% accuracy target requires traffic prediction |
| Traffic consistency | Eventual (last-write-wins) | Strong | High write throughput, seconds of staleness acceptable |
| Probe deduplication | Redis with TTL | Database unique constraint | Sub-ms check at ingestion rate of 1M/s |
| Graph ID type | BIGSERIAL | UUID | Array indexing in memory, sequential inserts |
| Spatial queries | PostGIS GEOGRAPHY | Application-level Haversine | Accurate distance on spheroid, GIST index support |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + Express + React.

### Local Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  React Frontend (:5173)                       │
│     MapView (Leaflet) + SearchBar + RoutePanel + Controls   │
│     State: Zustand (mapStore)                                │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP (fetch)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│              Express Backend (:3000)                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐ │
│  │ /api/    │  │ /api/     │  │ /api/    │  │ /api/map/ │ │
│  │ routes/* │  │ traffic/* │  │ search/* │  │ nodes,    │ │
│  │          │  │           │  │          │  │ segments, │ │
│  │          │  │           │  │          │  │ pois      │ │
│  └──────────┘  └───────────┘  └──────────┘  └───────────┘ │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Shared: logger, metrics, circuitBreaker,            │  │
│  │          idempotency, rateLimit, health               │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────┬─────────────────────────┬────────────────────────┘
           │                         │
           ▼                         ▼
┌────────────────────┐    ┌────────────────────┐
│  PostGIS (:5432)   │    │  Valkey (:6379)     │
│  postgis/postgis   │    │  valkey/valkey      │
│  DB: apple_maps    │    │  Cache, rate limits, │
│  User: maps        │    │  idempotency keys   │
└────────────────────┘    └────────────────────┘
```

### Production Patterns Actually Implemented

| Pattern | File | Why It Matters at Scale |
|---------|------|------------------------|
| Structured logging (Pino) | `backend/src/shared/logger.ts` | JSON logs enable ELK/Splunk ingestion; request correlation IDs trace issues across services |
| Prometheus metrics | `backend/src/shared/metrics.ts` | RED method (Rate/Errors/Duration) with histograms for p95/p99 latency tracking; `/metrics` endpoint for scraping |
| Circuit breakers (Opossum) | `backend/src/shared/circuitBreaker.ts` | Separate breakers for routing graph load, geocoding, nearest-node queries; prevents cascading failures |
| Idempotency | `backend/src/shared/idempotency.ts` | Redis-based dedup for GPS probes and incident reports; safe retries with cached responses |
| Rate limiting | `backend/src/shared/rateLimit.ts` | Per-endpoint limits: routing 30/min, search 60/min, traffic 120/min, GPS probes 600/min |
| Health checks | `backend/src/routes/health.ts` | Three-tier: `/health/live` (liveness), `/health/ready` (readiness with DB/Redis check), `/health` (full with graph and traffic freshness) |
| Graceful shutdown | `backend/src/index.ts` | SIGTERM/SIGINT handling: stop traffic simulation, drain connections, close pool |
| A* routing | `backend/src/services/routingService.ts` | Binary min-heap priority queue, Haversine heuristic, traffic-aware edge weights |
| Traffic simulation | `backend/src/services/trafficService.ts` | Simulated GPS probes with rush-hour patterns, exponential moving average aggregation |
| POI full-text search | `backend/src/routes/search.ts` | PostgreSQL GIN index on `to_tsvector('english', name)` with spatial proximity ranking |

### Simplifications from Production Design

| Production | Local Substitute | Why |
|------------|-----------------|-----|
| Kafka for GPS probe ingestion | In-process traffic simulation timer | No need for distributed streaming at dev scale |
| Contraction Hierarchies | Basic A* with priority queue | CH requires preprocessing pipeline; A* sufficient for grid-based test network |
| ClickHouse for traffic analytics | PostgreSQL traffic_flow table | Single time-series table fits local workload |
| Elasticsearch for POI search | PostgreSQL GIN full-text index | GIN index handles dev-scale POI corpus |
| CDN for tile serving | Leaflet loading OpenStreetMap tiles directly | No local tile generation pipeline |
| PostGIS spatial queries | Bounding-box queries on lat/lng columns | Simpler, sufficient for grid-based test data |
| Geographic sharding (H3) | Single PostgreSQL instance | One city-sized test dataset |
| OAuth / JWT auth | No authentication | Learning project focused on routing, not auth |
| Vector tile generation (MVT) | Leaflet raster tiles from OSM | Client-side rendering not in scope |

### What Was Omitted

- **CDN and edge caching** -- no multi-POP deployment
- **Multi-region deployment** -- single local instance
- **Kubernetes orchestration** -- Docker Compose only
- **ML-based ETA prediction** -- simple distance/speed calculation
- **Offline map download** -- not implemented
- **Voice navigation** -- not implemented
- **Rerouting on deviation** -- detected but not acted upon
- **Contraction Hierarchies preprocessing** -- basic A* only
- **Alternative routes** -- penalty method described but not implemented
