# Dashboarding: full-stack system design interview

## 🎯 Agree on what the product promises — 4 minutes

> “I would design an operational metrics dashboard around a trustworthy path from accepted observation to displayed evidence. The hard part is preserving meaning across ingestion, aggregation, refresh, and alerting.”

An engineer should be able to compare CPU, memory, traffic, and error measurements over
a shared window, inspect individual series, and save useful dashboard configurations.
Alert rules should produce incidents with enough context to explain why they opened,
whether evaluation remains reliable, and whether a notification was actually delivered.

I would clarify the required freshness. Assume ten-second browser refreshes, with
explicit ingestion and aggregation lag. That supports trend monitoring without requiring
a persistent stream to every browser. A sub-second operational display would justify
revisiting transport and backend fan-out.

We start with scalar gauges and cumulative counters. Units and supported operations are
part of the metric definition; a user-entered axis suffix is not a semantic contract.
Percentiles require distribution data before they can be offered. Logs, traces,
arbitrary executable plugins, and a general query language remain outside the first
design.

The main correctness requirements are that acknowledged batches cross a durability
boundary, retries do not silently distort measurements, charts do not move or invent
points, and missing telemetry does not automatically resolve an incident. A partial
result can be useful if its limits are visible.

| User action | Required system behavior |
|-------------|--------------------------|
| Producer retries a batch | Resolve the same identity without duplicating its effects |
| User changes time range | Show results belonging to the new range |
| User compares panels | Share absolute bounds and disclose resolution/freshness |
| One query fails | Preserve usable sibling panels and identify the failure |
| User edits a panel or rule | Detect stale saves and preserve an unsuccessful draft |
| Telemetry disappears during an incident | Expose uncertainty instead of declaring recovery |

## 📏 Estimate the two workloads — 3 minutes

Assume one million active series with one sample every ten seconds: 100,000 samples per
second, or 8.64 billion daily. At an illustrative 24 logical bytes per sample, seven-day
raw retention is about 1.45 TB before physical storage overhead, replication, and
compression.

Minute aggregates are not automatically tiny. One state per active series per minute
produces 1.44 billion states daily. At an illustrative 48 bytes per state, thirty-day
retention is about 2.07 TB. We must choose retention and supported resolution together
rather than promise every historical detail indefinitely.

On the read side, 10,000 concurrent viewers with ten panels refreshing every ten seconds
yield roughly 10,000 panel queries per second before reuse. One browser showing twenty
series in each panel can also receive hundreds of thousands of points per refresh unless
the query contract limits output.

Proposed targets are p95 below 500 milliseconds for bounded 24-hour queries and below
two seconds for bounded seven-day queries, with 99.95% ingestion and 99.9% query
availability. Those are design targets to benchmark against a specified workload. The
small synthetic local seed is not evidence of this capacity.

The budgets must cover active series, new-series creation, bytes, scanned work, returned
points, and active alert groups. Request rate alone does not describe cost: one broad
query or a label containing unique request IDs can dominate the system.

## 🏗️ Draw the end-to-end path — 4 minutes

I would keep the whiteboard focused on how data becomes visible and actionable.
Authentication, relational configuration, caching, and static asset delivery can be
described alongside these main boundaries.

```
┌────────────────┐      ┌────────────────┐      ┌────────────────┐
│ Producers      │─────▶│ Ingest + log   │─────▶│ Store worker   │
└────────────────┘      └────────────────┘      └────────┬───────┘
                                                         │
                                                         ▼
┌────────────────┐      ┌────────────────┐      ┌────────────────┐
│ Browser        │◀────▶│ Query API      │◀────▶│ Time series    │
│ coordinator    │      └────────┬───────┘      └────────────────┘
└────────────────┘               │
                                 ▼
                        ┌────────────────┐      ┌────────────────────┐
                        │ Rule workers   │─────▶│ Incidents +        │
                        └────────────────┘      │ delivery jobs      │
                                                └────────────────────┘
```

The ingestion API validates producers and appends identified batches to a durable log.
Storage workers write samples and receipts. A time-series store maintains raw
observations and defined aggregate states; the query service chooses sources according
to coverage and resolution.

PostgreSQL holds dashboard configuration, metric definitions, ingestion receipts, rule
state, and incidents. TimescaleDB can supply time-based storage in the initial database
deployment. Redis holds reusable query results and sessions. These roles need not begin
as separate clusters, but they require explicit authority and resource budgets.

The browser has one coordinator for query planning and refresh. Renderers draw returned
results and quality metadata without starting independent network timers. A saved
dashboard contains query definitions and layout, while its results and current hover
selection are transient state.

