# Distributed Cache Architecture

## System Overview

This project explores a cache whose entries are partitioned across memory-owning servers. Consistent hashing determines placement; each server manages recency and expiration; a coordinator routes client requests. The operator console makes those behaviors visible.

The sections before **Implementation Notes** describe a proposed production cache and identify relevant local interfaces. The final section traces the checked-in TypeScript implementation, including incomplete or incorrect behavior. Production targets are design assumptions, not benchmarks of this repository. The [README](./README.md) contains local setup and current launch limitations.

The production use case is **rebuildable application data** with an explicit freshness policy. The application owns its durable database and the cache-aside refill path. Neither that database nor a refill service is implemented here. Losing a cache entry is acceptable; overwhelming the origin or representing an unavailable read as confirmed absence is not.

## Requirements

### Functional requirements

- Read, replace, and delete an individually addressed key, with an explicit expiration deadline.
- Enforce per-entry, per-tenant, and per-node capacity limits; evict disposable entries under pressure.
- Partition keys across nodes and change placement without allowing obsolete owners to serve stale generations.
- Bound origin refill during failures, planned transitions, and bulk invalidation.
- Inspect health, placement, sampled distribution, capacity, and operation outcomes through an authenticated console.
- Make incomplete observations and uncertain mutation outcomes visible.

Increment is an optional cache-local operation, suitable only where its loss or duplication is acceptable. Durable counters, authorization decisions, distributed locks, transactions across keys, and arbitrary query execution are outside this cache contract.

### Non-functional targets

| Requirement | Proposed target | Qualification |
|-------------|-----------------|---------------|
| Cache response latency | Regional p99 below 5 ms | Small values, admitted traffic, warm connection pools; exclude origin fetch time |
| API availability | 99.9% monthly | A bounded MISS or explicit overload response is distinct from retaining every cached value |
| Peak traffic | 1 million operations/second | Sizing scenario to validate with skewed workloads |
| Working set | 100 million entries | Mean value 1 KiB; large values separately bounded |
| Freshness | Application-defined deadline, e.g. five minutes | Cache age does not by itself establish source freshness |
| Operational visibility | Health observations usually within 10 seconds | Show sample age and unavailable nodes; no instantaneous global snapshot claim |
| Failure containment | Bound downstream concurrency and refill QPS | An origin capacity budget controls recovery speed |

## Capacity Estimation

For 100 million entries, 1 KiB values occupy 102.4 GB. Assuming another 200 bytes per key and metadata record gives 122.4 GB, about 114 GiB. This is an estimate for a designed storage engine; a JavaScript object graph may have a very different footprint.

A starting scenario of 100 nodes with 2 GiB of usable cache budget each provides 200 GiB total before accounting for skew, maintenance, and process headroom. It is not a claim that 100 Node.js processes in this repository support those limits. One copy is the initial cost choice; a second full copy roughly doubles cached data storage, with additional replication traffic and coordination.

At one million operations/second, 95% reads, and a 95% read hit rate, the origin sees approximately 47,500 misses/second. If a failed node held 1% of previously successful hits, it adds roughly 9,025 misses/second. A celebrity key can make that increase much larger than the node's share of entries suggests.

That arithmetic determines whether cold recovery is affordable. Capacity planning must measure request-weighted placement, value sizes, event-loop delay, response bytes, and origin headroom, not just count keys per node.

### Local Development Scale

The provided scripts run three cache nodes, each configured for 10,000 entries and 100 MiB of estimated key/value memory, plus one coordinator and one dashboard. The nominal sum is 30,000 entries and 300 MiB. It is neither a heap limit nor an effective hard capacity guarantee: current mutation paths have accounting and enforcement defects.

A source-level sample of 100,000 keys named `key:0` through `key:99999`, using native node URLs and 150 virtual nodes each, mapped 35,914 / 32,044 / 32,042 keys. This is a deterministic placement example, not a load benchmark or universal balance bound. The busiest node has about 7.7% more keys than the equal-share mean.

## High-Level Architecture

Proposed production components:

