# Design Apple Maps - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a navigation platform like Apple Maps: route calculation across a global road graph, real-time traffic derived from anonymous GPS probes, map tile serving, and search/geocoding — at 10M+ concurrent navigators and 500M route requests/day. The system has three problems bolted together, each with a different bottleneck: **routing** is CPU-bound graph search that must return in milliseconds, **traffic** is a firehose of noisy, high-volume writes that must resolve into a clean signal, and **tiles/search** are read-heavy, cacheable, and mostly a distribution problem. Treating all three the same way — one database, one caching strategy — is the mistake this design avoids.

## 🎯 Requirements Clarification

Questions I'd ask up front:

- **Do we build routing from scratch or integrate an engine like OSRM/Valhalla?** I'll design the algorithm and data structures as if building it, since that's where the interesting engineering is, but note that in practice most companies adapt an open-source routing core rather than writing Contraction Hierarchies from zero.
- **Real-time navigation (turn-by-turn with rerouting) or just point-to-point routing?** I'll cover both — rerouting is a variant of the same route-calculation path, triggered by off-route detection.
- **How is traffic sourced?** Crowd-sourced GPS probes from the userbase itself, not fixed roadside sensors — that choice shapes the entire traffic pipeline, and I'll defend it below.
- **Global from day one, or launch region then expand?** I'll design for global scale but call out where geographic sharding is the natural growth path rather than a day-one requirement.

### Functional Requirements

- **Route**: origin/destination → optimal path with turn-by-turn maneuvers and ETA
- **Navigate**: live turn-by-turn with automatic rerouting on deviation
- **Traffic**: real-time congestion and incidents overlaid on the road network
- **Search**: full-text POI search and geocoding (address ↔ coordinates)
- **Offline**: downloadable map regions for connectivity-free navigation

### Non-Functional Requirements

- **Route latency**: p95 < 500ms, p99 < 1s — this is a "type a destination, expect an answer now" interaction
- **ETA accuracy**: within 10% of actual arrival — a routing system that's fast but wrong erodes trust as fast as one that's slow
- **Availability**: 99.99% — navigation failing mid-drive is a safety-adjacent failure, not just an inconvenience
- **Scale**: 10M+ concurrent navigators, 500M route requests/day, 1M+ GPS probe ingestions/second

### Scale Estimates

- 500M route requests/day ≈ 5,800/sec average, bursty around commute windows — routing capacity must be sized for peak, not average
- 1M GPS probes/sec sustained — this is the largest raw ingestion rate in the system, roughly 200x the route-request rate
- Road graph: tens of millions of segments globally; a single country's graph is a few GB in memory, making "load the whole graph into RAM per worker" plausible per-region but not globally
- The shape: **routing is latency-bound at moderate volume; traffic is throughput-bound at extreme volume; tiles/search are read-bound and almost entirely cache-absorbed.** Three different engineering problems sharing one product.

## 🏗️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│           Clients: iPhone │ CarPlay │ Watch │ Mac                │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CDN / Edge Network                            │
│              (vector tiles, static assets)                       │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│              API Gateway (auth, rate limit, geo-route)           │
└──────────────┬──────────────────┬──────────────┬─────────────────┘
               ▼                  ▼                  ▼
      ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
      │ Routing Service │ │ Traffic Service│ │  Map Service   │
      │ A* + CH, ETA,   │ │ probe ingest,  │ │ tiles, search, │
      │ alternatives    │ │ map-match,     │ │ geocoding      │
      │ (in-memory      │ │ incidents      │ │                │
      │  graph workers) │ │ (stream proc.) │ │                │
      └────────┬────────┘ └────────┬───────┘ └────────┬───────┘
               ▼                   ▼                   ▼
      ┌──────────────────────────────────────────────────────────┐
      │                       Data Layer                          │
      ├──────────────┬───────────────┬──────────────┬─────────────┤
      │ PostgreSQL + │ Kafka (probe  │ ClickHouse    │ Elasticsearch│
      │ PostGIS      │ stream)       │ (traffic      │ (POI search, │
      │ (graph, POI) │               │  history)     │  geocoding)  │
      ├──────────────┴───────────────┴──────────────┴─────────────┤
      │        Redis/Valkey (tile cache, dedup, sessions)          │
      │        Object storage (rendered tiles, offline packs)      │
      └──────────────────────────────────────────────────────────┘
