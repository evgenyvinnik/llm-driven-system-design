# Distributed Cache — Frontend System Design

A 45-minute interview discussion about an operator console. This is a proposed design,
grounded in the local project rather than a claim that every feature below is implemented.
I would draw one architecture and spend the rest of the time explaining observations,
requests, and consequential actions.

## 🎯 Scope and the operator's problem — 3 minutes

> “I’m designing a console for engineers who need to understand a cache and occasionally change it. The hardest frontend problem is telling them what we know, how recently we learned it, and which actions actually completed.”

I would first clarify whether this is a teaching cluster or a production administration
tool. The local project supports exploration; for this interview I will assume a production
console for a regional, shared cache of rebuildable application data.

The application using the cache owns the durable origin. A cache miss can be acceptable,
but a sudden wave of misses can overload that origin. The console therefore needs to
explain the consequences of a flush or node transition in terms of refill work, not just
disappearing rows.

The main user journeys are straightforward: assess cluster condition, inspect a specific
key, investigate a capacity imbalance, and carry out a scoped administrative change. I
would make the overview read-only and keep experimental writes in an explicitly identified
environment and namespace.

I am not designing a general metrics platform, an incident-management system, or a database
browser. Historical trends can come from a metrics backend later. The first screen needs
useful current observations and a clear path to the relevant node or key.

A key distinction is that “the owner is node B” and “node B contains the value” are
separate facts. Routing can change before data moves, and an entry can expire between a
listing and inspection. The UI should not collapse these into one confident location label.

The local implementation already has overview, keys, cluster, and test routes. It uses
React, TanStack Router, Zustand, and a coordinator HTTP API. That is a reasonable starting
point for the interview design.

## 📏 Scale, freshness, and useful budgets — 4 minutes

I will size the console for 100 cache nodes, millions of keys, and 200 simultaneous viewers
during an incident. Those are planning assumptions, not measured limits of the repository.

| Concern | Proposed target | Reason |
|---------|-----------------|--------|
| Initial overview | Useful cached observation within one second | Operators need orientation quickly |
| Health observation age | Usually below ten seconds | Includes collection and browser refresh delays |
| Key inspection | One bounded value preview | A large object must not freeze the page |
| Browser requests | One active observation request per view | Slow responses must not create a queue |
| Key listing | Bounded, paginated scan | Millions of keys cannot be loaded at once |
| Mutation feedback | Immediate pending state, authoritative outcome later | Responsiveness does not require pretending success |

A five-second browser interval does not guarantee data is at most five seconds old. The
server might have sampled a node just before the last interval, and a slow node can extend
collection. I would show the server sample time and browser receipt time separately where
the distinction matters.

Two hundred viewers polling every five seconds create forty overview requests per second.
If every request separately reads stats and lists keys from all 100 nodes, that becomes
8,000 node requests per second, before normal health probes.

The request count alone is not proof of an outage. The concern is the work behind those
requests: key enumeration can scan large maps and allocate arrays. A dashboard that appears
lightweight in the browser can create expensive work in the cache.

I would collect bounded node observations once and serve the same recent envelope to many
viewers. At one collection every five seconds, a 100-node pass averages twenty node samples
per second, with bounded concurrency rather than one uncontrolled burst.

The console's performance budget therefore starts at the API contract. Smaller React
components cannot compensate for an endpoint that scans every key for each viewer.

## 🏗️ Architecture and state ownership — 5 minutes

```
┌─────────────────────────┐
│ React operator console  │
│ Overview / keys / admin │
└─────────────────────────┘
             │ authenticated requests
             ▼
┌─────────────────────────┐
│ Console API             │
│ Samples + operation IDs │
└─────────────────────────┘
             │ bounded collection and control
             ▼
┌─────────────────────────┐
│ Membership + cache API  │
│ Versioned node routing  │
└─────────────────────────┘
             │
             ▼
┌─────────────────────────┐
│ Independent cache nodes │
└─────────────────────────┘
```

The browser talks to one authenticated console API. It does not discover arbitrary node
URLs and call them directly. The backend owns routing and authorization; the browser owns
presentation and interaction.

The data path and observation path need not be separate deployments initially. They do need
separate budgets, so opening the console cannot exhaust the capacity reserved for
application reads.

I would organize routes around questions: “Is the cluster serving?”, “What happened to this
key?”, and “What would this change affect?” A test route belongs in a development
environment, with server-enforced scope if it can write.

