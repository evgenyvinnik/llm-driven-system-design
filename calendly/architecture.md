# Calendly architecture

## System Overview

A scheduling service lets hosts publish working hours and event types, lets guests reserve a meeting without an account, and supports later cancellation or rescheduling. Its core responsibility is to convert a proposed time into one durable reservation while keeping the displayed date, timezone, and lifecycle understandable.

The sections before Implementation Notes describe a proposed production design. The final section traces the actual local Express/React implementation, including its limitations. This is an independent learning project, not a description of Calendly's private infrastructure.

## Requirements

### Functional requirements

Support one-to-one meetings, recurring weekly working hours, event duration, prep/recovery buffers, daily limits, public guest booking, and host management. Guests can recover a booking outcome and later manage that booking through a separate scoped capability. Notifications and reminders follow accepted booking revisions.

External-calendar synchronization is a proposed extension with an explicit freshness policy. Group capacity, round-robin assignment, recurring appointment series, payments, and arbitrary scheduling questionnaires are outside the initial design.

### Non-functional requirements

Planning targets are availability p95 below 200 ms, booking p99 below 500 ms, and 99.9% booking availability under the stated load. These are not local measurements. Displayed availability is a recent proposal; the booking transaction is authoritative.

Two active reservations managed by this service must not overlap the same host's occupied interval. Daily limits and working-hour eligibility must be checked at acceptance. Rescheduling must atomically release the old interval and reserve the new interval, with no loss of the old reservation if the new choice fails.

A successful reservation does not imply email delivery or a committed external-calendar write. The service cannot guarantee global absence of conflicts with an independently writable calendar provider that does not participate in its transaction. Detect and reconcile those conflicts rather than describing a polling interval as an absolute guarantee.

## Capacity Estimation

| Assumption | Estimate | Implication |
|------------|----------|-------------|
| One million active hosts, three bookings/week | About 430,000 bookings/day; 5/s average, 50/s assumed peak | Short per-host transactions are plausible; measure hot-host contention |
| 100 availability lookups per booking | About 43 million/day; 500/s average, 5,000/s peak | Cache bounded ranges and coalesce repeated calculations |
| Booking plus retained metadata averages 10 KB | About 1.6 TB/year raw | Retention, indexes, and backups matter even at modest write rates |
| Five event types/host at 5 KB each | About 25 GB raw | Versioned policy records fit ordinary relational access |
| 100 external events/host at 5 KB each | About 500 GB raw, if integration is added | Bound synchronization horizon and stored fields |

The read/write ratio is a workload assumption, not evidence that write scaling will never matter. A public release of office hours can concentrate requests on one host even when platform-wide throughput is modest. Control lock waits and admission per host.

### Local Development Scale

One API, one notification worker, PostgreSQL, Valkey, and RabbitMQ are sufficient. Multiple API/worker scripts share the same infrastructure; no load balancer is supplied. The optional valid fixture prefix contains four hosts, eight meeting types, and twenty weekly rules. The full historical fixture cannot populate its bookings as written.

## High-Level Architecture

```text
┌────────────────┐       ┌────────────────┐
│ Guest / host UI│──────▶│ Scheduling API │
└────────────────┘       └───────┬────────┘
                                 ▼
                         ┌────────────────┐
                         │ Booking store  │
                         │ Rules + outbox │
                         └───────┬────────┘
                                 │ committed changes
                 ┌───────────────┴──────────────┐
                 ▼                              ▼
         ┌────────────────┐             ┌────────────────┐
         │ Availability   │             │ Notification   │
         │ cache          │             │ jobs / workers │
         └────────────────┘             └───────┬────────┘
                                                ▼
                                        Email / calendar
                                        providers
```

A CDN serves static assets and public page metadata with appropriate cache policy. Guest availability and private management data have separate keys and access rules. Logical availability, booking, and integration services can begin in one application; scale their capacity independently as their workloads diverge.

## Core Components / Request Flows

### Time model and availability

