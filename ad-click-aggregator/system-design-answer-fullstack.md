# Ad Click Analytics — Fullstack System Design

*A 45-minute interview discussion. This proposes a production design with explicit
correctness and freshness contracts. See [architecture.md](./architecture.md) for
what the local implementation actually does.*

## 🎯 Follow a click to an analyst's decision — 5 minutes

> “I would design the journey from a click arriving to an analyst interpreting a
> campaign chart. The interesting problem is that acceptance, aggregation, and
> display happen at different times. We need the API and the interface to agree
> about what each stage guarantees.”

The system accepts ad clicks, assigns suspicious-activity signals, and provides
recent reports by campaign, time, country, and device. Analysts investigate trends;
administrators can inspect raw evidence and processing health.

I would clarify whether reports drive final invoices or operational decisions,
how late clicks may arrive, and whether fraud decisions can change. For this answer,
recent dashboard data is provisional and billing uses a separate reconciled result.

Producers generate stable event IDs before submission. A retry represents the same
logical click, even if a response was lost. We retain raw evidence and allow later
fraud corrections rather than treating the first flag as permanent truth.

The initial workload assumption is 10,000 clicks per second sustained and up to
1,000 concurrent dashboard users. Minute-level data freshness is acceptable for
analysis. The browser might poll more often, but its timer does not determine how
far the pipeline has processed.

### The promises I would make explicit

| Boundary | Promise |
|----------|---------|
| Ingestion response | The canonical event was durably accepted, or the caller gets a clear failure |
| Retry | Repeating an identity does not create another logical contribution |
| Analytics response | Metrics have a defined scope, revision, and completeness boundary |
| Dashboard | Labels and values refer to the same applied query |
| Fraud display | A flag is distinguished from confirmed billing eligibility |
| Historical correction | Revised results retain a path back to evidence and policy |

Impressions, bidding, attribution, and a general-purpose dashboard builder are out
of scope. The test-click UI is a development tool, not the production event source.

## 🏗️ Draw the system and estimate load — 5 minutes

```
┌────────────────┐   ┌────────────────┐   ┌────────────────────┐
│ Click producer │──▶│ Collector      │──▶│ Canonical events   │
│ stable identity│   │ validation     │   │ + outbox            │
└────────────────┘   └────────────────┘   └──────────┬─────────┘
                                                     ▼
                                            ┌─────────────────┐
                                            │ Durable stream  │
                                            └────────┬────────┘
                                                     ▼
                                            ┌─────────────────┐
                                            │ Fraud + rollups │
                                            │ durable progress│
                                            └────────┬────────┘
                                                     ▼
┌────────────────┐   ┌────────────────┐   ┌────────────────────┐
│ React dashboard│◀──│ Reporting API  │◀──│ Analytics projection│
│ query + state  │   │ scope + cover │   │ versioned buckets   │
└────────────────┘   └────────────────┘   └────────────────────┘
```

I would use PostgreSQL for transactional metadata and an initial canonical event
store, a durable stream for projection work, and ClickHouse for analytical reads.
Redis can support short-lived fraud signals and retry caches, while remaining
outside the authoritative acceptance decision.

At 10,000 events per second, we receive 864 million events per day. At an illustrative
500 bytes each, that is 432 GB/day before indexes and replication. This requires
an explicit partitioning and retention plan; a local single-table demo is not a
production capacity result.

For the UI, 1,000 sessions polling one combined endpoint every five seconds create
about 200 requests per second. Five independent calls per refresh would multiply
that load. I would cache identical scoped reports and bound ranges and dimensions.

These calculations identify different budgets: acceptance writes, projection work,
query fan-out, and browser rendering. Increasing capacity in one does not necessarily
fix a bottleneck in another.

## 💾 Define the shared model — 4 minutes

The frontend should not need to understand database engines, but it must understand
what the metrics mean. I would agree on a small contract before implementing charts.

| Record | Important fields | Why it exists |
|--------|------------------|---------------|
| Click | Event ID, event time, received time, trusted ad context | Canonical occurrence and retry identity |
| Fraud decision | Event ID, revision, rule version, reason | Explainable and revisable classification |
| Aggregate | Time bucket, full dimension key, measures, revision | Efficient current report values |
| Report | Applied range, timezone, totals, series, coverage | Coherent result for the UI |

