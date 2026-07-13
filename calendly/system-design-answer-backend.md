# Calendly - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## 📋 Problem Statement

Design the backend for a meeting scheduling platform like Calendly: hosts publish their availability, invitees pick a slot and book it, and the two never exchange a single "does Tuesday work?" email. The system computes availability across working hours, existing bookings, and external calendars; prevents double-bookings under concurrent access; handles time zones and DST correctly; and delivers reliable notifications for every booking lifecycle event.

Two properties define the design:

- **One invariant matters absolutely**: no double-bookings, ever. A scheduling product that double-books once loses the user — the entire value proposition is "trust me with your calendar."
- **A 100:1 read/write asymmetry**: invitees browse many dates before picking one. Availability checks outnumber bookings roughly 100 to 1, so the architecture optimizes reads aggressively while spending whatever it takes on write correctness.

## 🎯 Requirements Clarification

Questions I'd ask up front:

- **Meeting types in scope?** 1-on-1 first; group and round-robin events are extensions of the same availability core and I'll note where they'd attach.
- **How fresh must availability be?** I'll target minutes-fresh for browsing with a strict server-side re-check at booking time — the browse view is a hint, the booking transaction is the truth.
- **Calendar integration depth?** Two-way: read external events into availability, write bookings out as calendar events. This brings OAuth token management and third-party API failure modes into scope.
- **Do invitees have accounts?** No — invitees book via a public URL with just name and email. That makes the booking endpoint an unauthenticated public write path, which shapes rate limiting and abuse defense.

### Functional Requirements

- **Availability management**: recurring weekly schedules, buffer times before/after meetings, max-bookings-per-day caps
- **Booking flow**: browse slots, book instantly, reschedule, cancel — with conflict prevention throughout
- **Calendar integration**: Google/Outlook two-way sync; external events block availability; bookings appear on the host's calendar
- **Time zones**: invitee sees slots in their local zone; storage is UTC; DST transitions never corrupt a booking
- **Notifications**: confirmations, reminders, cancellation notices — asynchronous, with retry and dead-lettering

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Consistency | Zero double-bookings | One failure destroys trust in the product |
| Availability check latency | p95 < 200ms | Users browse many dates; slow browsing kills conversion |
| Booking latency | p99 < 500ms | Acceptable for a form submission with strong guarantees |
| Uptime | 99.9% for booking | A missed booking is lost business for the host |

### Scale Estimates

- 1M DAU, ~3 bookings per user per week → **~430K bookings/day (~5/sec average, ~50/sec peak)**
- ~100 availability checks per booking → **~43M checks/day, ~5,000 RPS peak**
- Storage: bookings ~1.5 TB/year at 10KB/row; calendar event cache ~500 GB for 1M users; meeting type configs ~25 GB
- The punchline: peak *write* load is 50 RPS. This system's booking path never needs to scale writes — it needs to be *correct*. All scaling energy goes to the 5,000 RPS read path.

For contrast, at production scale a payments system or a chat app measures success in write throughput; this one measures success in read-cache hit rate and in a write-side counter that must stay at zero. That's an unusual profile to design for, and it's worth naming explicitly before diving into components, because it inverts where the interesting engineering lives — not in sharding writes, but in guaranteeing correctness on a write path that's almost leisurely by comparison.

## 🏗️ High-Level Architecture

```
┌───────────────┐          ┌───────────────┐
│    Invitee    │          │     Host      │
│ (public page) │          │ (dashboard)   │
└───────┬───────┘          └───────┬───────┘
        └────────────┬─────────────┘
                     ▼
┌─────────────────────────────────────────────────┐
│        API Gateway / Load Balancer              │
│    (rate limiting, TLS, session validation)     │
└──────────┬──────────────┬──────────────┬────────┘
           ▼              ▼              ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │ Availability│ │   Booking   │ │ Integration │
   │   Service   │ │   Service   │ │   Service   │
   │ (read-heavy,│ │ (write path,│ │ (OAuth, cal │
   │  cached)    │ │  locking)   │ │  sync)      │
   └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
          │               │               │
    ┌─────┴───────┬───────┴─────┬─────────┴──────┐
    ▼             ▼             ▼                ▼
┌─────────┐ ┌──────────┐ ┌───────────┐ ┌────────────────┐
│  Redis  │ │PostgreSQL│ │ RabbitMQ  │ │ Google / MS    │
│ avail.  │ │ primary  │ │ notifs,   │ │ Calendar APIs  │
│ cache,  │ │ + read   │ │ reminders,│ │ (webhooks +    │
│ sessions│ │ replicas │ │ DLQ       │ │  polling)      │
│ idempot.│ └──────────┘ └─────┬─────┘ └────────────────┘
└─────────┘                    ▼
                       ┌───────────────┐
                       │ Notification  │
                       │ Workers (xN)  │
                       └───────────────┘
```

