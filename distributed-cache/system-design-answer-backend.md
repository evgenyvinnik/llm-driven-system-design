# Distributed Cache — Backend System Design

A 45-minute interview answer. The design below is proposed for production; the repository
provides a smaller, single-owner teaching implementation. I would use one architecture
diagram and explain the hard parts through concrete failure scenarios rather than write
cache classes or configuration on the whiteboard.

## 🎯 Clarify the cache contract — 3 minutes

> “Before choosing a hash ring or a replication factor, I want to know whether this data can be lost and how it can be rebuilt. That answer determines whether we are designing a cache or a durable database.”

I will assume application services cache rebuildable data from an external source of truth.
Entries may be evicted, expire, or disappear when an owner fails. The application tolerates
a defined amount of staleness and controls origin refill.

That does not make failures free. A cache normally protects something more expensive. If
losing a node sends more work to the origin than it can handle, the cache failure becomes
an application outage.

The core API is GET, SET, DELETE, and expiration. Increment can be an optional operation
for disposable approximate counters, but I would not use it for payments, durable quotas,
or authoritative account state.

I would clarify typical value size, read/write ratio, working-set size, expected hot keys,
and origin headroom. I would also ask whether a deployment must retain cached values
through a node failure, or whether bounded cold recovery is sufficient.

For this answer I will choose one current owner per key and controlled refill after loss.
Replication remains an explicit upgrade if origin capacity cannot support that choice. I
will not promise that single-owner storage preserves every cached value during failure.

The local project follows the single-owner shape and has no origin integration. It is
useful for studying placement and cache internals, but its current migration and
persistence helpers do not establish the production guarantees I am about to describe.

## 📏 Estimate what actually drives capacity — 4 minutes

Assume 100 million entries, average value size 1 KiB, and one million operations/second at
peak. Reads are 95% of traffic, with a 95% read hit rate. These are sizing assumptions, not
measured project throughput.

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Raw values | 102.4 GB | Before keys, metadata, and allocator overhead |
| Values plus 200 bytes metadata/key | 122.4 GB, about 114 GiB | A starting model, not a JavaScript heap measurement |
| Read traffic | 950,000 requests/second | Serialization and network cost matter |
| Origin misses | 47,500 reads/second | Refill capacity is part of the design |
| Initial node scenario | 100 nodes, 2 GiB cache budget each | Headroom for skew and maintenance |

The average is ten thousand operations/second per node, but average load is not a capacity
guarantee. A single key may receive more requests than an entire average node. More virtual
nodes cannot divide one key's traffic among independent owners.

If one failed node held 1% of previously successful hits, it adds about 9,025 origin
requests/second. That is a meaningful increase over 47,500 baseline misses. If the node
holds a hot key, the increase can be much larger.

I would validate the design with realistic size and popularity distributions. A uniform
workload of tiny strings can hide both memory overhead and the origin pressure caused by
skew.

For the regional data path, I would target p99 below five milliseconds for admitted
small-value requests and 99.9% API availability. Those targets exclude origin latency and
do not imply that every previously cached key remains a hit.

The local scripts configure three nodes with ten thousand entries and a 100 MiB estimate
each. Those values are convenient for exploration; they are not evidence for the production
capacity assumptions.

## 🏗️ Architecture, data model, and API — 6 minutes

```
┌────────────────────────┐       ┌──────────────────────┐
│ Application services   │──────▶│ Durable origin       │
│ Refill + freshness     │       │ Application-owned    │
└────────────────────────┘       └──────────────────────┘
             │ cache operations
             ▼
┌────────────────────────┐       ┌──────────────────────┐
│ Regional router pool   │◀──────│ Membership authority │
│ Admission + deadlines  │       │ Placement versions   │
└────────────────────────┘       └──────────────────────┘
             │ current owner and generation
             ▼
┌──────────────────────────────────────────────────────┐
│ Cache nodes: bounded memory, LRU, TTL, fencing       │
└──────────────────────────────────────────────────────┘
```