Rule workers reuse the query semantics with independent scheduling and concurrency
limits. They persist incident transitions and delivery obligations. A separate
notification worker attempts external delivery and records outcomes. A slow chart query
or failed webhook should not ambiguously change whether an incident exists.

## 🧭 Define shared contracts — 4 minutes

I would establish identities before choosing detailed implementation libraries. The
browser, API, worker, and storage layer must agree on which submission, configuration,
query, or incident they are discussing.

| Entity | Identity and essential meaning |
|--------|--------------------------------|
| Series | Tenant, typed metric descriptor, canonical complete label map |
| Accepted batch | Producer/epoch, immutable batch ID and payload digest |
| Stored receipt | Batch identity committed atomically with sample effects |
| Dashboard/panel | Authorized resource ID and saved revision |
| Query | Scope, filters, operation, grouping, absolute bounds, resolution |
| Refresh | Browser context and generation shared across visible panels |
| Rule evaluation | Rule version, group, cutoff, quality, owner generation |
| Incident/delivery | Stable transition and destination-specific delivery identities |

Ingestion success in the proposed system means durable acceptance for processing. Query
visibility follows later and is observable. A query response identifies its effective
window, resolution, complete series, latest observations, coverage, and any partial or
approximate result. An empty array alone cannot carry all of that meaning.

Configuration updates use expected revisions, and retryable creation uses a stable
mutation identity. The UI can therefore distinguish a saved operation from a rejected
conflict or unknown outcome. The backend binds every child mutation to the same
authorized parent used in the access check.

| API family | Shared client/server responsibility |
|------------|--------------------------------------|
| Ingestion | Stable retry identity and an honest durable acknowledgement |
| Discovery/query | Authorized bounded work and explicit measurement semantics |
| Dashboard/panel configuration | Conditional saves and preserved local drafts |
| Rule preview/configuration | Separate a tested predicate from scheduled incident state |
| Incident history | Versioned evidence, data quality, and actual delivery status |

I would not rely on dashboard privacy to protect metric values. The direct query and
discovery endpoints need the same tenant/metric scope. Likewise, hiding an edit button
improves the interface but does not authorize the corresponding HTTP request.

## 🔧 Deep dive 1: connect accepted data to honest freshness — 8 minutes

> “I would decouple durable acceptance from query visibility, then make that delay observable all the way to the panel. This provides burst tolerance without pretending that every accepted point is already on screen.”

A producer assigns an immutable batch identity and retries it unchanged after a timeout.
The API validates labels, timestamp bounds, size, and quotas, then appends to the log
with the required durability acknowledgement. If that boundary fails, it returns an
explicit retryable or unknown outcome rather than reporting an accepted sample count.

A worker resolves distinct series identities within the batch using bounded lookup
concurrency. Identity serialization must preserve label names and arbitrary values;
delimiter concatenation can map two different label maps to the same series. New-series
limits also protect metadata and caches from unbounded growth.

Samples and a processed-batch receipt commit together. The worker advances its consumer
checkpoint only after commit. A crash before commit leaves no applied batch; a crash
after commit causes redelivery that recognizes the receipt. A payload digest detects
reuse of an identity with different contents.

The guarantee applies to the same immutable batch. If a producer resubmits old
observations under a new identity, batch-level deduplication cannot recognize them.
Receipts also have a retention contract covering supported retry and replay windows.
These limits must be explicit before claiming that retries are safe.

Direct insertion is a simpler valid starting point for a small system: acknowledge
database commit and avoid broker operations. At the assumed high sustained volume and
bursty input, a durable log provides controlled buffering. We give up immediate
visibility and take on backlog, replay, and retention operations.

A database outage can leave ingestion available temporarily while panels age. The system
reports oldest unprocessed log age, storage visibility, and aggregate freshness. When
retained backlog approaches its limit, intake applies backpressure rather than accepting
work it cannot preserve. The browser distinguishes “query completed now” from “latest
observation arrived several minutes ago.”

Now consider a user looking at a CPU panel during that outage. Repeating successful
reads of an old value should not reset its freshness indicator. The response carries
observation age and coverage; the panel retains the useful old value with a clear stale
state. Its title and units remain stable, while data quality changes.

A successful empty response requires a different explanation from an unavailable source.
If a circuit breaker opens, the query API returns an unavailable status with relevant
context. Caching an empty fallback as ordinary data could make every panel appear quiet
and feed false recovery into alert evaluation.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Durable buffering plus visible lag/coverage | Handles bounded bursts while preserving an honest display | More backend state and client quality states |
| ❌ Direct insertion at all scales | Simple commit-to-visibility path | Intake coupled to storage latency and bursts |
| ❌ Keep success responses during unavailable writes/reads | Superficially stable interface | False acceptance and misleading empty dashboards |

