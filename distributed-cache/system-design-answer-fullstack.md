# Distributed Cache — Fullstack System Design

A 45-minute interview answer balancing cache behavior with the operator's experience. This
is a proposed production design. The local repository implements a smaller teaching
version; the final section identifies that boundary. I would draw one system diagram and
walk through three situations that cross the frontend/backend boundary.

## 🎯 Start with the product and its contract — 3 minutes

> “The product has two users: an application that needs cheap access to rebuildable data, and an engineer who needs to understand and change the cache. Both need the service to be clear about what happened and what is still uncertain.”

The application sends GET, SET, and DELETE requests. It owns the durable origin and decides
how long a cached observation may remain useful. The operator inspects health, capacity,
placement, and selected values, then occasionally changes membership or clears a scope of
data.

I would clarify whether this service is allowed to lose entries. For this answer, yes: it
is a cache of rebuildable data with bounded staleness. It is not the only copy of a
financial balance, authorization decision, or durable counter.

Losing entries can still cause an outage by increasing origin traffic. That is the
connection between the cache design and the admin interface: a convenient Flush button can
remove the protection the application depends on.

The local project contains the cache nodes, a coordinator, and a four-page React dashboard.
It does not implement an application origin, automatic refill, replication, or a real
operator login flow.

I will propose one current owner per key, bounded refill after loss, and an authenticated
console. I would add replicas only if the required recovery behavior or measured origin
headroom makes one-copy storage insufficient.

## 📏 Scope, scale, and observable outcomes — 4 minutes

Assume a regional cache with 100 million entries, mean value size 1 KiB, and one million
operations/second at peak. Let 95% of requests be reads and 95% of reads hit. These are
assumptions for the interview, not results measured from the repository.

| Quantity | Estimate | Why it matters |
|----------|----------|----------------|
| Raw cached values | 102.4 GB | Excludes keys and runtime overhead |
| Values plus 200 bytes metadata/key | About 114 GiB | Initial storage model |
| Application reads | 950,000/second | Data-plane load dominates |
| Origin misses | 47,500/second | Baseline refill capacity |
| Console viewers | 200 simultaneous | Incident-driven observation load |

A node holding 1% of successful hits could add about 9,025 origin reads/second when it
disappears. That estimate connects failure recovery to a concrete budget. A node holding a
celebrity key could cause a much larger change.

I would target regional p99 below five milliseconds for admitted small-value cache
operations, separately from origin latency. For the console, a useful overview within a
second and normally sub-ten-second health observation age are reasonable starting targets.

These are different latency paths. A browser rendering a 100-node table does not need the
same response time as an application reading a single key. It does need to show how old the
table is.

Three outcomes should survive all the way from node to UI: a confirmed hit, a confirmed
miss, and an unavailable observation. A network failure must not become an empty value or a
zero-node cluster through a convenience default.

The local demonstration runs three nodes with ten thousand entries and a 100 MiB estimate
each. I would use it to validate behavior before attempting the production sizing scenario.

## 🏗️ One architecture, two request paths — 5 minutes

```
┌───────────────────────┐       ┌───────────────────────┐
│ Application services  │──────▶│ Durable origin        │
│ Cache-aside + budgets │       │ Application-owned     │
└───────────────────────┘       └───────────────────────┘
            │ cache operations
            ▼
┌───────────────────────┐       ┌───────────────────────┐
│ Router pool           │◀──────│ Membership authority  │
│ Deadlines + admission │       │ Accepted generations  │
└───────────────────────┘       └───────────────────────┘
            │
            ▼
┌───────────────────────┐       ┌───────────────────────┐
│ Cache nodes           │──────▶│ Observation/admin API │
│ Memory, LRU, TTL      │       │ Samples + operations  │
└───────────────────────┘       └───────────────────────┘
                                           │
                                           ▼
                               ┌────────────────────────┐
                               │ React operator console │
                               └────────────────────────┘
```

The application data path goes through a router to the accepted owner. The observation path
collects bounded samples for many viewers. These can share a deployment at first, but their
budgets and failure behavior should remain distinct.

