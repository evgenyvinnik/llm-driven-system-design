# Design DoorDash — Development with Claude

## Project Context

A food-delivery marketplace with three sides — customers, restaurants, and drivers — coordinated in real time. The hard problem is the **dispatch loop**: when an order is confirmed, find the best nearby available driver fast (a geospatial query on constantly-moving points), assign atomically, and stream live status/location to all three parties. Everything else (menus, carts, order state) is comparatively ordinary CRUD; the geospatial matching and the real-time fan-out are where the design lives.

**Learning goals:** real-time location with Redis geo, score-based driver–order matching, an order state machine, WebSocket fan-out to multiple party types, and an event-streaming backbone (Kafka) for decoupling.

## Architecture at a Glance (what actually runs)

Matches `docker-compose.yml` (postgres, valkey, kafka+zookeeper) and `backend/package.json`:

| Store / channel | Client lib | Role | Why this one |
|-----------------|-----------|------|--------------|
| **PostgreSQL 16** | `pg` | Source of truth: users, restaurants, `menu_items`, drivers, orders (+ `order_items`), reviews, sessions, `audit_logs` | ACID for order/driver assignment and the `DECIMAL(10,2)` money columns |
| **Valkey (Redis)** | `redis` (node-redis) | `driver_locations` **geo set** (GEOADD/GEOSEARCH), session tokens, cache | GEOSEARCH answers "available drivers within N km of this restaurant" in sub-ms — the hot path of dispatch |
| **Kafka + Zookeeper** | `kafkajs` | **Producer only**: `order-events`, `location-updates`, `dispatch-events` topics | Append-only event log for downstream consumers (analytics, notifications) that a production build would add — see caveat below |
| **WebSocket** | `ws` | Live push of order status + driver location to customer/restaurant/driver clients | Sub-second bidirectional updates; this is the actual real-time delivery path (not Kafka) |

**Important:** Kafka is publish-only here — `shared/kafka.ts` exposes a producer and nothing in `backend/src` consumes the topics. Real-time UI updates go through the WebSocket `broadcast()`, not a Kafka consumer. Publishing is best-effort (returns `false` and logs a warning if Kafka is down; order flow is unaffected). Backend: single Express app (routes `auth`, `restaurants`, `drivers`, `orders/*`), default port 3000. Frontend: React 19 + TanStack Router + Zustand (no map library — driver movement is simulated/plotted from coordinates).

## Key Design Decisions

### 1. Redis GEOSEARCH for driver matching, PostgreSQL as fallback
Driver locations live in a Redis geo set updated on every location ping; `findNearbyDrivers()` runs GEOSEARCH (radius, sorted by distance, capped at 20) and only falls back to a DB scan + Haversine when Redis is unavailable. Trade-off given up: Redis geo data is not durable, so a Redis loss means rebuilding the location set from driver pings — acceptable because locations are ephemeral by nature (a 30-second-old position is already stale), and the DB fallback keeps matching functional (just slower). Doing the radius search in Postgres as the primary path would mean a full-table distance computation on every dispatch.

### 2. Score-based matching, not pure nearest-driver
`calculateMatchScore` combines proximity (`100 − distance×10`, dominant), driver rating (`×5`), and experience (`min(deliveries/10, 20)`). Trade-off: the closest driver isn't always chosen — a slightly-farther, higher-rated, more-experienced driver can win. That's deliberate: raw nearest-driver ignores reliability and over-assigns to whoever happens to be adjacent, hurting completion rate. The weights make proximity primary while letting quality break near-ties.

### 3. Dispatch wrapped in a circuit breaker
Driver matching (the Redis-dependent path) runs inside an Opossum circuit breaker. Trade-off: added complexity, but without it a slow Redis makes every dispatch request block on the timeout; at load those blocked requests exhaust the connection pool and take down *unrelated* endpoints (restaurant browsing). The breaker fails matching fast and lets the rest of the API stay responsive.

### 4. WebSocket for real-time, Kafka for the event log — two separate paths
The UI gets live updates over WebSocket directly from the request handlers (`broadcast()` on status change / assignment / location). Kafka receives the same events as a durable stream for *future* consumers. Trade-off: publishing to both is a double-write and the streams can briefly diverge, but they serve different needs — WebSocket is low-latency and connection-scoped, Kafka is durable and replayable. The current build only *produces* to Kafka.

### 5. Order state machine with an explicit CHECK-constrained enum
`orders.status` is `PLACED → CONFIRMED → PREPARING → READY_FOR_PICKUP → PICKED_UP → DELIVERED → COMPLETED` (plus `CANCELLED`), enforced by a DB CHECK constraint and idempotent transition handling. Trade-off: a rigid enum is less flexible than free-form status strings, but it makes illegal transitions impossible at the storage layer — the right call when status drives payouts and customer promises.

## Current State

Working end to end: auth (bcrypt, Redis-backed session cookies, role-based customer/restaurant/driver/admin); restaurant + menu browsing with cuisine/open filters; cart → order placement with `DECIMAL` money and idempotency; the order state machine with per-transition audit logging; driver onboarding, availability, and location pings into the Redis geo set; automatic driver matching (GEOSEARCH → score → assign) under a circuit breaker; multi-factor ETA (time-to-restaurant + prep + delivery + buffer, with rush-hour traffic multipliers); WebSocket live updates to all three party types; Kafka event publishing (best-effort); prom-client metrics, Pino logging, and three-tier health checks.

Intentionally not built: **Kafka consumers** (notifications, analytics, payment triggers), driver batching (multiple orders per trip), route optimization, ML-based ETA, surge pricing, and browser push notifications.

## Iteration & Repair Log

- **Doc rewrite (2026-07):** the previous CLAUDE.md used banned "Phase 1–4" checklists and embedded `.js` code blocks (`calculateMatchScore`, Redis geo snippets) — the code is TypeScript. Rewritten to the standard structure; the match-score formula and ETA factors were verified against `helpers.ts` / `utils/geo.ts` and described in prose.
- **Kafka reality clarified:** the previous notes implied a full event pipeline. In fact `shared/kafka.ts` is producer-only with no consumers; real-time delivery is WebSocket. `architecture.md` already discloses this ("Producer-only; no consumers implemented"), and this file now matches.
- **Verified against schema/code (no changes needed to architecture.md or README):** the order-status enum, demo credentials (`password123` for all four seeded roles), and the initdb schema mount were all confirmed consistent.

## Open Questions

1. **Kafka without consumers:** the topics are written but never read in-repo. Is the intent to add a notification/analytics consumer, or is Kafka here purely to demonstrate the producer side? Until a consumer exists, Kafka adds ops weight (Zookeeper + broker) for no in-app payoff.
2. **Location write amplification:** every driver ping writes Redis geo + Kafka + a WebSocket broadcast. At many active drivers this is a lot of fan-out per second — batch/throttle pings, or sample?
3. **Batching:** the single-order-per-driver model leaves efficiency on the table during peak. Where does batch-route computation live, and what's the max added delay a customer tolerates?
4. **Assignment races:** two concurrent dispatches could target the same top-scored driver. Is the assignment write guarded (conditional update / lock), or can a driver be double-assigned before their availability flips?

## Resources

- [DoorDash Engineering Blog](https://doordash.engineering/)
- [Redis Geo commands](https://redis.io/docs/latest/commands/geosearch/) — the dispatch hot path
- [Uber: real-time push platform](https://eng.uber.com/real-time-push-platform/) — the WebSocket fan-out pattern
- [Vehicle Routing Problem](https://developers.google.com/optimization/routing/vrp) — the batching/routing extension