```

The structural decision: **routing workers hold the graph in memory and never touch the traffic write path directly.** Traffic updates land in a fast-moving store (Redis for current state, ClickHouse for history) that routing reads from as a weight overlay, not as a join. This keeps 1M writes/sec from ever competing with 5,800 latency-sensitive route requests/sec for the same locks.

## 💾 Data Model

| Table/Store | Key Columns | Indexes | Notes |
|-------------|-------------|---------|-------|
| road_nodes | id (BIGSERIAL), location (PostGIS GEOGRAPHY), lat/lng, is_intersection | GIST(location) | Dense sequential IDs — needed for array-index graph traversal in memory |
| road_segments | id (BIGSERIAL), start/end_node_id, geometry, street_name, road_class, free_flow_speed_kph, is_toll/one_way, turn_restrictions (JSONB) | GIST(geometry), (start_node_id), (end_node_id) | The graph edges; turn_restrictions varies per segment, hence JSONB |
| traffic_flow | segment_id, minute_bucket, speed_kph, congestion_level, sample_count | (segment_id, minute_bucket) composite PK | UPSERT target — one row per segment per minute, not per probe |
| incidents | id (UUID), segment_id, type, severity, location, confidence, is_active | GIST(location), partial index WHERE is_active | 99% of queries want only active incidents — partial index keeps it 10-50x smaller |
| pois | id (UUID), name, category, location, address, rating, review_count | GIST(location), GIN(to_tsvector(name)), (category) | Full-text + spatial in one table; search scores both |
| navigation_sessions | id (UUID), user_id, origin/dest, route_data (JSONB), status | (user_id), (status) | Must never lose active navigation state — strong consistency required |

Three modeling calls worth defending:

**BIGSERIAL for graph entities, UUID for user-facing ones.** Routing algorithms need dense, sequential IDs to use as direct array indices in an in-memory graph — a HashMap lookup per edge traversal during a hierarchical search would be the dominant cost. POIs and incidents use UUIDs specifically to avoid sequential-ID enumeration in public APIs (nobody should be able to scrape "POI 1, POI 2, POI 3...").

**Dual coordinate storage (lat/lng plus PostGIS GEOGRAPHY).** The GEOGRAPHY column is required for correct spherical distance and GIST-indexed spatial queries (ST_DWithin, ST_Distance). Plain lat/lng columns let bounding-box filters and JSON serialization skip PostGIS entirely when precision to the centimeter doesn't matter. ~16 extra bytes/row is nothing against the query-pattern flexibility it buys.

**Denormalized congestion_level on traffic_flow.** Pre-computed at write time from speed/free-flow ratio rather than joined at read time. At 1M writes/sec, avoiding a join with road_segments on every single traffic read (which happens far more often than writes propagate) is a clear win — the ~20 extra bytes per row is cheap relative to eliminating a hot-path join.

**Foreign key discipline worth calling out**: `road_segments.start_node_id`/`end_node_id` use `ON DELETE NO ACTION` rather than CASCADE — accidentally deleting a node must not silently delete every segment that references it, since that's how you corrupt a routable graph. `incidents.segment_id` instead uses `ON DELETE SET NULL`, because an incident remains geographically valid at its reported point even if the underlying road geometry is later re-surveyed and replaced — the incident shouldn't vanish just because its original segment reference did.

**Data lifecycle**, since a 1M-write/sec table needs an explicit retention story or it grows unbounded:

| Data | Retention | Mechanism |
|------|-----------|-----------|
| road_nodes, road_segments | Permanent | Core graph; changes are edits, not accumulation |
| traffic_flow | 7 days live, then rolled up | Hourly aggregates retained ~1 year in ClickHouse for historical-pattern fallback |
| incidents | 90 days active, then archived | Resolved incidents move to cold storage |
| navigation_sessions | 30 days | Deleted or anonymized — no long-term need for individual trip records at the operational layer |
| pois | Permanent | Soft-deleted, never hard-deleted, since stale POI references shouldn't 404 old links |

Without the traffic_flow rollup, a table taking 1M writes/sec (even after minute-bucket aggregation collapses that to roughly one row per segment per minute) would still accumulate into the billions of rows within weeks. The rollup is what keeps the "last 5 minutes of freshness" query — which runs on every routing request's traffic overlay refresh — hitting a small, hot, mostly-cached working set instead of scanning history.

## 🔌 API Design

```
POST /api/routes/calculate      → Origin/dest → route + maneuvers + ETA
GET  /api/routes/:id            → Retrieve an in-progress navigation session
POST /api/traffic/probe         → Submit GPS probe (idempotent, high volume)
GET  /api/traffic/flow          → Traffic conditions for a bounding box
GET  /api/traffic/incidents     → Active incidents in an area
POST /api/traffic/incidents     → User-reported incident (idempotent, merges nearby)
GET  /api/map/tiles/:z/:x/:y    → Vector tile (CDN-cacheable, immutable per hash)
GET  /api/search                → POI search by name/category/location
GET  /api/search/geocode        → Address → coordinates
```

Contract notes: the probe-submission endpoint is the highest-volume write in the system and is explicitly designed for fire-and-forget semantics — clients don't wait on a rich response, just an ack. Tile URLs are content-addressed so the CDN can cache them as immutable forever, sidestepping invalidation entirely for the vast majority of traffic.

**The route-calculation request, end to end:**

```
Client              API Gateway         Routing Worker        Traffic Cache (Redis)
  │  POST /routes ────▶│                    │                      │
  │                     │── route to worker ▶│                      │
  │                     │   (nearest region) │── snap origin/dest ─▶│ (spatial KNN)
  │                     │                    │── fetch weight overlay ▶│
  │                     │                    │◀── current speeds ───│
  │                     │                    │  [bidirectional CH   │
  │                     │                    │   search on cached   │
  │                     │                    │   in-memory graph]   │
  │                     │◀── route + ETA ────│                      │
  │◀── 200 route ───────│                    │                      │
