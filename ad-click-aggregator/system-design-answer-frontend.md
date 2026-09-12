# Ad Click Analytics Dashboard — Frontend System Design

*A 45-minute interview discussion. This is a proposed frontend design; verified
local behavior is documented in [architecture.md](./architecture.md).*

## 🎯 Clarify the analyst's job — 5 minutes

> “The user is an analyst deciding whether a campaign is performing normally. They
> need to see click volume, investigate a suspicious change, and understand how
> current the data is. I would optimize for a trustworthy comparison of metrics,
> rather than making every number animate as quickly as possible.”

I would clarify the audience, the acceptable delay, and whether these screens are
used for operational monitoring or final billing. For this discussion, they show
provisional analytics. Final invoices are produced from a reconciled process with
a separately defined correctness contract.

The main journey is to open the dashboard, choose a campaign and time range, inspect
the trend, and drill into country or device breakdowns. An administrator can inspect
flagged events. A separate development tool generates synthetic clicks.

I would assume 1,000 concurrent dashboard sessions at the upper end of our initial
planning range. Recent data should usually be less than a minute behind ingestion;
a five-second refresh can be an initial product choice if the backend supports it.

A five-second browser timer does not guarantee five-second event freshness. The
pipeline may still be processing events, or a query may return a cached report.
That distinction becomes part of the interface.

### Requirements I would agree on

| Requirement | User-visible behavior |
|-------------|-----------------------|
| Understand freshness | Show data coverage separately from the last fetch time |
| Compare consistent metrics | Cards and charts refer to the same applied filters |
| Investigate trends | Change range, resolution, campaign, and supported dimensions |
| Handle slow queries | Keep usable results visible without relabeling them as new data |
| Read large reports | Bound chart points and paginate or virtualize long tables |
| Accessible analytics | Provide text summaries and a tabular representation |

I would keep invoice editing, custom dashboard builders, and offline mutation queues
outside the first interview design. They do not help establish the core analytics
read experience.

## 🏗️ Draw the client boundaries — 5 minutes

```
┌────────────────────────────────────────────────┐
│ Dashboard                                      │
│ Draft filters ──▶ Applied query                 │
│                         │                      │
│                         ▼                      │
│                 Query coordinator              │
│                         │                      │
│                 Results + freshness            │
│                    │           │               │
│                    ▼           ▼               │
│                  Cards       Charts / table    │
└─────────────────────────┬──────────────────────┘
                          │ bounded analytics request
                          ▼
                 ┌──────────────────┐
                 │ Reporting API    │
                 └──────────────────┘
```

I would build the interface with React and a router that can represent applied
filters in the URL. A small store can hold shared query state and view preferences;
component-local state handles menus, focused controls, and draft input.

Server responses belong to a cache keyed by the complete applied query. We can use a
query library or a carefully scoped store around the API client. The important
behavior is request identity, cancellation, freshness, and caching, rather than the
name of the state library.

The home view has a few KPI cards, one main time-series chart, and links into focused
reports. Campaign detail and raw-event inspection are separate routes so each page
has a manageable query and rendering budget.

### State ownership

| State | Location | Reason |
|-------|----------|--------|
| Draft date range and filters | Filter form | Users can finish a change before querying |
| Applied query and timezone | URL plus shared query state | Reproducible links and consistent headings |
| Report response and revision | Query cache | Reuse by complete query identity |
| Loading/error/freshness per query | Query coordinator | Partial failures stay attributable |
| Hovered point or open tooltip | Chart component | Transient presentation only |
| Synthetic-click submission | Development tool | Does not change authoritative report totals |

I would not duplicate a campaign's name, selected ID, and filtered result list as
independently mutable state. Store the identity and derive the presentation from
catalog data wherever possible.

## 🔧 Deep dive 1: freshness without a fragile live connection — 9 minutes

> “I would start with polling because the product needs recent aggregates, not a
> message for every click. I would make the polling lifecycle explicit and display
> the age of the underlying data. A repeated fetch is only useful when the user can
> distinguish fresh, stale, and failed results.”

With 1,000 visible sessions and one refresh every five seconds, a single report
request creates about 200 requests per second. If every refresh independently loads
five endpoints, that becomes about 1,000 requests per second.

At an assumed 50 KB per combined response, 200 responses per second represent about
10 MB/second of uncompressed payload before transport effects. These are planning
figures; real payload size and cache reuse should be measured.

That calculation motivates shared query caching, fewer duplicate requests, and a
cadence based on the data's useful update rate. It does not automatically prove that
polling is either cheap or too expensive.

### Poll after the previous attempt settles

I would schedule the next refresh after the current request completes, with a small
amount of jitter across clients. A fixed interval that launches another request
while the previous one is still running can multiply load during an outage.

Pause or reduce automatic refresh when the tab is hidden, and refresh when the user
returns. Back off after transient failures and retain the last successful result.
Provide a manual refresh with clear in-progress feedback.

