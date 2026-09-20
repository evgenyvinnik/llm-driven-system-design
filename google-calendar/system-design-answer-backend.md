# Google Calendar — backend system design interview

A proposed private-calendar service for a 45-minute interview. This answer explains
architectural choices rather than claiming that the local demo already provides them.
The implemented routes, schema, and limitations are documented in
[architecture.md](./architecture.md).

## 🎯 Requirements and scale — 4 minutes

> “I’ll design the service behind several private calendars per user. It must return the right events for a date window and save edits reliably. Overlap warnings are useful, but personal calendars are allowed to contain competing commitments.”

I would confirm that the core is account/session authentication, calendar management,
timed and all-day event CRUD, range reads, and advisory overlap detection. Month,
week, and day views are different consumers of the same temporal contract. A hidden
calendar can still contribute to warnings because visibility is not an availability
rule.

Sharing, invitations, reminders, external calendar import, recurring series, and
exclusive room booking are out of the initial scope. If recurrence is essential, I
would replace one deep dive with expansion and exceptions rather than pretending a
recurrence string finishes that feature.

Assume 10 million users with 200 stored events each, or 2 billion events. At an
assumed 1 KB of event payload each, that is about 2 TB before indexes, replication,
and backups. These are interview inputs, not measurements of Google or the repository.

If 1 million daily active users make 30 range reads and two mutations daily, the
averages are about 347 reads/s and 23 writes/s. A tenfold peak gives roughly 3,470
reads/s and 230 writes/s. I would also test concentrated Monday-morning traffic and
accounts with unusually large histories.

Our proposed regional targets are 99.9% availability, p95 range reads under 200 ms,
and ordinary writes under 300 ms under admitted load. A successful write means the
event and its retry result are durably committed. A recent writer must not immediately
read an older version of the same calendar.

The key consistency distinction is between lost edits and scheduling overlaps. We
prevent silent overwriting of stale event versions, while allowing two separate events
to occupy the same time. Those are different invariants and require different
mechanisms.

## 🏗️ High-level architecture — 7 minutes

I would draw the request path and storage boundary first. The service boxes represent
responsibilities, not a requirement to deploy a separate microservice for every route.
Start with one Calendar service replicated behind an authenticated gateway, then split
workloads when measurements justify it.

```
┌────────────────────────┐ HTTP   ┌────────────────────────┐      ┌────────────────────────┐
│ Browser / clients      │        │ API gateway            │      │ Session store          │
│ Date range or command  │◀──────▶│ Auth + request limits  │◀────▶│ Shared, revocable      │
└────────────────────────┘        └────────────────────────┘      └────────────────────────┘
                                              ▲
                                              │
                                              │  authorized request / result
                                              │
                                              ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Calendar service (replicated, logically separate query and command paths)                │
│ Range queries | event commands | advisory overlap checks                                 │
│ Validate ownership, explicit time type, expected version, and operation ID               │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                                   ▲                                     ▲
                                                   │                                     │
  canonical reads / atomic writes                  │           optional range cache      │
                                                   │                                     │
                                                   ▼                                     ▼
┌──────────────────────────────────────────────────────┐       ┌───────────────────────────┐
│ PostgreSQL primary / owner partition                 │       │ Private range cache       │
│ Users, calendars, events, range indexes              │       │ Owner + range + zone      │
│ Event versions + operation receipts + outbox         │       │ Snapshot revision + TTL   │
└──────────────────────────────────────────────────────┘       └───────────────────────────┘
                                                   ▲                          ▲
                                                   │                          │
  committed outbox records                         │                          │
                                                   │                          │
                                                   │       evict ranges       │
                                                   ▼                          │
┌──────────────────────────────────────────────────────┐                      │
│ Outbox worker (if caching is added)                  │◀─────────────────────┘
│ Retry invalidation; confirm progress after effect    │
└──────────────────────────────────────────────────────┘
```

The gateway validates the session, limits abusive requests, and routes the owner to
the right service/database partition. The Calendar service authorizes requested
calendars, validates temporal fields, and executes either a range query or a mutation.
The database is authoritative for event data and mutation outcomes.