```
┌───────────────────────┐       ┌──────────────────────────┐
│ Application services  │──────▶│ Durable origin           │
│ Cache-aside + budgets │       │ Owned by the application │
└───────────────────────┘       └──────────────────────────┘
            │ cache requests
            ▼
┌───────────────────────┐       ┌─────────────────────────┐
│ Regional router pool  │◀──────│ Membership authority    │
│ Deadlines + admission │       │ Versioned placement     │
└───────────────────────┘       └─────────────────────────┘
            │ one current owner
            ▼
┌────────────────────────────────────────────────────────┐
│ Cache nodes: bounded storage, TTL, owner-generation    │
│ checks, eviction, capacity and health reporting        │
└────────────────────────────────────────────────────────┘
            │ sampled observations
            ▼
┌───────────────────────┐       ┌─────────────────────────┐
│ Observation service   │──────▶│ Authenticated console   │
│ Per-node age/coverage │       │ Inspect + scoped admin  │
└───────────────────────┘       └─────────────────────────┘
```

The origin is outside the cache service. The membership authority is responsible for accepted placement versions; individual routers do not independently reshape the ring whenever a probe fails. The observation service protects the data path from per-viewer fan-out and does not become a prerequisite for ordinary cache reads.

A smart client can later perform routing locally using the same placement contract. That removes a hop while introducing SDK rollout, topology refresh, and stale-client handling. Neither a router pool nor a smart client removes the need to reject obsolete ownership generations at nodes.

## Core Components / Request Flows

### Cache read and refill

1. The application sends a namespaced key with a request deadline.
2. The router selects the owner using an accepted placement version and includes the ownership generation.
3. The node rejects an obsolete generation or expired entry; otherwise it returns a HIT with value metadata.
4. A MISS lets the application attempt an origin read within its refill budget. A transport failure remains an unavailable observation, even if application policy allows a controlled origin fallback.
5. Concurrent same-key misses share work within an application instance. Cluster-wide admission limits bound the remaining duplicate refills across instances.
6. The application writes back only a result that is still within its freshness deadline. The cache rejects obsolete-generation fills.

A TTL chosen at cache insertion time can extend a stale origin read if that read was delayed. The proposed fill therefore carries an absolute deadline derived from the origin observation, bounded by the application policy and clock assumptions. Strict source consistency requires a stronger source-version or invalidation protocol and is outside the basic stale-tolerant contract.

### Cache mutation and admission

Validate key length, value size, numeric fields, namespace permissions, and total request size before allocating large intermediate structures. Replacing a value must check the final memory budget as carefully as inserting a new key. Reject a value that cannot fit by itself; do not acknowledge it and immediately discard it while reporting successful retention.

Map lookup and recency-list changes can be constant-time. End-to-end SET includes value serialization, memory allocation, and potentially several evictions. List and pattern operations need an explicit cursor/work budget; a small response limit alone does not limit server work.

### Placement and node transitions

Consistent hashing limits the fraction of assignments affected by a membership change. It does not transfer bytes, handle a failed owner's missing data, or make two routers agree on membership. This distinction follows the separation between hash assignment and cache protocols in the [original consistent-hashing paper](https://www.cs.princeton.edu/courses/archive/fall09/cos518/papers/chash.pdf).

For this rebuildable-data use case, the initial production policy is a **controlled cold cutover of bounded partition groups**. Prepare a target, stop admitting old-generation work for a group, fence obsolete owners, publish the new generation, and admit refills at a bounded rate. Old copies may remain physically present but cannot serve the new generation.

A transition is not declared complete until old writers are fenced. If a partition prevents that guarantee, reject affected cache operations or wait for an enforceable ownership lease to expire; do not let both sides claim authority. Healthy unrelated partitions can continue.

Copying warm data is an optional optimization. It needs version-aware transfer, absolute deadlines, tombstones or equivalent deletion fencing, and a catch-up barrier before cutover. Blind GET/SET/DELETE migration is not sufficient under concurrent writes.

### Operator observations

Return a stable membership version plus separately timed node samples. Include expected node count, successful sample count, errors, collection interval, and per-node sample time. Combining them in one response gives a convenient observation envelope, not a transactionally consistent view of all nodes.

Key browsing reports a bounded page with scan coverage and a placement version. Owner lookup reports intended routing; a value inspection reports which node actually served it. During a transition those are different questions.

## Database Schema

There is no relational database in the local cache. The concrete storage representation is defined in [lru-cache.ts](./backend/src/lib/lru-cache.ts), [consistent-hash.ts](./backend/src/lib/consistent-hash.ts), and [persistence.ts](./backend/src/shared/persistence.ts).