Total clicks count accepted logical events. Flagged clicks are a subset under a
specified rule revision. Eligible clicks depend on a defined policy and may change
when evidence or classification changes.

Distinct users describe a set over the requested interval. They cannot be calculated
by adding hourly distinct counts. An estimate needs an approximation label so it
is not mistaken for an exact accounting measure.

### Public interfaces

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/v1/clicks` | Submit one stable event |
| POST | `/api/v1/clicks/batch` | Return per-event results for a bounded batch |
| GET | `/api/v1/analytics/aggregate` | Fetch a scoped report with totals, series, and freshness |
| GET | `/api/v1/analytics/campaign/:id/summary` | Campaign report and breakdowns |
| GET | `/api/v1/admin/recent-clicks` | Authorized event inspection |

I would validate entity ownership on the server. A caller cannot gain advertiser
access by changing a filter, and the collector should resolve or verify campaign
context rather than accept arbitrary combinations of IDs.

## 🔧 Deep dive 1: connect durable acceptance to honest UI feedback — 10 minutes

> “I would acknowledge a click after its canonical record and outbox entry commit
> together. Analytics catches up asynchronously. The interface should reflect that
> lifecycle instead of interpreting an HTTP success as proof that every report
> already includes the event.”

A tempting local implementation writes PostgreSQL, Redis, and ClickHouse in one
request handler. That is easy to understand on the successful path, but there is
no transaction joining all three effects.

Suppose PostgreSQL commits and a Redis processed marker is set, then ClickHouse
fails. A retry might see the marker and stop, leaving the chart short of one click.
If instead the retry repeats all side effects, a duplicate can increment counters
even when PostgreSQL ignores its raw-row insert.

Executing those writes in parallel does not fix either case. We need durable state
that says what was accepted and what work remains.

### Acceptance and delivery

I would make the collector's transaction create the unique canonical event and its
outbox entry. After commit, it returns an acceptance result. On a duplicate identity,
it retrieves the existing result and checks that the payload matches.

The outbox relay can deliver more than once after an ambiguous send. A consumer
therefore records processed identities with its durable aggregate-state changes,
or uses an equivalent checkpoint contract. It must not add the same contribution
again when a message is replayed.

The analytics sink needs replay protection as well. I would emit absolute bucket
snapshots with a monotonic revision per full dimension key. The query selects the
latest revision per logical bucket before combining disjoint buckets.

An identical snapshot retry is harmless; an older snapshot cannot overwrite a newer
one. Appending the same delta twice to an additive table would not have that property.

This design costs an outbox, relay, durable consumer state, and some projection lag.
The benefit is a concrete recovery story rather than hoping the stores never diverge.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Durable acceptance plus replay-safe projection | Retry boundaries and pending work are recoverable | More operational components and visible lag |
| ❌ Direct writes to several stores | Simple normal request path | Partial failure creates missing or repeated effects |
| ❌ Cache marker as final truth | Fast response lookup | Races and expiration do not cover durable recovery |

### What the producer and test tool see

The producer creates identity before sending. If a network response is lost, it
retries that same identity. Generating a fresh ID on every attempt turns one logical
click into several apparently new events.

A conflicting payload under an existing identity should return a conflict, not an
unrelated cached success. The supported retry horizon must be explicit and backed
by durable identity retention, independently of a short Redis TTL.

For batches, HTTP success does not imply that every event succeeded. The result must
identify accepted, duplicate, rejected, and ambiguous events individually. The client
retries only the events that require it, with their original identities.

The development UI can show “accepted; awaiting analytics” after a submission. It
should not optimistically increase an authoritative click total because the event
may be duplicated, flagged, outside the selected time range, or not projected yet.

### Two clocks on the report

The browser knows when it fetched a response. The server knows the event-time boundary
through which data is considered complete. Those values should not be collapsed
into one “last updated” label.

If the response arrives at 14:32 but is complete through 14:25, show the processing
lag. Polling again in five seconds does not make those seven missing minutes appear.

A failed refresh can keep the last successful report visible with a stale state.
Returning zero or relabeling old values as current would turn an infrastructure
problem into a false campaign signal.

### Delivery transport follows the freshness requirement

I would start with polling of aggregate snapshots. It uses ordinary requests and
fits a dashboard where a few seconds of additional delay is acceptable.

Schedule the next refresh after the previous attempt settles, pause or reduce work
in hidden tabs, and back off with jitter after failures. A fixed interval that keeps
launching slow requests can make an outage more expensive.

Push invalidations through SSE or WebSockets can be added if measured polling cost
or a tighter freshness requirement justifies connection management. We still need
resynchronization after reconnect, and the transport cannot bypass projection lag.

## 🔧 Deep dive 2: keep metric meaning from storage to chart — 9 minutes

> “I would choose rollups from the analyst's questions and keep the combination
> rules explicit. The server should return meaningful totals at a bounded resolution;
> the browser should present them without recomputing a different answer.”

ClickHouse is suitable for scanning selected columns and serving time/dimension
aggregates. PostgreSQL supports transactional relationships and acceptance constraints.
The split is useful at sustained volume, but it is not mandatory for every analytics
prototype and it does not provide consistency by itself.

At lower volume, one database with well-chosen indexes and aggregate tables may be
easier to operate. At higher volume, the separate read projection can isolate report
scans from ingestion. I would compare measured workloads rather than assert a fixed
10× or 100× speed advantage.

### Keys and measures are part of the API design

A bucket identity includes its time interval and every grouping dimension we need
to preserve. If advertiser is grouped on insertion but omitted from consolidation,
we can lose the attribution the API later filters on.

Click counts can add across disjoint sets of events. Distinct-user state needs a
union. If the same user clicks in two hours, the range total is one user even though
each hourly point is also one.

An exact distinct function executed separately for inserted blocks does not make
the scalar outputs safely additive. Use mergeable exact state, an explicitly
approximate sketch, or a canonical raw distinct query for the requested set.

The API should supply whole-range distinct users separately from the chart series.
The frontend must not reconstruct the total by summing the visible points.

Fraud rate is total flagged clicks divided by total clicks for the same scope and
revision. Averaging bucket percentages can overweight periods with very few clicks.
The response can include numerator and denominator so that the meaning is inspectable.

### Match resolution to the question

A week has 10,080 minute buckets before dimension splits. An ordinary chart cannot
communicate all of them separately, and requesting raw events is far more expensive.

I would use minute resolution for a recent narrow range and wider buckets for larger
ranges. When a user zooms in, request finer data for the selected interval. Cap both
time points and group cardinality at the API boundary.

Client-side visual downsampling can help a bounded dense series, but it does not
preserve accounting totals. Keep server-supplied totals and extrema independently
of whichever representative points are drawn.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Server rollups with bounded resolution | Predictable queries and meaningful totals | Fine zoom may need another request |
| ❌ Send raw events to aggregate in every browser | Flexible local exploration | High transfer, duplicated work, and unnecessary data exposure |
| Alternative: bounded series plus visual sampling | Smooth dense overviews | Sampling must not replace metric calculations |

Raw-event tables can use cursor pagination and optional virtualization. Chart series
need a continuous time contract, so paginating the chart like a table is not the
same solution.

### Avoid visual misstatements

A total-click series already includes flagged clicks under this definition. Stacking
total and flagged counts makes the chart appear larger than the actual total. I
would show flagged as a subset or stack disjoint eligibility categories.

Missing time buckets also need meaning. A missing row might mean no clicks, incomplete
processing, or an interval outside retention. The UI should not fill it with zero
until the server contract distinguishes those states.

Use UTC instants and half-open ranges internally, with an explicit reporting timezone.
Adjacent queries should not both count the event exactly at their shared boundary.
The chart's timezone, range picker, and API conversion must agree.

I would provide a text trend summary and a table alternative. The analyst should be
able to understand the report without relying exclusively on color, hover, or animated
SVG paths.

## 🔧 Deep dive 3: recover and revise without displaying mixed results — 8 minutes

> “I would treat report revisions as a shared backend/frontend concept. Late events
> and changed fraud decisions are expected. A rebuild should create a new coherent
> result, and an older response should never silently replace a newer view.”

A fraud rule can produce a false positive for a shared network, or a late click can
arrive after its event-time bucket first appeared in a dashboard. We should retain
received time and rule version so those changes can be explained.

Velocity thresholds are an inspectable starting point, not proof of fraud. A
first-event counter with a one-minute expiry is a fixed window, not a sliding window.
Different window structures have different boundary behavior and state costs.

I would store decision revisions and make recent report intervals provisional.
After an agreed lateness horizon, historical changes enter a correction process
rather than silently mutating a finalized billing result.

### Rebuild alongside the live system

Deleting active aggregates and replaying raw data can race with live arrivals. An
insert between deletion and refill may disappear, or replay may add a contribution
that was already present.

Instead, build a new report generation from a stable canonical input boundary. Apply
the necessary later arrivals and decision revisions, validate totals, then promote
the new generation. Readers continue to use the old one until the new one is ready.

Keep enough raw evidence to support the correction horizon and reconcile identities,
not just overall totals. Two errors can cancel in a grand total while individual
campaigns remain wrong.

This requires staging storage, revision metadata, and a clear promotion boundary.
It buys a recoverable report that can be explained to an analyst after a change.

### Frontend requests need identity too

An analyst selects campaign A and then campaign B. If A's request returns last,
it must not overwrite B's values under B's heading.

The query key includes authorization scope, campaign, range, resolution, grouping,
and relevant report revision. Abort obsolete work where possible and also ignore
responses whose identity no longer matches the current applied query.

Draft filter values remain separate from the applied query. The title, URL, API
request, and export action should all use the applied version. A date picker can
use an Apply action to avoid querying every intermediate input.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Versioned reports and query-keyed responses | Backend corrections and UI transitions remain attributable | More explicit metadata and cache management |
| ❌ Rebuild in place and publish any response | Less state to model | Mixed generations or wrong-campaign values can appear |
| Alternative: independent widget queries | Flexible loading and caching | Must expose per-widget scope, revision, and freshness |

### Coherent core report, independent secondary details

I would return the main KPI cards and time series as one coherent report where
possible. Secondary metadata and event-detail panels can load independently.

When panels are independent, each needs its own error and coverage state. One global
error string can be cleared by an unrelated successful request. Likewise, a global
refresh timestamp can falsely imply every panel succeeded.

During a background refresh, retain the last matching result and show that it is
stale. After a campaign change, either show a new-query loading state or clearly
identify any retained result as belonging to the old query.

Do not move keyboard focus or announce every chart point on each poll. Keep controls
stable and use concise status messages for errors, completed user requests, and
material freshness changes.

## 📊 Validate the boundaries and close — 4 minutes

I would test the transitions that support the design's promises:

1. Two collectors receive the same event concurrently.
2. Acceptance commits, but the response or outbox publication acknowledgement is lost.
3. An analytics snapshot is retried after a newer revision has arrived.
4. The same user appears across several time buckets and grouping dimensions.
5. A backfill overlaps live clicks and a revised fraud decision.
6. Two campaign queries return out of order while one panel fails to refresh.

The expected outcomes are one canonical occurrence, one logical contribution,
correct set/rate semantics, a coherent published report, and UI labels that still
match the displayed values.

I would monitor acceptance latency, oldest unprojected event, reconciliation errors,
query latency, response size, and chart render time. These identify whether the next
change belongs in ingestion, projection, reporting, or the browser.

For growth, partition and batch the authoritative path after measurement, distribute
hot aggregate keys with stable partial aggregation, cache bounded scoped reports,
and limit client work. More API replicas alone do not fix a single hot aggregate or
an unbounded chart response.

> “The complete design connects durable acceptance to truthful presentation.
> Replay-safe processing prevents retries from changing meaning, composable metrics
> keep rollups and charts mathematically sound, and revision-aware reports let the
> system recover without showing mixed results. I would establish those contracts
> before optimizing away a few milliseconds or calling the dashboard billing-ready.”
