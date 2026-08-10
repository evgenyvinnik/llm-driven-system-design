# Uber — Ride Hailing — Development with Claude

## Project Context

A ride-hailing platform connecting riders and drivers: request a ride, get matched to a nearby driver, watch them arrive in real time, pay a fare that flexes with demand. The core hard problem is **low-latency geospatial matching under a moving supply** — drivers' locations change every few seconds, and the system has to find, score, and offer a ride to the best of them in well under a second, while surge pricing keeps supply and demand roughly balanced.

**Learning goals:** Redis geospatial indexing on the hot path, asynchronous matching via a work queue, supply/demand surge pricing, WebSocket real-time delivery, and graceful degradation (circuit breakers) when the geo store misbehaves.

## Architecture at a Glance (what actually runs)

Three backend datastores plus a message broker, each on a specific access pattern — matches `docker-compose.yml` and `backend/package.json`:

| Store | Client | Role | Why this one |
|-------|--------|------|--------------|
| **PostgreSQL 16** | `pg` | Source of truth: users, drivers, rides, payments, sessions, analytics rollups | ACID for the ride lifecycle and money; the match transition is a status compare-and-swap (see repair log) |
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

- **2026-08-10 — three of six screens showed nothing, and two pages were unreachable.**
  1. **`/rider/history` rendered the rider *index* page.** With TanStack flat routing, `rider.tsx` is the PARENT of `rider/history.tsx`, and it renders no `<Outlet/>` — so the child never mounted and the parent's own content appeared at the child's URL. `driver.tsx` had the same relationship with `driver/earnings.tsx` and `driver/history.tsx`. Three fully-built pages were unreachable by any path. Fixed by moving both parents to `rider/index.tsx` / `driver/index.tsx` so they are siblings of their children. **Third occurrence of this class in the repo** (payment-system's `transactions.tsx`, reddit's `r.$subreddit.tsx`) — worth a repo-wide sweep for any `X.tsx` that has an `X/` directory beside it and no `<Outlet/>`.
  2. **Both driver screens were captured as the login page.** The harness logged in once as `rider1@test.com`, and `/driver` redirects non-drivers. The harness already supports per-screen `loginAs` for exactly this multi-sided case; the config simply never used it.
  3. **The seed had users, drivers, and payment methods and no rides at all**, so rider history, driver history, and the earnings dashboard were all empty — and earnings defaults to "today", so rides had to be completed *today* to show anything. Seeded 9 rides across both riders and all three drivers, including a cancellation, with fares internally consistent against their distance/duration/surge so the earnings total isn't nonsense.
  4. **Every fare estimate read "No drivers nearby" for all four vehicle types.** Drivers seeded with `is_online = FALSE` and no coordinates, and — the deeper issue — **nothing ever reads the persisted location copy back.** Decision 1 accepts that the Redis geo index is ephemeral and says PostgreSQL holds a lagging copy via `persistLocation`; but that copy was write-only, so after any Redis restart supply was invisible until every driver's app reconnected. Added `restoreGeoIndexFromDatabase()`, called at boot, which `GEOADD`s online drivers back into `drivers:available`. Same pattern as tinder's Elasticsearch backfill: the durable store has to be readable back, or it isn't really a backup.
- **Also:** the rider address inputs had no `id`/`name`/`htmlFor` (no stable selector, no label association) and the Set buttons no `data-testid`; "1 rides" pluralization in the hourly earnings breakdown. Screenshots 6 → 7, all showing real data — including 1.1× surge and XL correctly reporting no drivers, since no XL driver is seeded.
- **2026-08-10 (answer doc) — corrected a claim this file was also making.** `system-design-answer-backend.md` described "optimistic locking" with a `version` column on `rides`. **There is no `version` column.** What exists is narrower and worth stating precisely: the accept path runs `UPDATE rides SET ... WHERE id = $2 AND status = 'requested'` and treats zero rows as "another driver got there first" — a compare-and-swap on the status column, which is the right guard for the one transition that actually races. The later transitions (`driver_arrived`, `picked_up`, `completed`) are unguarded, so a retried request can move a ride backwards or overwrite `final_fare_cents`. A code comment in `allocation.ts` also says "(version check)" and is wrong. Doc trimmed 552 → 542 lines, with the index/Redis/surge tree-and-box listings converted to tables and the geohash-vs-H3 trade-off written out properly.

## Open Questions

1. Cross-instance WebSocket routing is stubbed by running a single API instance — at what connection count does the Redis Pub/Sub fan-out become mandatory, and does that change the offer-timeout budget?
2. Matching is greedy per request; at what concurrent-request density in one geohash does batch assignment actually beat first-match on rider wait time?
3. Surge uses square geohashes with hard boundaries — is the price discontinuity at cell edges bad enough to justify H3, or does interpolation across neighboring cells suffice?
4. Location is persisted to PostgreSQL best-effort and async; is the Redis-vs-PG divergence ever load-bearing for anything besides post-hoc analytics?

## Resources

- [Redis Geospatial commands](https://redis.io/docs/latest/develop/data-types/geospatial/)
- [Uber H3 hexagonal grid](https://www.uber.com/blog/h3/) — the production surge-zone system this project approximates with geohashes
- [Opossum circuit breaker](https://nodeshift.dev/opossum/)
