# Health Data Pipeline — Fullstack System Design Interview

> “I would build around one promise: the user can understand which measurements a report
> includes and why its numbers changed. That promise connects device retries, aggregation
> correctness, and the dashboard's state model.”

This is a proposed production design for a 45-minute interview. It uses three deep dives and a
drawable overview. The teaching implementation demonstrates parts of the flow, with a separate
implementation boundary at the end.

## 🎯 Scope and user journey — 4 minutes

I would clarify that the product helps someone review personal activity, sleep, and
measurements from several devices. It is not intended to diagnose conditions or provide
emergency monitoring.

The main journey starts with a device collecting observations, possibly offline. When it
reconnects, the server accepts a batch. The user later opens a dashboard, explores a metric,
and checks whether a gap means no observations or processing delay.

I would support an overview, a metric explorer, source status, and account controls. A device
integration handles actual collection; a web registration form alone cannot make a wearable
start sending measurements.

The initial scope includes corrections and deletion because they affect the core data model.
Clinician sharing, advanced report builders, and clinical advice can remain outside the first
design.

| Requirement | Why it shapes the system |
|-------------|--------------------------|
| Safe retry after lost response | Requires stable source and batch identities |
| Several sources can overlap | Requires an explicit fusion policy |
| Late arrivals can change old reports | Requires complete recomputation and versioned publication |
| Missing data must be visible | Requires coverage in both API and chart model |
| Account transitions must be private | Requires server authorization and browser state cleanup |

For discussion, assume one million active users and 1,500 samples per day each. That is about
17,400 samples/second on average and 300 GB/day at an assumed 200 bytes per sample, before
indexes and replication.

I would aim for bounded batch acceptance under 500 ms at p95 and ordinary report publication
within two minutes. Those are design targets, not measurements of the local prototype.
Historical imports need a separate processing budget.

## 🏗️ High-level architecture — 7 minutes

I would draw the upload path, the processing loop, and the browser boundary as one connected
picture. The most important labels are “accepted” and “published.”

