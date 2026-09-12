# Dashboarding: backend system design interview

## 🎯 Clarify the monitoring contract — 4 minutes

> “I would design a service that accepts metric observations, answers bounded time-series queries, and evaluates alert rules. My first question is what an ingestion acknowledgement promises, because every later chart and alert depends on that boundary.”

For this interview, acceptance means a batch is durably recorded for processing; it does
not mean that every query can see it immediately. We expose ingestion and
materialization lag. Queries may be stale within a stated budget, but a dependency
failure cannot be represented as a successful healthy measurement.

Users need metric discovery, label filtering, time aggregation, saved dashboards, and
alert history. Producers need batch ingestion and safe retries. Dashboard configuration
is ordinary relational data; observations are a high-volume time-series workload. I
would start with gauges and cumulative counters, adding a distribution-aware
representation before supporting percentile queries.

Assume a ten-second dashboard refresh target. Proposed service objectives are 99.95%
ingestion availability, 99.9% query availability, and p95 below 500 milliseconds for
bounded 24-hour queries. Seven-day queries may take up to two seconds. These targets
require a specified series count, point budget, hardware, and workload before they can
be benchmarked.

Alert rules need both a query window and a sustained-condition duration. I would clarify
how absent samples, delayed observations, evaluator outages, and rule edits affect
incidents. “Alert after five minutes” is too ambiguous to implement without
distinguishing these cases.

| Contract | Initial decision |
|----------|------------------|
| Acceptance | Durable log acknowledgement before success |
| Retry | Same immutable batch identity has one database effect |
| Query semantics | Declared type, unit, aggregation, bounds, and resolution |
| Missing data | Separate from normal values and query errors |
| Isolation | Tenant scope applies to ingestion, discovery, queries, and rules |
| Notification | Incident creation and delivery success are separate records |

## 📏 Estimate the workload — 3 minutes

Assume one million active series, each reporting every ten seconds. That is 100,000
points per second or 8.64 billion per day. A series is a metric descriptor plus its
complete label map within a tenant. A label such as request ID could increase series
count far beyond this estimate, so cardinality is a controlled resource.

At an illustrative 24 logical bytes per raw observation, seven days retain about 1.45 TB
before indexes, metadata, WAL, replication, and compression. I would not translate that
payload figure directly into a disk purchase. Actual row layout and ingestion/query
tests determine physical capacity.

Rollups also consume substantial space. One minute bucket per active series means 1.44
billion states per day. At an illustrative 48 bytes each, thirty days retain about 2.07
TB. Hourly states for one year add about 420 GB. Longer aggregate retention can exceed
shorter raw retention despite fewer states per day.

For reads, 10,000 viewers with ten panels refreshing every ten seconds produce about
10,000 panel queries per second before sharing. I would bound matching series, output
buckets, total returned points, and scanned work. A batch query endpoint reduces HTTP
overhead, not the number of distinct database computations.

The local seed is several thousand observations, so it cannot validate these production
estimates. I would use it for correctness demonstrations and develop representative load
tests separately.

## 🏗️ Draw the service boundaries — 5 minutes

I would draw two paths: accepting observations and serving measurements. Alert
evaluation reuses query semantics, but receives its own resource budget so a popular
dashboard cannot starve incident detection.

```
┌────────────────┐      ┌────────────────┐      ┌────────────────┐
│ Producers      │─────▶│ Ingest API     │─────▶│ Durable log    │
└────────────────┘      └────────────────┘      └────────┬───────┘
                                                         │
                                                         ▼
┌────────────────┐      ┌────────────────┐      ┌────────────────┐
│ Query API      │◀────▶│ Time series    │◀─────│ Store worker   │
└────────┬───────┘      └────────────────┘      └────────────────┘
         │
         ▼
┌────────────────┐      ┌────────────────────┐
│ Rule workers   │─────▶│ Incident DB        │
└────────────────┘      │ + deliveries       │
                        └────────────────────┘
```

A durable log such as Kafka absorbs a bounded backlog and separates acknowledgement from
storage processing. It does not increase database capacity or make an unlimited outage
safe. The ingestion API applies authentication, quotas, and validation before allowing a
producer to allocate that backlog.

PostgreSQL stores configuration, series metadata, receipts, incidents, and delivery
obligations. TimescaleDB supplies time-based storage and aggregation capabilities in the
initial database deployment. Redis can cache reusable query results and sessions;
neither is authoritative evidence that observations were committed.

