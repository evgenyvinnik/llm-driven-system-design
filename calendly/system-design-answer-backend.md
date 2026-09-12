# 📅 Design a scheduling service: backend interview

> “I would start with the invariant: two active meetings managed by this service
> cannot occupy overlapping time for the same host. Availability is a proposal; a
> transaction decides whether a reservation is accepted. Then I would explain how
> retries, rescheduling, and notifications preserve that decision.”

This is a proposed production design for a 45-minute discussion. The local
implementation demonstrates parts of it, with important gaps described in
[Implementation Notes](./architecture.md#implementation-notes). This is an independent
learning design, not Calendly's internal architecture.

| Time | Discussion |
|------|------------|
| 5 minutes | Requirements and capacity |
| 5 minutes | Architecture, records, and API |
| 9 minutes | Deep dive: reservation authority and retries |
| 8 minutes | Deep dive: time policy and availability |
| 9 minutes | Deep dive: notifications and booking revisions |
| 6 minutes | Failure handling and scaling |
| 3 minutes | Verification and implementation boundary |

## 🎯 Requirements and capacity — 5 minutes

I would scope the service to one-to-one meetings. Hosts configure recurring weekly
working hours, event duration, buffers, and optional daily limits. Guests choose a
time without an account, and both authorized hosts and guests can cancel or
reschedule.

I would separate a meeting's visible interval from its occupied interval. If the host
needs preparation and recovery, that time is unavailable too. The policy must say
whether adjacent meetings share a buffer or require both; I would choose per-booking
occupied intervals and preserve those accepted values.

A successful reschedule replaces the reservation atomically. If the proposed
replacement conflicts, the original meeting remains confirmed. Rescheduling is a
historical action, not an inactive status that makes the new meeting disappear from
occupancy queries.

Notifications are asynchronous effects of accepted changes. Booking availability
should not depend on an email provider being healthy. The user can recover the
committed outcome independently of whether a confirmation email has arrived.

External calendars require a separate agreement. This service can serialize its own
writes, but a person can create an event directly in a provider during our
transaction. Without a shared reservation protocol, I would promise freshness bounds
and conflict reconciliation rather than absolute cross-provider exclusion.

For sizing, suppose we have one million active hosts and three bookings per host per
week. That is about 430,000 bookings a day, or five per second on average. A tenfold
peak gives approximately 50 booking requests per second before retries.

At 100 availability lookups per booking, the service handles about 43 million reads a
day, averaging 500 per second and peaking near 5,000. These are assumptions to size
the design, not measurements of the local app.

If a booking and its retained metadata occupy 10 KB, that is about 1.6 TB per year
before replication and index overhead. The more immediate concern may still be one
popular host whose newly published hours attract hundreds of simultaneous attempts.

My initial targets would be availability p95 below 200 ms, booking p99 below 500 ms,
and 99.9% booking availability. I would define what each timer includes and measure
contention separately; no database choice by itself establishes those targets.

## 🏗️ Architecture, records, and API — 5 minutes

I would keep the whiteboard to a few logical responsibilities:

```
┌────────────────┐       ┌────────────────┐
│ Guest / host   │──────▶│ Scheduling API │
└────────────────┘       └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ PostgreSQL     │
                         │ Rules/bookings │
                         │ Receipt/outbox │
                         └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Jobs + workers │──────▶ Providers
                         └────────────────┘
```

The API owns authentication, validation, and transaction orchestration. Availability
calculation can scale separately from booking writes, but both use one definition of
policy. A relay delivers committed outbox events to notification and integration
workers.

| Record | Important fields | Purpose |
|--------|------------------|---------|
| Host | Identifier, IANA zone, schedule revision | Stable coordination and policy identity |
| Event type | Host, duration, buffers, cap, active flag | Published booking policy |
| Working rule | Host, weekday, local interval, policy revision | Recurring local intent |
| Booking | Host/type, start/end instants, occupied interval, status, revision | Authoritative reservation |
| Operation receipt | Scoped identity, input digest, result reference | Retry and outcome recovery |
| Booking history | Booking, revision, action, accepted snapshot | Explain lifecycle changes |
| Outbox/delivery | Event identity, booking revision, recipient, progress | Recover asynchronous effects |
| Reminder job | Booking revision, reminder kind, due instant, state | Durable scheduled work |

A creation receipt and a booking are different records. The receipt answers what
happened to a particular attempt. The booking answers what the appointment is now.
Cancelling or archiving an appointment must not make the old creation attempt look as
though it never occurred.

The public API needs event metadata, a bounded availability range, booking creation,
and operation recovery. Management APIs need detail, cancellation, and rescheduling
with scoped authorization and expected revisions. Host APIs manage event types and
working policies.

| Method | Proposed path | Purpose |
|--------|---------------|---------|
| GET | /api/availability | Return candidates and explicit covered interval |
| POST | /api/bookings | Submit one identified booking attempt |
| GET | /api/operations/:id | Recover that attempt with authorized access |
| GET | /api/bookings/:id | Read a booking through host or guest authorization |
| PUT | /api/bookings/:id/reschedule | Atomically move a known booking revision |
| DELETE | /api/bookings/:id | Cancel with recoverable operation semantics |

I would return distinct validation, conflict, and temporary-unavailability responses.
Raw database errors and a generic 400 make it harder for a client to know whether to
correct input, choose another slot, or recover a prior operation.

## 🔧 Deep dive: reservation authority and retries — 9 minutes

I would use a short PostgreSQL transaction with a stable host row as the coordination
point. That row exists even when the host has no bookings. Locking only the bookings
currently overlapping a candidate fails to coordinate two inserts into an empty
interval.

The transaction first claims or resolves the operation identity, then acquires the
host lock in a consistent order. All code paths that change that host's occupancy or
relevant policy must follow the same coordination protocol.

Once the lock is held, I read the current active event type and working policy. I
derive the meeting and occupied intervals, check the booking horizon and working-hour
rules, check the daily limit, and look for conflicting active occupancy.

Only after those checks do I write the booking, immutable accepted policy snapshot,
operation result, history, and outbox event. The transaction commits before
responding. No external provider call belongs inside the host lock.

I would also add a database exclusion constraint on host plus active occupied range.
PostgreSQL supports rejecting overlapping ranges through exclusion constraints. An
exact-start unique index rejects equal starts but cannot reject a 09:00–10:00 meeting
overlapping a 09:30–10:30 meeting. [PostgreSQL range
constraints](https://www.postgresql.org/docs/current/rangetypes.html#RANGETYPES-CONSTRAINT).

The range constraint is a backstop, not the entire scheduling policy. It does not
enforce working hours, active event types, or a maximum number of meetings per
host-local day. Those checks still need coordinated current reads.

For rescheduling, the transaction validates the caller's expected revision and
excludes the booking itself from the conflict query. It updates the interval while
keeping the reservation active, increments the revision, and writes the associated
history and outbox event.

A conflict rolls back the move, leaving the old interval reserved. Changing status to
a historical verb such as “rescheduled” is dangerous when the rest of the system
counts only confirmed rows. The action belongs in history; occupancy follows an
explicit active state.

Cancellation also increments the revision and records its effect. Repeating the same
cancellation operation should recover the accepted result. A different stale
cancellation intent can receive the latest state rather than silently acting on a
meeting that has since moved.

Daily limits use a documented scope, such as event type and host-local start date. A
move may release capacity on one day and consume it on another. The same transaction
must handle both, counting the old booking correctly rather than double-counting
itself.

| Approach | Benefit | Cost for this workload |
|----------|---------|------------------------|
| ✅ Host lock plus range backstop | Simple shared authority for overlap and policy | Serializes even nonoverlapping writes to one host |
| ❌ Lock only matching booking rows | Less contention when rows exist | Does not protect an empty time range |
| ❌ Exact-start uniqueness alone | Cheap duplicate-start guard | Misses partial overlap and buffer conflicts |
| Alternative: serializable transactions | Detects broader conflicting executions | Requires bounded retries and contention testing |

I would accept per-host serialization because most hosts receive modest write traffic.
A hot host needs bounded lock waits and admission control. Redis can reduce repeated
work, but it should not become a second independent authority for whether time was
reserved.

Idempotency handles another race: the database commits and the response is lost. The
client retries the same operation, and the receipt returns the original result. A
cached response alone cannot provide that behavior after cache eviction or expiration.

The operation identity is scoped and bound to normalized meaningful input. A caller
must not reuse a key to retrieve another guest's booking or change the selected time
while receiving an earlier result. A different intentional booking gets a new
operation identity.

Receipt retention must cover the supported retry window and remain separate from
booking retention. I would not promise indefinite retry recovery while deleting all
evidence after an hour. The API should make expiry and recovery semantics explicit.

> “The host lock answers who wins the slot. The operation receipt answers whether this
> caller already won. Those are two different questions, so I would not ask one Redis
> key to answer both.”

## 🔧 Deep dive: time policy and availability — 8 minutes

Weekly availability is expressed in the host's civil time: Monday from 09:00 to 17:00
in a named zone. Accepted meetings are stored as instants, with the zone and policy
snapshot needed to explain their original meaning.

Storing weekly hours as a recurring UTC interval can shift the host's workday when
offsets change. Storing a booking only as a local label leaves repeated clock times
ambiguous. I would keep both forms for their different jobs.

An availability request describes a bounded interval of instants, often derived from a
guest-local day or month. That interval can intersect several host-local dates. The
service expands the relevant recurring rules on those host dates before filtering
candidates to the requested range.

For each working window, I collect occupied intervals that overlap it, including
reservations that began earlier. I clip busy intervals to the window, merge overlaps,
and subtract them. Looking up only bookings whose starts fall on that date misses an
overnight conflict.

Then I generate candidate meetings according to the event's duration and slot-grid
policy. The candidate's occupied interval must fit the allowed policy and avoid the
stored occupied intervals of other meetings. Existing reservations keep their own
accepted buffers, rather than borrowing those of the newly queried event type.

Half-open intervals make adjacency precise: one occupied interval can end exactly
where another begins. If preparation and recovery are both required, those values
extend the respective booking intervals and can make two visibly adjacent meetings
conflict.

A daily cap limits accepted bookings, not the number of times offered. If one booking
remains, all otherwise valid times are alternatives for using that capacity.
Truncating the slot list to one item arbitrarily hides legitimate later choices.

At a spring clock change, some local times do not exist. At an autumn change, some
occur twice. I would define a product policy that omits nonexistent slots and
identifies repeated slots by distinct instants, with labels that expose the
distinction to guests.

The date library helps perform conversion, but its default choice is not a scheduling
policy. I would verify the configured library and runtime against the zones we support
and keep timezone data current. IANA's database tracks changes to local time rules.
[IANA timezone database](https://www.iana.org/time-zones).

Confirmed bookings remain tied to their accepted instants unless a deliberate policy
and notification process changes them. Future recurring working hours are expanded
using the relevant timezone rules. Treating these as the same kind of data can
unexpectedly move existing appointments.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Local recurring rules plus accepted instants | Preserves host intent and unambiguous bookings | Explicit conversion, versioning, and transition tests |
| ❌ UTC-only recurrence | Simple arithmetic | Can shift the intended local workday |
| ❌ Local labels without zone/instant | Easy human input | Cannot uniquely identify some meetings |

I would cache derived availability by host/type, covered range, and policy or
availability revision. A booking affects every event type sharing the host.
Invalidation that removes only the booked type's key is insufficient.

A revision also helps prevent a late old computation from repopulating a cache after
invalidation. The response can still become stale between display and submission; that
is why acceptance repeats the authoritative policy and occupancy checks.

If Redis is unavailable, bounded calculations can fall back to PostgreSQL with
admission limits. An unbounded 365-day expansion for every visitor is not a safe
fallback. If the authoritative store is unavailable, booking returns unavailable
rather than pretending cached free time is a reservation.

## 🔧 Deep dive: notifications and booking revisions — 9 minutes

I would commit notification intent with the booking through an outbox. A separate
relay publishes committed events and records progress. A crash after database commit
but before publication leaves work to retry, rather than a confirmed meeting with no
recoverable notification intent.

The relay can publish an event more than once, so the event has a stable identity.
Delivery work is tracked per event, booking revision, recipient, and notification
kind. Host and guest delivery can succeed independently.

The worker checks the current booking revision and the kind of event before sending.
An obsolete confirmation should not announce a cancelled appointment as current. A
cancellation notification is itself valid work and should not be discarded simply
because the booking is inactive.

That check cannot retract an email already accepted by a provider. A cancellation can
race with an in-flight send. I would retain event history, send the current change
notification, and use precise wording rather than promise that no stale email can ever
reach an inbox.

For a provider timeout, the delivery outcome may be unknown. If the provider supports
a stable idempotency key or status lookup, use it. Otherwise a retry can duplicate an
email; a unique database row cannot create exactly-once physical delivery across an
uncoordinated provider boundary.

Reminders are durable jobs keyed by booking revision and reminder kind, such as 24
hours or one hour before the start. Rescheduling supersedes the old jobs and creates
jobs for the new revision. Cancellation makes pending reminder work obsolete.

I would use an indexed due-job table with multiple schedulers claiming bounded batches
under recoverable leases. The scheduler dispatches only eligible jobs, and workers
recheck revision and status close to delivery. Lease expiry recovers work after a
scheduler crash.

The polling interval contributes to reminder lateness, so I would choose it from the
product's tolerance and measure due-to-dispatch and dispatch-to-provider delays
separately. Multiple schedulers avoid making one process the only path for all
reminders.

| Approach | Benefit | Cost in this product |
|----------|---------|----------------------|
| ✅ Durable due jobs with revision checks | Supports moves, cancellation, retry, and inspection | Requires claiming, indexes, and lease recovery |
| ❌ One queue for each arbitrary delay | Convenient small demonstration | Queue growth and lifecycle changes become awkward |
| ❌ In-process timers | Minimal infrastructure | Process restarts lose scheduled work |

RabbitMQ TTL and dead-letter routing can defer messages, but they do not by themselves
define an exact reminder scheduler. Queue expiration applies to unused queues and is
not guaranteed to happen promptly. [RabbitMQ TTL
documentation](https://www.rabbitmq.com/docs/ttl).

A queue remains useful for delivery throughput and backpressure. I would bound
retries, separate permanent failures from temporary ones, and provide an inspected
dead-letter path. Reconnecting a transport must also restore consumers; a connected
socket does not prove anyone is processing work.

The same lifecycle discipline applies to a proposed external-calendar integration.
Store provider identity, synchronization cursor, last successful refresh, and the
booking revision represented by each external write. Retry provider operations
independently of guest creation.

Provider events are advisory inputs until their freshness is known. If freshness
exceeds a configured threshold, the product can refuse new bookings, warn and permit
them, or require manual reconciliation. I would choose that policy with the product
owner rather than hide it behind a cache TTL.

My default for this first implementation is to make internal reservation correctness
reliable before adding multiple external providers. The outbox and revision model
leave a clear place to add synchronization without moving network calls into the
booking transaction.

## 📈 Failure handling and scaling — 6 minutes

PostgreSQL is the acceptance authority. I would run replicas for suitable historical
reads and use a failover arrangement that preserves acknowledged booking guarantees.
Availability replicas may lag; final acceptance and operation recovery require a
consistency policy appropriate to the claimed result.

Stateless API instances scale horizontally. The host is a natural partitioning key if
write volume later requires sharding, because occupancy and daily-count checks remain
local to one partition. I would keep an operation's routing and authorization tied to
that same ownership model.

Read scaling begins with bounded date horizons, overlapping-interval indexes, policy
caches, and coalescing repeated calculations. A global total of five thousand reads
per second says little about the cost of a single request that expands thousands of
days.

I would measure host lock wait, transaction duration, conflict rate, idempotency
recovery, availability freshness, outbox age, reminder lateness, and provider delivery
failures. A successful HTTP response counter cannot distinguish a booked meeting from
a notification backlog.

Health checks should separate process liveness, acceptance dependencies, and
asynchronous delivery health. A broker outage can degrade notification delivery while
the outbox preserves intent. If the outbox backlog exceeds safe storage or delay
limits, admission policy may need to change.

Host sessions and guest capabilities have different scopes. Current authorization must
be enforced on every private request. Public identifiers must not expose arbitrary
attendee data, and password hashes must never appear in login responses or session
user objects.

Retention is another lifecycle operation. I would archive an exact, locked cohort and
delete only the rows successfully copied. Running a broad copy and a later broad
delete can act on different eligible rows as concurrent cancellations occur.

Archival must preserve required history without accidentally deleting delivery
evidence through cascading foreign keys. Account deletion, archive retention, and
receipt retention need an explicit product policy. I would not infer a legal retention
period from a convenient default value in configuration.

## 🧪 Verification and implementation boundary — 3 minutes

I would test two simultaneous requests with overlapping but different starts, two
event types sharing a host, a cap race, and a failed reschedule that preserves the
original interval. Another test loses the response after commit and recovers the same
operation after cache eviction.

Timezone tests cover host and server zones that differ, overnight overlap, split
working windows, a busy interval beyond the window, and both clock-change cases.
Delivery tests interrupt publication, fail one recipient, replay an event, and
reschedule while old reminders are pending.

The local service already explicitly locks the host during creation. Its reschedule
and cancellation queries also lock joined host rows through unqualified FOR UPDATE; it
would be inaccurate to say they have no host lock. The decisive local reschedule bug
is changing to a status ignored by confirmed-only occupancy checks.

The source also lacks a durable receipt lookup, transactional outbox, actual email
delivery, and external-calendar integration. Direct and queued email simulations both
run. Those differences are documented so that the proposed guarantees are not mistaken
for completed implementation.