The router pool holds an accepted placement version. A membership authority coordinates
changes; individual routers do not create conflicting ownership maps after observing
different timeouts.

At each node, a map finds entries and a doubly linked list tracks recency. The node checks
expiration before returning a value and enforces admission limits before accepting a
replacement. Storage is in memory, not a relational schema.

| Shared concept | Backend responsibility | Frontend responsibility |
|----------------|------------------------|-------------------------|
| Key identity | Namespace authorization and canonical key | Preserve identity across search and selection |
| Entry deadline | Reject expired values | Show sampled TTL/deadline with age |
| Placement version | Route and fence obsolete owners | Label observations and invalidate old previews |
| Partial observation | Include missing targets and sample times | Display incomplete coverage |
| Administrative operation | Track effect and outcomes | Show pending, partial, and completed states |

The local HTTP API uses TTL seconds and returns routing metadata on successful coordinator
data operations. It has no generation or operation receipt fields. I would evolve that
contract deliberately rather than assume TypeScript interfaces already supply these
guarantees.

React and TanStack Router are suitable for the four console routes. A query layer or
disciplined Zustand store can retain server observations by query identity. Draft inputs
remain local; shareable namespace and selected-key state belong in the URL.

There is no need for the browser to implement authoritative hashing. It can render an
explanatory ring, but it asks the backend which owner/version a request used. Otherwise
client and server implementations can disagree exactly when topology changes.

## 🔧 Deep dive 1: What does “SET succeeded” mean? — 9 minutes

> “I would walk a single operation through the entire stack. The UI should represent the promise the backend can actually keep, and the backend should not return success for a value it rejected or immediately discarded.”

### Follow the request

An engineer enters a key, a value, and a lifetime in a test namespace. The browser
validates the input for quick feedback and shows an in-progress operation without erasing
the draft.

The API repeats validation because browser checks are not a trust boundary. It verifies
namespace permission, key length, supported value shape, numeric lifetime, and size limits.
It routes using an accepted owner generation and an overall deadline.

The node checks that it is authorized to serve that generation. It evaluates the new entry
size against admission limits, including replacement of an existing value. Then it performs
the local mutation synchronously and returns the accepted metadata.

The UI reports that the value was accepted by that owner. It does not claim the origin
changed or that the value will remain a hit forever: eviction, expiry, and cache loss are
part of this service's contract.

For a user expecting to modify the durable application record, this would be the wrong form
entirely. The console must distinguish writing a cache value from editing the application's
source of truth.

### Define the wire semantics

| Result | Meaning in the console |
|--------|------------------------|
| Accepted | Current owner accepted the cache mutation |
| Validation rejected | No accepted mutation under this request contract |
| Capacity rejected | Entry exceeds an admission limit |
| Obsolete owner version | Refresh routing or reconcile according to operation type |
| Timeout after submission | Effect may have happened; outcome is unknown |

The last row prevents a common fullstack mistake. A client timeout is not proof that the
server rolled anything back. The request may have finished just before the connection
disappeared.

I would use a consistent error envelope with an operation/request identity and a
machine-readable reason. The UI can show useful text without trying to infer semantics from
arbitrary error strings.

### Why blind retries are unsafe

Suppose an increment changes a counter from 9 to 10, then the response is lost. Repeating
the request can change it to 11. There is no way for a generic fetch retry wrapper to know
whether that was intended.

SET also has subtle repeat effects. Replaying a relative TTL restarts its deadline, and
replaying an older value may overwrite a newer write from another client. DELETE can remove
a value recreated after the first delete.

If repeated-effect protection is required, the backend needs a scoped operation
identity/receipt or a conditional version. The UI must reuse that logical identity when
reconciling, rather than generate a new command on every click.

For this disposable cache I would keep durable counter semantics outside scope. The
operator can inspect current state after an ambiguous result, but inspection alone does not
prove whether a particular increment was the one that changed it.

### TTL and the origin observation

The local API takes TTL in seconds. Zero uses a positive node default if configured;
otherwise it means no expiration. I would make that distinction explicit in the form so
“zero” does not silently mean something different in another environment.

