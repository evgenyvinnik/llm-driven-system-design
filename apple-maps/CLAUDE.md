# Design Apple Maps (Navigation) — Development with Claude

## Project Context

A navigation platform: geocode a place, search nearby POIs, and compute a fastest-route with turn-by-turn directions over a road graph whose edge costs change with live traffic. The hard problem is **graph routing fast enough to feel instant** — a shortest-path search over a road network where each edge's real cost is `length / effective-speed` and effective speed depends on current traffic — plus **spatial search** (nearest road node, POIs within a radius) that PostGIS handles natively. There is no user auth; it's a public routing/search service.

**Learning goals:** A* pathfinding with an admissible heuristic, in-memory graph modeling vs. DB traversal, traffic-aware ETA, and PostGIS spatial queries.

## Architecture at a Glance (what actually runs)

Two backing services plus an in-memory routing graph (`docker-compose.yml` — Postgres+PostGIS, Valkey):

| Component | Client lib | Role | Why this one |
|-----------|-----------|------|--------------|
| **PostgreSQL + PostGIS** (`postgis/postgis:16-3.4`) | `pg` | Source of truth: `road_nodes` (GEOGRAPHY + GIST), `road_segments` (edges: geometry, `road_class`, `free_flow_speed`, `is_toll`, `is_one_way`, `turn_restrictions`), `traffic_flow` (time-series), `incidents`, `pois` (GIST + GIN full-text), `navigation_sessions` | Spatial types + GIST/KNN give nearest-node snapping, radius POI search, and geocoding in one DB |
| **Redis / Valkey** (`valkey/valkey:7-alpine`) | `ioredis` | Route-result cache, traffic cache, rate limiting | Sub-ms reuse of recently computed routes; shared rate-limit state across `dev:server1..3` |
| **In-memory graph** (in `routingService`) | — | Adjacency list (`Map<nodeId, edges[]>`) loaded from Postgres, cached 60s, circuit-breaker guarded | A* needs thousands of neighbor lookups per route; those must be in-process, not DB round-trips |

Frontend is React 19 + **Leaflet/react-leaflet v5** + Zustand v4, rendering OpenStreetMap tiles. No authentication (`navigation_sessions.user_id` is just an opaque string).

## Key Design Decisions

### 1. In-memory graph + A*, not per-expansion DB traversal
`routingService._loadGraphFromDB` pulls all nodes and segments into an adjacency map once, caches it for 60s, and A* (binary-heap priority queue) runs entirely in memory. **Trade-off given up:** the graph must fit in RAM and can be up to 60s stale about newly added segments — accepted because the alternative, a `SELECT` per node expansion, means thousands of network round-trips per route and makes sub-second routing impossible. That naive DB-traversal is exactly the design that breaks under interactive latency requirements.

### 2. A* with an admissible Haversine heuristic (over Dijkstra)
The heuristic is straight-line (Haversine) distance divided by an assumed max highway speed — it never *overestimates* true travel time, so A* stays optimal while expanding far fewer nodes than Dijkstra's uniform-cost sweep. **Trade-off given up:** without contraction hierarchies, worst-case A* still explores much of the graph, so continental routing would be slow — CH / transit-node routing is the documented production path, not built here.

### 3. Time-based edge weights adjusted by live traffic
Routes minimize ETA, not distance: an edge's cost is `length / effective_speed`, where effective speed is the `traffic_flow` speed if present, else `free_flow_speed`; the router honors avoid-toll and avoid-highway constraints. **Trade-off given up:** ETA quality is only as good as traffic freshness — with the current simulated feed, ETAs track the simulation, not reality.

### 4. Circuit breaker around graph load with stale-graph fallback
The graph load is wrapped in an Opossum breaker; if a reload fails, the last good in-memory graph is served. **Trade-off given up:** during a DB outage the router may plan on slightly stale topology — chosen deliberately so routing stays available rather than failing hard.