| State | Owner | Example |
|-------|-------|---------|
| Placement and sampled health | Server | Membership version, node sample age |
| Key search context | URL | Namespace, pattern, selected key |
| Cached query result | Query/store layer | Page tied to its request and placement version |
| Draft input and selection controls | Component | Value editor, expanded detail |
| Administrative operation | Server, mirrored in UI | Pending or partially completed removal |

Zustand is adequate for a small console, provided server data is keyed by query identity. A
single global loading flag is not enough when overview refresh, key inspection, and node
removal can overlap.

I would keep the selected namespace and key in URL state so another operator can open the
same view. Cached values and credentials do not belong in a shareable URL. Navigating to a
URL starts a fresh authorized query; it does not certify a historical observation.

Static typing helps development, but it does not validate a server response. The API
boundary should validate the fields needed to render safely and convert transport errors
into a consistent client error model.

The frontend does not need to reproduce the consistent-hash algorithm. A backend placement
endpoint is the authority for the version the cluster accepts. A local educational
visualization can explain the algorithm without being used to authorize a mutation.

## 🔧 Deep dive 1: An honest view of partial observations — 9 minutes

> “I want one understandable observation envelope, but I won’t call it an atomic snapshot of a distributed system. The envelope must tell me which topology it describes and which node samples are missing or older.”

### Why independently fetched panels are tricky

Imagine the topology panel reports four nodes, the statistics request finishes using three,
and the key listing returns a key from a node that has just left. Each result can describe
a real observation while the combined page suggests a state that never existed.

Fetching everything through one endpoint makes response handling simpler, but the backend
still samples nodes at different times. It cannot create simultaneous measurements just by
returning one JSON object.

I would include a membership version, collection start/end times, expected nodes, and
per-node outcomes. When membership changes during collection, the response can report that
change or require the client to refresh before enabling a topology-dependent action.

An old sample can remain useful. The page should label it as the last successful
observation, with its age, rather than discard it or display it as current.

### The data contract drives the UI

| Observation | Display |
|-------------|---------|
| All expected samples present | Aggregate with collection interval |
| One node unavailable | Aggregate labeled “from 99 of 100 nodes” |
| Previous value retained after failure | Last known sample and age |
| Membership changed | New topology; older key pages marked stale |
| No nodes configured | Genuine empty-cluster state |
| Coordinator unreachable | Unknown current state, not zero nodes |

This costs a little screen space, but that space explains how much confidence an operator
should place in a number. Hiding failed nodes from a sum can make a failure look like
reduced memory pressure.

I would compute hit rate from successful sample counters by summing hits and misses, not
averaging percentages across nodes. A node with ten requests should not carry the same
weight as one with a million.

Even the weighted value needs a label: it is the cumulative hit rate over the included
nodes' counter lifetimes. A rate over the last minute needs interval deltas and reset
handling. The UI should not invent that time window from one cumulative sample.

### Request ordering is part of correctness

Suppose an operator selects key A, then key B. If A's slower response arrives last, a naive
component can show A under B's selection. I would bind the response to a request generation
and key identity before accepting it.

Cancellation reduces wasted work, but generation checks are still useful because
cancellation may happen after a response is already completing. The invariant is that a
response for an obsolete selection cannot replace the current detail.

The same rule applies to pattern search and namespace changes. A previous page must not
appear under a newly typed search. I would reset or mark the old results explicitly while
the new request is pending.

### Ownership and presence

The detail view should show the node that actually served the value and the placement
version used. A separate owner lookup may report where a future request would go. If those
observations differ, present the difference rather than choosing whichever response arrived
later.

A listed key can disappear through expiration or eviction before inspection. That is a
normal miss, not necessarily a frontend bug. I would leave the row's context visible and
say the value was absent at inspection time.

TTL is also a sample. A local countdown can help interpretation, but it cannot prove the
server still holds the value. At zero, label the observation expired and offer a refresh;
do not claim a server deletion happened at that instant.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Observation envelope with coverage and versions | Makes uncertainty inspectable | Richer API and rendering states |
| ❌ Render whichever panels finish | Very simple initial implementation | Mixed generations and hidden partial totals |
| ❌ Freeze all writes to take a global snapshot | Stronger observation boundary | Disrupts a live cache for a monitoring screen |

The alternative of independent requests is still workable when each panel carries its own
provenance and no combined guarantee is implied. I prefer one envelope for the overview
because it makes correct use the easy path, while key inspection remains a separately
identified observation.

## 🔧 Deep dive 2: Freshness without expensive observation — 8 minutes

> “I would begin with modest polling of shared observations. The important optimization is to collect once and serve many viewers; changing the browser transport alone does not remove expensive node scans.”