In the proposed production refill path, the application carries a freshness deadline
derived from the origin observation. Starting a full lifetime after a very slow origin read
can keep an already old value longer than intended.

The node stores the absolute deadline, checks it on reads, and preserves it during transfer
or snapshot recovery. Background expiration is for reclaiming memory; a read must not
return an expired value merely because cleanup has not reached it yet.

The UI can count down from a sampled deadline, but it cannot know whether eviction removed
the key earlier. At the displayed deadline, the observation becomes expired; another
request determines what the server currently holds.

### Admission affects the experience

Consider replacing a short string with a very large object. If only new-key insertion
enforces memory, replacement bypasses the limit. If an oversized new value is inserted and
immediately evicted, returning ordinary success is also misleading.

The server should reject a value that cannot fit under the entry policy, and the UI should
preserve the draft with the limit and attempted size. Large previews should be bounded
before they reach the browser's renderer.

Map and list updates are cheap, but serialization and evicting several entries are not
constant-time. This is why value-size limits help both backend latency and frontend
behavior.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Pending state plus explicit acceptance contract | Truthful across retries and cache loss | More outcome states to design |
| ❌ Optimistic “stored” followed by rollback | Looks immediate | Cannot undo server effects or resolve timeouts |
| ❌ Treat every mutation as retryable | Simple shared client | Repeats TTL, overwrite, or increment effects |

I am giving up optimistic completion, while keeping immediate progress feedback. The user
should never have to guess whether a red error banner means “rejected” or “possibly
applied.”

The local source demonstrates why this matters: existing-value growth skips eviction,
oversized new values can disappear despite SET success, and there is no operation
deduplication. Those are implementation gaps rather than intended cache semantics.

## 🔧 Deep dive 2: A dashboard for a system that changes while queried — 8 minutes

> “I would treat the overview as a set of observations with provenance. One response can organize the data, but it does not turn measurements from a hundred machines into one atomic instant.”

### Build an observation contract

A server collection pass records the membership version, expected nodes, collection
interval, and each node's success or error. The frontend renders from that envelope and
keeps the last useful observation when refresh fails.

If only 99 of 100 nodes responded, totals say so. If one node's last sample is older, the
node card shows its age. A failed request should not zero the counters and make the system
look suddenly healthy and empty.

The backend can aggregate successful samples, but it should not average hit-rate
percentages blindly. Sum the hits and misses of the included samples first, then calculate
the ratio. Also disclose that cumulative counters may span different process lifetimes.

A “last minute” rate requires deltas over time and reset handling. The fullstack contract
should name what a number means rather than let a label imply a time window the backend
never computed.

### Keep queries separate by purpose

The overview needs node condition and bounded counters, not every key. Key enumeration
belongs to an explicit diagnostic query with a cursor and server work budget.

The local coordinator limits responses to 1,000 keys, but each node scans its cache first.
A response limit alone does not make a scan cheap or complete. The production API must
distinguish returned rows, scanned scope, and whether more data remains.

Browsing a live cache is inherently subject to change between pages. A key can expire
between listing and inspection. The UI should explain that miss while retaining the prior
query context; it should not treat every disappearance as a system error.

A placement change can invalidate a scan cursor. That deserves an explicit restart path
rather than silently combining pages from incompatible routing versions.

### Prevent stale responses from winning

Suppose key A is selected, then B, and A's response arrives last. The frontend checks the
request generation and key identity before committing results. Cancelling obsolete requests
reduces work but does not replace this acceptance check.

Value inspection and owner lookup can also disagree because they are separate observations.
The detail view should prefer the owner metadata attached to the value response when
describing who served it, while identifying a later routing lookup as a different fact.

React keys should identify the displayed entity. If a diagnostic view intentionally shows
physical duplicates, key text alone is insufficient; source node and placement context
matter too.

### Bound the observer's load

Two hundred viewers refreshing every five seconds produce forty overview requests/second.
If each request fetches stats and key lists from 100 nodes, the backend performs 8,000 node
requests/second. Scans behind those requests can be much more expensive than the browser
suggests.