The session store is shared across API instances so a request does not depend on
returning to the same process. PostgreSQL is a reasonable initial store. A dedicated
Valkey deployment becomes an option if measured session load competes with event
queries; I would not introduce it merely because we crossed an arbitrary user count.

### Follow one range read

The client requests a bounded interval with explicit time semantics. The service
verifies ownership, obtains a consistent range page and revision, and returns
canonical events with a continuation if needed. The browser uses that revision to
avoid mixing unrelated pages or regressing behind an acknowledged edit.

A private range cache is optional. It sits behind authorization, carries its source
revision, and can be bypassed when it is too old for the caller. It is not the source
used to decide whether a stale edit should be accepted.

### Follow one save

The client sends an operation ID, the intended fields, and an expected version for an
edit. The service commits the event, retained operation result, and owner change
revision in one transaction. If cache invalidation or another downstream effect is
needed, it also commits an outbox record.

The response carries the canonical event and advisory overlap status. The database
commit is the save boundary; a worker or cache does not have to be available for the
event to be durable. Outbox processing retries independently and invalidates both old
and new ranges when an event moves.

The return arrow from the cache confirms the invalidation effect; only then does the
worker advance durable progress. A crash can repeat eviction harmlessly. A lost save
response instead resolves the original operation receipt, so optional cache recovery
cannot create another event or turn a committed edit into an ordinary save failure.

The lower cache/worker branch is a scaling extension, not mandatory startup
infrastructure. The first release can read directly from PostgreSQL with a small
browser cache. That keeps the important correctness path short while leaving an
explicit place for later optimizations.

## 💾 Data model and API contracts — 5 minutes

| Entity | Key data | Invariant / access pattern |
|--------|----------|----------------------------|
| User | ID, account identity, default display zone | Authentication and owner routing |
| Calendar | ID, owner, name, color | List by owner; every event belongs to an authorized calendar |
| Timed event | ID, calendar, start/end instants, authored zone, version | Positive duration; overlap reads |
| All-day event | ID, calendar, start date, exclusive end date, version | Positive civil-date range |
| Owner revision | Owner, monotonically advancing revision | Range freshness and continuation validation |
| Operation receipt | Owner, operation ID, fingerprint, outcome, retention | Deduplicate identified retries |
| Outbox record | Owner revision, event ID, old/new interval | Recoverable downstream invalidation |
| Session | Opaque ID, user, expiry | Shared authentication and revocation |

I would use relational storage because the core work joins ownership with events and
atomically changes a small set of related records. PostgreSQL provides constraints and
useful range access paths. A wide-column store can serve carefully designed time
partitions, but cross-boundary and long-duration events require extra projections and
duplication; it is not inherently incapable of time queries.

If events carry a denormalized owner ID for partitioning, enforce consistency with
their calendar's owner. Otherwise an apparently convenient partition key can create a
privacy bug when the event and calendar disagree. Changing the owner or sharing a
calendar would need a separate migration/authorization design.

| Proposed method / path | Contract |
|------------------------|----------|
| GET `/api/v1/calendars` | Return authorized calendars and capabilities |
| POST `/api/v1/calendars` | Create a private calendar with an identified operation |
| PATCH / DELETE `/api/v1/calendars/:id` | Rename/recolor or delete an owned non-primary calendar; identify the mutation |
| GET `/api/v1/events` | Calendar set, exclusive range, display zone, optional continuation/minimum revision |
| POST `/api/v1/events` | Create a typed timed/all-day event with operation ID |
| PATCH `/api/v1/events/:id` | Expected version plus intentional field changes |
| DELETE `/api/v1/events/:id` | Expected version and identified delete |
| GET `/api/v1/operations/:id` | Resolve an uncertain prior mutation |
| POST `/api/v1/conflicts/preview` | Optional unsaved draft preview; advisory snapshot only |

Responses use stable event identity, canonical temporal values, effective display
metadata, and a version. A save also returns its operation result and owner revision.
An overlap warning is distinct from a stale-version error and from a failed
validation.

I would define missing fields as unchanged, explicit null as clearing a nullable
field, and empty text according to the field's validation rule. This avoids a common
partial-update bug where the UI clears a description but the database quietly retains
it. Runtime validation remains necessary even if client and server share type
definitions.