I would verify this contract with failures at acknowledgement and commit boundaries,
then observe the corresponding browser states. A passing chart render is not enough. We
need evidence that a repeated batch does not alter totals and that stale observations
remain labeled stale during storage failure.

## 🔧 Deep dive 2: comparable panels with bounded query cost — 8 minutes

> “I would make the query planner and browser coordinator share responsibility for comparison: the server preserves mathematical meaning, and the browser preserves context and timestamps.”

At each live refresh, the browser captures one absolute end time and derives a common
start. It creates normalized plans for visible panels, deduplicates identical work, and
limits concurrent requests. A pinned historical window does not advance automatically.
Sharing an aligned anchor also improves cache reuse compared with unrelated millisecond
timestamps.

Each plan includes metric scope, filters, aggregation, grouping, and resolution. The
server authorizes and validates it, then chooses a source based on data age and
available materialization. A short range from last year still needs retained historical
data; range duration alone cannot select the raw tier.

For averages, aggregate states retain sums and counts. Combining a bucket with one
sample at zero and a bucket with nine samples averaging 100 produces 90. Averaging the
two averages produces 50 and changes the answer. A count of observations combines bucket
counts, not the number of returned buckets.

A metric's unit also constrains the operation. A cumulative counter needs reset-aware
rate calculation per series before combining hosts. A gauge is an observed level. If a
panel displays requests per second, summing those gauge observations across time cannot
retain that unit without defining a different calculation.

The server returns a bounded number of buckets and series, including effective
resolution and coverage. Closed materialized buckets and a recent raw tail join at a
known, non-overlapping boundary. Partial edges need raw data or a disclosed coarser
range; expired observations cannot be recreated by requesting a smaller output interval.

Late observations can change historical buckets, so cache keys or invalidation reflect
relevant data generations and freshness policy. I would retain raw data until required
rollups are verified and provide a backfill path for supported older corrections. A
five-minute cache duration is a staleness policy, not proof that older data never
changes.

On the client, a new range or dashboard advances the request generation. Cancel obsolete
requests when possible and check plan/generation again before accepting any completion.
Cancellation alone does not prevent a late response from entering shared state.
Successful sibling panels remain usable when another request fails.

Rendering aligns by actual timestamps. If host A has samples at 00:00 and 00:02 and host
B has one at 00:01, each remains at its own time. Missing values stay missing.
Array-index alignment would shift B's sample; filling a missing second entry with zero
would invent a measurement.

Complete series IDs drive color and selection stability; abbreviated display labels do
not become identity. A stat panel must explicitly reduce several matches or ask for one
series. It cannot silently take the first row. Multi-day chart labels and tooltips
include enough date/time context to distinguish points.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Declared aggregate resolution and coordinated refresh | Bounded work with comparable, explainable results | Planner and lifecycle complexity |
| ❌ Raw samples and independent panel timers | Flexible small demo | Expensive transfers, overlap, stale-response races |
| ❌ Convenient averages, array joins, and zero padding | Easy API/rendering code | Alters values, timestamps, and missing-data meaning |

The trade-off is reduced detail at coarse resolution. An average can hide spikes, so
min/max summaries or a raw-data drill-down may be appropriate. The interface must expose
the effective resolution and unavailable detail. Lower latency is not a success if it
depends on presenting different mathematics without telling the user.

## 🔧 Deep dive 3: alerts and configuration across failures — 8 minutes

> “I would treat the saved rule, its evaluation, the resulting incident, and notification delivery as separate facts. This prevents a convenient form or log message from becoming unsupported operational evidence.”

The rule editor separates the measurement window from the required duration of a true
predicate. A five-minute average above 90 at one instant does not prove five minutes of
continuously valid above-threshold evaluations. The UI explains both controls and
previews available data without creating an incident.

Saving uses the rule revision the user edited. The draft survives a conflict or network
failure, and a late completion cannot update a different editor after navigation.
Creating a rule reuses a mutation identity on retry. For this structured form,
conditional saves and explicit conflict resolution are simpler than collaborative
document-editing algorithms.

Each saved rule version determines the query, grouping, threshold, sustained duration,
and missing-data policy. An evaluator uses a fixed cutoff and records quality, last
accepted evaluation, and pending-since state for each group. Condition states such as
pending and firing are separate from no-data or query-error quality.

