# Google Calendar — frontend system design interview

A proposed calendar client for a 45-minute interview. The local project implements
only part of this design; [architecture.md](./architecture.md) documents that
boundary. I would draw the browser overview early, trace one interaction through it,
and use three deep dives to explain the difficult choices.

## 🎯 Requirements and scope — 4 minutes

> “I’ll focus on helping someone understand their week and safely change an event. The hardest parts are representing time correctly, keeping navigation responsive, and making the result of a save unambiguous.”

I would first confirm the main views and users. Assume a desktop and tablet calendar
with month, week, and day views, several private calendars, timed and all-day events,
and an event editor. A narrow screen can use a day agenda rather than squeezing seven
unreadable columns into the viewport.

We need date navigation, calendar visibility controls, event
creation/editing/deletion, and advisory conflict warnings. Overlaps are allowed: a
tentative meeting should not make it impossible to record another commitment. A hidden
calendar can still contain a scheduling conflict.

I would leave shared editing, recurring-series editing, drag-and-drop, notifications,
and an offline write queue outside the first release. They are valuable extensions,
but adding all of them would leave too little interview time to explain the core
interaction correctly.

The user can choose a display time zone. Timed meetings retain their actual instants
when the display zone changes; an all-day holiday stays attached to its dates. The
server contract must preserve that distinction, even though the renderer handles both
in the same product.

For sizing the browser, assume ten calendars and up to a thousand events in a busy
visible range. That is a fixture to test, not a universal limit. Local navigation
feedback should appear within 100 ms, and ordinary admitted range reads should
complete within 200 ms at p95 in the user's region. These are proposed targets, not
measured performance.

I would agree that a blank calendar means the requested range loaded successfully and
has no events. It must not also mean “still loading,” “request failed,” or “only the
first page arrived.” Correct empty states are part of the product's trustworthiness.

## 🏗️ High-level browser architecture — 8 minutes

I would draw the browser boundary, its visible controls, the shared model, and the API
boundary. Each arrow answers a question: who receives the action, where the data
lives, and what changes when the response arrives.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                                  │
│                                                                                          │
│  ┌────────────────────────┐    ┌───────────────────────┐     ┌────────────────────────┐  │
│  │ Calendar views         │    │ Event editor          │     │ Navigation controls    │  │
│  │ Month / week / day     │    │ Draft + pending op ID │     │ Date / zone / filters  │  │
│  └────────────────────────┘    └───────────────────────┘     └────────────────────────┘  │
│                          ▲                            ▲                              ▲   │
│   render / select        │      edit / result         │       change scope           │   │
│                          │                            │                              │   │
│                          ▼                            ▼                              ▼   │
│  ┌─────────────────────────────────────────────────────┐     ┌────────────────────────┐  │
│  │ Calendar model + derived layout                     │     │ UI state               │  │
│  │ Event entities, range status, versions              │◀────│ View, date, time zone  │  │
│  │ Day segments and overlap lanes                      │     │ Visible calendar IDs   │  │
│  └─────────────────────────────────────────────────────┘     └────────────────────────┘  │
│                             ▲                                            │               │
│  range / save commands      │                                 range key  │               │
│                             ▼                                            │               │
│  ┌─────────────────────────────────────────────────────┐                 │               │
│  │ Data access + mutation coordinator                  │◀────────────────┘               │
│  │ Read identity; submitted ID + version; reconcile    │                                 │
│  └─────────────────────────────────────────────────────┘                                 │
│                             ▲                                                            │
│                             │                                                            │
└─────────────────────────────┼────────────────────────────────────────────────────────────┘
                              │
                              │   HTTP: ranges / commands / versions
                              │
                              ▼
   ┌────────────────────────────────────────────────────────────────────────────────────┐
   │ Calendar API (server boundary)                                                     │
   │ Authorized events, canonical save results, advisory conflicts                      │
   └────────────────────────────────────────────────────────────────────────────────────┘