I would initially route through a small pool of proxies. That gives heterogeneous clients
one place for deadline handling, authorization, and routing. The cost is another network
hop and a tier that must scale with request volume.

A smart client can remove that hop later. It needs the same placement-version and
stale-owner rules, and those rules now have to be deployed in every language SDK. I would
make the change when measured proxy cost justifies that coordination burden.

The membership authority publishes accepted placement. Health probes provide evidence, but
each router must not independently rewrite ownership after a local timeout. Two routers
with different rings can otherwise send writes for the same key to different nodes.

At a node, a hash map identifies an entry and a doubly linked list tracks recency. I would
draw only the relationship between the map and the list if asked; writing pointer
manipulation would not answer the distributed-system problem.

| Record | Important fields | Purpose |
|--------|------------------|---------|
| Cache entry | Namespace/key, value, size, deadline, generation | Data and the conditions under which it may be served |
| Placement | Partition/range, owner, version | Authoritative routing contract |
| Transition | Old/new owners, generation, phase | Make ownership changes explicit |
| Observation | Node, sample time, outcome, counters | Diagnose partial failures without inventing totals |

These are logical records, not relational tables. The local project stores a Map and JSON
snapshots; it has no SQL database.

| Operation | Contract I would define |
|-----------|-------------------------|
| GET | HIT with metadata, MISS, or an explicit unavailable/rejected result |
| SET | Validated value and deadline accepted by the current owner |
| DELETE | Remove the intended version or apply a defined unconditional policy |
| INCREMENT | Atomic only within the owner contract; retries need special handling |
| Scan | Bounded work and cursor; live results may change between pages |
| Change membership | Identified operation with progress and per-target outcomes |

A successful cache write means the node accepted it into this disposable tier. It does not
mean the application database committed anything. Expiration and eviction remain allowed
afterward.

I would use bounded HTTP/JSON initially for ease of integration. A binary protocol or
batching may improve throughput, but I would measure parsing, allocation, network, and
queueing before making protocol complexity the first optimization.

## 🔧 Deep dive 1: Placement does not move the data — 9 minutes

> “Consistent hashing answers where a request should go. It does not answer how a new owner obtains a current value, how old writes are fenced, or what happens when the old owner is unreachable.”

### Why use consistent hashing

With modulo placement, changing the node count changes the mapping for a large fraction of
keys. For example, moving from three to four buckets can remap roughly three quarters of
uniformly distributed assignments.

A consistent ring adds a new node's positions among existing ones. Only the ranges captured
by the new positions change owner. With similarly weighted nodes, adding a fourth node is
expected to move roughly a quarter of assignments, not exactly a quarter of actual bytes or
requests.

Virtual nodes spread each physical node's ownership across the ring. They reduce
sensitivity to one unlucky token gap, but they do not ensure equal demand. I would choose
the count from measured distribution and operating cost rather than promise a universal
variance from a particular number.

The local implementation uses 150 virtual nodes and hashes node URLs. Production should
separate stable node identity from its current address; replacing an address should not
accidentally be treated as an unrelated membership event.

### The dangerous copy sequence

Imagine the ring changes from A to B. A migration reads value 7 from A. A client then
writes value 8 to B. The migration copies 7 onto B and deletes A's entry.

Every individual operation succeeded, but the migration overwrote the newer value. A delete
racing with a copy can similarly bring an intentionally removed key back. Merely slowing
the copy loop does not fix either race.

The reverse ordering is not a general solution. If we delete before copying, a failed
transfer creates a miss; if we copy before deletion without version checks, concurrent
writes can still be lost or overwritten.

### My initial choice: bounded cold cutover

For the selected rebuildable workload, I would prefer a controlled cold transition over an
incomplete warm-copy protocol. Move a bounded group of partitions at a time and allow
refills within a known origin budget.

The steps I would explain are:

1. Prepare the target and reserve enough capacity for the incoming group.
2. Stop admitting old-generation work for that group and establish an enforceable fence against obsolete owners.
3. Publish the new owner generation through the membership authority.
4. Treat old-generation data as unusable, even if bytes remain on disk or in memory.
5. Admit misses and fills at a bounded rate; advance the next group only when the recovery budget permits.

