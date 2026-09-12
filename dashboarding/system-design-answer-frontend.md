# Dashboarding: frontend system design interview

## 🎯 Establish the user contract — 4 minutes

> “I would design this for an engineer investigating a service problem. The interface must make several measurements comparable and make uncertainty visible. A fast chart that quietly shifts a sample to another timestamp can lead to the wrong operational decision.”

I would start with a dashboard containing time-series charts, gauges, and summary
values. Users can choose a time range, filter series, refresh, and save panel
configuration. They can inspect active alerts and understand which rule and measurements
caused an incident. A metrics explorer supports investigation outside a saved dashboard.

I would clarify freshness before choosing a transport. For trend monitoring, a
ten-second refresh target is sufficient for this first version. An incident-response
product needing updates within a second would change the subscription and server fan-out
design. Neither requirement means that receiving a response guarantees its observations
are current.

The first release supports scalar gauges and cumulative counters with explicit units and
supported operations. Logs, traces, arbitrary executable panel plugins, and a general
query language are outside this interview's scope. I would require distribution support
before offering latency percentiles; a chart cannot recover a percentile from averages
alone.

The critical interaction is comparing panels during investigation. Their absolute time
window should match, even if one query finishes later. A failed panel must show its own
failure while successful panels remain usable. Switching dashboard or time range must
prevent an older response from appearing under the new selection.

I would also distinguish viewing data from editing configuration. A saved dashboard is a
reusable definition; its current query results are transient. Access to a private
dashboard and access to the underlying metrics are separate permissions, both enforced
by the server.

| Requirement | Visible success criterion |
|-------------|---------------------------|
| Compare measurements | Shared window, explicit units and resolution |
| Investigate a point | Actual timestamp, complete series identity, value and quality |
| Handle gaps | Missing values remain gaps; query failure is explicit |
| Change context | Previous requests cannot replace the current selection |
| Edit configuration | Pending, saved, conflict, and failed states are distinguishable |
| Inspect an alert | Rule version, incident state, observation age, and evaluation quality |

## 📏 Estimate browser and service work — 3 minutes

Assume 10,000 concurrent viewers with ten panels each, refreshing every ten seconds.
That produces roughly 10,000 panel queries per second before reuse. Combining panels
into one HTTP request reduces transport overhead, but ten distinct plans still require
work at the query service.

Within one browser, ten panels showing twenty series each and a thousand buckets per
series already represent 200,000 plotted values. I would set a total response and
rendering budget, not merely a per-series limit. Returning all matching hosts because
the chart library can technically accept an array is an unbounded product decision.

A chart about 1,200 pixels wide does not need every raw observation from a month. The
client supplies a desired point budget, and the server chooses a supported resolution
while returning what it actually used. Exact data export is a separate, explicitly
larger workload.

I would measure time to usable panels, input responsiveness, response size, rendering
time, and request overlap on representative devices. A loading spinner disappearing
quickly is insufficient if labels, axes, or points are wrong. The production targets are
design assumptions, not performance measurements of the repository demo.

## 🏗️ Draw the browser architecture — 5 minutes

I would keep this whiteboard diagram small. The important boundary is the coordinator
between dashboard configuration and independent panel renderers. The server owns
authorization and query semantics; the browser owns interaction and presentation.

```
┌──────────────────────┐      ┌──────────────────────┐
│ Route + controls     │─────▶│ Query coordinator    │
└──────────────────────┘      └───────────┬──────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │ Query API            │
                              └───────────┬──────────┘
                                          │
                                          ▼
┌──────────────────────┐      ┌──────────────────────┐
│ Panel renderers      │◀─────│ Results + quality    │
└──────────────────────┘      └──────────────────────┘
```

The route identifies the dashboard and shareable investigation context. Time range,
selected filters, and a pinned absolute window belong in the URL when sharing them is
useful. Hover state and an open menu remain local. An unsaved panel draft is separate
from the last saved dashboard configuration.

The query coordinator turns visible panel definitions into normalized query plans. It
chooses one time anchor, shares identical work, limits in-flight requests, and
associates each result with its plan and refresh generation. Panel components receive a
result and status rather than starting their own network timers.

