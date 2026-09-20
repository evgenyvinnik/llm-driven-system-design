# Health Data Pipeline — Frontend System Design Interview

> “I would design a personal health dashboard that helps someone understand what was measured,
> which sources contributed, and how current the report is. A smooth chart is useful only if
> missing data and delayed processing remain visible.”

This is a proposed production design, separate from the teaching implementation. The
walkthrough is paced for 45 minutes, with three deep dives. I would put the overview on the
whiteboard early and return to its arrows as we discuss correctness and user experience.

## 🎯 Requirements and scope — 4 minutes

I would first clarify the audience: someone reviewing their own activity, sleep, and
measurements across several devices. This is a reporting product, not a clinical diagnosis or
emergency-monitoring system.

The main journey is to open today's summary, inspect a metric over time, understand a gap or
change, and check which device last contributed. Registering a device is part of the
experience, but actual device acquisition belongs to a separate sync client or provider
integration.

I would agree on four initial surfaces:

| Surface | User question |
|---------|---------------|
| Overview | What was recorded today, and is it complete? |
| Metric explorer | How did this metric change over my chosen period? |
| Source details | Which observations contributed, and what is delayed? |
| Account controls | Who can access this data, and how do I end my session? |

A zero step count, no observations, and an unfinished upload are different states. I would
make that distinction a requirement before choosing a chart library.

For discussion, assume a useful initial view within two seconds on a midrange phone and
ordinary report updates within two minutes of server acceptance. These are targets to validate
with representative devices and networks, not claims about the demo.

I would defer clinician sharing, complex dashboards, medical advice, and persistent offline
health history. A clear read-only report is enough to expose the central design problems.

## 🏗️ High-level architecture — 7 minutes

I would draw the browser boundary, three view areas, the state they consume, and one shared
data-access layer. The server stays an abstract authorized reporting boundary in this frontend
interview.

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                                    │
│                                                                                            │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ Charts + data table    │     │ Metric / date controls │     │ Sources + sync status  │  │
│  │ Values and gaps        │     │ Range + reporting zone │     │ Coverage / freshness   │  │
│  └────────────────────────┘     └────────────────────────┘     └────────────────────────┘  │
│                         ▲                              ▲                              ▲    │
│   render / inspect      │        choose view           │        inspect status        │    │
│                         │                              │                              │    │
│                         ▼                              ▼                              ▼    │
│  ┌────────────────────────┐     ┌────────────────────────┐     ┌────────────────────────┐  │
│  │ Report model           │     │ View state             │     │ Source status          │  │
│  │ Points + provenance    │◀───▶│ Metric, range, zone    │◀───▶│ Captured / accepted    │  │
│  │ Policy / report rev    │     │ Resolution budget      │     │ Processed watermarks   │  │
│  └────────────────────────┘     └────────────────────────┘     └────────────────────────┘  │
│                         ▲                              ▲                              ▲    │
│                         │                              │                              │    │
│   scoped reports        │        query identity        │        refresh status        │    │
│                         │                              │                              │    │
│                         ▼                              ▼                              ▼    │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Query coordinator + authorized report cache                                          │  │
│  │ Account + metric/range/zone/resolution/policy/version; response guards               │  │
│  │ Per-query loading, stale, empty and error states; clear on account change            │  │
│  └──────────────────────────────────────────────────────────────────────────────────────┘  │
│                                              ▲                                             │
└──────────────────────────────────────────────┼─────────────────────────────────────────────┘
                                               │
                                               │  HTTPS: report / status / explicit refresh
                                               │
                                               ▼
   ┌──────────────────────────────────────────────────────────────────────────────────────┐
   │ Health query service (server boundary)                                               │
   │ Current access checks, published aggregates, source coverage and processing status   │
   └──────────────────────────────────────────────────────────────────────────────────────┘