| Local structure | Stored fields | Actual meaning |
|-----------------|---------------|----------------|
| Entry Map | `key` → cache item | One entry per string key |
| Cache item | `key`, `value`, `size`, `expiresAt`, `createdAt`, `updatedAt`, `prev`, `next` | `value` is unknown/JSON-compatible on HTTP paths; timestamps are epoch milliseconds; zero expiration means none |
| Recency list | Head/tail sentinels and entry links | GET and SET move an entry toward the head |
| Statistics | hits, misses, sets, deletes, evictions, expirations, current size/bytes | Process-local counters; some update paths are incomplete |
| Hash ring | Map of 32-bit hash → node string; sorted hash array; node Set | Coordinator passes URL strings as identities |
| Snapshot envelope | `version: 1`, `nodeId`, `timestamp`, `entries`, `stats` | JSON file, not a journal |
| Snapshot entry | `key`, `value`, `expiresAt`, `createdAt`, `updatedAt` | No linked-list order, source version, tombstone, or owner generation |
| Health Map | URL, healthy flag, optional node/cache metadata, last check, consecutive failures | Last probe result, separate from ring membership |

A production entry would add namespace, accepted ownership generation, source observation/version where available, absolute freshness deadline, and admission accounting. A membership record would contain partition assignments, versions, and transition state. Administrative operations need identity, requested effect, status, and per-target results. These are proposed records, not hidden local tables.

## API Design

The following is the implemented API surface. Production would add authentication, consistent error envelopes, owner generations, deadlines, scan cursors, and operation status resources.

| Method | Coordinator path | Local behavior |
|--------|------------------|----------------|
| GET | `/cache/:key` | Single-owner read; 404 miss; successful response adds `_routing.nodeUrl` |
| POST / PUT | `/cache/:key` | Replace or create from `value` and optional TTL seconds; status 201 / 200 |
| DELETE | `/cache/:key` | Delete from current owner; 404 if absent |
| POST | `/cache/:key/incr` | Numeric increment on current owner; no deduplication |
| GET | `/keys` | Fan-out pattern query; per-node and aggregate truncation, no cursor |
| POST | `/flush` | Public handler fans out; protected later handler is unreachable |
| GET | `/cluster/info`, `/cluster/stats` | Membership/health and separately collected aggregate counters |
| GET | `/cluster/locate/:key` | Current intended owner, not an existence check |
| POST | `/cluster/distribution` | Hashes supplied `keys` array; does not inspect stored data |
| GET | `/cluster/hot-keys` | Per-node top-key summaries |
| GET | `/health`, `/metrics` | Health JSON and Prometheus exposition |
| POST / DELETE | `/admin/node` | Add URL to monitored list / attempt removal |
| POST | `/admin/health-check`, `/admin/rebalance`, `/admin/snapshot` | Protected control operations |
| GET | `/admin/rebalance/analyze` | Protected impact analysis; currently mutates the live ring |
| GET / POST | `/admin/circuit-breakers`, `/admin/circuit-breakers/reset` | Inspect/reset helper registry; normal requests do not populate it |
| GET | `/admin/config` | Public nonsecret auth configuration |

Direct nodes expose core cache operations plus `/cache/:key/exists`, `/ttl`, `/info`, and POST `/expire`; the suffixes are attached to `/cache/:key`. They also expose GET `/keys`, `/info`, `/stats`, `/hot-keys`, `/health`, `/metrics`, `/snapshots` and POST `/mget`, `/mset`, `/flush`, `/snapshot`. No direct-node route uses admin-key middleware.

Examples at the coordinator:

```http
POST /cache/demo:profile
Content-Type: application/json

{"value":{"name":"Ada"},"ttl":60}
```

```json
{"key":"demo:profile","value":{"name":"Ada"},"ttl":59,"_routing":{"nodeUrl":"http://localhost:3001"}}
```

The GET owner and remaining TTL above are illustrative; the hash ring chooses the actual node. No endpoint implements cross-key atomicity. Direct `/mset` applies entries one by one and can leave earlier entries written when a later entry fails.

## Key Design Decisions

### A cache contract before a durability mechanism

Choose rebuildable, stale-tolerant data with a defined freshness deadline. That allows eviction and controlled cold recovery. Using the same service as the only copy of a session revocation, financial balance, or durable counter would change the requirements: loss and delayed invalidation become correctness failures, not cache misses.

Snapshots reduce warmup cost but do not turn cache acknowledgements into durable commits. Requiring a synchronous journal and replicas for every write is a valid alternative for a durable store; here it spends latency and capacity on a guarantee the selected data does not need. The price of the cache choice is a real origin, measured refill headroom, and restricted admissible workloads.

