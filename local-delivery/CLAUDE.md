# Local Delivery — Development with Claude

## Project Context

A last-mile delivery platform (DoorDash-shaped): customers order from local merchants, the system finds a nearby driver, and everyone watches the order move in real time. The hard problem is the **matching loop** — turning "an order was placed" into "a specific driver accepted it" while being fair to drivers, fast for customers, and resilient when the matching path itself degrades. The design leans on Redis geo-indexing for "who's nearby," a sequential-offer protocol for "who gets it," WebSockets for "where is it now," and a circuit breaker so a sick matcher fails into a retry queue instead of taking orders down.

**Learning goals:** real-time geospatial queries, a fair dispatch protocol, WebSocket + pub/sub fan-out, and protecting a critical-path algorithm with a circuit breaker.

## Architecture at a Glance (what actually runs)

Two datastores — this matches `docker-compose.yml` and `backend/package.json`:

| Store | Client | Role | Why this one |
|-------|--------|------|--------------|
| **PostgreSQL 16** (`pg`) | Source of truth | `users`, `drivers`, `merchants`, `menu_items`, `orders`, `order_items`, `driver_offers`, `ratings`, `delivery_zones`, `sessions`, `driver_location_history`, `idempotency_keys`, `retention_policies` | ACID for the order lifecycle and the durable audit of offers/ratings |
| **Redis / Valkey 7** (`ioredis`) | Real-time layer | Driver geo-index (`GEOADD`/`GEOSEARCH`), session cache, pub/sub for live updates | Sub-ms proximity queries on the matching critical path; PostGIS at ~5–10ms is too slow per match |

Backend is a single Express app (port 3000) with routes `auth`, `orders`, `driver`, `merchants`, `admin`, plus a native `ws` WebSocket server at `/ws`. The order logic is split under `services/order/` into `create`, `matching`, `assignment`, `status`, `delivery`, `tracking`. Cross-cutting `shared/` modules: `circuitBreaker` (Opossum), `idempotency`, `metrics` (prom-client), `retention` (data-cleanup jobs), `logger` (pino). Frontend: React 19 + TanStack Router + Zustand, with customer, driver, and admin interfaces.

## Key Design Decisions

### 1. Redis geo-index for driver location, not PostGIS
Driver positions are written to a Redis geo set and matched with `GEOSEARCH`; PostgreSQL keeps only `driver_location_history` for after-the-fact analysis. Trade-off: "who's within N km of this merchant" sits on the order critical path and runs constantly as drivers move, so we want the sub-millisecond answer Redis gives rather than PostGIS's ~5–10ms per query. What we give up is durability of live positions — a Redis flush loses current locations (rebuilt on the drivers' next ping) — which is acceptable because live location is inherently ephemeral while the trip record in Postgres is not.

### 2. Sequential driver offers, not broadcast
`startDriverMatching` finds the best available driver, creates a **time-limited `driver_offers` row (30s)**, and polls for accept/reject/expire before moving to the next-best driver, excluding those already offered, up to `MAX_OFFER_ATTEMPTS`. Trade-off: broadcasting to all nearby drivers would fill the order faster but creates a race (two drivers "win" the same order) and is unfair (fastest tapper wins every time). Sequential offers give each driver an exclusive window and make acceptance a clean state transition — at the cost of higher time-to-assign, which we bound with the attempt cap and fall back to cancellation when exhausted.

### 3. Driver scoring is multi-factor, not nearest-only
`calculateDriverScore` weights **distance 40%, rating 25%, acceptance rate 20%, current load 15%** (normalized against a 5km max). Trade-off: pure nearest-driver minimizes ETA but ignores reliability — a close driver who routinely rejects or is already juggling deliveries is a worse pick than a slightly-farther dependable one. The weights bias toward proximity while still pricing in reliability; the cost is a heuristic that needs tuning against real acceptance data.

### 4. Circuit breaker around matching with a retry-queue fallback
The matcher is wrapped in an Opossum breaker (opens at 50% errors over 3+ calls, resets after a timeout). When open, the **fallback re-marks the order `pending`** and queues it for retry rather than failing the customer outright. Trade-off: while open, orders wait instead of matching immediately — but the alternative (every order blocking on a degraded matcher, e.g. Redis latency spiking) cascades into a total outage. Failing fast into a retry queue keeps the rest of the API — browsing merchants, tracking in-flight orders — alive.

### 5. Native WebSocket + Redis pub/sub for live tracking
Order status and driver-location updates push over a native `ws` server; Redis pub/sub distributes messages so any API instance can deliver to a connected client. Trade-off vs. Socket.io: fewer features (no built-in rooms/reconnection) but lower overhead and no dependency, which suits point-to-point order tracking. Trade-off vs. polling: persistent connections cost server memory, justified by the second-by-second freshness a live map needs.

## Current State

Implemented and running end to end: session auth (bcrypt + Redis-cached sessions in Postgres), merchant/menu browsing, order placement with idempotency keys, the sequential-offer matching loop with multi-factor driver scoring and the Opossum circuit breaker, driver location tracking via Redis geo, order lifecycle status transitions, ratings, WebSocket live updates over Redis pub/sub, Prometheus metrics, `pino` logging, and data-retention cleanup jobs. Frontend has customer ordering, a driver dashboard with offer accept/reject, and an admin dashboard with stats. Seeded accounts (customers, drivers, admin) all log in with **`password123`**.