## 🔧 Deep dive 1: model time and overlap correctly — 8 minutes

### Separate the things users mean by “an event”

A timed meeting is an interval of instants. Its authored zone helps the editor
reconstruct local intent, but the stored interval remains the same when another user
changes display zones. An all-day vacation is a range of calendar dates and should not
shift into the previous day through a UTC conversion.

I would require explicit offsets or resolved instants for timed writes, preserve the
named authored zone separately, and store all-day dates separately. Reject ambiguous
timezone-less timed input at the API boundary. Letting the Node process and database
each infer a zone can make the warning query examine one interval while the insert
stores another.

Use inclusive starts and exclusive ends throughout. An event from 09:00 to 10:00 does
not conflict with one beginning at 10:00. An all-day event for September 10 ends on
September 11. Using 23:59:59 creates a precision-dependent gap and an awkward contract
for adjacent days.

The date-window request also needs an exclusive boundary. A civil day in a named zone
is not always exactly 24 elapsed hours. The service should validate the supplied
interval against its stated interpretation rather than adding a fixed duration to
midnight for every date.

### Define what a warning means

Two positive-duration timed events overlap when each begins before the other ends.
This covers partial intersection and containment without a collection of special-case
queries. The service excludes the event being edited and searches the user's relevant
busy calendars, including hidden ones.

For the initial policy, treat all-day entries as informational and check timed events
consistently. A later explicit busy/free field is better than guessing that every
all-day holiday blocks every meeting. The policy should be symmetric between existing
events and the event being submitted.

The query returns a snapshot of possible conflicts. Another device can create an event
immediately afterwards. That is acceptable because the user is being informed, not
promised an exclusive slot. The response can report how many overlaps were found and
bound the returned details for a very busy interval.

The browser must keep the warning reachable after saving. A perfectly correct backend
calculation has no product value if the only banner disappears when the editor closes.
I would confirm that outcome with the frontend engineer while defining the response.

### Why not block every conflict?

Personal calendars contain tentative meetings, alternatives, travel holds, and
reminders. Rejecting all overlapping entries would force the user to delete useful
information before recording another commitment. It also turns an advisory feature
into a much more contentious serialization problem.

If the product requires exclusive room booking, the invariant changes. Two requests
can both observe a free interval before either inserts. An ordinary check-then-insert
sequence, even inside a transaction with the default isolation level, does not
automatically prevent that race.

For exclusive resources, I would use a suitable database non-overlap constraint scoped
to the resource, or another allocation mechanism that actually serializes competing
claims. The product then needs cancellation, temporary holds, and retry semantics.
That is a focused extension rather than a hidden promise of the personal-calendar API.

| Decision | Why it fits | Cost |
|----------|-------------|------|
| ✅ Typed temporal values and advisory conflicts | Preserve user intent and allow ordinary calendar behavior | Clear time-zone validation and warning semantics |
| ❌ Store timezone-less strings and infer later | Easy forms and inserts | Different processes can persist or compare different instants |
| ❌ Reject every personal overlap | Strong-looking rule | Prevents legitimate competing commitments |

> “I choose precise time types and a deliberately limited warning promise. The system should be strict about what time an event means and flexible about whether the user may record it.”

If recurrence becomes required, retain a local rule and named zone, expand only a
bounded window, and represent exceptions against stable occurrence identity. Repeating
a fixed UTC duration is not the same as repeating a local Monday morning meeting. I
would discuss those semantics before selecting an expansion library.

## 🔧 Deep dive 2: serve range queries without scanning history — 8 minutes

### Start with the actual access pattern

A range query asks for events that intersect the visible interval, not just events
whose start falls inside it. A week-long trip beginning before Monday must still
appear in Monday's calendar. An index or partitioning plan that considers only starts
inside the view can silently lose such events.

A B-tree beginning with calendar ID and start time is a sensible starting point for
ordinary histories. The overlap predicate also constrains end time, but two
inequalities do not magically turn every query into a tiny index lookup. Long-lived
events and large past histories can leave many candidates to examine.