### Choosing a refresh mechanism

Five-second polling is easy to operate and sufficient for many human decisions. I would
schedule the next request after the previous one completes, add small jitter, and enforce a
timeout. A fixed interval that starts another request while the last one is still pending
can accumulate work during the very incident being observed.

Manual refresh should coalesce with an in-flight request or deliberately replace it.
Repeated clicks should not create parallel observation passes.

When the page is hidden, pause or substantially slow polling. Resume with one refresh when
it becomes visible. If requests fail, back off and show age; do not make repeated failures
produce a faster retry loop.

SSE becomes attractive if operators need faster one-way updates or many viewers repeatedly
fetch unchanged envelopes. The backend can push a new observation identifier and changed
samples. It still needs a bounded collection loop and per-client output limits.

WebSockets are reasonable when the product requires an ongoing bidirectional protocol.
Ordinary administrative commands can remain HTTP requests with explicit outcomes, so I
would not choose a socket merely because the screen is “live.”

| Approach | Why I would choose or defer it |
|----------|--------------------------------|
| ✅ Poll shared observations | Small protocol, bounded server work, simple recovery |
| ❌ Poll each node from each viewer | Multiplies collection work and duplicates topology logic |
| Deferred SSE | Useful for many viewers or tighter freshness needs |
| Deferred WebSocket | Adds connection lifecycle without a present bidirectional requirement |

### Browsing keys is a different workload

The overview needs counters and node samples; it does not need a key list. I would remove
enumeration from background overview refresh entirely.

The key browser uses explicit Search or debounced input and a bounded cursor. The server
limits work per page, not just returned rows. A scan that visits ten million keys and
returns ten rows is still expensive.

Pagination through a live cache is not a perfect census. Keys can be added, evicted, or
expire between pages. The response should state the scope and scan version; a topology
change may invalidate the cursor and require restarting the scan.

For stable results at a particular time, the system would need a separate snapshot/export
facility with a different cost model. I would not make interactive browsing pay that cost
by default.

### Rendering and previews

A virtualized list helps when a fetched page contains enough rows to make rendering
expensive. Stable row identity should include namespace and key, plus physical source if
the view intentionally exposes duplicate copies during diagnosis.

Virtualization does not reduce network payload or backend enumeration. Server pagination
and browser windowing solve different problems, and I would introduce each where
measurement justifies it.

Large values need a size-limited preview and an explicit fetch/download path, subject to
permission. Serializing a huge object into a pretty-printed string can block the main
thread even if the surrounding layout is small.

The ring view should answer a specific question. For three nodes, a compact diagram is
educational. For a hundred, a sorted distribution chart or table communicates imbalance
more clearly than hundreds of tiny arcs.

I would show ownership share, stored bytes, and request rate as separate measures. Equal
arcs do not mean equal memory or equal load. A hot key can overload one node despite an
evenly divided ring.

### What this choice gives up

Polling permits visible delay. Shared collection also means an operator cannot demand a
fresh probe of every node for free. An explicit diagnostic refresh may be useful, but it
needs a separate budget and a visible completion state.

The benefit is predictable work when many operators open the console. I would accept
several seconds of clearly labeled age before accepting unbounded enumeration that competes
with application traffic.

## 🔧 Deep dive 3: Administrative actions with truthful outcomes — 8 minutes

> “A responsive console can show that a request is pending immediately. It should wait for evidence before saying a node was removed or the cluster was flushed.”

### Consequence determines the interaction

Reading a key needs no confirmation, although it still requires permission because values
may be sensitive. Removing a node or flushing a namespace can create a surge of origin
reads. Those actions deserve a preview of scope and a short, specific confirmation.

The preview should identify environment, namespace or node, placement version, available
refill headroom, and estimated impact. Estimates need coverage and age; a sample of 1,000
keys cannot be presented as the exact number affected in a million-key shard.

The backend must bind the accepted operation to the expected placement version. If topology
changed after preview, the UI should request a new preview. A frontend confirmation alone
cannot prevent an obsolete request or a direct API call.

### Long-running operations need identities

For node changes I would use a server operation resource. The initial response returns an
operation ID; later responses identify pending work, completed targets, failures, and
whether the operation can be resumed.

The UI can navigate away and return using that ID. The operation's lifetime should not
depend on an open browser tab or an in-memory component promise.

| Outcome | User-visible meaning |
|---------|----------------------|
| Accepted | Server registered the operation |
| Running | Some work remains |
| Completed | Defined completion condition satisfied |
| Partially completed | Named targets succeeded; others remain or failed |
| Unknown after timeout | Request may have taken effect; reconcile by operation ID |

