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

## Open Questions

1. **Driver goes offline mid-delivery:** currently disallowed. A grace period + automatic reassignment (re-entering the matching loop) would be more robust — how long before reassigning?
2. **Offer latency vs. fill rate:** 30s sequential offers can be slow to fill in low-density areas. Is a hybrid (broadcast to top-K with first-accept-wins under a short lock) worth the added race-handling complexity?
3. **Seed-vs-init mismatch:** should the demo users move into the mounted `init.sql` (so `docker-compose up` self-seeds), or should a `db:seed` npm script be added? The current split surprises anyone not using the screenshot harness.
4. **Batching:** multi-order pickup from one merchant (TSP over drop-offs) would raise driver efficiency — where does the added routing complexity pay off?

## Resources

- [Redis Geospatial](https://redis.io/docs/data-types/geospatial/) — `GEOADD`/`GEOSEARCH` driver index
- [Haversine formula](https://en.wikipedia.org/wiki/Haversine_formula) — distance/ETA in `utils/geo.ts`
- [Opossum circuit breaker](https://nodeshift.dev/opossum/) — matching-path protection