At first, several logical responsibilities can share a deployment while having separate
pools and concurrency limits. Splitting every component into a service would add failure
boundaries before measurements justify it. At the proposed scale, I would expect
ingestion, interactive queries, and rule evaluation to need independent resource control
early.

If one storage instance becomes insufficient after reducing avoidable work,
application-level routing to independently owned tenant or series partitions is a
possible next step. Cross-partition queries then need bounded fan-out and merge
semantics. I would not assume that adding API processes distributes database writes
automatically.

## 💾 Describe data and API contracts — 4 minutes

I would describe the model in a table on the whiteboard rather than write a database
schema. The critical additions are identities and state that make retries and
uncertainty explicit.

| Record | Important fields | Correctness purpose |
|--------|------------------|---------------------|
| Metric descriptor | Tenant, name, type, unit, allowed labels | Define identity and supported operations |
| Series | Descriptor, canonical label map, stable ID | Avoid ambiguous or duplicate identities |
| Observation | Series, event time, numeric value | Preserve accepted measurements |
| Batch receipt | Producer/epoch, batch ID, payload digest, commit status | Make replay effects repeatable |
| Aggregate state | Series, bucket, sum, count, min/max, coverage | Combine buckets without losing weighting |
| Dashboard/panel | Owner, query definition, layout, revision | Save configuration and reject stale edits |
| Alert rule | Scope, query, predicate, window, duration, version | Define what is evaluated |
| Rule/group state | Rule version, owner generation, pending time, quality | Serialize valid transitions |
| Incident/delivery | Evidence, transition ID, destination, attempt status | Explain alerts and repair delivery |

Canonical identity must preserve label names and values unambiguously. Joining arbitrary
strings with commas and equals signs is insufficient because different maps can produce
the same key. Tenant identity comes from authenticated scope rather than trusting a
client label named tenant.

| Proposed endpoint | Purpose |
|-------------------|---------|
| POST /api/v1/metrics/ingest | Accept a bounded identified batch after durable append |
| POST /api/v1/metrics/query | Execute a bounded authorized query with quality metadata |
| GET /api/v1/metrics/definitions | Discover a paginated authorized set of series |
| PUT /api/v1/dashboards/:id | Conditionally update configuration at an expected revision |
| POST /api/v1/alerts/rules | Create a versioned rule |
| POST /api/v1/alerts/rules/:id/test | Evaluate a preview without creating an incident |
| GET /api/v1/alerts/instances | Read bounded incident history and evaluation context |

I would return accepted batch identity separately from visibility status, using an
asynchronous-acceptance response for the proposed log-backed path. Query responses
include effective bounds, interval, complete series identity, observation age, coverage,
and partial/error status. The repository's current HTTP 200 ingestion count and plain
series arrays do not implement those contracts.

## 🔧 Deep dive 1: durable acceptance with bounded retry effects — 8 minutes

> “I would choose a durable ingestion log at the stated workload, then make the storage effect repeatable with an immutable batch identity. A queue acknowledgement alone does not deduplicate database writes.”

The producer assigns an identity within its producer/epoch namespace and fixes the batch
payload. On a timeout it retries the same identity and payload. Repacking old
observations into a new batch identity is outside this deduplication guarantee; that
would require a separate stable observation identity.

The ingestion API authenticates, checks size and timestamps, validates metric types and
labels, and enforces new-series and point quotas. It appends the identified payload to
the log and acknowledges only after the configured durable broker boundary. If that
boundary fails or remains unknown, the producer retries using the same identity.

A storage worker consumes a bounded batch and resolves distinct series identities once
per batch with limited concurrency. It then writes the observations and processed-batch
receipt in one transaction. The unique receipt identity arbitrates concurrent
redelivery; a conflicting payload digest is an error, not another legitimate submission.

Only after the transaction commits does the worker advance its consumer checkpoint. A
crash before commit leaves no applied receipt or observations. A crash after commit but
before checkpoint advancement causes redelivery, which finds the receipt and skips
reapplying the samples. This is repeatable database effect over at-least-once transport,
not a universal exactly-once promise.

If the database connection drops during commit, the worker treats the result as unknown
and resolves it by reading or retrying the same identity. It must not generate another
identity to escape uncertainty. Retain receipts longer than the supported client retry
and broker replay windows; unlimited deduplication history is not free.

A database outage grows log lag. We monitor its oldest unprocessed age and remaining
retention/capacity, then apply backpressure before accepted work can age out. Broker
availability and storage visibility have different service indicators. The system must
expose both rather than report a healthy HTTP intake while observations disappear from
queries.

