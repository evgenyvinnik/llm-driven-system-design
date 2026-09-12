# 📅 Design a scheduling application: fullstack interview

> “I would follow one booking from the calendar to the database and back. The guest
> must see the intended local time, the server must reserve it once, and later changes
> must reach the UI and notification system without losing the appointment's meaning.”

This is a proposed production design for a 45-minute whiteboard discussion. The local
React/Express project supplies the product example, while [Implementation
Notes](./architecture.md#implementation-notes) document what is actually implemented
and where it falls short.

| Time | Discussion |
|------|------------|
| 5 minutes | Scope, guarantees, and sizing |
| 5 minutes | Architecture and shared contracts |
| 9 minutes | Deep dive: one booking across client and server |
| 8 minutes | Deep dive: calendar dates and availability |
| 8 minutes | Deep dive: changes, reminders, and notifications |
| 6 minutes | Host workflows, failure handling, and growth |
| 4 minutes | Verification and implementation boundary |

## 🎯 Scope, guarantees, and sizing — 5 minutes

I would build one-to-one scheduling. Hosts define weekly working hours and event types
with a duration, buffers, and optional daily cap. Guests open a public link, choose a
timezone and slot, enter contact details, and reserve without creating an account.

Hosts need an authenticated dashboard for upcoming meetings, event types, and
availability. Guests need a scoped way to return to a booking and cancel or
reschedule. Group capacity, team assignment, payments, and recurring appointment
series can wait.

The main guarantee is that two active reservations managed by this service do not
overlap the same host's occupied interval. Occupied time includes the booking's
accepted prep and recovery buffers. The displayed meeting duration remains separate
from that extra host time.

I would also require recoverable outcomes. If a request commits but its response
disappears, the guest must be able to retrieve that result without creating a second
booking. A timeout is a state to resolve, not proof that the reservation failed.

External-calendar integration is a separate proposed extension. A provider can accept
an event independently while our transaction is running. I would expose
synchronization freshness and reconciliation behavior rather than promise global
conflict freedom without a shared reservation protocol.

For a capacity discussion, assume one million hosts and three bookings each per week.
That is about 430,000 bookings per day, or five per second on average. At a tenfold
peak, we plan around 50 booking writes per second.

If guests make 100 availability requests per booking, reads reach about 43 million per
day and 5,000 per second at the assumed peak. The workload is read-heavy overall, but
one popular host can still have intense write contention.

I would target availability p95 below 200 ms and booking p99 below 500 ms, with 99.9%
booking availability. Those are planning targets to validate. The confirmation screen
should appear after durable acceptance; email delivery has a separate delay objective.

## 🏗️ Architecture and shared contracts — 5 minutes

I would draw the complete flow without splitting every function into a microservice:

```
┌────────────────┐       ┌────────────────┐
│ Guest calendar │──────▶│ Scheduling API │
│ Host dashboard │◀──────│ Auth + policy  │
└────────────────┘       └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Booking store  │
                         │ Receipt/outbox │
                         └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Jobs / workers │──────▶ Providers
                         └────────────────┘
```

A cache accelerates availability calculations, and a CDN serves static assets. Neither
decides whether a booking commits. PostgreSQL owns reservation state, operation
receipts, and notification intent.

The frontend separates local drafts from server state. Components own input fields,
focus, and the current step. A query layer owns event metadata, availability ranges,
and booking details. Shared state holds the resolved session and a minimal reference
to any submitted operation being recovered.

| Concept | Browser representation | Authoritative record |
|---------|------------------------|----------------------|
| Working hours | Host-local weekly editor | Rules with IANA zone and revision |
| Candidate slot | Start/end instants plus display labels | Derived availability with covered range |
| Booking attempt | Frozen input and operation identity | Scoped receipt and input digest |
| Confirmed meeting | Returned booking snapshot | Interval, occupied range, status, revision |
| Booking change | Pending action against a known revision | Atomic transition and history |
| Notification | Pending/delivered/failed indicator | Per-recipient delivery progress |

The API contract must expose these distinctions. A booking response contains the
accepted start, end, host, type, revision, and management reference. The browser does
not manufacture confirmation from whatever happens to remain in the form.

Availability responses state their covered instant range and policy or availability
revision. The browser can then tell whether a timezone change needs additional data. A
date string alone does not identify the same global interval in every zone.

Public booking access and host account access are separate. A guest capability is
scoped to one booking and permitted actions. Public identifiers must not double as
unrestricted access to attendee notes and email addresses.

I would begin with HTTP and bounded refetching. Push updates can improve freshness
later, but they do not remove the need for transactional acceptance or recovery after
missed messages.

## 🔧 Deep dive: one booking across client and server — 9 minutes

I would walk through a guest selecting Tuesday at 10:00. The calendar holds the
server-supplied instant, while its label is formatted in the guest's chosen zone. The
person enters contact details and submits.

At submission, the client freezes the meaningful input and creates an operation
identity. Repeated transport attempts use that same identity. Choosing another slot
after a known conflict is a new intention and gets a new identity.

The server validates the request and binds the operation identity to normalized input
and authorized recovery scope. If that operation already completed, it returns the
recorded result. The cache may accelerate the lookup, but a durable receipt remains
available after cache eviction.

For a new operation, a short transaction acquires the host's stable lock and reads
current policy. It checks active event type, working hours, booking horizon, occupied
interval, and the relevant host-local daily count.

Locking the host matters because the row exists even when the schedule is empty.
Locking only overlapping booking rows would leave two requests free to see no matching
rows and both insert. All writers that change occupancy or relevant policy must
coordinate through the same authority.

The transaction writes the booking, accepted policy snapshot, receipt, history, and
outbox event together. It commits before returning success. Slow email or
calendar-provider calls happen later so they do not hold the host lock.

I would add an active occupied-range exclusion constraint as a database backstop.
PostgreSQL can enforce nonoverlapping ranges; uniqueness on host and start time alone
cannot reject two different starts whose intervals overlap. [PostgreSQL range
constraints](https://www.postgresql.org/docs/current/rangetypes.html#RANGETYPES-CONSTRAINT).

The range constraint does not enforce every product rule. Daily caps and working-hour
eligibility still require current coordinated reads. Likewise, a Redis lock may reduce
duplicate effort but should not become a competing reservation authority.

Suppose two guests submit the same slot. One commits; the other receives a conflict
after revalidation. The losing browser keeps the contact draft, refreshes the relevant
choices, and lets the guest choose another time.

Suppose instead the database commits and the response is lost. The browser enters an
unknown-outcome state and resolves the existing operation. It does not announce
failure and immediately submit a fresh request with a new identity.

| Outcome | Frontend action | Backend guarantee |
|---------|-----------------|-------------------|
| Confirmed | Render the returned booking | Reservation and receipt committed |
| Conflict | Retain contact draft; refresh slots | This attempt did not reserve the choice |
| Validation error | Explain the rejected field or policy | No accepted reservation for this attempt |
| Unknown after timeout | Recover the same operation | Durable result can be found within the supported window |
| Notification delayed | Keep booking confirmed | Delivery progress is separate from reservation state |

A stable operation identity is not just a disabled button. It covers retries after
refresh or navigation as well as repeated clicks. The browser can retain a minimal
recovery reference without storing all attendee notes in persistent state.

A receipt also survives lifecycle changes. If the guest cancels later, retrying the
original creation request should identify the original booking, not recreate it or
return a misleading freshly confirmed object. The current booking state is a separate
read.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Short host transaction plus durable recovery | Clear winner and recoverable guest outcome | Per-host contention and receipt storage |
| ❌ Optimistic confirmation before acceptance | Immediate success animation | Can tell two guests they own the same time |
| ❌ Response cache as the only receipt | Fast short-term replay | Loses recovery when the cache expires or fails |

For ordinary hosts, serializing a few writes is an acceptable cost. For a release of
highly contested office hours, I would bound lock waits and admit requests per host. I
would not introduce temporary holds for every browsing guest before showing that the
short booking form actually needs them.

## 🔧 Deep dive: calendar dates and availability — 8 minutes

I would put a host-local workday and a guest-local day on the whiteboard, then map
both to the timeline. That small example explains why the frontend and backend need
more than a date label.

The host's rule might be Monday 09:00–17:00 in Los Angeles. The guest may view Tokyo
time. Some of those meeting instants appear on Tuesday for the guest, so one guest day
can intersect portions of different host dates.

The browser defines the requested range using midnight and the next midnight in the
selected zone. It should not use browser-local midnight after the person chooses
another zone, or assume that every local day lasts exactly 24 hours.

The server expands weekly rules for every relevant host date, resolves them to
instants, and subtracts existing occupied intervals. It queries by overlap, including
bookings that began before the requested date and buffers that cross a boundary.

Busy intervals are clipped to each working window before gaps are computed. Without
clipping, a busy interval later in the day can accidentally make the preceding gap
extend past the host's working hours. Split working windows must also remain separate
rather than silently forming one continuous day.

Each existing booking keeps its own accepted buffer policy. Applying the newly
requested event type's buffers to every old meeting produces different answers
depending on which public page is queried. Creation and availability must evaluate the
same occupied-time rule.

Weekly local rules and confirmed instants have different persistence needs. Recurring
hours should preserve the host's intended local time across offset changes. A
confirmed meeting needs one unambiguous instant, plus enough original zone and policy
context to explain it later.

I would define how the product handles clock changes. Nonexistent local times are not
offered. Repeated local times can be offered as distinct instants with an offset in
their labels. A library's silent conversion choice is not a substitute for that
policy.

The server and browser need maintained timezone data because civil-time rules can
change. [IANA timezone database](https://www.iana.org/time-zones). I would test the
specific runtime helpers in use rather than assume every valid-looking date string has
been interpreted as intended.

When the guest switches timezone, the client can immediately reformat already loaded
instants. It must also check whether those instants cover the newly visible date. If
coverage is incomplete, it requests the missing range before declaring the date fully
booked.

The product should choose whether a zone change preserves the selected instant or
clears it. Either can work if the date highlight and step transition are explicit.
Clearing the slot while leaving the person on a details form whose submit action does
nothing is not a usable policy.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Server-derived instants with explicit coverage | Shared policy and flexible display zones | More careful date/range contract |
| ❌ Client rebuilds slots from text times | Quick initial UI | Duplicates rules and loses ambiguous-time meaning |
| ❌ Fixed UTC weekly hours | Simple recurrence arithmetic | Can move the host's intended local workday |

Availability remains derived and potentially stale. A booking must invalidate every
event type sharing the host, not just the page used to create it. Host-wide revisions
help prevent late old computations from becoming the current cache value after an
edit.

The frontend also guards request identity. If a slow response for event type A arrives
after navigation to B, it is discarded. Date, timezone, and range changes each create
a new query context; cancellation helps efficiency, while identity checks protect
correctness.

A daily cap limits reservations, not alternatives. If one booking remains under the
cap, the guest should still see every eligible time at which it could be used. The
transaction arbitrates whichever alternative is finally submitted.

## 🔧 Deep dive: changes, reminders, and notifications — 8 minutes

Rescheduling starts from a known booking revision. The UI keeps the existing confirmed
time visible while the guest selects a replacement. It submits the new instant and
expected revision through an authorized management operation.

The transaction acquires the same host authority as creation, checks the new interval
while excluding the booking itself, and updates the interval atomically. If the move
fails, the original reservation remains intact.

The booking stays active after a successful move. “Rescheduled” is recorded as
history, while the active booking revision identifies the current time. Otherwise
confirmed-only queries can accidentally treat the moved meeting as free capacity.

The response supplies the complete new booking, so the UI updates time, host details,
status, and revision together. A partial mutation result should not erase fields that
were present in the prior detail view.

Cancellation follows a similar identified operation. Repeating a known successful
cancellation recovers its result. A stale action against a meeting changed in another
tab should return current state and let the person decide whether their intention
still applies.

Every accepted change writes an outbox event in the same transaction. The relay can
retry after a crash between commit and publication. A message queue alone cannot close
that gap when publication happens only as an unrecorded post-response task.

Delivery records distinguish host and guest recipients, notification kind, and booking
revision. If the host notification succeeds but the guest notification fails, retry
only the work that remains or use a provider-supported stable delivery identity.

I would not claim exactly-once physical email from a unique database key. A provider
may accept a message and lose its response. Without compatible provider recovery, a
retry can duplicate delivery; the system should record that uncertainty.

Reminders are scheduled jobs for a particular booking revision. A reschedule replaces
the due work, and cancellation makes pending reminders obsolete. A worker verifies
current status and revision before sending rather than trusting an old payload's start
time.

For the initial design, an indexed due-job table is easy to inspect and update.
Multiple schedulers claim bounded batches with recoverable leases, then dispatch work
to delivery workers. The polling interval contributes a measurable amount of lateness.

A queue for every distinct millisecond delay is useful as a teaching example but
awkward for many bookings and repeated moves. In-process timers are simpler still, but
process restarts lose their pending work unless another durable record can reconstruct
it.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Outbox plus revision-aware durable jobs | Recover publication and supersede old reminders | More persistent state and worker recovery logic |
| ❌ Send email inside the booking transaction | Simple sequencing | Provider delays hold locks and impair booking |
| ❌ Best-effort task after commit | Fast booking response | A crash can lose the only notification intent |

Revision checks reduce stale sends but cannot retract a message already accepted by a
provider. If cancellation races with an in-flight confirmation, a later change
notification establishes the current state. The product must not promise that an
earlier email can never arrive afterward.

The confirmation screen should therefore say what the booking service knows: reserved
time and current delivery status. It can offer the management link immediately. The
guest should not have to create another meeting merely to retry an email.

A future calendar integration uses the same durable effects model, with
provider-specific recovery and a visible synchronization state. It still cannot
atomically control an event created directly in another provider, so fresh local
projections and conflict reconciliation remain necessary.

## 🛠️ Host workflows, failure handling, and growth — 6 minutes

The host editor must preserve the policy it loads. If Monday contains a morning and
afternoon interval, changing Tuesday must not collapse Monday to one interval. The
label beside the editor shows the stored host zone rather than whichever zone the
browser happens to use.

Policy edits carry an expected revision. A second tab that submits an old copy should
receive a conflict and retain its local draft. Changing a type's duration or buffers
should affect future candidate policy without silently rewriting accepted bookings'
occupied intervals.

Disabling an event type stops new bookings but preserves existing history. Deletion
needs deliberate lifecycle semantics so that removing a card does not unexpectedly
cascade through past appointments and notification evidence.

Private routes wait for a resolved session before fetching account data. Logout or
account switching clears account-scoped queries and prevents late old responses from
entering the new context. Guest pages can operate without waiting for that private
dashboard session.

Loading, empty, and failed states remain distinct. I would give calendar controls
keyboard navigation and clear selection labels, announce conflicts, and preserve form
input on recoverable failures. Large host agendas need bounded API pagination before
the UI needs virtualization.

If Redis is unavailable, bounded availability calculations may fall back to PostgreSQL
with admission limits. If the database is unavailable, the service cannot accept a
reservation based on a cached free slot. If a provider is unavailable, committed
outbox work remains pending.

I would measure time to usable choices, booking transaction latency, host lock wait,
conflict rate, operation recovery success, outbox age, and reminder lateness.
Page-load success and an open broker connection do not establish those outcomes.

At higher scale, stateless APIs and cached bounded ranges handle read growth.
Host-based partitioning keeps reservation conflicts and daily limits together if the
database later needs sharding. A hot individual host still needs admission control
within its partition.

Retention should move an exact verified cohort, with copy and deletion tied to the
same rows. Broad copy/delete predicates can diverge as bookings change concurrently.
Booking history, operation receipts, attendee data, and delivery logs also have
different retention purposes.

## 🧪 Verification and implementation boundary — 4 minutes

I would first test the user promise end to end: choose a time, submit, lose the
response after commit, refresh, and recover exactly that appointment. The confirmation
must use returned data even if the old form draft changes during the request.

Next, two guests request overlapping times with different starts, including different
event types for the same host. Only one compatible occupancy set should commit. A
daily-cap race and a reschedule into an occupied interval test rules that a simple
unique-start check cannot cover.

Timezone tests cross host, browser, and guest zones. They include an overnight
booking, a busy interval outside a working window, split hours, a spring gap, and a
repeated autumn hour. The test verifies both the offered label and the committed
instant.

Recovery tests interrupt the outbox relay, reconnect a worker, fail only one
recipient, cancel while a confirmation is pending, and move a meeting while old
reminders exist. Assertions cover stored revisions and visible status, not just
whether a page rendered.

The local project has real host locking during creation and joined-row locking during
reschedule/cancel. It nevertheless sets moved bookings to a status ignored by
confirmed-only conflict and reminder paths. Its cache-backed replay does not supply a
durable operation-recovery contract.

The UI has no rescheduling screen and derives confirmation from the draft. The worker
simulates email through SQL/console records, while both direct and queued notification
paths run. External-calendar integration and the proposed outbox/jobs are absent.
Those boundaries make clear which parts are demonstrated and which would be the next
engineering work.