A router carrying an old version can refresh and retry an appropriate request. The node
must still reject obsolete ownership; relying on every client to update instantly is not a
correctness mechanism.

If the old owner cannot be fenced during a partition, the cache may have to reject affected
operations or wait for an ownership lease to expire. The application may use its separately
budgeted origin path. I am choosing an explicit availability cost rather than letting two
owners silently accept conflicting generations.

### When warm migration is worth it

If origin headroom is too small for even gradual cold cutover, I would add warm transfer or
maintained replicas. A correct transfer must preserve absolute expiration, identify source
versions, account for deletions, and catch up changes before ownership becomes exclusive at
the target.

A transfer also needs progress tracking, bounded enumeration, retry state, and a completion
condition. “We copied some keys without throwing” is not a completion condition.

Replicas can reduce refill after failure, but they raise another question: how current must
the replacement be? Asynchronous replication can lose recent writes; synchronous
acknowledgement adds latency and can reduce write availability. The cache contract should
decide whether those costs are justified.

### The trade-off

| Approach | Why it fits or fails here |
|----------|---------------------------|
| ✅ Fenced, bounded cold cutover | Simple ownership semantics; costs temporary misses |
| ❌ Blind GET/SET/DELETE migration | Warm-looking transfer can overwrite newer values |
| Deferred versioned warm transfer | Preserves more hits but needs a real transition protocol |
| Deferred replicas | Reduce loss/refill while adding capacity and consistency work |

I am giving up seamless retention of warm entries during maintenance. That is acceptable
only if the origin budget supports the resulting misses. If it does not, I would revise the
design rather than relabel data loss as availability.

The local helper illustrates the gap: addition changes the ring before copying, while
graceful removal consults the old ring and skips keys that still belong to the departing
node. Neither path implements the fence described here.

## 🔧 Deep dive 2: Memory and TTL need a precise contract — 8 minutes

> “The map and linked list make lookup and recency updates cheap. They do not make every cache operation constant-time, enforce a heap budget automatically, or make expiration exact under every restore path.”

### The useful part of LRU

A map lookup finds an entry, and a live GET moves that entry toward the most-recent end.
When space is needed, the least-recent entry is a candidate for eviction. Each individual
list update is constant-time.

A SET still has to validate and serialize the value, allocate storage, and possibly evict
several entries. Its work depends on value size and the number of victims. I would state
that distinction instead of writing “all operations O(1)” on the board.

Replacing an existing key must enforce the same budget as a new insertion. Otherwise a tiny
admitted value can later grow beyond the node's limit. A value larger than the entire
allowed entry budget should be rejected explicitly.

Memory accounting also needs headroom for keys, maps, object overhead, request bodies, and
temporary buffers. Counting serialized value bytes alone is a useful signal, not a
process-memory cap.

### LRU is an admission policy choice

A one-time scan can repeatedly insert values and evict a hot working set. LRU sees recent
use, not future value. If that workload is common, frequency-aware admission can prevent
many scan entries from entering the cache at all.

The cost is more policy state and tuning. I would begin with LRU plus size limits and
measure avoided origin work per byte, then add admission sophistication when scans or churn
demonstrably reduce useful hit rate.

| Choice | Strength | Cost |
|--------|----------|------|
| ✅ LRU with bounded admission | Clear baseline, adapts to recent demand | Vulnerable to scan pollution |
| Deferred frequency-aware admission | Protects repeated-use working set | More metadata and approximate policy |
| ❌ Admit every oversized value | Simple success path | Can displace useful data or exceed capacity |

### TTL is about freshness, not just cleanup

Every read checks whether the entry deadline has passed before returning a value. A
background expiration pass reclaims memory from expired keys that nobody reads. This
separates semantic expiration from eventual physical removal.

A bounded sampling pass should not allocate an array of the entire keyspace. Otherwise the
“twenty sampled keys” headline hides O(N) work and event-loop pressure. I would use an
incremental cursor or another bounded traversal strategy.

