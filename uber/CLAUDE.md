# Uber — Ride Hailing — Development with Claude

## Project Context

A ride-hailing platform connecting riders and drivers: request a ride, get matched to a nearby driver, watch them arrive in real time, pay a fare that flexes with demand. The core hard problem is **low-latency geospatial matching under a moving supply** — drivers' locations change every few seconds, and the system has to find, score, and offer a ride to the best of them in well under a second, while surge pricing keeps supply and demand roughly balanced.

**Learning goals:** Redis geospatial indexing on the hot path, asynchronous matching via a work queue, supply/demand surge pricing, WebSocket real-time delivery, and graceful degradation (circuit breakers) when the geo store misbehaves.

## Architecture at a Glance (what actually runs)

Three backend datastores plus a message broker, each on a specific access pattern — matches `docker-compose.yml` and `backend/package.json`:

| Store | Client | Role | Why this one |
|-------|--------|------|--------------|
| **PostgreSQL 16** | `pg` | Source of truth: users, drivers, rides, payments, sessions, analytics rollups | ACID for the ride lifecycle and money; optimistic-locked status transitions |
| **Redis / Valkey** | `ioredis` | Live driver geo index (`GEOADD`/`GEORADIUS`), driver status, surge demand counters, ride cache | Sub-ms radius queries on ephemeral hot data that changes every 3s |
| **RabbitMQ** | `amqplib` | Matching request queue + `ride_events` fanout exchange feeding workers | Decouples the < 200ms request API from the slower matching loop |

**Services:** one Express API (`src/app.ts`, routes `auth`, `rides`, `driver`) plus a raw `ws` WebSocket server for offers and location streaming. **Three workers** (`src/workers/`): `matching-worker` (consumes match requests), `notification-worker`, `analytics-worker`. **Frontend:** React 19 + TanStack Router + Zustand (`authStore`, `driverStore`, `rideStore`), Tailwind, separate Rider and Driver apps talking to `services/api.ts` and `services/websocket.ts`.

## Key Design Decisions

### 1. Redis GEO for the driver index, not PostGIS
Driver locations are hot, ephemeral data — rewritten every ~3 seconds, only relevant while online. `locationService` keeps them in a single Redis sorted set (`drivers:available`) via `GEOADD` and queries with `GEORADIUS ... WITHDIST ... COUNT 20 ASC`. PostGIS would mean disk I/O and connection-pool pressure for data that is overwritten seconds later. Trade-off: everything lives in memory and is lost on a Redis flush, so PostgreSQL holds a lagging persisted copy (`persistLocation` writes async, best-effort).

### 2. Asynchronous matching through RabbitMQ
`requestRide` inserts the ride, publishes to the `matching.requests` queue, and returns `202 {status: matching}` immediately — the rider sees "Searching" in < 200ms. The `matching-worker` does the expensive part (geo query → score → offer) off the request path. Trade-off: matching is eventually-consistent and needs a timeout/retry (`maxWaitSeconds`, `attempt` in the message) rather than a synchronous success/fail, but the API stays fast and a worker crash just leaves the message to be reprocessed.

### 3. Weighted first-match scoring, not global optimization
`scoring.ts` scores each nearby driver as `0.6 × etaScore + 0.4 × ratingScore` (ETA normalized against a 30-min ceiling, rating against a 3–5 band), sorts descending, and offers to the top candidate with an acceptance timeout before falling to the next. Trade-off: this is greedy — a batch Hungarian assignment would be globally optimal across many simultaneous requests — but greedy is O(n log n), easy to reason about, and good enough below the scale where global assignment pays off.

### 4. Surge by geohash supply/demand ratio
`pricingService` encodes the pickup into a ~5km geohash (precision 5). Each request `INCR`s a `demand:<geohash>` counter with a 5-min TTL; supply is a `GEORADIUS` count within 3km. The ratio maps through a fixed table to a multiplier (≥2.0 → 1.0×, down to 2.5× when supply is starved). Trade-off: square geohash cells are coarser than Uber's real H3 hexagons and create boundary discontinuities, but the TTL gives a self-cleaning rolling window with no background job.

### 5. Circuit breaker around Redis geo ops
Every geo call goes through an Opossum breaker (`createCircuitBreakerWithFallback`, 3s timeout, opens at 50% errors). When open, `findNearbyDrivers` returns an empty list — the rider sees an honest "no drivers available" instead of a hung spinner — while writes fail fast. Trade-off: during a Redis blip we under-match rather than block the whole API on a slow dependency.

## Current State

Implemented end to end: session auth (rider + driver registration/login), driver online/offline + location streaming over WebSocket, Redis geo index with async PG persistence, fare estimation for all four vehicle types, surge pricing, async matching worker with weighted scoring and offer/accept/timeout, the full ride lifecycle (requested → matched → driver_arrived → picked_up → completed / cancelled) with optimistic-locked transitions, notification and analytics workers writing to `notifications` / `analytics_*` tables, plus Prometheus metrics (`prom-client`), pino structured logging, and `/health/live` + `/health/ready` probes.

Intentionally omitted (production extensions): Kafka for the location firehose, Redis Pub/Sub to route WebSocket messages across multiple API instances, ETA from a real routing engine (uses a distance-based estimate), H3 hexagonal surge zones, real payment processing, and batch/global matching.

## Iteration & Repair Log

- **DB migrate/seed + workers** (`79f37320`): added the three background workers and the `db/init.sql` + `db-seed/seed.sql` path so the schema and test users apply without hand-running SQL; docker-compose mounts `init.sql` into `docker-entrypoint-initdb.d`.
- **Seed password normalization (repo-wide):** all seeded users (`rider1/2@test.com`, `driver1/2/3@test.com`) log in with **`password123`**; the README credentials table matches.
- **Answer-file trim:** `system-design-answer-fullstack.md` was ~728 lines; condensed the oversized ride-request sequence diagram and several state-sync diagrams into compact form to bring it under the 600-line target without losing the flow.
- **Doc drift fixes (this pass):** the old CLAUDE.md claimed "Docker Compose for PostgreSQL and Redis" and never mentioned RabbitMQ or the workers — corrected to the real three-store + broker topology. README's native-install pointed at a nonexistent `backend/src/models/init.sql` and omitted RabbitMQ; fixed to `backend/src/db/init.sql`, added the RabbitMQ install step and an explicit seed command.
- **CI note (repo-wide):** the GitHub Actions smoke-test workflow was removed (couldn't run without Docker services); don't treat it as active.

## Open Questions

1. Cross-instance WebSocket routing is stubbed by running a single API instance — at what connection count does the Redis Pub/Sub fan-out become mandatory, and does that change the offer-timeout budget?
2. Matching is greedy per request; at what concurrent-request density in one geohash does batch assignment actually beat first-match on rider wait time?
3. Surge uses square geohashes with hard boundaries — is the price discontinuity at cell edges bad enough to justify H3, or does interpolation across neighboring cells suffice?
4. Location is persisted to PostgreSQL best-effort and async; is the Redis-vs-PG divergence ever load-bearing for anything besides post-hoc analytics?

## Resources

- [Redis Geospatial commands](https://redis.io/docs/latest/develop/data-types/geospatial/)
- [Uber H3 hexagonal grid](https://www.uber.com/blog/h3/) — the production surge-zone system this project approximates with geohashes
- [Opossum circuit breaker](https://nodeshift.dev/opossum/)