I would use React for composition and a small shared store for dashboard editing and
query coordination. A store library does not itself solve stale requests or define cache
correctness. Those need explicit transitions and identity. Server configuration can have
its own fetch/cache layer rather than being copied into several overlapping stores.

Renderers have a common contract: data, units, effective range, resolution, quality, and
interaction callbacks. A local registry selects line, area, bar, gauge, or stat
behavior. Adding a panel type should not require duplicating authentication, polling,
cancellation, and error handling in that renderer.

The initial editor uses accessible form controls for metric, aggregation, grouping, and
title. Dragging and resizing can be an enhancement, with keyboard alternatives and a
narrow-screen layout. I would avoid promising a plugin sandbox merely because renderer
components use a registry.

## 🧭 Define state and API boundaries — 4 minutes

I separate configuration state from query state because they change at different rates
and have different recovery rules. A failed refresh must not erase an unsaved title
edit, and saving a title must not falsely mark chart observations as fresh.

| State | Identity | Recovery behavior |
|-------|----------|-------------------|
| Saved dashboard | Dashboard ID and server revision | Refetch or conditionally update |
| Editor draft | Base revision and local changes | Preserve on failure; resolve conflicts |
| Query plan | Authorized scope, metric, filters, operation, range, interval | Share only equivalent work |
| Refresh | Dashboard context and generation | Ignore obsolete responses |
| Panel result | Plan identity plus effective bounds and data version | Retain as explicitly stale when appropriate |
| Incident | Incident ID and evaluated rule version | Refresh status without rewriting historical meaning |

The query response needs more than an array of values. It should identify each complete
series, return UTC bucket timestamps, effective resolution, source coverage, latest
observation time, and any partial or approximate result status. An HTTP success with no
rows is not sufficient evidence that a service is healthy.

For configuration, I would propose conditional updates against the revision the user
edited. The API returns the resulting revision, and duplicate creation retries use a
stable mutation identity. These are proposed contracts; the existing API does not supply
revision checks or durable mutation receipts.

| Proposed API operation | Purpose |
|------------------------|---------|
| Get dashboard | Fetch authorized configuration and revision |
| Query bounded panel plans | Return independently identified results and quality |
| Update dashboard/panel with expected revision | Detect concurrent edits |
| List incidents | Return bounded history with evaluation context |
| Test a rule draft | Preview its predicate without creating an incident |

I would distinguish expired authentication, forbidden access, invalid queries,
unavailable dependencies, and empty measurements. They lead to different user actions.
The client can hide unavailable editing controls for convenience, but the server must
still authorize every request and the exact target resource.

## 🔧 Deep dive 1: coordinate refresh without losing context — 8 minutes

> “I would choose coordinated polling for the stated ten-second freshness requirement. The challenge is keeping requests and results attached to the user's current investigation.”

At the start of a refresh, the coordinator captures an absolute end time and derives the
start time. Every plan in that refresh uses those bounds. Live mode advances this anchor
on a controlled cadence; a pinned historical window stays fixed until the user changes
it.

Plans include all inputs affecting meaning, including authorization scope, labels,
grouping, aggregation, and resolution. Identical plans can share a pending request and a
result. If two panels use different units or transformations, I would distinguish shared
source data from panel-specific presentation so an inappropriate transform is not
reused.

I would cap concurrent requests and prioritize visible panels. A slow refresh does not
launch unlimited overlapping copies every ten seconds. Hidden-tab polling pauses;
returning to the tab schedules a fresh generation. Failed requests use bounded backoff
and jitter so many viewers do not retry in lockstep.

When the user changes a range, filter, or dashboard, the coordinator advances the
context generation and cancels obsolete work where possible. Cancellation saves
resources, but it is not the correctness boundary. Each completion must still match the
active plan and generation before it can publish a result.

Consider a one-hour CPU request that takes four seconds. After one second the user
chooses seven days, and that query finishes first. Without the generation check, the
older one-hour response can replace the seven-day result while the controls still say
seven days. A network library's cache does not automatically prevent this mismatch in
component state.

During an ordinary refresh, I would keep the previous usable result visible with a
refreshing indicator. If the new request fails, it becomes a labeled stale snapshot with
its actual observation time and error. A context change requires more care: old data can
be shown only as an explicitly identified previous view, never as current results under
new filters.