Direct synchronous insertion is a reasonable smaller-system alternative. Its
acknowledgement can mean database commit, and it avoids a broker, consumer lag, and
another operational subsystem. It still needs a way to resolve an unknown write outcome
and to reject work honestly when storage is unavailable.

The proposed workload favors buffering because producers can burst and database
maintenance should not immediately interrupt every producer. The trade-off is delayed
visibility, more moving parts, and retention management. I would benchmark direct
ingestion first for a smaller deployment rather than require Kafka merely because this
is a metrics system.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Durable log plus transactional receipts | Bounded replay and burst absorption; explicit acceptance | Operational cost, lag, receipt retention |
| ❌ Unidentified at-least-once inserts | Simple worker loop | Retries distort counts, sums, and selective averages |
| ❌ Successful empty fallback on insert failure | Keeps HTTP success rate high | Claims acceptance without storing observations |

Finally, cache keys cannot substitute for durable identity. The local implementation's
ambiguous label key can map distinct series to one ID, and its open ingestion breaker
can return an accepted count without an insert. Those examples show why identity and
acknowledgement must be checked at the actual storage boundary.

## 🔧 Deep dive 2: plan queries without changing metric meaning — 8 minutes

> “I would choose mergeable aggregate states for long ranges, with a planner that considers data age, coverage, and requested resolution. Selecting a table from range duration alone is not enough.”

A one-hour range from yesterday can use a seven-day raw tier. A one-hour range from six
months ago cannot. The planner must know which tiers cover the requested interval and
which buckets are materialized. It also checks the output and scan budget before
launching work.

For sample averages, store sums and counts and divide after combining states. A bucket
averaging zero from one sample and another averaging 100 from nine samples combine to
90, not 50. An average of averages silently gives sparse and dense buckets equal weight.

Counting also needs a clear definition. Counting returned time buckets is not counting
the underlying observations. If two buckets contain 40 and 60 observations, their
observation count is 100, while the number of buckets is two. Distinct-host count and
total event count are different operations again.

Metric type and units constrain aggregation. A cumulative counter needs reset-aware
change over time before producing a rate; detect resets per series before combining
hosts. A gauge is a sampled level. Summing observations of a requests-per-second gauge
over time does not directly produce another requests-per-second measurement.

Grouping is a real reduction across series, not just an extra cache-key field. The
planner identifies which labels are retained, which series are combined, and whether the
result weights samples, hosts, or time. The first version can support sample-weighted
means and explicitly separate other operations rather than silently guessing.

I would use non-overlapping half-open intervals to join materialized buckets with a
recent raw tail. A known materialization boundary prevents double counting. For a range
cutting through a coarse bucket, use raw observations for the edge when retained;
otherwise disclose coarser effective bounds or reject a request requiring exact edges.