```

Starting at the center, metric/date controls update view state. That state defines a query
identity: account, metric, range, reporting timezone, and requested resolution. It does not
directly mutate the chart's previous response.

The coordinator fetches an authorized report. The report model retains values, units, gaps,
provenance, and publication versions. Charts and the data table consume that same model so
they cannot disagree about the underlying points.

The source panel asks a different question: what was captured, accepted, and processed? It can
update independently from a long-range chart. A single global loading flag would unnecessarily
hide unrelated information.

On the return path, the coordinator accepts a response only if it still belongs to the current
account and query. This is where cancellation, cache reuse, and late-response guards belong.

I would demonstrate an accepted backfill while the chart is open:

1. The source panel can show acceptance while the existing chart remains explicitly stale or processing.
2. Poll status within a bound, then fetch a new report when its publication version changes; do not add uploaded sample values directly to chart points.
3. Replace only the matching account, metric, range, zone, resolution, and policy context. Preserve gaps and coverage even when the request succeeds.
4. Returning to the page restores view preferences and reauthorizes report reads; this design does not promise a persistent offline health-history cache.

> “The main separation is between what the user wants to view and what the server has actually
> published. Keeping those separate makes range changes, retries, and processing delays easier
> to explain.”

I would begin with a client-rendered authenticated application and route-level loading/error
boundaries. Server rendering is optional for the public shell; it does not remove the need to
authorize and reconcile private report data.

React components can remain small: a route composes controls, status, summary cards, charts,
and a table. A query cache manages remote data; local component state manages open menus and
focus. A small shared store is sufficient for account context and cross-view preferences.

## 💾 Data model and API contract — 5 minutes

I would ask the backend for semantic report points rather than raw rows that every browser
must interpret independently.

| Model | Important fields | Owner |
|-------|------------------|-------|
| View selection | Metric, start/end, timezone, resolution | Browser |
| Report point | Bucket boundaries, value, unit, coverage, source policy | Server |
| Report identity | Query scope, publication version, processing watermark | Server / coordinator |
| Source status | Device label, last capture, last acceptance, processing state | Server |
| Query state | Loading, success, empty, stale, error, retry state | Coordinator |
| Interaction state | Focused point, tooltip, open source panel | Component |

Bucket boundaries should be real timestamps with a declared reporting timezone. A formatted
“Sep 12” label is presentation, not identity. It loses year and offset information and cannot
describe daylight-saving boundaries by itself.

The server should tell me whether the point is observed, partially covered, estimated, or
absent. The frontend can explain that information but should not invent it from a nullable
number.

A compact proposed API is enough for the whiteboard:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/reports` | Bounded metric/range report with coverage and version |
| GET | `/sources` | Registered sources and their status |
| GET | `/receipts/:id` | Accepted-versus-processed upload status when relevant |
| POST | `/sessions/logout` | End the current server session |

These paths illustrate the proposed contract; the repository's actual routes are documented in
architecture.md. I would avoid spending interview time on request JSON.

The important error contract distinguishes expired access, an invalid range, a temporary
reporting failure, and no available measurements. Each produces a different screen action.

## 🔧 Deep dive 1: Charts that preserve meaning — 8 minutes

**Decision: aggregate by metric semantics on the server and render explicit coverage in the
browser.**

A daily step total, average heart rate, and latest weight are three different kinds of report.
Treating them as interchangeable numbers makes the UI simpler initially but can make its
summaries wrong.

For steps, combining days means adding their totals. For an observation-weighted heart-rate
average, I need the sum and count or an equivalent weighted aggregate. Averaging daily
averages equally gives a day with one observation the same weight as a day with a thousand.

For latest weight, I need the latest measurement timestamp and the chosen value. Summing
weights or choosing the last item after priority sorting would not answer the user's question.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Server supplies semantic aggregates and coverage | Consistent meaning across clients; bounded payloads | Requires a richer contract and policy versioning |
| ❌ Browser applies one generic reducer to raw samples | Flexible initial prototype | Large transfers; inconsistent fusion and summaries |

I would walk through a concrete gap. Suppose a watch records steps on Monday and Wednesday but
has no Tuesday observations. The chart should break or mark the missing bucket, and the table
should say “No observations.” Connecting a smooth line across Tuesday suggests evidence we do
not have.

