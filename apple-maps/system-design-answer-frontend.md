# Apple Maps — frontend system design interview

> “I would start with route planning on an interactive map, then add a navigation
> mode that handles uncertain position and intermittent connectivity. The browser
> must keep the map responsive without mixing old requests, new destinations, and
> instructions from a route the user has already replaced.”

This is a proposed 45-minute design. I would draw one diagram and use three deep
dives: camera/layer ownership, route planning, and navigation under uncertainty.
The local project's implemented scope is described at the end.

| Discussion | Minutes |
|------------|---------|
| Scope and user experience | 5 |
| Frontend architecture and contracts | 6 |
| Deep dive: responsive map and layers | 10 |
| Deep dive: search and route planning | 9 |
| Deep dive: navigation and connection loss | 9 |
| Accessibility and verification | 4 |
| Trade-offs and local implementation boundary | 2 |
| Total | 45 |

## 🎯 Scope and user experience

I would clarify whether this is a browser map or a native navigation client.
I will design a browser experience for place search, driving-route planning, and
foreground guidance. Native background location, CarPlay, and voice integration
have additional platform contracts and are outside this answer.

The user can move the map, choose a destination, compare a primary route with
supported alternatives, start guidance, and return to browsing.
Traffic overlays should state their freshness, while a route includes the graph
and traffic versions used to compute it.

A brief connection loss should not erase the accepted route.
It does limit fresh search, traffic, and rerouting unless appropriate offline data
and a routing engine are already available locally.
I would distinguish retaining a route from promising a complete offline map product.

The frontend requirements I would defend are:

- Dragging and zooming feel responsive on the target devices.
- Every displayed route belongs to the current endpoints and preferences.
- The user can inspect the map without the camera constantly snapping back.
- Uncertain position does not trigger a cascade of contradictory instructions.
- Errors preserve useful context and have an accessible recovery action.

I would set a frame-time budget for target mobile hardware, then measure it with
representative dense maps. Choosing WebGL or React does not by itself guarantee
60 frames per second; image transfer, layer count, layout, and device limits matter.

> “A map can look smooth while showing a route for yesterday's destination.
> Responsiveness and result identity need separate design and verification.”

## 🏗️ Frontend architecture and contracts

I would keep one map renderer mounted while panels and route state change.
The renderer owns frame-by-frame camera movement and geometry drawing.
React owns controls, accessible text, selected results, and workflow state.

```
┌────────────────────────────────────────────────────────────┐
│ Search / route planner / navigation panel                  │
└─────────────┬────────────────────────────────┬─────────────┘
              ▼                                ▼
┌───────────────────────────┐    ┌───────────────────────────┐
│ Route and request state   │    │ Map renderer              │
│ Accepted generation       │───▶│ Camera, tiles, layers     │
└─────────────┬─────────────┘    └─────────────┬─────────────┘
              ▼                                ▼
┌───────────────────────────┐    ┌───────────────────────────┐
│ API client + query cache  │    │ Viewport data scheduler   │
│ Results keyed by context  │◀───│ Bounded layer requests    │
└─────────────┬─────────────┘    └───────────────────────────┘
              ▼
┌────────────────────────────────────────────────────────────┐
│ Routing / search / traffic APIs + versioned tile source    │
└────────────────────────────────────────────────────────────┘

```

There are four useful kinds of state:

| State | Owner | Example |
|-------|-------|---------|
| High-frequency rendering | Map engine / small adapter | Camera position during a drag |
| User intent | React or a small shared store | Destination, avoid-toll preference, follow mode |
| Server results | Query cache keyed by inputs | Places, traffic cells, route response |
| Active guidance | Navigation state machine | Accepted route generation and progress |

A query cache is useful, but not required to be a particular library.
The important property is that results are associated with their request context.
A single global result slot and loading flag cannot express these independent flows.

The route contract should include request generation, endpoint identity, route
geometry, maneuver positions along the route, duration, and graph/traffic metadata.
Traffic responses need observation age and coverage, not only a congestion color.
Position samples need timestamp and accuracy, not only latitude and longitude.

I would choose a renderer based on product needs.
Leaflet is sufficient for a simple raster map with moderate overlays.
A vector/WebGL renderer supports dynamic styling and rotation at higher complexity.
The adapter should isolate renderer-specific calls without pretending their
performance and interaction models are perfectly interchangeable.

## 🔧 Deep dive 1: Responsive map and layers

> “I would let the map engine handle the gesture loop, and publish a settled
> viewport to application state. React should not round-trip every animation
> frame back into a command that moves the map again.”

### Camera ownership

The camera has several sources of movement: direct user gestures, a search result,
fit-to-route, and navigation follow mode. I would make the source explicit.
A user gesture updates observed viewport state, while a deliberate command asks
the engine to move to a new target.

Blindly mirroring every move event into a store and then calling setView from an
effect can create a feedback loop. Even an apparently unchanged camera command may
emit another map event. The adapter needs equality checks and a distinction between
observed movement and commands initiated elsewhere.

