# Hotel Booking Architecture

## System Overview

Hotel booking combines read-heavy discovery with scarce inventory sold across a range of nights.
The important invariant is that, for each hotel, room type, and occupied night, accepted active
allocations do not exceed sellable capacity. A search result is evidence for choosing a hotel;
a reservation transaction is the authority that allocates its inventory.

The first sections describe a **proposed production design**, not a claim about a commercial
hotel platform or this repository's deployed scale. The exact local schema and API are explicitly
labeled. Final [Implementation Notes](#implementation-notes) trace what the TypeScript/React demo
actually does, including defects. Setup and seed choices belong in [README.md](./README.md).

## Requirements

### Functional requirements — proposed

- Search by destination, dates, party size, price, amenities, and room count.
- Inspect nightly availability, a complete price quote, and cancellation terms.
- Hold inventory, authorize payment, confirm a booking, and recover uncertain outcomes.
- Cancel according to the accepted policy and retain an auditable status history.
- Let property owners manage room types, sellable capacity, and dated prices.
- Accept reviews only under the product's verified-stay policy.

One booking covers a quantity of one room type in one hotel. Intentional overbooking, multi-hotel
baskets, channel-manager synchronization, and physical room assignment are separate problems.
The initial design does not sell more than configured inventory.

### Non-functional requirements — proposed targets

| Concern | Design target, not a measured result |
|---|---|
| Inventory correctness | No overselling through any allocation or capacity-change path |
| Booking identity | A retried purchase intent has one durable result |
| Money | Confirm only against the accepted quote and verified payment state |
| Latency | Search p95 below 500 ms; local hold transaction p95 below 300 ms, excluding payment |
| Availability | 99.9% discovery availability; fail closed for authoritative writes without the primary |
| Recovery | No acknowledged booking lost after the required durable database commit |
| User experience | Explicit held, confirmed, expired, cancelled, and uncertain states |

## Capacity Estimation

Assume 100,000 hotels, five room types per hotel, ten million searches and 100,000 bookings per day.
These are exercise assumptions: about 116 average searches/s and 1.2 bookings/s, with a tenfold
peak budget of roughly 1,200 and 12/s. A popular property can concentrate much of the write load;
global averages conceal the room-type lock bottleneck.

At twenty candidates per search and two room types checked per candidate, naive enrichment turns
1,200 searches/s into 48,000 availability checks/s before calendar traffic. Batch queries, bounded
candidate expansion, and disposable read caches matter more than prematurely splitting services.

A one-year per-night inventory projection would contain about 182.5 million room-type/date rows.
This can be maintained by hotel partitions if measurement justifies it. Start with booking ranges
and a room-type lock for simplicity; do not pretend both models have the same storage or write cost.

### Local Development Scale

The Compose stack is one PostgreSQL instance, one Valkey instance with AOF, and one Elasticsearch
node with a 512 MB heap. The TypeScript seed is five hotels and thirteen room types. There are no
load measurements establishing a memory budget, throughput, or availability objective.

## High-Level Architecture

Proposed logical components; discovery, booking, and owner APIs can initially share a deployment.

```
┌────────────────────────┐ HTTPS  ┌──────────────────────────────────────────────────────────┐
│ Guest / hotel owner    │        │ API boundary                                             │
│ Saved intent / command │◀──────▶│ Authentication, ownership, bounds, intent identity       │
└────────────────────────┘        └──────────────────────────────────────────────────────────┘
                                              ▲                  ▲
                                              │                  │
             ┌────────────────────────────────┘                  │
             │                       quote / hold / owner edits  │
search reads │                                                   │
             ▼                                                   ▼
┌────────────────────────┐        ┌──────────────────────────────────────────────────────────┐
│ Search service         │        │ Booking + inventory service                              │
│ Bounded candidates     │◀──────▶│ Hotel-owned transactions; conditional state changes      │
│ Advisory enrichment    │        │ Quote, receipt, booking and outbox commit together       │
└────────────────────────┘        └──────────────────────────────────────────────────────────┘
             ▲                                                  ▲
             │                                                  │
match / rank │                      authoritative transactions  │
             │                                                  │
             ▼                                                  ▼
┌────────────────────────┐        ┌──────────────────────────────────────────────────────────┐
│ Elasticsearch + cache  │        │ PostgreSQL primary, partitioned by hotel at scale        │
│ Catalog projection     │        │ Rooms, nightly inventory, quotes, holds, receipts        │
│ Disposable snapshots   │        │ Payment attempts, provider receipts, inbox and outbox    │
└────────────────────────┘        └──────────────────────────────────────────────────────────┘
             ▲                                                  ▲
index jobs   │                                                  │
             │                      jobs / state transitions    │
             ▼                                                  ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ Workers: projection, expiry, payment reconciliation                                        │
│ Retry committed work; verify provider events; reconcile uncertain outcomes                 │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                                               ▲
                                               │  idempotent authorization / settlement
                                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ External payment provider — separate failure domain                                        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

An authenticated command reaches the booking service and the hotel's owning database partition.
The transaction checks inventory and commits its booking, receipt, and durable work together.
A search reads a rebuildable hotel projection and asks for bounded advisory enrichment. Search
and cache responses never grant inventory. Workers publish projections, expire eligible holds,
and reconcile payment outcomes across the external provider boundary.

A returning guest resolves the saved account-scoped purchase intent and existing payment attempt before creating new work. A provider timeout leaves an unknown outcome, so payment-processing inventory remains protected while reconciliation determines the next transition. Expiry applies only to eligible holds under the same database state machine. Projection workers separately confirm versioned index effects before recording progress; updated search results are not the booking receipt.

## Core Components / Request Flows

### Discovery and dated availability — proposed

Elasticsearch matches location and catalog attributes. Expand candidates only to a bounded budget,
then batch availability and date-specific price checks by hotel/room type. Return a coherent page
and continuation token; if an exact available-hotel count is expensive, omit it rather than
combining a filtered page count with an unrelated unfiltered total.

Availability responses include the requested room count, date range, evaluation time, and freshness
information. A dependency error is “availability unknown,” not “sold out.” Cache keys include all
semantic inputs or cache raw capacity counts from which a caller derives its own boolean.
Generation-based invalidation can cover all overlapping range keys for a room type; a short TTL
bounds residual staleness. None of this read optimization replaces the allocation transaction.

The local service already filters a dated Elasticsearch page for availability, but returns
inconsistent totals and mismatched hotel field names; it does not implement this proposed contract.

### Quote and reserve — proposed

1. Validate real calendar dates, positive bounded counts, guest capacity, hotel activity, and the maximum stay length.
2. Issue a server quote containing the hotel date range, room quantity, per-night amounts, total, currency, policy version, and expiration.
3. Accept a client purchase-intent key scoped to the authenticated account and bound to the frozen request and quote.
4. In a short transaction, resolve an existing receipt, lock the room type or relevant nightly inventory rows, and check every occupied night.
5. Verify the quote is still acceptable; persist its immutable monetary/policy snapshot, booking hold, receipt, and outbox entry atomically.
6. Return the canonical booking ID, status, deadline, and accepted total. Recover a lost response through the same intent or booking status.

No network call to a payment provider occurs while holding inventory row locks. A price change
requires explicit acceptance of a new quote; it must not silently increase the purchase amount.

### Payment, confirmation, and expiry — proposed

A valid hold transitions atomically to a bounded payment-processing state before its deadline.
This state still consumes inventory and has a reconciliation deadline. Durable work authorizes
payment using the booking/payment-attempt identity. Provider events are verified, deduplicated,
and matched to the amount, currency, and attempt before advancing state.

The expiry worker and payment state machine use conditional transitions, so only one wins.
A worker being late does not extend the right to begin payment: commands compare the database
clock with the deadline themselves. If authorization arrives after inventory has been released,
void it or enter a visible refund/reconciliation path. Do not resurrect the old reservation unless
inventory is explicitly reacquired and the user accepts the resulting terms.

Settlement and cancellation are similarly durable workflows. “Confirmed,” “authorized,” and
“settled” are separate facts; the UI should not label every reservation “Total Paid.”

### Owner changes and catalog projection — proposed

Capacity reductions share the allocation serialization rule and check future obligations before
commit. Price changes version future quotes; accepted quotes retain their terms. Owner authorization
is enforced in SQL/service access even if the management route is hidden in the browser.

Commit a versioned catalog event in the same transaction as a hotel or room change. The indexing
worker retries and ignores older versions, preventing a slow earlier update from overwriting a
newer document. Reviews also trigger rating projection updates. Rebuild/reconciliation tools recover
lost projections without treating Elasticsearch as the source of truth.

## Database Schema

### Exact local PostgreSQL schema

The following is the checked-in [init.sql](./backend/src/db/init.sql): seven tables and fifteen
explicit secondary indexes, in addition to indexes created for primary/unique constraints. It is
an initialization script, not a sequence of safe incremental migrations.

```sql
-- Hotel Booking Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(20),
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'hotel_admin', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Hotels table
CREATE TABLE hotels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID REFERENCES users(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  address TEXT NOT NULL,
  city VARCHAR(100) NOT NULL,
  state VARCHAR(100),
  country VARCHAR(50) NOT NULL,
  postal_code VARCHAR(20),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  star_rating INTEGER CHECK (star_rating BETWEEN 1 AND 5),
  amenities TEXT[] DEFAULT '{}',
  check_in_time TIME DEFAULT '15:00',
  check_out_time TIME DEFAULT '11:00',
  cancellation_policy TEXT DEFAULT 'Free cancellation up to 24 hours before check-in',
  images TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Room types table
CREATE TABLE room_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  hotel_id UUID REFERENCES hotels(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  bed_type VARCHAR(50),
  total_count INTEGER NOT NULL CHECK (total_count > 0),
  base_price DECIMAL(10, 2) NOT NULL CHECK (base_price > 0),
  amenities TEXT[] DEFAULT '{}',
  images TEXT[] DEFAULT '{}',
  size_sqm INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Bookings table
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  hotel_id UUID REFERENCES hotels(id),
  room_type_id UUID REFERENCES room_types(id),
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  room_count INTEGER NOT NULL CHECK (room_count > 0),
  guest_count INTEGER NOT NULL CHECK (guest_count > 0),
  total_price DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'reserved', 'confirmed', 'cancelled', 'completed', 'expired')),
  payment_id VARCHAR(100),
  idempotency_key VARCHAR(64) UNIQUE,
  reserved_until TIMESTAMP WITH TIME ZONE,
  guest_first_name VARCHAR(100) NOT NULL,
  guest_last_name VARCHAR(100) NOT NULL,
  guest_email VARCHAR(255) NOT NULL,
  guest_phone VARCHAR(20),
  special_requests TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT valid_dates CHECK (check_out > check_in)
);