### 5. PostGIS for everything spatial
Geocoding, POI search (GIN full-text on name + GIST radius), nearest-road-node snapping, and incident proximity all run as PostGIS queries against GIST indexes. **Trade-off given up:** a single Postgres caps spatial throughput and lacks Elasticsearch's relevance tuning for POI text — fine locally; the production doc moves POI search to Elasticsearch and traffic to Kafka/ClickHouse/H3.

### 6. Traffic as simulated probe aggregation
`trafficService` simulates GPS probes with rush-hour patterns, aggregates them into per-segment `congestion_level` (free/light/moderate/heavy), and refreshes periodically. **Trade-off given up:** no real probe data or map-matching (HMM/Viterbi), so congestion is plausible but synthetic.

## Current State

**Implemented end to end:** grid road-network seeding; in-memory A* routing with turn-by-turn maneuver generation (bearing → turn-angle → classification) and avoid-toll/highway options; traffic-aware ETA; simulated traffic probe ingestion, segment aggregation, congestion levels, and rush-hour patterns; basic incident detection; geocoding (address ↔ coordinate) and POI search (full-text, category, radius); `navigation_sessions` tracking; a Leaflet map UI with route rendering; Redis route/traffic caching; rate limiting (`express-rate-limit`); Opossum circuit breaker with stale-graph fallback; Prometheus metrics + Pino/pino-http logging; `npm run db:migrate` and `npm run db:seed`.

**Simulated or omitted (documented in `architecture.md`):** contraction hierarchies / transit-node routing; alternative routes; off-route rerouting; voice guidance; offline maps; real GPS probes and map-matching; the Kafka/ClickHouse/H3-cell traffic pipeline; Elasticsearch POI search; and user authentication.

## Iteration & Repair Log

- **README setup command fixed (this pass):** the README told users to run `npm run seed`, but the actual scripts are `npm run db:migrate` and `npm run db:seed` (the seeder lives at `backend/db/seed.ts`). Corrected to `db:seed`, with a note that Docker auto-applies `init.sql` via `initdb.d` and native Postgres needs `db:migrate` first.
- **Default dev port is 3001, not 3000:** the backend `dev` script runs `PORT=3001` to line up with the `dev:server1/2/3` multi-instance convention; the README already reflects this.
- **React 19 dependency upgrade (repo-wide):** the map stack is pinned to `leaflet@1.9` + `react-leaflet@5` because react-leaflet v4 peer-depends on React 18; this project moved to React 19 in the repo-wide upgrade pass.
- **ESM / connection-fallback pass (repo-wide):** ESM under `tsx`; `pino-http` named import; Postgres/Redis clients fall back to docker-compose defaults when env vars are unset.

## Open Questions

1. The graph is reloaded every 60s and assumed to fit in RAM. At what network size does this need contraction-hierarchy preprocessing or a graph store — and how would live-traffic weight updates coexist with precomputed shortcuts (which assume static weights)?
2. Traffic is simulated. What's the minimal real-probe ingestion + map-matching (HMM/Viterbi) pipeline needed before ETAs become trustworthy, and where does that data land (the production Kafka/ClickHouse path)?
3. Route results are cached in Redis keyed on origin/destination/preferences, but traffic changes constantly. What TTL balances cache hit rate against ETA staleness?
4. There's no rerouting. Given a `navigation_session`'s GPS stream, how do we detect off-route and recompute incrementally rather than replanning from scratch each tick?

## Resources

- [OSRM — Open Source Routing Machine](https://project-osrm.org/) — the production-grade routing engine this approximates
- [Contraction Hierarchies](https://algo2.iti.kit.edu/schultes/hwy/contract.pdf) — the preprocessing that makes continental routing fast
- [Hidden Markov Map Matching](https://www.microsoft.com/en-us/research/publication/hidden-markov-map-matching-through-noise-and-sparseness/) — the map-matching approach for real GPS probes
- [PostGIS Documentation](https://postgis.net/documentation/) — the spatial indexing and KNN queries behind search