Zero is different. If a supported source explicitly reports a zero over a known covered
interval, the report can show zero with that coverage. “No rows” does not prove inactivity.

The same principle applies to partial days. At noon, today's total may be correct for the
received data but incomplete for the day. A “through 11:40” status is more useful than an
unexplained comparison with yesterday's complete total.

Timezone belongs in the report request and identity. If the user changes reporting zone, day
boundaries and totals may change, so I would request a new report instead of merely relabeling
the old x-axis.

For rendering, I would set a point budget based on the visible width and period. A year can
use daily or weekly buckets without returning every sensor observation. The response must
state that resolution so the tooltip and summary remain honest.

I would preserve meaningful extrema where needed and avoid a generic visual downsampling rule
that changes totals or implies a new average. The server chooses the semantic resolution; the
browser can reduce decorative detail without changing the result.

Accessibility is part of the report design. A keyboard-operable point selection, meaningful
labels, visible units, and a table using the same data model make the information available
beyond pointer hover. Color alone cannot distinguish missing, estimated, and observed data.

> “I am giving up some visual smoothness and client-side flexibility. That is worthwhile
> because the product's value is helping someone understand their measurements, not simply
> filling every pixel with a continuous curve.”

I would verify this with missing days, one-observation days, midnight-spanning intervals,
different timezones, and a narrow viewport. Snapshot tests alone would not catch an incorrect
weighted average.

## 🔧 Deep dive 2: Rapid navigation and account changes — 7 minutes

**Decision: key every request completely and guard its result by account generation.**

Consider someone selecting 90 days and then 7 days. The 7-day response arrives first. If the
cache is keyed only by metric, the older 90-day response can replace it while the controls
still say “7 days.”

That is a state-ownership problem, not a chart rendering problem. The coordinator needs a key
that includes the range and timezone, and the component should subscribe to that exact query.

Cancellation saves bandwidth, but it is not the correctness guarantee. A response may already
be in flight or a server may finish despite cancellation. The acceptance check must still
reject a response whose identity is no longer current.

An account generation handles a more serious version of the race. On logout or account switch,
increment the generation, cancel active queries, clear private caches and derived view state,
and reset source status. A response from the old generation cannot repopulate the new session.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Identified queries plus generation guards | Correct range/account ownership; independent states | More explicit cache lifecycle |
| ❌ One global metric map and loading flag | Little setup code | Late responses overwrite current views; data survives transitions |

I would keep stale data visible only when it belongs to the same authorized query context. It
needs a clear refreshing or failed-refresh label. A previous account's chart is never a useful
loading placeholder.

Similarly, changing from heart rate to sleep should not briefly relabel the old series as
sleep. Either retain the old chart with its old title during a deliberate transition or show
the new query's loading state.

Authentication initialization needs an explicit state: checking, authenticated, or signed out.
Redirecting before the session check finishes causes flicker and can discard the intended
route.

A temporary network failure should not automatically look like invalid credentials. I would
distinguish “cannot verify right now” from an explicit unauthorized response, then define
whether an already-open report may remain visible under the session policy.

For browser session storage, I would prefer a secure cookie-based session for a same-origin
product, with the corresponding request-forgery protection. This reduces token exposure to
ordinary script reads. It does not protect health data if malicious script already controls
the page.

The report payload stays in memory by default. Persisting it offline would require a separate
decision about device sharing, eviction, encryption keys, revocation, and deletion. I would
not add that complexity solely to avoid a loading spinner.

The trade-off is less offline availability and occasionally refetching data after navigation.
I would accept that first and measure whether a scoped cache solves most repeat reads before
adding persistent storage.

## 🔧 Deep dive 3: Freshness without misleading optimism — 7 minutes

**Decision: show upload acceptance and report publication as separate states.**

A source can capture data while offline, upload it later, and trigger recomputation of
yesterday's report. A last-sync timestamp collapses all of those stages and cannot explain
whether the visible total includes that upload.

I would model the experience around three timestamps:

| Time | Meaning | Display consequence |
|------|---------|---------------------|
| Captured | Device observed the measurement | Explains how recent the source evidence is |
| Accepted | Server durably stored the upload | Safe for the sync client to stop retrying it |
| Processed | A published report includes the accepted work | Safe to refresh the chart as updated |