I would compare that plan with a matching range expression and GiST overlap query on
realistic fixtures. The index must match the expression/operator used by the query.
Declaring an expression index while querying only scalar inequalities is not evidence
that the intended index is used.

Index the calendar-owner lookup as well. A foreign key enforces a relationship; it is
not a substitute for checking every needed access index. Explain actual candidate
counts and buffers from the query plan rather than quoting a fixed
milliseconds-per-database number.

### Bound results as well as the requested dates

A six-week request sounds small, but an imported calendar can contain thousands of
events in that period. Limit the allowed date window, response count, and total
payload. A first page budget of 500 events is a starting point for tests, with a
continuation and completeness flag.

Use stable ordering and an opaque cursor bound to the owner, filters, range, and
snapshot revision. Obtain the page and revision from one consistent database snapshot.
If the owner's revision changed before a continuation, reject that continuation and
ask the client to restart rather than mixing incompatible page boundaries.

This is deliberately simpler than maintaining a long-lived database snapshot across
arbitrary browser pauses. It costs restarts during changes. Bound them; a frequently
changing account can request a narrower day window or use a more advanced change-aware
protocol later.

Authorization applies to every requested calendar and every continuation. A cursor is
not permission. A client-supplied owner ID or a previously cached capability cannot
override current session identity.

### Add caching only where repeated work is expensive

Repeated visits to the same week may benefit from a private range cache. Key by owner,
calendar selection, range, and relevant zone interpretation. Each entry carries the
revision of the data it contains and expires after a bounded time. Do not reuse a
public CDN cache for private event responses.

Moving an event invalidates its old and new ranges. Deleting it invalidates the range
it previously occupied. The write transaction records those intervals in an outbox,
and a worker retries invalidation after commit. Directly writing the database and then
deleting a cache key leaves an unrecorded failure window if the process dies between
those steps.

Invalidation alone does not eliminate stale-fill races: a reader can finish populating
an old result after a worker deleted it. Keep the snapshot revision, apply the
writer's minimum-revision requirement, and treat the TTL as a bound for other stale
readers. Cache entries must not claim a newer revision than the data they actually
contain.

The writer can always bypass an insufficient cache entry and read the primary. Other
devices may see briefly stale data under the stated policy. If immediate cross-device
freshness becomes a requirement, add a verified change/revision protocol rather than
claiming that an asynchronous invalidation worker already supplies it.

### Scale the measured bottleneck

Add API instances with bounded pools, remembering that every instance contributes
database connections. Add replicas for reads that permit lag, or route a
minimum-revision read to a source that has caught up. A replica is not automatically
safe immediately after a save.

At larger storage scale, partition private calendars by owner so ordinary reads and
writes stay on one shard. A placement directory and controlled migration keep one
writer authoritative during movement. A shared organizational calendar may be a hot
partition and needs its own access and distribution design.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Bounded owner-scoped reads, then measured caching | Clear correctness path and controllable work | Query-plan analysis and explicit pagination |
| ❌ Return every event in the account | Simple endpoint | Growing database, network, and browser cost |
| ❌ Cache first and assume invalidation ensures freshness | Quick repeat reads | Stale fills, missed ranges, and read-after-write regressions |

> “My first scaling step is to make each request's work visible and bounded. A cache helps repeated work; it does not repair the wrong interval predicate or an unbounded response.”

## 🔧 Deep dive 3: make edits and retries reliable — 9 minutes

### Protect one event from stale writers

Two tabs load event version 7. Tab A moves it to 14:00 and saves version 8. Tab B
changes the location using version 7. An unconditional update can silently restore A's
old time if B sends the whole stale form.

Require the expected version in the mutation and enforce it in the actual database
update. Only one competing update from version 7 can succeed. Return the current
authorized event on a conflict so B can compare, preserve its draft, and intentionally
resubmit.

I would not hold a database transaction open while someone edits a form. An editing
lease is possible, but it adds expiry, takeover, and disconnected-client rules.
Conditional versions fit relatively short event edits and detect concurrency at the
point where persistence matters.

### Give a retry the same identity

A response can disappear after commit. Retrying an event create with a fresh request
identity can produce two identical meetings. Content-based deduplication is not
sufficient because users can intentionally create similar events; the identity must
describe this particular action.