The proposed fill carries an absolute freshness deadline tied to the source observation. If
a slow origin read started long ago, assigning a brand-new full TTL when it finally
completes can extend staleness beyond the intended policy.

An absolute deadline still needs a clock policy, especially when entries move between
machines. We should budget for clock error and preserve the original deadline during
migration rather than repeatedly round remaining TTL up and start it again.

TTL limits how long we retain an observed value; it does not prove that value was current
when read. Strong invalidation requires source versions or another source-coordinated
protocol. I would use the origin directly for decisions that cannot tolerate this cache's
staleness.

### Snapshot recovery

Snapshots are a warm-start optimization. They should include absolute deadlines and enough
metadata to reject obsolete owner generations. A recovered node should not simply start
serving every value found on disk.

For robust optional recovery, write a temporary file, validate it, replace the final file
atomically, and make durability expectations explicit. On load, try older valid compatible
snapshots if the newest one is corrupt.

Deleted entries are a subtle case. A value removed after the last snapshot can return after
a restart. If that is forbidden by the workload, snapshots need deletion/version protection
or the recovered generation must be treated as cold.

Recency is another separate property. Restoring by last-write timestamp does not reproduce
last-read order. If preserving the warm working set matters, save a suitable approximation
and load it in an order that does not immediately evict the most valuable entries.

### What the choice costs

Precise admission and expiration add checks to the fast path, but their cost is bounded by
the value and request budgets. Skipping them creates misleading success and unpredictable
resource use.

The local implementation estimates memory from JSON string length, misses eviction on
existing-key growth, and rounds TTL during restore. It has useful learning mechanisms, but
its one-minute snapshot timer is not a bound on crash loss and its memory setting is not a
hard process limit.

## 🔧 Deep dive 3: A cache failure must not become an origin failure — 8 minutes

> “My failure policy is not ‘on any error, hit the database.’ It is ‘preserve an explicit result, then let the application attempt a bounded fallback if its workload permits it.’”

### Miss, failure, and overload are different

A MISS means the current owner did not return a live entry. A transport error means we
could not obtain that observation. An overload rejection means the service deliberately
refused more work. The application may choose the same fallback for some of these, but
observability and capacity accounting should preserve the distinction.

If a failing node makes each request wait five seconds, large numbers of calls can
accumulate. Deadlines need to include reading the response body, not just receiving
headers. Queues and concurrent downstream calls need upper bounds as well.

Circuit breakers can suppress repeated calls to a failing dependency. A normal cache miss
is not a dependency failure; a breaker that counts 404 responses as errors can stop traffic
to a perfectly healthy node.

Probe success is only one signal. A process can answer health checks while its data path is
overloaded or its recovered generation is not ready to serve. Membership decisions need an
explicit readiness and authority model.

### Control the refill wave

Suppose a popular key expires and a thousand application requests miss at once. Coalescing
those requests within an application instance avoids duplicate origin work for that
process. It does not collapse requests across every application instance automatically.

I would combine local same-key coalescing with a global or partitioned origin admission
budget. Waiting callers have bounded time and queue space. Excess requests receive a
defined degraded response rather than creating an unlimited backlog.

Jittering expiration deadlines reduces synchronized expiry of unrelated keys. It does not
solve a genuinely hot key or an entire node disappearing. Those cases still require refill
capacity and overload behavior.

For selected stale-tolerant data, a short application-local cache or managed read copies
can reduce repeated demand on one owner. They must preserve the freshness policy. Randomly
splitting one mutable key into several names does not keep the copies coherent.

### Retry semantics

Reads are generally safe to retry within an overall deadline, although their values may
change. A timed-out mutation is different: the server may have applied it before the
connection failed.

SET with the same body is not always the same effect. It can restart a relative TTL and
overwrite a concurrent writer. DELETE can remove a key recreated after the original
attempt. Increment can apply twice.