```
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Sync client + journal  │        │ Ingestion API          │        │ Durable raw store      │
│ Saved batch/sample IDs │◀──────▶│ Validate / receipt     │◀──────▶│ Samples + outbox       │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                                                                                 ▲         ▲
                                               ┌─────────────────────────────────┘         │
                                               │                     committed work        │
read complete bucket inputs                    │                                           │
                                               ▼                                           ▼
                                  ┌────────────────────────┐        ┌────────────────────────┐
                                  │ Rollup workers         │        │ Dispatcher + queue     │
                                  │ Dedup + full buckets   │◀──────▶│ Retry jobs by ID       │
                                  └────────────────────────┘        └────────────────────────┘
                                                         ▲
                                                         │
                                   guarded publication   │
                                                         │
                                                         ▼
                                  ┌────────────────────────┐        ┌────────────────────────┐
                                  │ Versioned rollups      │        │ Health query API       │
                                  │ Coverage + policy      │◀──────▶│ Authorize every read   │
                                  └────────────────────────┘        └────────────────────────┘
                                                                              ▲
                                                                              │
 Responses include source coverage, bucket revision and processing status.    │
                                                                              │
┌─────────────────────────────────────────────────────────────────────────────┼──────────────┐
│ BROWSER                                                                     │              │
│                                                                             ▼              │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ Charts + table         │     │ Report model           │     │ Query coordinator      │  │
│  │ Values, gaps, context  │◀───▶│ Units / gaps / version │◀───▶│ Query / policy / rev   │  │
│  └────────────────────────┘     └────────────────────────┘     └────────────────────────┘  │
│                                                                                            │
│   Range changes → identified reads; account changes → discard old data and requests.       │
│                                                                                            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

Across the top, a sync client sends stable sample IDs and a batch key. Ingestion verifies the
owner and source, then commits raw observations, a receipt, and an outbox entry together.

The dispatcher delivers committed work to workers. Workers read the complete affected periods,
apply the chosen source/metric policy, and publish guarded report versions. They do not assume
that arrival order is measurement order.

I would follow recovery across the return arrows:

1. The sync client retains bounded batch/sample identities under its storage policy, reauthorizes, and resolves the original receipt after an uncertain upload.
2. Workers retry identified bucket work, publish only against the current generation/epoch, and record completion or supersession before acknowledging it.
3. A newer correction remains pending until its own report is published. The dashboard keeps acceptance, processing progress, and report coverage separate.
4. Refresh the matching report on publication change, preserving units and gaps. The browser never reconstructs a new aggregate by adding received upload totals.

The query API reads published rollups after checking current access. It includes coverage,
policy, and processing status so the browser can explain what the numbers represent.

Inside the browser, a query coordinator owns requests and their identity. A report model
preserves units, gaps, and versions. Charts and the table render that same model, while range
controls change the requested view.

> “The browser does not need to know how many workers exist. It does need to know whether its
> report includes an accepted upload and whether a late response still belongs to the current
> account and range.”

Initially, the API and query service could be modules in one application. The diagram shows
responsibilities and failure boundaries, not a requirement to deploy every box as a
microservice.

I would place a user's raw data, receipt identities, and pending work on the same database
shard. Time partitioning helps within that shard. Separate workers become useful because a
long historical import should not occupy an interactive request.

## 💾 Shared contracts and state ownership — 5 minutes

I would define the few contracts that cross boundaries before discussing framework details.

| Contract | Important fields | Responsibility |
|----------|------------------|----------------|
| Source sample | Owner/device, stable source ID/version, value/unit, interval | Preserve original evidence and correction identity |
| Batch receipt | Scoped key, digest, per-item outcome, accepted time | Resolve uncertain retries |
| Report | Metric/unit, bucket boundaries, coverage, policy, publication version | Explain derived data consistently |
| Processing status | Accepted work and processed watermark | Distinguish upload progress from chart freshness |
| Browser query | Account generation, metric, range, zone, resolution | Prevent stale results entering the current view |

There are two deduplication questions. A repeated source ID should not create another
observation. Two different IDs from a phone and watch may still cover the same activity. We
need both identity checks and overlap policy.

The database stores original units and normalized values separately. The report also retains
the policy version, so changing source preferences does not make a historical number
inexplicable.

On the client, query results are remote state; open menus, focused points, and temporary
selections are local UI state. Keeping those separate avoids a source-status refresh resetting
the user's chart interaction.

A small proposed API is enough:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/devices/:id/batches` | Accept a bounded owned batch |
| GET | `/receipts/:id` | Read acceptance/processing state |
| GET | `/reports` | Read a metric/range report with coverage and version |
| GET | `/sources` | Explain source contribution and freshness |
| POST | `/sessions/logout` | End the current server session |

The repository uses different route names; these paths illustrate the proposed interaction.
The essential design is in the ownership, retry, and report semantics rather than the spelling
of each endpoint.

## 🔧 Deep dive 1: A delayed upload, end to end — 8 minutes

**Decision: acknowledge durable acceptance and expose report publication separately.**

Suppose a watch was offline all morning. It reconnects at noon and sends observations for
several earlier hours. The server commits the batch, but the response disappears when the
network changes.

The sync client retries with the same batch key and sample identities. Ingestion first checks
device ownership, then looks up a receipt scoped to that owner and device. It compares a
digest covering all relevant fields, including units and source versions.

The same key and content returns the original acceptance result. The same key with changed
content is a conflict. A global cache key would be unsafe because it could replay another
user's response.

The transaction records accepted raw versions, the final per-item receipt outcome, dirty
period generations, and an outbox entry. Only after commit can the client safely stop retrying
that batch.

An outbox is important here. Writing SQL and then independently publishing a queue message has
a gap: the process can crash after saving samples but before scheduling aggregation.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Durable receipt and outbox | Safe uncertain retries; work survives process failure | Background processing and visible lag |
| ❌ Aggregate everything within the upload request | Simple immediate happy path | Backfills hold requests; errors can follow committed data |
| ❌ Cache the response after independent writes | Fast duplicate path | Does not close transaction or concurrency gaps |

Now follow the lower half of the diagram. A worker reads complete affected periods, not just
the newly uploaded start-time range. Otherwise replacing a daily row from one small batch
could erase earlier contributions.

New samples advance the desired bucket generation. A worker publishes only if its input
generation is still current. This matters when an older job finishes after a newer one.

On the browser, the source panel can now say “Upload received; reports updating.” The chart
remains on the last published version with a clear processing status. It should not announce
that the new total is final merely because upload succeeded.

