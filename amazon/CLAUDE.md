# Design Amazon (E-Commerce) — Development with Claude

## Project Context

A marketplace back end: hierarchical catalog with multiple sellers and warehouses, full-text product search, a cart, and a checkout that turns a cart into an order without ever overselling stock. The two hard problems are **inventory correctness under concurrency** (10K buyers, 1K units — nobody gets a confirmed order for stock that isn't there) and **search that survives its own dependency** (a product search box that keeps working when Elasticsearch is down). Payments are simulated but wrapped in the same resilience machinery a real gateway would need.

**Learning goals:** reserved-inventory modeling, idempotent checkout, circuit-breaker-wrapped external calls, and a primary/fallback search architecture.

## Architecture at a Glance (what actually runs)

Three backing services (`docker-compose.yml` — Postgres, Valkey, Elasticsearch; **no message queue**):

| Store | Client lib | Role | Why this one |
|-------|-----------|------|--------------|
| **PostgreSQL 16** (`postgres:16-alpine`) | `pg` | Source of truth: products, `inventory` (`quantity`/`reserved` per warehouse), `cart_items`, orders, `order_items`, reviews, sessions, `idempotency_keys`, `audit_logs`, `orders_archive`, `search_logs`. Also a GIN `tsvector` index for fallback search | ACID transactions are the whole point of the inventory/checkout path; a single DB keeps the money-touching writes consistent |
| **Elasticsearch 8.11** (`@elastic/elasticsearch`) | — | Primary product search: relevance + faceted filtering (category, price, rating) | Inverted index + facets at a latency Postgres full-text can't match; synced from Postgres via the `sync-es` script (`utils/syncElasticsearch.ts`) |
| **Redis / Valkey** (`valkey/valkey:7-alpine`) | `redis` (node-redis v4) | Session store + recommendation/response caching | Sub-ms session lookups and cache-aside for hot reads |

Order events are processed **synchronously in-process** (no Kafka/RabbitMQ locally); reservation cleanup runs as a `setInterval` background job (`services/backgroundJobs.ts`). Auth is session-based (bcrypt, `sessions` table + Redis). Frontend is React 19 + TanStack Router + Zustand v5 + **Tailwind v4** (via `@tailwindcss/vite`, no `tailwind.config`).

## Key Design Decisions

### 1. Reserved-inventory model, not decrement-on-add
`inventory` carries both `quantity` (on hand) and `reserved` (held in carts). Adding to cart sets a `reserved_until` timestamp; checkout runs a transaction that `SELECT … FOR UPDATE`s the cart rows, verifies `SUM(quantity)` across warehouses covers each line, then decrements `quantity` and `reserved` together and clears the cart. A background job frees reservations whose `reserved_until` has passed. **Trade-off given up:** held stock is unavailable to other buyers for the hold window, so heavy cart-abandonment temporarily suppresses availability — the classic UX-hold vs. availability tension, tuned by the reservation TTL.

### 2. Idempotent checkout keyed on an idempotency table
`POST /api/orders` first calls `handleIdempotentOrder`, which upserts an `idempotency_keys` row (`processing` → `completed`/`failed`). A retry with the same key returns the cached response, and a still-in-flight duplicate gets `409` instead of a second order. **Trade-off given up:** an extra table and a three-state machine to maintain — but a double-clicked "Place order" or a network retry must never create two orders and charge twice, and a UNIQUE `orders.idempotency_key` is the durable backstop.

### 3. Payment behind a circuit breaker with a queue fallback
The simulated gateway call is wrapped in an Opossum breaker (`createPaymentCircuitBreaker`); when it trips, `paymentFallback` returns `{ queued: true }` and the order is persisted in a `payment_status = pending` state rather than blocking checkout on a dead dependency. **Trade-off given up:** orders can exist in a payment-pending limbo that needs later reconciliation — deliberately, because failing the whole checkout when the payment provider hiccups is worse than accepting the order and settling payment asynchronously.

### 4. Elasticsearch primary, PostgreSQL full-text fallback
`GET /api/search` tries Elasticsearch first; on any ES error it falls back to a Postgres `to_tsvector @@ plainto_tsquery` query over the GIN index, logging which `engine` served each request into `search_logs`. **Trade-off given up:** the fallback loses ES's relevance tuning and rich facets and can be slower, but search *degrades* instead of *failing* — for a storefront, a slightly worse result set beats an error page, and the search box is the top of the funnel.

### 5. Order archival as a first-class lifecycle stage
Orders carry `archive_status` (`active`/`pending_archive`/`archived`/`anonymized`) and old orders move to `orders_archive` (`shared/archival.ts`). **Trade-off given up:** added write paths and a second place order data lives, in exchange for keeping the hot `orders` table small and supporting data-retention/anonymization.

## Current State

**Implemented end to end:** hierarchical categories, products with per-warehouse inventory, sellers; Elasticsearch search with PostgreSQL full-text fallback and ILIKE suggestions; cart with timed reservations; idempotent checkout with `FOR UPDATE` inventory verification and atomic decrement; payment via Opossum circuit breaker with queue fallback; order lifecycle (cancel restores inventory, admin status transitions), all with `withDatabaseRetry`; verified-purchase reviews with rating rollups; `also_bought` recommendations; background reservation cleanup; order archival; audit logging (`audit_logs` with correlation IDs); Prometheus metrics (`prom-client`) and Pino/pino-http logging.

**Simulated or omitted (see `architecture.md` Implementation Notes):** real payment gateway (simulated with optional injected failures); Kafka/CDC event streaming (ES is synced by the `sync-es` script, order events are synchronous); MinIO/S3 image storage (image URLs are text arrays); and personalized-homepage / recently-viewed recommendations (only `also_bought` is computed).

## Iteration & Repair Log

- **ESM / connection-fallback pass (repo-wide):** backend runs as ESM under `tsx`; Postgres/Redis/Elasticsearch clients fall back to the docker-compose defaults (`amazon` DB, `redis://localhost:6379`, `http://localhost:9200`) when env vars are unset, and `pino-http` uses its named import.
- **Seed password normalization:** all seeded users (`admin@amazon.local`, `seller@amazon.local`, `alice@example.com`, `bob@example.com`, …) share one bcrypt hash for `password123`, matching the README credentials table. Note: one stale comment in `backend/db-seed/seed.sql` still reads `password: admin123` above the admin insert even though the hash is `password123`; it's a source `.sql` comment (outside this .md pass) and no `.md` repeats it, so nothing was changed here — flagged for a code-side cleanup.
- **Search index bootstrap:** Elasticsearch starts empty; products only become searchable after `npm run seed` **and** `npm run sync-es` (the README documents both). Until the sync runs, `/api/search` silently serves the Postgres full-text fallback — correct behavior, but worth knowing when a fresh stack "returns worse results."

## Open Questions

1. Inventory verification sums `quantity` across warehouses but the decrement isn't warehouse-aware in the checkout path. When multi-warehouse allocation matters (ship-from-nearest, split shipments), how should the reservation and decrement pick a warehouse without reintroducing an oversell race?
2. Reservation cleanup is a single-process `setInterval`. With multiple backend instances, what stops two of them from racing to release the same expired reservation — a Postgres advisory lock, or moving cleanup to a leader/queue?
3. Payment fallback marks orders `queued`/`pending` but there is no worker that later settles them. What is the minimal reconciliation loop, and how does it stay idempotent against the gateway?
4. ES is synced by an explicit script, so the index can drift from Postgres between runs. Where is the right seam to add change-data-capture so a product edit reaches search within seconds rather than at the next manual sync?

## Resources

- [Optimistic Offline Lock (Fowler)](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html) — the concurrency pattern behind reserved inventory
- [Elasticsearch as a Foundation for E-Commerce Search](https://www.elastic.co/blog/found-elasticsearch-as-a-foundation-for-e-commerce-search) — the primary search engine's rationale
- [Amazon / AllThingsDistributed](https://www.allthingsdistributed.com/) — availability-first design philosophy this echoes
