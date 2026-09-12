# Apple Maps — full-stack system design interview

> “I would explain the system through one journey: find a place, compare a route,
> and follow it while conditions change. At each step, the browser and backend
> need to agree about which destination, route, and traffic estimate are current.”

This is a proposed production design for a 45-minute interview, not a description
of Apple's internals. The repository demonstrates a smaller subset, described
at the end and in the architecture's implementation notes.

## 🧭 Scope and targets — 4 minutes

I would first confirm the travel mode and platform. I will design driving
navigation in a foreground browser, with place search, a map, traffic, and route
instructions. Native background navigation, transit, and downloadable regional
maps would require additional platform and data work.

The main user flow is to search or pick a destination, request directions, inspect
the route, and start guidance. The user can change endpoints, stop navigation,
or recover from a temporary network interruption without losing their intent.

I would make browsing and directions work without an account. Saved places may
use an account, while uploading position observations requires its own collection
and consent choices. Reading a map should not imply uploading a location trace.

| Discussion | Time |
|------------|------|
| Scope and targets | 4 min |
| Architecture and contracts | 7 min |
| Deep dive: intent to accepted route | 10 min |
| Deep dive: observations to useful traffic | 9 min |
| Deep dive: guidance under uncertainty | 9 min |
| Scale, validation, and local boundary | 6 min |

I would propose sub-200 ms search responses and sub-500 ms route responses for
ordinary regional journeys at p99. The map should remain interactive while those
requests run. These are targets to test, not existing benchmark results.

Traffic should usually reflect observations from the last minute, with an age
and confidence state when it cannot. Guidance should prefer a stable, coherent
route over rapidly switching among slightly different estimates.

## 🏗️ Architecture and contracts — 7 minutes

I would draw the user-facing and data-processing paths separately enough to make
their failure boundaries visible, while keeping the initial diagram small.

```
┌──────────────────────────────────────────────────────────────┐
│ Browser: map renderer, search, trip state, guidance          │
└────────┬─────────────────────┬──────────────────────┬────────┘
         ▼                     ▼                      ▼
┌────────────────┐   ┌───────────────────┐   ┌─────────────────┐
│ Tiles via CDN  │   │ Search/Route API  │   │ Probe ingestion │
└────────────────┘   └─────────┬─────────┘   └────────┬────────┘
                               ▼                      ▼
                     ┌───────────────────┐   ┌─────────────────┐
                     │ Places/road graph │   │ Durable stream  │
                     │ Traffic snapshots │◀──│ Aggregation     │
                     └───────────────────┘   └─────────────────┘

```

The browser owns immediate interaction. A map renderer handles camera motion and
geometry; React renders controls, search results, and instructions. A trip store
holds intentional choices and the accepted route. A request cache manages server
results, freshness, and in-flight work.

The route service owns legal path computation over a regional graph. Search owns
text and spatial retrieval. A traffic pipeline transforms observations into
segment estimates consumed by route workers and the traffic overlay.

A basemap tile is not the road graph used by routing. The rendered map can look
correct while a graph release contains a bad connection. Releases need compatible
geographic data, and tests must inspect paths as well as screenshots.

For scale, assume 500 million route requests per day: roughly 5,800 per second
on average, with a tenfold peak around 58,000. Ten million active clients reporting
once every ten seconds create one million observations per second.

Those workloads justify independent pools for route computation and ingestion.
They do not justify making every road-edge lookup a remote service call. Regional
workers should keep a graph and eligible traffic weights close to the computation.

### Define the objects that cross the boundary

| Object | Essential information | Why both sides need it |
|--------|-----------------------|------------------------|
| Place result | Stable ID, display name, location, category | Select a destination without relying on display text |
| Route intent | Endpoints, driving options, client generation | Know which user choice a response answers |
| Accepted route | Geometry, maneuvers, totals, route/release IDs | Replace a complete, internally consistent guidance bundle |
| Traffic view | Segment estimates, observation time, confidence | Display freshness and choose eligible route weights |
| Position sample | Event time, coordinates, accuracy, heading when available | Avoid treating every GPS fix as exact truth |
| Incident report | Operation ID, type, location, time, evidence | Distinguish retries from independent observations |

