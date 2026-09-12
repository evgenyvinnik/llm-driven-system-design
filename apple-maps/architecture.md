# Apple Maps architecture

## System Overview

A navigation platform combines three workloads: rendering a map, finding a legal
route through a road graph, and estimating travel time from noisy observations.
Search connects a user's destination intent to that graph. The learning goals are
spatial modeling, in-memory pathfinding, traffic freshness, and coordination between
an interactive map and asynchronous requests.

The production design below is **proposed**, with explicit planning assumptions.
The final [Implementation Notes](#implementation-notes) describe the current local
code: a synthetic San Francisco-area grid, basic A*, a timer-driven traffic
simulator, PostgreSQL/PostGIS, Valkey, and a React/Leaflet frontend. It is not an
implementation of Apple's proprietary mapping or navigation services.

## Requirements

### Functional requirements

- Browse map data, find places/addresses, and select an origin and destination.
- Calculate a legal driving route with geometry, maneuvers, and an estimated duration.
- Apply supported road restrictions and route preferences consistently.
- Present route progress from sufficiently recent position observations and request
  rerouting when evidence supports a deviation.
- Produce traffic estimates with observation time, coverage, and confidence.
- Continue displaying the accepted route during brief connectivity loss.

Global offline routing, transit, voice guidance, and predictive ML are later
extensions. Retaining a route and some rendered tiles is not equivalent to having
an offline road graph, search index, or current closure feed.

### Non-functional requirements

| Concern | Proposed target / invariant |
|---------|-----------------------------|
| Routing latency | p99 below 500 ms for ordinary regional journeys |
| Availability | 99.99% monthly routing availability, with explicit degraded responses |
| Traffic freshness | Normal processing lag below one minute; confidence/coverage reported separately |
| Route validity | Honor direction, access, and turn restrictions for the selected profile |
| Data coherence | One compatible graph/weight version per route calculation |
| Client identity | Display results only for the request/route generation that produced them |
| Probe effects | Redelivery does not contribute the same observation twice |
| Privacy | Minimize raw trace retention and linkability; pseudonyms are not anonymity |

ETA accuracy needs evaluation against actual completed journeys, segmented by
region, trip length, and traffic conditions. A universal “within 10%” statement is
not established by a travel-time formula or by a synthetic demonstration.

## Capacity Estimation

Assume 500 million daily route requests: approximately 5,787/s average, or about
58,000/s at a 10× peak. Ten million concurrent navigators reporting once every ten
seconds would produce one million observations/s. These are deliberately separate
capacity assumptions; the route request rate does not imply that every position
update recomputes a route.

At 200 bytes of application payload per observation, raw ingestion is about
200 MB/s or 17.28 TB/day before replication, indexes, and envelope overhead.
A one-hour deduplication window at that rate contains 3.6 billion observation IDs.
An unpartitioned Redis key per observation is therefore not automatically a cheap
solution; bounded stream state and durable effect identity need deliberate sizing.

Graph memory depends on vertices, directed edges, turn-expanded states, geometry,
and routing indexes. Database sequence IDs need not be dense: an import can map
external IDs to compact in-memory offsets. Geographic partitions must preserve
boundary connectivity; independent closed tiles cannot route across their borders.

### Local Development Scale

The seed creates 400 nodes and 760 two-way segments, represented as 1,520 directed
adjacency entries, plus 35 randomly positioned POIs. Each API process writes 760
traffic rows every ten seconds: about 6.57 million rows/day, assuming each pass
finishes before the next tick. No retention task bounds that growth.

One PostGIS instance and one Valkey instance are sufficient for the small graph,
but “small graph” does not imply that an indefinitely running history stays small.
There are no runtime benchmarks or resource measurements in this review.

## High-Level Architecture

Proposed production boundaries:

```text
┌──────────────────────────┐        ┌──────────────────────────┐
│ Map / navigation client  │───────▶│ CDN: versioned map data  │
└────────────┬─────────────┘        └────────────▲─────────────┘
             ▼                                   │
┌──────────────────────────┐        ┌────────────┴─────────────┐
│ API gateway              │        │ Map build + object store │
└────────────┬─────────────┘        └──────────────────────────┘
             ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│ Routing + place search   │◀───────│ Published graph snapshot │
│ Workers with local graph │        │ Spatial source/importer  │
└────────────▲─────────────┘        └──────────────────────────┘
             │
┌────────────┴─────────────┐        ┌──────────────────────────┐
│ Traffic weight snapshots │◀───────│ Matcher + aggregation    │
│ Age/coverage/confidence  │        └────────────▲─────────────┘
└──────────────────────────┘                     │
                                    ┌────────────┴─────────────┐
                                    │ Durable probe stream     │
                                    │ Validated observations   │
                                    └──────────────────────────┘
```

The tile-delivery path does not depend on a route query. The routing query uses a
compatible graph and traffic snapshot, not a database lookup for every edge it
expands. Traffic processing owns a separate write workload and publishes derived
weights for routers and visual overlays.

## Core Components / Request Flows

### Road graph and routing

The map importer produces directed road edges, geometry, supported travel profiles,
and turn/access restrictions. Snapping selects a reachable directed road position
within a bounded distance, using heading/access information when available.
An origin near an overpass should not snap to an inaccessible road merely because
its centerline is closest in two dimensions.

A query pins graph and weight versions, computes the route, reconstructs actual
edge geometry, and generates instructions at junctions. Totals include defined
access/egress connectors. A no-route or out-of-coverage result is distinct from
an infrastructure failure.

For a small region, A* over adjacency lists is a useful baseline. Its heuristic
must lower-bound the cost under the same units and supported speeds. Nonnegative
edge costs, valid geometry/lengths, and enforced speed bounds are part of that
correctness argument. An assumed maximum speed is not sufficient by itself.

At larger scale, choose a routing index with an explicit traffic-update path.
Customizable Contraction Hierarchies separate topology preprocessing from weight
customization; ordinary static shortcuts cannot be left unchanged when their
underlying costs change. See the [CCH paper](https://arxiv.org/abs/1402.0402).
OSRM's [MLD workflow](https://project-osrm.org/docs/v26.6.1/tools#osrm-customize)
also applies speed/turn updates through a customization step. Neither is implemented here.

### Traffic ingestion and materialization

1. Validate observation identity, coordinates, time, units, and source limits.
2. Acknowledge only after durable acceptance into a partitioned stream.
3. Match a short ordered trace to candidate road positions using geometry,
   heading, connectivity, and observation uncertainty.
4. Aggregate unique observations by directed segment and event-time window.
5. Publish a versioned estimate with sample coverage, observation age, and confidence.
6. Customize route weights or atomically replace a compatible routing snapshot.

A nearest-line lookup is a spatial candidate search, not full map matching.
Parallel roads, tunnels, stops, and sparse samples require temporal reasoning.
An exponential moving average smooths noise but is order-dependent and not
idempotent: applying the same observation twice generally changes the result twice.

Historical patterns may fill uncovered segments, with their provenance labeled.
“Missing observation” does not mean “free-flow traffic.” A reported road closure
also needs a policy distinct from merely assigning a slow positive speed.

### Search and tiles

Search combines textual intent with geography. A location bias is not always a
hard radius; the product should distinguish “near me” from searching another city.
Place identity, entrance/access location, and address display are related but
not interchangeable. Public search can use an eventually consistent index while
authoritative graph data determines route connectivity.

Versioned tile URLs allow caching of immutable geometry/style assets. Vector tiles
support client styling and rotation; raster tiles reduce client rendering work.
Payload size and frame rate depend on layer density, styling, zoom, and hardware,
so neither a fixed compression ratio nor guaranteed 60 FPS follows from the format.

### Navigation client

The client owns the accepted route, local progress, and camera-follow state.
A route response includes request generation, geometry, maneuver positions, graph
version, traffic version/as-of time, and degradation metadata.
Late responses for an old destination or route generation are discarded.

Position handling uses observation timestamp and accuracy. Progress is measured
along the accepted route, not only by straight-line distance to the next turn.
Rerouting requires evidence of deviation and hysteresis to avoid repeated route
changes from GPS noise. A newly computed route replaces the accepted one atomically.

## Database Schema

The complete current SQL is [backend/src/db/init.sql](./backend/src/db/init.sql).
It creates tables directly, so rerunning it against an existing schema fails.
This inventory describes the supplied schema, not the proposed production additions.

| Table | Important fields / indexes | Current use and constraint |
|-------|----------------------------|----------------------------|
| `road_nodes` | BIGSERIAL ID, geography point, lat/lng; GiST and coordinate indexes | In-memory graph loading and nearest-node lookup |
| `road_segments` | Start/end FK, geography line, length, speed, toll/one-way, turn JSON; GiST and endpoint indexes | Graph loader ignores turn restrictions and line geometry |
| `traffic_flow` | ID, segment FK, timestamp, speed, congestion, sample count; segment/time indexes | Append-only simulator writes; no unique segment/window key |
| `incidents` | UUID, segment FK, geography point, scalar coordinates, type, severity, status/time | Missing fields required by reporting service |
| `pois` | UUID, name/category, geography, coordinates, address/rating; GiST, category, name GIN | Public spatial/name search and map markers |
| `navigation_sessions` | UUID, user string, endpoints, route JSON, status/time | Schema only; no API writes or reads |

Incident foreign keys use the default delete behavior, not `ON DELETE SET NULL`.
There are no confidence, sample-count, last-reported, or idempotency columns on
incidents. Speeds, lengths, coordinate consistency, and status values lack the
production validation/constraints needed for trustworthy routing.

### Proposed production records

| Record | Identity / rule | Why |
|--------|-----------------|-----|
| Graph build | Immutable version, supported profile, coverage, validation result | Publish coherent topology and restrictions |
| Directed road state | Graph version plus edge/turn identity | Preserve access and turn semantics |
| Traffic window | Segment/direction/window/version, samples and age | Replayable, correctable estimates |
| Observation receipt | Source session plus sequence or durable observation ID | Prevent duplicate contribution within the supported replay horizon |
| Incident report | Unique report ID, source, location, type, observed time | Separate report identity from merged incident identity |
| Current incident | Incident ID, policy state, confidence, decision history | Support verified closure and later resolution |
| Route response | Request generation, graph/weight versions, maneuver geometry | Keep client results coherent and diagnosable |

Raw observations need bounded retention and restricted access. Aggregates can be
retained longer when their purpose and privacy properties justify it. Replacing
an account ID with a stable device ID does not make a travel trace anonymous.

## API Design

These are the actual local endpoints. The frontend uses `/api`, not `/api/v1`.

| Method | Path | Current behavior |
|--------|------|------------------|
| POST | `/api/routes` | Origin/destination/options to one route |
| POST | `/api/routes/alternatives` | Primary route only; alternatives helper returns an empty array |
| GET | `/api/search` | POI-name search, optional category/location/radius/limit |
| GET | `/api/search/geocode` | Substring POI/address lookup, then street lookup |
| GET | `/api/search/reverse` | Nearest POI or named road, without a maximum distance |
| GET | `/api/search/places/:id`, `/api/search/categories` | Place details / category counts |
| GET | `/api/traffic` | Latest stored speed for segments intersecting bounds |
| POST | `/api/traffic/probe` | Attempt local EMA update; no durable traffic effect |
| GET / POST | `/api/traffic/incidents` | Bounding-box listing / incomplete reporting |
| DELETE | `/api/traffic/incidents/:id` | Mark resolved without authentication |
| GET | `/api/map/nodes`, `/api/map/segments`, `/api/map/pois` | Map data; no tile generation |
| GET | `/health`, `/health/live`, `/health/ready`, `/metrics`, `/ping` | Diagnostics |

The route response contains raw coordinate objects, distance, duration, maneuvers,
and edge metadata. It has no encoded polyline, route/session ID, graph version,
traffic timestamp, confidence, or degradation field. There is no route lookup,
position-update, map-tile, or offline-package endpoint.

The production contract should add those version/freshness fields and bounded
input validation. No route, unsupported coverage, bad input, rate limiting, and
dependency failure should have distinct responses and client presentation.

## Key Design Decisions

### In-memory routing with coherent versions

Fetching neighbors from a database during every graph expansion adds many network
round trips to one interactive request. Keeping the regional adjacency structure
in worker memory makes pathfinding CPU work with predictable data access.

The cost is memory, import/version management, and explicit partition boundaries.
A graph database can help other graph-query workloads, but it does not eliminate
the need for a routing-specific index. Sequence IDs also need not serve as array
positions; compact remapping is an import concern.

Traffic-aware shortcuts require customization that preserves their meaning under
the new weights. Publish a completed compatible snapshot and pin it for a request.
Updating base edges independently of shortcut costs can produce an incorrect route,
even when the visible road topology did not change.

### Durable observation identity before aggregation

Crowdsourced observations can extend coverage, but each source carries noise,
selection bias, privacy cost, and potential manipulation. Multiple samples from
one device are not independent confirmation of an incident.

The proposed pipeline acknowledges durable input, deduplicates within a defined
replay horizon, and applies versioned aggregate effects. Redis can accelerate
checks, but a claim before a nontransactional effect can suppress an observation
that was never processed. A weighted-average UPSERT alone does not eliminate
repeated contributions.

This design costs stream state, replay handling, and retention operations.
At local scale, a durable unique observation table plus a transaction is a simpler
starting point than introducing a million-events-per-second architecture immediately.

### Local navigation progress with bounded server refresh

The client can advance along a saved route without waiting for a round trip on
every position sample. Server requests refresh route options, traffic estimates,
and reroutes when needed. This improves responsiveness during intermittent service.

The cost is coordinating route generations and defining degraded guidance.
A route can remain displayable while live traffic becomes unavailable; it cannot
claim current closures or support arbitrary offline rerouting without more data.
Persisting every GPS sample in a strongly consistent trip row would add latency
and sensitive history without being necessary for local progress display.

## Consistency and Idempotency

Graph builds are immutable snapshots. A route query pins a compatible weight
snapshot; changes arrive through a new generation. The response identifies the
generations used so the client and diagnostics can reason about freshness.

Traffic windows use event time and an explicit allowed-lateness policy. A late
observation can create a newer aggregate revision, while an older revision cannot
overwrite a newer materialized result. Checkpointed processing and sink identity
must cover crashes between accepting input and applying output.

Incident reporting distinguishes retrying one report from merging independent
reports of the same event. A transaction or spatially serialized decision prevents
concurrent nearby reports from both creating separate incidents. Merge policy
considers type, time, road/direction, and location, not distance alone.

The local Redis helper provides claims and cached responses, but has no durable
probe receipt and incomplete retry recovery. Incident reporting additionally
claims the same standard header key in two layers. These limitations are detailed below.

## Security / Auth

The proposed system validates observation ranges, units, timestamps, plausible
motion, and source limits before they influence traffic. It treats location data
as sensitive even when identified by a rotating pseudonym. Logging and retention
must follow the same minimization rules as the ingestion path.

The local API is public, has permissive CORS, and has no authentication or ownership
model. Any caller can submit probes or attempt report/resolve actions. Coordinates,
speeds, limits, and timestamps have only partial presence checks. Some zero values
are rejected by truthiness tests, while malformed values reach SQL or arithmetic.

Rate limiting exists, but uses per-process memory and trusts the first raw
`X-Forwarded-For` value. It is not a shared authenticated-device quota or a source
independence check. The simulator and public probe endpoint are not a trustworthy
real-world traffic feed.

## Observability

Proposed indicators include route latency and CPU, snapped-endpoint distance,
restriction violations in reference tests, graph/weight age, observation-to-weight
lag, coverage/confidence, and route-generation rejection on the client.
ETA error must be measured against actual trip outcomes rather than simulator values.

The current API exposes Pino HTTP logs and Prometheus metrics. Route calculation
latency, nodes visited (a histogram), cache hits/misses, probe outcomes, breaker
state, and some traffic counters are wired. Database query timing is declared but
not applied to ordinary queries. The staleness gauge is set to zero on a simulator
pass and does not increase as data ages.

Health checks test PostgreSQL/Redis connectivity, count graph rows, and inspect
latest stored traffic timestamps. They do not inspect a loaded graph or prove that
restrictions/routing work. Freshness uses only segments with traffic rows as its
denominator, so missing coverage can look healthy. HTTP metrics normalize some
IDs but not arbitrary unknown paths; global rate limits also affect probes and scrapes.

## Failure Handling

| Failure | Proposed behavior |
|---------|-------------------|
| Traffic unavailable | Use labeled historical/free-flow estimates if policy allows; report age/confidence |
| New graph fails validation | Keep the previous compatible snapshot; expose its age |
| Search unavailable | Show a search error; preserve current route and map |
| Position stale or inaccurate | Hold progress conservatively and show position uncertainty |
| Reroute response arrives late | Reject it if its request generation is obsolete |
| Probe processing interrupted | Replay durable input without duplicate aggregate effects |
| Brief connection loss | Retain accepted route; explicitly limit live-data claims |

A stale graph is not automatically safe indefinitely: topology and closure policy
still need age limits. A fallback also cannot promise availability if the request
continues to require other unavailable dependencies.

Locally, graph loading has an Opossum stale-memory fallback, but nearest-node
queries still require PostgreSQL and traffic reads still require Redis. There is
no historical traffic store, queue retry/DLQ system, HTTP retry loop, or A* fallback
from a hierarchy. The CPU-bound search has no query deadline or cancellation.

## Scalability Considerations

First separate large tile delivery from API work and bound spatial query outputs.
Then measure routing CPU, graph memory, and traffic write growth independently.
A stateless API replica is not a substitute for a coherent graph snapshot or an
owned traffic partition.

At larger scale, geographic stream partitioning can colocate matching/window state,
while query workers load relevant graph partitions plus validated boundary links.
Use completed weight generations rather than mutable partial reloads. Move historical
traffic analysis away from the latency-sensitive route store when measured load warrants it.

The local simulator is especially misleading as a scaling example: every replica
starts another writer over every segment. A production feed needs partition ownership
or leader coordination, and historical storage needs retention/rollups.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Route traversal | Regional in-memory graph | Database query per expansion | Avoid many network round trips |
| Dynamic routing index | Explicit weight customization | Static shortcuts with changed base weights | Preserve route-cost correctness |
| Traffic acceptance | Durable identified observations | Redis claim before volatile update | Recover interrupted processing |
| Traffic publication | Versioned windows and confidence | Unqualified latest speed | Handle late data and missing coverage |
| Client progress | Local accepted-route state | Server round trip per position | Remain responsive during connection loss |
| Tile format | Select by rendering/product needs | Fixed vector-is-always-smaller rule | Costs depend on actual content and devices |

## Implementation Notes

### Runtime, setup, and data

[backend/src/index.ts](./backend/src/index.ts) starts Express without waiting for
schema/data readiness and starts one traffic simulator in its listen callback.
`npm run dev` sets port 3001; `npm start` runs TypeScript through `tsx` with the
entry point's port-3000 default. Vite proxies `/api` to 3001. No `.env` loader is present.

The API and seed use `DB_HOST/PORT/USER/PASSWORD/NAME`, while
[db/migrate.ts](./backend/src/db/migrate.ts) uses `DATABASE_URL` with different
fallback credentials. Compose initializes SQL on fresh volumes only. The schema
is not rerunnable, and the seed deletes all project data without a transaction.
It does not reset sequences or invalidate Redis keys. See [README](./README.md).

The real basemap and CSS come from external OSM/UNPKG services. The synthetic road
grid and randomized POIs do not align with real streets or business locations.
No incident is seeded. The fixture has no highway, toll, one-way, or turn-restriction
case, so the corresponding routing behavior is not validated by viewing the demo.

### Routing and geometry

[routingService.ts](./backend/src/services/routingService.ts) loads all nodes and
segments into Maps, adds reverse edges for two-way segments, and caches the graph
for 60 seconds. Those two database reads are not one snapshot transaction, and
concurrent cache misses are not coalesced. A stale fallback resets the cache age.

A* uses the binary heap in [utils/geo.ts](./backend/src/utils/geo.ts), time weights,
and Haversine distance divided by **100 km/h**. Turn restrictions and actual segment
line geometry are not loaded. There is no enforced positive finite cost/speed bound,
so the heuristic's admissibility is not guaranteed for arbitrary stored inputs.
The small seed's speeds are below that bound, but this is not a general guarantee.

Every calculation snaps endpoints through separate PostGIS nearest-node queries
with no distance cap, collects all segment IDs, then reads a whole-graph traffic
map. Redis `traffic:current` lasts 30 seconds; on a miss the router selects the latest
stored row per segment with no age cutoff. Missing data uses free-flow speed; stale
data does not switch to historical patterns. Redis failures propagate.

Path coordinates connect original endpoints to snapped nodes and then node-to-node,
but distance/time totals include only graph edges. Arbitrarily long off-graph
connectors can therefore be drawn without counted travel cost. Equal snapped nodes
can produce zero graph distance and only a depart instruction. Maneuver distances
reset after each emitted turn, rather than being cumulative route offsets.

No route-result cache, contraction hierarchy, routing worker pool, alternative
route algorithm, session persistence, or incident closure constraint is connected.
The synchronous A* loop occupies the Node event loop and has no search budget.

### Traffic and incident defects

[trafficService.ts](./backend/src/services/trafficService.ts) scans every segment
every ten seconds, assigns a random speed using server-local rush-hour bands, and
performs one awaited INSERT per segment. This is not a batch, EMA, or real-probe
simulation. Overlapping interval passes are possible; each API has its own Map and
writes the shared Redis value. Rows have no cleanup or unique time-window constraint.

The probe endpoint applies a 0.1 EMA to process-local memory only. Heading is ignored;
matching chooses the nearest segment within 50 metres. Observation time is used for
the key, not event-time ordering. No PostgreSQL or immediate Redis update records
the effect, and the next simulator pass replaces it. A processed acknowledgement
therefore does not mean a durable or consistently visible traffic contribution.

Incident reporting references missing `confidence`, `sample_count`,
`last_reported_at`, and `idempotency_key` fields, so it cannot complete against the
supplied schema. Its insert also constructs geography with longitude in both
coordinate arguments. Scalar coordinates can disagree with the geography even if
the missing columns are added. Nearby lookup ignores incident type/direction and
has no concurrency protocol; there is no automatic slowdown-to-incident detector.

### Idempotency, breakers, and limits

[shared/idempotency.ts](./backend/src/shared/idempotency.ts) uses Redis SET NX and
cached responses. Probe claims last one hour, but completion uses the default
24-hour TTL. No-match/error paths retain their claim; a 60-second logical processing
timeout does not remove the key, so a new NX still fails. Redis errors fail open.
There is no durable observation uniqueness or payload binding.

The incident middleware claims `Idempotency-Key`, then the service tries to claim
the same operation/key again. The service returns duplicate before a real insert,
and middleware caches that response. A body-only key avoids this double claim but
still reaches the broken SQL. Failure-state keys can also block retries until TTL
expiry despite `checkIdempotency` saying they may proceed.

[shared/circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) wires graph load,
nearest-node, geocode, and reverse-geocode breakers. Graph-load options are a
10-second timeout, 60% error threshold, volume threshold 3, and 60-second reset;
nearest-node uses a five-second timeout. These are percentage/volume settings,
not a rule of five failures and three recovery successes. A timeout does not cancel
an underlying database query or preempt the A* loop.

[shared/rateLimit.ts](./backend/src/shared/rateLimit.ts) supplies in-memory IP limits:
general 100/minute, routing 30, search 60, traffic 120, map data 200, incidents 10.
The probe limiter is 600 with successful requests excluded, but all requests still
pass the stricter global 100 limit. Geocode/strict helper instances are unused.
Raw forwarded-header trust permits spoofed identities and counters are not shared
across API processes.

### Browser behavior and observability limits

[MapView.tsx](./frontend/src/components/MapView.tsx) displays raster tiles and React
Leaflet layers. Data loads on mount/toggle and after a 300 ms move-end debounce,
with no stationary polling, cancellation, request-generation guard, or timeout cleanup.
Route lines are added before traffic lines, so enabled traffic can overlay the route.
There is no fitting of a calculated route into the available map area.

Camera synchronization writes a new center object on every `moveend`, then an
effect calls `setView` again. In [Leaflet 1.9.4's source](https://github.com/Leaflet/Leaflet/blob/v1.9.4/src/map/Map.js),
a zero-offset pan also emits `moveend`. This creates a source-derived feedback-loop
risk requiring an equality/origin guard; no browser reproduction was run here.

[mapStore.ts](./frontend/src/stores/mapStore.ts) keeps all layers, requests, and
navigation state together without persistence. Endpoint/option edits keep the old
route; the panel hides Get Directions while a route exists. A cleared request can
later restore its stale route. Search errors become empty results, and selecting a
result triggers another debounced search for its name, reopening the dropdown.

Start sets the initial maneuver and ETA. `updateNavigation` has no caller, and
there is no `watchPosition` or probe sender. The one-time My location action only
recenters the map. The unused progress helper uses rough Euclidean degrees rather
than route distance. Origin/destination displays are not editable search inputs.
Incident timestamps arrive as `reported_at`, while the UI reads `reportedAt`.

[routes/health.ts](./backend/src/routes/health.ts) implements the health checks:
connectivity timeouts use Promise.race without canceling queries; Redis INFO and
other deep checks are outside those timeouts. Traffic health uses five-minute
freshness, not the older document's two-minute claim. Graph health counts stored
rows, not a loaded/validated in-memory snapshot.

[shared/metrics.ts](./backend/src/shared/metrics.ts) and
[shared/logger.ts](./backend/src/shared/logger.ts) wire useful HTTP/route telemetry,
but base service logs do not consistently carry the HTTP request ID. URLs and some
error objects can contain coordinates or raw probes. An audit logger's retention
label is not implemented retention, and its helper has no callers.

Shutdown stops the interval and closes database/Redis resources, but never closes
the HTTP listener or waits for in-flight requests/simulation passes before exit.
The one smoke test checks the Leaflet container; it does not exercise these flows.

### Simplifications and omissions

One PostGIS instance replaces a managed spatial source/read tier, Valkey holds
small caches, and generated data replaces real roads/probes. Leaflet raster tiles
replace a custom versioned vector pipeline. There is no authentication or operator UI.

Durable stream ingestion, trace matching, traffic history rollups, verified closures,
customizable routing indexes, bounded offline packages, live navigation/rerouting,
privacy controls, multi-region deployment, and distributed snapshot publication are
omitted. This source/documentation review did not run the stack or repair app code.
