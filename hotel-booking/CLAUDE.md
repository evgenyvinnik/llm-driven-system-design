# Hotel Booking — Development with Claude

## Project Context

Hotel inventory is the textbook case where a correctness bug costs real money in both directions. Oversell a room and someone arrives at midnight with a confirmation email and nowhere to sleep; hold inventory too conservatively and rooms go empty. The awkward part is that hotel inventory isn't a counter you decrement — it's a **count of overlapping intervals**. Whether a room is available on March 17th depends on every booking whose range straddles that night, so "how many rooms are free?" is a per-night `MAX` over a date range, not a single number you can `UPDATE ... SET count = count - 1`.

That interval shape is why the concurrency control here is layered rather than single-mechanism. There are two distinct races: two requests on the *same* server (solved by a Postgres transaction with `SELECT ... FOR UPDATE` on the room type row) and two requests on *different* servers (which a row lock also solves, but only if both reach the same database in overlapping transactions — and the availability computation is expensive enough that widening that transaction to cover it hurts). So a Redis distributed lock scoped to `(hotel, roomType, dateRange)` sits outside the transaction, and idempotency sits outside both.

The third layer is idempotency, and it's solving a different problem entirely: not concurrency but *repetition*. A user double-clicking "Book" or a client retrying a timed-out POST doesn't race anything — it produces two perfectly serialized, perfectly valid bookings for the same stay, and charges twice.

**Learning goals:** interval-based availability and its query cost, layered concurrency control (idempotency → distributed lock → row lock), reservation holds as a way to avoid inventory deadlock at the payment step, and splitting search across Elasticsearch (matching) and PostgreSQL (truth).

## Architecture at a Glance (what actually runs)

| Component | Where | Why this one |
|-----------|-------|--------------|
| **API server** (`backend/src/index.ts`, port **3001**) | `npm run dev` (`PORT=3001 tsx watch`) | Single Express process; `dev:server2/3` on 3002/3003 exist specifically to prove the distributed lock does something the row lock can't |
| **PostgreSQL 16** (5432) | `docker-compose.yml` | `users`, `hotels`, `room_types`, `bookings`, `pricing_overrides`, `reviews`, `sessions`. The authority for availability — search results are advisory, this is binding |
| **Elasticsearch 8.11** (9200) | `docker-compose.yml` | Hotel discovery only: text match on city, `geo_distance` filters, star/price/amenity/capacity ranges, sort by price/rating/relevance. Never consulted for availability |
| **Valkey/Redis 7** (6379) | `docker-compose.yml` | Three distinct jobs: sessions, the availability cache, and the distributed lock keyspace (`lock:room:*`) |

Booking is decomposed under `backend/src/services/booking/`: `reservation.ts` (the create path — idempotency → `withLock` → transaction), `availability.ts` (the per-night interval count + cache), `confirmation.ts` (`reserved` → `confirmed`), `cancellation.ts`, `cache.ts`, `queries.ts`, `formatter.ts`. The lock itself is `shared/distributedLock.ts` — Redis `SET key value PX ttl NX` with a random lock ID so a process can only release its own lock, a 30s TTL so a crashed holder can't deadlock inventory, and jittered retries. Also in `shared/`: `idempotency.ts`, opossum `circuitBreaker.ts`, `metrics.ts` (booking duration, revenue counters, lock wait times, cache hit/miss), `healthCheck.ts`, `logger.ts`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind + date-fns: search, hotel detail with `AvailabilityCalendar`, booking flow, my-bookings with confirm/cancel, review submission, and an admin dashboard (`components/admin/`) for hotels, room types, and pricing overrides. Vite proxies `/api` → `localhost:3001`.

## Key Design Decisions

### 1. Three layers of protection, each solving a race the others can't
`createBooking` runs: idempotency check → `withLock(room:hotel:type:dates)` → transaction with `SELECT ... FOR UPDATE`. This looks redundant. It isn't — each layer catches a case the others structurally cannot.

**Idempotency** catches repetition, not concurrency. A double-clicked submit produces two requests that may be *fully serialized* — the second starts after the first commits. No lock helps: both are individually legal bookings for the same room and dates. The key is derived from `(userId, hotelId, roomTypeId, checkIn, checkOut, roomCount)`, so the retry returns the original booking with `deduplicated: true` instead of a second charge.

**The distributed lock** catches cross-server races on an expensive computation. The availability check is a `generate_series` over the date range joined against overlapping bookings — not something to hold a row lock across if you can avoid it. Two servers could each compute "1 room available" from consistent snapshots before either writes. The Redis lock serializes the whole check-then-write sequence across the fleet.