I would poll pending status while the page is active, with backoff and explicit refresh. When
the published version changes, the coordinator fetches that report. A push channel is an
option if a later requirement needs continuous updates, but it still requires
resynchronization after reconnect.

I would not optimistically add the batch's steps to the displayed total. Another source may
already cover that interval, so adding before fusion can double count and then force a
confusing rollback.

> “The user gets immediate acknowledgment of a real fact—the upload is saved—without
> pretending that the final chart is ready. The cost is a second progress state, which is
> preferable to an unreliable single ‘synced’ label.”

## 🔧 Deep dive 2: One report, consistent meaning — 8 minutes

**Decision: the backend defines metric semantics and coverage; every frontend view preserves
them.**

Consider a phone reporting 90 steps over 90 minutes and a preferred source reporting 30 steps
over the middle 30 minutes. Those are distinct observations, but simply adding them counts the
middle interval twice.

For interval totals, the policy subtracts the full union of preferred coverage from
lower-priority intervals. It then splits the remaining fragments at report boundaries. A
containing interval and multiple overlaps both need handling.

Allocating an interval's total in proportion to uncovered duration assumes uniform activity.
That is an estimate, so the report should preserve that qualification. The server cannot
manufacture exact sub-interval counts from an aggregate measurement.

The same arithmetic does not apply to every metric. If a heart-rate observation spans ten
minutes and only five are selected, its value does not become half as many beats per minute.
The chosen weighting changes; the physical rate does not.

| Metric | Server responsibility | Frontend responsibility |
|--------|-----------------------|-------------------------|
| Steps | Resolve overlap and sum eligible contributions | Show total, coverage, and any estimation |
| Heart rate | Define and preserve weighting | Display average/range with correct units |
| Weight | Select latest eligible event timestamp | Show measurement time, not merely fetch time |
| Sleep | Resolve eligible interval coverage | Show duration and source gaps explicitly |

A latest-value policy needs timestamp ordering and a stable tie-breaker. Sorting by device
priority and taking the last result does not necessarily select the newest observation.

Likewise, a weekly heart-rate average cannot generally be the unweighted average of daily
averages. A day with one measurement should not automatically carry the same weight as a day
with hundreds.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Semantic reports with coverage and policy versions | Same meaning across cards, charts, and clients | Richer data model and targeted policy tests |
| ❌ Send numbers and let each view infer meaning | Small initial contract | Inconsistent totals, averages, and missing-data behavior |

The browser should receive real bucket boundaries and an explicit reporting timezone. Changing
the zone may change which observations belong to a day, so it creates a new report query
rather than just different axis labels.

A day can be shorter or longer around daylight-saving transitions. The backend computes
half-open UTC boundaries from the reporting zone; the frontend displays the chosen zone and
formats labels without discarding bucket identity.

Missing observations should produce a gap or a clearly labeled incomplete bucket. Zero should
mean a measured or otherwise explicitly supported zero. A sleep card must not turn missing
input into “0 hours” by default.

For performance, the API supplies bounded points at an appropriate semantic resolution. A
year-long view does not require downloading every raw sensor sample. The selected resolution
must remain visible in tooltips and summaries.

Charts and an accessible data table should use the same report model. Keyboard selection, text
labels, and non-color indicators make source/coverage information available without relying on
hover or a particular color distinction.

The trade-off is less freedom for each frontend to invent its own aggregation. That is a good
constraint: the product should give the same answer whether someone reads a summary card,
opens the table, or changes devices.

## 🔧 Deep dive 3: Corrections and account-safe updates — 7 minutes

**Decision: identify both server publications and browser requests, and reject obsolete work
at each boundary.**

There are two similar races. On the server, an old worker can publish after a newer one. In
the browser, an old range request can return after a new selection. Finishing last does not
make either result current.

For workers, the input generation and policy/deletion epoch are checked atomically with
publication. A correction dirties the union of old and new intervals. A deleted final sample
must produce an explicit empty result, not leave an old aggregate untouched.

If a screen needs hourly and daily values from one coherent update, the server publishes a
report head pointing to the completed bundle. Otherwise it exposes per-bucket revisions and
freshness. Independent writes should not be described as an atomic report.

For the browser, a query key includes account, metric, range, timezone, and resolution. A
response is stored under that identity, and the visible page subscribes only to its selected
identity.

