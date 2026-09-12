# Push notification console — frontend interview answer

This is a proposed operator experience for an APNs-inspired service.
It is not a claim that the local console implements every feature below.
The [architecture](./architecture.md) documents the actual simulator and its protocol differences.

The outline allocates 45 minutes, including discussion and drawing.
I would draw one system diagram, then work through three difficult user interactions.

## 🎯 Frame the problem — 4 minutes

> "I want an operator to answer three questions: did we accept the notification,
> where is it now, and what can I safely do next? A green response from an API
> is not enough to say the device received it. That distinction should shape
> the console before I choose a component library."

I would clarify the primary user: an application developer investigating a failed push,
or an operations engineer diagnosing a fleet incident.
Both need trustworthy status, but they work at different levels of detail.

A developer starts with one app, environment, device, or operation ID.
An operator starts with a time range, queue age, or error category.
The first version should make those paths converge on an understandable operation detail.

### Scope

- Browse a bounded page of registered destinations and their validity.
- Compose a test for one destination, preview its content, and submit it.
- Follow acceptance and subsequent delivery evidence without inventing certainty.
- Inspect aggregate health and freshness within an authorized app/environment.
- Handle delayed responses, session expiry, and temporarily unavailable services.

Bulk campaigns, native operating-system notification rendering, and a general analytics
query builder are outside my first version. A broadcast control deserves a separate
workflow because its audience and retry effects differ from a single-device test.

### Quality goals

I want the visible table to remain responsive with a large server-side history.
A page should explain whether it is loading, empty, stale, or failed.
Routine aggregate freshness can be about 30 seconds; one test operation can refresh faster.

Keyboard users must be able to complete the send-and-inspect flow.
Status must be understandable without relying on red or green alone.
An unavailable backend should not destroy an unsent draft.

> "I would agree on these interaction goals before promising a live feed.
> Thousands of events per second can be technically current and practically unreadable."

## 🏗️ Architecture and ownership — 5 minutes

I would draw this once and refer back to it:

```
┌─────────────────────┐     ┌──────────────────────┐
│    Console routes   │────▶│ Session + API client │
│  Overview/list/test │     │ Request cancellation │
└──────────┬──────────┘     └───────────┬──────────┘
           │                            ▼
┌──────────▼──────────┐     ┌──────────────────────┐
│  Draft + view state │     │ Authorized read API  │
│ Selection + filters │     │ Status + aggregates  │
└─────────────────────┘     └───────────┬──────────┘
                                        ▼
                            ┌──────────────────────┐
                            │    Delivery state    │
                            │ Acceptance/attempts  │
                            └──────────────────────┘
```

The browser reads a bounded projection of the service.
It does not subscribe directly to the internal delivery broker or infer delivery from
whether its own connection to the console API is healthy.

### Component responsibilities

| Area | Responsibility |
|------|----------------|
| App shell | Session check, authorized scope, navigation, shared outage notice |
| Overview | Timestamped counters and links into filtered investigations |
| Device list | Page, selection, readable identifiers, validity evidence |
| Composer | Draft, validation, target summary, explicit submit |
| Operation detail | Stable operation identity, state, timestamps, retry guidance |
| API layer | Authentication, cancellation, typed errors, request identity |

I would keep server records in a query cache or a small explicit resource layer.
Zustand can own cross-route selections and session state; local state owns temporary
form edits and open panels. A query library is a choice, not a correctness guarantee.

The crucial separation is between an editable draft and an accepted operation.
Typing in a field should never mutate the historical payload displayed in a result.

### State placement

Filters, sort order, page cursor, and app/environment belong in the URL when shareable.
A colleague should be able to open the same investigation context.
Raw addressing tokens and payload secrets do not belong in URLs.

The operation resource carries authoritative status and observation timestamps.
The browser carries selection and presentation preferences.
Session identity scopes cached records so a later user cannot inherit the previous user's data.

## 🧭 Information model and API contract — 4 minutes

> "I would define status words with the backend team before implementing badges.
> The UI cannot repair a server that uses delivered to mean published to a broker."