Follow mode is a small state machine: following, browsing, or recenter requested.
When the user drags the map during guidance, I would enter browsing mode and show
a clear recenter control. A position sample should not immediately undo that choice.

Fitting a route also accounts for the visible bottom sheet and search panel.
A mathematically correct bounding box can still hide the destination beneath a
panel. When the panel changes size, update the renderer's usable area deliberately.

### Viewport data scheduling

Raster/vector tile scheduling belongs largely to the map engine.
Application overlays such as traffic and POIs need their own bounded requests.
I would request data after movement settles, with cancellation and a viewport
identity so late results cannot replace the current area.

Fetching one exact floating-point bounding box per tiny pan has poor cache reuse.
A spatial cell or tile key with a modest buffer gives reusable chunks.
The visible layer composes the chunks needed for the current viewport, rather than
storing a single unqualified “current traffic” array.

At the date line, the viewport may wrap longitude. The API/cache contract must
split or normalize that area consistently; treating west greater than east as an
ordinary empty rectangle would lose visible data.

I would bound features by zoom level and product relevance.
A city overview does not need every individual POI marker. Clustering or selecting
a representative subset reduces work and visual clutter.
When zoomed in, finer detail can load without rebuilding the whole map component.

### Static and dynamic layers

Base geometry changes more slowly than traffic.
I would cache versioned map data independently and refresh traffic on a bounded
schedule while the relevant view is active. Turning a layer off cancels unnecessary
work but need not destroy every reusable cached chunk immediately.

A failed traffic refresh can retain the last layer with an age indicator.
After its useful-age threshold, show unknown data or remove the misleading color.
Green must mean a supported free-flow estimate, not “the request returned nothing.”

The route should remain visually above optional traffic where they overlap.
Use stable feature IDs and update only changed geometry or style properties.
Recreating thousands of markers because a search spinner changed wastes both CPU
and memory, even if the underlying renderer is fast.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Renderer-owned gestures plus settled viewport state | Smooth interaction with controlled data fetches | Adapter and camera-source rules |
| ❌ React/store update for every camera frame | One apparent state owner | Repeated renders and possible command/event loops |
| ❌ Fetch every visible feature on every move | Simple query shape | Redundant requests and unbounded rendering work |

I would choose raster or vector rendering after measuring the real map style.
Vector tiles enable richer client styling but are not universally smaller, and
custom gesture libraries can conflict with a renderer that already handles gestures.

## 🔧 Deep dive 2: Search and route planning

Search expresses intent; selecting a place identifies a destination.
I would keep typed input separate from the selected place, because changing the
query text should not silently change an already accepted destination.

### Search behavior

A short debounce reduces requests while typing. It does not solve request races.
Every request includes query and location context, and its results stay keyed to
that context. A result from an older query cannot reopen a cleared dropdown.

The location context should be visible in product terms: near the map, near me,
or in a named region. Searching while panning should not silently switch between
these modes. A user looking for a hotel in another city may not want a hard nearby radius.

I would provide keyboard selection and clear empty/error states.
A successful search with no matches differs from a dependency failure.
Recent destinations are useful but should be a deliberate local/account feature,
with a clear way to remove them.

Selecting a result commits its identity and access location, closes suggestions,
and optionally adjusts the camera. Updating the input to the result's name should
not trigger a new autocomplete loop that immediately reopens the dropdown.

### Planning state

The route request depends on origin, destination, travel profile, preferences,
and relevant departure-time assumptions. I would derive a request generation from
that intent and mark an existing route stale when those inputs change.

The browser may keep the old line visible while recalculating, but it must indicate
that it belongs to the previous plan. Starting guidance is allowed only for a
confirmed route matching the accepted current intent.

Consider dragging the destination twice while the first request is slow.
The second result can arrive first. The browser accepts only the newest applicable
generation; it does not let completion order choose the destination.
Cancellation saves resources, while generation checking provides correctness.

Clearing a route invalidates its outstanding generation too.
Otherwise a response arriving after Clear can redraw the line and resurrect a trip
the user deliberately removed.

### Route response and display

The server returns geometry plus maneuver positions measured along that geometry.
I would validate the response shape at the API boundary and use a consistent
coordinate convention. Many rendering APIs use longitude/latitude arrays while
application models use named latitude/longitude fields.

The response also identifies snapped endpoints and any access connectors.
If the destination lies outside supported coverage, the UI should explain that
instead of drawing an arbitrary long connector with a zero-minute route.
The client cannot repair an illegal route by making its line look plausible.

Alternative routes need meaningful distinction and coherent selection.
The active line, maneuver list, ETA, and Start action all reference one selected
route identity. Selecting a new alternative should not leave guidance from the old one.

I would preserve the planning context on reload only if the product wants that
behavior. Restoring a destination is different from automatically resuming location
tracking or navigation; those require an explicit mode decision.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Explicit intent and accepted route generations | Safe edits, clearing, and overlapping requests | More states than one route object |
| ❌ Last response wins | Very little coordination | A late request restores obsolete directions |
| ❌ Clear all context on every error | Simple reset path | User repeats destination selection and loses useful work |

