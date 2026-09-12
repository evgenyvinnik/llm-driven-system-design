# Ad Click Aggregator — Backend System Design

*A 45-minute interview discussion. This is a proposed production design. The local
implementation and its correctness gaps are described in [architecture.md](./architecture.md).*

## 🎯 Define acceptance and counting — 5 minutes

> “I would start by separating three moments: receiving a click, durably accepting
> it, and making it visible in analytics. A system can be fast at the first while
> still losing data before the second. It can also accept correctly and briefly
> show stale analytics. Those boundaries need explicit contracts.”

The product records ad clicks, groups them by time and campaign dimensions, and
flags suspicious activity. Analysts need recent reports; an accounting process needs
reconciled eligibility and a way to explain corrections.

I would ask how long clients may retry, how late events can arrive, whether fraud
classification can change, and when a reporting period becomes final. These answers
determine how long we retain identity and what “correct count” means.

For this discussion, clients create stable event IDs before sending. They may retry
an ambiguous submission with the same ID. Recent analytics is provisional, and
fraud decisions may be revised through an explicit correction process.

I would assume 10,000 clicks per second sustained, an initial acceptance p95 target
of 50 ms, and minute-level dashboard freshness. These are planning requirements,
not a benchmark or a claim that one local database already satisfies them.

| Requirement | Invariant or behavior |
|-------------|-----------------------|
| Retry-safe acceptance | One canonical event per identity and payload |
| Durable acknowledgement | Success follows authoritative commit |
| Recent analytics | Projection may lag; its coverage is visible |
| Explainable fraud | Preserve input, rule version, and decision history |
| Correct rollups | Count disjoint events; union distinct-user state |
| Recoverability | Replay and corrections do not silently add duplicate contributions |

I would keep impressions, bidding, attribution, and ML training out of the initial
design. We need a sound event and reporting foundation before expanding the domain.

## 📐 Estimate volume — 4 minutes

At 10,000 clicks per second sustained, there are 864 million events per day. At an
illustrative 500 bytes per event, that is 432 GB per day and roughly 13 TB per month
before replication, indexes, and compression.

If 10,000 is only the peak, those storage estimates are too high unless average
traffic is also near that rate. I would write “sustained” next to the assumption.

A five-minute Redis cache holds up to three million recent IDs. At an assumed
100 bytes per entry, that is around 300 MB before additional overhead. Extending
that exact cache to cover months is a different storage problem.

The cache lifetime should therefore be a performance choice. The authoritative
identity retention must cover the accepted retry and replay policy independently.

Reporting volume depends on the dimensions we expose. Minute, ad, campaign, country,
and device combinations can create a large sparse cube. I would precompute the
common access patterns rather than every conceivable combination.

One thousand dashboard users refreshing once every five seconds imply about
200 queries per second for one combined report endpoint. Query caching and bounded
ranges can matter as much as raw event throughput.

## 🏗️ Draw the service boundaries — 5 minutes

```
┌─────────────┐   ┌─────────────┐   ┌────────────────────┐
│ Click source│──▶│ Collector   │──▶│ Canonical events   │
│ stable IDs  │   │ validate    │   │ + outbox transaction│
└─────────────┘   └─────────────┘   └──────────┬─────────┘
                                              │ relay
                                              ▼
                                    ┌───────────────────┐
                                    │ Durable stream    │
                                    └──────────┬────────┘
                                               ▼
                                    ┌───────────────────┐
                                    │ Fraud + aggregate │
                                    │ durable state     │
                                    └──────────┬────────┘
                                               │ versioned snapshots
                                               ▼
                                    ┌───────────────────┐
                                    │ Analytics store   │
                                    └──────────┬────────┘
                                               ▼
                                    ┌───────────────────┐
                                    │ Reporting API     │
                                    └───────────────────┘
```

PostgreSQL is an initial candidate for canonical events, metadata, and an outbox.
A durable stream decouples acceptance from projection. ClickHouse serves bounded
analytical queries over a derived representation.

