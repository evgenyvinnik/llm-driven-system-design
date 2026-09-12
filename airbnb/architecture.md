# Airbnb — Architecture

## System Overview

Design a vacation rental marketplace in which guests discover properties, choose
stay dates, and make instant or host-approved reservations. Hosts manage inventory
and requests; both parties communicate and review completed stays. The main
learning goals are geographic retrieval, inventory consistency, date semantics,
and dependable workflows across a database and asynchronous consumers.

The first part describes a **proposed production design**, not Airbnb's internal
architecture or a claim that this repository implements every component. Database
Schema and API Design identify the local contract. The final Implementation Notes
trace the checked-in Express/React application and its material limitations.

## Requirements

### Functional requirements

- Search by destination, date range, guest count, property attributes and price.
- Display listing information, photos, calendar constraints and an itemized quote.
- Support instant reservations and requests that await a host response.
- Let hosts change future availability without invalidating committed stays.
- Support cancellation, completed-stay reviews and participant-only messaging.
- Recover reservation outcomes after timeouts and deliver downstream events eventually.

Payments are an explicit extension of this proposed design. The local application
only calculates and stores booking amounts; it does not collect, hold or refund money.

### Non-functional requirements

These are design targets, not benchmark results:

| Requirement | Proposed target or invariant |
|-------------|------------------------------|
| Search | p95 below 500 ms for a bounded query; explicit degraded response on failure |
| Booking decision | p99 below 1 second for the database decision, excluding external payment latency |
| Availability | 99.9% search service availability; booking writes fail closed if authority is unavailable |
| Inventory | No overlapping active reservations for one independently bookable listing |
| Recovery | A retried operation with the same identity resolves to the same logical outcome |
| Privacy | Only authorized participants access private booking and conversation details |
| Freshness | Measure projection lag and revalidate inventory at commitment |

A pending request also consumes inventory in this design. Its expiry deadline and
host-response policy must be specified; otherwise pending requests can block a
property indefinitely.

## Capacity Estimation

Assume 10 million listings, 5 million daily searchers and 20 queries per searcher.
That is 100 million queries/day, roughly 1,160/second on average, with a planning
peak of 10,000/second. Assume 500,000 reservation attempts/day, roughly 6/second
on average and a 100/second peak. These figures size different paths; they are not
actual usage statistics or a conversion forecast.

At ten 300 KB delivery images per listing, image payloads alone total about 30 TB,
excluding originals and variants. Image delivery belongs behind a CDN. Search
pressure will concentrate on a few destinations and dates rather than spread evenly.

Availability storage depends on host behavior. One row per listing-night over a
year produces 3.65 billion rows. Interval storage can be much smaller when adjacent
nights share a state, but daily price changes can erase that advantage. There is
no fixed compression ratio independent of the data.

### Local Development Scale

Compose runs one PostgreSQL/PostGIS, one Valkey and one RabbitMQ instance. The seed
creates eight listings. The API has a 20-connection PostgreSQL pool per process;
three API processes can therefore request up to 60 connections before workers.
No local load test or resource benchmark was performed for this documentation review.

## High-Level Architecture

```
┌───────────────┐       ┌────────────────────┐       ┌─────────────────┐
│ Web / Mobile  │──────▶│ CDN / API Gateway  │──────▶│ Search service  │
└───────────────┘       └─────────┬──────────┘       └────────┬────────┘
                                │                           ▼
                    ┌───────────▼──────────┐       ┌─────────────────┐
                    │ Listing / Booking   │       │ Search projection│
                    │ services            │       │ + read caches   │
                    └───────────┬──────────┘       └────────▲────────┘
                                ▼                           │
                    ┌──────────────────────┐       ┌────────┴────────┐
                    │ PostgreSQL authority │──────▶│ Outbox relay /  │
                    │ + transactional outbox│       │ event broker    │
                    └──────────────────────┘       └────────┬────────┘
                                                           ▼
                                                  ┌─────────────────┐
                                                  │ Notifications / │
                                                  │ analytics       │
                                                  └─────────────────┘
```