Panel failures stay local. A database timeout in a CPU chart must not remove a
successful memory chart or block time-range controls. An error boundary also isolates
renderer exceptions, which are different from API failures. Retrying one failed panel
should not repeatedly fetch the whole dashboard configuration.

A page-level status can report that eight of ten panels completed for a particular
window. It should not imply that all observations are current merely because metadata
loaded. I would reserve “last observed” for sample age and “last queried” for transport
activity.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Coordinated polling | Shared bounds, bounded work, straightforward recovery | Must manage generations and partial results |
| ❌ Independent panel timers | Small standalone components | Drift, duplicate queries, overlap, inconsistent freshness |
| ❌ Push for this first version | Lower delivery latency | Subscription recovery and fan-out exceed the stated need |

The cost of coordination is centralized lifecycle logic. I would keep that logic
independent of chart rendering and test it with deliberately reordered completions. If
sub-second freshness becomes a requirement, I would preserve plan identity and
generation checks while changing the transport; a persistent connection does not
eliminate them.

## 🔧 Deep dive 2: preserve meaning when drawing fewer points — 8 minutes

> “I would negotiate a bounded resolution with the server and align points by timestamp. I would never use array position or a convenient zero to fill a measurement gap.”

Suppose host A has points at 00:00 and 00:02, while host B has a point at 00:01. Zipping
their arrays places B's value at A's first timestamp. Padding B's second entry with zero
then invents a measurement at 00:02. Both errors make the chart easy to render while
changing the evidence presented to the user.

Instead, each series retains its canonical identity and bucket timestamps. The renderer
joins on timestamps, or uses independent time/value arrays if the chart library supports
them. An absent bucket remains null or absent. Connecting across gaps should be an
explicit visual policy, with gaps still discoverable, rather than an invisible data
transformation.

Series identity includes label names as well as values. Concatenating values with a
delimiter can collide and can change when object order changes. Stable identities also
keep colors and legend selection consistent between refreshes. Display labels can be
shorter, but the tooltip exposes the complete identity.

For long ranges, the server chooses buckets from supported data sources using the
requested point budget. It returns the effective interval and coverage. The browser must
not label a one-hour materialized bucket as a precise one-minute measurement or create
intermediate points that imply unavailable resolution.

Aggregation must match the question. A mean across unevenly populated buckets uses their
sums and counts. An average of host averages gives each host equal weight, which may be
a valid operation, but it is different from an average across all samples. The UI should
name the selected interpretation instead of hiding it behind a generic “average.”

For gauges, I would show the chosen sample or summary window and its observation age.
For cumulative counters, I would ask the server for a defined reset-aware rate. A value
already measured in requests per second cannot simply be summed across time and keep the
same unit. Panel formatting cannot repair an incorrect server operation.

A stat panel matching three hosts must either display each host, apply an explicit
reduction, or require a single series. Taking the first result is unstable and
misleading. Likewise, a gauge should use a configured range appropriate to its unit, not
automatically clamp every measurement to a percentage.

I would format timestamps at the final presentation step. Multi-day charts need dates as
well as times, and tooltips should show an unambiguous instant and time zone. Formatting
several days as repeated hour/minute labels must not turn timestamps into
indistinguishable categorical keys.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Server aggregation with declared resolution | Bounds transfer and query work; preserves stated semantics | Requires coverage and precision metadata |
| ❌ Fetch all raw samples and reduce in the browser | Flexible client exploration | Large transfers, memory pressure, wasted database work |
| ❌ Align by array index and fill zero | Easy chart input | Moves measurements and invents healthy-looking values |

The trade-off is information loss. A coarse average can conceal a short spike; min/max
bands or a drill-down can expose it while raw data exists. Once raw observations expire,
exact detail may be unavailable. The interface should disclose that limit rather than
suggest zooming can recreate it.

## 🔧 Deep dive 3: make editing and alerts explainable — 7 minutes

> “I would keep a rule's draft, its saved version, and the incident it produced distinct. Otherwise editing a threshold can silently change the apparent explanation of an earlier alert.”

A panel editor starts from a known configuration revision. Local edits update a draft
and preview; saving sends the expected revision. If another user changed the panel, the
draft remains available while the interface presents the conflict. For a small form,
asking the user to reconcile changed fields is simpler than implementing collaborative
text editing.