Redis can accelerate duplicate-response lookups and maintain short-lived fraud
signals. It does not own the final truth about whether an event was accepted.

At this volume, authoritative storage needs batching, partitioning, retention, and
possibly sharding. I would measure the write path before choosing shard counts.
The diagram expresses responsibilities rather than promising that one PostgreSQL
instance handles every production event forever.

### Data model and interfaces

| Entity | Key fields | Important constraint |
|--------|------------|----------------------|
| Advertiser/campaign/ad | IDs, ownership, status | Resolve hierarchy from trusted metadata |
| Canonical click | Event ID, payload fingerprint, event time, received time | One payload per logical identity |
| Outbox item | Event ID, publish progress | Created with the canonical event |
| Fraud decision | Event ID, rule version, decision revision, reason | Reclassification retains history |
| Aggregate state | Bucket/dimensions, counters, distinct state, revision | Updated with durable consumer progress |
| Report generation | Source boundary, revision, completeness | Defines a reproducible published result |

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/clicks` | Accept one stable logical event |
| POST | `/api/v1/clicks/batch` | Return per-event acceptance outcomes |
| GET | `/api/v1/analytics/aggregate` | Query a bounded range and supported dimensions |
| GET | `/api/v1/analytics/campaign/:id/summary` | Campaign-level report with coverage metadata |

The collector authenticates the source and validates ownership. A client-supplied
advertiser ID is a claim to verify, not permission to write or query another account.

## 🔧 Deep dive 1: make retry effects durable — 10 minutes

> “I would put the canonical click and the obligation to publish it in one database
> transaction. That gives me a clear acceptance point. Redis reduces repeated work,
> but neither a cache key nor a unique row in one database makes all later effects
> exactly once.”

Consider a collector that writes PostgreSQL, increments Redis counters, and inserts
into ClickHouse. If the last step fails, the first two may already have succeeded.
Putting the calls in parallel changes latency, not their atomicity.

There are two bad retry outcomes. If we skip the retry because a Redis marker says
“processed,” the analytics copy stays missing. If we repeat every step, we can
increment counters again even though PostgreSQL refuses a duplicate row.

The latter is easy to miss when the insertion uses an ignore-on-conflict operation.
A caller must know whether it created a new record; otherwise it can perform side
effects after an insert that did nothing.

### Define the acceptance transaction

The proposed collector follows a short sequence:

1. Validate event identity, ownership, size, and timestamp bounds.
2. Insert the canonical event under a unique identity.
3. Insert the associated outbox work in the same transaction.
4. Commit, then return the event's acceptance result.
5. On conflict, retrieve the existing event and compare payload fingerprints.

A matching retry receives the same logical result. A different payload under the
same identity is a conflict, because silently accepting it would make the audit
record ambiguous.

A server-generated ID alone does not solve network retries: after losing the first
response, the client might not know that ID. The producer should create an event ID
before transmission, or provide a stable request key that maps durably to the event.

The response means “accepted durably,” not “visible in every dashboard” or “eligible
for a charge.” Those are later states that can evolve independently.

### Publish at least once, apply once logically

The outbox relay publishes committed events and records progress. It can crash after
publishing but before marking an item complete, so a duplicate delivery is expected.

The consumer must couple its processed-event record and aggregate-state update in
one durable transaction, or use an equivalent state/checkpoint mechanism. On replay,
it observes that the event's contribution is already applied and does not add it again.

Advancing a broker offset before state is durable risks a missing contribution.
Advancing it after state is durable permits replay, which the processed-event
contract handles. Broker delivery settings alone do not establish this sink behavior.

### The analytics sink still needs a contract

If the consumer retries an additive ClickHouse insert after an ambiguous response,
it may add the same count twice. I would publish absolute aggregate snapshots with
a monotonic revision for each bucket and full dimension key.

The reporting query selects the latest revision for each logical bucket before
summing across disjoint buckets. Repeating a revision does not add another value,
and an older retry cannot replace a newer snapshot.

This requires stable revision generation and query semantics that select one value
per logical key even before background merges finish. Simply naming a table
“replacing” or “summing” is not the full correctness argument.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Canonical transaction, outbox, idempotent projection | Recoverable work and explicit retry boundaries | More state, relay operation, and projection lag |
| ❌ Independent synchronous writes | Simple normal path | Partial failure can lose or duplicate derived effects |
| ❌ Redis marker as final acceptance | Fast lookup | Expiry, races, and failures around the durable write |

### Bound identity retention honestly

We need durable deduplication for the supported retry horizon. If we delete identities
and accept arbitrary older replays as new events, the logical-once guarantee ends.

For events older than the online horizon, I would reject ordinary ingestion or route
them through an explicit backfill process using canonical archived identities and
a new report generation. A five-minute cache TTL should never silently define that
business policy.

The cost is extra storage and an explicit distinction between normal retries and
historical reconstruction. For counts that influence money, that complexity is more
useful than an unsupported “exactly once” label.

## 🔧 Deep dive 2: make rollups mathematically composable — 9 minutes

> “I would precompute a small set of common rollups, but I would define each metric's
> combination rule. Click totals add across disjoint events. Distinct users need a
> union. Fraud rates need a weighted calculation. Treating all three as ordinary
> counters creates plausible-looking but incorrect reports.”

A columnar database is a good fit for scanning a few dimensions and measures across
many events. PostgreSQL remains useful for transactional relationships. The choice
is driven by access patterns; neither database is categorically unable to perform
the other's style of query.

At modest volume, PostgreSQL-only reporting can reduce operational complexity.
At sustained high volume, a separate analytics projection isolates large scans from
acceptance writes and can serve precomputed aggregates efficiently.

### Choose the rollup key from query requirements

A rollup might contain time bucket, advertiser, campaign, ad, country, and device.
Every dimension that changes the logical grouping must be represented in the key.
If one is omitted, background consolidation can combine rows that should remain
separate or retain arbitrary attribution.

Queries can combine fine-grained buckets into a coarser result if the measures are
composable. They cannot recover a dimension we already discarded.

Time partitioning helps prune and expire old data; the sort key supports common
filtering and grouping. I would choose them from actual query patterns, not assume
that a primary-looking key is a uniqueness constraint in every database engine.

### Count events, union users

Suppose one user clicks once in each of two minutes. Each minute has one click and
one distinct user. The two-minute interval has two clicks but one distinct user.

A materialized view that stores a scalar distinct count for each inserted block
cannot later recover that union by adding the scalars. Even an exact distinct
function at insertion time only knows the rows included in its input block.

For exact distinct counts, retain mergeable exact set state or query canonical raw
records for the requested interval. Exact state can become expensive as cardinality
grows. For exploratory unique-user metrics, a mergeable sketch may be appropriate
if the API labels the approximation and its intended use.

A sketch for distinct users does not imply approximate click billing. We can choose
exact event contributions and approximate audience estimates independently.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Additive counts plus mergeable distinct state | Correct combination across supported groups | Distinct-state storage and explicit merge logic |
| ❌ Sum per-block or per-hour unique-user numbers | Small and simple | Repeated users are counted multiple times |
| Alternative: query raw distinct users | Flexible and exact for canonical data | More query work for large ranges |

### Fraud is a subset, not an extra total

A report should distinguish total received clicks, flagged clicks, and eligible
clicks under a named decision policy. A flag is provisional evidence, not proof
of fraud and not automatically a final billing exclusion.

The overall flagged rate is total flagged clicks divided by total clicks. Averaging
bucket percentages gives small and large buckets equal weight and can be misleading.

A live correction may change eligibility without changing the raw click total.
Versioned snapshots can publish revised values without appending a second raw event
or requiring unsigned aggregate counters to represent a negative correction.

### Bound query work

Require a time range, allowlist grouping dimensions, parameterize values, and cap
output cardinality. A request for minute-level data across every ad for a year is
not a reasonable synchronous dashboard query.

Return totals independently of chart resolution and paginate event-detail results.
Hot query caching can help repeated campaign views, but cache identity must include
authorization scope, filters, and report version or freshness policy.

The trade-off is less arbitrary exploration in the fast API. I would provide a
separate export or offline analysis path if analysts need larger investigations.

## 🔧 Deep dive 3: late events, fraud changes, and safe recovery — 8 minutes

> “I would keep recent reports provisional and make corrections explicit. Event
> arrival order is not business time, and a live rule can be wrong. The design must
> support changing a report without deleting the evidence that explains it.”

Store event time and received time separately. Event time chooses the reporting
bucket; received time helps measure processing delay and detect implausible client
clocks. Validate unusually old or future timestamps under a documented policy.

Use UTC instants internally and half-open intervals. An event exactly at 11:00 belongs
to the next interval rather than both the 10:00–11:00 and 11:00–12:00 reports.

A watermark indicates how complete we expect the stream to be through a point in
event time. It does not prove that no older event can ever arrive. Late arrivals
within an agreed horizon can revise live buckets; older arrivals enter a controlled
correction process.

### Start fraud detection with inspectable evidence

Velocity thresholds are a reasonable first signal because we can explain the input
and the decision. A shared office or carrier address can generate legitimate bursts,
while distributed attackers can stay under a per-IP threshold.

An incrementing counter that expires sixty seconds after its first event is a fixed
expiry window, not a true sliding window. That approximation creates boundary effects.
If those matter, use finer time buckets or a sliding-window structure and measure
the additional state cost.

A click exactly on the second is not enough evidence of regular automated timing.
Actual inter-event patterns require multiple observations. I would avoid turning a
convenient demo heuristic into an assertion that a user is fraudulent.

Store rule version and reason. Evaluate false positives and preserve original data
so a later decision can be explained. ML can supplement the rules when suitable
training evidence and operational needs exist; it is not inherently incompatible
with explainability or fast serving.

### Rebuild without mixing old and new contributions

A naive backfill deletes a time range and reinserts aggregates while live events
continue arriving. The delete and live updates can race, or replay can count events
that were already represented.

I would rebuild into a new report generation from a stable canonical input boundary.
Track the later arrivals separately, apply the necessary tail or corrections, compare
counts and invariants, and publish the new generation only when it is consistent.

Readers continue using the previous generation until promotion. The new generation
must carry its coverage and decision version so cached reports can be invalidated
or distinguished correctly.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Versioned rebuild and controlled promotion | Readers avoid mixed generations; recovery is inspectable | Temporary storage and explicit source boundaries |
| ❌ Delete and refill live aggregates in place | Less staging infrastructure | Concurrent arrivals can be lost or counted twice |
| ❌ Treat first fraud result as permanent | Simple reporting state | Cannot correct false positives or explain changed policy |

Archive canonical data according to the correction and evidence-retention policy.
The existence of a retention constant does not create an archival job; uploads,
validation, cleanup, and replay tooling are separate operational work.

## 📊 Failure, scaling, and close — 4 minutes

If the authoritative store cannot commit, return a retryable failure without claiming
acceptance. If projection is down, accepted events accumulate durably and reports
show increasing lag. If Redis fails, an explicitly designed durable path can still
preserve identity even if performance or fraud signals degrade.

Monitor acceptance latency, oldest unprojected event, duplicate/conflicting identities,
projection failures, and reconciliation mismatches. A process health endpoint alone
cannot establish that a click has reached every required representation.

Hot campaigns may dominate one aggregation key. Stable partial-aggregation shards
can spread the work, with a final combine step that preserves distinct-state union.
Adding read replicas does not increase the authoritative primary's write capacity.

I would validate recovery with concurrent duplicate submissions, a crash after each
commit boundary, an ambiguous sink acknowledgement, and a replay overlapping a live
correction. These tests target the correctness argument rather than only normal
endpoint responses.

> “The design's core is a durable acceptance boundary followed by a replay-safe
> analytical projection. Composable metrics keep rollups meaningful, and versioned
> decisions and rebuilds make late changes explainable. I would measure throughput
> and add partitions as needed, but I would establish those invariants before
> describing the system as suitable for billing.”