### Observable states

| State | What the console can say |
|-------|--------------------------|
| Submitting | A request is in progress; acceptance is not yet known |
| Accepted | The service durably recorded the operation |
| Retained | Work is waiting for a destination or scheduled attempt |
| Handed to gateway | A transport attempt occurred; device receipt is not established |
| Receipt confirmed | An authenticated device transport acknowledged the operation |
| Expired/superseded/rejected | A specific reason ended further attempts |
| Outcome unknown | The response was lost and status lookup has not resolved it |

Application handling and a person's interaction are different observations.
If we do not collect them, the console should not display them as inferred successes.
A terminal receipt should not turn back into retained because an older fetch arrives late.

### Proposed API surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | /console/session | Current identity and permitted scopes |
| GET | /console/overview | Counters, window, observation time, data completeness |
| GET | /console/devices | Bounded page within selected scope |
| POST | /console/test-operations | Accept a test with a stable operation identity |
| GET | /console/operations/:id | Current state and bounded attempt history |
| GET | /console/operations | Filtered, paginated investigations |

Responses include enough identity to verify that they match the current view.
I would use a stable cursor for a moving history list and a deterministic tie-breaker.
Total counts can be approximate or delayed if labeled; they should not block the page.

An error distinguishes invalid input, lost authorization, service overload, and an
uncertain write outcome. One generic red message cannot tell the operator what to do next.

## 🔧 Deep dive 1: trustworthy freshness — 8 minutes

### Decision: start with bounded polling and visible observation time

For overview cards, I would fetch a snapshot periodically while the page is visible.
The response includes the period being measured and when the projection was updated.
A browser request that just completed may still contain an old server projection.

The console displays that difference rather than stamping every response "live."
For an actively inspected test operation, I would poll more frequently for a bounded
period and slow down when it stays retained or the tab becomes hidden.

### Why this fits

The operator needs changes at a human timescale, not every internal event.
A thousand open overview tabs polling every 30 seconds create about 33 requests/second.
That is manageable if the backend serves an aggregate projection instead of rescanning
billions of history rows for each request.

Ten thousand delivery events per second sent to every browser would multiply network
and rendering work while obscuring the failure the operator is investigating.
Polling a small snapshot makes the data and failure boundaries straightforward.

### Prevent overlapping and stale responses

1. Fetch the current scope and attach a request generation.
2. Schedule the next refresh after the current request settles.
3. Cancel or disregard old work when filters, route, or session change.
4. Apply the response only if its scope and generation still match.
5. Preserve the last successful snapshot on a transient failure.
6. Show its age and provide a retry action.

Cancellation saves resources, but a response can race cancellation.
The identity check is still necessary. A global loading boolean cannot tell which of
two overlapping requests is allowed to replace the visible data.

For an operation, a server revision or ordered lifecycle sequence prevents state regression.
For aggregate snapshots, I would compare the defined snapshot version/time within the
same scope, not combine arbitrary fields from different windows.

### Why not a raw WebSocket feed initially?

A socket adds connection lifecycle, event ordering, reconnect gaps, and server fan-out.
It does not automatically make the view correct. If the connection drops, a browser
needs a resume cursor or a fresh snapshot before it can claim completeness again.

If subsecond updates become necessary, I would consider a scoped SSE stream for
server-to-browser status changes, since the browser still submits commands through HTTP.
A bidirectional WebSocket is useful only if the interaction actually needs it.

I would retain snapshot reconciliation in either case.
An event can invalidate a cached record or advance a version; it should not bypass
authorization or fabricate a complete history from an incomplete stream.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Bounded polling | Simple recovery, bounded data, appropriate human cadence | Delayed change detection and periodic requests |
| ❌ Raw per-event stream | Low event latency | Browser overload, gap recovery, event ordering complexity |

### What I give up

A 30-second overview cannot promise immediate incident detection.
Operational alerting belongs in the monitoring system, independent of an open tab.
The console explains an alert and investigates state; it does not replace that system.