```

I would trace an uncertain Save back through the same coordinator: retain the submitted
operation ID and frozen fields, resolve its outcome, then update the shared event and
both affected ranges. An overlap warning belongs to that saved result; it is not a
second verdict on whether the database committed. This requires no offline write queue.

The calendar views receive already grouped and positioned events. They render cells,
event buttons, overflow indicators, and the all-day lane. They emit selection or
slot-click actions rather than performing their own network requests. This keeps month
and week views from developing incompatible fetching rules.

The event editor owns a draft, field errors, focus, and the identity of the save in
progress. Editing a title should not immediately mutate the canonical event shared by
other views. Its Save action submits a frozen draft through the mutation coordinator;
the accepted event then enters the shared model.

The calendar model holds normalized event entities and the result status for each
loaded range. Derived selectors combine those entities with visibility and
display-zone preferences to produce day segments and overlap lanes. The server owns
persisted truth; this model owns the browser's current, explicitly versioned knowledge
of it.

UI state owns the selected date, view, zone, visible calendar IDs, and open editor
identity. Date and view can live in the URL so Back and shared links behave
predictably. Transient pointer or focus state stays near the component that uses it.

The data-access layer owns fetching, response validation, deduplication of identical
in-flight reads, and request identity. It can be implemented with a query library plus
a small mutation coordinator. Naming a library does not explain cancellation, cache
keys, or conflict handling, so I would discuss those contracts first.

### Walk through “next week”

The toolbar advances the civil date and updates the route/UI state. The coordinator
derives the new exclusive interval in the chosen zone and looks up that range's cache
entry. The view can show known events immediately with a refresh indicator, or show a
loading state if that range is unknown.

The API returns events and a range revision. The coordinator checks account, range,
and request identity before merging them into the model. Selectors group the events
into days, then the week view renders them. A late response for the previous week can
populate its own cache entry but cannot replace the currently selected week.

### Walk through “move a meeting”

Selecting an event copies its canonical fields into an editor draft with the expected
event version. The user changes the start/end time and presses Save. The coordinator
sends the identified command and receives a canonical event plus advisory status. It
updates the entity, invalidates affected old/new ranges, and reports the result to
that editor instance.

This is a connected architecture: controls express intent, the model exposes known
state, and one data boundary reconciles server results. I would refer back to these
same boxes during the deep dives instead of drawing an unrelated implementation
diagram for each feature.

## 💾 Data ownership and interfaces — 5 minutes

| Data | Important fields | Owner and lifetime |
|------|------------------|--------------------|
| Calendar | ID, name, color, capabilities | Server-originated, shared browser model |
| Timed event | ID, calendar, start/end instants, authored zone, version | Server-originated entity |
| All-day event | ID, calendar, start date, exclusive end date, version | Server-originated date range |
| Range entry | Account, interval, zone, IDs, revision, loading/completeness | Bounded data-access cache |
| Navigation | Civil date, view, zone, visible calendars | Client UI state; route where useful |
| Editor draft | Fields, original version, dirty state, operation ID | One editor instance until resolved |
| Day segment | Event ID, clipped interval, lane, label | Derived from entities and view scope |

A timed event and an all-day event should be distinguishable without guessing from
midnight timestamps. Display color can fall back to the calendar color, but the API
should preserve whether a color is inherited or explicitly overridden. Otherwise
moving an event between calendars can accidentally freeze an old color.

| Proposed interface | Input / action | Result |
|--------------------|----------------|--------|
| Load calendars | Current authenticated account | Calendars and capabilities |
| Load events | Calendar set, exclusive range, zone, continuation | Events, revision, completion/next page |
| Create event | Frozen temporal fields and operation ID | Canonical event and advisory result |
| Edit/delete event | Event ID, expected version, operation ID | Canonical result or recoverable version conflict |
| Resolve operation | Previous operation ID | Committed result or an explicit unresolved/expired state |

Inside the browser, a view receives day segments, selected date, and loading state,
and emits “select event” or “create at this slot.” The editor receives an initial
event or slot and emits a submitted draft. Those component contracts matter as much as
the HTTP paths in a frontend interview.

The server validates actual request bytes and authorizes calendar IDs. The client
validates early for helpful errors but cannot grant itself permission. Response errors
should preserve useful structure, such as the current event on a version conflict,
rather than collapsing everything to a generic string.

## 🔧 Deep dive 1: turn time into a readable calendar — 8 minutes

### Preserve dates and instants

A 09:00 meeting created in Los Angeles has a particular instant. A New York viewer
sees that same meeting at a different local time. An all-day birthday, by contrast,
should not move to the previous date just because someone changes display zones.

I would use explicit instants for timed events and separate date ranges for all-day
events. The editor shows a named zone and resolves wall-clock input deliberately
before saving. If a selected local time is missing or occurs twice during a
daylight-saving change, the UI must explain the choice rather than silently using
whichever interpretation a runtime happens to choose.

The interval end is exclusive. A meeting ending at midnight belongs to the preceding
day and does not leave a phantom block on the next one. A one-day all-day event has
the following date as its end boundary. This also makes adjacent events naturally
non-overlapping.

### Build the month and time views

For month view, generate whole weeks around the month in the chosen locale's week
convention. That can be four, five, or six rows. I would either render the actual row
count or intentionally normalize both the date list and layout to six rows; mixing a
variable list with fixed assumptions invites gaps.

Show a bounded number of event pills per date and a “more” control opening a day
agenda. The control must reveal every event, not merely tell the user that something
was omitted. All-day events have a distinct treatment, while title truncation can open
accessible event details.

For day/week views, split multi-day timed events at the visible civil-day boundaries
and clip each piece. A meeting from 23:00 yesterday to 01:00 today occupies one hour
in today's column. Using the entire original duration after clipping only the top
would draw two hours and misrepresent availability.

The layout then maps those clipped instants to the displayed time scale. On normal
days a wall-clock scale is straightforward. On transition days, I would show the
missing/repeated interval explicitly, including offsets for repeated times, or offer
an agenda where the ordering is unambiguous. Fixed elapsed-minute arithmetic against
ordinary 24-hour labels is not a complete solution.

### Give overlapping events separate lanes

Sort a day's segments by start, then by end and a stable event ID. Scan them in order,
reusing a lane when its previous event has ended. Because ends are exclusive, a
meeting starting at 10:00 can reuse the lane of one ending at 10:00.

Track connected overlap groups and their maximum simultaneous lane count. Within each
group, divide available width by that count. An event connected through a chain of
overlaps belongs to the same group even if it does not directly intersect every other
member. A simple first release can use equal-width lanes without trying to maximize
every empty horizontal gap.

The sorting cost is roughly proportional to the number of visible segments times its
logarithm. More importantly, the algorithm is run on the displayed range and memoized
against relevant event/time-zone changes. Pointer hover should not regroup the entire
month.

A minimum hit height improves usability for five-minute meetings, but it is a visual
affordance rather than a change in duration. Preserve exact time labels and keyboard
access. If dozens of events overlap, a grouped “more” entry and agenda is more useful
than dozens of one-pixel columns.

| Approach | Why it helps | Cost |
|----------|--------------|------|
| ✅ Civil-day segments, lanes, and agenda overflow | Events remain discoverable with honest boundaries | More layout and time-zone test cases |
| ❌ One full-width block per event | Easy to position | Overlaps cover one another and overnight clipping is fragile |
| ❌ Custom canvas for the whole UI | Can reduce DOM work at extreme density | Manual semantics, focus, text layout, and hit testing |

> “I choose DOM-based views with derived geometry because the normal calendar is modest in size and interaction semantics matter. I pay for a careful layout model, but I can reuse native focus and accessible controls.”

## 🔧 Deep dive 2: fast navigation without stale or missing events — 7 minutes

### Cache the meaning of a request

A single global events array is attractive at first: fetch a range, replace the array,
render. It fails when requests overlap. If April responds after May, the May heading
can sit over April's events. It also makes it difficult to distinguish an empty range
from one we have never loaded.

I would key range entries by account, calendar set, start/end boundaries, and any
zone-dependent interpretation. Each entry has separate loading, success, error, and
completeness state. The view selects its own entry; changing the selected date does
not rewrite the identity of an outstanding request.

Cancel obsolete work to save resources, but also guard completion by request and
account generation. Cancellation is not a guarantee that a response handler cannot
run. On logout, clear private entries, close editors, and retire the current
generation before another account can render cached content.

Visibility is a client display preference when all permitted calendars are already
loaded. Toggling Work off should be immediate and should not change the server's
conflict policy. If the product supports thousands of calendars, fetching only
selected ones may become necessary, but then the cache key and loading behavior must
reflect that selection.

### Avoid trading correctness for an instant-looking screen

A cached range can render immediately while it refreshes, with clear freshness status
when it matters. An uncached range shows a loading state. On failure, retain the last
known data for that same range and offer retry; do not display unrelated previous-week
events as if they are current.

Dense responses need pagination or a narrower agenda query. The client marks a range
incomplete until all relevant pages arrive. If a server revision changes during
paging, restart according to the server contract instead of stitching together
snapshots that may omit moved events.

I would allow only a bounded restart and then narrow the request or report that the
calendar is changing. A retry loop that restarts forever during active editing is not
a usable consistency policy. The important UI promise is that partial data is visibly
partial.

Keep a small least-recently-used set of ranges and prefetch the immediately adjacent
period after the visible request succeeds. Aggressive year-wide prefetch can consume
bandwidth for dates the user never opens and can bury the useful request behind
speculative work.

### Keep edits coherent across views

An event moving from Friday to Monday affects both the old and new ranges. Update its
normalized entity from the canonical response, remove stale memberships, and
invalidate intersecting range entries. A delete removes the entity and its
memberships. Read responses older than an acknowledged mutation must not resurrect the
previous event version.

The mutation's returned owner revision provides a freshness floor for subsequent
reads. The server must honor it through a current data source; a client cannot
manufacture read-after-write consistency if every response is allowed to come from an
arbitrarily lagging replica.

| Approach | Benefit | Limitation |
|----------|---------|------------|
| ✅ Bounded range cache with identity and versions | Fast revisits without confusing scope | Membership invalidation and explicit completeness |
| ❌ Replace one events array on every response | Very little state to manage | Late responses can display the wrong range |
| ❌ Download the entire calendar history | Simple local navigation after loading | Unbounded startup, memory, and staleness |

> “I’m willing to store a little more request metadata to keep the date heading and its events consistent. That is a more valuable optimization than making every navigation appear instant by showing whatever data happened to arrive last.”

## 🔧 Deep dive 3: save safely and keep warnings visible — 8 minutes

### Give the editor a real lifecycle

The editor starts with either the clicked slot or a canonical event. A 15:00 slot
should initialize a 15:00 start. It records the base event version and keeps local
fields separate from shared event data. Changing the calendar list in the background
should not reset text the user is typing.

On Save, validate the draft, freeze the submitted revision, and assign an operation
ID. Show pending status and prevent a second submission of the same intent. I would
initially disable edits while that save is pending, with explicit recovery if the
request fails, because it is simpler than maintaining multiple simultaneous editor
revisions.

Closing the editor must have a defined meaning. Either keep it open while resolving
the save or move the pending result into a persistent activity area. An old save
callback must be scoped to its editor instance so it cannot close a newly opened
event.

I would choose acknowledged saves for the first release. The event enters the
canonical model after the server commits, while the editor immediately shows “Saving.”
This gives fast feedback without pretending a new event is already durable.
Drag-and-drop can later add a pending visual overlay with the same operation protocol.

### Separate overlap warnings from edit conflicts

A scheduling overlap means two events intersect in time; it is usually allowed. An
edit-version conflict means another editor changed the same event since we loaded it;
overwriting that change requires a decision. These should have different language and
recovery controls.

If the API saves successfully and reports overlaps, keep “Saved — overlaps with two
events” visible in the event details or a persistent notification after the modal
closes. Putting that message only inside a modal that immediately unmounts loses the
information the API just computed.

For live preview, debounce a dedicated preview request and bind its result to the
current draft revision. A warning for yesterday's draft cannot describe today's input.
The final save still returns its own advisory result, and a preview of “no overlaps”
is never an exclusive reservation.

If the warning query is unavailable, say the event was saved and warnings could not be
checked. If the save itself failed validation, retain the draft and show the field
problem. Keeping those outcomes separate is important because the user's next action
differs.

### Recover from uncertainty and another editor

A timeout after Save has an unknown outcome. The server may already have committed.
Retry or resolve the same operation ID, rather than creating a new ID and potentially
inserting a duplicate event. The server's receipt retention period bounds this
guarantee; after it expires, reconcile before starting new intent.

On a version conflict, preserve the draft and show the current event alongside the
changed fields. Let the user reload, revise and resubmit against the new version, or
create a separate event. Do not silently overwrite either version or automatically
merge start and end fields from incompatible edits.

Delete has similar uncertainty and must be identified. Once deletion is acknowledged,
a stale range response cannot bring the event back. If the user is no longer
authorized, clear the private event and explain that access changed instead of
continuing to show the old editor indefinitely.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Acknowledged save with immediate pending feedback | Clear durability and straightforward recovery | Visible server round trip before the event settles |
| ❌ Close immediately and assume success | Minimal apparent latency | Lost drafts, hidden errors, and ambiguous retries |
| ❌ Full offline optimistic editing immediately | Works through long disconnections | Durable queue, conflict policy, storage, and recovery scope |

> “For the first release, I optimize confidence in the result. Once that lifecycle is sound, a pending event overlay can improve perceived speed without changing what ‘saved’ means.”

## ♿ Accessibility, performance, and validation — 5 minutes

I would make the calendar operable without a pointer: arrow keys move the active date,
Enter opens its agenda or selected slot, and event buttons expose title, date, time,
and calendar. Use one active grid focus target with a documented navigation pattern
instead of requiring Tab through hundreds of empty cells.

The modal needs a label, focus entry and containment, Escape/close behavior, and focus
restoration to the invoking event or slot. Validation and save outcomes are announced
appropriately. Color distinguishes calendars visually, but the accessible name and
text identify them too.

On a narrow display, prioritize a readable day/agenda and a collapsible sidebar.
Scrolling time columns and their labels must remain aligned. A month grid can
summarize density without trying to display every event simultaneously.

I would profile grouping, component subscriptions, and layout on dense fixtures before
adding virtualization. A long agenda may benefit from virtualized rows; seven day
columns and a few dozen visible cells often do not. Selectors should avoid rerendering
every event for an unrelated editor keystroke.

| Scenario | What I would verify |
|----------|---------------------|
| Midnight and overnight events | Correct day membership and clipped duration |
| DST gaps and repeated times | Explicit interpretation and readable ordering |
| Rapid next/previous navigation | Heading, range identity, and returned events stay aligned |
| Save then lose the response | One operation resolves without a duplicate |
| Edit in two tabs | Draft survives a version conflict |
| Logout during a request | No previous-account result or editor appears |
| Dense and all-day calendar | Every event remains reachable by mouse and keyboard |

The local repository supplies the basic views, modal, API wrapper, and Zustand store.
It does not yet implement the complete temporal, layout, range-cache, or save-recovery
design described here. I would use that implementation to demonstrate the initial user
journey and these fixtures to guide the next improvements.