Use an owner-scoped operation ID and a fingerprint of the immutable submitted payload.
In the transaction, claim a unique receipt, perform the conditional mutation, and
store the canonical outcome. Concurrent uses of the same ID converge on that retained
result rather than both inserting events.

If the same ID arrives with different content, reject it. If the same request is
retried after commit, return the original event/version result. The client can also
resolve an operation after a timeout without reinterpreting its input as a new edit.

Define how long receipts remain available. An operation older than that window cannot
safely be treated as a fresh create just because the server no longer remembers it.
The client should reconcile known event state or ask for a new deliberate action
according to the contract.

### Keep the commit and advisory boundaries separate

Within the transaction, event data, event version, owner revision, and operation
outcome move together. If a downstream cache or notification is introduced, the outbox
record commits alongside them. Workers consume that durable intent after commit and
can retry without controlling the success of the user's save.

Advisory overlap data is a snapshot and can change. It may be computed before the
mutation or obtained after commit, but an unavailable advisory must not turn an
already committed event into a normal failed-save result. Return “saved, warnings
unavailable” or leave warning refresh as a separate operation.

For a retained operation result, be explicit whether the advisory is the original
snapshot or a separate current refresh. Replaying the durable event result while
silently attaching differently timed warnings can confuse debugging and the user. The
event outcome itself remains stable.

Registration has the same transaction principle at a smaller scale: user creation and
the default calendar belong together. Otherwise a failed second insert leaves an
account that exists but has nowhere to put an event. Session establishment follows
successful account creation and needs its own error handling.

### Explain the cost and failure behavior

Conditional versions can cause user-visible conflicts. Receipts add storage and
cleanup, and an owner revision introduces a serialization point for that owner's
mutations. These are real costs, but ordinary private calendars are not edited
thousands of times per second by one owner.

If an account becomes an extreme write hotspot, reconsider the revision granularity or
use per-calendar change tracking with an appropriate multi-calendar read contract. Do
not remove concurrency checks merely to make the write path look simpler.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Conditional versions plus transactional receipts | Detect lost edits and resolve uncertain retries | Receipt lifecycle and conflict recovery |
| ❌ Last-write-wins plus blind retry | Very short implementation | Silent overwrites and duplicate creates |
| ❌ Keep a transaction open during editing | Can serialize a form session | Long-held resources and fragile disconnect behavior |

> “The version answers whether the edit is based on current data. The operation ID answers whether we already performed this exact action. I need both because concurrent editing and a lost response are different failure cases.”

## 🛡️ Failure handling, security, and validation — 4 minutes

The API derives the owner from a validated session and checks access on every read and
mutation. Use parameterized queries, bounded runtime validation, managed session
secrets, secure cookie/proxy settings, session rotation on login, and suitable
CSRF/origin checks. Calendar color and visibility are presentation, not permissions.

I would separate liveness from readiness. A constant health response says the process
can respond; it does not establish that event queries or session storage work. Track
database pool waits, range candidate counts, rejected validation, version conflicts,
uncertain responses, and advisory failures as different outcomes.

If PostgreSQL is unavailable, preserve the user's draft and return an explicit
failure. If the optional cache is down, fall back within database capacity and shed
excess work rather than creating an unlimited retry storm. Outbox backlog is visible
and recoverable; it does not erase an already committed event.

| Scenario | Evidence I would want |
|----------|------------------------|
| Two edits using one version | One commits; the other gets a recoverable conflict |
| Duplicate create operation | One event and one retained outcome |
| Response lost after commit | Retrying/resolving returns that outcome |
| Midnight, overnight, and DST cases | Queries return the intended intervals |
| Event moved across cached ranges | Old/new membership is invalidated; writer sees its revision |
| Dense history and long events | Bounded payload and acceptable examined-row cost |
| Unauthorized calendar ID | No private event or receipt is disclosed |

The local demo already has parameterized owner-scoped queries, positive-duration
constraints, cascading relationships, and PostgreSQL sessions. It does not yet have
the proposed conditional versions, operation receipts, bounded range protocol, or
cache/outbox path. That distinction keeps the interview design ambitious while the
repository documentation stays accurate.