> "I would trade a little display latency for a page whose freshness has a clear
> meaning. If we later need streaming, the same versioned state model still applies."

## 🔧 Deep dive 2: submitting a test without accidental repeats — 8 minutes

### Decision: freeze the submitted attempt and recover by its identity

The composer has a draft with target, environment, delivery class, and content.
Before submission, I show a compact summary of those fields and any validation errors.
For one-device tests, the review can sit beside the form rather than become a lengthy wizard.

On submit, I create a stable operation identity and a frozen request snapshot.
The accepted result belongs to that snapshot even if the operator starts editing a new draft.
The result should say which target and content it describes.

### Validation is shared, authority remains on the server

I would validate required target and payload fields in the browser for quick feedback.
Payload limits must count the final UTF-8 representation, including custom data and structure.
A visible byte counter is useful for a payload editor; a character counter can be wrong
for accented text or emoji.

The backend repeats validation and checks the authenticated user's scope.
A disabled button and a route redirect are not authorization.
The UI explains field-specific errors returned by the server without losing the draft.

### The ambiguous timeout

Imagine the server accepts a test, but the connection drops before the response.
If the console says "failed, try again" and sends a new ID, it can produce a second notification.
If it says "sent," it invents evidence the browser never received.

Instead, the UI enters outcome unknown and looks up the original operation.
The backend contract must support that stable identity before the browser can offer safe recovery.
Retrying the same ID must validate the same target and payload, and resume or return the operation.

If that contract is absent, I would preserve uncertainty and explain that another send
is a new attempt. Frontend state alone cannot create backend idempotency.

### Interaction sequence

1. Validate the draft and show the selected app/environment and destination.
2. Freeze the request and retain its operation identity.
3. Submit once and disable the same attempt's submit action.
4. Display accepted state or structured rejection when known.
5. On a transport timeout, query the same operation instead of creating another.
6. Follow later receipt/expiry evidence in the operation detail.

The user may edit a new draft while an old attempt is resolving, but the two must be
visually distinct. Clearing the form cannot erase a still-uncertain operation's identity.
Sensitive payloads should not be persisted broadly just to survive navigation.
A recoverable operation ID often suffices once acceptance is known.

### Why not optimistic success?

Optimistic updates work well for reversible local preferences.
A notification send has an external effect, and acknowledgement is asynchronous.
Changing a badge to delivered immediately may encourage someone to close an incident
while the device is still offline.

I would optimistically show the attempt in the local list as submitting, clearly labeled.
I would not increment confirmed delivery counts or mark it terminal without evidence.
The distinction retains responsiveness without confusing intention with outcome.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Identified attempt plus status recovery | Handles lost responses and preserves context | Requires backend operation lookup and additional UI states |
| ❌ New request after every timeout | Easy to implement | Can repeat external effects and lose audit continuity |

### What I give up

There is more visible uncertainty and a more complex state model.
That is appropriate for a diagnostic tool: hiding uncertainty does not remove it.
The benefit is a workflow an operator can trust during the failure they are investigating.

## 🔧 Deep dive 3: useful navigation through large histories — 8 minutes

### Decision: bounded server pages with explicit investigation context

A push history can contain millions of records, but an operator needs a small subset.
I would start with app/environment, time window, status, and operation/device identity.
Filtering belongs on the server; filtering one downloaded page cannot answer a global query.

The URL records shareable filters and the current cursor.
A separate selected operation opens a detail panel or route with full identifiers,
copy actions, status evidence, and a bounded attempt timeline.

### Why pagination before virtualization?

Pagination bounds network payloads and database work as well as browser rendering.
Virtualization only bounds mounted rows; downloading a million records still consumes
memory and network, and sorting them still consumes CPU.

For a table of 20–50 rows, native table semantics are simpler and accessible.
If the product later needs long, continuous investigation lists, I would add
`@tanstack/react-virtual` over already paginated data and test keyboard/focus behavior.

### Stable pages under concurrent writes

A descending history list changes while the operator reads it.
Offset paging can shift records between pages as new rows arrive.
I would use a cursor based on creation time and a unique ID, with a documented snapshot
or upper-bound time so repeated navigation has a predictable meaning.

