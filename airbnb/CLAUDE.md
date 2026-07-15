# Design Airbnb — Development with Claude

## Project Context

A two-sided vacation-rental marketplace: hosts list properties with availability calendars, guests search by location/dates/filters and book, and both sides review each other after a stay. The core hard problems are **double-booking prevention** (two guests must never confirm the same dates on the same listing) and **geographic search with availability filtering** (find bookable listings near a point, fast). It is deliberately a single-database design where PostgreSQL + PostGIS carries both the relational and the geo workload.

**Learning goals:** efficient availability-calendar storage, PostGIS radius search, concurrent-booking correctness under row locks, mutual-reveal two-sided reviews, and cache-aside + async-queue patterns around a marketplace core.

## Architecture at a Glance (what actually runs)

Three backing services (see `docker-compose.yml`), each for a distinct access pattern:

| Store | Client lib | Role | Why this one |
|-------|-----------|------|--------------|
| **PostgreSQL + PostGIS** (`postgis/postgis:16-3.4`) | `pg` | Source of truth: users, listings, `availability_blocks`, bookings, reviews, messages, sessions, `audit_logs` | ACID for booking correctness; `GEOGRAPHY(POINT,4326)` + GIST index gives `ST_DWithin` radius search in the same DB — no separate search index to keep in sync |
| **Redis / Valkey** (`valkey/valkey:7-alpine`) | `redis` (node-redis v4) | Session cache, cache-aside for listing/availability/search, and queue-consumer idempotency (`processed:<eventId>` keys, 7-day TTL) | Sub-ms reads on the hot search/listing path; auto-expiring keys make dedup cheap |
| **RabbitMQ** (`rabbitmq:3-management`) | `amqplib` | Topic exchange `airbnb.events` → background workers (booking, notification, analytics), with a dead-letter exchange | Decouples booking latency from notification/analytics work; DLQ + at-least-once + idempotent consumers give reliable async delivery |

Photos are uploaded via **multer to local disk** (`./uploads`, served statically) — there is no MinIO/S3 locally. Auth is **session-based** (bcryptjs hashes, Redis-cached sessions with a PostgreSQL `sessions` backup), not JWT. The backend is a single Express monolith with route-based separation (`auth`, `listings`, `search`, `bookings`, `reviews`, `messages`); the frontend is React 19 + TanStack Router + Zustand + Tailwind (no charting/map libraries).

## Key Design Decisions

### 1. Date-range `availability_blocks`, not day-by-day rows
Availability is stored as `(start_date, end_date, status)` ranges and queried with the PostgreSQL `OVERLAPS` operator. Day-by-day rows would be ~10M listings × 365 = billions of rows; ranges cut that ~18×. **Trade-off given up:** updating a partial range (host blocks 3 nights inside an open month) requires split/merge logic in `listings.ts` rather than a trivial per-day flip.

### 2. Pessimistic locking (`SELECT … FOR UPDATE`) for booking correctness
`POST /api/bookings` opens a transaction, locks the listing row with `FOR UPDATE`, re-checks for `booked`/`blocked` overlaps *inside* the lock, then inserts the booking and its availability block atomically. This makes the check-then-write race impossible: a concurrent second booking blocks on the row lock and then sees the conflict. **Trade-off given up:** all booking attempts for one hot listing serialize through its row lock — acceptable because contention per *single* listing is low (unlike a flash sale on one SKU), and it buys a dead-simple correctness proof versus optimistic-locking retry loops.

### 3. PostGIS as the primary search engine (locally), Elasticsearch only in the production design
Search runs `ST_DWithin` against the GIST index with faceted filters (price, property/room type, amenities `@>`, guest count, bed counts) plus an availability `NOT IN (overlapping blocks)` sub-select, all in one SQL query. Keeping search in Postgres means zero index-sync machinery. **Trade-off given up:** no real full-text relevance (location autocomplete is `ILIKE`), and a single Postgres instance caps search throughput — `architecture.md` documents Elasticsearch + CDC as the production path when that ceiling is hit.

### 4. Mutual-reveal reviews enforced by a DB trigger
Both a guest and host review are inserted with `is_public = FALSE`; a trigger flips both to public only once both `author_type`s exist for the booking, and a second trigger recomputes the listing's denormalized `rating`/`review_count`. Putting this in the database, not app code, means no request path can accidentally leak one side's review early. **Trade-off given up:** there is no 14-day auto-publish for a single-sided review (a real Airbnb rule), so a one-sided review stays hidden forever here.