Suppose the user chooses 90 days and immediately switches to 7 days. The 90-day response must
not replace the current series while the controls still say “7 days.” Abort the old request
when possible, but retain the identity check because cancellation is not guaranteed to stop
completion.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Version guards at publication and query boundaries | Rejects obsolete work explicitly | More lifecycle state to maintain |
| ❌ Last response or worker wins | Easy assignment logic | Newer state can be replaced by older input |

Account changes add a privacy boundary. On logout, advance an account generation, cancel
requests, clear report/source caches, and remove derived chart state. Any late response from
the old generation is discarded.

Clearing a token alone is insufficient if global health state remains in memory. The next
account could see a previous user's chart before its own request finishes, even when every
backend endpoint is correctly authorized.

Server caches also need current authorization before reuse. A versioned payload can remain
immutable while the user's permission changes. Payload identity and access permission have
different lifecycles.

I would default to memory-only report caching and a secure same-origin browser session, with
its corresponding request-forgery controls. Persistent offline health reports require a
separate lifecycle decision about device sharing, revocation, keys, and deletion.

A failed refresh can retain the last authorized report for the same query with an explicit
stale state. It cannot retain another account's data as a loading placeholder. Authentication
checking also needs its own initial state so routes do not redirect before verification
completes.

Corrections can legitimately lower a past total. The UI should preserve the user's range and
focused date, update the published version, and make source inspection available. It should
not treat all decreases as a failed upload.

The cost is extra query and publication metadata. In return, the two halves of the product
agree on what “current” means instead of relying on timing.

## 📈 Scaling, operations, and verification — 3 minutes

I would expect overlap resolution, backfills, and repeated period rebuilds to become expensive
before ordinary dashboard rendering. Coalesce dirty work, bound accepted interval lengths, and
give recent updates a separate queue budget from historical imports.

Shard by user ownership when necessary, and use time partitions within each shard. Report
queries should read compact projections. Adding replicas requires an explicit freshness rule
before claiming a just-accepted upload is visible everywhere.

On the frontend, bound point counts first, isolate subscriptions, and measure chart work on a
representative phone. Route code splitting and data loading should have separate error
boundaries.

My key checks cross the service/browser boundary:

- Lose a response after acceptance, retry, and confirm one logical sample effect.
- Deliver a late overlapping batch and verify a complete corrected period.
- Finish an old worker after a newer publication and reject its result.
- Switch ranges or accounts while requests are in flight and reject obsolete responses.
- Show missing, partial, accepted-but-pending, and published states consistently in chart and table.

Operational metrics should separate capture delay, acceptance latency, oldest pending work,
publication lag, query latency, and displayed report age. A single “last sync” metric hides
the distinction between a disconnected source and a stalled worker.

Retention must include raw observations, derived reports, caches, and deletion work. Expiring
original data also limits which historical policies can be recomputed; the product should
state that boundary.

## ⚖️ Trade-offs and implementation boundary — 3 minutes

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Upload completion | ✅ Durable acceptance, then publication | ❌ One ambiguous synced flag | Explain retries and processing lag |
| Metric meaning | ✅ Server semantic reports | ❌ Generic per-view aggregation | Keep cards, charts, and tables consistent |
| Current state | ✅ Publication/query identities | ❌ Completion order | Prevent old work replacing new state |
| Health cache | ✅ Authorized, account-scoped memory | ❌ Persistent global payloads | Make account lifecycle explicit |

The local project contains Express, TimescaleDB, Valkey, React, Zustand, and Recharts. It
performs aggregation inline and lacks the durable outbox, source-version registry, guarded
publication, and report coverage contract in this proposal.

Its source also shows incomplete overlap handling, narrow-range replacement of whole
aggregates, stale query-cache keys, missing device ownership checks, and browser state that
survives logout. Route components return fresh Promises; the documentation review did not
verify browser navigation.

Those findings explain why this answer emphasizes clear boundaries. They are documented with
source references in [architecture.md](./architecture.md#implementation-notes); local commands
and fixture limitations are in [README.md](./README.md).

> “I would finish with the same journey I started with: a device uploads once logically, the
> server publishes a traceable report, and the browser shows the right version to the right
> account with honest gaps and freshness. Each box in the diagram exists to support that
> journey.”