When new records arrive, show a "new activity available" action instead of continually
inserting rows above the operator's current selection. Refreshing is a deliberate
navigation decision; it should not move a focused control unexpectedly.

Changing a filter resets the cursor and selection only where the selection becomes invalid.
A failed refresh preserves old results with a stale indication rather than presenting
"no notifications" as if the query succeeded.

### Accessible investigation

Use a native table with clear headers for tabular records.
Expose full identifiers through a labeled detail/copy action while keeping rows compact.
Status badges include text, and error summaries point to specific fields.

The composer needs associated labels, logical focus order, and keyboard-operable controls.
After submit, announce the acceptance/uncertainty message without stealing focus on every poll.
A changing counter should not continuously interrupt a screen reader.

On narrow screens, provide reachable navigation and horizontal table scrolling or a
purposeful summary layout. Hiding all navigation links at a breakpoint is not a mobile design.

### Why not a continuously animated event feed?

It is attractive in a demo but makes stable inspection difficult.
A record can move while someone tries to read or select it, and each incoming event can
trigger expensive reconciliation and accessibility announcements.

The bounded view sacrifices a sense of constant activity in exchange for reproducible
queries, stable focus, and useful detail. Those properties fit troubleshooting better.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Server-filtered cursor pages | Bounded load and stable investigation | Requires cursor/query semantics |
| ❌ Download-and-filter live feed | Simple small demo | Incomplete searches, moving rows, unbounded memory |

## 🧪 Failure handling and validation — 5 minutes

I would validate user-visible invariants, not just whether the page renders.
The key tests are about when one response is allowed to change another view.

### Scenarios I would exercise

- Switch status filters while the first request is delayed; old results must not replace new ones.
- Log out and log in as another user while a request is in flight; prior data must be discarded.
- Accept a send on the server and drop its response; recovery must keep the same operation.
- Lose a refresh after a successful snapshot; the page must show stale data, not an empty result.
- Deliver older status after a receipt; the operation must not move backward.
- Navigate the send and inspection flow using only a keyboard and a narrow viewport.

A session check needs a distinct initializing state to avoid premature redirect flicker.
A transient service outage should be distinguishable from a definite expired session.
On logout, clear scoped query data, selected sensitive details, and pending subscriptions.

### Performance evidence

Measure route readiness, slow input interactions, request sizes, and table render costs
with representative pages. Do not add memoization or virtualization everywhere first.
If the backend snapshot is slow, a frontend spinner optimization will not fix its query plan.

For streaming later, test resume gaps, duplicate events, and snapshot reconciliation.
For polling now, test hidden tabs, backoff, manual refresh, and cleanup on navigation.
Document the observation window behind every aggregate.

### Connection to the local project

The local app already has React routes, Zustand session/dashboard stores, centralized
fetch, 20-row lists, a 30-second overview poll, and a send form.
It does not implement the operation recovery, scope isolation, versioned queries,
cursor paging, or receipt-tracking experience proposed here.

Its backend currently reports publication as delivered and leaves most APIs unguarded.
Those contract problems need backend changes; changing the badge text alone is insufficient.
The existing smoke checks exercise page shells, not these failure scenarios.

## ⚖️ Trade-offs and close — 3 minutes

| Decision | Chosen | Alternative | Main cost |
|----------|--------|-------------|-----------|
| Overview freshness | ✅ Bounded polling with timestamps | ❌ Every delivery event in the browser | Some update latency |
| Test submission | ✅ Frozen attempt with stable identity | ❌ Optimistic success/new retry IDs | More outcome states and backend support |
| History navigation | ✅ Filtered cursor pages | ❌ Unbounded live feed | Explicit pagination and refresh controls |

> "The console succeeds when it makes a complicated asynchronous system legible.
> I would keep the overview bounded, make each submitted test recoverable by identity,
> and preserve a stable investigation context. That gives operators a fast interface
> without claiming delivery evidence the backend does not have."