> “I would keep the user's intent stable while the network catches up, and make
> it obvious when the visible route is still being updated.”

## 🔧 Deep dive 3: Navigation and connection loss

The navigation loop receives uncertain observations, not a perfect moving point.
A position can be old, noisy, or on a nearby parallel road.
I would use timestamp, accuracy, and route continuity before advancing instructions.

### Local progress

The accepted route and its maneuver offsets remain on the client.
A position is matched to plausible positions along that route, considering recent
progress and heading when reliable. Remaining distance is distance along the route,
not straight-line distance to the next instruction marker.

A road may curve around a block while its next turn is physically close.
Straight-line proximity can announce that turn as reached too early.
Loops and overpasses also require continuity, so nearest geometry alone is insufficient.

I would reject out-of-order or excessively old position samples and avoid jumping
progress backward because of a single noisy fix. Accuracy thresholds should depend
on observed device/route conditions, rather than one universal 50-metre rule.

The displayed ETA can be updated from remaining route costs and fresh traffic.
It should carry an estimate status when traffic or position is stale.
A timestamp computed once at Start is not a live ETA model.

### Off-route handling

Off-route detection should require a pattern of evidence, with hysteresis.
One uncertain sample near a turn can show “Locating” while retaining the accepted
route. Sustained deviation can trigger a reroute using the latest suitable position.

I would allow one relevant reroute at a time and replace obsolete work when intent
or position changes substantially. A cooldown or minimum expected benefit prevents
continual rerouting as estimated travel times fluctuate.

A reroute response has its own generation. Accepting it swaps geometry, maneuvers,
and progress together. Applying a new polyline while retaining the old maneuver
index can tell the user to take a turn that is no longer on the route.

### Connectivity and permission states

| Situation | User-visible behavior |
|-----------|-----------------------|
| Position permission denied | Keep manual planning available; explain how location changes the experience |
| Position uncertain | Hold progress conservatively and show uncertainty |
| Traffic refresh fails | Retain a bounded-age estimate and mark freshness |
| Network lost | Keep accepted route/instructions; show unavailable live capabilities |
| Rerouting unavailable | Preserve context and explain that a new route cannot be obtained |
| Navigation stopped | Stop the location watch and related background work |

I would not send every position to the server before rendering local progress.
The server receives only what is necessary for agreed functions, such as rerouting
or a consented traffic contribution. Traffic probes and private local guidance are
separate purposes with separate retention and identity needs.

### Offline scope

Caching a displayed route helps during short outages.
Arbitrary offline rerouting requires a compatible regional graph, restrictions,
and a local routing engine. Offline search and base tiles add further storage.
Packages need versions, coverage boundaries, updates, and an eviction policy.

For the first version, I would commit to retaining the accepted route and state
the limits clearly. A later offline feature must use a data source that permits
packaging, rather than bulk-prefetching the public demo tile service.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Local progress with conservative matching and bounded server refresh | Responsive guidance through short outages | Client state machine and uncertainty handling |
| ❌ Server round trip for every progress update | Central logic | Network delay can stall basic guidance |
| ❌ Immediate reroute on any distant sample | Quick response to real deviation | Noise produces route thrashing and contradictory instructions |

## ♿ Accessibility and verification

The map needs a usable text counterpart: search results, route summary, and a
maneuver list. Keyboard users need a destination-selection path that does not
require clicking a geographic point or dragging a marker.

Instructions should be announced when meaningfully changed, not on every position
sample. Controls need accessible names, and traffic information should use text
or patterns as well as color. Follow-mode animations should respect reduced-motion
preferences while preserving essential orientation.

I would test scenarios that reveal coordination defects:

- A camera command settles without recursively producing new camera commands.
- A slow previous viewport/query response cannot replace the current layer/results.
- Clearing or moving a destination invalidates a pending route response.
- Noisy and delayed positions do not skip maneuvers or repeatedly reroute.
- A new route atomically replaces its geometry, instructions, and progress.

Measure frame times on dense views, long tasks, retained feature memory, and the
age of displayed traffic. A screenshot of the map container cannot verify navigation.

## ⚖️ Trade-offs and local implementation boundary

The proposed frontend separates camera rendering, user intent, server results,
and accepted guidance. That separation makes each update's meaning inspectable
without making every movement depend on React renders or server round trips.

The local project uses Leaflet raster tiles, one Zustand store, map markers, search,
and a route panel. It has no query-cache library, vector/WebGL rendering pipeline,
continuous position watch, rerouting, voice, or offline packages.
Start only sets the initial navigation state and a fixed ETA.

The map/store camera loop lacks equality guards; route edits do not invalidate
old results, and the browser does not periodically refresh a stationary traffic
layer. Search errors appear as no results. Backend routes use a synthetic grid
whose geometry and names do not match the real basemap.

The [architecture](./architecture.md#implementation-notes) records those source
findings. I would first make camera ownership and request identity reliable,
then connect navigation to explicit position-quality and route-generation rules.