### Placement stability versus safe transitions

Choose versioned placement and bounded cold cutovers initially. The main benefit is understandable ownership: old data cannot silently overwrite a new owner's value. The cost is temporary misses and reduced transition speed while origin refill is rate-limited.

A fully warm migration is better when refilling a large or expensive shard is unacceptable, but it must capture concurrent writes and deletions. Copying first and deleting later can restore stale values; deleting first can lose the only cached copy. If origin headroom cannot support cold transitions, budget for a proper migration protocol or warm replicas instead of calling an unsafe copy loop graceful.

### Recency eviction versus protecting the working set

Choose bounded LRU as the initial eviction policy, with admission checks and expiration cleanup. It is easy to explain and responds to changing recent demand. A one-time scan can nevertheless evict frequently reused entries: recency alone cannot distinguish a useful working set from a stream read once.

Frequency-aware admission can reduce that pollution at the cost of bookkeeping, policy tuning, and approximate counts. Measure origin work avoided per byte before changing policies. Adding virtual nodes does not fix a large entry, a hot key, or poor admission.

### Proxy routing versus client complexity

Choose a router pool for a small number of heterogeneous client stacks. Central routing simplifies deadlines, access controls, and observability. It adds network and serialization work and creates another capacity tier.

A smart SDK avoids the hop and can scale independently with application instances. It also distributes topology-version handling and retry behavior across deployments. Introduce it when measured router cost justifies that operating burden, while preserving the same node-side fencing checks.

## Consistency and Idempotency

The proposed cache is allowed to return values within its freshness policy and to lose entries. Single-owner execution only orders operations accepted by that owner during a valid ownership generation. It does not establish durable, cross-generation, or source-database consistency.

A request timeout means the effect may have occurred. Reads can be retried within a deadline; retrying writes needs a defined policy. Replaying a SET may extend a relative TTL and overwrite another writer. Replaying DELETE can erase a newly recreated value. Increment can apply twice. Conditional versions or scoped operation receipts are required when repeat effects matter.

For bulk control operations, return an operation identifier and per-target outcomes. A successful HTTP envelope must not imply all nodes flushed or all keys migrated. A retry should resume or report the same operation, not silently start an unrelated second change.

Replica quorum arithmetic alone does not establish linearizability. Version ordering, conflict resolution, membership changes, incomplete writes, and failover behavior still matter. This project implements no replica reads, quorum writes, or read repair.

## Security / Auth

Production data APIs require service identity and namespace authorization; administration requires a person or scoped automation identity. Keep node ports private, restrict registered endpoints to allowed cache services, validate redirects/address resolution, and enforce request and scan budgets.

An operator-facing backend can translate an authenticated session into scoped service requests. A hidden admin key in a browser bundle is not a secret, and a reverse proxy that injects a key without authenticating and authorizing the user does not solve access control. Cookie-based mutations also need CSRF protection.

Local API-key checks cover selected coordinator admin routes only. The custom comparison avoids an early content mismatch return but is not a reviewed cryptographic authentication design. The default shared key, public writes/flush, unrestricted node URLs, and direct-node access make this an isolated development service.

## Observability

Measure admitted request rate, hit/miss/unavailable outcomes, end-to-end latency, payload bytes, capacity, eviction reason, expiration work, event-loop delay, origin refill load, and rejected obsolete-generation requests. Separate cache-node time from routing and origin time.

For transitions, report operation ID, old/new placement version, affected partitions, pending work, failures, and origin budget. For snapshots, report time of the last validated complete file rather than assuming a timer proves recovery readiness.

Use bounded labels for tenant and operation classes. Exporting arbitrary keys or node URLs as time-series labels can cause unbounded series churn and reveal sensitive identifiers. A bounded top-key diagnostic view is more appropriate than preserving every historical key label.

Local prom-client counters and Pino logs are useful instrumentation, with the coverage limits documented below. There is no checked-in Prometheus/Grafana service or historical telemetry backend for this project.

## Failure Handling