Store weekly rules as local wall-clock intervals tied to the host's IANA zone. Store confirmed booking instants and their occupied intervals as timestamps, retaining host/guest zone context and the accepted policy revision. A recurring “Monday at 09:00” is not a fixed UTC hour across daylight-saving transitions. IANA's database changes as civil-time rules change; runtime timezone data must be maintained. [IANA Time Zone Database](https://www.iana.org/time-zones).

For an invitee-local date or range, first compute its actual instant boundaries in the selected zone. Fetch every host-local day that intersects those boundaries. Convert host rules for those dates, merge overlapping working intervals, subtract all overlapping occupied intervals, and generate candidates using an explicitly defined grid.

Busy intervals must be clipped to each working window before gap calculation. Fetch by overlap, not by whether a booking starts within the day: a meeting or its buffer can cross midnight. Use the next local midnight as the exclusive day end rather than assuming every day lasts 24 hours.

Define buffer semantics once. Here each booking reserves its own interval from start minus prep time to end plus recovery time, using a snapshot of that booking's policy. Compare candidate occupancy against existing occupancy. A later event-type edit does not retroactively change already accepted reservations.

Reject nonexistent local-time candidates and define how repeated local times are offered. If both fall-back occurrences are eligible, return distinct instants and labels that include their offset. An ordinary local-time string alone cannot distinguish them.

Daily capacity limits the number of reservations, not the number of alternatives a guest may see. With one reservation remaining, show all eligible choices and arbitrate the final selection at write time. Cache results with policy/booking revisions and computation time; remove choices that have aged past the booking cutoff even on cache hits.

### Booking acceptance

Validate the guest request and operation identity. In one transaction, acquire the host's stable lock, read the current event policy/rules, check the requested instant and occupied interval, enforce the host-local daily cap, and insert the booking with a durable operation result and outbox entries. Return the committed booking, not merely the submitted slot.

Every writer of managed reservations uses the same host authority, including rescheduling, imports, and administrator actions. A range exclusion constraint is a backstop against overlapping occupied intervals. The displayed slot list, an earlier availability precheck, and a Redis operation lock do not reserve time.

### Reschedule and cancel

Rescheduling updates one booking's interval and revision atomically while keeping its lifecycle active. It revalidates the same rules as creation, excluding its own old reservation from conflict checks. Failure leaves the original time intact. Treat “rescheduled” as an event in history rather than a status that removes the meeting from the active reservation set.

Cancellation transitions an active reservation to cancelled and records a notification event. A repeated identical cancellation can return the current cancelled result. Compare the caller's expected revision when a stale view could overwrite an intervening change; a server-internal version reread alone does not detect stale user intent.

### Notifications and reminders

Commit notification intent with the reservation through an outbox. Workers deliver using identities scoped to booking revision, notification kind, and recipient. Provider acceptance, mailbox delivery, and a local simulated record are distinct outcomes.

Maintain reminder jobs by booking revision and due time. A scheduler can claim a bounded set of due rows through an indexed query and leases; multiple schedulers can share that work. This avoids a durable broker queue per individual delay. At dispatch, check that the booking is still active at the expected revision and time.

Rescheduling invalidates old reminder jobs and creates replacements in the same authoritative change. Cancellation invalidates pending jobs. Delayed notifications must not overwrite newer lifecycle state or announce an obsolete confirmation as current.

### External-calendar extension

Synchronize provider changes into a local busy-event projection with cursors, retry budgets, and visible last-success time. Push notifications are hints to fetch changes; periodic reconciliation recovers missed hints. Poll frequency is a target under healthy operation, not a staleness bound through an outage.

Route imported busy changes through the same host coordination when updating local reservations. However, an independent external event can still be created after a fresh check. Choose a product policy for stale calendars and conflicts discovered after acceptance, and expose it to the host. Outbound calendar writes use durable jobs and provider-supported identities; they do not share the PostgreSQL booking transaction.

## Database Schema

### Current local schema

This is the checked-in [initialization SQL](./backend/src/db/init.sql), with full-line comments removed. It is evidence of the teaching implementation, not the production schema proposed above. The confirmed-start unique index does not prevent arbitrary overlaps. There is no stored occupied interval, outbox, guest capability, external calendar table, or durable reminder job.

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  time_zone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  role VARCHAR(20) NOT NULL DEFAULT 'user', -- 'user' or 'admin'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE meeting_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
  max_bookings_per_day INTEGER,
  color VARCHAR(7) DEFAULT '#3B82F6',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, slug)
);

CREATE TABLE availability_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6), -- 0=Sunday, 6=Saturday
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

CREATE INDEX idx_availability_user_day ON availability_rules(user_id, day_of_week, is_active);


CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meeting_type_id UUID NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  invitee_timezone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed', -- confirmed, cancelled, rescheduled
  cancellation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1,
  -- Migration 002: Idempotency key for duplicate prevention
  idempotency_key VARCHAR(255),
  CONSTRAINT valid_booking_time CHECK (end_time > start_time)
);

CREATE UNIQUE INDEX idx_bookings_no_double ON bookings(host_user_id, start_time)
  WHERE status = 'confirmed';

CREATE INDEX idx_bookings_host_time ON bookings(host_user_id, start_time, end_time);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_meeting_type ON bookings(meeting_type_id);

