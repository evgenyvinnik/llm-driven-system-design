# Google Calendar — fullstack system design interview

A proposed calendar product, paced for a 45-minute interview. I would use one
connected system diagram to explain how a user's action becomes a persisted event and
then a visible calendar update. The repository's actual implementation is documented
separately in [architecture.md](./architecture.md).

## 🎯 Requirements and the user journey — 4 minutes

> “I’ll design the experience of opening a week, recording a meeting, and changing its time. The system needs to preserve what the user meant, keep every event discoverable, and make a successful save trustworthy.”

Assume private calendars with month, week, and day views, timed and all-day events, an
editor, calendar visibility controls, and advisory overlap warnings. Users can choose
a display time zone. The main interface is desktop/tablet, with a day agenda on narrow
screens.

Overlaps are allowed. A warning about two commitments is different from a reservation
system guaranteeing exclusive access to a room. I would clarify that distinction
before choosing a locking or transaction strategy.

Sharing, recurring-series editing, invitations, reminders, external integrations, and
long-term offline editing are outside the first release. If one is essential to the
interview, I would trade away another deep dive and explain the changed scope rather
than append every feature at the end.

For planning, assume 10 million registered users and 1 million daily active users.
Thirty range reads and two mutations per active user give roughly 347 reads/s and 23
writes/s on average, with a tenfold peak as a starting load scenario. These are
assumptions to size and test, not measured product usage.

Proposed regional goals are 99.9% availability, p95 bounded range reads under 200 ms,
and ordinary writes under 300 ms. The browser should acknowledge local navigation
within 100 ms. A displayed pending change is distinct from an event whose save has
been acknowledged.

| User action | Frontend obligation | Backend obligation |
|-------------|---------------------|--------------------|
| Open a week | Show correct dates, events, and load status | Authorized, bounded range with a revision |
| Create/edit | Preserve draft and explain pending/result state | Validate time, ownership, and conditional mutation |
| Change display zone | Recompute labels and day placement | Preserve temporal meaning in the contract |
| Hide a calendar | Update display immediately | Keep authorization and warning policy independent |
| Retry after a timeout | Resolve the same submitted operation | Return its retained outcome if committed |

## 🏗️ High-level architecture and walkthrough — 7 minutes

I would draw the browser boundary and the service boundary, then connect the
persistent path. The picture should let us follow both the request and the return of
authoritative data. The CDN serves the application assets; private event requests
follow the authenticated API path.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                                  │
│                                                                                          │
│  ┌────────────────────────┐    ┌────────────────────────┐    ┌────────────────────────┐  │
│  │ Views + event editor   │    │ Calendar model         │    │ Data access            │  │
│  │ Local draft, focus     │◀──▶│ Events + range state   │◀──▶│ Request + fixed op ID  │  │
│  └────────────────────────┘    └────────────────────────┘    └────────────────────────┘  │
│                                                                           ▲              │
│                                                                           │              │
│    Navigation → range fetch; save → operation ID + version                │              │
│                                                                           │              │
│    Result → event model → render; account and zone scope requests         │              │
│                                                                           │              │
└───────────────────────────────────────────────────────────────────────────┼──────────────┘
                         ▲                                                  │
                         │                    ┌─────────────────────────────┘
                         │                    │
                         │                    │  HTTPS ranges / commands / results
HTML / JS / CSS          │                    │
                         │                    │
                         ▼                    ▼
┌─────────────────────────┐      ┌─────────────────────────────────────────────────────────┐
│ CDN                     │      │ Authenticated Calendar API                              │
│ Versioned static assets │      │ Owner checks, time validation, versioned saves          │
└─────────────────────────┘      │ Range reads + advisory conflicts                        │
                                 └─────────────────────────────────────────────────────────┘
                                                                                         ▲
                                                                                         │
                                  read model / commit event + receipt                    │
                                                                                         │
                                                                                         ▼
                                 ┌─────────────────────────────────────────────────────────┐
                                 │ PostgreSQL                                              │
                                 │ Calendars, events, session rows, operation receipts     │
                                 │ Transactional source of truth; no browser authority     │
                                 └─────────────────────────────────────────────────────────┘
