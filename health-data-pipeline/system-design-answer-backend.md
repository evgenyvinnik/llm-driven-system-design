# Health Data Pipeline — Backend System Design Interview

> “I would separate durable ingestion from derived reports. The two hardest questions are
> whether a retry creates another effect and whether overlapping devices describe additional
> activity or the same activity twice.”

This 45-minute answer proposes a production design. The repository implementation is a smaller
synchronous prototype; its limitations are discussed at the end rather than assumed to be
production guarantees.

## 🎯 Requirements and estimates — 4 minutes

I would clarify that we are building personal health reporting, not clinical diagnosis or
emergency monitoring. We accept measurements, preserve their provenance, and produce
understandable summaries across devices.

The primary operations are device registration, batch upload, report queries, source
inspection, and correction/deletion. Trend summaries can follow once the underlying reports
expose adequate coverage and consistent semantics.

The correctness requirements matter more than naming infrastructure:

- A lost response must not make a retry duplicate an accepted sample.
- Two devices observing the same interval must not automatically double the total.
- Late arrivals and corrections must update complete affected periods.
- A successful upload receipt must survive an API process crash.
- Reads must remain scoped to the current authorized user.

For capacity, assume one million daily active users and 1,500 samples per user per day. That
is 1.5 billion samples/day, or roughly 17,400 samples/second on average. I would plan around a
hypothetical 100,000-sample/second peak.

With full 500-sample batches, that peak is 200 upload requests/second. Small batches change
request overhead, so I would measure both samples and requests instead of treating them as
interchangeable load estimates.

At 200 bytes per sample, raw payload is about 300 GB/day before replication and indexes. This
suggests partitioning and an explicit retention policy. It does not imply that the local
database has been benchmarked at that scale.

Initial targets could be p95 acceptance below 500 ms and ordinary report publication within
two minutes. Historical imports get a separate processing objective so they cannot monopolize
recent-data capacity.

## 🏗️ High-level architecture — 7 minutes

I would draw the acceptance path across the top, the durable ownership boundary in the middle,
and workers plus queries below it.

```
┌────────────────────────┐ batch  ┌────────────────────────┐        ┌────────────────────────┐
│ Sync client + journal  │        │ Ingestion API          │        │ Identity + grants      │
│ Saved batch/sample IDs │◀──────▶│ Validate + authorize   │◀──────▶│ User / device scope    │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                                                         ▲
                                                         │
atomic: samples, receipt, dirty buckets, outbox          │
                                                         │
                                                         ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ PostgreSQL / time-series partitions, sharded by user                                       │
│ Raw versions + source identity registry + receipts + dirty generations / outbox            │
│ Published bucket versions, provenance, policy version, access grants                       │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                       ▲                                  ▲                                ▲
                       │                                  │                                │
 inputs / publish      │           committed jobs         │          scoped reads          │
                       │                                  │                                │
                       ▼                                  ▼                                ▼
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Rollup workers         │        │ Dispatcher + queue     │        │ Query API              │
│ Full affected buckets  │◀──────▶│ Retry / bounded jobs   │        │ Current authorization  │
│ Metric-specific rules  │        │ Outcome / retry state  │        │ Published versions     │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                                                                                           ▲
                                                                                           │
                                                                     reports / status      │
                                                                                           │
                                                                                           ▼
                                  ┌──────────────────────────────────────────────────────────┐
                                  │ Dashboard clients                                        │
                                  │ Charts, source coverage, accepted vs processed status    │
                                  └──────────────────────────────────────────────────────────┘
```

The sync client owns stable sample IDs and retry state. Ingestion authenticates the caller,
verifies the device, validates the batch, and commits raw versions together with a receipt and
pending work.

The large storage box is a logical user shard. It contains relational control records and
time-partitioned samples. Co-locating that user's receipt, source identity, and outbox keeps
acceptance within one transaction.

The dispatcher reads committed outbox work and delivers retryable jobs. Workers read complete
affected periods, resolve source overlap, and publish versioned aggregates. The queue can
deliver a job more than once without changing its logical effect.

I would trace a lost upload response and a retried rollup separately:

