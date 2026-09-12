# Apple Maps — backend system design interview

> “I would design a driving-directions service that combines a stable road network
> with changing travel times. The hard part is returning a legal, explainable route
> while the map, traffic observations, and driver's position change independently.”

This is a proposed production design for a 45-minute interview. It is not a claim
about Apple's internal systems. The repository's small A* demonstration appears
in the final implementation boundary.

## 🧭 Scope and interview plan — 4 minutes

I would clarify whether we need driving directions, place discovery, live traffic,
and active navigation. I will include those four, with driving as the only travel
mode. Walking, transit schedules, lane guidance, and a global address-import
pipeline would substantially expand the problem.

The client receives route geometry, instructions, an ETA, and enough version
information to recognize when those pieces belong together. Search returns places
that can become route endpoints. Traffic updates affect subsequent route queries;
an active trip can request a replacement when its conditions materially change.

I would not require an account to browse or calculate a route. Saved destinations
and consented observation uploads are separate features with separate lifetimes.
We should not make route availability depend on a user's profile database.

| Discussion | Time |
|------------|------|
| Scope and targets | 4 min |
| Scale and architecture | 6 min |
| Data and API contracts | 6 min |
| Deep dive: legal and fast routing | 10 min |
| Deep dive: reliable traffic estimates | 9 min |
| Deep dive: version changes and recovery | 7 min |
| Trade-offs and implementation boundary | 3 min |

I would propose p99 route latency below 500 ms for normal regional trips, search
below 200 ms, and traffic usually less than a minute old. These are design targets
to validate against graph size and trip length, not measured repository results.

Route correctness includes legal turns and access restrictions. A fast response
through a closed road is not a successful response. If traffic is unavailable,
we may still return a legal route with a clearly qualified ETA.

## 🏗️ Scale and architecture — 6 minutes

Assume 500 million route requests per day, or about 5,800 requests per second on
average. A tenfold peak implies roughly 58,000 requests per second. Region and
journey length will make that demand uneven rather than uniformly distributed.

Assume ten million active navigation clients, with one consented observation per
ten seconds. That is one million observations per second. The ingestion workload
is much larger than the routing workload and should scale independently.

At 200 bytes per observation, raw ingress alone is 200 MB per second, or roughly
17.3 TB per day before replication and indexing. Retaining every observation in
an ordinary transactional table indefinitely is not a workable default.

I would draw this much first and add detail around the two central paths:

```
┌────────────────────────────────────────────────────────────┐
│ Clients: search, routes, optional observations             │
└──────────────────────────────┬─────────────────────────────┘
                               ▼
┌────────────────────────────────────────────────────────────┐
│ API edge: validation, quotas, region selection             │
└─────────┬────────────────────┬────────────────────┬────────┘
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ Place search     │ │ Route workers    │ │ Ingestion        │
│ Regional index   │ │ Graph + weights  │ │ Durable log      │
└──────────────────┘ └─────────▲────────┘ └─────────┬────────┘
                               │                    ▼
                     ┌─────────┴─────────────────────────────┐
                     │ Map releases + traffic aggregates     │
                     └───────────────────────────────────────┘

```

Basemap tiles come from an independent tile service and CDN. They do not pass
through the route worker. A slow tile download should not delay route computation,
and a traffic-ingestion surge should not exhaust the route worker's CPU pool.

Regional workers hold a searchable road graph in memory. A durable map build
produces that graph; a streaming pipeline produces traffic weights. PostgreSQL
with spatial support can hold source records and edit metadata without serving
as the inner loop for every graph traversal.

Search uses a regional text and spatial index. It can tolerate a brief delay in
new business listings, but its place identifiers and endpoint coordinates must
remain useful to routing. A deleted business must not silently resolve to a
completely different destination after a data rebuild.

> “I would start with replicated regional graphs. I would not shard each road
> lookup across network services; that puts a round trip inside graph search.”

## 💾 Data and API contracts — 6 minutes

I would describe the important records without drawing their complete schemas.
The distinction between physical roads and legal transitions matters more than
the choice of UUID versus integer for a particular identifier.