| Method | Endpoint | Meaning |
|--------|----------|---------|
| GET | /places/search | Find candidate places near a location or region |
| POST | /routes | Calculate a route for the current intent |
| POST | /routes/alternatives | Ask for a bounded set of useful alternatives |
| GET | /traffic | Fetch traffic for a bounded viewport and compatible map |
| POST | /observations | Durably accept a bounded batch of consented observations |
| POST | /incidents | Submit one logical incident report with retry identity |

These are proposed contracts. Coordinate ranges, finite numbers, search radius,
and batch limits are enforced at the edge. The UI can validate for a quick
explanation, but that cannot replace server validation.

I would send a client generation with route requests and retain it locally even
if the server simply echoes it. It is an ordering tool, not an authorization
credential or a promise that recomputation always returns identical traffic.

## 🔧 Deep dive 1: intent to accepted route — 10 minutes

### Keep camera movement responsive

Dragging the map should update the renderer directly. React does not need a full
application state update for every pixel. At the end of a movement, I would record
the settled viewport and request newly relevant places or traffic.

There are two different camera actions: the user moved the map, or the application
asked it to move. Selecting a search result is an application command; a settled
camera event is an observation. Sending every observation back as an unconditional
new command can create a feedback loop.

> “I would let the map own motion, and let the application own decisions such as
> centering a selected place. Equality checks and command identity keep the two
> synchronized without repeatedly asking each other to move.”

Viewport requests use a bounded area, layer type, zoom bucket, and data version
as their identity. Small pans can reuse nearby cached data. The client retains
usable prior layers while refreshing and marks stale traffic when appropriate.

I would start with raster basemap tiles and bounded overlays for a small product.
Dense, frequently styled road layers may justify vector tiles and GPU rendering.
The choice follows feature density and frame-time measurements, not the mere
presence of a map in the product.

### Search results must belong to the current query

Typing triggers a short debounce, but debounce alone does not order responses.
If “coffee” finishes after the user has typed “coffee shop,” the older response
must not replace the newer results.

I would cancel obsolete requests when possible and still compare their query
generation on completion. Cancellation saves work; the identity check guarantees
that a late response cannot become current state.

Search distinguishes loading, empty, error, and stale cached results. A network
failure is not evidence that no matching places exist. Keyboard users need a
labeled field, navigable results, and a predictable way to dismiss the list.

Selecting a result sets a destination by place ID and coordinates, dismisses the
search interaction, and issues one camera command. Updating the visible field to
the selected name should not automatically reopen an old search request.

### Treat route calculation as a state transition

When an endpoint or driving option changes, the current route becomes a previous
preview until a route for the new intent is accepted. I would either label that
preview clearly or hide it if its meaning would be confusing.

The trip state moves through editing, calculating, previewing, and navigating.
It can return to editing or an error state without discarding the user's endpoints.
Clearing the trip increments the intent generation and invalidates pending work.

A route response is accepted only if its generation and endpoint/options identity
still match the current intent. Geometry, distance, duration, and instructions
then replace the previous bundle together.

| Approach | Benefit | Cost for this journey |
|----------|---------|-----------------------|
| ✅ Explicit intent and response generations | Late responses cannot resurrect cleared or edited trips | More deliberate state transitions |
| ❌ A single shared loading flag and route object | Fast to prototype | Concurrent requests overwrite unrelated user choices |
| ❌ Always clear the entire trip on any error | Easy error handling | Forces users to repeat endpoint selection |

I am accepting some additional state modeling to prevent a particularly damaging
failure: the interface confidently displaying directions to a destination the
user no longer selected.

### Make the backend's answer match the preview

The backend snaps endpoints to plausible directed road edges, validates access,
and computes a legal path. Snap distance matters: a destination far outside the
network should not silently become a zero-cost connector to the nearest node.

A* is a useful baseline when travel times are nonnegative and its heuristic is a
valid lower bound. Legal turn restrictions require transition-aware state; a
node-only shortest path can otherwise suggest an illegal turn.

The response reconstructs original edge geometry and includes endpoint connectors
in totals where supported. Two coordinates that snap to one graph node are not
necessarily a zero-distance journey.