Creation and save controls show pending status and prevent accidental repeated
submissions. A retry after an uncertain response reuses the same mutation identity.
Closing a dialog or navigating away prevents its late completion from mutating a
different editor. Successful writes invalidate the relevant configuration and dependent
plans, not every unrelated query.

I would use immediate local preview for reversible presentation changes, while
representing server persistence honestly. An optimistic toggle can work if rollback is
tied to the same entity and operation; otherwise a refetch after confirmation is easier
to reason about. A generic shared error string is inadequate when multiple panels have
independent edits.

Alert configuration separates the evaluation window from how long a condition must
remain true. “Average CPU over five minutes exceeds 90” and “that predicate has stayed
true for five minutes” are different controls. A preview explains the predicate and
available data, but does not promise that a future scheduled evaluation will fire at an
exact wall-clock second.

An incident row should show the evaluated rule version, affected series/group,
transition time, and supporting value. Current rule text can be linked separately. If a
user edits a threshold later, historical evidence must still describe the condition that
opened the incident.

The interface distinguishes firing, pending, and resolved condition states from no-data
and evaluation-error quality. A firing incident with missing telemetry stays visibly
uncertain according to policy; disappearance from a successful query is not sufficient
reason to paint it green. The banner's count should represent a known total or
explicitly say that it shows a limited subset.

Delivery status is another separate fact. Creating an incident does not prove an email
or webhook reached anyone. The UI can display queued, attempted, confirmed, or failed
delivery status based on actual backend evidence, without turning a log message into
“notification sent.”

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Versioned configuration and explicit incident context | Explains conflicts and historical behavior | More state and deliberate recovery UI |
| ❌ Unconditional save and current-rule labels everywhere | Minimal form code | Lost edits and misleading historical explanations |
| ❌ Treat empty/error as healthy | Simple red/green display | Conceals loss of monitoring coverage |

I would keep the first implementation modest: clear forms, conditional saves, bounded
history, and readable quality states. This gives operators evidence they can act on
before adding complex layouts or extensibility. The same state distinctions also support
useful keyboard and screen-reader announcements without announcing every background
poll.

## 📈 Scale and verify the experience — 4 minutes

The first bottlenecks are often excess points, matching too many series, and duplicate
work. I would inspect those before replacing SVG rendering with canvas. If profiling
shows chart rendering dominates, a denser renderer can help, but query limits and
semantic correctness remain necessary.

Use virtualization for large dashboard lists or histories. For panel grids, preserve
query and editor state independently of whether a renderer is mounted. A panel scrolling
out of view should not lose an unsaved edit, and remounting should not create another
independent polling loop.

A narrow screen needs deliberate panel stacking and readable axes. Legends and tooltips
cannot be the only way to understand a series: provide a keyboard-accessible summary or
data view. Status should use text and symbols as well as color, especially for stale or
missing telemetry.

I would verify reversed request completion, navigation during a save, uneven timestamps,
duplicate display labels, empty series, delayed ingestion, multi-day ranges, and partial
query failure. These checks exercise the user's interpretation of data rather than
merely checking that a heading appears. Performance checks use realistic series counts
and include repeated navigation to detect retained timers and large result objects.

## 🛠️ Relate the design to this repository — 2 minutes

The current React/TanStack Router/Recharts application provides a public seeded
dashboard, a metrics explorer, and alert controls. It is a useful starting point, but
the proposed coordinator and revision contracts are not implemented. The two Zustand
stores exist without being used by the current route/component tree.

Panel renderers poll independently. Charts align series by index and fill missing
entries with zero; gauges and stats use the last bucket of the first series. Longer
queries select absent rollup tables. The Refresh button reloads dashboard metadata, and
several async paths lack response-generation guards. These are source findings, with
selected isolated checks, rather than a claimed browser reproduction.

There is no login screen, interactive panel editor, or drag/resize implementation.
Alerts are publicly mutable, empty descriptions fail form validation, and missing data
can resolve an incident. Webhooks are only logged. I would prioritize correct
query/error contracts and sample alignment, then coordinated refresh and
access/configuration workflows. The detailed current behavior is recorded in
[architecture.md](./architecture.md#implementation-notes).