```

Two things worth naming in that flow: the gateway routes each request to a worker holding the *relevant regional graph* rather than round-robining blindly — a query for a Tokyo route landing on a worker that only holds the US graph is a wasted round trip. And the traffic overlay fetch is a cache read, never a database query in the hot path — this is exactly the separation described above: routing never blocks on the traffic write pipeline.

## 🔧 Deep Dive 1: Sub-Second Routing Across a Continental Graph

Plain Dijkstra or A* on tens of millions of segments is too slow for a 500ms budget — a full-continent shortest path can touch millions of nodes.

**Contraction Hierarchies (CH)**: an offline preprocessing pass orders nodes by importance (local streets → arterials → highways) and contracts them from least to most important, inserting shortcut edges that preserve shortest-path distances whenever removing a node would otherwise break them. At query time, bidirectional search only expands *upward* in importance from both origin and destination, meeting in the middle — visited nodes drop from millions to thousands.

**Why CH instead of plain A*, defended with the actual failure mode:**

> "Plain A* with a good heuristic is still fundamentally a full graph search — worst case it touches every node on the path between two distant points, and on a cross-country query that's millions of node expansions, each a priority-queue operation. At 5,800 requests/sec average with commute-hour bursts well above that, a routing worker spending even 200ms of CPU per long-distance query caps out at low single-digit queries per second per core — you'd need an enormous fleet just to keep up, and tail latency would blow through the 1-second p99 constantly. Contraction Hierarchies front-load that cost: hours of offline preprocessing per graph rebuild, producing a hierarchy where a query only searches shortcuts near the top of the importance order, cutting visited nodes by orders of magnitude and turning multi-second worst cases into tens of milliseconds. What we give up is flexibility — the hierarchy encodes *topology*, and topology changes (new road opens) require a hierarchy rebuild, not a live edit. That's fine because road topology changes on the order of days to weeks, while traffic *weights* change every few minutes — and the design handles that by leaving weights out of the hierarchy entirely, adjusting them at query time as an overlay on unchanged shortcut structure."

**Traffic-aware weighting without invalidating the hierarchy**: edge cost is `distance / current_speed`, and current_speed comes from the traffic overlay (Redis-cached, ClickHouse-backed for gaps) rather than being baked into precomputed shortcuts. This is the key move that makes CH compatible with real-time traffic: the *expensive* thing (hierarchy structure) is stable; the *volatile* thing (speeds) is applied as a cheap runtime lookup during the already-fast hierarchical search.

**Alternative routes via the penalty method**: after finding the primary route, penalize its edges (1.5–2x weight) and re-run A* on the penalized graph — the search naturally routes around the expensive segments, producing a genuinely different path rather than a near-duplicate. A diversity check (<70% edge overlap with the primary) filters out alternatives that differ by one turn. This is far cheaper than true k-shortest-paths algorithms, which explore exponentially more state for marginal benefit here — riders want *meaningfully* different options, not the mathematically-exact second-best path.

**Maneuver generation** turns a raw path (a sequence of nodes and edges) into human instructions. For each consecutive edge pair, compute the bearing change: under 15° is "continue straight," 15–45° is a slight turn, 45–120° is a normal turn, 120–160° is a sharp turn, and over 160° is a U-turn. Each maneuver attaches the upcoming street name pulled from the segment record, so "turn right" becomes "turn right onto Market Street" — the difference between a usable instruction and a frustrating one. This step is cheap relative to the search itself, but it's where a technically-correct shortest path becomes an actually-drivable set of directions, which is the part users actually experience.

**The heuristic's admissibility matters for correctness, not just speed**: Haversine (great-circle) distance divided by the maximum plausible road speed (say 130 km/h for highway) never overestimates true travel cost, which is the formal requirement for A* to guarantee optimality. A heuristic that occasionally overestimates would make the search faster but could return a route that merely *looks* fast rather than actually is — an unacceptable trade for a navigation product where the whole point is trustworthy ETAs.

## 🔧 Deep Dive 2: Turning 1M Noisy GPS Probes/Sec into a Traffic Signal

Every active navigator's phone is a traffic sensor. That's free, ubiquitous coverage — and also a firehose of imprecise, high-volume, adversarial-by-noise data that must resolve into "this road is doing 40% of free-flow speed" within seconds.

**The pipeline**: probes flow through Kafka partitioned by geography (H3 cell) → map-matching snaps each noisy GPS point to the most likely road segment (candidate segments within 50m via `ST_DWithin` + GIST index, scored by distance-from-centerline plus heading-alignment via `ST_Azimuth`) → exponential moving average smooths per-segment speed (α = 0.1, so new samples nudge the average without letting single-probe noise whipsaw it) → congestion level derived from speed/free-flow ratio → anomaly detection watches for sustained slowdowns.

**Why crowd-sourced probes instead of fixed roadside sensors:**

> "Fixed sensors give clean, unambiguous readings, but only on roads someone paid to instrument — which in practice means major highways in wealthy metros, leaving the overwhelming majority of the road network with zero live data. Probes are noisy — consumer GPS has 5-15 meters of error, occasional multipath bouncing off buildings, and no sensor calibration — but they exist on literally every road anyone drives, and coverage grows automatically as the userbase grows, with zero incremental infrastructure cost. The trade I'm making is signal quality for coverage: I accept needing map-matching to clean up noisy points because the alternative — perfect data on 5% of roads — fails the actual product requirement, which is traffic-aware ETAs *everywhere*, not just interstates. The EMA smoothing and the requirement for multiple confirming probes before flagging an incident are exactly the machinery that pays for this trade: they convert 'noisy but abundant' into 'reliable in aggregate,' which converges to accurate speeds with as few as 5 probes/segment/minute in practice."

**Idempotency at ingestion volume**: each probe keys on `deviceId + timestamp`; Redis holds a 1-hour dedup window so a retried or duplicated probe is a cheap SET-with-TTL check, not a database round-trip. The PostgreSQL/ClickHouse write is itself an UPSERT keyed on (segment_id, minute_bucket) — so even if dedup somehow missed a duplicate, the write converges to the same aggregated state rather than double-counting. Two independent layers, because at 1M/sec the cost of getting this wrong (a phantom traffic jam from double-counted probes) is worse than the cost of two cheap checks.

**Incident detection requires *confirmation*, not a single bad reading**: a lone probe reporting 20% of free-flow speed is far more likely a driver who stopped for coffee than a genuine incident. The rule — 5+ probes in 5 minutes reporting <30% free-flow speed on the same segment — trades detection latency (an incident takes a few minutes to confirm) for false-positive suppression. Nearby reports (within 100m, already-active) merge by incrementing a confidence score rather than spawning duplicate incidents, which matters because a real incident generates a burst of independent reports from different drivers, not one report repeated.

**Freshness and fallback**: segments with no probes in 10 minutes (rural roads, off-peak hours) fall back to historical day-of-week/hour-of-day averages from ClickHouse, tagged with a `confidence` field the client can surface ("estimated" vs. "live"). This is the traffic-service equivalent of the routing service's graceful degradation — the system always answers, it just tells you honestly how sure it is.

## 🔧 Deep Dive 3: Tiles and Search — The Part That's Mostly a Caching Problem

Compared to routing and traffic, map tile serving and POI search are almost boringly solvable: they're read-heavy, the underlying data changes slowly, and the access pattern is embarrassingly cacheable.

**Vector tiles over raster**: MVT/protobuf tiles are 3-5x smaller than PNG, support client-side styling (dark mode, accessibility contrast, rotation without pre-rendering every angle), and stay sharp at any zoom. The cost is client-side rendering complexity — every target device needs a GPU-capable renderer — which is a reasonable bet given the platform is exclusively Apple hardware with Metal support. A cross-platform product with cheap Android devices in its target market might make the opposite trade.

**Tile caching is layered and mostly free once built**: content-addressed URLs (tile hash changes only when underlying geometry changes) mean CDN edge caching is immutable-forever — no invalidation logic needed for the common case of "nothing changed." Behind the CDN, Redis holds a hot LRU tile cache; behind that, origin renders from PostGIS on a genuine cache miss. Because road geometry changes on the order of weeks, cache hit rates at the edge approach 99%+, and origin capacity only needs to handle the rare miss plus periodic re-renders after map updates.

**Search blends text relevance with geography**: PostgreSQL GIN full-text index on POI names combined with spatial proximity — score is a weighted mix of text-match quality, distance penalty, rating, and log(review_count) so a highly-rated nearby result beats a perfect text match three cities away. At the scale where this needs its own cluster (global POI density, sub-100ms search SLA), Elasticsearch takes over the text-relevance half while PostGIS remains the source of truth — a read-replica pattern where the search index is a derived, eventually-consistent view.

## 🔧 Deep Dive 4: Live Navigation — Rerouting Without Re-Deriving Everything

Point-to-point routing is a single request-response. Turn-by-turn navigation is a *session* — the client streams position updates, and the backend must decide, continuously, whether the driver is still on the planned route and whether the ETA still holds.

**Off-route detection** compares the reported position against the planned path's geometry using the same map-matching machinery built for traffic probes: if the position snaps to a road segment that isn't on the route (or is farther than a threshold distance from any planned segment), the client has deviated. A single off-route reading isn't necessarily a deviation — GPS jitter near a planned turn can look like a wrong turn for one sample — so the same "require confirmation" discipline from incident detection applies: 2-3 consecutive off-route readings before triggering a reroute, not one.

**Rerouting reuses the exact route-calculation path**, not a special-cased "fast reroute" endpoint — the origin is simply the driver's current position instead of the original starting point. This is a deliberate simplification: maintaining a second, lighter-weight routing code path for reroutes would be an ongoing maintenance burden and a second place for routing bugs to hide, in exchange for savings that don't matter once Contraction Hierarchies already make a fresh route calculation fast. The one addition specific to rerouting is a preference to *stay close to the original route* when cost is comparable — nobody wants to be routed a completely different way for a two-block deviation — implemented as a small bias in the edge weights toward previously-planned segments.

**ETA updates ride the traffic overlay refresh**, not a separate recomputation: as the navigation session progresses, each position update triggers a lightweight re-fetch of current-segment traffic state for the remaining path, and ETA is recalculated as remaining-distance-weighted-by-current-speed rather than a full graph re-search. This is cheap enough to run on every position update (every few seconds) without approaching the cost of a full route calculation.

**Navigation session state lives in PostgreSQL with strong consistency** for exactly one reason: losing track of an active drive mid-navigation — because a cache evicted the session or a worker restarted — is a materially worse failure than a slow response would be. This is the one place in the whole system where I'd accept extra write latency without hesitation, because the alternative failure mode (silent navigation loss) is disproportionately bad relative to the data volume involved (one session per active navigator, not per probe).

## 🔐 Security and Rate Limiting

- **Probe submission is the most abuse-sensitive endpoint** — it's high-frequency, low-friction, and directly shapes what every other user sees as "current traffic." A malicious actor spamming fake slow-speed probes on a segment could manufacture a phantom traffic jam and reroute real drivers away from a road. Defenses: per-device rate limiting on probe submission, the multi-probe confirmation requirement for incidents (a single bad actor can't singlehandedly manufacture 5 independent-looking confirmations), and anomaly detection on submission patterns (one device reporting from geographically impossible sequential locations).
- **Anonymization**: probes carry a device ID for dedup purposes only, with no durable link to a user identity in the traffic pipeline — the privacy model treats location data as ephemeral signal, not a tracked history.
- **Rate limiting tiers**: route calculation and search are moderate-limit, user-facing endpoints; probe submission uses a much higher per-device ceiling appropriate to its "every few seconds while driving" cadence but still bounded to prevent a compromised or buggy client from flooding the pipeline.
- **Tile and search endpoints are read-only and public-cacheable**, so the main defense is CDN-layer request shielding rather than application-level auth — the vast majority of requests never reach application servers at all.

## 🛡️ Consistency, Idempotency, and Failure Handling

**The consistency budget:**

| Data | Bar | Why |
|------|-----|-----|
| Road graph | Strong (transactional) | Wrong topology produces wrong routes — safety-adjacent |
| POIs | Strong (transactional) | User-facing correctness; low write volume makes strength cheap |
| Navigation sessions | Strong | Losing active nav state mid-drive is unacceptable |
| Traffic flow | Eventual, last-write-wins via EMA | 1M writes/sec; seconds of staleness is invisible to a driver |
| Incidents | Eventual with confidence-based merge | Multiple independent reports must converge, not race |

**Failure handling, tiered by blast radius:**

- **Routing graph load failure**: circuit breaker (5 failures → open, 30s half-open, 3 successes to close) falls back to a cached, possibly-stale graph rather than failing every request — a slightly outdated graph still routes correctly almost always; no graph routes nothing.
- **Traffic service down**: routing falls back to historical day-of-week/hour patterns automatically, marking the response `degraded: { traffic: "historical" }` so the client can show a subtle warning rather than silently serving a worse ETA as if it were live.
- **Hierarchical routing timeout**: falls back to plain A* — slower, but correctness doesn't depend on the hierarchy being available, only speed does.
- **Retry discipline**: exponential backoff with jitter (100ms base, 2x multiplier, 5s cap), retrying only 5xx/408/429; every retryable write carries an idempotency key so a retry storm during a partial outage can't manufacture duplicate incidents or double-counted probes.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| Route calculation latency histogram (by route_type, status) | The core SLO; regressions here are immediately user-visible |
| Nodes-visited gauge per query | Leading indicator that the hierarchy needs a rebuild or a region is under-optimized |
| Probe ingestion rate + dedup ratio | Health of the highest-volume pipeline in the system |
| Traffic freshness (% segments updated in last 5 min) | A routing service can be "up" and still serving stale ETAs — this catches that |
| Incident detection counter by type | Validates the confirmation pipeline is neither silent nor trigger-happy |
| Circuit breaker states | Live map of what's currently degraded |

Structured JSON logs carry a correlation ID from request through graph lookup to response, letting one slow route be traced across services.

**Alert thresholds I'd wire from day one:**

| Metric | Warning | Critical | Response |
|--------|---------|----------|----------|
| Route p95 latency | > 500ms | > 1000ms | Scale routing workers; check for a stuck graph reload |
| Route error rate | > 1% | > 5% | Page on-call; check graph load and DB connectivity |
| Probe ingestion lag | > 1 min | > 5 min | Check Kafka consumer lag; scale traffic workers |
| Traffic freshness | < 90% segments updated in 5 min | < 70% | Investigate probe pipeline; may indicate a regional Kafka partition stall |
| Postgres connection pool | > 80% used | > 95% used | Investigate connection leaks before it becomes an outage |

The route-latency and traffic-freshness alerts are the two I'd treat as most load-bearing: one guards the product's core promise (fast routes), the other guards its second promise (accurate ones) — and a system can violate the second while looking perfectly healthy on every infrastructure dashboard, which is exactly why freshness needs its own explicit metric rather than being inferred from uptime.

## 📈 Scalability: What Breaks First

1. **First: routing CPU.** A* and CH traversal are CPU-bound; this is the most latency-sensitive path and the first to feel commute-hour load. Fix: horizontally scale stateless routing workers, each holding a full regional graph in memory (~a few GB per country) — no shared state needed since routing is read-only against the graph plus the traffic overlay.

2. **Second: traffic write volume.** 1M probes/sec will eventually saturate a single PostgreSQL instance regardless of batching. Fix: Kafka absorbs and buffers the burst, partitioned by H3 cell so consumers parallelize geographically; ClickHouse takes the historical/analytical load off PostgreSQL entirely, which keeps only current-minute aggregates.

3. **Third: tile bandwidth at global scale.** Fix: this is what CDNs are for — origin should see well under 1% of tile requests once the immutable-URL caching strategy is in place; if origin load ever grows, it means cache-hit-rate regressed, which is the metric to chase, not more origin capacity.

4. **Fourth: POI search latency** as POI density and query volume grow. Fix: Elasticsearch cluster sharded by region, PostgreSQL read replicas as fallback — search was never going to stay a single-instance PostGIS query at global scale.

5. **The graph itself, geographically sharded at true global scale**: partition road_nodes/road_segments by H3 or S2 cell so each region's graph is self-contained for intra-region routing; cross-region routes traverse a coarser inter-region graph (think: connecting highway backbones) rather than one planet-sized in-memory structure. This is the honest end-state, not a day-one requirement — a single country's graph fits comfortably in one worker's memory.

**The scaling sequence I'd actually execute, in order:**

1. Horizontal routing workers behind a geo-aware load balancer — the cheapest lever, since routing is stateless once the graph is loaded
2. Kafka in front of traffic ingestion, if not there from day one — this is the pipeline most likely to be underestimated at launch
3. ClickHouse split out from PostgreSQL for traffic history — keeps the operational database lean
4. CDN and edge caching for tiles — should be near-day-one given how cache-friendly the workload is
5. Elasticsearch for search once POI density or query volume outgrows PostGIS full-text
6. Geographic sharding of the road graph — the last resort, only once a single region's memory footprint is the actual constraint, not a precaution taken early

## 🗺️ Offline Maps

Downloadable regions are a smaller but distinct subsystem: pre-render a bundle of vector tiles plus a regional slice of the road graph for a bounding area, package it (compressed, versioned), and store it in object storage for direct client download. The interesting backend problem isn't the download itself — that's a solved CDN/object-storage problem identical to the online tile path — it's **keeping offline packages in sync with map updates without forcing every offline user to re-download a multi-hundred-megabyte bundle for a single fixed pothole location**. The practical answer is delta packaging: version each region's bundle, and when the underlying graph changes, generate a diff package that patches only the changed tiles and graph segments, falling back to a full re-download only when the delta itself would exceed some fraction of the full package size. This is genuinely a different problem from the online serving path, which is exactly why it's called out separately here rather than folded into the tile-caching discussion above.

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Routing algorithm | ✅ Contraction Hierarchies | ❌ Plain Dijkstra/A* | Orders-of-magnitude faster queries; weights stay a runtime overlay |
| Traffic source | ✅ Crowd-sourced GPS probes | ❌ Fixed roadside sensors | Universal coverage at zero incremental infra cost; noise handled by aggregation |
| Traffic consistency | ✅ Eventual, EMA-smoothed | ❌ Strong consistency | 1M writes/sec; seconds of staleness invisible to a driver |
| Incident detection | ✅ Multi-probe confirmation | ❌ Single-report trigger | Suppresses false positives from one stopped car |
| Map tile format | ✅ Vector (MVT) | ❌ Raster (PNG) | 3-5x smaller, client styling, sharp at any zoom — costs GPU rendering |
| Graph entity IDs | ✅ BIGSERIAL | ❌ UUID | In-memory array indexing for traversal speed |
| Probe dedup | ✅ Redis TTL + DB UPSERT | ❌ DB constraint alone | Sub-ms check needed at ingestion volume; UPSERT as durable backstop |
| Alternative routes | ✅ Penalty method | ❌ True k-shortest-paths | Comparable rider value at a fraction of the search cost |

## 🗃️ PostGIS Versus a Dedicated Graph Database

Worth addressing directly since it's a natural interviewer follow-up: why relational-plus-spatial-extension instead of Neo4j or a purpose-built graph store?

> "A dedicated graph database's strength is expressive traversal queries — 'find all nodes within 4 hops satisfying property X.' That's not the access pattern here. Routing doesn't query the graph relationally at request time at all; it loads a regional slice into a custom in-memory structure once and traverses it with a purpose-built algorithm, so the database's query language is almost irrelevant to the hot path — its job is durable storage, spatial indexing for nearest-node lookups, and transactional consistency for graph edits. PostGIS gives me all three with mature tooling, an ecosystem every engineer on the team already knows, and — critically — the same database engine serving POIs, which need real spatial queries (find POIs within this bounding box) that PostGIS is specifically built for. Adopting Neo4j would mean operating two database technologies for marginal benefit, since the actual graph traversal happens in application memory regardless of which database stores the graph at rest."

## 🚀 Closing: What I'd Build Next

With more time I'd go deeper on four fronts:

- **ML-based ETA prediction** layered on top of the current EMA/historical-pattern approach, since the 10% accuracy target gets meaningfully harder in genuinely novel traffic patterns — a major event or sudden weather that historical day-of-week averages have never seen
- **Hidden Markov Model map-matching** in place of the simpler distance-plus-heading heuristic, which would materially improve accuracy in dense urban grids where multiple parallel streets sit within the matching radius and a single-point score can pick the wrong one
- **Geographic sharding of the routing graph** as the concrete next step once a single region's memory footprint stops being comfortably-sized, including the harder sub-problem of routing cleanly across shard boundaries without a visible seam in the route
- **The full rerouting and live-navigation loop** — off-route confirmation thresholds, the UX judgment call of when a deviation means "recalculating" versus "the driver clearly wants a different destination," and keeping that entire loop inside the same latency budget as a fresh route request

The throughline across all of it: this system is really three different engineering problems wearing one product's name, and the biggest architectural risk isn't getting any single algorithm wrong — it's letting one problem's solution leak into another's data path, like a traffic write blocking a route read. Keeping those boundaries sharp is most of what makes the 500ms promise achievable at 10M concurrent navigators.
