# 🔗 Design a URL shortener: backend interview

> “I would separate three decisions: publishing a unique mapping, resolving a mapping
> that is still allowed to redirect, and retaining an observation for analytics. A
> cache and a queue help with load, but each introduces a different failure boundary.”

This is a proposed production design, not a claim about Bitly's private architecture.
It extends the local learning project; the [Implementation
Notes](./architecture.md#implementation-notes) distinguish implemented paths from
these guarantees.

| Time | Discussion |
|------|------------|
| 5 minutes | Requirements and capacity |
| 5 minutes | Architecture, data, and API |
| 8 minutes | Deep dive: namespace ownership and creation recovery |
| 8 minutes | Deep dive: cached redirects and revocation |
| 9 minutes | Deep dive: retained analytics and repeated delivery |
| 6 minutes | Failure isolation, security, and growth |
| 4 minutes | Verification and design boundaries |

## 🎯 Requirements and capacity — 5 minutes

I would support generated short links, optional custom aliases and expiration, owner
management, administrative deactivation, and basic click reports. Destination editing,
custom domains, and paid campaign accounting are outside the first design. I would
clarify those early because they change cache and durability requirements.

A short code has one owner and one destination. Once retired, it is not reassigned to
someone else. Otherwise an old email could unexpectedly direct people to an unrelated
destination years later. Code-space conservation is not worth that behavior.

The main product is navigation. I would target 99.99% redirect availability and
regional p99 resolution under 50 ms, excluding the destination server. Creation can
tolerate a larger budget, such as 300 ms p99. These are design targets that require
measurement, not results from this repository.

Analytics can normally lag by a minute. During collection failures, I would prefer
continued redirects with disclosed report gaps. If the interviewer instead requires
every successful redirect to have a retained event, I would acknowledge that durable
event admission becomes part of the redirect's critical path.

Assume 50 million new links and five billion redirect requests per day. That is about
580 creations and 58,000 redirects per second on average. I would provision and test
representative peaks around 5,000 creations and 200,000 redirects per second, then
refine those assumptions from traffic shape.

At an assumed 500 bytes per mapping, one year adds about 9.1 TB before indexes and
replication. At 200 bytes per request event, analytics adds about 1 TB per day. The
event store therefore becomes a storage and retention problem much sooner than the
mapping namespace fills.

Seven base62 characters provide about 3.52 trillion possibilities. At 50 million
allocations per day, that is roughly 193 years of raw capacity. Random selection still
collides before exhaustion; the unique constraint, retry policy, and retirement policy
are part of the design.

> “I would spend more time on a viral link, stale deactivation, and event recovery
> than on inventing a complicated identifier scheme. Those are more likely to
> determine whether this service behaves correctly.”

## 🏗️ Architecture, data, and API — 5 minutes

I would draw the redirect path separately from management and analytics:

```
┌────────────────┐       ┌────────────────┐
│ Management API │──────▶│ Mapping store  │
└────────────────┘       └───────┬────────┘
                                 │ revisions
                                 ▼
┌────────────────┐       ┌────────────────┐
│ Link request   │──────▶│ Resolver/cache │──────▶ Destination
└────────────────┘       └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Event log      │
                         └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Report workers │──────▶ Analytics API
                         │ and store      │
                         └────────────────┘
```

The mapping store is authoritative for ownership and lifecycle. Regional caches hold
read representations. A retained event pipeline feeds an analytics store so report
queries and click aggregation do not compete with mapping writes.

I would start with PostgreSQL for link management because unique claims and operation
receipts fit a transaction. Logical separation does not require six deployments on day
one. The redirect and analytics workloads get separate capacity and pools as soon as
their interference becomes measurable.

| Record | Key information | Access pattern |
|--------|-----------------|----------------|
| Link | Code, owner, target, status, expiry, revision | Resolve by code; list by owner and creation cursor |
| Creation receipt | Caller, operation ID, request digest, resulting code | Recover one accepted creation |
| Change outbox | Link revision and pending propagation | Resume invalidation after a publisher crash |
| Session | Opaque token reference, user, authoritative expiry | Check current access and revoke it |
| Observation | Event ID, code, time, selected dimensions | Retain, replay, and aggregate by time |
| Report projection | Code, bucket, metric version, count | Read bounded summaries with freshness |

| Method | Resource | Purpose |
|--------|----------|---------|
| POST | `/api/v1/urls` | Create or recover one caller-scoped attempt |
| GET | `/api/v1/urls` | List the caller's links with a stable cursor |
| PATCH | `/api/v1/urls/:code` | Change permitted lifecycle fields against a revision |
| GET | `/:code` | Resolve an eligible mapping |
| GET | `/api/v1/analytics/:code` | Read authorized aggregate activity |
| GET | Proposed creation-operation resource | Recover an outcome after a lost response |

I would require consistent URL, alias, and duration validation before allocation. The
service accepts HTTP(S) destinations but does not fetch them as part of creation.
Syntactic acceptance and destination reputation are different capabilities.

An anonymous creator receives a narrowly scoped operation-recovery context rather than
account ownership. A signed-in creator gets a link owned by that account.
Authentication infrastructure failure must not silently turn an intended owned
creation into an anonymous one.

## 🔧 Deep dive: namespace ownership and creation recovery — 8 minutes

The first invariant is that one code cannot point to two owners' destinations. For the
initial production implementation, I would generate a cryptographic random candidate
and let a unique insert claim it. A collision causes a bounded retry with a new
candidate.

The key word is bounded. If collisions unexpectedly become frequent, the request
should fail predictably and emit a useful signal. An unbounded loop turns a namespace
or generator problem into an availability problem.

At roughly 0.5% occupancy after a year under these assumptions, most independent draws
still succeed on the first attempt. That does not prove a particular database meets
the peak workload, but it gives me a simpler design to benchmark before adding a
reservation service.

Custom aliases use the same namespace authority. A preflight availability check is
only a hint: two concurrent callers can both observe absence. The transaction that
claims the unique code decides the winner, and the loser receives a conflict while
retaining its proposed destination.

I would define the namespace completely: supported characters, case sensitivity,
maximum length, reserved service paths, and no reuse after retirement. Generated keys
and custom aliases must not have independent ownership rules that can drift apart.

The local project uses a preallocated pool. That is a legitimate alternative for
amortizing reservation work. Workers can claim batches using row locks that skip
already locked candidates, then consume their local batches without asking an
allocator for every candidate.

But a batch is not free coordination. The database still grants it, and each mapping
still needs durable publication. The pool introduces unused reservations, refill
bursts, ownership records, and recovery when a holder disappears. Concurrent refill
calls should be coalesced and kept off the normal path while capacity remains.

A timed-out lease cannot simply be returned to the pool. The old holder might resume
and publish one of its remembered keys. Safe reclamation needs fencing that prevents
the old allocation generation from committing, or a policy that permanently retires
abandoned keys.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Random candidate with unique insert initially | Small authoritative write path | Collision retries and namespace occupancy monitoring |
| ❌ Preallocated pool before a measured need | Amortized reservation and local headroom | Stranded keys, refill coordination, and fencing |
| ❌ Unchecked random fallback | Avoids waiting for allocation | Can collide without a controlled recovery path |

A counter with blocks is another credible design. A single round trip for every
increment can become a bottleneck, but block allocation changes that calculation.
Sequential identifiers are enumerable, and base62 encoding does not conceal that
sequence. I would compare these operational properties without claiming one approach
is universally unscalable.

The second invariant is that retrying a creation attempt does not produce a second
result. I would commit a caller-scoped operation receipt and the mapping in the same
transaction. The receipt includes an input digest so a caller cannot reuse one key for
a different destination.

If the connection drops after commit, a retry returns the stored code. If the
transaction did not commit, the same attempt can safely continue. Two simultaneous
retries arbitrate on the receipt's unique identity rather than each allocating a
separate link.

The response may be lost even when every database operation succeeded. That is why a
disabled button or a short Redis lock is not sufficient. The result must remain
discoverable after the process holding the lock has died.

At sharded scale, I would choose a layout that keeps the receipt and namespace claim
under one transaction authority, or explicitly design a recoverable coordination
protocol. Merely adding a receipt table on another shard would invalidate the
atomicity I just relied on.

> “The trade-off is paying for a durable receipt on a comparatively infrequent write
> path. I accept that cost because it prevents duplicate links and makes timeout
> recovery understandable.”

## 🔧 Deep dive: cached redirects and revocation — 8 minutes

A viral link can receive a large fraction of all traffic. Reading PostgreSQL for every
request makes that one row's availability and the database's capacity central to
navigation. I would put hot mappings in regional caches, with a bounded fallback for
misses.

The cached value must include target, active state, expiration, revision, and
freshness deadline. A destination string alone cannot tell the resolver whether a link
is expired or has been deactivated. Cache presence is not permission to redirect
forever.

Expiration is the easier case because the deadline is known in advance. The resolver
checks it on every hit, and cache retention does not extend beyond it. I would reject
already expired creations rather than inserting and warming a mapping that should
never resolve.

Deactivation is harder because it changes after a cache entry was created. I would
propose a five-second normal propagation bound, commit a new revision with an outbox
event, and distribute that change to serving regions.

An invalidation event is not enough on its own. Consider an old database read that
pauses, then completes after deactivation deleted the cache entry. If it blindly
refills the target, the link becomes active again in that cache.

Revision-aware tombstones prevent an old refill after a newer revision has been
observed. A fixed freshness deadline assigned at the authoritative read bounds the
case where invalidation has not arrived. The late read cannot reset its five-second
lifetime when it finally reaches the cache.

Clock uncertainty must be accounted for in that deadline. I would use a conservative
margin and refuse stale decisions once the policy budget is exhausted. Saying “TTL is
five seconds” without defining when it starts leaves the race unresolved.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Cache lifecycle records with bounded freshness | Low-latency hot reads and a stated revocation bound | Revision propagation and deliberate stale-data policy |
| ❌ Cache targets for a day without lifecycle metadata | Very simple fast path | Expired and deactivated links can keep redirecting |
| ❌ Query authority for every redirect | Simpler immediate status decisions | Viral traffic and outages directly hit the database |

For emergency abuse removal, I would require acknowledgement from active serving
regions or withdraw regions that cannot enforce the decision. If a region is
partitioned, it cannot both keep making indefinitely stale decisions and promise
immediate global takedown.

I would use 302 for the mutable redirect and an explicit HTTP cache policy. The
proposal uses `no-store` for compliant browser and shared caches, while retaining an
internal controlled mapping cache. The status code alone does not specify all storage
behavior. [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5)
defines that response directive.

This still does not mean one HTTP request equals one human click. Preview bots,
retries, and downstream failures remain separate measurement questions. HTTP cache
control is not a human-attribution mechanism.

On a miss, I would coalesce simultaneous lookups of the same code and limit concurrent
database fallbacks. During a Redis outage, letting every resolver send unrestricted
SQL requests can turn a cache incident into a database incident.

A short negative cache can reduce random-code scans. Creation must invalidate a prior
negative entry, and the new link must be readable at the returned address after
success. At multi-region scale, I would route immediate read-after-create to its
authority or propagate it before advertising regional availability.

## 🔧 Deep dive: retained analytics and repeated delivery — 9 minutes

I would first define the event: an eligible redirect request observed by our resolver.
It does not establish that the destination loaded, that the visitor was human, or that
the same person has not clicked before.

Assign the observation an event ID once. If publication is retried because its
acknowledgement was lost, keep the same ID. If the browser makes another HTTP request,
that may be a new observation under the metric definition; transport deduplication and
unique-visitor estimation are different problems.

The admission boundary determines the durability promise. Scheduling a callback after
the response is fast, but a process can crash before the callback publishes anything.
A queue cannot recover an event that never reached durable storage.

If lossless admitted observations are required, wait for a durable acknowledgement
before treating the event as retained. For this product, I would continue redirects
when the admission path fails within its budget and expose that interval as incomplete
analytics. That is an explicit availability choice.

Publisher confirms and consumer acknowledgements serve different purposes: one
establishes broker acceptance, the other marks consumer handling. Neither makes a
database side effect occur only once. [RabbitMQ's acknowledgement
documentation](https://www.rabbitmq.com/docs/confirms) describes those separate
boundaries.

Once retained, events can be delivered more than once. A worker can apply an update
and crash before acknowledging. Retrying is necessary for recovery, so the consumer
must make repeated processing safe.

For a small implementation, I would transactionally insert the event identity if
unseen and apply its aggregate contribution only for a new identity. Commit both
before acknowledging. An atomic ingestion contract in a larger analytics system can
provide the same property, but it must be stated rather than inferred from the word
“streaming.”

The deduplication horizon must cover the supported replay horizon. If IDs are
forgotten after a day but operators can replay a month, an old replay can count again.
Retention and recovery policies need to be designed together.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Retained events with repeatable aggregate effects | Recoverable processing and consistent replays | Event identity, retention, and atomic contribution logic |
| ❌ Insert event then separately increment mapping row | Straightforward local implementation | Partial updates, duplicate effects, and hot-row contention |
| ❌ Assume durable queue means exactly-once totals | Little application logic | Ignores publisher loss and consumer crash windows |

I would avoid updating one mapping counter for every click at high scale. A viral link
serializes those updates even with many workers. Partitioned event ingestion and
bucketed projections distribute the write load, while dashboard queries read compact
aggregates.

Batching can improve throughput, but a consumer prefetch setting is not batch
insertion. I would define the batch's commit and acknowledgement behavior, cap its
size, and measure the delay it adds to report freshness. Increasing concurrency
without changing a hot row does not remove the bottleneck.

Bad messages need a different path from transient failures. Invalid schema, impossible
timestamps, or a missing referenced mapping should not produce an immediate endless
requeue loop. Use bounded retries, quarantine with a reason, and an operator-visible
count.

Reconnect must restore subscriptions as well as the network connection. A healthy
socket with no consumer can leave a growing backlog while every basic health check
remains green. I would monitor oldest-event age and actual committed progress.

Report APIs return the processed-through watermark, query range, timezone, and known
admission gaps. A total is meaningful only with its metric and coverage. Do not
silently equate an event-derived count with a separate mutable counter on the mapping
row.

For daily reports, group by explicit day boundaries in the agreed timezone. For hourly
reports, retain date as well as hour. Missing buckets are zero only if the covered
interval is known to contain no eligible observations; unprocessed intervals are
incomplete.

> “I can make the effect of retained events repeatable. I cannot use deduplication to
> prove that every human visit was observed, or to recover an event lost before
> admission.”

## 🛡️ Failure isolation, security, and growth — 6 minutes

I would isolate management writes, redirect fallbacks, and analytics work with
separate budgets and pools. Otherwise a backlog recovery or a heavy report can exhaust
the same connections needed to publish links and answer cold redirects.

A circuit breaker can reduce repeated calls to a failing dependency, but its timeout
does not automatically cancel a database statement. A creation may commit after the
caller receives an error. Operation recovery remains necessary even when a breaker is
present.

Health checks should distinguish an alive process, readiness for its role, and
progress of background work. A broker connection flag is insufficient for a worker; a
metrics endpoint should remain available when a business database is unavailable.

For authentication, use opaque server-managed sessions with authoritative expiry.
Cache only for the remaining lifetime and make revocation robust against concurrent
repopulation. Role and user-active changes should affect the next authorized
operation.

Owners can read and mutate their own links and analytics. Administrators get explicit
moderation access. Raw event endpoints require particularly careful scope because IPs,
user agents, and referrers can reveal information unrelated to the public destination.

I would minimize retained personal data and define a deletion/retention policy before
collecting more dimensions. Destination syntax checks do not prevent malicious links,
so reporting and takedown need a separate process. Avoid logging raw session tokens or
full sensitive query parameters.

Creation and expensive reports get shared limits across replicas. Redirect protection
should consider bot traffic and large shared networks rather than applying a small
universal per-IP quota that breaks legitimate campaigns. Metrics labels should use
route templates, not arbitrary short codes or unmatched paths.

At the assumed storage growth, mappings eventually need code-based partitioning and an
owner-list index. I would add that when measured storage, maintenance, or write
throughput warrants it. Regional read replicas also need an explicit lag policy for
newly created links and takedowns.

The cache working set is determined by active links, not all historical mappings. A
million entries at an assumed 600 bytes each is roughly 600 MB before replication and
overhead. Measure real entry sizes and traffic skew before choosing cache capacity.

For analytics, raw-event retention dominates cost. Keep detailed data for a bounded
period and longer-lived aggregates where useful. Provision enough consumer capacity to
catch up after an outage; matching average arrival rate exactly leaves no recovery
headroom.

## 🧪 Verification and design boundaries — 4 minutes

I would test concurrent custom-alias claims and response loss immediately after
creation commit. Exactly one namespace owner should win, and retrying a committed
attempt should recover the same code.

For cache correctness, pause an old read, deactivate the link, then release the read.
It must not resurrect an accepted old revision. Also test a link expiring while warm
and a region unable to receive takedown updates.

For analytics, crash a worker after applying an event but before acknowledgement,
replay it, and verify one contribution. Then fail between event insertion and
aggregate update, inject a poisoned event, and interrupt the broker to verify
subscription restoration.

I would load-test a single viral code and a large stream of random invalid codes.
Those expose different bottlenecks from a uniform happy-path benchmark. Observe
fallback concurrency and oldest-event age alongside latency.

The local code currently differs substantially: it caches only targets for 24 hours,
has no active creation idempotency middleware, and writes click events and counters
separately. Its worker reconnects without restoring consumption. Those are limitations
to study, not evidence that the proposed guarantees already exist.

> “The design is defensible when I can name the authority for a code, the maximum age
> of a redirect decision, and the point after which an event can be recovered. I would
> validate those three boundaries before expanding the feature set.”