I would collect node samples once per interval with bounded concurrency, then serve them to
many viewers. Polling the shared result is a good baseline. Pause or slow background tabs
and schedule the next request only after the previous one finishes.

SSE is a reasonable later transport when many viewers need quicker one-way updates. It
still needs a shared collection loop and bounded subscriber queues. Switching to push does
not fix a backend that repeats a full scan for each viewer.

On the browser side, paginate first and virtualize when row rendering becomes material.
Limit value previews and result logs. A virtual list cannot compensate for downloading the
entire keyspace or pretty-printing a massive object on the main thread.

### The trade-off

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Shared observations with age/coverage | Bounded load and honest partial state | Some visible staleness |
| ❌ Unqualified independent panels | Easy first implementation | Mixed topology and misleading totals |
| ❌ Full live scans for every viewer | Seemingly fresh detail | Observation competes with application work |

Independent panels can still be valid if each carries its own timing and scope. I choose
one envelope for the overview because it helps the frontend present a coherent explanation,
not because it creates global transactional consistency.

The local dashboard currently polls info, stats, and keys independently, advances a shared
timestamp on individual successes, and has no request-generation checks. The proposed
contract directly addresses those observed weaknesses.

## 🔧 Deep dive 3: Changing nodes without hiding the consequences — 8 minutes

> “A node-change button needs an operation model on the server. The hard part is not the confirmation dialog; it is defining what happens to concurrent requests and what completion means.”

### Start with placement

Consistent hashing reduces how much assignment changes when membership changes. Adding a
fourth similarly weighted node to three is expected to move about a quarter of assignments.
That is an expectation over placement, not an exact fraction of bytes, requests, or
successfully transferred entries.

Virtual nodes improve distribution across many keys. They cannot split one celebrity key's
traffic, and they do not maintain data on replacement owners. The console should show
placement share, stored bytes, and traffic separately.

A production membership authority publishes an accepted version. Nodes enforce an ownership
generation so an old router cannot continue writing to an obsolete owner indefinitely.

### Why a warm-looking copy can be wrong

Suppose the ring now routes a key to B, while a migration reads its old value from A. A
client writes a newer value to B. The migration then overwrites B with the old copy.

The transfer can report success while damaging the observed value. A delete can race the
same way and be undone by a delayed copy. Smaller batches reduce load but do not establish
correctness.

The local implementation contains this kind of unversioned copy sequence. Its graceful
removal also migrates before removing the node from the ring, so correctly placed keys
still select the departing owner and are skipped.

### Choose a transition the application can afford

For rebuildable data, I would initially choose a bounded cold cutover. Prepare the target,
fence old-generation work, publish the new generation, and refill affected partitions under
an origin budget.

If the old owner cannot be fenced during a partition, affected cache operations may need to
wait for an enforceable ownership lease or fail explicitly. We cannot promise one owner
while allowing both sides to accept writes without restriction.

The transition proceeds in bounded groups so origin headroom determines the pace. Old
physical copies are not valid in the new generation. Returning nodes must not serve stale
disk snapshots simply because their health endpoint responds again.

This choice costs temporary misses. If origin capacity cannot tolerate those misses, I
would implement version-aware warm transfer or managed replicas, including concurrent
writes, deletion fencing, absolute TTLs, and a cutover barrier.

The trade-off is a real product requirement: retained warm hits cost capacity and
coordination. I would not claim that snapshots plus a hash ring provide replica-level
failure recovery.

### Connect the protocol to the interface

The UI requests a preview containing target, environment, expected placement version, and
estimated impact with coverage. The backend validates scope and version again when
accepting the operation.

The initial response returns an operation ID. The console keeps a pending badge on the node
and shows phase, remaining work, and per-target outcomes. Navigating away does not cancel
server work; returning to the operation restores its status.

A timeout does not trigger a fresh removal automatically. The frontend reconciles the same
operation. If the backend cannot determine its outcome, the console says so and provides
the observations needed for a deliberate next action.

A flush follows the same principle. “Request sent to all nodes” is not equivalent to “all
nodes cleared.” A successful response envelope may contain failures, and those failures
must remain visible.