Object storage supplies CDN images. Session storage supports authenticated APIs.
Messaging and reviews can begin as modules with separate tables and later receive
independent deployments. Logical ownership matters before deployment count.

Search projections serve discovery. The listing's authoritative database owner
makes inventory decisions; neither a cached calendar nor a search index can commit
a booking. Multi-region routing must preserve that single write authority.

## Core Components / Request Flows

### Discovery and listing details

Resolve the destination to a geographic area, retrieve nearby active listings,
apply filters, and rank a bounded candidate set. Start with PostgreSQL/PostGIS;
introduce an independent search projection when load or relevance requirements
justify its synchronization and operational costs.

Return stable listing IDs, the applied query identity, pagination information and
freshness/degradation metadata. Public listing data and personalized attributes
need distinct cache treatment. Fetching details should not expose private addresses
merely because they exist in the stored listing row.

The browser keeps draft filters separate from the applied URL query. Responses
must match the query that produced them; cancelling a request alone is insufficient
protection against an already completed older response updating the screen.

### Quote and reservation

1. Validate civil dates, party size, listing state and stay rules on the server.
2. Calculate an itemized quote using a defined currency and rounding policy.
3. Give the quote an identity and validity deadline; it does not reserve inventory.
4. On submission, resolve the client's idempotency key and validate the quote.
5. Lock the listing, inspect current inventory and create the booking plus its occupied interval.
6. Commit the outcome, idempotency record and outbox event in one database transaction.
7. Return the durable booking ID and its current state; publish downstream work afterward.

All paths that change inventory must acquire the same listing lock in a consistent
order, then validate the current booking state inside that transaction. This includes
host responses, cancellations, calendar edits, expiry and operational repairs.
A database range exclusion constraint is a possible second line of defense, not a
replacement for correct lifecycle transitions.

If payment is introduced, create a bounded inventory hold, commit, and contact the
processor outside database locks. Persist and reconcile payment attempts separately.
A late successful authorization must not confirm an expired/reallocated hold; the
workflow must resolve it through the chosen compensation policy.

### Date boundaries and host calendar changes