At larger scale I would evaluate a customizable routing index so graph topology
and frequent weight changes have defined publication steps. OSRM's MLD tooling
separates partitioning from customization of speeds and turn penalties.
[OSRM tools](https://project-osrm.org/docs/v26.6.1/tools)

The client does not need the index's internal details. It needs a coherent route,
a release identity, and enough freshness information to explain its ETA.

## 🔧 Deep dive 2: observations to useful traffic — 9 minutes

### Separate rendering traffic from producing it

The overlay is a viewport query; route computation may need roads far outside
that viewport. Both should consume compatible estimates, but the browser should
not have to download an entire regional traffic snapshot to color visible roads.

A stationary map still needs a refresh policy. Refreshing only after panning lets
a traffic layer remain unchanged indefinitely. I would choose a bounded polling
interval initially, pause unnecessary work when hidden, and refresh after reconnect.

Polling every visible segment separately would create too many requests. A bounded
viewport or tile-based response batches related segments, with versioned caching
and jitter to avoid synchronized refresh bursts.

At large scale, pushing changed tiles or region versions may reduce repeated
transfer, but adds subscriptions, reconnect recovery, and fan-out state. I would
adopt it when update volume and latency measurements justify that complexity.

### A GPS fix is evidence, not a road speed

A browser location fix has uncertainty. A stopped vehicle may be parked, and a
fix between parallel roads may match the wrong segment. The pipeline should use
accuracy, direction, recent movement, and independent samples to qualify evidence.

Accepted observations enter a durable stream before the server acknowledges them.
Processing matches them to candidate directed segments, groups them into bounded
event-time windows, and publishes robust speed estimates with confidence and age.

A retry uses a stable event identifier. Duplicate handling must not claim an event,
crash before storing it, and then reject its only remaining copy. Aggregate state
must be recoverable from durable input and committed processing progress.

A simple exponential average smooths noise, but updating it twice for one retried
sample changes the result. I prefer recomputable windows as the first durable
foundation, then smoothing whose relationship to those windows remains explicit.

> “I would trade a small aggregation delay for resistance to duplicate and noisy
> probes. The user needs useful traffic evidence, not just a frequently changing
> color on the map.”

| Approach | Benefit | Cost for this journey |
|----------|---------|-----------------------|
| ✅ Windowed estimates with confidence and expiry | Stable, explainable congestion and ETA inputs | Some delay and stateful processing |
| ❌ Immediately trust every nearest-road speed | Quick updates | Parking, GPS errors, and retries can mislead routes |
| ❌ Keep the last known speed until replaced | Simple reads | Sparse roads can retain obsolete congestion indefinitely |

When live evidence expires, the service can fall back to historical or free-flow
estimates. It should also change the quality state. A gray or qualified overlay
is more honest than presenting missing coverage as confirmed free-flow traffic.

### Distinguish an estimate from a closure

A low traffic speed changes travel time; a verified closure may make traversal
illegal or impossible. An incident report should not be merged with every other
nearby report regardless of type, direction, or time.

I would keep report evidence separate from the resulting incident and its routing
effect. Retry identity preserves one report, while several independent reports
can increase confidence. Moderation or trusted feeds can promote a closure to a
hard constraint under explicit rules.

The UI should state whether a report was accepted, merged with an existing incident,
or failed. It cannot infer success from an HTTP success response if the backend
has not actually recorded an incident or report.

### Put privacy controls on the actual data path

Observation uploads should be optional and bounded. Precise traces need short
retention and restricted access; aggregate traffic can have a different policy.
Rotating an identifier does not eliminate the identifying information in a journey.

I would remove origins, destinations, and probe bodies from ordinary diagnostic
logs. Correlation can use request, event, and release IDs without making every
support log another permanent copy of location history.

## 🔧 Deep dive 3: guidance under uncertainty — 9 minutes

### Define when a preview becomes guidance

Pressing Start should create a navigation state tied to the accepted route.
It starts foreground position observation, establishes progress, and shows the
next meaningful maneuver. A fixed initial ETA and a boolean flag are insufficient.

I would retain the accepted geometry and maneuver bundle locally for the active
trip. Progress is computed along that route, using a plausible nearby segment
and the previous position to avoid jumping between overlapping roads.

Distance to a maneuver is distance along the accepted path, not straight-line
distance to an arbitrary coordinate. A hairpin road illustrates the difference:
the next instruction can be geographically close but far away along the road.

Position quality can be good, uncertain, stale, or unavailable. The interface
should expose those states rather than moving a precise-looking marker through
unreliable fixes. It can retain the last reliable position without implying it
is a current observation.

### Reroute only when the evidence is strong enough

A single noisy sample should not trigger a new route. I would require sustained
distance from the accepted corridor, plausible direction, and adequate accuracy
before treating the driver as off route.

A reroute uses the current destination and options plus a new route generation.
While it is pending, the client keeps the accepted route, qualifies guidance as
needed, and prevents repeated requests from every subsequent position update.

When the response arrives, the client verifies that navigation is still active
and the destination is unchanged. It then adopts geometry, instructions, progress,
and ETA as one new generation.

| Approach | Benefit | Cost for this journey |
|----------|---------|-----------------------|
| ✅ Local progress with qualified server rerouting | Responsive guidance through brief network gaps | Position-quality logic and route replacement rules |
| ❌ Request server progress for every location fix | Centralized state | Network delay and outages interrupt immediate guidance |
| ❌ Reroute on every apparent deviation | Reacts quickly to real changes | GPS noise causes route churn and distracting instructions |

> “I would accept a short confirmation window before rerouting because stable
> guidance matters. I would shorten it when several accurate samples establish
> that the driver has actually left the route.”

Traffic-only rerouting also needs a benefit threshold and a cooldown. Changing
roads for a few seconds of uncertain ETA improvement can create more disruption
than value. A verified closure is a different event and deserves a stronger
response than a minor estimated speed change.

### Be precise about offline behavior

During a short network interruption, the active route's stored geometry and
instructions can support limited foreground guidance if position remains available.
That does not imply new route calculation, search, or a complete offline basemap.

Offline regional maps require licensed downloadable data, storage budgets,
versioned packages, update rules, and a compatible local routing engine. They
should be designed explicitly rather than inferred from ordinary browser caching.

On reconnect, refresh traffic and check route compatibility without destroying
the accepted trip first. If a new graph release cannot interpret the old route,
request a replacement and explain the transition to the user.

Permission denial, tab suspension, and stale location are distinct from network
failure. A foreground browser cannot promise native background navigation simply
because it has a geolocation API.

### Keep instructions usable beyond the map

The route panel provides a textual alternative to interpreting a polyline.
Maneuvers need ordered labels and distances; traffic severity needs more than
color alone. Icon controls need accessible names and usable touch targets.

Announce meaningful instruction changes rather than every position update. Honor
reduced-motion preferences for decorative camera movement, and allow a user to
pan away from follow mode without the map immediately pulling them back.

## 📈 Scale, validation, and implementation boundary — 6 minutes

### Scale the expensive paths independently

Route workers scale by regional demand and graph memory. Prewarm graph releases,
retain compatible old versions during active requests, and budget temporary
rollout memory. Reject malformed requests before CPU-intensive search.

Ingestion scales by region and segment partitions, with protections for hot roads
and large batches. At one million observations per second, even short retention
and deduplication windows require explicit storage sizing.

Basemap traffic is mostly a caching and delivery problem. Search needs text and
spatial retrieval. Navigation needs local responsiveness and controlled refresh.
Combining all four in one synchronous request path would couple unrelated failures.

### Validate the user-visible promises

I would measure frame time, long tasks, stale-response rejection, search latency,
route latency by journey length, invalid endpoint snaps, and traffic age/coverage.
Server reachability alone cannot tell us whether the traffic on screen is current.

The most revealing scenarios cross the browser/server boundary:

- A destination changes while the previous calculation is delayed.
- Clearing a trip invalidates an in-flight response and stops guidance.
- A camera command settles without causing a command/event feedback loop.
- Duplicate, late, or inaccurate probes do not create confident false congestion.
- A road closes or a graph changes while a route is already accepted.
- GPS becomes noisy and the network disconnects during a maneuver sequence.

These require controlled clocks, data, and response ordering. A map-container
smoke test is useful for startup but does not validate any of those promises.

### Connect the design to the local project

The repository uses React, Leaflet, and Zustand with an Express API, PostGIS,
and Valkey. It displays real basemap tiles around a synthetic 400-node road grid
and 35 randomly positioned named places. The graph does not reproduce the roads
visible in those tiles.

Its A* solver uses a whole-graph traffic snapshot. Each API process generates
traffic every ten seconds; GPS ingestion changes only that process's memory.
There is no durable observation stream or accelerated routing index.

The current browser has no continuous position watch or working maneuver
progression. Endpoint edits and cleared trips are not protected against stale
route responses. Incident writes have schema and idempotency defects, and the
camera/store connection has an unguarded feedback risk.

Those boundaries are documented in the [architecture](./architecture.md#implementation-notes).
I would first make the current trip's identity and legal route semantics reliable,
then connect durable traffic and position-quality handling. That order makes the
user journey understandable before increasing scale or feature breadth.