### 5. Best-effort async, correctness-first sync
The booking commit is the source of truth; publishing the `booking.created` event to RabbitMQ is wrapped in try/catch so a queue outage **never** fails a booking. Consumers dedup on Redis `processed:<eventId>` and nack-to-DLQ after retries. **Trade-off given up:** notifications/analytics are eventually consistent and can lag or be dropped if the queue is down — deliberately, because a guest's reservation must not hinge on the notification pipeline.

### 6. Circuit breaker (Opossum) on the search path
Search and availability calls run through Opossum breakers that fail fast and return a fallback (empty results / assume-unavailable) when Postgres is degraded, instead of piling up slow queries. **Trade-off given up:** during an open breaker the UI shows degraded/empty results rather than accurate ones — chosen so one slow dependency can't cascade into a full outage.

## Current State

**Implemented end to end:** session auth + become-host flow; listing CRUD with multer photo upload and split/merge availability editing; PostGIS faceted search with result caching + circuit breaker; location autocomplete (`/api/search/suggest`) and popular destinations; booking with `FOR UPDATE` double-booking prevention, instant-book vs request-to-book, host confirm/decline, cancellation with date release, completion; two-sided mutual-reveal reviews with trigger-driven rating rollups; host↔guest messaging (HTTP polling); RabbitMQ workers (booking/notification/analytics) with DLQ + idempotency; full observability (Prometheus metrics, Pino logs, `audit_logs`, `/health` `/ready` `/live` `/metrics`).

**Intentionally omitted (documented in `architecture.md` Layer 2):** payments/Stripe (prices computed, never charged), Elasticsearch, S3 + CDN + image pipeline, WebSocket real-time messaging, ML smart pricing, request rate limiting, single-sided review auto-publish window, and an admin UI (the `requireAdmin`/`role` plumbing exists but no dashboard).

## Iteration & Repair Log

- **2026-07-13 (search silently ignored the destination):** `SearchBar.handleSearch()` set only the free-text location with no coordinates, but `/api/search` filters geographically on `latitude`/`longitude`. With no coords the backend applied no location predicate, so "San Francisco" returned *every* listing — the search box looked broken. The backend already had `/api/search/suggest` (city→lat/lng) that the UI never called. Fixed by wiring the search bar to it: debounced autocomplete, selection sets lat/lng in `searchStore`, and free text submitted without a pick is geocoded on submit; unresolvable destinations set `locationUnresolved` so the results page says "We couldn't find X" instead of listing everything. Verified: SF search returns 1 SF listing (was: all 5).
- **2026-07-13 (screenshot login / seed password):** the screenshot config authenticated as `guest1@example.com`; that user *is* seeded (`src/seed.ts`), but seeded password hashes across the repo were normalized to the shared `password123`. Confirmed the five seeded logins (`host1`/`host2`/`guest1`/`guest2`/`admin@example.com`) all use `password123`, matching the README credentials table.

## Open Questions

1. Pessimistic `FOR UPDATE` is correct but serializes per-listing writes — at what booking-concurrency per listing (or once a payment-authorize step is added mid-transaction) does this need to become optimistic locking or a short-lived Redis reservation lock?
2. Availability is filtered in-query with `NOT IN (overlapping blocks)` sub-selects; at what listing/booking volume does this need the Elasticsearch 365-day bitmap the production doc describes, and how would CDC keep it consistent with the `FOR UPDATE` write path?
3. The mutual-reveal trigger never auto-publishes a single-sided review. Adding the 14-day window means a scheduled job — worker cron, or a Postgres `pg_cron`-style task? Which keeps the trigger invariant intact?
4. Cache invalidation on booking wipes all search-result caches for simplicity. What is the right key granularity (by geo tile? by listing?) before that becomes a thundering-herd problem?

## Resources

- [PostGIS Documentation](https://postgis.net/documentation/) — `ST_DWithin`, GIST indexing
- [Airbnb: Avoiding Double Payments in a Distributed Payments System](https://medium.com/airbnb-engineering/avoiding-double-payments-in-a-distributed-payments-system-2981f6b070bb) — idempotency the production design would extend into payments
- [Listing Search Ranking at Airbnb](https://medium.com/airbnb-engineering/listing-search-ranking-at-airbnb-4ab8ec5d76fb) — the ML ranking layer deliberately out of scope here