A network failure does not guarantee that the next poll will succeed. The UI should
show a stale indicator with a retry action rather than quietly pretending that
old values are current.

The initial load can use placeholders. A background refresh should generally keep
the previous data visible so the chart does not flash blank every few seconds.
If the applied filters changed, identify the old result as belonging to the prior
query until the new one arrives.

### Separate two clocks

The browser knows when it last received a response. The server knows the latest
event-time interval that its report considers complete. These timestamps answer
different questions.

“Fetched at 14:32” can still describe data complete only through 14:25. I would show
coverage or a freshness label supplied by the server, with a distinct warning when
processing is behind.

Recent buckets may remain provisional because of late events or fraud corrections.
A report revision or completeness boundary helps the UI explain why an earlier
point changed on refresh.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Poll bounded aggregate reports | Simple request lifecycle and ordinary HTTP caching | Repeated reads and up to one interval of extra delay |
| ❌ Push every click to every dashboard | Very immediate event delivery | Excessive client work and a different aggregation responsibility |
| Alternative: push invalidations | Refresh only when relevant data changes | Connection recovery and subscription state |

Server-sent events or WebSockets become reasonable when measured polling cost is too
high or the product needs faster notification. They still need reconnect, missed
update, and resynchronization behavior. A push transport cannot remove processing
lag in the analytics pipeline.

For this scope, I would accept several seconds of polling delay and spend effort on
correct data coverage. I would not claim that users cannot perceive that delay;
I would confirm that it is acceptable for the decisions they are making.

### Partial failure behavior

If one report panel fails while others succeed, each should retain its own result
and error state. A shared global error string can be cleared by an unrelated
successful request, hiding which data is stale.

Likewise, a global “last updated” timestamp should not imply that every panel was
successfully refreshed. Either return one coherent report response or display
panel-specific freshness when independent data sources are intentional.

## 🔧 Deep dive 2: prevent filters and results from disagreeing — 9 minutes

> “A fast dashboard showing the wrong campaign is worse than a slow one. I would
> make the complete applied query the identity of a request and its result. Then an
> older response cannot overwrite the screen after the user changes their selection.”

Imagine the analyst selects campaign A, then quickly selects campaign B. A's query
is slower and returns last. If both responses write into a single unqualified
`metrics` field, the heading can say B while the values belong to A.

Cancellation helps reduce wasted work, but the server may already have completed a
request or a response may still arrive. I would also associate every response with
the query identity or a request generation and only publish it to the matching view.

### Define a complete query key

The key includes campaign and advertiser scope, time range, timezone where relevant,
time granularity, grouping dimensions, and metric definition or report revision
when those affect results.

Normalize equivalent inputs, such as the ordering of grouping dimensions. Otherwise
the same logical query occupies multiple cache entries. Never share a cache entry
across authorization scopes just because the visible campaign filter looks similar.

The applied query drives the URL, title, request, and export action. Draft form values
remain separate until the user applies them or a documented debounce commits them.

For a time-range form with several controls, an explicit Apply action is often
clearer than firing expensive queries for every intermediate keystroke. A simple
campaign selector can apply immediately.

### Use consistent time boundaries

I would represent instants in UTC and display the chosen reporting timezone. The
interface must distinguish an absolute interval from a rolling “last hour” preset.
When sharing a report, decide whether the recipient should see that fixed interval
or evaluate a moving window at their current time.

Use half-open intervals: include the start and exclude the end. Two adjacent hourly
reports then do not both count an event exactly on their shared boundary.

Local date-time inputs need deliberate conversion. Filling one with a sliced UTC
string and later parsing it as local time can silently shift the requested range.
Daylight-saving transitions are another reason to test actual instants and labels,
not only the displayed hour number.

### Coherent response or independent widgets?

A single report response can include cards, a chart series, a revision, and coverage
metadata for one applied query. That makes the UI internally consistent and reduces
request fan-out.

Independent widget requests can improve cache reuse and let slow secondary panels
load separately. But they may come from different report versions or completion
boundaries, so the product must expose or reconcile that distinction.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ One coherent core report per applied query | Matching cards, series, scope, and freshness | Larger response and less independent loading |
| ❌ Unqualified shared metrics updated by any request | Minimal initial state code | Late responses can display the wrong data |
| Alternative: independently keyed widgets | Flexible caching and partial loading | Requires explicit per-panel consistency and freshness |

I would start with a coherent core report and load secondary details independently.
This keeps the common comparison reliable without forcing every table and metadata
list into one large endpoint.

### Loading, empty, and error are distinct

An empty result means the query completed and found no events in its defined range.
A failure means we do not know the result. Substituting zero after a failed request
could make an analyst think a campaign stopped receiving traffic.

A stale result should retain its original filter and time context. A campaign change
should not silently reuse another campaign's numbers under a new heading while the
spinner is small enough to miss.

For selection controls and result updates, keep keyboard focus stable. Do not move
focus to a chart on every background refresh or announce every point change through
an aggressive live region.