| Record | Main fields | Access pattern and invariant |
|--------|-------------|------------------------------|
| Road segment | Stable ID, geometry, direction, access, length | Regional spatial lookup; valid for a map release |
| Junction/transition | Incoming edge, outgoing edge, restriction | Evaluate legal turns, including time-dependent rules |
| Traffic estimate | Segment ID, window, speed, count, confidence | Latest eligible estimate for a compatible release |
| Map release | Region, version, checksum, activation state | Publish and pin a complete graph build |
| Place | ID, names, category, location, address | Text plus spatial retrieval |
| Incident | ID, affected edges, type, evidence, expiry | Constrain routes or annotate uncertain conditions |
| Observation | Event ID, event time, position, accuracy | Short-lived ingestion and aggregation input |

A route result is a versioned response, not necessarily a permanently stored row.
It contains endpoint snaps, full geometry, maneuvers, totals, graph version,
traffic version or observation time, and any degraded-data reason.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /places/search | Search with query, region or position, and filters |
| GET | /places/:id | Resolve a stable place to its current details |
| POST | /routes | Compute a route for endpoints and driving options |
| POST | /routes/alternatives | Request a small, meaningfully different candidate set |
| POST | /observations | Accept a bounded batch of consented position events |
| POST | /incidents | Submit a report with an operation identifier |
| GET | /traffic | Read bounded, versioned traffic for a viewport |

These are proposed contracts. The local endpoint inventory is in the README.
I would cap coordinates, batch size, search radius, and number of destinations.
Validation checks finiteness and geographic ranges before a request reaches
spatial queries or CPU-intensive graph work.

Route calculation has no business side effect, so a retry can recompute against
a newer snapshot. The client must still reject a response for an obsolete intent.
An incident report is a mutation: retrying it must preserve one logical report.

For observations, acknowledgement means the event is in the durable ingestion
path. It must not mean only that one process updated a memory map. Duplicate
suppression is useful, but it must not discard an event before durable acceptance.

## 🔧 Deep dive 1: legal and fast routing — 10 minutes

### Choose the graph representation before the search algorithm

A road graph is directed. A two-way street usually contributes two traversable
edges, potentially with different travel times. A turn restriction depends on
how the vehicle entered a junction, so a node-only state cannot represent every
legal transition without additional state or an expanded graph.

I would snap endpoints to plausible directed edges using position, access rules,
and distance. Starting on the wrong side of a divided highway can produce an
impossible initial maneuver even when the shortest-path algorithm is correct.

An endpoint too far from the road network should produce an explicit unsupported
or uncertain result. Connecting it to the nearest node with an invisible free
jump understates both distance and travel time.

Each query pins one graph and one eligible weight view. It then searches legal
transitions, reconstructs the original edge geometry, and generates maneuvers
from that same path. Geometry and instructions cannot be assembled from different
routes simply because each individual cache entry is fresh.

### Use A* as the correctness baseline

> “For the first implementation I would use A* with nonnegative travel times and
> a provable lower-bound heuristic. Then I would compare faster indexes against
> that baseline on representative routes and map changes.”

Straight-line distance divided by a valid maximum possible speed is a useful
lower bound. Picking an arbitrary maximum while allowing larger input speeds
breaks the reasoning. Invalid lengths or negative travel times must be rejected
when building weights, not discovered inside a customer request.

A* reduces exploration by steering toward the target, but a long trip through a
large road network may still visit too much of the graph to meet the latency
budget. An ordinary binary heap does not remove that worst-case workload.

I would bound computation and isolate it from the API event loop. Cancellation
and overload admission should free capacity for useful requests. A database
circuit breaker does not time out synchronous CPU work that has already started.

### Add acceleration without hiding changing weights

For large regions I would evaluate a customizable hierarchy or partition-based
routing index. These move work out of each query while allowing compatible
traffic weights to be refreshed between topology changes.