| Failure | Proposed response | Current local limit |
|---------|-------------------|---------------------|
| Owner unreachable | Deadline, explicit unavailable result, controlled origin fallback | Five-second fetch timeout until headers; no active breaker |
| Node declared failed | Authoritative generation change; refuse obsolete owners | Coordinator removes from in-memory ring after three failed probes |
| Returning old node | Fence or invalidate old generation before serving | First successful probe immediately restores routing |
| Snapshot corrupt | Validate and try an older complete compatible file | Only newest filename is attempted |
| Transition interrupted | Persist progress and expose partial state | Process-local busy flag; no resumable operation |
| Origin saturated | Queue within bounds, reject excess work, preserve allowed stale data only within policy | No origin integration or refill limiter |
| Observation incomplete | Preserve samples with age and coverage | Failed node stats are omitted from aggregates |

Circuit breakers should distinguish dependency failure from ordinary cache misses and invalid input. A 404 must not trip a healthy node's failure breaker. Timeouts must cover the response body as well as connection/headers, and abandoning a client request must not be mistaken for cancelling a completed mutation.

## Scalability Considerations

Scale from measured bottlenecks. A busy router may need more routers or a smart client; an overloaded owner may need less request skew rather than more aggregate storage. A single key still maps to one owner regardless of virtual-node count.

Very hot, stale-tolerant values may use a small application-local cache with a bounded lifetime, or deliberately managed read copies. Replication requires explicit refresh/invalidation semantics; appending random suffixes to a mutable key does not maintain coherent copies automatically.

The control plane should publish accepted placement, while the observation plane collects bounded samples once for many viewers. Avoid polling every node's full key list from every open dashboard. Key enumeration, expiration sampling, and full JSON snapshots are likely local event-loop pressure points well before hash lookup itself.

The local 32-bit hash representation also needs collision handling before large rings: distinct virtual nodes can hash to the same position. A deterministic secondary ordering or wider identifier avoids one token overwriting another. Stable node identity should be distinct from its current network address.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Data role | Rebuildable cache | Durable primary store | Permit loss while bounding refill and freshness |
| Routing | Router pool initially | Smart client | Central policy across heterogeneous clients |
| Placement | Consistent hashing with versions | Modulo by node count | Reduce assignment churn without confusing it with migration |
| Transition | Bounded cold cutover | Concurrent warm copy | Simpler ownership at the cost of controlled misses |
| Eviction | LRU with admission | Frequency-aware admission | Explainable baseline; measure scan pollution |
| Recovery | Optional warm snapshots | Synchronous durable journal | Reduce refill cost without promising durable SET |
| Observation | Shared samples with age/coverage | Per-viewer full fan-out | Bound load during incidents |

## Implementation Notes

### What actually runs

One backend package has a [node entry point](./backend/src/server/index.ts) and a [coordinator entry point](./backend/src/coordinator/index.ts). Native scripts run three nodes and one coordinator; the React application is an operator/test interface. There is no application origin, database adapter, queue, replica, router pool, membership authority, or shared cluster state.

The coordinator starts listening before its asynchronous initial health pass finishes. Its ring begins empty. Optional demo seeding runs once after that pass and counts attempts even when `nodeRequest` returns failure. Simultaneous startup can miss nodes and skip some or all seed keys.