The read path (availability) and write path (booking) are separated on purpose: they have opposite requirements. Availability tolerates minutes of staleness and gets cached ruthlessly; booking tolerates zero inconsistency and gets a fully serialized transaction. Mixing their code paths invites someone to "optimize" the booking check with cached data — the one bug this system must never have.

## 💾 Data Model

| Table | Key Columns | Indexes | Notes |
|-------|-------------|---------|-------|
| users | id (UUID PK), email, password_hash, name, time_zone (IANA), role | unique on email | IANA zone, not a UTC offset — offsets break on DST |
| meeting_types | user_id (FK), name, slug, duration_minutes, buffer_before/after_minutes, max_bookings_per_day, is_active | unique (user_id, slug) | Slug drives public URLs; buffers are per-type, not per-host |
| availability_rules | user_id, day_of_week (0–6), start_time, end_time, is_active | (user_id, day_of_week, is_active) | Weekly recurring template; CHECK end > start |
| bookings | meeting_type_id, host_user_id, invitee_name/email, start_time, end_time (both UTC), invitee_timezone, status, version, idempotency_key | see below — the interesting ones | Status: confirmed → completed / cancelled |
| bookings_archive | same shape, no FKs, plus archived_at | (host_user_id, start_time) | Completed/cancelled >90 days move here nightly |
| calendar_integrations | user_id, provider, encrypted tokens, sync cursor, last_synced_at | user_id | Tokens encrypted at rest; cursor for incremental sync |
| email_notifications | booking_id, recipient, type, status, sent_at | booking_id | Audit trail of every send attempt |

**The two indexes that carry the system:**

- **Partial unique index on (host_user_id, start_time) WHERE status = 'confirmed'** — the database-level double-booking backstop. Partial, because a cancelled booking must free its slot: uniqueness applies only to confirmed rows, so cancel-then-rebook works without deleting history.
- **Unique index on idempotency_key (where not null)** — the durable half of retry protection.

Two modeling calls worth defending:

**Archive table has no foreign keys.** Historical bookings must survive the deletion of their meeting type or even their host account (GDPR delete of the host shouldn't vaporize the invitee's record of a meeting that happened). Denormalized, FK-free archive rows make retention policy independent of live-data lifecycle.

**version column on bookings.** Reschedule and cancel are compare-and-swap updates on the version. Two people acting on the same booking simultaneously (host cancels while invitee reschedules) can't silently overwrite each other — the second writer gets a 409 and re-reads. Cheap insurance for a rare but confusing race.

## 🔌 API Design

```
Public (invitee, unauthenticated)
  GET    /:username/:slug              → Booking page data (meeting type, host TZ)
  GET    /api/availability/slots       → Available slots for date range (UTC timestamps)
  POST   /api/bookings                 → Create booking (idempotency key required)
  PUT    /api/bookings/:id/reschedule  → Reschedule (signed link from email)
  DELETE /api/bookings/:id             → Cancel (signed link from email)

Host (session-authenticated)
  POST   /api/meeting-types            → Create meeting type
  POST   /api/availability/rules       → Set weekly schedule
  GET    /api/bookings                 → Host's bookings
  GET    /api/integrations/google/oauth → Start calendar OAuth
  POST   /api/integrations/:id/sync    → Force calendar re-sync
```

Contract decisions:

- **Slots API returns UTC timestamps only**, never pre-localized strings. The client converts using the invitee's detected zone. This means switching the timezone dropdown re-renders instantly with no refetch, and the server never encodes anyone's locale assumptions into data.
- **Public booking URLs carry an entropy suffix** (`/john-doe/30min-x7k2m9`) — human-readable but not enumerable, so competitors can't crawl every host's calendar.
- **Invitee reschedule/cancel links are signed tokens in email**, not authenticated sessions — invitees have no accounts, so capability URLs are the auth model, scoped to one booking each.

## 🔧 Deep Dive 1: Double-Booking Prevention Under Concurrency

The scenario: Alice and Bob both see the 2:00 PM slot, both click Book within 50ms. Exactly one must succeed, and the loser must get a clean, immediate answer.

**The layered defense, innermost layer last:**

1. **Idempotency key check** (Redis) — catches the same *user's* retry: double-click, network retry, load-balancer replay. Returns the original result, doesn't touch the booking logic.
2. **Row-level lock**: the booking transaction takes SELECT FOR UPDATE on the host's confirmed bookings overlapping the requested window — serializing concurrent booking attempts against the same host.
3. **Explicit overlap check** inside the lock: full interval-overlap logic including buffer times, not just exact-start-time matching.
4. **Partial unique index** on (host, start_time) for confirmed rows — the constraint of last resort. If an application bug ever skips layers 2–3, the database still refuses the second insert.

**Why pessimistic locking rather than optimistic:**

> "Optimistic concurrency looks attractive — no locks, faster happy path. But look at how conflicts distribute in scheduling: they're not uniform, they're *pathologically clustered*. Everyone wants Monday 10 AM; nobody is fighting over Thursday 4:45. When a popular host opens office hours and fifty people converge on the same slot, optimistic locking means one success and forty-nine aborted transactions that each re-read, re-check, and re-fail — a retry storm generating more database load than the contested resource is worth, plus complex client-side error handling. Pessimistic locking serializes those fifty attempts: each waits a few milliseconds for the row lock, the first inserts, and the remaining forty-nine fail the overlap check *cleanly, inside the transaction*, getting an immediate 409 with alternative slots. The cost is 10–20ms of lock latency on every booking — at 50 bookings/sec peak, lock contention on any single host's rows is negligible because the lock is per-host, not global. I'm paying a fixed, small latency tax to eliminate a tail-risk retry storm. For a write path that peaks at 50 RPS, latency was never the constraint; correctness and clean failure were."

**What we give up**: lock waits mean a slow transaction on one host briefly queues other bookings *for the same host*. Bounded by a statement timeout so a stuck transaction can't wedge a host's calendar for more than a second.

**The booking transaction end to end:**

```
Client                API                 Redis              PostgreSQL
  │  POST /bookings ──▶│                    │                    │
  │  (idempotency_key) │── check key ──────▶│                    │
  │                     │◀── miss ───────────│                    │
  │                     │── acquire lock ───▶│                    │
  │                     │── BEGIN ───────────────────────────────▶│
  │                     │── SELECT rules ────────────────────────▶│
  │                     │── SELECT bookings FOR UPDATE ───────────▶│ (row lock)
  │                     │── overlap check (app logic) ────────────│
  │                     │── INSERT booking ──────────────────────▶│ (unique index guards)
  │                     │── COMMIT ──────────────────────────────▶│
  │                     │── cache result, release lock ──▶│        │
  │                     │── publish notification ─────────────────│ (async, post-commit)
  │◀── 201 Created ─────│                    │                    │
```

Notification publish happens *after* commit, never inside the transaction — a slow or down queue must never roll back a successful booking.

**Why the redundant unique index if the lock already serializes?**

> "Because the lock only protects code paths that take it. The constraint protects against the paths nobody planned: a new bulk-import endpoint written next year, an admin fix-up script, a subtle bug where someone queries the replica inside the transaction. Application discipline decays; schema constraints don't. The index costs nothing measurable and converts 'we believe no double-bookings are possible' into 'the database will not store one.'"

## 🔧 Deep Dive 2: Availability Calculation and the Caching Boundary

Computing a day's slots means merging three busy-source streams and generating gaps:

1. Fetch the host's availability rules for that weekday (the "open" windows)
2. Fetch confirmed bookings overlapping the day
3. Fetch cached external calendar events
4. Merge all busy periods into a sorted, non-overlapping interval list — classic interval merge, linear after sort
5. Subtract busy from open; expand buffer times around each busy block (a 30-min meeting with 15-min buffers blocks an hour)
6. Emit slots at the meeting type's duration granularity; enforce max-per-day caps and minimum-notice windows

Result cached in Redis per (host, meeting type, date) with a 5-minute TTL.

**Why 5-minute TTL plus event-driven invalidation, defended against both neighbors:**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ 5-min TTL + invalidate on change | Fresh enough for browsing; absorbs the 100:1 read ratio | Invalidation logic to maintain |
| ❌ No cache | Always accurate | 5,000 RPS of multi-query interval math crushes Postgres |
| ❌ 1-hour TTL | Higher hit rate | Slots booked 45 min ago still show available — invitees fill out the form and *then* get rejected |
| ❌ Precompute everything nightly | Fastest reads | Stale within minutes of any booking; wasted compute for the long tail of hosts who get zero bookings |

> "The number that makes this work is the booking-time re-check. The cache is a *browsing hint*, never a *booking authority* — the booking transaction re-derives conflicts from the primary inside the lock. That means cache staleness can never cause a double-booking; it can only cause a friendly 'that slot was just taken' with fresh alternatives. Once staleness is demoted from a correctness problem to a UX annoyance, the TTL becomes a pure tuning knob, and 5 minutes matches a browsing session. On any state change for a host — booking created, cancelled, rules edited, calendar synced — I delete all of that host's availability keys. Aggressive over-invalidation is deliberate: a spurious cache miss costs one recomputation; a stale hit costs an invitee a form-filling dead end."

**Time zone discipline** runs through this path end to end: rules are stored as local times against the host's IANA zone (a 9-to-5 rule must *stay* 9-to-5 across a DST shift, so it can't be stored in UTC); bookings are stored in UTC (an instant in time is an instant); conversion happens exactly once, at slot generation, using the zone database. The DST edge cases — the nonexistent 2:30 AM on spring-forward day, the ambiguous 1:30 AM on fall-back day — surface only in slot generation, where skipping or disambiguating them is a contained, testable rule rather than data corruption.

## 🔧 Deep Dive 3: Calendar Integration — Syncing Against Someone Else's API

External calendars inject events the host didn't create in our system, and our bookings must appear on their external calendar. Both directions fail in interesting ways.

**Inbound sync (their events → our availability): hybrid push + poll.**

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Webhooks + 10-min polling fallback | Near-real-time when healthy; bounded staleness when not | Two mechanisms to run |
| ❌ Polling only | Simple, predictable quota | 10-min floor on staleness; wasteful for idle calendars |
| ❌ Webhooks only | Real-time, minimal API calls | Silent failure mode: one dropped notification → stale for days |
| ❌ Fetch on every availability request | Always fresh | +200–500ms per request; 43M checks/day obliterates API quotas |

> "Webhooks fail *silently* — that's the property that disqualifies webhooks-only. A dropped notification doesn't error; it just means we never learn about the dentist appointment, and we cheerfully offer that slot until the host notices a conflict. The polling fallback converts an unbounded staleness into a bounded one: worst case, we're 10 minutes behind. And the booking-time story mirrors the cache story — availability built from calendar data is a hint. The residual risk window (external event created < 10 minutes before someone books that exact slot) produces a conflict on the *host's* calendar, which the sync flags for manual resolution. That's rare enough to handle with an apology email rather than architecture."

**Outbound (our booking → their calendar): asynchronous, after commit.**

The booking transaction commits *without* waiting on Google. Event creation is a queued job with retries. The alternative — creating the external event inside the booking flow — couples our core write path's availability to a third party's uptime: Google has a bad five minutes and we can't take bookings at all. Decoupled, the failure mode is "calendar event appears a few minutes late," which nobody notices. The job is idempotent (external event tagged with the booking ID; re-runs update rather than duplicate).

**Token hygiene**: OAuth refresh tokens encrypted at rest; refresh handled centrally in the integration service with per-provider rate-limit budgets; a circuit breaker per provider (3 consecutive failures → open, 30s half-open probe) so a provider outage degrades to cached calendar data instead of stacking up timed-out requests.