The source panel can say “Upload received; reports updating” while the chart continues to show
its last published version. This is a valid partial-progress state, not an error.

I would not optimistically add an uploaded step count to the displayed daily total. Another
device might already cover the same interval, and the server's fusion policy might replace
rather than add that contribution.

Optimism is more appropriate for reversible presentation actions, such as dismissing an
informational card, provided failure restores it. Measurement totals need authoritative
reconciliation.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Poll active status and refresh published versions | Simple recovery; explicit processing progress | Some update delay and status requests |
| ❌ Immediately modify totals from upload payloads | Instant apparent feedback | Double counting and visible rollback after fusion |

For this reporting product, I would begin with bounded polling while the page is visible or
work is pending, plus explicit refresh. Back off on errors, stop hidden-tab polling, and avoid
launching a new request while the previous one is unresolved.

If the interviewer changes the requirement to continuous live exercise monitoring, I would
reconsider a push channel. That introduces reconnect and resynchronization behavior, and a
push notification still needs a versioned report read.

A worker failure should leave the last published chart available with a delayed-processing
message. A source that has not uploaded is a different explanation from a server that has
accepted data but is behind.

Corrections can lower an old total. I would preserve the selected range and focused date while
refreshing, show that the report changed, and allow source inspection. Treating every decrease
as an error would hide legitimate deduplication.

Descriptive trend cards should reference the report version and coverage used to produce them.
Comparing a partial week with a complete week can create a false change even when the chart
itself is accurate.

The cost of this design is additional status fields and more nuanced UI states. It avoids
promising immediate correctness where the underlying pipeline is deliberately asynchronous.

## 📈 Performance and failure checks — 4 minutes

I would measure time to useful report, interaction responsiveness, request cancellation/reuse,
chart render cost, and the age of the displayed publication. A fast response with stale or
mismatched data is not a successful experience.

The first performance fix is bounded data. Then I would isolate subscriptions so a
source-status refresh does not rebuild every chart, memoize expensive transformations when
measurements justify it, and defer offscreen reports.

Route code splitting should use supported lazy components and loading/error boundaries. It is
separate from data loading: a route's JavaScript can arrive successfully while its health
query fails.

I would prioritize these behavioral checks:

- Rapidly change ranges and deliver responses out of order.
- Log out during a request, sign into another account, and deliver the old response.
- Render empty, zero, partially covered, delayed, and failed-refresh states.
- Compare chart/table values and keyboard navigation across reporting timezones.
- Simulate an accepted upload whose report publication is delayed, then corrected.

On mobile, range controls, navigation, and source explanations must remain reachable. A
desktop navigation row hidden at small widths needs an actual replacement, not simply fewer
visible links.

## ⚖️ Trade-offs and implementation boundary — 3 minutes

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Data semantics | ✅ Server-defined points and coverage | ❌ Generic browser aggregation | Preserve metric meaning |
| State ownership | ✅ Complete query keys and account guards | ❌ Global metric-only state | Prevent range/account races |
| Freshness | ✅ Accepted-versus-published status | ❌ Optimistic health totals | Respect overlap and correction processing |
| Offline reports | ✅ Memory cache initially | ❌ Persistent private history | Keep lifecycle and revocation manageable |

The local project has React, Zustand, Recharts, summary cards, metric selectors, device
registration, and admin views. It lacks the proposed coverage/version contract, account/range
guards, accessible table, and processing-status flow. Its route components return fresh
Promises, and browser navigation was not verified in the documentation review.

The local health store survives logout and can accept an old range response. Those examples
motivate the boundaries in the overview; they are not recommended behavior. See
[architecture.md](./architecture.md#implementation-notes) for the source audit and
[README.md](./README.md) for setup.

> “I would finish by walking the diagram once more: controls choose an identified report, the
> coordinator accepts only current authorized responses, and the views explain values, gaps,
> sources, and freshness. That is the experience I would establish before expanding the
> feature set.”