A 200 response containing some failed node results is not a successful cluster-wide flush.
The client should inspect the operation contract, not just HTTP status.

### Why I avoid optimistic topology changes

Removing a node card immediately can hide a failure to remove it. Rolling the card back
later does not undo any migration already performed by the server. This is different from
optimistically toggling a local preference.

I would keep the node visible with a pending action badge, disable duplicate submissions
for that operation, and refresh from the authoritative result. Unrelated inspection stays
usable.

A lost response is especially important for increment. If an increment was applied but its
response disappeared, retrying can apply it twice. Unless the backend provides a receipt
for the same logical operation, the console should report an unknown outcome and inspect
current state rather than automatically replay it.

SET is not universally harmless to replay either. A relative TTL restarts on each attempt,
and another writer may have changed the key in between. Version conditions matter when the
user means “replace the value I inspected.”

### Keep experimentation bounded

The local Test page can write arbitrary keys and perform 100 sequential SETs. In a
production console I would place that capability in a dedicated development environment, or
enforce a small test namespace with expiry and quotas at the API.

A UI prefix is useful feedback but not access control. The server must reject requests
outside the allowed scope, even if someone edits the request in browser tools.

I would cap the result log, preserve inputs after failures, and distinguish malformed JSON
from an intentional string. Quietly treating every parse error as a string can store a
different value type than the operator intended.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Pending state plus server operation result | Accurate during partial failures and navigation | Requires backend operation tracking |
| ❌ Optimistic success then local rollback | Fast-looking first response | Cannot reverse distributed effects |
| ❌ Confirmation for every interaction | Uniform implementation | Trains operators to dismiss prompts |

I am giving up the appearance of instant completion, not immediate feedback. The pending
state can be fast, clear, and useful while the actual work remains asynchronous.

## 🔐 Access, accessibility, and verification — 5 minutes

The browser should authenticate a person through a session and receive only their permitted
views and actions. A backend can hold a service credential, but it must authorize each
request before forwarding it. Keeping a key out of JavaScript does not prevent an
authenticated user from issuing an unauthorized command unless the server checks scope.

The current frontend sends no admin key, so protected node controls fail. That is an
integration gap; it is not evidence of a working login flow. Conversely, current public
data and flush endpoints are not made safe by hiding controls in the UI.

For accessibility, health needs a word or symbol in addition to color. Action controls need
proper labels, keyboard focus, and an intelligible pending state. I would announce
meaningful health changes politely rather than every polling update, which would overwhelm
a screen reader.

Small screens can collapse node details and move the key inspector below the list. Long
URLs and keys should wrap or truncate with a way to inspect the full value. A fixed
navigation row should not push primary actions out of reach.

The most valuable frontend tests exercise ordering and uncertainty:

| Scenario | Expected behavior |
|----------|-------------------|
| A selected, then B; A returns last | B remains selected and displayed |
| One node sample fails | Partial total and failed node remain visible |
| Membership changes during preview | Old preview cannot submit silently |
| Flush finishes on only some targets | Per-target outcomes, no blanket success |
| Tab hidden, then visible | Polling backs off, then refreshes once |
| Inspection of expired key | Clear miss with prior listing context |

These can be deterministic contract/component tests. A small real-cluster smoke test then
verifies routing, authentication integration, and one operation lifecycle. The repository's
three existing page checks do not prove these behaviors.

## ⚖️ Decisions and implementation boundary — 3 minutes

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Overview data | ✅ Versioned observations with coverage | ❌ Unqualified totals | Missing nodes must remain visible |
| Refresh | ✅ Shared collection plus modest polling | ❌ Full fan-out per tab | Bound work during incidents |
| Node changes | ✅ Pending operation with receipts | ❌ Optimistic completion | Distributed effects can be partial |
| Key browsing | ✅ Bounded scan and preview | ❌ Entire keyspace in memory | Control backend and browser work |

The current application has the four routes, local component state, an overview store,
five-second polling, and basic HTTP operations. It does not have placement versions, shared
observation snapshots, cursor pagination, request-generation checks, authenticated
sessions, or durable administrative operation records.

Those gaps define a practical first iteration: make incomplete results explicit, remove
unused enumeration from overview polling, prevent obsolete responses from replacing current
selections, and connect scoped administration through a real authorization boundary.

> “The console succeeds when an operator can explain what a number includes, identify when a result is uncertain, and carry out a change without confusing acceptance with completion. Those are the frontend guarantees I would establish before adding a more elaborate ring animation.”