A valid false predicate can resolve an incident according to policy. An unavailable
query cannot. If telemetry disappears while the condition is firing, the incident
retains an explicit uncertain state, and a separate telemetry incident may be
appropriate. Product policy must also define whether a gap pauses or resets pending
duration.

The evaluator has a fenced owner generation and conditionally updates the expected state
and rule version. Running a timer in every API instance allows duplicate evaluations and
competing inserts. A lease alone is also insufficient if an expired owner can still
commit; the database mutation must reject its obsolete generation.

Incident transition and notification obligation commit in one transaction. Delivery
workers retry identifiable jobs and record actual response outcomes. If a receiver
supports idempotency, the stable delivery ID helps suppress duplicate external effects;
otherwise unknown outcomes can still lead to repeated notifications under at-least-once
delivery.

The incident UI shows the evaluated rule version, affected group, transition time,
evidence, and quality. It can link to the current rule separately. Editing a threshold
later must not rewrite the apparent explanation of an earlier incident, and deleting a
rule should follow an explicit history-retention policy.

Delivery status is displayed from delivery evidence, not inferred from the incident's
existence. “Queued” and “sent” are different, and a webhook log saying what would have
been sent is neither. A capped banner list also needs an honest count label or a
separately computed total.

Authorization crosses this whole path. The rule must query only allowed metrics, and
incident readers must be allowed to inspect its evidence. Panel mutations similarly bind
the target panel to the authorized dashboard in the same operation. Checking ownership
of one dashboard while updating an unrelated panel ID is not a complete access check.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Versioned rules, fenced transitions, durable deliveries | Explainable incidents and recoverable effects | More persisted state and explicit policies |
| ❌ Last-write-wins configuration | Minimal editor/API | Lost edits and changed historical explanations |
| ❌ Resolve on empty and notify inline without receipts | Simple evaluator loop | False recovery and ambiguous or lost notifications |

The operational cost is justified because degraded conditions are exactly when
monitoring must remain understandable. I would prioritize correct state transitions and
recovery before adding elaborate chart editors. A visually polished interface cannot
compensate for an alert that disappears when its data source fails.

## 📈 Scale and verify the complete experience — 4 minutes

First reduce unbounded work: series creation, repeated identity lookups, matching-series
discovery, raw scans, returned points, simultaneous cache misses, and active alert
groups. Adding HTTP instances before bounding these can worsen database contention and
duplicate rule evaluation.

Separate ingestion, interactive queries, materialization, and rule evaluation budgets.
Client timeouts do not necessarily stop SQL, so use database-side limits and bounded
concurrency as well. Scale storage through measured capacity and explicit ownership;
adding a queue or another API process does not multiply database throughput.

Browser performance work begins with response budgets and visible-panel scheduling.
Virtualize large lists and histories, and profile chart rendering with realistic series
counts before changing rendering technology. Preserve query/editor state independently
of mounting a chart. A narrow screen needs readable stacking and keyboard-accessible
controls.

Measure the path from accepted batch to visible observation, alongside log age,
aggregate coverage, query cost, stale-panel duration, evaluation lag, and delivery
outcomes. Use an independent monitoring path for the platform itself. Otherwise its
ingestion outage can hide the very signal needed to detect it.

I would test reordered query completions, navigation during saves, uneven timestamps,
sparse bucket weighting, counter resets, raw expiration, backfill, repeated batches,
stale evaluator commits, and unknown delivery outcomes. An end-to-end scenario should
inject a storage outage and verify both the server's quality response and the
panel/incident state seen by the user.

## 🛠️ Ground the proposal in the repository — 2 minutes

The current project runs an Express API, React frontend, TimescaleDB, and Valkey. It
supplies a synthetic public dashboard, metric explorer, and alert forms. Kafka is
configured only as an optional unused profile; there is no ingestion worker or durable
receipt path. Seven-day raw retention exists, but the longer query paths refer to absent
rollup tables.

The backend can report accepted ingestion while its breaker is open, ignores query
grouping, and can treat missing alert data as recovery. The chart maps by array position
and fills gaps with zero. Independent polling lacks request generations; configuration
is unversioned; no browser login or interactive panel editor is implemented. Webhooks
are log-only, and access checks are incomplete.

These findings come from source review and isolated mocked-module checks, not a
full-stack or production-load test. The proposed design explains how those boundaries
should work while keeping current capabilities explicit. I would start implementation
with honest write/query failures and correct sample semantics, then coordinate refresh,
access, and incident transitions. [Detailed implementation
mapping](./architecture.md#implementation-notes)