-- Pricing overrides table (for dynamic pricing)
CREATE TABLE pricing_overrides (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_type_id UUID REFERENCES room_types(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  price DECIMAL(10, 2) NOT NULL CHECK (price > 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(room_type_id, date)
);

-- Reviews table
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id UUID REFERENCES bookings(id) UNIQUE,
  user_id UUID REFERENCES users(id),
  hotel_id UUID REFERENCES hotels(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title VARCHAR(200),
  content TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table (for authentication)
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_hotels_city ON hotels(city);
CREATE INDEX idx_hotels_country ON hotels(country);
CREATE INDEX idx_hotels_location ON hotels(latitude, longitude);
CREATE INDEX idx_hotels_active ON hotels(is_active) WHERE is_active = true;

CREATE INDEX idx_room_types_hotel ON room_types(hotel_id);
CREATE INDEX idx_room_types_active ON room_types(is_active) WHERE is_active = true;

CREATE INDEX idx_bookings_hotel_dates ON bookings(hotel_id, room_type_id, check_in, check_out);
CREATE INDEX idx_bookings_user ON bookings(user_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_reserved_until ON bookings(reserved_until) WHERE status = 'reserved';

CREATE INDEX idx_pricing_overrides_room_date ON pricing_overrides(room_type_id, date);

CREATE INDEX idx_reviews_hotel ON reviews(hotel_id);
CREATE INDEX idx_reviews_user ON reviews(user_id);

CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_hotels_updated_at BEFORE UPDATE ON hotels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_room_types_updated_at BEFORE UPDATE ON room_types
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

This schema models inventory as room-type capacity plus overlapping booking ranges. `DATE` is
appropriate for hotel nights, but the JavaScript conversion must preserve date-only semantics.
The latitude/longitude index is an ordinary composite B-tree, not a geographic radius index.

Important limits: nullable foreign keys do not enforce complete booking ownership relationships;
there is no composite hotel/room constraint, per-night capacity constraint, quote snapshot, currency,
payment-attempt table, event inbox, or outbox. Positive room counts and a nonempty date interval
are checked, but guest capacity and hold transition deadlines are not database constraints.

### Production additions — proposed, not in this SQL

| Entity | Key / important fields | Purpose |
|---|---|---|
| Quote | quote ID, owner, room/date/count scope, amount/currency, nightly breakdown, policy/version, deadline | Immutable purchase terms |
| Operation receipt | account + intent key, request digest, booking ID, durable result | Distinguish retry from a separate purchase |
| Booking state history | booking ID + sequence, old/new state, reason, server time | Explain confirmation, expiry, and cancellation |
| Payment attempt / inbox | booking + attempt; unique provider event ID | Verify and deduplicate external money events |
| Outbox | event ID, hotel, entity version, delivery state | Retry indexing and payment work after commit |
| Nightly inventory, if needed | hotel + room type + date, capacity, held, confirmed, version | Bound allocation query cost at scale |

## API Design

### Current local API

All endpoints below have prefix `/api/v1`. Public discovery routes can attach an optional session;
booking mutation and account reads require an opaque bearer token. Owner writes additionally require
a hotel-management role and ownership checks in the service.

| Method | Path | Current purpose |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | Create account / return session token |
| POST / GET | `/auth/logout` / `/auth/me` | End session / current user |
| GET | `/hotels/search` | Elasticsearch page, optionally filtered by dated availability |
| GET | `/hotels/:hotelId` | SQL detail, active room types, optional prices and availability |
| GET | `/hotels/:hotelId/rooms` | Room types |
| GET | `/hotels/:hotelId/reviews`, `/hotels/:hotelId/reviews/stats` | Reviews / rating aggregate |
| GET | `/bookings/availability`, `/bookings/availability/calendar` | Advisory range / month data |
| POST / GET | `/bookings` | Create reservation / list own bookings |
| GET | `/bookings/:bookingId` | Own booking detail |
| POST | `/bookings/:bookingId/confirm`, `/bookings/:bookingId/cancel` | Simulated confirmation / cancellation |
| POST | `/bookings/:bookingId/review` | Review own confirmed or completed booking |
| GET | `/hotels/admin/my-hotels`, `/bookings/hotel/:hotelId` | Owner's hotels / hotel bookings |
| POST | `/hotels`, `/hotels/:hotelId/rooms` | Create owned hotel / room type |
| PUT / DELETE | `/hotels/:hotelId`, `/hotels/rooms/:roomTypeId` | Update or delete hotel / room type |
| POST / GET | `/hotels/rooms/:roomTypeId/pricing` | Set one dated price / retrieve dated overrides |

There is no quote endpoint, real payment endpoint, booking modification flow, or completion job.
A successful booking creation returns 201 even for an idempotent replay. Availability failures are
mapped to 409 using message matching; many other validation or post-commit failures return 500.
Confirmation/cancellation of an ineligible state produces an error rather than a canonical replay.

### Proposed contract changes

Add explicit quote creation, purchase-intent lookup, typed conflict/expired/unknown outcomes, and
payment-attempt status. Return the same canonical booking representation on original and repeated
requests. Keep search DTOs distinct from internal Elasticsearch documents and validate them at the
client boundary. Bound page size, stay length, room count, month range, and query fan-out.

## Key Design Decisions

### Room-type serialization before distributing inventory

A row lock on the room type followed by a fresh occupancy query provides an understandable starting
point. Transactions from different API processes contend on the same PostgreSQL row. The next
transaction queries occupancy after the previous one commits at the default Read Committed level.
This depends on every allocation and relevant capacity mutation honoring the protocol. PostgreSQL
explains these guarantees in [row-level locking](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS)
and [transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html).

A Redis lease keyed by an exact date range cannot serialize all overlapping ranges. A global
room-type lease could reduce contention but adds expiration and failover problems without replacing
the authoritative database transaction. The local database lock is not restricted to one API process,
contrary to comments in the reservation source.

The cost of the simple row lock is serializing unrelated stays for the same room type. If measured
wait time becomes unacceptable, lock per-night inventory rows in a deterministic order. This admits
nonoverlapping dates concurrently but requires many rows, bounded stay lengths, and careful multi-night
rollback. Optimistic retries on a sold-out hot key can amplify load; they are not automatically faster.

### Search freshness without putting booking locks on every read

Advisory availability filtering is useful. The choice is how much enrichment to perform and how to
report freshness, not whether a search UI is ever allowed to say a room was available when checked.
Scanning every candidate hotel synchronously can overwhelm SQL; never filtering creates irrelevant
results and pushes the same work into detail visits. Bounded batching plus a conservative cache is a
middle ground. Allocation remains a fresh transaction, so stale search can disappoint but cannot sell
inventory by itself.

### Purchase identity rather than parameter coincidence

Two requests with identical dates may represent either a retry or two intended reservations. A digest
of booking parameters cannot distinguish them. A stable client intent plus a bound payload can, while
a unique account/intent receipt prevents concurrent retries from creating separate results. The receipt
must commit with the booking and unique-conflict handling must return the winner's canonical result.
The cost is receipt retention, request-version rules, and an explicit new-intent action for another stay.

## Consistency and Idempotency

Use strong consistency for inventory allocation, capacity reductions, accepted quotes, and booking
transitions. Search, ratings, and calendar hints may lag. Payment is an external state machine, not
an atomic extension of a database transaction; describe effectively-once business effects under retries,
not universal exactly-once delivery.

The local SQL unique idempotency key prevents duplicate rows for the same generated key, but does not
provide a correct repeat-response protocol. The precheck happens before locking; a concurrent second
request can hit an availability or uniqueness error. Parameter hashes conflate separate intentions,
and the Redis receipt representation is incompatible with its replay formatter.

## Security / Auth

Production: use secure revocable sessions, CSRF protection appropriate to the transport, current owner
checks, bounded inputs, abuse limits, and redacted audit events. Keep payment credentials on the provider
side and verify webhook signatures and account/amount/currency binding. Public self-service property
registration can be intentional; property ownership must still constrain every operation.

Local: bcrypt hashes and SQL/Redis-backed opaque bearer sessions exist. Tokens are stored in browser
localStorage. Registration allows `hotel_admin`; it does not allow arbitrary `admin`. Session cache hits
read the user from SQL, but do not validate the session's SQL expiry. A cache miss refreshes Redis for a
full 24 hours even near SQL expiry. Logout spans SQL then Redis; a failed Redis deletion can leave a
cached token accepted. Redis failure generally fails authentication rather than falling back to SQL.

There is no rate limiter, restricted CORS policy, or payment verification. UI minimum password length
is not a server guarantee. Hotel-management role checks do not make the admin account a global property
owner; the permissive ownership helper is unused by actual service paths.

## Observability

Production signals should answer: are holds succeeding, are inventory waits growing, how late is expiry,
how old are pending payment attempts, and how far behind is the search projection? Track accepted holds,
verified payments, cancellations, and refunds separately. Add bounded labels, traces across durable work,
and invariant audits comparing inventory to active allocations.

Locally, Pino request logs and Prometheus middleware are connected. Business functions often use a global
logger rather than the request child, so request IDs are not carried through every business log. Raw search
cities and entity IDs create unbounded metric dimensions. The “revenue” counter increments when a hold is
created, not when money is paid, and never compensates for cancellation. Idempotent-hit counting occurs
in both the helper and caller. HTTP labels can lose the route mount prefix; pool gauges refresh only when
health checks run. These metrics are demonstrations, not reliable financial or SLO reports.

## Failure Handling

| Failure | Proposed behavior | Local behavior |
|---|---|---|
| Search index unavailable | Explicit discovery failure or intentionally limited fallback | Search fails; no connected breaker/fallback |
| Availability dependency fails | Unknown state, retain criteria | Dated search silently drops that hotel |
| Redis fails after SQL commit | Durable result remains recoverable; retry ancillary work | Can return 500 after booking/state already committed |
| Duplicate concurrent intent | Return the committed winner's receipt | May return availability or unique-constraint error |
| Expiry worker delayed | Command still enforces server deadline | Confirmation accepts any still-reserved row |
| Payment response lost | Reconcile same provider attempt | No provider is integrated |
| Process terminates | Drain requests and leave durable worker claims recoverable | Timer cleared, then immediate process exit |

The local expiry sweep is real: every API process starts a 60-second interval. Conditional SQL expires
past-deadline reserved rows, then invalidates their caches. It is neither a durable job queue nor an
exact-deadline scheduler. One failed invalidation can stop subsequent invalidations after rows have
already changed, and simultaneous timers have no explicit coordination or overlap guard.

## Scalability Considerations

First bound search fan-out and date horizons. Measure PostgreSQL pool wait, room-type lock wait, and
nightly aggregation cost. Avoid a second pool checkout while holding a transaction's connection.
Introduce nightly inventory rows only when the simpler booking-range model reaches measured limits.

Partition authoritative writes by hotel so one booking stays within one owner partition. Add replicas
for tolerant reads, versioned search projection workers, and image delivery through a CDN. Route writes
to the owning region with failover fencing; do not accept two independent writable owners for the same
inventory. Protect hot properties with admission control and short queues rather than unbounded retries.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|---|---|---|---|
| Initial inventory | Room-type lock + nightly occupancy | Distributed range leases | One enforceable authority across API processes |
| Hot inventory | Per-night rows when justified | One coarse lock forever | Nonoverlapping stays can proceed concurrently |
| Discovery | Bounded advisory enrichment | Check every candidate synchronously | Useful results within a controlled SQL budget |
| Retry identity | Account + purchase intent + payload binding | Hash booking parameters | Separate repetition from a second intended purchase |
| External effects | Outbox, provider identity, reconciliation | Database lock across payment | Recover uncertainty without long-held inventory locks |
| Hotel dates | Date-only, half-open occupied nights | Host-timezone timestamp iteration | Avoid off-by-one availability and price errors |

## Implementation Notes

### Local topology and wired patterns

```
┌────────────────────────┐        ┌──────────────────────────────────────────────────────────┐
│ React browser          │        │ Express API (one process per instance)                   │
│ Vite /api proxy        │◀──────▶│ Auth, search, rooms, booking routes + expiry timer       │
└────────────────────────┘        └──────────────────────────────────────────────────────────┘
                                                                                ▲
                                                                                │
             ┌──────────────────────────────────────────────────────────────────┘
             ▲                                ▲                                 ▲
transactions │                    cache/lease │                    search/index │
             │                                │                                 │
             ▼                                ▼                                 ▼
┌─────────────────────────┐       ┌─────────────────────────┐      ┌─────────────────────────┐
│ PostgreSQL 16           │       │ Valkey                  │      │ Elasticsearch 8.11      │
│ Catalog + bookings      │       │ Sessions, availability  │      │ Hotel documents         │
│ Prices + sessions       │       │ Receipts, range leases  │      │ One shard, no replicas  │
└─────────────────────────┘       └─────────────────────────┘      └─────────────────────────┘



Every API runs a 60-second expiry sweep against PostgreSQL.

Confirmation updates SQL directly; no external payment provider is connected.
```

[backend/src/index.ts](./backend/src/index.ts) mounts the API, request logging, metrics, and health
routes, attempts Elasticsearch setup, starts the expiry interval, and listens. Setup swallows errors;
a message that the index is ready is not proof it exists. No startup migration or schema readiness check
runs. The shutdown handlers do not drain HTTP or close database/cache clients gracefully.

The most important implemented concurrency pattern is in
[reservation.ts](./backend/src/services/booking/reservation.ts):

```typescript
await client.query('BEGIN');
await client.query(
  'SELECT id FROM room_types WHERE id = $1 AND hotel_id = $2 FOR UPDATE',
  [roomTypeId, hotelId]
);
// The following occupancy query runs while this transaction holds the row lock.
```

The subsequent query generates each occupied date, sums active room quantities for that date, and uses
the maximum nightly occupancy to check the requested quantity. It counts `reserved` and `confirmed`
rows. Expired-by-time reservations keep consuming capacity until their status is swept. This is a fresh
SQL check, independent of the advisory Redis result.

[shared/distributedLock.ts](./backend/src/shared/distributedLock.ts) supplies a single-Redis lease with an ownership-checked
Lua release. Creation uses a 30-second exact-range key and bounded retries; different overlapping ranges
have different keys. There is no lease renewal in this path or fencing token. The separate PostgreSQL
row lock supplies the actual serialization among booking creation transactions.

The real expiry predicate in [cancellation.ts](./backend/src/services/booking/cancellation.ts) is:

```sql
UPDATE bookings
SET status = 'expired'
WHERE status = 'reserved' AND reserved_until < NOW()
RETURNING hotel_id, room_type_id, check_in, check_out;
```

[shared/metrics.ts](./backend/src/shared/metrics.ts), [shared/logger.ts](./backend/src/shared/logger.ts),
and [shared/healthCheck.ts](./backend/src/shared/healthCheck.ts) implement the connected operational helpers.
[shared/circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) defines factories, but request paths
do not instantiate/use those breakers. Its payment fallback claiming `queued` does not enqueue work.
Health checks probe PostgreSQL connectivity, Redis, and the ES cluster, not tables or the hotel index;
the overall check treats Elasticsearch's degraded result as healthy.

### Reservation, price, and receipt limitations

- The room row is locked before availability, but pricing uses `roomService` through a separate pool connection. Price reads are outside the booking transaction and a busy pool can be exhausted by transactions waiting for a second connection.
- Reservation creation checks room activity and hotel/type association, but not hotel activity or guest capacity. Owner capacity reductions can go below active obligations; they do not enforce the allocation invariant.
- COMMIT precedes cache invalidation. A later Redis error enters a catch block that issues ROLLBACK after commit and returns failure; that rollback cannot undo the booking.
- [shared/idempotency.ts](./backend/src/shared/idempotency.ts) hashes user, hotel, type, dates, and room count. It omits guest count and contact details, has no independent purchase identity, and can return an old cancelled/expired stay instead of a new purchase.
- The precheck is not repeated after waiting for the lock, and INSERT has no unique-conflict replay handling. A cached success is camelCase but [formatter.ts](./backend/src/services/booking/formatter.ts) expects a snake_case SQL row on replay. Fields disappear and `totalPrice` becomes NaN, serialized as null.
- Cached receipts are not refreshed on confirmation, cancellation, or expiry. Client-idempotency middleware exists but is not wired into creation; the browser sends no intent header.
- [confirmation.ts](./backend/src/services/booking/confirmation.ts) checks owner and `reserved` status but not `reserved_until`. The browser supplies a fabricated payment ID; no charge, signature check, refund, or accepted cancellation-policy enforcement occurs.
- Money is stored as DECIMAL but converted to JavaScript floating point. There is no currency column or immutable nightly quote. Pricing loops mix UTC date parsing and local `setDate`: in Los Angeles, 2026-03-07 through 2026-03-10 produces four priced entries for three nights in an isolated source check.

### Availability and search limitations

[availability.ts](./backend/src/services/booking/availability.ts) caches advisory results for 300 seconds.
The range key omits requested room count even though the cached object includes `available` and
`requestedRooms`; a successful one-room check can therefore answer a five-room request incorrectly.
Monthly calendars use host-local dates converted to UTC strings, shifting labels in positive timezones.

[cache.ts](./backend/src/services/booking/cache.ts) deletes only one exact range and computed month keys.
Incrementing the start date by one month can skip a touched month: January 30 through February 2 never
deletes February's calendar. Other overlapping range entries survive. Room/price edits do not invalidate
these keys. Cache TTL limits some staleness; it does not make invalidation complete.

[searchService.ts](./backend/src/services/searchService.ts) enriches an already-paginated ES result when
dates are supplied. It filters room types by capacity for the whole party, ignoring distribution across
multiple rooms; individual check errors remove a hotel. It changes `total` to the surviving page length
but retains ES `totalPages`. Its return shape contains ES `hotel_id`, `star_rating`, and `avg_rating`,
while frontend cards require `id`, `starRating`, and `avgRating`. Dated `startingPrice` uses base prices,
not override totals. Detail lookup checks only one requested room and ignores its guests argument.

[models/elasticsearch.ts](./backend/src/models/elasticsearch.ts) uses one shard, zero replicas, and
city keyword matching without a normalizer. It does not search hotel name/description despite the UI
placeholder. Amenities are any-of, and hotel-level minimum price and maximum capacity can describe
different room types. Sorting has no stable ID tie-breaker; there is no geographic SQL fallback or
claimed custom weighted ranking algorithm. Catalog writes commit SQL before synchronous ES refresh;
index errors and out-of-order snapshots can leave drift. Reviews do not refresh ES rating fields.

### Frontend behavior and boundaries

The frontend uses route-local state plus Zustand auth/search stores and a fetch wrapper. It does not
implement a server-query cache, request cancellation/generation guards, or an immutable checkout attempt.
The auth bootstrap gate is present; tokens persist in localStorage. Search pages do not initialize from
URL criteria, so homepage city links can lose their city. Detail links preserve dates but drop party and
room count. A selected room object can remain stale after dates change.

[AvailabilityCalendar.tsx](./frontend/src/components/AvailabilityCalendar.tsx) fetches a month at a time,
but has no client month cache or stale-response guard. It checks endpoints rather than every occupied
night, allows a same-day range, and blocks checkout on a sold-out departure night even though that night
is not occupied. Today appears enabled but its click can be rejected by a midnight-versus-now comparison.
It displays daily prices, not numerical inventory counts. Full keyboard grid semantics and range
announcements are absent.

Checkout recomputes display totals from fetched room data and sends no accepted quote/version. It disables
the submit button while submitting, but has no durable attempt recovery for uncertain outcomes. Booking
detail labels every state “Total Paid” and uses fake payment confirmation. Confirm/cancel actions lack
an in-flight guard. Booking lists are unpaginated, lack expiry polling/countdowns, and omit some status
filters. Reviews accept confirmed/completed bookings without checking checkout has passed; no completion
worker advances stays automatically.

Owner screens expose room CRUD and single-date pricing, not seasonal bulk editing or occupancy analytics.
They show the first ten bookings ordered by check-in, which need not be the most recent. UI role checks
are broader than property ownership; backend service checks still constrain writes. Direct hotel detail
reads can expose inactive hotels, and deleting referenced hotels/rooms can fail on foreign keys.

### Substitutions, omissions, and verification

One shared PostgreSQL replaces hotel partitions and replicas. Valkey supplies the Redis-compatible
cache/lease/session interface; ES is local and rebuildable. Confirmation is simulated. Images are external
URLs, not an implemented upload/CDN pipeline. Authentication uses local accounts and opaque bearer tokens.
There is no payment integration, durable outbox, indexing reconciliation worker, notification queue,
production rate limiter, multi-region ownership, Kubernetes deployment, or measured SLO enforcement.

The two seed paths have different accounts, entities, and indexing behavior; see the README. Source review
covered all five documents, application routes/services, relevant frontend state/components, schema,
configuration, seeds, and smoke tests. Nine isolated checks reproduced cache, replay, date, search, and
confirmation behavior and verified TypeScript source inclusion; fixture password hashes were also checked.
These tests mock dependencies and do not prove SQL concurrency or runtime integration. No full stack,
browser, payment service, or build was run during this documentation pass.