1. The sync client's bounded journal retries or resolves the original batch key and sample versions after current device authorization.
2. The committed receipt decides acceptance. A worker then reads complete inputs for the identified bucket generation and policy.
3. Publication rechecks that generation and deletion/policy epoch. Record a completed or superseded outcome before acknowledging work, while leaving newer required work pending.
4. Report reads return the resulting publication and coverage. A worker acknowledgement for an older job is not evidence that every accepted correction is now visible.

The query service performs current authorization and returns a published version with coverage
and processing status. A cache may accelerate that read, but cannot decide whether the caller
still has access.

> “The important arrow is the one from ingestion into durable storage. I acknowledge there.
> The worker arrows explain why an accepted upload can still be pending in the dashboard.”

I would start with PostgreSQL and time partitions, then shard by user ownership as measured
load requires. A separate distributed log or database for every box is unnecessary for the
first version.

The frontend remains a consumer of report semantics. It should not independently resolve
sensor overlap, because different clients would otherwise disagree about the same user's
total.

## 💾 Data model and APIs — 5 minutes

There are two identities to preserve: the logical source sample and the batch request that
transported it. A sample may appear in several batches, while a batch contains many samples.

| Record | Key fields | Main access pattern |
|--------|------------|---------------------|
| Device | Owner, device/provider ID, status | Authorize a source before ingestion |
| Source identity | Owner, device, source sample ID, version, digest, event partition | Resolve retry or explicit correction |
| Raw sample version | Metric, original/normalized units, value, interval, provenance | Rebuild affected periods |
| Batch receipt | Owner, device, batch key, digest, outcome | Replay an accepted request safely |
| Dirty bucket / outbox | Scope, desired generation, job ID | Recover and coalesce processing |
| Published bucket | Value, coverage, policy, input generation, publication version | Serve bounded reports |

A time-partitioned raw table often has uniqueness tied to its partition key. I would use an
ordinary source identity registry within the user shard so a retry cannot evade identity
checks by changing its event timestamp.

The original observation remains distinguishable from the normalized value and derived
projection. That makes a unit-policy change or source-priority change explainable instead of
destructive.