Intentionally omitted: map visualization of the live driver (tracking data flows over WebSocket but there's no map widget), multi-stop/batched routing (TSP), surge pricing, demand prediction, and PostGIS.

## Iteration & Repair Log

- **Seed password normalized to `password123` — the "fix bcrypt" TODO is done.** The prior CLAUDE.md listed "[ ] Fix bcrypt password hashing for demo accounts" as remaining. The seed hash now verifies against `password123` (confirmed via `bcrypt.compare`), and `authService.validatePassword` does a real bcrypt check. The stale TODO is removed.
- **README credential drift (this pass).** The README listed the password as `password` and claimed "any password will work" — both false; login is bcrypt-verified and the password is `password123`. Corrected.
- **README missing seed step (this pass).** The mounted `backend/src/db/init.sql` is schema-only (no INSERTs); the demo accounts live in `backend/db-seed/seed.sql`, which isn't mounted and has no npm script. `docker-compose up` alone leaves the DB unseeded. Added an explicit `psql -f backend/db-seed/seed.sql` step so the README actually produces the accounts it documents.
- **Order service split.** `services/order/` was broken into `create`/`matching`/`assignment`/`status`/`delivery`/`tracking` to keep each concern focused.
- **CLAUDE.md rewrite (this pass).** Replaced the Phase 1–4 checklist ("Phase 3/4: Not started") with real architecture + decision rationale grounded in `services/order/matching.ts` and `services/driverService.ts`.
- **2026-11-01 (WebSocket tracking scope).** The `/ws` auth was already sound: `?token=` is the server-issued session token, resolved with the same `getSessionByToken` the REST middleware uses; `subscribe_order` checks customer/assigned driver/admin; and `update_location` takes the role from the DB and writes the session user's own location. The hole was in what a subscription kept streaming. `subscribe_order` subscribed to `driver:<driver_id>:location` whenever the order had a driver, without looking at its status. A delivered or cancelled order keeps `driver_id`, so any past customer could send `subscribe_order` for an old order and follow that driver's live position through later deliveries for other customers, for as long as the socket stayed open. A socket that stayed subscribed past `delivered` got the same stream. Now the driver channel is joined only while the order is not `delivered`/`cancelled`, and a terminal `status_update` unsubscribes it. `tsc --noEmit` is clean before and after; the backend has no test suite. Verified against the live stack (8 checks): no token or a user id as token closes with 4001; the customer's active order streams the driver's location and another customer is refused it; a customer's `update_location` is refused; after delivery neither the still-open socket nor a new subscription gets the driver's location. The live run also exposed an unrelated bug: `driver_offers.expires_at` is `TIMESTAMP` without time zone, so a backend whose `TZ` differs from Postgres's (UTC in Docker) stores offer expiry in local time and `expires_at > NOW()` makes every offer look hours expired, so drivers never see them. The check was run with `TZ=UTC`; the column types are fixed in the 2026-11-02 entry.
- **2026-11-02 (timestamps are `TIMESTAMPTZ`; offers visible again in any backend time zone).** Reproduced first on the old schema with the backend in Pacific time and no `TZ`: an offer created at 18:16 UTC was stored with `expires_at` 10:16:35, so `GET /driver/offers/pending` returned nothing for either driver. The bug was wider than offers. With plain `TIMESTAMP`, `pg` writes a JS `Date` as local wall-clock time and reads the column back as local time, while `DEFAULT CURRENT_TIMESTAMP` and `NOW()` use the server's zone. So every JS-written column (offer and idempotency expiry, `estimated_delivery_time`) was 8 hours behind `NOW()`, and every Postgres-written column (`created_at`, `delivered_at`, …) went out over the API 8 hours ahead: an order placed at 18:16 UTC came back with `created_at` 02:16 the next day. The retention job's `sessions.expires_at < NOW()` would also have deleted sessions 8 hours early. All 32 timestamp columns in `init.sql` (and the schema in `architecture.md`) are now `TIMESTAMPTZ`, which stores an instant and makes JS Dates and `NOW()` comparable. Offer and idempotency-key expiry are also computed in SQL (`NOW() + make_interval(...)`), because they are only ever compared against `NOW()`. That keeps them on the database clock, so skew on an app host can't eat into a 30s offer window. Session expiry stays JS-computed because `authService` checks it in JS and caches it in Redis; `TIMESTAMPTZ` alone makes that correct. Because `init.sql` only runs on an empty volume, existing setups need `docker-compose down -v` and a reseed (added to the README). `tsc --noEmit` is clean. Verified live with `npm run dev` in `America/Los_Angeles` and no `TZ` in the server environment: `customer1` ordered from Pizza Palace, `driver2` saw the offer with 29s left (`expires_at - offered_at` = 30s) and accepted it, and the order moved to `driver_assigned` with `created_at`/`estimated_delivery_time` in correct UTC. A second order checked the other direction: an idempotent replay returned the same order id; the unanswered offer was visible at 1.5s and gone at 32.5s, marked `expired` in the DB.

## Open Questions

1. **Driver goes offline mid-delivery:** currently disallowed. A grace period + automatic reassignment (re-entering the matching loop) would be more robust — how long before reassigning?
2. **Offer latency vs. fill rate:** 30s sequential offers can be slow to fill in low-density areas. Is a hybrid (broadcast to top-K with first-accept-wins under a short lock) worth the added race-handling complexity?
3. **Seed-vs-init mismatch:** should the demo users move into the mounted `init.sql` (so `docker-compose up` self-seeds), or should a `db:seed` npm script be added? The current split surprises anyone not using the screenshot harness.
4. **Batching:** multi-order pickup from one merchant (TSP over drop-offs) would raise driver efficiency — where does the added routing complexity pay off?

## Resources

- [Redis Geospatial](https://redis.io/docs/data-types/geospatial/) — `GEOADD`/`GEOSEARCH` driver index
- [Haversine formula](https://en.wikipedia.org/wiki/Haversine_formula) — distance/ETA in `utils/geo.ts`
- [Opossum circuit breaker](https://nodeshift.dev/opossum/) — matching-path protection