Where the caller needs the same logical effect, use an operation identity and scoped
receipt, or a conditional version contract. That receipt needs a defined lifetime and
authority; a request ID written only to a log does not deduplicate a mutation.

For this simple cache I would avoid promising durable exactly-once increment. Callers that
require durable counters should use an appropriate authoritative service. The cache can
store a derived view of the result.

### Failure-oriented trade-off

| Policy | Benefit | Cost |
|--------|---------|------|
| ✅ Bounded fallback and explicit errors | Protects the origin and makes overload diagnosable | Some requests must degrade or fail |
| ❌ Unlimited fallback on every timeout | Appears highly available at low load | Converts cache failure into origin overload |
| ❌ Retry every operation automatically | Simple client wrapper | Can duplicate or overwrite mutation effects |

The chosen policy gives up the promise that every cache error can be hidden from the user.
It preserves the larger application's ability to keep serving admitted work during a
failure.

Recovery should be paced against live origin load, not a fixed number of milliseconds
between copy batches. A nominal delay says little about actual bytes, downstream
concurrency, or the work each refill triggers.

The local project does not include an origin or refill coordinator. Its active fetch helper
also bypasses the Opossum implementation. Those are concrete boundaries between the
learning code and this proposed failure policy.

## 🔬 Security, observation, and validation — 4 minutes

Service identity should authorize namespaces on data operations; administration needs a
separate scoped identity. Cache nodes should not be public endpoints, and adding a node
must resolve to an allowed cache service rather than an arbitrary URL.

The operator console should receive observations with collection age and coverage. If 99
nodes respond, label totals as covering those nodes. Do not silently subtract the failed
node and make the system look less busy.

I would measure hits, misses, unavailable results, admission rejections, latency
distributions, bytes, evictions, expiration work, event-loop delay, and origin refill.
Transition metrics need remaining work and failures, not just a counter of successful
copies.

Raw key labels can expose data and create high-cardinality telemetry. Use bounded
diagnostic samples and stable metric dimensions. A top-key report is useful, but it should
not become an unbounded catalog in the metrics database.

The most informative tests are scenarios that challenge a guarantee:

| Scenario | Property to verify |
|----------|--------------------|
| Old owner receives a request after cutover | Obsolete generation cannot serve or mutate |
| Write races a warm transfer | Older copy cannot replace a newer value |
| Existing value grows beyond admission limit | Replacement is rejected or bounded correctly |
| Origin is saturated during node loss | Refill remains within admission budget |
| Response disappears after increment | No undocumented automatic replay |
| Newest snapshot is corrupt | Defined fallback or cold-start behavior |

I would combine deterministic helper/contract tests with a small multi-process failure
exercise. A page-render smoke test does not verify these properties, and a throughput
benchmark without failures does not establish them either.

## ⚖️ Decisions and the local implementation — 3 minutes

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Data role | ✅ Rebuildable cache | ❌ Durable primary store | Allows eviction and bounded cold recovery |
| Placement | ✅ Versioned consistent hashing | ❌ Independent health-driven rings | Assignment stability needs ownership agreement |
| Transition | ✅ Fenced cold cutover first | ❌ Unversioned copy loop | Avoid stale-copy overwrite |
| Eviction | ✅ LRU plus admission | ❌ Unbounded replacement growth | Keep memory behavior explainable |
| Failure | ✅ Bounded origin fallback | ❌ Unlimited retries/refill | Protect the service behind the cache |

The repository implements direct key hashing, one coordinator, one in-memory owner,
LRU/TTL, HTTP operations, snapshots, health probes, and a dashboard. It does not implement
replication, quorums, source-version validation, owner fencing, origin refill, or durable
operation receipts.

It also has current defects in migration ordering, memory enforcement, snapshot
restoration, and admin route coverage. I would repair those basics and establish failure
tests before measuring production performance or introducing more distributed mechanisms.

> “My central design decision is to make loss and freshness explicit. The hash ring reduces placement churn, but the system remains dependable only when ownership transitions are fenced, resource work is bounded, and a cache failure cannot freely overwhelm the origin.”