Customizable contraction hierarchies distinguish topology preprocessing, metric
customization, and queries. That separation is useful when roads change less
frequently than travel times. It does not mean arbitrary new weights can bypass
customization. [CCH paper](https://arxiv.org/abs/1402.0402)

With an MLD approach, partitioning and weight customization are also separate
operations. OSRM documents repeated customization for updated segment speeds
and turn penalties. I would benchmark the resulting update delay and query cost
against our freshness target. [OSRM tools](https://project-osrm.org/docs/v26.6.1/tools)

| Approach | Benefit | Cost for this problem |
|----------|---------|-----------------------|
| ✅ A* baseline, then a customizable index | Testable correctness with a path to faster queries | Build, customization, and release machinery |
| ❌ Plain A* as the only worldwide strategy | Simple dynamic edge costs | Long routes can exceed CPU and latency budgets |
| ❌ Static shortcuts with arbitrary live overrides | Appears to combine fast queries and fresh traffic | Shortcut costs can stop representing their underlying paths |

I am giving up implementation simplicity and accepting a bounded weight-publication
lag. That is preferable to claiming both instant arbitrary traffic changes and
precomputed shortest-path guarantees without reconciling the two.

### Explain the route's limits

For a short trip, a frozen traffic snapshot can be a reasonable initial model.
For a two-hour trip, current congestion at the destination is not a prediction
of conditions when the driver arrives there.

I would first return an ETA with explicit freshness and confidence, then introduce
time-dependent weights where data quality supports them. The search algorithm
must support that model's assumptions; replacing static edge weights with an
arrival-time function is not merely an API formatting change.

Alternatives should offer useful choices, such as avoiding a motorway or reducing
tolls. Returning the same route with a few different local edges wastes the
user's attention and increases computation without improving the decision.

## 🔧 Deep dive 2: reliable traffic estimates — 9 minutes

### Follow an observation to a published estimate

1. Validate the consent context, timestamp, accuracy, batch size, and event ID.
2. Append accepted events to a regional durable log before acknowledging them.
3. Match observations to plausible directed road segments, using recent movement
   and heading when available rather than just the nearest geometric line.
4. Aggregate by segment and event-time window, handling duplicates and lateness.
5. Reject implausible speeds and estimate confidence from independent evidence.
6. Publish compatible segment estimates with timestamps and expiration rules.

The privacy boundary belongs in that flow. Short-lived rotating identifiers can
help deduplicate nearby samples, but a sequence of precise locations can still
identify a journey. Rotation alone does not make the observations anonymous.

I would minimize collection and retention, restrict raw-data access, and keep
precise coordinates out of ordinary request logs. Aggregate traffic has a longer
useful lifetime than a person's detailed position trace.

### Aggregate evidence instead of trusting individual probes

A low speed can mean congestion, a parked vehicle, a red light, or a bad location
fix. Parallel frontage roads and tunnels make nearest-segment assignment uncertain.
One outlier should not turn a motorway red for everyone.

I would combine robust speed statistics, sample diversity, recent coverage, and
historical expectations. A minimum confidence threshold determines whether live
data replaces the baseline. The exact thresholds need evaluation on labeled
journeys and known congestion events rather than arbitrary interview constants.

An exponential moving average is cheap and useful for smoothing, but arrival
order changes its result. If the same event is replayed twice, applying the EMA
twice changes the estimate even though the underlying evidence is unchanged.

For an initial durable pipeline, I prefer bounded event-time windows with stable
event IDs and recomputable aggregates. We can add smoothing over completed windows
while preserving an auditable relationship to the observations they summarize.

| Approach | Benefit | Cost for this problem |
|----------|---------|-----------------------|
| ✅ Durable events and bounded window aggregates | Replayable estimates with explicit lateness and confidence | Buffering, state, and publication delay |
| ❌ Update a shared speed directly for every probe | Very low apparent latency | Retries, outliers, and arrival order distort the result |
| ❌ Periodically overwrite all roads with one model | Easy to operate | Erases useful local evidence and hides coverage gaps |

> “I would accept several seconds of aggregation delay to avoid turning noisy or
> duplicated positions into confident route advice. Freshness matters, but a
> freshly wrong estimate is not an improvement.”

### Define duplicates, late events, and expiry

A deduplication claim and an eventual aggregate update are different operations.
Claiming an event first, crashing, and rejecting its retry loses valid evidence.
The durable log and processing state need a recovery contract that closes that gap.

At one million events per second, even a one-hour deduplication window represents
3.6 billion event IDs. I would size that state explicitly, exploit batch/source
sequence structure where appropriate, and avoid an unlimited key per event in a
single Redis instance.

Late events within a bounded window may revise an unpublished estimate. Older
events can support historical analysis without rewriting live conditions. Server
receive time is useful operationally but cannot replace the observation time.

When coverage expires, the segment transitions to a historical or free-flow
estimate with a visible quality state. Keeping yesterday's speed forever because
it remains the newest database row is not a valid freshness policy.

Incident evidence follows a related but separate path. A confirmed closure can
forbid an edge, while a single unverified report may only annotate it. Reports
need time, direction, type, and evidence; proximity alone cannot establish that
two users observed the same incident.

## 🔧 Deep dive 3: version changes and recovery — 7 minutes

### Publish coherent regional releases

Map edits can split or merge segments. An old segment ID must not accidentally
apply its speed or closure to an unrelated new segment. I would include release
compatibility in the traffic publication contract and rebuild mappings explicitly.

A new regional graph is validated, checksummed, warmed on workers, and activated
through a small manifest change. Queries already using the previous release may
finish there while new queries select the new one.

For a cross-region route, neighboring graph versions must agree on boundary
connections. I would publish compatible region sets or retain a supported boundary
mapping; independently choosing each region's newest file can disconnect a trip.

This increases memory during rollout because old and new graphs overlap. I would
budget that headroom and reject an activation that exceeds it, rather than evicting
the old graph underneath active queries.

### Separate availability from precision

| Failure | Useful behavior | What must remain explicit |
|---------|-----------------|---------------------------|
| Live traffic pipeline delayed | Use eligible older data, then baseline estimates | Observation age and reduced confidence |
| New graph fails validation | Keep the prior compatible release | Release age and operational alert |
| Search index unavailable | Keep selected place and accepted route usable | New discovery may fail |
| Route worker overloaded | Bound queueing, shed work, allow client backoff | No invented successful route |
| Observation processor crashes | Replay from durable progress | Duplicate-safe aggregate reconstruction |

> “I prefer a known, compatible previous map to a partly published new map. I am
> accepting some update delay to preserve route consistency during recovery.”

That fallback has limits. A prior graph may not contain a critical closure, and
a stale graph alone does not make every dependency available. Endpoint resolution
must also have a working path, or the service still cannot start a route query.

Active guidance should keep its accepted route if a background refresh fails.
A replacement response includes a generation and its complete maneuver bundle;
the client adopts it atomically. The server should not overwrite a user's new
destination because an earlier, slower calculation finished later.

### Measure the contract, not just process uptime

I would track routing latency by trip length, nodes explored, route failure cause,
invalid snap distance, traffic age and coverage, ingestion lag, and disagreement
between estimated and observed travel time.

A zero-valued staleness gauge set once after an update stays zero when updates
stop. Age should derive from the last successful publication time or be computed
at observation. Health checks must distinguish dependency reachability from data
freshness and from the ability to answer a representative route.

Logs can correlate request and release IDs without storing full origins,
destinations, or probe bodies. Metrics should use bounded labels, not arbitrary
request paths or device identifiers.

The most valuable tests compare accelerated routing with a reference solver,
exercise restricted turns and snaps, replay duplicate/out-of-order observations,
and activate a graph while requests are in flight. Those tests probe the promises
we made, rather than just checking that an endpoint returns a success status.

## ⚖️ Trade-offs and local implementation boundary — 3 minutes

The design separates topology, changing weights, and query execution. Its main
cost is maintaining coherent releases and a replayable observation pipeline.
That cost buys understandable correctness and useful recovery behavior.

The local application is much smaller: one Express process loads a 400-node
synthetic graph, runs synchronous A*, and reads a Redis traffic snapshot. It has
no accelerated index, regional graph publication, durable ingestion log, or
continuous navigation service.

Traffic is generated on a timer in every API process. GPS ingestion changes only
process memory, and simulation later overwrites it. Turn restrictions are stored
but not used by routing; endpoint connector distances are absent from totals.
The incident write path has schema mismatches and a duplicate idempotency claim.

The [architecture](./architecture.md#implementation-notes) records the exact
source boundaries. I would first establish legal path and endpoint invariants,
durable observation semantics, and versioned response contracts before scaling
this demonstration into the proposed service.