**The row lock** is the last-resort correctness guarantee, and it's there because the distributed lock is *not* a correctness primitive. Redis locks fail under exactly the conditions that matter: a 30-second TTL expiring while the holder is alive but slow leaves two processes believing they hold it. The `FOR UPDATE` inside the transaction means even then, the database serializes the final read-and-write. Nothing gets oversold; the worst case degrades to a lock that didn't help.

What we give up: three mechanisms to reason about, and a booking path that touches Redis twice and Postgres in a transaction before returning. Under contention on one popular room type, throughput for that room type is serialized by design — which is correct, and would be a genuine problem in a flash sale.

### 2. Bookings are stored as ranges; availability is a per-night `MAX`
`bookings` holds `check_in`/`check_out` dates rather than one row per night. Availability is computed with `generate_series($3::date, $4::date - 1, '1 day')` left-joined against overlapping bookings, taking `MAX(daily_booked)` across the requested nights.

Row-per-night is the tempting alternative because availability becomes a trivial indexed count. It fails on cost and on mutation: a 7-night booking becomes 7 rows, so a hotel with 200 rooms booked a year out carries ~73,000 inventory rows *per hotel*, and changing a booking's dates means deleting and inserting a different number of rows inside a transaction rather than updating two columns. Range storage keeps one row per booking and makes date changes an `UPDATE`.

The cost lands squarely on reads: every availability check runs a series expansion and an aggregate, which is why it's cached with a 5-minute TTL and invalidated on any booking state change (`invalidateAvailabilityCache`). Using `MAX` rather than a sum is the subtle part — a room can be free on the 15th and full on the 16th, and a stay spanning both is only bookable if *every* night has inventory, so the constraint is the worst night.

### 3. Two-phase booking: `reserved` with a hold, then `confirmed`
A new booking enters as `reserved` with a `reserved_until` timestamp; payment moves it to `confirmed` (`confirmation.ts`, which updates only `WHERE status = 'reserved'`).

The alternative — reserve nothing until payment succeeds — means the user enters card details, waits on a payment processor, and gets told the room went to someone else. The opposite alternative — confirm immediately and reconcile if payment fails — sells rooms to people who never pay and leaves them held until someone notices. The hold splits the difference: inventory is committed for a bounded window, long enough to complete payment and short enough that abandonment doesn't cost a night's revenue. `idx_bookings_reserved_until ON bookings(reserved_until) WHERE status = 'reserved'` is a partial index sized for exactly the sweeper query — it indexes only the rows a cleanup job cares about, so it stays small no matter how many completed bookings accumulate.

The honest gap: the sweeper itself isn't running. `expired` is in the status `CHECK` constraint and the index exists, but nothing currently transitions abandoned holds, so in local use a reserved-and-abandoned booking holds inventory indefinitely. The mechanism is designed and half-built.

### 4. Elasticsearch finds hotels; PostgreSQL decides if you can book them
`searchService.ts` queries ES for matching hotels (city match, `geo_distance` within a radius, capacity/star/price/amenity filters), then calls the Postgres-backed availability check for the candidates.

Putting availability in Elasticsearch would collapse this into one fast query, and it would be wrong in the worst possible way. Availability changes on every booking and cancellation; ES is near-real-time with a refresh interval, so search results would confidently show rooms that were taken seconds ago. Users would click through to "sold out" repeatedly — and worse, an oversell could be *justified* by a stale index. Keeping availability in the transactional store means the number shown at the moment of booking is the number the lock and the transaction are about to enforce.

The cost is latency and a fan-out: search is two hops, and the availability check runs per candidate hotel. The 5-minute availability cache is what makes this tolerable, which means search results can be up to five minutes stale — acceptable precisely because search is advisory, and the binding check happens again inside the lock at booking time.

### 5. The Redis lock uses a random lock ID and a TTL, not a plain `SETNX` flag
`acquireLock` generates a UUID as the lock value and only releases if the value still matches. A bare boolean flag has a well-known failure: process A acquires, stalls past the TTL, the lock expires, process B acquires, then A finishes and deletes the key — releasing *B's* lock while B is still working. The lock ID makes release conditional on ownership. The TTL is the other half: without it, a process that crashes mid-booking holds that room type's inventory hostage forever, and the only recovery is a human deleting a Redis key. Thirty seconds bounds the damage to a slow retry.

## Current State