I would keep the whiteboard API small:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/devices` | Register an owned source |
| POST | `/devices/:id/batches` | Validate and durably accept a bounded batch |
| GET | `/receipts/:id` | Return acceptance and processing state |
| GET | `/reports` | Return a bounded metric/range projection |
| POST | `/samples/:id/corrections` | Submit an explicit new source version |
| DELETE | `/samples/:id` | Request scoped deletion and recomputation |

These are proposed contracts. Each result needs stable identity and meaningful status;
detailed request bodies are less useful in the interview than agreeing on retry and
authorization semantics.

## 🔧 Deep dive 1: Durable ingestion and retries — 8 minutes

**Decision: commit the receipt, accepted samples, and pending work together.**

Suppose a watch uploads a batch, the database commits, and the network drops before the
response arrives. The client cannot know whether the server accepted it. Retrying must return
the same logical result.

The client supplies a batch key, scoped by authenticated owner and device. The server also
computes a canonical digest over all relevant content, including units, sample IDs, source
versions, values, and intervals.

A repeated key with the same digest returns the saved outcome. A repeated key with different
content is a conflict. A key by itself is not proof that two requests mean the same thing.

Authorization precedes receipt lookup. Otherwise a globally reused key could return someone
else's cached response, especially when that response contains invalid-sample details.

The transaction has four responsibilities:

1. Claim or resolve the scoped receipt identity under a uniqueness constraint.
2. Validate source identities and insert accepted raw versions.
3. Advance affected bucket generations and insert/coalesce outbox work.
4. Store the final per-item outcome and commit before acknowledging acceptance.

Invalid samples can be reported individually under a documented partial-acceptance contract.
An unauthorized device rejects the entire request. Bound both bytes and sample count, as well
as interval duration and backfill age.

Unit validation is not just a formatting concern. If the system cannot convert “hours” to the
canonical sleep unit, it should reject that unit rather than retain the number and label it
“minutes.” Values must also be finite, and interval endpoints must be valid and ordered.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Transactional receipt and outbox | Durable replay result; recoverable processing | Extra control records and worker lifecycle |
| ❌ SQL insert followed by independent queue publish | Simple happy path | Crash between steps leaves accepted data unprocessed |
| ❌ Redis response cache alone | Fast duplicate lookup | Expiry, races, and SQL/cache failures break the guarantee |

A dispatcher may publish a job and crash before marking it delivered. That is acceptable:
delivery is at least once, and the worker uses stable job identity and guarded publication. I
would avoid claiming exactly-once network delivery.

The client retries uncertain acceptance with the same identity and bounded backoff. It
generates a new version only for a real correction. A receipt cache can expire for
performance, but stable source identity must outlive that cache window.

This design gives up immediate report completion in the upload response. In return, a large
backfill cannot force the device to hold a connection while every affected day is recomputed.

## 🔧 Deep dive 2: Overlap is metric-specific — 8 minutes

**Decision: preserve raw observations and apply a deterministic policy for each metric
family.**

A retry of the same source sample and two independent sensors covering the same activity are
different problems. Stable IDs solve the first. They cannot decide whether a phone's steps
should add to or overlap a watch's steps.

For interval totals, I would establish a versioned source preference policy and resolve
coverage before summing. This is a product rule, not a medical claim that one brand always
measures better.

Imagine a preferred source covers minutes 30–60, while another source covers 0–90. The
lower-priority interval contains the first one. An overlap check that only tests whether an
endpoint falls inside an existing interval misses this case.

The correct operation is to subtract the full union of preferred coverage. Here, the remaining
fragments are 0–30 and 60–90. If an interval crosses midnight, split those fragments again at
the report boundaries.

For an interval total, allocating value in proportion to uncovered duration is an estimate. We
do not know that steps were uniformly distributed during the interval. Retain that provenance
and prefer finer source observations when the product needs more precision.

A second example exposes why a universal clipping function fails. Two overlapping readings of
100 bpm should not become 100 bpm and 50 bpm merely because one interval is half covered.
Duration changed; the physical rate did not.

| Metric family | Example | Proposed rule |
|---------------|---------|---------------|
| Interval total | Steps / active energy | Resolve coverage; split boundaries; label any proration |
| Point/rate observations | Heart rate | Define observation or time weighting explicitly |
| Latest measurement | Weight | Latest eligible event time with deterministic tie-breaker |
| Covered duration | Sleep | Union eligible sleep intervals under a stage/source policy |

I would store enough intermediate information to combine reports correctly. For an
observation-weighted average, preserve sum and count. Averaging daily averages without their
weights is not generally equivalent.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Metric-specific, versioned fusion | Preserves units and explainable provenance | More policy cases and targeted verification |
| ❌ One priority-and-clipping algorithm for every metric | Easy to reuse | Scales rates incorrectly and selects “latest” by the wrong order |

The projection should distinguish observed coverage from no observations. Missing input cannot
automatically become a zero, and a daily maximum should not be inferred from an average-only
projection.

Tie-breakers must be stable. Equal source priority and equal event time need an explicit
secondary identity, otherwise input ordering can change the published result between runs.

I would implement a sweep over sorted interval boundaries or equivalent interval-set
operations for dense overlap windows. Repeatedly scanning a growing list and clipping only the
first match is both incomplete and potentially quadratic.

> “I am choosing explainability over a universal reducer. The extra domain modeling is
> justified because two reports with the same numeric type can still require completely
> different mathematics.”

## 🔧 Deep dive 3: Late data and safe publication — 7 minutes

**Decision: rebuild complete affected buckets, then publish only a current generation.**

Suppose yesterday already contains 8,000 steps. A delayed batch adds one observation from
noon. Querying only the new batch's start-time range and replacing yesterday's row can erase
the rest of the day's data.

Recomputation therefore reads the complete bucket's relevant inputs, including intervals that
began before the bucket and still overlap it. For a correction moving an interval, dirty both
its previous and new coverage.

The reporting timezone is part of bucket identity. Convert its local day boundaries to
half-open UTC intervals; daylight-saving changes mean “one day” is not always 24 hours.
Relabeling timestamps after aggregation cannot repair an incorrectly chosen boundary.

Now consider two workers. Worker A reads generation 10. More data arrives and advances the
bucket to generation 11. Worker B finishes first. If A later writes unconditionally, it
replaces the newer result with older input.

The publication transaction compares the worker's input generation with the current desired
generation. If they differ, discard the stale result and ensure the newest generation remains
scheduled.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Complete rebuild plus generation check | Clear correction/deletion semantics; rejects stale workers | Repeated reads and compute for busy buckets |
| ❌ Increment totals for every delivered batch | Cheap ordinary update | Retries and overlap-policy changes are difficult to reverse |
| ❌ Let the last finishing worker win | Minimal coordination | Completion order can move reports backward |

A generation is not merely a timestamp in the job message. It must identify the input snapshot
used and be checked atomically with publication. Otherwise the job can compute from mixed
input or race after its check.

If hourly and daily values must agree in one screen, publish a coherent report head pointing
to the completed bundle. If we publish buckets independently, return their revisions and
coverage instead of claiming a single atomic snapshot.

Deleting the last contributing sample must publish an explicit empty bucket or remove its
current head. Returning early on “no inputs” would leave an old total visible forever.

Deletion and policy changes also advance an epoch checked at publication. That prevents an old
worker from resurrecting removed data after the deletion job finishes.

The query cache uses immutable publication versions, scoped by owner, metric, range,
resolution, and reporting zone. The service resolves current access and the report head before
using a cached payload. A five-minute TTL alone cannot guarantee either freshness or
revocation.

The cost is additional coordination and more recomputation. I would first coalesce dirty work
and bound backfills; incremental algorithms can follow if measured workload justifies their
greater correction complexity.

## 📈 Scaling and failure handling — 3 minutes

User-based sharding keeps acceptance transactions local. Time partitions then bound scans and
lifecycle operations inside a shard. A few very active users still need fair queue scheduling
and per-account limits.

The first expensive path is likely overlap resolution and repeated bucket rebuilds. Separate
recent updates from large historical imports, coalesce repeated dirty buckets, and track the
oldest pending generation.

| Failure | Response |
|---------|----------|
| API crashes after commit | Same receipt identity returns the accepted outcome |
| Dispatcher or worker restarts | Retry stable committed work |
| Cache unavailable | Use a deliberately bounded authoritative read path |
| Processing delayed | Serve last published version with lag/coverage status |
| Access revoked | Reject the read before any cached payload is returned |

I would monitor accepted versus rejected samples, duplicate outcomes, publication lag,
stale-worker rejections, query latency, and coverage. Raw capture delay and server processing
delay need separate metrics.

Retention needs a deliberate contract for raw data, derived reports, deletion, and any
archives. Once original observations expire, we may no longer be able to rebuild historical
reports under a new fusion policy.

## ⚖️ Trade-offs and implementation boundary — 3 minutes

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Acceptance | ✅ Durable receipt plus outbox | ❌ Inline work plus response cache | Recover after uncertain delivery |
| Fusion | ✅ Metric-specific policy | ❌ Universal clipping | Preserve measurement meaning |
| Corrections | ✅ Full bucket and guarded publication | ❌ Partial replacement | Prevent lost contributions and stale results |
| Storage boundary | ✅ User-owned shard | ❌ Unnecessary cross-shard acceptance | Keep correctness transactions manageable |

The local implementation uses Express, TimescaleDB, and Valkey. It inserts samples and
aggregates synchronously, uses non-atomic Redis receipts, and lacks source-version identities,
an outbox, and publication generations.

Its sync route does not verify device ownership, cache invalidation misses actual query keys,
and overlap processing can produce incorrect totals and rates. The interview design addresses
those boundaries; it should not be presented as already implemented. See
[architecture.md](./architecture.md#implementation-notes) and [README.md](./README.md).

> “I would close at the whiteboard by following one delayed upload: authorize it, accept it
> durably once, rebuild the complete affected periods under a known policy, and expose the
> resulting version with honest coverage. That path is the core of the system.”