**Reschedule and cancel follow the same asymmetric-trust pattern as booking.** Rescheduling is modeled as cancel-plus-rebook inside one transaction — not a mutate-in-place update — because rebooking re-runs the full double-booking gauntlet (lock, overlap check, unique index) against the *new* time, while the old slot's confirmed-status flip frees it atomically in the same commit. Modeling it as two independent operations (delete then insert) would create a window where the slot briefly shows free to a third party's concurrent read; doing both inside one transaction means no external observer ever sees the intermediate state. Cancellation triggers the same async notification path as booking creation, plus optionally frees the slot for someone in a waitlist — a feature I'd design as a Redis-backed per-slot subscriber list, notified via the same queue infrastructure, so it costs no new operational surface.

## 🔐 Security and Abuse Defense

The booking endpoint is unusual for a write path: it's **public and unauthenticated by design** — invitees have no accounts. That inverts the normal security posture, where writes are the trusted side.

- **Rate limiting, tiered by risk**: auth endpoints 10 req/min (credential stuffing), booking POST 10 req/min per IP+email combination (slot-exhaustion abuse — a bad actor could otherwise script-book every open slot on a competitor's calendar to deny real customers), availability GET more permissive at 30 req/min since it's cache-absorbed anyway
- **Capability URLs for reschedule/cancel**: signed tokens scoped to exactly one booking, emailed to the invitee — no account, no password, no broader access than that single action
- **Encrypted calendar tokens at rest**: OAuth refresh tokens are the keys to a host's real calendar; a database leak must not become a calendar-access leak
- **PII discipline in logs**: invitee emails masked in structured logs — the booking audit trail lives in the database with proper access control, not in grep-able log aggregation
- **RBAC**: two roles suffice — `user` manages their own meeting types/availability/bookings, `admin` adds platform statistics and user management. A scheduling product doesn't need fine-grained permissions beyond "is this your calendar"

## 🛡️ Consistency, Idempotency, and Failure Handling

**Idempotent booking creation, the full flow:**

1. Key arrives via header, or is derived from (meeting_type, start_time, invitee_email) — so even clients that forget the header get natural-key protection
2. Redis fast path: key seen → return the stored result immediately
3. Short distributed lock on the key prevents two *concurrent* requests with the same key from both entering the transaction
4. Booking processes; result cached in Redis (1h TTL); key also written to the bookings row for durable audit
5. The DB unique index on idempotency_key backstops the case where Redis lost the key

**Optimistic locking for mutations**: reschedule/cancel are version-checked updates; a version mismatch returns 409 and the client re-reads. Cancel is also naturally idempotent — cancelling a cancelled booking is a no-op success.

**Notification pipeline**: booking events publish to RabbitMQ (persistent messages, durable queues); workers consume with prefetch 1; failures retry with backoff; exhausted retries land in a dead-letter queue that alerts a human. Reminders are scheduled messages with a TTL equal to the time until send — the queue itself becomes the delay mechanism, no separate scheduler service needed. The email provider being down never blocks a booking — the user cares about the confirmation screen, not SMTP timing.

> "I chose async delivery specifically because the failure domains are so different. A booking is a database transaction with well-understood failure modes — lock timeout, constraint violation, connection loss — all things Postgres and the application handle every day. Email delivery depends on a third party's SMTP relay, DNS, spam filtering, and network path, none of which the booking's correctness should depend on. Coupling them means Calendly's uptime becomes bounded by SendGrid's uptime, which is backwards: the booking is the product, the email is a courtesy notification about it. Decoupling costs a queue to operate and a DLQ to monitor, and introduces the question 'did the email actually send' as a separate observable fact from 'did the booking succeed' — which is exactly the right question to be asking anyway, since a booking without a confirmation email is a *support ticket*, not a *lost booking*."

**Degradation table:**

| Failure | Behavior | Why acceptable |
|---------|----------|----------------|
| Redis down | Sessions fall back to Postgres table; availability computed uncached (slower) | Correctness never lived in Redis |
| RabbitMQ down | Health check reports degraded (not down); notifications buffer and retry on reconnect | Bookings proceed; emails arrive late |
| Calendar API down | Circuit breaker open; availability uses cached events; banner warns host of possible staleness | Booking re-check still guards the invariant |
| Read replica down | Reads fail over to primary | Headroom exists — reads are cache-absorbed |
| Postgres primary down | Bookings stop — full stop | This is the true SPOF; hot standby + fast failover is the mitigation, not a workaround |

The ordering encoded in that table: protect the booking transaction above everything, degrade freshness before degrading function, and never let an auxiliary system's failure propagate into the write path.

**The consistency budget, spent deliberately:**

| Data | Bar | Mechanism |
|------|-----|-----------|
| Booking creation/cancellation | Strong, zero tolerance | Row locks + partial unique index inside one transaction |
| Availability shown while browsing | Minutes-stale acceptable | Redis cache, re-verified at booking time |
| External calendar events | ~10-min-stale acceptable | Webhook + polling fallback |
| Notification delivery | Eventually, with retry | Durable queue + DLQ, no ordering guarantee needed |
| Session state | Strong per-request, revocable | Redis-backed, Postgres fallback |

Naming the budget this explicitly matters in an interview: it shows the consistency requirement was *derived* from what breaks the product (a double-booking) versus what merely annoys a user (a slightly stale slot list), rather than applied uniformly out of caution.

## 📊 Observability

| Signal | Why it matters |
|--------|----------------|
| double_booking_prevented counter | Constraint-layer rejections. Nonzero means an upper layer has a bug — page on it. Zero forever is the goal |
| Booking creation latency histogram | The p99 < 500ms promise; lock-wait growth shows here first |
| Availability cache hit rate | Below ~70%, the database starts feeling the 100:1 ratio directly |
| Notification queue depth + DLQ size | Queue > 500 is critical; DLQ growth means a systematic send failure, not random flakes |
| Calendar sync lag per integration | Staleness of the webhook+poll pipeline, per provider |
| Circuit breaker states | Which third party is currently degrading us |
| DB pool waiting count | Pool exhaustion is how lock pileups become an outage |

Structured logs carry a correlation ID from HTTP request through transaction to queued notification, so one booking's full lifecycle is a single query in the log system. Health checks are tiered — a fast liveness probe, a readiness probe checking DB/Redis/RabbitMQ in parallel, and a detailed endpoint exposing pool sizes and breaker states for debugging — with RabbitMQ specifically allowed to be "degraded" rather than "unhealthy," since a paused notification queue is a real problem but not one that should pull booking traffic off an otherwise-healthy instance.

## 🗄️ Data Lifecycle

Not a compliance afterthought — it's what keeps the hottest table fast:

| Data | Retention | Mechanism |
|------|-----------|-----------|
| Active bookings | Until completed/cancelled | Live in the primary `bookings` table, fully indexed |
| Completed/cancelled bookings | 90 days in the active table | Kept for reschedule-from-history and dispute resolution |
| Archived bookings | 2 years | Nightly job moves rows to `bookings_archive` (no FKs, denormalized) |
| Availability cache | 5 minutes | TTL expiry; also explicitly invalidated on write |
| Idempotency keys | 1 hour | TTL expiry — long enough to catch client retries, short enough to bound Redis memory |
| Sessions | 24 hours | TTL expiry; Postgres fallback table on Redis outage |

The archival job runs nightly: insert matching rows into the archive table, delete from the active table, both inside one transaction so a crash mid-job never loses or duplicates a record. Keeping the active `bookings` table to roughly 90 days of live data is what keeps the double-booking overlap query fast forever — that query scans a bounded, consistently-sized working set no matter how many years the platform has been running.

## 📈 Scalability: What Breaks First

1. **First: the availability read path.** 5,000 RPS of interval computation is the load the system actually feels. It breaks in two stages: cache misses pressure Postgres (fix: read replicas for the availability queries — staleness there is already tolerated by design, so replica lag is free); then cache key cardinality grows with hosts × meeting types × dates (fix: shard Redis; keys are naturally partitionable by host).

2. **Second: calendar sync quota.** More integrations mean more polling; provider quotas are fixed. Fix: sync frequency proportional to booking activity — a host receiving daily bookings syncs every 10 minutes, a dormant host daily. Priority queue, not uniform schedule.

3. **Third: the bookings table.** Not write throughput — 50 RPS peak never threatens Postgres — but *bloat*: index depth and vacuum cost grow with years of rows. Fix: the 90-day archival job already in the design, then monthly range partitioning so the active partition stays small and hot.

4. **What deliberately never shards: the booking write path.** All conflict logic for one host lives in one database with real transactions. If growth ever demands sharding, the shard key is host_user_id — every locking decision is per-host, so host-sharding preserves the invariant with zero cross-shard coordination. That's the escape hatch, and the schema is already shaped for it.

**The scaling sequence I'd actually execute, in order:**

1. Read replicas for availability queries — the biggest lever, since 5,000 RPS is almost entirely reads
2. Redis cluster sharding once availability key cardinality outgrows a single node
3. Monthly range partitioning on `bookings`, paired with the archival job already described
4. Priority-queued calendar sync once integration count makes uniform 10-minute polling exceed provider quotas
5. Host-sharded PostgreSQL only if a single primary's write capacity is ever actually threatened — which, given the 50 RPS peak, is a "years away, if ever" concern rather than a launch-blocking one

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Booking concurrency | ✅ Pessimistic per-host locking | ❌ Optimistic + retries | Conflicts cluster on popular slots; clean 409 beats retry storms |
| Last-resort integrity | ✅ Partial unique index | ❌ Trust application layers | Constraints outlive code discipline |
| Availability freshness | ✅ 5-min cache + booking-time re-check | ❌ Longer TTL / no cache | Staleness demoted to UX; correctness stays transactional |
| Calendar sync | ✅ Webhooks + polling fallback | ❌ Either alone | Bounds the silent-failure staleness window at 10 min |
| External event creation | ✅ Async post-commit job | ❌ In booking transaction | Third-party uptime never gates our write path |
| Time storage | ✅ UTC instants + IANA rules | ❌ Host-local timestamps | Rules survive DST; instants stay unambiguous |
| Notifications | ✅ Queue + DLQ | ❌ Synchronous SMTP | Booking latency decoupled from email infrastructure |
| Sessions | ✅ Redis + Postgres fallback | ❌ JWT | Revocation, and a degraded mode that still works |

## 📉 Observability in Practice: Alerting Thresholds

Concretely, the alerts I'd wire on day one:

| Alert | Condition | Severity |
|-------|-----------|----------|
| Double booking prevented | count > 0 | Critical — page immediately, this should be structurally impossible |
| Booking latency | p95 > 500ms | Warning — lock contention or DB pressure building |
| Availability cache hit rate | < 70% | Warning — read path load about to hit Postgres directly |
| Notification DLQ growing | > 10 messages | Warning — systematic send failure, investigate the provider |
| Notification queue depth | > 500 messages | Critical — workers falling behind or crashed |
| DB connection pool waiting | > 0 | Warning — leading indicator of lock pileup becoming visible latency |

The double-booking alert deserves the strongest treatment in the whole system: it is the one metric whose healthy value is always exactly zero, and any deviation means the core promise of the product just broke for a real customer.

## 🚀 Closing: What I'd Build Next

With more time I'd extend along four lines:

- **Round-robin and collective team scheduling** — the availability algorithm generalizes cleanly to intersecting multiple hosts' free sets, but fairness in round-robin assignment (weighted by recent load, not pure alternation) is a genuinely new component with its own consistency requirements
- **Recurring bookings**, which turn the double-booking check into a series-conflict check with partial-failure semantics — "8 of 10 requested sessions are available, book those and flag the other 2?" rather than an all-or-nothing transaction
- **No-show tracking and host analytics** — closing the loop from "booking created" to "meeting actually happened," which needs a lightweight signal (calendar event join, host confirmation) and feeds directly back into max-bookings-per-day tuning for hosts who get burned by no-shows
- **Deeper abuse defense on the public booking endpoint** — it's an unauthenticated write path by necessity, so bot-driven slot exhaustion (scripting fake bookings to deny a competitor's real customers) warrants CAPTCHA-on-anomaly, email verification holds before a booking counts as confirmed, and per-IP/per-invitee velocity limits layered on top of the rate limiter already described — the kind of adversarial thinking a public scheduling surface eventually can't skip
