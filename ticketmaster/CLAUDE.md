# Ticketmaster — Development with Claude

## Project Context

Ticket sales look like e-commerce until you notice the inventory is *unique*. There is exactly one seat A-14 in Floor A, it cannot be back-ordered, and at 10:00:00 on on-sale day several thousand people want it simultaneously. Every hard problem in this project descends from that one fact: you cannot oversell, you cannot make buyers wait behind a lock, and you cannot serve a seat map that says "available" when it isn't.

The second constraint is the traffic shape. Load isn't a curve, it's a step function — near-zero, then everything, at a wall-clock instant everyone knows in advance. A system sized for the average is useless; a system sized for the peak is mostly idle. So the design instead *reshapes* demand: a virtual waiting room admits a bounded number of shoppers, and everyone else gets a queue position instead of a 503.

**Learning goals:** distributed locking without deadlock or overselling, hold-and-expire reservation semantics, admission control as a load-shedding strategy, idempotent checkout across an unreliable payment provider, and cache TTLs chosen against a correctness cost rather than a latency budget.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts`) | **3001** | Single Express process; `dev:server2`/`dev:server3` (3002/3003) exist to exercise the locking across instances |
| **PostgreSQL 16** | 5432 | Seat inventory is money. `event_seats.status` is the authority, enforced inside transactions with `FOR UPDATE NOWAIT` |
| **Valkey (Redis)** | 6379 | Three distinct jobs: per-seat distributed locks, the waiting-room sorted set, and the short-TTL availability cache |
| **Frontend** (Vite) | 5173 | Proxies `/api` → `localhost:3001` |

Services live in `backend/src/services/`: `seat.service.ts` (the core — availability, reserve, release, expiry sweep), `waiting-room.service.ts` (queue + admission), `checkout.service.ts` (payment, orders, idempotency), `event.service.ts`, `auth.service.ts`. Cross-cutting code is in `backend/src/shared/`: `distributed-lock.ts` (Redis `SET NX EX` + Lua compare-and-delete release, with a PostgreSQL advisory-lock fallback), `idempotency.ts`, `circuit-breaker.ts`, `metrics.ts`, `logger.ts`. Schema in `backend/src/db/init.sql`, mounted into the Postgres container's `docker-entrypoint-initdb.d`, including a `generate_event_seats(event_id)` plpgsql function that materializes per-seat rows from `venue_sections` templates.

Frontend is React 19 + TanStack Router + Zustand + Tailwind. `stores/ticket.store.ts` holds seat selection, queue status, and a client-side countdown driven by the server's `expiresAt`; `components/SeatMap.tsx` and `components/WaitingRoom.tsx` are the two screens that matter.

Three background jobs run in-process from `index.ts`: expired-hold cleanup (60s), on-sale promotion (30s), queue metrics (5s).

## Key Design Decisions

### 1. Two-layer locking: Redis `SET NX` in front of Postgres `FOR UPDATE NOWAIT`

`reserveSeats()` first takes a Redis lock per seat, then opens a transaction that re-checks the rows with `FOR UPDATE NOWAIT` before flipping them to `held`. The Redis layer exists to keep contention *off* the database: during an on-sale, most concurrent requests for a hot seat are losers, and a `SET NX` round-trip rejects them for microseconds and zero database connections.

Plain pessimistic locking — `SELECT … FOR UPDATE` without `NOWAIT` — fails in a specific and ugly way. A blocking lock makes each loser hold a pooled Postgres connection for the *entire* duration of the winner's transaction. With a default pool of a few dozen connections and thousands of buyers converging on the same section, the pool is exhausted by waiters within a second, and then every request to the service fails — including browsing events that have nothing to do with that seat. One contended row takes down the API. `NOWAIT` converts that queue into an immediate error, which the user experiences as "pick another seat" rather than a hung spinner.

What we give up: two authorities that can disagree. A Redis lock can be granted for a seat the database already considers `held` (say, after a Redis flush), so the transaction has to re-verify and the catch block has to release every lock it took. There's also no ordering discipline — `acquireSeatLocks` takes locks in whatever order the client sent the seat IDs, so two users requesting {A,B} and {B,A} can each hold one and block the other. That isn't a deadlock only because acquisition is bounded (3 retries, exponential backoff with jitter) and then gives up and releases; it's livelock-free by fail-fast, not by lock ordering.

### 2. Hold expiry lives in the database column, not in the Redis TTL

Seats are held for 600 seconds. That number appears twice — as the Redis lock TTL and as `event_seats.held_until` — and a background sweeper (`cleanupExpiredHolds`, every 60s) is what actually returns seats to inventory.

Letting the Redis TTL be the mechanism is the obvious simplification and it silently destroys inventory. When the lock key expires, nothing tells Postgres; the row stays `status='held'`, `held_by_session` set, forever. The seat is not sold and not sellable — it has simply vanished from the event, and `events.available_seats` is now wrong too. Keyspace notifications don't rescue this either: they're fire-and-forget, so a Redis restart or a dropped connection during the notification loses the event permanently, and you find out when a customer asks why row F is empty at the show.

Making the database column authoritative means the truth survives any Redis failure, and the sweeper is idempotent — it re-derives `available_seats` with a `COUNT(*)` rather than incrementing a counter that could drift. The cost is up to 60 seconds where a seat is expired but still shows as held, and a sweeper that does one `UPDATE` per expired seat in a loop rather than a set-based statement. At real on-sale volume that loop is the first thing that would need rewriting.

### 3. A virtual waiting room, because rate limiting fails everyone equally

`waiting-room.service.ts` keeps a Redis sorted set `queue:{eventId}` scored by arrival timestamp (plus sub-millisecond jitter to break ties), and a set `active:{eventId}` capped at the event's `max_concurrent_shoppers` (schema default 5000). A per-event `setInterval` admits the next batch every second.

The alternative — admit everyone, rate-limit the endpoints — is worse in a way that isn't obvious until you count. Madison Square Garden seats ~20,000. If half a million people arrive at on-sale, admitting all of them means half a million clients polling a seat map, and roughly 480,000 of them are going to fail no matter what, because the seats don't exist. Rate limiting distributes the pain uniformly: everyone gets intermittent 429s, everyone retries, retries amplify load, and nobody can tell whether they're failing because they're late or because the site is broken. The queue instead converts overload into information — position #34,102 and an estimated wait — which is both a better experience and a natural backpressure valve, since a waiting client isn't hitting the seat map at all.

What we give up is honest and visible in the code: the queue processor is an in-process `setInterval` stored in a per-process `Map`. Run the three API instances this repo is set up for and you get three processors admitting from the same sorted set, so the effective admission rate is 3× the intended one. Worse, `admitNextBatch` does `SCARD` → `ZRANGE` → pipeline as separate round-trips, so the `maxConcurrent` check races between instances and the active set can overshoot. Making this correct needs the admission decision to be a single Lua script, and the processor to be leader-elected or a dedicated worker.

### 4. Availability cache TTL is set by correctness, not by latency

`getSeatAvailability` caches per event+section, but the TTL is chosen dynamically: 5 seconds while the event is `on_sale`, 30 seconds otherwise. Every mutation path (reserve, release, checkout, cancel, expiry sweep) also calls `invalidateAvailabilityCache`.

Uncached, this is the single hottest read in the system and the most expensive: MSG's seed layout generates thousands of `event_seats` rows per event, and the endpoint reads all of them to group by section. Serving that per client per poll during an on-sale is how you melt the database. But a long TTL doesn't fail by being slow — it fails by lying. A user who clicks a seat the cache still calls available gets a reservation error, and from their side, at the moment they've been waiting an hour for, the site looks broken. Five seconds is the window we're willing to be wrong for, backed by explicit invalidation so the common case is far tighter than the TTL.

The cost: `invalidateAvailabilityCache` uses `redis.keys('availability:{id}:*')`, which is an O(N) scan of the entire keyspace and blocks Redis while it runs — called on every single reservation. That is fine at seed scale and is exactly the wrong thing at real scale; a tracked key set or a per-event version counter is the fix.

### 5. Checkout is idempotent by derivation, not by client cooperation

`checkout()` takes an optional `X-Idempotency-Key`, and when the client doesn't provide one, `validateIdempotencyKey` derives a deterministic key from (sessionId, eventId, sorted seatIds). Results are stored in the `idempotency_keys` table and `orders.idempotency_key` carries a UNIQUE constraint.

Trusting clients to send keys is the standard design and it leaks in exactly the scenario that matters: a user double-clicks Buy, or their phone drops the connection after the payment succeeded but before the response arrived, and the retry charges them twice for seats they already own. Deriving the key means the *server* can recognize "this is the same purchase" even from a client that knows nothing about idempotency. The final defense is inside the transaction: the `UPDATE … WHERE held_by_session = $1 AND status = 'held'` checks `rowCount` against the expected seat count and aborts if they differ, so a race that slipped past both lock layers still cannot oversell — it logs `oversellPrevented` and fails the order.

The trade-off is that the derived key makes a *legitimate* second purchase of the same seats by the same session in the same 24-hour window indistinguishable from a retry. For seats — which can only be bought once — that's harmless. For any fungible product it would be a bug.

## Current State

Runs end to end on a single `npm run dev` (API on 3001) plus `docker-compose up -d` for Postgres and Valkey. Implemented: session auth with bcrypt and cookies, event and venue browsing, seat-map availability with the dynamic cache, seat reservation with the dual-lock path, release, the 10-minute hold with client countdown, the virtual waiting room (join / status / leave / stats), idempotent checkout with a circuit-breaker-wrapped payment call, order history and cancellation, three background jobs, Prometheus metrics at `/metrics`, structured pino logging with correlation IDs and business events (`seatReserved`, `oversellPrevented`, `lockContention`, `redisFallback`), and `/health` `/ready` `/live` probes that report Postgres, Redis, and payment-breaker state.

Seeded login: `admin@ticketmaster.local` / `password123`. Four venues (MSG, The O2, Staples Center, Red Rocks) with section templates; two events are seeded `on_sale` and have their seats materialized via `generate_event_seats`.

Simulated or omitted: payment is `simulatePaymentProcessing` with a 95% success rate and 100–300ms of fake latency — deliberately, because it exercises the circuit breaker and the failure path on most runs. There is no admin UI, no scalper/bot detection (`max_tickets_per_user` is in the schema but not enforced at reservation time), no ticket delivery or QR generation, no CDN, and no load balancer in front of the three-instance setup.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. Its "Phase 3: Scaling and Optimization — *Not started*" listed "Add caching layer" and "Add monitoring" as future work while `seat.service.ts` already had the dynamic-TTL availability cache with explicit invalidation, `/metrics` was serving prom-client output, and `/health` was reporting circuit-breaker state. The old file also had no explanation of *why* there are two lock layers, which is the only genuinely hard thing in this project.
- **Backend port pinned to 3001:** the `dev` script is `PORT=3001 tsx watch src/index.ts` so it matches the Vite proxy target in `frontend/vite.config.ts`. Note `index.ts` still defaults to 3000 when `PORT` is unset — running `tsx src/index.ts` directly binds the wrong port and the frontend silently gets nothing.
- **Seed password comment is wrong:** `db-seed/seed.sql` says `-- Create admin user (password: admin123)`, but the hash is the repo-shared bcrypt hash for **`password123`** (identical to the one in uber/microsoft-teams/twitter seeds, which document it correctly). The screenshot config uses `password123`, which is the working credential. The comment, not the hash, is the defect.
- **Dead `db:seed` script:** `backend/package.json` declares `"db:seed": "tsx src/db/seed.ts"`, but `src/db/` contains only `init.sql`, `pool.ts`, and `redis.ts`. Seeding is actually `db-seed/seed.sql` piped into psql; the schema itself loads from the compose mount, so there is no `db:migrate` step here.
- **Redis lock key formats diverged:** `distributed-lock.ts` writes `lock:seat:{eventId}:{seatId}` while older code paths in `seat.service.ts` used `seat_lock:{eventId}:{seatId}`. Both are now deleted on release and in the expiry sweep, which is defensive rather than correct — the legacy format should go.
- **CI:** the repo-wide smoke-test workflow was removed; a CI runner can't provide the Postgres and Valkey services these paths need, so verification is local (`npm run triage ticketmaster`).

## Open Questions

1. The waiting-room processor is per-process, so N API instances admit at N× the configured rate and the `maxConcurrent` check races. Is the right fix a Lua-scripted atomic admit, a leader-elected worker, or moving admission out of the API entirely?
2. Cache invalidation calls `redis.keys()` on every reservation — O(keyspace) and blocking. Is a per-event version counter (bump an integer, include it in the cache key) simpler than maintaining a tracked key set?
3. Hold duration is a flat 600 seconds for everyone. Should it shrink as inventory does — a 10-minute hold on the last 50 seats of a sold-out show has a very different opportunity cost than one placed at minute two?
4. `max_tickets_per_user` exists in the schema but nothing enforces it. Enforcing per-*user* is easy and useless against scalpers who make accounts; enforcing per-payment-instrument or per-device means state we don't have. Is there a version worth building at this scale, or is it honestly out of scope?
5. Redis is a hard dependency for reservations even though `acquireSeatLockWithFallback` (advisory locks) exists and is unused by the main path. Should the fallback be wired in, or is a reservation outage during a Redis outage the correct, honest behavior?

## Resources

- [Redis distributed locks (Redlock)](https://redis.io/docs/latest/develop/use-cases/patterns/distributed-locks/) — and the reasons single-instance `SET NX` is what we actually use
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) — `FOR UPDATE NOWAIT` semantics and advisory locks
- [Ticketmaster engineering blog](https://tech.ticketmaster.com/)
- [Redis sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) — the waiting-room queue primitive
- [Stripe: designing robust and predictable APIs with idempotency](https://stripe.com/blog/idempotency)