## 🔧 Deep dive 3: draw less data without changing its meaning — 9 minutes

> “I would ask the server for an appropriate time resolution, then render a bounded
> series. Reducing the number of chart points is a presentation decision. It must
> not change the totals or turn distinct users into an additive metric.”

A week contains 10,080 minute buckets before country or device splits. An 800-pixel
chart cannot communicate every point separately. Returning all raw click events
would be far more expensive and expose data the chart does not need.

The API should choose or accept a resolution and enforce a point/group limit. A
one-hour view might use minute buckets; a month view might use hourly or daily
buckets depending on the question and available retention.

When the user zooms into a smaller interval, request finer data for that interval.
This creates a small wait on zoom but bounds transfer, browser work, and server
query size across the whole report.

### Aggregation versus visual sampling

Server-side time aggregation preserves click totals by summing disjoint event
contributions into wider intervals. Visual downsampling selects a representative
shape; it is not an accounting calculation.

If we use a shape-preserving algorithm for a dense series, I would retain full-range
totals and extrema from the authoritative response. Summing sampled points would
produce a different and misleading total.

Taking every twentieth point can miss a short fraud spike. A peak-preserving or
shape-oriented sample may help visual inspection, but its behavior needs validation
against the specific chart question. I would not claim an unmeasured runtime or
that any algorithm preserves every important event.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Server time aggregation with bounded results | Predictable transfer and metric-preserving buckets | Finer zoom may require another request |
| ❌ Fetch every event and aggregate in the browser | Flexible local exploration | Large payload, duplicated computation, and access concerns |
| Alternative: client visual downsampling of a bounded series | Smooth overview rendering | Must preserve separate totals and label resolution |

Pagination is appropriate for raw-event tables; it is not the natural alternative
to a continuous time-series chart. Different visualizations need different data
contracts.

### Distinct users and rates require care

If the same user clicks in two hourly buckets, both buckets can show one distinct
user while the two-hour report still has one distinct user. Adding the bucket
values would overcount.

The server should return a distinct count for the requested union, or identify it
as an estimate computed from mergeable sketches. The frontend must not invent a
range total by adding scalar distinct counts.

Fraud rate also needs a defined denominator. The aggregate rate is total flagged
clicks divided by total clicks, not the average of per-bucket percentages. A bucket
with ten clicks and one with a million clicks should not have equal weight.

A missing bucket can mean zero activity, incomplete processing, or data beyond
retention. The API must distinguish those cases before the chart fills gaps with
zeros. A line joining unknown periods can imply continuity that we do not know.

Total clicks already include flagged clicks when that is the metric definition.
Stacking “total” and “flagged” series would visually count flags twice. Show flagged
clicks as a subset or stack eligible and flagged categories with clear definitions.

### Render for the available space

I would begin with a chart library and a bounded SVG series, disable unnecessary
point markers, and avoid animating every full refresh. Measure actual render cost
before replacing it with canvas or a custom visualization engine.

Long event tables need server pagination; if the visible page itself is large,
virtualization can reduce DOM cost. Virtualizing a table does not reduce the cost
of downloading an unbounded result.

Each chart should have a meaningful title, a concise trend summary, and access to
the same information as a table. Keyboard-accessible detail is preferable to a
hover-only tooltip. SVG is not inherently inaccessible, but visual paths alone do
not communicate the report's meaning.

## 🧪 Test tools and validation — 5 minutes

The development click generator is useful for exercising acceptance, duplicate
responses, and later projection. I would show its submission result separately from
report totals. A successful request means the event was accepted according to the
API contract; it does not justify optimistically incrementing a live KPI.

If a batch has individual failures, the tool must display them even if the overall
HTTP response is successful. Retry only failed or ambiguous logical events with
their original IDs, rather than create new identities for the same intended clicks.

For the dashboard, I would test:

- Slow campaign A followed by fast campaign B, with responses arriving out of order.
- A failed background refresh while a previous successful report remains visible.
- Two panels with different completeness times or one partial failure.
- A range crossing a daylight-saving boundary and an event exactly at the end.
- Repeated users across buckets, unequal fraud-rate denominators, and missing data.
- Large result groups with a bounded chart and an accessible table alternative.

Performance checks should include request fan-out per refresh, response size, chart
render time, and behavior after a tab returns from the background. A tiny component
render benchmark does not establish that the complete dashboard is efficient.

## 🎤 Close the design — 3 minutes

I would scale the query and rendering budgets first: cache identical scoped reports,
reduce redundant polling, limit dimensions, and fetch finer detail only when needed.
A store change or WebSocket migration is useful only if it addresses an observed
bottleneck or a new product requirement.

> “The dashboard's main promise is that the analyst can trust what a number refers
> to. Polling with coverage metadata explains freshness, query identity keeps filters
> and responses aligned, and bounded time-series data preserves meaning while the
> interface stays responsive. I would accept a little delay on a finer zoom before
> showing fast, unlabeled, or mathematically incorrect analytics.”