Runs end to end. `docker-compose up -d` starts Postgres (schema auto-loaded from `backend/src/db/init.sql`), Valkey, and Elasticsearch; the API calls `elasticsearch.setupIndex()` on startup, so the hotels index is created automatically. Working: registration/login with bcrypt and Redis-backed sessions, hotel search with geo/text/facet filters and price/rating/relevance sorting, hotel detail with room types and an availability calendar showing per-night pricing (base price plus `pricing_overrides`), the full booking flow through idempotency + distributed lock + `FOR UPDATE` transaction, booking confirmation and cancellation, post-stay reviews, and an admin dashboard for creating hotels, managing room types, and setting date-range price overrides. Operational surface: prom-client metrics (booking duration and revenue, lock acquisition counts and wait times, availability cache hit/miss, search duration), opossum circuit breakers, Pino logging, and health checks.

Seeded logins: `alice@example.com` / `password123` and additional users in `backend/db-seed/seed.sql`; `backend/scripts/seed.ts` (`npm run seed`) populates hotels, room types, and Elasticsearch.

Simplified or omitted: **no expiry sweeper** — reserved holds never transition to `expired` (see decision 3). Payment is simulated; `confirmBooking` accepts a `payment_id` without contacting anything. The `npm run setup-es` script points at `scripts/setup-elasticsearch.ts`, which doesn't exist — index creation happens at server startup instead, so the script is a stale leftover, not a required step. No overbooking policy (real hotels intentionally oversell by 5–10%), no multi-room-type bookings in one transaction, no cancellation-fee rules.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the template phase-checklist CLAUDE.md with this structure. The old file declared **"Phase 3: Scaling and Optimization — *Not started*"** while availability caching, opossum circuit breakers, and a detailed prom-client metrics set were all in use — and its "Design Decisions Log" entry on pessimistic locking still described Redis distributed locks as a hypothetical future addition ("Could add Redis distributed locks as overflow mechanism") when `shared/distributedLock.ts` was already wrapping every booking.
- **Distributed lock added on top of the row lock:** the original implementation relied on `SELECT ... FOR UPDATE` alone, which is correct only if both racing transactions overlap in the database. Because the availability computation is expensive and deliberately runs outside a long transaction, two servers could each read consistent-but-stale availability. `withLock(createRoomLockResource(...))` now serializes check-then-write fleet-wide; the row lock stayed as the backstop for lock expiry (decision 1).
- **Lock release made ownership-conditional:** release compares the stored UUID before deleting, fixing the classic case where a slow process deletes the lock a *different* process now holds.
- **Booking service split into modules:** one monolithic booking service became `booking/{reservation,availability,confirmation,cancellation,cache,queries,formatter,types}.ts`, isolating the concurrency-critical path in `reservation.ts` from the read paths.
- **Backend `dev` pinned to `PORT=3001`** to match the Vite proxy target; previously the script fell through to the default port and the frontend proxied to nothing, surfacing as connection failures that looked like auth bugs.
- **Availability cache invalidation on state change:** the 5-minute TTL alone let a just-cancelled room look occupied for minutes. Booking, confirming, and cancelling now all call `invalidateAvailabilityCache`.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Postgres/Redis/Elasticsearch services these tests need). Verification is local: `npm run type-check`, then `npm run triage hotel-booking`.

## Open Questions

1. Nothing expires abandoned holds, so `reserved_until` and its partial index are load-bearing for a sweeper that doesn't exist. Should expiry be a background interval in the API process (simple, but every instance races to sweep the same rows), or lazy — treating a hold as expired at read time whenever `reserved_until < NOW()` (no job, but every availability query gets more complex and expired rows never actually get cleaned)?
2. All three concurrency layers serialize on `(hotel, roomType, dateRange)`. In a flash sale on one room type that's a single-threaded queue by construction. Is the answer a per-room-type token bucket handed out before the lock, so waiting clients get a fast "sold out" instead of queueing on a 30s lock?
3. Availability is cached for 5 minutes and search results are therefore advisory. Is that window too wide for a room type with low inventory — should TTL scale inversely with remaining rooms, so the last two rooms are effectively uncached?
4. Real hotels oversell deliberately. Adding a soft limit above the hard `total_count` would mean availability has two thresholds and cancellation stops being a pure inventory return. Is that modelable without contaminating the booking path everything else depends on?

## Resources

- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) — `SELECT ... FOR UPDATE` semantics, the backstop in decision 1
- [Redis distributed locks](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/) — including why a TTL'd lock is not a correctness primitive
- [Elasticsearch geo-queries](https://www.elastic.co/guide/en/elasticsearch/reference/current/geo-queries.html) — the `geo_distance` filter in `models/elasticsearch.ts`
- [PostgreSQL `generate_series`](https://www.postgresql.org/docs/current/functions-srf.html) — the date expansion behind the per-night availability count
- [opossum](https://nodeshift.dev/opossum/) — the circuit breaker library in `shared/circuitBreaker.ts`