```

The browser's view/editor layer owns interaction, focus, local fields, and
presentation. The calendar model holds canonical events and explicit range load state.
The data-access layer owns request identity, errors, and reconciliation. These
responsibilities can be implemented with React, a small store, and a query library,
but their contracts matter more than the names.

The API owns authentication, calendar authorization, validation, overlap queries, and
durable mutations. PostgreSQL owns calendars, events, sessions, and retained operation
results. The browser cannot decide that an event is durably saved merely because it
updated its own array.

Initially, one Calendar service can handle both reads and writes. Scale service
instances behind a gateway and bound their combined database connections. Shared range
caching and read replicas are later options with explicit freshness rules, not
prerequisites for explaining the core product.

### Trace opening the week

The route selects a civil date, view, and display zone. The client calculates the
visible date window and asks the API for events intersecting its exclusive interval.
The server derives the account from the session and checks every requested calendar.

The server returns canonical events, a range revision, and any continuation. The
client verifies the response belongs to the active account and request, places it in
the matching range entry, and derives day segments. The view renders those segments
and keeps the range visibly incomplete if more pages remain.

A later response for a different week cannot replace this one. A fetch failure is an
error state for that range, while a successful empty response means there are no
events. The architecture makes those states distinct before we add performance tricks.

### Trace moving a meeting

The editor begins with a copy of the event and its version. The user changes the time,
checks the display zone, and presses Save. The client freezes that intent, assigns an
operation ID, and sends a conditional mutation.

The API validates and commits the new event version and operation outcome together.
The response returns the canonical event, owner revision, and advisory status. The
client updates the shared entity, invalidates both affected ranges, and reports the
save result to the correct editor instance.

The result then travels from the model back into every view showing that event. We use
the same identity from editor to database to grid; we do not create unrelated local
copies that can disagree about where the meeting is.

If the response is lost, the coordinator retains the submitted operation identity and
resolves that same result before retrying. It reconciles the returned event/version and
refreshes old and new ranges. Warning availability and any later cache invalidation are
separate from the durable save outcome; the UI should explain each without resubmitting
the meeting under a new ID.

## 💾 Shared data and interface contracts — 5 minutes

| Concept | Important fields | Authoritative owner |
|---------|------------------|---------------------|
| Calendar | ID, owner, name, color | Server; cached for display |
| Timed event | ID, calendar, start/end instants, authored zone, version | Server |
| All-day event | ID, calendar, start date, exclusive end date, version | Server |
| Editor draft | Fields, base version, dirty/pending state | One browser editor |
| Range entry | Account, bounds, zone, event IDs, revision, completeness | Browser knowledge of a server snapshot |
| Operation result | Account, operation ID, fingerprint, canonical outcome | Transactional receipt in storage |
| Layout segment | Event ID, clipped boundaries, lane | Derived browser data |

A shared schema can validate the exchanged shapes, but it must describe meaning as
well as types. A string might be a date, a timezone-less wall time, or an absolute
instant. Those values are not interchangeable just because they all fit in JSON.

Use stable event IDs and explicit versions. Read and write responses should expose
compatible display data, including effective calendar color and whether an event
overrides it. A successful edit should not temporarily lose its calendar name or
change color until the next refresh.

| Proposed endpoint | Inputs | Result |
|-------------------|--------|--------|
| GET `/api/v1/calendars` | Authenticated account | Owned calendars and capabilities |
| GET `/api/v1/events` | Calendar set, range, zone, continuation/minimum revision | Canonical events and range status |
| POST `/api/v1/events` | Typed draft and operation ID | Committed event plus advisory result |
| PATCH `/api/v1/events/:id` | Expected version and intentional field changes | New version or current conflicting event |
| DELETE `/api/v1/events/:id` | Expected version and operation ID | Retained deletion outcome |
| GET `/api/v1/operations/:id` | Identified uncertain operation | Its authorized retained result |

For partial updates, an omitted field means unchanged; explicit null can clear an
allowed nullable field. The UI must actually send the clearing intent. Returning a
plain string for every error would discard the current event needed for conflict
recovery, so the error contract should preserve that structured data.

Authentication uses a shared server-side session. All reads, writes, and operation
lookups derive the owner from it. A calendar visibility checkbox is a UI preference
and never a grant of permission or a promise of free time.

## 🔧 Deep dive 1: preserve time from form to grid — 7 minutes

### Start with a concrete example

Alice creates a meeting for 09:00 in Los Angeles. Later she views her calendar in New
York. The meeting's instant stays the same, while its displayed clock time changes.
Her all-day vacation for September 10 stays on September 10.

The form therefore needs a temporal type and an explicit zone for timed input. Resolve
its wall-clock fields deliberately and send an offset-qualified instant. Store the
authored zone separately for future editing. Sending a bare 09:00 string and letting
both the API process and database infer its zone is an easy way to compare one
interval and store another.

An all-day event uses dates, with an exclusive end. A one-day vacation begins
September 10 and ends September 11. There is no manufactured 23:59:59 timestamp and no
dependence on the precision of the database or browser clock.

The server checks positive duration, valid date/zone inputs, field limits, and
calendar ownership. The browser performs early validation to help the user, but server
validation protects every API client and cannot be replaced by HTML input constraints.

### Carry those semantics into rendering

A view requests events that overlap its interval, including those that began earlier.
A trip starting Sunday night may continue into Monday. The client splits a multi-day
timed event at each visible civil-day boundary and clips the segment before sizing it.

An event ending at midnight does not also appear on the following day. A 23:00–01:00
event contributes one hour to each ordinary day, not its full two-hour duration in
both columns. These are small examples that expose whether the layers share the same
interval contract.

Daylight-saving transitions need explicit handling. A missing local hour cannot be
treated as an ordinary available slot, and repeated clock times need a way to
distinguish their offsets. The browser can show a marked transition or use an agenda
for that interval; a fixed 1,440-minute denominator against ordinary clock labels is
insufficient.

Month view summarizes a whole-week grid, with a bounded number of pills and a
reachable “more” agenda. Week/day views have a separate all-day lane so those events
remain visible. They use the same event entities even though the geometry differs.

### Make overlaps discoverable

The renderer sorts each day's clipped segments and assigns reusable horizontal lanes.
Adjacent meetings can share a lane because interval ends are exclusive. Connected
overlap groups use their maximum simultaneous lane count to set widths.

Putting every event at the same full width would hide some commitments behind others.
On the other hand, dividing a column into dozens of microscopic lanes is not useful
either. For extreme density, use a grouped entry and agenda that exposes the exact
times and full titles.

| Approach | Why it fits | Cost |
|----------|-------------|------|
| ✅ Explicit timed/date types with clipped day segments | The form, query, and picture agree on meaning | More temporal fixtures and deliberate zone handling |
| ❌ Treat every event as a naive timestamp pair | Small initial schema/form | Time shifts, all-day drift, and inconsistent comparisons |
| ❌ Ignore overlaps in layout | Easy absolute positioning | Events become hidden precisely when the schedule is busy |

> “I would settle the time contract before optimizing the renderer. A beautifully drawn meeting at the wrong time is a worse result than a slightly slower calendar that preserves the user's intent.”

If recurring series are required later, the model must also preserve local recurrence
rules, a named zone, and exceptions tied to stable occurrence identity. The system
should expand a bounded requested window rather than generating an unlimited future
history. That extension cannot be implemented just by repeating an event at a fixed
UTC interval.

## 🔧 Deep dive 2: reliable saves and useful conflict warnings — 9 minutes

### Distinguish three different outcomes

A scheduling overlap is allowed and informational. A version conflict means someone
edited the same event since this draft loaded. An unknown save outcome means the
network failed before the client learned whether storage committed. The UI and API
need different responses for each.

For a first release, the editor shows pending feedback immediately and waits for
acknowledgment before treating the shared event as saved. This keeps the canonical
model straightforward. A future drag interaction can show a pending overlay without
changing the durable-save contract.

The editor initializes from the clicked slot and does not reset while the user is
typing because calendar metadata refreshed. Save freezes the submitted draft and its
expected event version. I would initially disable field editing until the result is
resolved, avoiding accidental loss of text typed after submission.

Every completion is scoped to the editor instance and account. If the user opens
another event, a late response from the old save must not close the new editor. The
client may reconcile the completed event into the appropriate cache, but it cannot
apply unrelated modal side effects.

### Make the database operation conditional and repeatable

Two tabs read version 7. One moves the meeting and commits version 8. The other should
not send its stale full form and overwrite that new time while changing only the
location. The server's update checks the expected version in the mutation itself.

On conflict, return the current authorized event. Keep the user's draft and offer a
comparison or deliberate reload/resubmit. Automatic merging of start from one draft
and end from another can produce an unintended meeting, so temporal fields deserve
explicit review.

A version alone does not deduplicate a create or resolve a lost response. The client
also supplies an operation ID for the frozen intent. The server claims an owner-scoped
unique receipt, performs the mutation, and stores its canonical outcome in the same
transaction.

A repeated operation with the same payload returns that result. Reusing the ID with
different content is rejected. After a timeout, the client retries or resolves the
same operation, rather than creating a fresh request that could insert a duplicate
meeting.

The receipt has a declared retention period. After it expires, the system must
reconcile before interpreting a very old retry as new intent. This is a bounded
operational guarantee, not a blanket claim that networks now deliver exactly once.

### Keep advisory feedback separate from durability

The overlap query examines the user's relevant timed events and excludes the edited
event itself. It uses the same normalized boundaries as persistence. Hidden calendars
can still produce warnings because hiding something from view does not make the person
available.

A preview can improve editing feedback, but bind it to the draft revision and treat it
as advisory. Another device may create an event before Save. A room booking would need
a stronger allocation invariant; the personal calendar should not imply that a clean
preview reserves the interval.

When Save succeeds with overlaps, retain a visible message such as “Saved — overlaps
with two events” in details or a persistent notification. A warning stored only in a
modal that immediately closes is effectively lost.

If the event commits but the warning lookup fails, return the committed result with
warning status unavailable. Telling the user simply “Save failed” encourages another
create and can produce duplicates. The durable result and the optional advisory must
have separate failure meanings.

If downstream cache invalidation or notifications are added, record an outbox entry in
the transaction and process it later. A failed worker should delay that effect, not
reverse the already committed event or manufacture an ambiguous response.

### Be explicit about the trade-off

Waiting for an acknowledged save adds a server round trip before the event settles.
Conditional versions add a conflict recovery screen; receipts add retention and lookup
work. Those costs are justified by the risk of silently losing edits or duplicating
real commitments.

Optimistic overlays can improve perceived speed once this protocol exists. Without
operation identity and canonical reconciliation, “just roll back on failure” is
incomplete: the database may have succeeded, and later local actions may depend on the
supposed failed event.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Pending UI, conditional save, retained operation result | Honest outcome and recoverable concurrent edits | Round trip, receipt lifecycle, conflict UI |
| ❌ Assume success and blindly retry errors | Simple happy-path interaction | Duplicates and silent lost edits |
| ❌ Block every overlapping personal event | Appears to prevent scheduling mistakes | Rejects legitimate alternatives and tentative commitments |

> “I would make the server precise about what committed and the browser precise about what it knows. The conflict warning then becomes useful information instead of being entangled with whether the save happened.”

## 🔧 Deep dive 3: bounded reads and coherent navigation — 8 minutes

### Give a range its own identity

The client keys fetched data by account, calendar set, exclusive date window, and
relevant display zone. Each entry knows whether it is loading, complete, incomplete,
stale, or failed. The selected view reads that entry rather than whatever happens to
be in a single global events array.

Suppose the user requests April, then May. May returns first and renders. April's late
response may populate April's own entry, but it cannot replace May's events.
Cancellation saves work; identity checks protect state even if the canceled response
still completes.

On logout or account change, retire the request generation, clear private cache/editor
state, and prevent old responses from repopulating it. SQL owner checks protect server
reads, while the browser lifecycle prevents previously loaded private data from
leaking into the next account's view.

The route owns date/view navigation so Back returns to the right scope. Calendar
visibility can filter already fetched data immediately. Avoid refetching calendar
metadata in a way that resets the user's hidden-calendar choices or wipes an editor
draft.

### Keep the server's work bounded

The API authorizes the requested calendars and selects events overlapping the range.
The predicate must include events that started before the range but end inside or
after it. A start-only date filter would omit long trips and overnight meetings.

A calendar/start-time B-tree is an initial option, but range predicates can still
examine substantial history. Test large histories and long-duration events, then
compare a matching range index/operator where useful. The existence of an index does
not establish which query plan is used.

Bound request duration, returned rows, and payload size. A six-week view can still be
dense, so responses need continuation and completeness. The frontend should never
label a first page as the complete calendar just because it rendered successfully.

A simple paging contract uses a range snapshot revision. Continuation is rejected if
the owner has changed since that snapshot; the client can restart once and then narrow
the request or explain ongoing changes. This is more manageable initially than holding
a database snapshot open for an arbitrarily slow browser.

### Reconcile both sides of a move

An event moving from Friday to Monday affects the source and destination views. Merge
the canonical event by stable ID, remove stale memberships, and invalidate loaded
ranges intersecting its old or new interval. Deletion similarly removes memberships
and advances known state.

The server returns a change revision with the mutation. Subsequent range requests can
require at least that revision, preventing a lagging replica or shared cache from
resurrecting the old Friday meeting immediately after the user moved it.

Keep only a bounded number of browser ranges and prefetch adjacent ones after the
active request succeeds. This makes common navigation fast without downloading a year
of events or letting speculative work delay the user's current view.

Shared caching is a later optimization. Its entries must be private, revisioned, and
expiring; an outbox can retry invalidation of old/new ranges. A delayed cache fill can
still contain old data, so the writer's freshness requirement remains necessary. Other
devices may see bounded stale data under the chosen policy.

### Scale at the right layer

First measure server candidate rows, response bytes, browser grouping cost, and layout
time. A slow request caused by a huge payload will not be fixed by memoizing a React
component; a slow dense grid will not be fixed by adding a database replica.

Add API replicas with bounded database pools, and database read replicas only where
the requested freshness can be satisfied. If storage requires sharding, private
calendars can be placed by owner. Shared organizational calendars change that
distribution problem and should be designed explicitly when they enter scope.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Bounded range protocol and scoped browser cache | Responsive navigation with explicit completeness | Revision and membership management |
| ❌ Download all history | Simple local date switching | Growing startup, memory, and staleness |
| ❌ Replace one array on any response | Minimal client state | Wrong-range displays and stale resurrection |

> “I would make each range a coherent piece of knowledge. That connects the database query, network response, and calendar heading, and it gives both teams a concrete contract to test.”

## ♿ Quality, failure handling, and rollout — 5 minutes

The calendar needs keyboard-accessible dates and events, a usable agenda, and a modal
with labels, focus management, Escape/close behavior, and focus restoration. Announce
meaningful save/error states. Calendar names and time labels carry information
independently of color.

On narrow screens, favor a readable day agenda and collapsible navigation. In a dense
week, every hidden event must remain reachable through an overflow control. Minimum
hit areas should not change the underlying event times or the server's overlap
calculation.

Authentication needs shared session storage, session rotation, managed secrets,
appropriate Secure cookie/proxy settings, and suitable CSRF/origin defenses. Validate
runtime inputs and keep private event content out of operational logs. Authorization
is repeated for mutations and operation-result lookup, not only when opening the
editor.

I would instrument the whole user journey: range latency/completeness, stale-response
drops, layout cost, committed saves, version conflicts, unresolved outcomes, and
advisory failures. A static health endpoint alone cannot tell us that sessions or
event queries are working.

| End-to-end scenario | What should remain true |
|---------------------|-------------------------|
| Create in one zone, view in another | Timed instant is preserved; all-day date does not drift |
| Midnight, overnight, DST transition | Query inclusion agrees with rendered boundaries |
| Two tabs edit one meeting | The stale draft survives an explicit version conflict |
| Lose the save response | Resolving the operation does not create another meeting |
| Save with overlaps | Saved outcome and warning remain visible |
| Navigate quickly, then log out | No wrong-range or previous-account data appears |
| Move across weeks | Both source and destination reconcile to the new event |

I would release the temporal contract and basic acknowledged editor first, then add
robust range caching and density/accessibility improvements, and only then expand
scope to collaboration or recurrence. Each step can be validated with concrete
journeys rather than an infrastructure checklist.

The repository's local demo provides the starting views, event routes, owner checks,
and PostgreSQL sessions. Its missing layout, time-zone, request-lifecycle, and save
guarantees are recorded in the architecture document. The interview design describes
how those pieces should fit together as the product matures.