Use date-only values in the property's calendar and a half-open stay interval:
check-in is included, checkout is excluded. September 10–12 occupies the nights
of the 10th and 11th; a second stay can begin on the 12th. PostgreSQL `OVERLAPS`
uses half-open periods for nonzero intervals. [PostgreSQL date/time documentation](https://www.postgresql.org/docs/16/functions-datetime.html)

Keep host pricing/availability rules distinct from reservation occupancy. An edit
that changes a September 1–20 rule over September 10–12 preserves September 1–10
and September 12–20. Merge neighboring rules only when their relevant attributes
match. Reject an edit that would overwrite occupied inventory.

Use one date representation across parsing, comparisons and serialization. Dividing
elapsed milliseconds by 24 hours is not a general way to count civil nights across
time-zone or daylight-saving boundaries.

### Messages and reviews

A conversation belongs to verified participants and, when supplied, a matching
listing/booking relationship. Message IDs and bounded pagination enable retries,
reconnection and read markers without reloading an entire history.

For reviews, choose a product policy explicitly: reveal after both submissions or
a fixed deadline, with a defined submission window. Enforce uniqueness per booking
and author role. Serialize the reveal decision or run an idempotent repair job so
simultaneous submissions cannot remain hidden indefinitely.

## Database Schema

The complete **implemented** schema is maintained in
[backend/src/db/init.sql](./backend/src/db/init.sql); it is the authoritative DDL.
The following table summarizes its important relationships and constraints.

| Table | Important columns and relationships | Existing indexes / constraints |
|-------|------------------------------------|--------------------------------|
| `users` | Integer ID, unique email, password hash, host/verified flags, user/admin role | Email uniqueness, role check |
| `listings` | Host FK, address, latitude/longitude and geographic location, capacity, amenities, flat price and stay rules | GiST location index; host, price and active indexes |
| `listing_photos` | Listing FK, URL, caption, display order | Listing index; cascade with listing |
| `availability_blocks` | Listing FK, DATE start/end, available/blocked/booked status, optional price and booking FK | Positive interval check; listing/start/end and status indexes |
| `bookings` | Listing/guest FKs, DATE check-in/out, party size, captured amounts, status and cancellation metadata | Positive interval check; listing, guest, dates and status indexes |
| `reviews` | Booking/author FKs, host/guest author type, ratings, text and visibility | Unique booking/author type; rating checks |
| `conversations` | Listing, booking, host and guest relationships | Host and guest indexes; no unique conversation identity |
| `messages` | Conversation/sender FKs, content, read flag and timestamps | Conversation and sender indexes |
| `sessions` | Session ID, user FK and expiry | User and expiry indexes |
| `audit_logs` | Actor, event, resource, before/after JSON, request/session context and outcome | Event, actor, resource, time and request indexes |

Schema triggers maintain update timestamps, reveal paired reviews, and
update listing ratings from visible guest reviews. The schema does **not** contain
an exclusion constraint against overlapping inventory, booking idempotency records,
a transactional outbox, payment records, or the analytics/notification tables
referenced by the workers.

For production, add explicit operation identity, booking version, deadline and
currency semantics. Store price components with exact decimal arithmetic or currency
minor units; avoid silently mixing currencies or floating-point rounding rules.
Maintain booking history even after a listing is removed.

PostgreSQL range types support overlap indexing and exclusion constraints. An
occupancy-only table with a listing key and date range is a candidate design;
ordinary available-price rules should not conflict with occupied intervals in the
same constraint. [PostgreSQL range documentation](https://www.postgresql.org/docs/16/rangetypes.html)

## API Design

The **implemented** prefix is `/api`, not `/api/v1`. Routes are mounted in
[backend/src/index.ts](./backend/src/index.ts).

| Method | Path | Actual purpose |
|--------|------|----------------|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/logout` | Account/session operations |
| GET | `/api/auth/me` | Current user |
| POST / PUT | `/api/auth/become-host` / `/api/auth/profile` | Host enrollment / profile update |
| GET | `/api/search` | Geographic/filter search and total count |
| GET | `/api/search/suggest`, `/api/search/popular-destinations` | Suggestions from stored listings |
| GET / POST | `/api/listings` | Browse / create listing |
| GET | `/api/listings/host/my-listings` | Owned listings |
| GET / PUT / DELETE | `/api/listings/:id` | Listing detail / update / removal |
| POST / DELETE | `/api/listings/:id/photos` / `/api/listings/:id/photos/:photoId` | Upload / remove photo metadata |
| GET / PUT | `/api/listings/:id/availability` | Read / change calendar blocks |
| GET | `/api/bookings/check-availability` | Current conflict check and calculated price |
| POST | `/api/bookings` | Create pending or confirmed booking and block |
| GET | `/api/bookings/my-trips`, `/api/bookings/host-reservations`, `/api/bookings/:id` | Participant booking views |
| PUT | `/api/bookings/:id/respond`, `/api/bookings/:id/cancel`, `/api/bookings/:id/complete` | Lifecycle changes |
| POST | `/api/reviews` | Submit completed-booking review |
| GET | `/api/reviews/listing/:listingId`, `/api/reviews/user/:userId`, `/api/reviews/booking/:bookingId/status` | Visible reviews / participant submission status |
| POST / GET | `/api/messages/start` / `/api/messages` | Start / list conversations |
| GET / POST | `/api/messages/:id` / `/api/messages/:id/messages` | Read conversation / send message |
| GET | `/api/messages/unread/count` | Unread message count |

For example, the existing search accepts `latitude`, `longitude`, `radius`,
`check_in`, `check_out`, `guests`, filters, `sort`, `limit` and `offset`.
Its normal result contains listings, total, limit and offset. A booking submission
supplies listing ID, dates, guests and an optional message; the server calculates
the amount and returns the created booking.

Production extensions would add quote and operation-status resources, bounded
pagination, consistent validation and typed conflict/degradation responses. A timeout
must not force clients to invent a second booking identity to discover the first outcome.

## Key Design Decisions

### Shared inventory authority versus independent availability caches

A property is indivisible inventory over a date interval. Listing-scoped transactions
make concurrent requests for that property observe a serial sequence while allowing
different properties to proceed independently. They also give calendar edits and
cancellations one place to enforce the invariant.

Checking a Redis calendar and then inserting a booking leaves a gap in which another
request can pass the same check. A TTL-based lock adds lease-expiry and ownership
problems unless every writer honors it. The database already owns the durable state,
so it is the simpler first authority.

The cost is contention for popular properties and dependency on the owning database.
Bound transaction time, avoid network calls under locks, and reject/retry overload
with limits. During a partition, preserve inventory correctness even if that prevents
accepting a booking in the disconnected region.

### Geographic retrieval versus immediate global search synchronization

PostGIS can combine geographic filtering and relational attributes without maintaining
a second search system. Start there and measure representative dense-city queries.
A spatial index narrows candidates; it does not make arbitrary filters, ranking,
large offsets or exact counts free.

A separate search engine becomes useful for independently scaling retrieval and
richer relevance. The cost is stale additions/removals and a repairable indexing
pipeline. Revalidate a candidate's availability before commitment regardless of
which search technology returns it. Empty inventory and failed search are different
responses; hiding the latter damages both UX and error monitoring.

### Transactional outbox versus best-effort post-commit publishing

Booking confirmation should survive a temporarily unavailable notification service.
Write the booking and an event in the same database transaction, then relay events
to the broker with publisher confirmation and retry. Relays can publish twice if
they crash after broker acceptance but before marking an event delivered.

Each consumer therefore owns a deduplication identity such as consumer name plus
event ID. For database effects, commit the marker and effect together. External
providers require their own idempotency/reconciliation mechanism. This produces
recoverable at-least-once delivery; it does not make every external effect exactly once.

The extra relay, replay tools and lag monitoring are justified by recoverability.
Synchronous publication alone either couples booking availability to the broker or
loses events in the gap after the database commits.

## Consistency and Idempotency

A production operation key is scoped to the authenticated actor and operation type.
Persist a request fingerprint and resulting booking identity. Reusing a key with
different dates or guests is a conflict; retrying the same request returns its outcome.
Concurrent requests with that key converge through a database uniqueness constraint.

Use explicit allowed transitions and expected state/version checks. A cancellation
and host acceptance racing against the same pending request must produce one legal
winner. Expiry workers follow the same rule and release inventory transactionally.
Consumer retries must not recreate occupancy from an old event after cancellation.

The local implementation has no such booking operation record. Its creation lock
protects competing create calls but does not establish correctness across all writers.
See the concrete race in Implementation Notes.

## Security / Auth

Production controls include server-side participant/owner authorization, bounded
input sizes, rate limits on login/search/messages, safe upload validation, protected
private addresses, and redacted audit data. Cookie authentication needs deliberate
CSRF and origin handling alongside HTTP-only/secure cookie settings.

Local authentication uses bcrypt and a UUID cookie backed by Redis and PostgreSQL.
Redis lookup errors do not trigger the PostgreSQL fallback; only a cache miss does.
A fallback session is cached for a fresh seven days without limiting TTL to its
remaining lifetime, and cache hits do not recheck expiry. This can extend server-side
acceptance beyond the database deadline. See
[services/auth.ts](./backend/src/services/auth.ts).

There is no implemented rate limiter or production identity-verification workflow.
Upload middleware writes files before the route's listing-owner check, and extension/
MIME checks are not content validation. Audit context includes raw session IDs,
which are not covered by the configured password/token/cookie redaction paths.

## Observability

Measure search success, empty results, degradation and latency separately. Track
inventory conflicts, transition failures, lock wait time, operation recovery and
pending-age distribution. Downstream correctness needs outbox age, consumer lag,
retry/dead-letter counts and reconciliation discrepancies.

Local [metrics.ts](./backend/src/shared/metrics.ts) exports HTTP, search, booking,
cache and breaker instrumentation. Declaring a metric does not mean every path
updates it: database timing and some gauges lack recording calls. Queue depth is
refreshed by queue-stat collection in `/health`; worker metrics are in separate
processes and are not exposed by the API's `/metrics` endpoint.

The booking revenue counter includes pending booking values and does not represent
collected or net revenue. Pino request logs and database audit records help inspect
flows, but module logs do not automatically inherit every request's correlation
context, and audit writes are separate from the business transaction.

## Failure Handling

| Failure | Proposed behavior | Local limitation |
|---------|-------------------|------------------|
| Search database timeout | Typed unavailable/degraded response | Search breaker returns empty HTTP 200 fallback |
| Cache unavailable | Bounded database fallback for public reads | Cache helpers catch errors; session lookup behaves differently |
| Reservation response lost | Query/retry same operation identity | No booking idempotency or operation lookup |
| Broker unavailable after commit | Outbox retains work | Publication errors are logged; no durable replay source |
| Worker repeatedly fails | Bounded persisted attempts and routed dead letter | Retry header is not incremented on requeue |
| API shutdown | Stop accepting traffic, drain requests, close clients | Shutdown closes queue/Redis and exits without HTTP/pool draining |

`/ready` checks PostgreSQL only. `/live` returns process liveness. `/health` includes
queue diagnostics but its overall result does not establish broker or worker health;
queue stats may be empty when no channel exists. Only the search circuit breaker
is wired to a business path. Availability, database and notification breaker factories
exist but are not protection currently applied to those operations.

## Scalability Considerations

Cache images and public metadata first, then tune PostGIS query plans with realistic
city density and filter combinations. Cap radius, result count, offset and date
horizon. Consider avoiding an exact total when its cost exceeds its UX value.

Move discovery to a projection when measured load warrants it. Partition booking
ownership by listing ID while maintaining a routing directory; user trip lists may
need their own projection because user-based queries cross listing partitions.
Keep booking and occupied interval co-located to retain local transactions.

Regional replicas can serve browsing. A disconnected region cannot accept writes
for the same property independently without changing the ownership/consensus design.
Worker scale must respect ordering or versions per booking and deduplicate within
each consumer's own scope.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Inventory commitment | Listing-scoped database transaction | Cache check followed by independent insert | Serialize every writer at durable authority |
| Availability model | Occupied intervals plus separate host rules | Uniform row for every future night | Compact when rules repeat; accept range-edit complexity |
| Initial search | PostgreSQL/PostGIS | Immediate separate search engine | Combine existing relational and geographic queries |
| Downstream delivery | Transactional outbox and idempotent consumers | Best-effort publish after commit | Recover event loss and duplicate delivery |
| Browser search state | Applied URL plus local draft | Independent copies in URL and stores | Make navigation and request identity agree |

## Implementation Notes

### Production-grade patterns actually present

The repository uses one Express API, not the separate services in the production
diagram. Its booking creation route uses the transaction wrapper in
[db.ts](./backend/src/db.ts), locks the listing, and checks occupied ranges before
inserting both records. The key implemented pattern is:

```sql
SELECT * FROM listings WHERE id = $1 FOR UPDATE;
```

That lock in [routes/bookings.ts](./backend/src/routes/bookings.ts) prevents two
cooperating creation transactions from reading the same unoccupied listing at once.
It does not lock every future calendar writer automatically.

[shared/cache.ts](./backend/src/shared/cache.ts) implements cache-aside reads:
listing details use 900 seconds, calendar reads 60 seconds, and eligible anonymous
searches 300 seconds. Date-specific and authenticated searches bypass search caching.
TTL bounds ordinary staleness; invalidation does not prevent an older in-flight read
from repopulating a deleted key.

[shared/circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) wraps search with
Opossum, limiting repeated calls while failures accumulate. Its empty fallback is
a correctness/UX limitation, not evidence of a successful search.

[shared/logger.ts](./backend/src/shared/logger.ts),
[shared/audit.ts](./backend/src/shared/audit.ts), and
[shared/metrics.ts](./backend/src/shared/metrics.ts) supply request logs, selected
business audit events and Prometheus instrumentation. These are useful foundations;
transactional audit guarantees, full tracing and comprehensive measurements are absent.

### Material gaps found by source review

**Booking lifecycle.** A host response reads a pending booking outside a transaction,
then updates it by ID without an expected-state condition. If a guest cancels between
those steps, cancellation deletes the block and host confirmation changes the row
back to confirmed without restoring inventory. A subsequent create can book the same
dates. Calendar edits also omit the shared listing lock and exclusion enforcement.
There is no pending-request expiry job, payment workflow or create idempotency key.

**Calendar and quote.** The host edit route tries to split existing non-booked blocks,
but compares PostgreSQL Date values directly with ISO request strings. With the
default [node-postgres date parser](https://node-postgres.com/features/types), these
comparisons can be false and omit preserved outer ranges. It does not merge adjacent
blocks. Booking pricing ignores stored nightly overrides and uses a flat rate,
cleaning fee and service percentage; a zero percentage falls back to ten percent.
Creation also lacks the active-listing check used by the separate availability read.

**Search.** In [routes/search.ts](./backend/src/routes/search.ts), the count query
guesses date placeholder positions from condition count rather than tracking the
parameter array. Common date/filter combinations therefore bind the wrong values
or nonexistent parameters. The breaker masks failures as an empty result. Default
ranking is rating then review count, not a weighted relevance formula.

The search cache key truncates Base64-encoded JSON to 64 characters; it is not a
hash. Identical coordinates with different later guest/price fields can share a key.
Listing creation and review updates do not invalidate all affected cached views;
other invalidations use Redis `KEYS`, which is unsuitable for large keyspaces.

**Workers and events.** [shared/queue.ts](./backend/src/shared/queue.ts) declares
durable RabbitMQ queues and publishes persistent messages through an ordinary
channel. There are no publisher confirms or outbox. Booking and analytics queues
can receive the same event, but both use `processed:eventId` in Redis, allowing
one consumer to suppress another. Read-then-set deduplication also races and is not
atomic with database effects.

Retries delay and requeue the original message without changing its retry header,
so the intended attempt limit does not advance. Dead-letter queues cover booking
and notification routes only. `availability.changed` has no matching binding;
listing, completion and review event helpers are not consistently published by their
routes. No consumer implements the declared host-alert or search-reindex queues.

The [workers](./backend/src/workers) do not call `connectRedis`, so deduplication
fails before handlers run. Their SQL references absent `booking_analytics`,
`notifications` and `daily_metrics` tables; cancellation also refers to nonexistent
`block_type`. Notification email/push actions are simulated logs. These files are
prototypes, not a working reliable background pipeline.

**Frontend.** [search.tsx](./frontend/src/routes/search.tsx) combines Zustand search
state with local filters, but does not synchronize applied queries to the URL or
guard against stale responses. Clearing filters can submit the old closure's values.
There is no map, virtualized list, pagination UI or React Query cache.
[Calendar.tsx](./frontend/src/components/Calendar.tsx) includes checkout in blocked
ranges, unlike the backend. Its minimum-night prop is displayed but not enforced.
[BookingWidget.tsx](./frontend/src/components/BookingWidget.tsx) keeps dates locally,
can lose them across login, and does not make an in-flight availability check a
submission barrier. Failed calendar loads can leave an apparently empty calendar.

Host creation navigates to an absent edit route; Edit and Calendar links lead to
public details. Messages fetch on opening/sending, with no polling or WebSocket.
Review reveal has no timer; simultaneous opposite-party inserts can both observe
only one review and remain hidden. Conversation creation lacks a uniqueness guard,
and supplied booking relationships are not fully validated.

### Simplifications, omissions and verification scope

Local disk replaces object storage; external sample images replace an image pipeline.
One database replaces partitioned ownership and replicas. Session cookies replace
federated login. Flat prices replace dated pricing and payments. The local UI covers
parts of both guest and host personas, with no admin interface.

CDN, API gateway, independent search service, outbox relay, payment integration,
reliable workers, automatic expiry, timed review reveal, live messaging, multi-region
failover and deployment orchestration are omitted. Compose/setup commands and native
service alternatives are in [README.md](./README.md).

The review inspected routes, SQL, queue/cache/auth helpers, workers, frontend state,
configuration and test coverage. Route tests mock infrastructure; smoke tests mainly
assert page presence. The documented concurrency and recovery gaps are source-based
findings, not claimed reproductions from a running stack. Application code was not
changed as part of this documentation pass.