CREATE UNIQUE INDEX idx_bookings_idempotency_key
  ON bookings(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE bookings_archive (
  id UUID PRIMARY KEY,
  meeting_type_id UUID NOT NULL,
  host_user_id UUID NOT NULL,
  invitee_name VARCHAR(255) NOT NULL,
  invitee_email VARCHAR(255) NOT NULL,
  start_time TIMESTAMP WITH TIME ZONE NOT NULL,
  end_time TIMESTAMP WITH TIME ZONE NOT NULL,
  invitee_timezone VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  cancellation_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  version INTEGER DEFAULT 1,
  -- Migration 002: Idempotency key for consistency with bookings table
  idempotency_key VARCHAR(255),
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_bookings_archive_host_time
  ON bookings_archive(host_user_id, start_time);

CREATE INDEX idx_bookings_archive_archived_at
  ON bookings_archive(archived_at);


CREATE TABLE email_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  recipient_email VARCHAR(255) NOT NULL,
  notification_type VARCHAR(50) NOT NULL, -- confirmation, reminder, cancellation, reschedule
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'sent' -- sent, failed
);

CREATE INDEX idx_email_booking ON email_notifications(booking_id);


CREATE TABLE sessions (
  sid VARCHAR(255) PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE INDEX idx_sessions_expire ON sessions(expire);
```

Weekly `TIME` values are wall times, so “all times stored in UTC” is inaccurate. `timestamptz` preserves an instant, not the original IANA zone; those zone names live in separate fields. Booking and archive status values are not checked by the database. The archive omits foreign keys but also omits snapshots of host and meeting-type names.

### Proposed schema extensions

| Record/constraint | Purpose |
|-------------------|---------|
| Occupied start/end and accepted policy revision | Preserve each reservation's buffer and duration semantics |
| Per-host range exclusion for active occupancy | Reject overlapping intervals, including different start times |
| Caller/operation receipt with input digest | Recover one result across retries and lifecycle changes |
| Booking history and expected revision | Preserve reschedule/cancel intent and detect stale modifications |
| Outbox and per-recipient delivery record | Retain notification intent and recover partial processing |
| Reminder job keyed by booking revision and kind | Replace/cancel due work without relying on old payloads |
| Hashed guest capability with scope/expiry | Authorize one guest's management actions separately from public IDs |
| Policy and host availability revision | Invalidate every affected event type consistently |

A representative production constraint would use an occupied timestamp range plus host equality, with `btree_gist` for the scalar host key. PostgreSQL documents range exclusion constraints for this purpose. [PostgreSQL range constraints](https://www.postgresql.org/docs/current/rangetypes.html#RANGETYPES-CONSTRAINT).

```sql
-- Proposed columns and constraint; not present in the local schema.
ALTER TABLE bookings ADD COLUMN occupied_start timestamptz;
ALTER TABLE bookings ADD COLUMN occupied_end timestamptz;
-- Backfill, make these NOT NULL, and check occupied_end > occupied_start first.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bookings ADD CONSTRAINT no_active_host_overlap
EXCLUDE USING gist (
  host_user_id WITH =,
  tstzrange(occupied_start, occupied_end, '[)') WITH &&
) WHERE (status = 'confirmed');
```

The production lifecycle keeps rescheduled reservations confirmed; otherwise this predicate would repeat the local status bug. Ordinary policy edits must not rewrite occupied intervals without revalidation. A daily-count limit is a separate invariant and still needs coordinated checks.

## API Design

### Current routes

The application uses `/api`, not `/api/v1`. Responses normally wrap results in `success` and `data`, with `error` on failure.

| Method | Path | Current access and behavior |
|--------|------|-----------------------------|
| POST | `/api/auth/register`, `/login` | Register and auto-login, or sign in |
| POST | `/api/auth/logout` | Destroy Redis session; no explicit cookie clearing |
| GET | `/api/auth/me` | Session lookup plus cached user read |
| GET/POST | `/api/meeting-types` | Host lists or creates types |
| GET | `/api/meeting-types/:id` | Public active type plus host name/email/zone |
| PUT/DELETE | `/api/meeting-types/:id` | Owner update or hard delete; deletion cascades bookings |
| GET/POST | `/api/availability/rules` | Host reads or replaces rules |
| DELETE | `/api/availability/rules/:id` | Owner deletes one rule |
| GET | `/api/availability/slots` | Public slots for one date; validates but does not use invitee zone in calculation |
| GET | `/api/availability/dates` | Public dates over a default 30-day horizon; no bounded days-ahead schema |
| GET | `/api/bookings`, `/api/bookings/stats` | Host list or dashboard statistics |
| GET | `/api/bookings/:id` | Public full booking details |
| POST | `/api/bookings` | Public creation; optional X-Idempotency-Key |
| PUT | `/api/bookings/:id/reschedule` | Anonymous caller with UUID, or authenticated host |
| DELETE | `/api/bookings/:id` | Anonymous caller with UUID, or authenticated host |
| GET | `/api/admin/stats`, `/users`, `/bookings`, `/emails` | Session-copied admin role required |
| DELETE | `/api/admin/users/:id` | Admin deletion; prevents deleting self |
| GET | `/api/admin/bookings/recent` | Creation/cancellation counts grouped by creation day |

The public frontend routes are `/book/<meeting-type UUID>` and `/bookings/<booking UUID>`. There is no username/slug-token resolver, slot-check endpoint, signed management token, or Google OAuth route.

Example slot request and response shape:

```http
GET /api/availability/slots?meeting_type_id=<UUID>&date=2026-09-14&timezone=America%2FLos_Angeles

{"success":true,"data":{"date":"2026-09-14","timezone":"America/Los_Angeles","slots":[{"start":"2026-09-14T16:00:00.000Z","end":"2026-09-14T16:30:00.000Z"}]}}
```

The timestamp is illustrative, not a promised result for the sample policy. Creation accepts meeting type, UTC start, invitee name/email/zone, and optional notes; the server derives the end from the current event type. Local booking conflicts and most business failures return 400, not 409 with suggested alternatives.

The proposed contract adds range coverage, policy revision, operation recovery, expected mutation revision, and scoped guest authorization. It returns a complete authoritative booking and separately reports notification/calendar progress.

## Key Design Decisions

### Stable host locking versus locking matching bookings

Lock the host before checking occupancy. It is a row that exists even when the host has no bookings. Locking only currently overlapping bookings does not protect the absence of such a row, so two concurrent inserts can both observe an empty range.

The host lock serializes nonconflicting bookings for that host too. Short transactions and bounded waits are the price of a simple common authority. A version on a host schedule, serializable transactions with bounded retries, or a range exclusion constraint are credible alternatives; they are not intrinsically unable to handle scheduling. The proposed design uses the lock for policy/count coordination and the range constraint as a backstop, rather than claiming an exact-start unique index covers all overlaps.

### Local recurrence plus instants versus a UTC-only rule model

A host's weekly 09:00 working time should remain 09:00 after an offset change. Store that intent with an IANA zone and resolve it for each date. A confirmed meeting also needs one unambiguous instant and a policy for later timezone-rule changes.

A UTC-only recurrence can shift host working hours seasonally; a local-time-only booking cannot distinguish repeated fall-back times. The cost of the combined model is explicit date/zone handling, DST tests, and versioned policy. Browser formatting remains useful, but changing the selected timezone can change which instants belong to the visible calendar date, requiring additional range coverage.

### Durable scheduled jobs versus queue-per-delay reminders

An indexed due-job table supports multiple claiming schedulers, revision checks, and retries without maintaining one queue for each millisecond delay. It adds a polling interval and lease/recovery logic. That interval is a controllable scheduling delay, not a reason a scheduler must be a single point of failure.

TTL/dead-letter routing can defer messages, but it is not a complete reminder lifecycle or an exact timer. Queue expiration concerns unused queues, and dead-lettering can have delivery limitations. The local implementation uses delay queues; the proposed design chooses durable due jobs with explicit dispatch state. [RabbitMQ TTL](https://www.rabbitmq.com/docs/ttl), [dead-letter behavior](https://www.rabbitmq.com/docs/dlx).

## Consistency and Idempotency

A creation operation is distinct from a slot. Two guests choosing the same interval are competing reservations; one guest retrying a committed attempt should recover the same result. A shared host lock handles occupancy, while a caller-scoped operation record handles retries.

Bind the operation identity to normalized input and retain its result independently of the booking's mutable lifecycle. A cancelled booking can still be the result of an earlier creation attempt. Rebooking the same time is a new operation, not a reason to replay a stale confirmed object forever.

Outbox entries commit with each lifecycle revision. Notification and reminder workers reconcile the current revision before sending, and duplicate processing must not generate an unbounded number of effects. A provider timeout can leave send outcome uncertain; database uniqueness alone cannot guarantee exactly one physical email without a compatible provider contract.

## Security / Auth

Hosts use opaque server-managed sessions; private reads and mutations check current account access. Guests receive separate, scoped management capabilities rather than using a public identifier as unrestricted proof of ownership. Email verification, when required, is a distinct state and does not happen merely because a syntactically valid address was submitted.

Protect public availability and booking endpoints with bounded date horizons, request sizes, and actor/network quotas. Avoid exposing unrelated guest details, raw idempotency keys, password hashes, or notification bodies in logs. Administrative account deletion needs an explicit retention and cascade policy.

## Observability

Measure accepted bookings, ordinary slot conflicts, recovered attempts, lock wait, stale-policy rejections, availability age, calculation latency, outbox age, reminder lateness, and notification outcomes. A prevented conflict is expected when two guests compete; it is not evidence that a double booking occurred.

Alert separately on actual overlapping active reservations or mismatched occupancy state. Use route templates and bounded labels. Report fresh user-visible confirmation independently of provider delivery. Health and worker-progress checks must remain useful during dependency failures.

## Failure Handling

| Failure | Proposed response | Local limitation |
|---------|-------------------|------------------|
| Stale displayed slot | Revalidate under host authority; preserve guest details on conflict | Creation checks overlaps/cap but not full working-hour or future eligibility |
| Lost creation response | Recover durable operation result | Redis replay only; unique DB key is not queried for recovery |
| Redis unavailable | Controlled cache bypass; explicit session behavior | Most caches and session store fail; no SQL session fallback |
| Cache invalidation fails after commit | Return committed result, retry propagation from outbox | Can return failure after booking/rules already committed |
| Broker unavailable | Retain notification intent and retry later | Fire-and-forget publication, no outbox or in-memory replay buffer |
| Worker replay | Reconcile revision and per-recipient delivery | Duplicate SQL email logs; old payloads can be processed later |
| External calendar stale | Apply stated acceptance policy and expose sync status | External calendars are not integrated |
| Interrupted archival | Move an exact locked cohort atomically | Separate broad INSERT/DELETE predicates can see different eligible rows |

## Scalability Considerations

Optimize availability misses before adding distributed writes. Compute bounded ranges in batches, avoid repeated per-day metadata queries, coalesce cache fills, and key results by host/policy revision. Invalidate every event type whose shared host occupancy changed, not only the type just booked.

Read replicas can serve browsing projections when their age is acceptable. They must not arbitrate booking acceptance. Cache age plus replica lag plus notification delay determine visible freshness; replica lag is not free merely because browsing tolerates some staleness.

Partition by host when one mapping/booking authority is insufficient so that host occupancy and policy remain colocated. Cross-host group scheduling needs additional coordination. Time partitioning alone can split a meeting and its conflicts across day/month boundaries and complicate a global exclusion constraint; do not assume it preserves the invariant automatically.

Retain active reservations until their lifecycle is complete. Archive an exact set of locked rows and preserve operation/delivery identities for the recovery horizon. Policies for archives and personal data should be requirements, not invented legal obligations.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Occupancy arbitration | Host lock plus range backstop | Lock only matching bookings | An empty interval has no row to lock |
| Time model | Local recurring rules plus instants | UTC-only recurrence | Preserve host wall-clock intent across offset changes |
| Availability cache | Bounded versioned proposal | Treat cached slots as reservations | Correctness belongs to the commit transaction |
| Reschedule lifecycle | Active booking with a new revision | Nonblocking rescheduled status | The moved meeting must still reserve time |
| Notification intent | Transactional outbox | Post-commit publish alone | Recover process/broker failures after booking success |
| Reminders | Durable due jobs | Queue per unique delay | Make revision, cancellation, and recovery explicit |

## Implementation Notes

### Runtime, setup, and fixtures

[The entry point](./backend/src/index.ts) mounts all API routes in one Express process on port 3000 by default. [The worker](./backend/src/workers/notification-worker.ts) logs simulated emails through a separate process. [Compose](./docker-compose.yml) provides PostgreSQL 16, Valkey 7, and RabbitMQ 3. Only PostgreSQL and Valkey have named data volumes; AOF is not explicitly enabled and RabbitMQ data is not retained across ordinary container replacement.

The schema creates seven tables but no accounts. It is not rerunnable on an initialized schema. The full [SQL fixture](./backend/db-seed/seed.sql) references absent demo records and invalid `bk...`/`ar...` UUIDs. With stop-on-error it leaves the preceding four users, eight types, and twenty weekly rules committed, then stops at the first booking statement. Repeating the valid prefix duplicates rules because there is no uniqueness constraint on weekly intervals. Existing matching emails with different UUIDs can also break its fixed foreign-key references.

All four sample users have role user and password123, verified by an isolated bcrypt comparison. There is no administrator or demo@example.com account. The README gives registration and a valid-prefix option plus explicit local promotion. Application startup does not seed, migrate, or repair the fixture.

The API logs failed database/Redis startup checks and continues listening. The worker exits if PostgreSQL, Redis, or its initial broker setup fails. Broker connection variables are separate host/port/user/password fields, not RABBITMQ_URL. There is no `.env` loader or load balancer. `WORKER_ID` is set by scripts but unused in the worker.

### Booking authority and lifecycle

[Creation](./backend/src/services/booking/create.ts) acquires a database client, begins a transaction, fetches active meeting metadata through a separate pool query, then explicitly locks the host:

```sql
SELECT id FROM users WHERE id = $1 FOR UPDATE;
```

The subsequent confirmed-booking overlap check uses the candidate's expanded interval. This serializes ordinary creates for a host; it is stronger than locking only existing bookings. However, the policy was read before the lock, and creation never verifies working-hour membership, slot-grid membership, a future start, minimum notice, or a maximum horizon. It expands only the candidate by its current type's buffers, without reserving each existing meeting's own buffer snapshot.

The daily cap counts this meeting type's confirmed starts within the API process's local midnight boundaries. Availability uses host-zone boundaries instead. Neither the partial index nor the host lock reconciles those different definitions.

[Reschedule](./backend/src/services/booking/reschedule.ts) and [cancel](./backend/src/services/booking/cancel.ts) select a join of booking, type, and host with unqualified `FOR UPDATE`. This locks participating rows from all three tables, including the host; it is incorrect to describe rescheduling as having no host lock. PostgreSQL specifies that scope for a locking clause without an `OF` table list. [SELECT locking clauses](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE).

The major reschedule defect is the update to `status = 'rescheduled'`. All occupancy queries, daily-cap counts, the exact-start unique index, upcoming statistics, and reminders use only confirmed rows. The moved booking therefore stops reserving time. Reschedule also omits daily-cap, working-hour, future-time, and active-type checks, uses the current type duration, and does not schedule new reminders.

Its version condition uses the version just read under lock; callers supply no expected version. Cancellation increments version without a version predicate, rejects an already cancelled booking, and can cancel past/rescheduled records through the API. These are not the documented optimistic client-conflict and idempotent-cancel semantics.

Post-commit cache invalidation is awaited inside the same try/catch. Redis failure can cause an attempted rollback after commit and return 400 despite a durable booking change. Create can cache its result before invalidation fails, so a later replay may return success while notifications were never started. There are no transaction/lock statement deadlines or automatic deadlock retries.

### Idempotency behavior

[Booking idempotency](./backend/src/services/booking/idempotency.ts) uses [shared/idempotency.ts](./backend/src/shared/idempotency.ts). The browser sends no key; the service derives one from meeting type, the literal start string, and lowercased/trimmed email. Name, notes, timezone, operation scope, and a complete request digest are not included. A supplied key is global and unbound to its payload or caller.

```typescript
return `booking:${meetingTypeId}:${startTime}:${normalizedEmail}`;
```

Results are cached for one hour by default. Locks contain the constant value `1`, expire after 30 seconds, are not renewed, and are deleted without checking ownership. Cache/lock errors fail open. Database-client acquisition occurs outside the try/finally, so an acquisition failure leaves the Redis lock until expiry.

The database's unique idempotency column can prevent a second stored key, but no path queries it to recover the prior result. After cache loss/expiry, retries can fail with overlap or uniqueness errors instead of returning the booking. Equivalent start-time string representations can derive different keys. Replay can return an old confirmed object after cancellation or reschedule, and a deliberately new booking with the same derived identity is indistinguishable from retry. Archival removes the live unique-key record and has no coordinated receipt retention.

### Availability calculation and time defects

[AvailabilityService](./backend/src/services/availabilityService.ts) first queries active type/host metadata, then reads `slots:<type>:<date>`. A cache hit still requires PostgreSQL and returns stored slots without filtering those now in the past. The `_inviteeTimezone` argument is ignored; its validation does not make the date an invitee-local day.

For weekday selection, it parses the date as midnight in the process zone and converts that instant to the host zone. In an isolated UTC-process check, Monday 2026-09-14 becomes weekday Sunday for a Los Angeles host. Working intervals are then constructed from the original date label, so the chosen weekday's rules can be applied to another date.

The dates endpoint generates labels in the invitee zone but feeds them into this host-date calculation. It performs a sequential slot query per day, with an unbounded days-ahead parameter. It does not return coverage for a genuine invitee-local instant range.

[Time helpers](./backend/src/utils/time.ts) use date-fns/date-fns-tz. They do not detect ambiguous or nonexistent civil times. An isolated call for New York 2026-03-08 02:30 returned 06:30Z, which formats back as 01:30, while 2026-11-01 01:30 selects one occurrence without an explicit policy. These checks exercised the installed helper/library, not the live booking API. The library's [conversion documentation](https://github.com/marnusw/date-fns-tz#fromzonedtime) describes converting civil values and instants; application-level disambiguation is still required.

Booking lookup selects confirmed rows whose starts fall between host-local 00:00 and 23:59. It misses meetings beginning earlier and overlapping the day, buffers crossing into it, and starts in the final minute after 23:59:00. The slot calculator expands every booking using the candidate type's buffers, then adds candidate padding again while generating slots; this differs from creation's raw-existing-interval predicate and ignores other types' own buffer policy.

`findGaps` merges busy intervals but does not clip them to the working window. A direct check of a 09:00–12:00 window with a 15:00–16:00 busy interval produced a 09:00–15:00 gap and a final 14:30 slot. Multiple working rules are not merged, so duplicates/overlapping rules can also emit repeated choices.

Daily-cap handling truncates alternatives to the first remaining-count slots, incorrectly hiding later valid choices. Booking mutations invalidate only `slots:<changed type>:*`; the host ID argument is unused, so caches for the host's other types remain stale. Rule changes invalidate all types found through a cached list, using blocking Redis KEYS. Late computations can refill old results after deletion; there are no generation checks.

[Meeting-type creation](./backend/src/services/meetingTypeService.ts) deletes `meeting_types:<user>` while reads use keys ending in `:true` or `:false`, leaving existing lists stale. Updates clear type/list caches but not computed slots. Deactivation is checked by the fresh active-type query before a slot-cache read. Hard deletion cascades bookings/email logs; it does not perform cancellation or notify guests. Empty updates return cached details without checking ownership.

### Notification and reminder behavior

[Booking notifications](./backend/src/services/booking/notifications.ts) always invoke both a queued path and a direct [email simulation](./backend/src/services/emailService.ts). With a functioning worker, ordinary confirmation produces two records per recipient; cancel/reschedule produces two guest records and one host record. The direct path is not a fallback selected only when RabbitMQ fails. Both write status sent and print bodies; neither contacts an email provider, and host messages use the invitee timezone too.

[QueueService](./backend/src/shared/queue.ts) declares durable booking-notifications, reminders, and notifications-dlq queues. Main/reminder failures dead-letter through a correctly bound direct exchange. Publication uses persistent messages on a plain channel without confirms or backpressure handling. There is no outbox, retained in-memory retry buffer, payload schema validation, or event/revision identity for duplicate suppression.

Connection setup is lazy in the API. Concurrent publishers can call connect while setup is in progress; connect returns immediately rather than awaiting the existing initialization, allowing a publisher to access a null channel. Creation launches confirmation and reminder scheduling together, exposing this cold-connection race.

Reminders use one durable `reminders-delay-<milliseconds>` queue per delay, with message TTL and dead-letter routing through the default exchange into reminders. Queue expiry is based on being unused, not a guaranteed exact deletion timer after delivery. There is no per-booking cancel/update operation for these queues. Scheduled reminders check only current confirmed status and use their old payload; rescheduled meetings are skipped and get no replacements.

The worker inserts recipient logs separately and then writes a seven-day Redis notification-status marker. A failure after one recipient or after both sends can dead-letter a partially applied job; replay duplicates prior records. It does not reject stale lifecycle notification payloads. Unknown notification types are logged and acknowledged. Prefetch 1 limits consumer delivery, not end-to-end exactly-once work.

Reconnect creates queues/channel but does not restore either consumer. Connection error and close events can schedule multiple attempts; the timer calls an async connect without handling its rejection. Shutdown closes connections without first canceling and draining consumers, and connection-close handling can schedule reconnect during shutdown. The API has no graceful-shutdown handler.

### Authentication and frontend behavior

[Login](./backend/src/services/userService.ts) validates bcrypt with 10 rounds, but destructures `_password_hash` rather than `password_hash`. The real hash remains in the returned user, HTTP login response, and session. An isolated object-shape check confirmed that property remains. Registration returns a narrower user shape. Emails are case-sensitive, and registration does not validate that the host timezone is a real IANA zone.

Sessions use connect-redis with prefix calendly:session:, default connect.sid cookies, HttpOnly/SameSite=Lax, a 24-hour cookie max age, and Secure only in production. The SQL sessions table is unused. Login/registration do not regenerate the session ID. Authorization checks session userId and the copied role rather than refreshing the user on every request; `/me` uses a one-hour user cache and does not update the copied role. User deletion clears that user cache but not existing sessions.

Public booking details include guest/host emails, notes, and other booking fields. Anonymous cancel/reschedule accepts a booking UUID without a separate token; adding a session restricts these actions to the host, but omitting the cookie removes that check. No rate limiter or calendar-token encryption is wired because calendar integration is absent.

[The browser](./frontend/src/main.tsx) checks auth on mount without persist storage. However, ordinary host route guards skip the check while auth isLoading is true and do not recheck automatically after it finishes. There is no universal HTTP-status interceptor, account-generation guard, or cancellation of outstanding requests. Logout clears browser identity even if the parsed response reports failure; a network exception leaves it intact.

[Guest booking](./frontend/src/routes/book.$meetingTypeId.tsx) uses local state and direct fetch. Changing timezone reloads dates/slots and clears selection even in the details step. Meeting-type changes do not reset the wizard or include the new type in the slot effect dependencies. Late type/date/slot responses can overwrite newer context. Errors often log only to the console and look like empty availability.

[CalendarPicker](./frontend/src/components/CalendarPicker.tsx) uses browser-local Date values for day labels, minimum date, and month navigation. An empty available-date set enables all nonpast dates, including while loading or after a failed lookup. Month navigation does not request new coverage beyond the initially loaded 30 days. Formatting selected local midnight in another zone can change the displayed date independently of the selected label.

The confirmation stores only the returned booking ID, then displays draft name/time/duration instead of the complete committed record. The ID is not exposed as a management link. The success page claims email delivery even though it only has booking acceptance. There is no calendar export or reschedule UI. Public [booking details](./frontend/src/routes/bookings.$bookingId.tsx) do allow cancellation; after the mutation's plain booking response replaces joined details, host/type display fields disappear until reload.

[The availability editor](./frontend/src/routes/availability.tsx) displays the browser timezone rather than the saved host timezone and retains one interval per day, overwriting additional rules on save. [Event editing](./frontend/src/components/meeting-types/MeetingTypeModal.tsx) lacks a daily-cap field; blank description becomes undefined and cannot clear an existing description. Copy Link announces success before awaiting the clipboard operation. Host lists are unpaginated, dashboard data is sliced to five after full fetch, and filters have no stale-response guard.

### Operational patterns and lifecycle tooling

| Pattern | Actual evidence | Limit |
|---------|-----------------|-------|
| Host locking | booking/create.ts and joined mutation selects | No range exclusion or complete shared policy validation |
| Idempotency helper | shared/idempotency.ts | Redis result cache plus unbound lock; no durable-result recovery |
| Metrics | [shared/metrics.ts](./backend/src/shared/metrics.ts), HTTP finish hooks | Raw fallback paths can be unbounded; DB-query and calendar metrics are declared but unused |
| Structured logging | [shared/logger.ts](./backend/src/shared/logger.ts) | Request context is not propagated into service/queue logs; emails and full simulated bodies remain visible |
| Health | [shared/health.ts](./backend/src/shared/health.ts) | SQL and Redis checks lack overall deadlines; broker object/depth checks do not prove consumer progress |
| Archival | [archivalService.ts](./backend/src/services/archivalService.ts) | Manual only, broken aggregate maintenance, unsafe broad cohort deletion |

Metrics count a prevented create conflict as normal conflict handling, not a stored double booking. Success is recorded before post-commit invalidation, so a subsequent failure can also record failed latency. Replays bypass creation timing. The active-bookings gauge updates on create/cancel only and does not age with time or update on reschedule. Worker email simulation does not update the API process's notification metric. There is no circuit-breaker implementation, even though the old architecture described one.

Health treats SQL, Redis, and heap-used/heap-total ratio as critical; RabbitMQ failure only degrades the overall result. It queries queue depths only after that process has a broker connection. Basic health still performs Redis INFO and queue checks; RabbitMQ's latency measurement is taken before those queue operations. SQL health releases its client only on success, so a failed query can leak it. Pool-size metrics use in-memory pool values and do not require a business query.

Archival selects completed/cancelled records older than the completed-retention setting, default 90 days. The separate cancelled-retention setting is unused, and there is no automatic completed transition: old confirmed/rescheduled bookings remain live. Copy and deletion use separate broad predicates under ordinary isolation; a record becoming eligible between statements can be deleted without being in the copied cohort when other rows were archived. Cascading deletion removes its email logs.

Restore has a similar broad-delete pattern, and can fail when original parents no longer exist. Archive purge uses archived_at plus 730 days by default; no scheduler runs it. Full maintenance invokes operations in parallel, including cleanup of nonexistent calendar_events_cache, then its package command catches the error and exits without a failing exit code. Other operations may already have committed or be interrupted by process exit. Storage stats hide missing/inaccessible archive/calendar queries as zero.

### Simplifications, omissions, and verification

The local system uses one PostgreSQL database, one Valkey, RabbitMQ, and direct SQL/console email simulation. It omits external calendars, provider token storage, a transactional outbox, durable reminder records, guest capability tokens, shared quotas, read replicas, sharding, CDN, and region failover. Prototype defects above are separate from those deliberate scope reductions.

The eight [smoke tests](./tests/smoke.spec.ts) and screenshot configuration mostly assert page containers. The booking-detail case uses an invalid UUID and can succeed on an error page. This review inspected source and ran isolated bcrypt, interval, date/DST, and object-property checks. It did not execute the SQL fixture, start the application stack, run browser/concurrency tests, or measure the proposed production targets.