The [Dockerfiles](./backend/Dockerfile) still target nonexistent JavaScript entry points; [Compose](./docker-compose.yml) has no snapshot volumes and uses unavailable `curl` probes. Native `tsx` scripts match current source. The [README](./README.md#setup) records this rather than claiming a verified Docker launch.

### Hashing and routing

The ring hashes each node URL plus `:vn<i>` and every key with MD5, retaining the first eight hexadecimal digits. It stores hash→URL in a Map plus a sorted numeric array and binary-searches clockwise, wrapping at the end. Default virtual-node count is 150.

Lookup after hashing is O(log V), where V is total virtual nodes; hashing itself depends on key length. Addition re-sorts the full token array. Removal performs an array search and splice per token. Hash collisions overwrite the Map entry while duplicate positions remain in the array; there is no collision-resolution invariant. `getNodes` exists but is unused by requests and can fail to terminate if collisions leave a registered physical node with no reachable token.

[Routing](./backend/src/coordinator/routing.ts) calls exactly one URL. Successful data operations add routing metadata; upstream HTTP failures keep their status, transport failures normally become status 500 with a JSON string, and absence of any ring owner produces 503. No alternate replica, retry, or origin fetch exists.

The active [node-request helper](./backend/src/coordinator/node-request.ts) uses fetch plus AbortController. Its timer is cleared as soon as headers arrive, before JSON body parsing, so the nominal five-second timeout is not a complete-response deadline. It never calls `createNodeClient` or another breaker execution helper. Breaker management endpoints inspect an otherwise unused registry; importing its module does not protect requests.

### Cache storage, TTL, and validation

[LRUCache](./backend/src/lib/lru-cache.ts) performs synchronous Map/list mutations. GET checks expiration, updates hits/misses, and moves a live entry to the head. Expiration is tested with `Date.now() > expiresAt`; at the exact deadline it is still considered live. `ttl` rounds remaining seconds upward.

SET with positive TTL computes a relative deadline. Zero uses a positive node default if configured; otherwise it means no expiration. Negative or malformed TTL inputs are not consistently rejected. Direct EXPIRE with a nonpositive number clears expiration, which differs from SET zero with a positive default.

The estimated size is twice the JSON string length plus twice the key length, excluding object/Map/list overhead and temporary serialized copies. Eviction runs only for new keys. Existing-value growth can exceed the budget; a new value larger than the entire budget can evict itself while SET returns true. Eviction decrements byte estimates but not `stats.currentSize`; `stats.size` uses the actual Map size.

Increment calls GET then synchronously adjusts the value, preserving a live key's TTL. It recalculates the item's size but not total memory, set counters, or update timestamp. Its delta lacks runtime numeric validation. It is not safe for a durable or deduplicated distributed counter.

The sentinel-name check inside eviction compares strings rather than object identity. User keys `__HEAD__` or `__TAIL__` can be detached without removal from the Map; an over-budget cache can then loop indefinitely. The HTTP API does not reserve these names.

Every active expiration cycle first allocates an array of **all** keys, then samples up to twenty with replacement. High expired-sample ratios schedule another cycle. Cleanup therefore includes O(N) work despite the small sample count. Pattern listing scans all entries, does not delete skipped expired ones, and passes regex metacharacters through after replacing `*` and `?`; invalid patterns can throw and expensive expressions have no budget.

The 10 MiB JSON body limit is the main request-size boundary. TypeScript interfaces do not validate JSON. Single SET only requires a defined value; bulk operations validate the outer array, then process items without a transactional boundary. The async timing wrapper records duration in `finally` but does not forward rejections to Express 4's error middleware, so some malformed single-operation requests can become unhandled rejections.

### Health and rebalancing

The [health monitor](./backend/src/coordinator/health-monitor.ts) probes all configured URLs concurrently every five seconds. It has no pass-overlap guard. One failed result updates displayed health to false; three consecutive failures remove that URL from the ring. A success adds it immediately, then starts addition rebalancing in the background. A successful HTTP/JSON response is treated as healthy without a richer readiness contract.

Only additions automatically invoke the [rebalance manager](./backend/src/shared/rebalance.ts). Failure-driven removal drops the ring member without copying anything. On explicit graceful removal, [the admin route](./backend/src/coordinator/admin-routes.ts) calls migration **before** removing the URL from the ring. Keys correctly owned there still select the departing URL, so the migration loop skips them as failures before the route removes the node anyway.

Addition scans other nodes after the new ring is already live. Each source `/keys` returns at most 1,000 keys. For each selected key it reads the old value, writes to the target, and attempts source deletion. No versions, CAS, tombstones, or generation fencing protect this sequence: a source copy can overwrite a newer target write, and deletes can race updates. A failed source DELETE still increments `keysMoved`.

Removal copying does not delete the source. Remaining TTL is converted from rounded seconds into a new relative TTL, extending the original deadline by rounding and transfer time; a zero/no-expiration value can take on a destination's positive default TTL. Recovery can route to stale retained or snapshot-loaded entries.

Batches default to 100, but keys inside a batch run sequentially. The 50 ms delay is between batches, not a concurrency limit. The five-minute timeout is checked only at batch boundaries; key enumeration and response-body waits can exceed it. Timeouts, failed source reads, and skipped nodes can still yield `success: true`. Concurrent jobs are rejected by one process-local busy flag, with no queue or retry; simultaneous startup additions can miss a migration.

`currentRebalance` is never assigned beyond null. The impact analyzer repeatedly adds/removes the target on the **live** ring for each enumerated key. If the target already exists, add is a no-op but remove is not, so an apparent analysis request can alter routing. Its duration estimate counts batch delays only, excluding scanning and network work.

### Snapshots and shutdown

The persistence manager creates a full pretty-printed JSON file every 60 seconds and retains three filenames by default. It gathers live records synchronously, serializes them, writes directly to the final filename, then cleans older files. There is no temporary-file rename, checksum, fsync durability contract, or fallback across files. A forced snapshot while disabled or already busy returns null, but the node route still responds with a “Snapshot created” message.

Loading selects only the newest filename and requires version 1. It sorts entries by descending `updatedAt`, skips deadlines at or before startup time, rounds remaining TTL upward, and calls SET. Each SET becomes most recent, so loading newer records first actually leaves older ones nearer the head; a reduced capacity can retain the older subset. Read recency was never stored. Original timestamps/counters are not restored, and the reported loaded count counts insert attempts rather than final retained entries.

Snapshots can resurrect post-snapshot deletions and flushes. No-expiration records are reinserted with TTL zero and can inherit a new positive default. A failed snapshot or lost directory means the recovery gap is unbounded by the one-minute timer.

A node closes HTTP acceptance, then attempts persistence shutdown, stops cache/hot-key timers, and exits, with a ten-second forced-exit timer. If a snapshot is already running, `createSnapshot` returns null; shutdown does not wait for that write and may log completion anyway. Coordinator shutdown closes HTTP but does not explicitly stop health checks or drain rebalance jobs before exiting.

### Metrics, logging, and access controls

[Metrics](./backend/src/shared/metrics.ts) cover core route hits/misses/sets/deletes, timed GET/SET/DELETE, capacity gauges, health checks, snapshots, and rebalance operations. Wrappers count active-expiration and eviction work after snapshot loading. Lazy expirations, increments, bulk timing, and restore evictions have different or missing metric coverage. Counter ratios describe these observed operations, not exclusively application traffic: inspections and migrations also perform GETs.

Hot-key detection keeps at most 10,000 tracked keys, sorts to prune, and returns the ten largest shares at or above 1% of accesses. Its windows reset every minute; they are tumbling, not sliding. Exported hot-key gauges update at reset using the completed window, while JSON endpoints read the current one. Detection does not install a hot-key cache or replicas.

[Pino](./backend/src/shared/logger.ts) uses component child loggers, request IDs, development pretty output, and structured production output. Standard authorization/admin headers are redaction targets; request serialization omits headers. URLs and logged hot-key names can still contain sensitive identifiers, and custom header names need deliberate handling. Per-operation debug log durations are passed as zero even though histograms measure real local elapsed time.

[Admin auth](./backend/src/shared/auth.ts) uses a process-local per-IP fixed window, ten attempts/minute by default, before checking a shared header key. The 429 response includes a body field named `retryAfter`, not a `Retry-After` header. The protected flush registration is shadowed by the earlier public router; node admin-named routes contain no middleware. Arbitrary node registration can make the coordinator fetch supplied URLs. CORS is unrestricted, with no general service or user authentication.

### Frontend behavior and remaining production work

The [dashboard store](./frontend/src/stores/cache-store.ts) fetches info, stats, and keys independently. The overview polls every five seconds even though it does not render the fetched key list. Requests can overlap, and one successful response advances a shared `lastUpdated` even while another dataset remains stale. Background tabs do not explicitly back off.

The [Keys page](./frontend/src/routes/keys.tsx) refetches on every pattern edit as well as Search. Selection fetches value and owner separately without an abort or selection-generation check; slow results can replace a newer selection. TTL is a sampled label, not a live countdown. Rows are not virtualized, and duplicate physical keys can produce duplicate React keys. The coordinator silently omits failed node results and counts truncated lists, so “Found” is not a complete cluster census.

The [Cluster page](./frontend/src/routes/cluster.tsx) refreshes on mount, manual refresh, and completed actions; it does not poll. Its ring visualization is colored URL badges, not actual token arcs. The [API client](./frontend/src/services/api.ts) sends no admin header, has no timeout or runtime response validation, and often loses details when transport errors are JSON strings. The test page stores a growing text log and performs 100 sequential single-key SETs; it has no isolated test namespace enforcement.

Production work therefore includes validated storage/admission, fenced membership, origin integration and refill budgets, coherent error/observation contracts, authenticated scoped controls, complete bounded scans, robust optional snapshots, and failure-oriented tests. Existing three-page Playwright smoke tests do not cover these guarantees. Isolated source checks reproduced the LRU/accounting, removal, overwrite, analyzer, restore, and health-state behaviors above; no application stack, image build, or throughput test was run for this review.