Late arrivals require refresh and cache policy. A recent materialization window handles
bounded lateness; older corrections use an explicit backfill path and data-generation
change. Historical queries are not automatically immutable. Retain raw observations
until required aggregates are verified, and avoid refreshing retained historical
aggregates from already deleted raw regions. [Timescale refresh-policy
behavior](https://github.com/timescale/docs/blob/latest/use-timescale/continuous-aggregates/refresh-policies.md)

Caching uses normalized plans including tenant scope, filters, operation, grouping,
aligned bounds, resolution, and data generation where applicable. A shared refresh
anchor creates reuse; independently chosen millisecond endpoints often do not. Cache
misses should share bounded in-flight work, and dependency errors must remain errors
rather than cacheable empty measurements.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Mergeable states and coverage-aware planning | Bounded long-range work with explicit precision | Materialization, lateness, and retention coordination |
| ❌ Raw scans for every historical dashboard | Flexible exact calculations while data remains | High repeated scan cost and expired-data gaps |
| ❌ Average averages or infer precision from output interval | Small implementation | Wrong weighting and invented detail |

The cost is information loss and additional maintenance. Min/max can preserve extrema
but cannot reconstruct the original sequence. Percentiles need compatible distribution
state; per-bucket percentile values cannot reconstruct a global percentile. I would
expose these limits in the query contract so the browser can explain them honestly.

## 🔧 Deep dive 3: alert state under missing data and failures — 8 minutes

> “I would model condition state and data quality separately, and serialize transitions for each rule/group. A missing result is not evidence that an existing incident has recovered.”

Each evaluation uses a versioned query plan and a fixed cutoff. The query window defines
which observations contribute to the predicate. A separate duration defines how long
valid evaluations must keep that predicate true before the incident fires. Evaluation
cadence and ingestion lag limit the precision of that claim.

A healthy-quality true result moves normal to pending, then firing after the required
duration. A valid false result can resolve a firing incident according to recovery
policy. No-data and query-error results update quality without silently resolving the
incident. Product policy decides whether they pause or reset pending duration and
whether to open a separate telemetry incident.

For irregular evaluation gaps, I would avoid pretending that no observations means
continuous proof. Persist the last accepted evaluation time, pending-since time, and
quality. The rule specifies an acceptable freshness/coverage threshold, so one old
sample cannot keep a current incident evaluation looking healthy indefinitely.

Partition rules and their groups across evaluator workers. An ownership generation
fences a previous worker after reassignment, and a conditional database update verifies
both that generation and the expected state/version. A process-local timer or a lease
without checking its generation at commit does not prevent a late worker from changing
state.

State transition and notification obligation commit in one transaction. A unique
transition identity prevents duplicate firing records for the same accepted transition.
The notification worker records attempts and actual outcomes, retries transient failures
with bounded backoff, and retains permanent failures for inspection.

External delivery may still duplicate after an unknown response. If the destination
supports an idempotency key, send the stable delivery identity; otherwise expose
at-least-once delivery semantics. Marking a delivery sent because code logged “would
send webhook” does not establish any external effect.

Rule changes create a new version. The system must choose whether to restart pending
duration and how open incidents relate to the new condition. Disabling a rule also has
an explicit operational meaning: stop evaluations, preserve or close incidents with a
stated reason, and retain history. Deleting configuration should not accidentally erase
the only incident evidence.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Fenced state transitions plus delivery outbox | Stable incidents and repairable notifications | Persistent coordination and explicit quality policy |
| ❌ Timer in every API process | Easy local scheduling | Overlap, duplicate incidents, inconsistent ownership |
| ❌ Resolve on empty and mark delivery after logging | Minimal state model | False recovery and unsupported delivery claims |

The trade-off is more durable state and operational tooling. I would accept it because
alert correctness matters most when dependencies are degraded. Reusing one query
implementation preserves aggregation semantics, but separate concurrency budgets and
error propagation prevent dashboard traffic from silently disabling alert evaluation.

## 📈 Handle bottlenecks and observe the system — 3 minutes

I would first bound cardinality, duplicate identity lookups, query matches, returned
points, cache-miss concurrency, and active rules. Adding API instances can otherwise
amplify database contention and evaluator duplication. A circuit breaker limits calls
during failure; it must not convert an unavailable write or query into fabricated
success.

Use distinct budgets for ingestion, interactive reads, materialization, and evaluation.
Database-side time limits and bounded queues complement client timeouts, because timing
out the caller does not necessarily cancel a running query. Historical reads may use
replicas if their coverage and lag satisfy the contract.

Observe durable acceptance, storage visibility, oldest backlog age, duplicate receipt
handling, series creation, query scan/return cost, materialization lag, evaluation
delay, no-data incidents, and real notification outcomes. Monitor the monitoring
platform through an independent path so its own ingestion outage is detectable.

Verification should include a crash after database commit but before checkpoint, receipt
races, changed-payload retries, uneven sampling, partial buckets, late backfill, raw
expiration, stale evaluator commits, and unknown notification outcomes. These are more
meaningful than a success-only throughput test.

## 🛠️ Map the proposal to the local implementation — 2 minutes

The local API inserts arrays directly into TimescaleDB and uses Valkey for
sessions/caching. Kafka is an optional, unwired Compose profile. The schema has seven
tables and seven-day raw retention, with no rollups, receipts, evaluator ownership, or
delivery outbox. Longer queries select missing tables, and `group_by` does not reduce
series.

The evaluator runs in every API process. Count evaluation counts buckets, missing data
can resolve firing rows, and webhook delivery is only logged. Metrics and alert routes
are public; dashboard ownership checks are incomplete. There are no seeded users or
first-admin bootstrap flow.

Source review and isolated mocked-module checks support these findings; production
throughput, real database concurrency, and full browser flows were not tested in this
audit. The next implementation priorities are honest failure responses, correct series
identity and aggregation, then explicit alert quality and serialization. [Architecture
and implementation notes](./architecture.md#implementation-notes)