### Confirmation is scoped, not universal

An inspection needs no confirmation. A node removal or namespace flush should state the
consequence and scope, not merely ask whether the user is sure. Preview values are
estimates if derived from a sample.

The browser cannot authorize a change by hiding a button or displaying a warning. The
server must restrict namespaces, roles, and registered node endpoints. Test writes should
have enforced scope and expiry rather than a cosmetic key prefix.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Fenced transition plus identified operation | Correct ownership and reviewable progress | More control-plane state |
| ❌ Change ring and copy blindly | Short implementation | Stale overwrites, lost warm data, ambiguous completion |
| ✅ Bounded cold recovery for this workload | Simpler transfer semantics | Temporary misses and slower maintenance |
| Deferred warm migration/replicas | Preserve more cache hits | Version and deletion coordination |

The user sees a slower but meaningful completion state. That is preferable to an instant
green toast followed by an origin overload the console never explained.

## 🔐 Security, accessibility, and validation — 5 minutes

Service requests need identity and namespace permissions. Operators need authenticated
sessions and scoped actions. An operator-facing backend can hold a service key, but it must
authorize the person before forwarding any request; key injection alone is not
authorization.

Data inspection also needs permission because values and key names can contain sensitive
information. Node ports should be private, request sizes bounded, and registered endpoints
restricted to known cache services.

The current frontend sends no admin header, so protected cluster actions fail. Meanwhile,
the effective coordinator flush route and direct node routes are public. These are concrete
integration and enforcement gaps, not a complete security model.

The interface needs status words as well as color, correctly labeled fields, and visible
keyboard focus. Announce significant changes rather than every polling tick. Keep an
expired or failed observation understandable without relying on animation.

I would validate the shared contract through failure scenarios:

| Scenario | Backend expectation | Frontend expectation |
|----------|---------------------|----------------------|
| SET too large | Reject before accepting an unretainable entry | Preserve input and show the limit |
| Response lost after mutation | Defined receipt or unknown outcome | No blind replay disguised as retry |
| One node unavailable | Explicit missing sample | Partial total with age/coverage |
| Membership changed after preview | Reject obsolete request version | Refresh preview before resubmission |
| Old owner receives delayed write | Enforce the generation fence | Show a reconcilable routing error |
| Key expires after listing | Confirmed miss on inspection | Keep context and explain absence |

Deterministic tests can cover request reordering and API outcomes. A small real
multi-process exercise should verify fencing, timeout behavior, and origin admission under
node loss. The existing three page smoke tests only confirm basic rendering.

For performance, measure end-to-end latency, heap/RSS, serialization work, origin load, and
observation collection cost under skew. A uniform benchmark that ignores node changes and
hot keys cannot validate the most consequential parts of this design.

## ⚖️ Decisions and the implementation boundary — 3 minutes

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Mutation UX | ✅ Pending plus defined outcome | ❌ Optimistic success | Network failure can leave the effect uncertain |
| Observation | ✅ Shared samples with provenance | ❌ Implicitly complete totals | Partial failures must remain visible |
| Membership | ✅ Versioned authority and fencing | ❌ Independent mutable rings | Keep obsolete owners from serving |
| Recovery | ✅ Bounded cold refill initially | ❌ Unsafe warm-copy loop | Fit the rebuildable-data contract |
| Resource use | ✅ Admission and scan budgets | ❌ Response limits alone | Bound actual server and browser work |

The repository has a single coordinator, HTTP routing, an LRU/TTL store per node,
snapshots, probes, and four React routes. The proposed origin refill, authority, fencing,
scoped authentication, observation envelope, and operation records are not implemented
there.

The first practical improvements would establish honest API outcomes, enforce cache limits,
correct node transitions, and give the dashboard partial-result and request-ordering
behavior. That is a smaller and more useful first step than adding quorum settings to a
system whose basic ownership protocol is still incomplete.

> “Across both layers, the design should preserve the same meaning: a hit is a live observation, a timeout is uncertainty, and a node transition is an operation with a completion condition. Keeping those meanings intact makes the cache understandable and the console useful when the system is under stress.”
