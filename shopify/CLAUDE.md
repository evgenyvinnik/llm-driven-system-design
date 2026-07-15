# Shopify (multi-tenant e-commerce) — Development with Claude

## Project Context

A simplified Shopify-style platform: many independent merchant stores run on shared infrastructure, each with its own products, orders, customers, and storefront. The core hard problem is **tenant isolation on a shared database** — Merchant A must never see Merchant B's data even though both live in the same tables — combined with a **checkout path that has to be correct under concurrency** (no overselling inventory, no double-charged/duplicated orders on retry).

**Learning goals:** shared-DB multi-tenancy with PostgreSQL Row-Level Security, a transactional checkout with pessimistic inventory locking, idempotency for money-moving operations, and decoupling the checkout critical path from downstream work via a message queue.

## Architecture at a Glance (what actually runs)

Three datastores from `docker-compose.yml`, each on a distinct access pattern:

| Store | Role | Why this one |
|-------|------|--------------|
| **PostgreSQL 16** (`pg`) | All tenant data (stores, products, variants, orders, customers, carts) + idempotency/audit/webhook tables | ACID for checkout; Row-Level Security enforces tenant isolation at the DB layer, not just in app code |
| **Valkey/Redis** (`redis` — node-redis v4) | Sessions, domain→store mapping cache, cart persistence, rate-limit counters | Sub-ms lookups; session store enables immediate revocation |
| **RabbitMQ** (`amqplib`) | Async order/inventory/webhook/email processing with dead-letter exchanges | Keeps the checkout critical path fast; DLQs catch poison messages |

Backend is a single Express app (`backend/src/index.ts`) plus four RabbitMQ workers (`order`, `inventory`, `webhook`, `email`). Resilience libraries actually wired in: **Opossum** (circuit breaker), **Pino** (structured logs), **prom-client** (Prometheus metrics), **bcryptjs** (password hashing). Frontend is React 19 + TanStack Router (file-based) + Zustand + Tailwind. **There is no Stripe dependency** — payment is a mocked internal function; the schema keeps `stripe_*` columns for the production design.

## Key Design Decisions

### 1. Shared database + Row-Level Security for tenancy (not schema-per-tenant)
Every tenant table (`products`, `variants`, `orders`, `customers`, `carts`, …) has RLS enabled with a policy keyed on `current_setting('app.current_store_id')`. Requests run through `getClientWithTenant(storeId)`, which sets that session variable so the database itself filters rows. Trade-off: one shared schema is operationally simple and cheap versus a schema/DB per tenant, but a single missing `SET` or a policy bug leaks data across merchants. Mitigated by routing all tenant queries through a dedicated low-privilege DB role (`shopify_app`) whose `store_id` defaults to empty, so an un-scoped query returns nothing rather than everything.

### 2. SERIALIZABLE transaction + `FOR UPDATE` for checkout inventory (not optimistic)
`processCheckoutInternal` runs the whole checkout in `BEGIN ISOLATION LEVEL SERIALIZABLE` and locks each variant row with `SELECT ... FOR UPDATE` before decrementing stock. Two shoppers racing for the last unit of a variant serialize on that row, so the second sees `out of stock` instead of both succeeding. Trade-off: writes to a hot variant serialize (a bottleneck under a flash sale on one SKU), but for retail, overselling is a worse failure than a few milliseconds of contention. On payment failure the reserved inventory is explicitly rolled back before the transaction aborts.

### 3. Two-layer idempotency for money-moving operations
Checkout is guarded by an `idempotency_keys` table (unique on key+store+operation, via `idempotencyMiddleware`) so a retried checkout returns the original order instead of creating a second one; inbound webhooks are deduped separately in `processed_webhooks` (unique `event_id`). Trade-off: extra writes and a claim/complete state machine on every checkout, accepted because a duplicate order is a real charge and a real fulfillment.

### 4. RabbitMQ async workers instead of synchronous post-checkout work
Once the order commits, checkout publishes `order.created` / inventory events and queues an email, then returns. Email rendering, webhook fan-out, and inventory alerts happen in dedicated workers behind dead-letter exchanges. Trade-off: eventual consistency for notifications and a broker to operate, but the customer's checkout latency no longer depends on a slow merchant webhook endpoint or an email provider being up.

### 5. Circuit breaker around the payment call (Opossum)
The payment call is wrapped in an Opossum breaker; when it trips, the fallback marks the payment `deferred: true` and the order is written as `payment_pending` rather than failing the customer outright. Trade-off: some orders land unpaid and need later reconciliation, but the storefront degrades gracefully instead of erroring during a payment-provider brownout.

### 6. Session-in-Redis auth (not JWT)
Login stores a session in Valkey and sets an httpOnly cookie. Chosen for immediate revocation and simplicity over stateless JWTs, consistent with the repo's auth default.

## Current State

**Implemented end to end:** merchant register/login/logout with Redis sessions; store CRUD + subdomain resolution; product and variant CRUD with inventory; collections CRUD; the customer storefront (product grid → detail → cart → checkout → success); checkout with SERIALIZABLE txn, `FOR UPDATE` inventory reservation, mocked payment behind a circuit breaker, order + line-item creation, and cart cleanup; PostgreSQL RLS on all tenant tables; idempotency keys; audit logging; the four RabbitMQ workers; Prometheus metrics and `/health`, `/ready`, `/live` endpoints.

**Intentionally omitted:** real Stripe integration (payment mocked; `stripe_*` columns kept for the design); custom-domain SSL / Let's Encrypt provisioning (the `custom_domains` table exists but verification is not wired); real email delivery (the email worker renders templates and logs them — no SMTP); a Liquid theme engine (themes are JSONB color config applied inline); Elasticsearch product search; CDN, sharding, and multi-region.

## Iteration & Repair Log

- **2026-07 (README drift correction):** the README claimed the stack was "PostgreSQL + Redis" and pointed at `backend/scripts/init.sql` and a JavaScript `index.js`. Reality: `docker-compose.yml` also runs **RabbitMQ** (four workers depend on it), the schema lives at `backend/src/db/init.sql`, and the backend is TypeScript (`index.ts`). Corrected the infra list, project-structure block, and Node version (repo requires ≥20).
- **2026-07 (seed password normalization):** demo credentials in the README were `merchant123`; the repo-wide seeded login password is `password123`. Fixed the README to match the seeded bcrypt hash in `backend/db-seed/seed.sql`.
- **Schema-apply mechanism (current characteristic, noted for future work):** `init.sql` is applied **only** through the `docker-entrypoint-initdb.d` mount, which runs solely on a fresh Postgres volume; there is no `migrate.ts` / `npm run db:migrate` and the seed (`db-seed/seed.sql`) is not mounted, so seeding is a manual `psql` step. A persisted volume that predates a schema change will not pick it up. Adding an idempotent migrate step would make this self-healing (see Open Questions).

## Open Questions

1. Should this project adopt the repo's `migrate.ts` + `db:migrate` pattern so schema changes apply on every boot instead of only on a fresh volume?
2. The `FOR UPDATE` lock is correct but serializes hot-SKU checkouts — at what concurrency does a reservation queue or optimistic-with-retry become worth the added coordination code?
3. RLS depends on every connection setting `app.current_store_id`; is a connection-pool wrapper or a lint/test guard needed to prevent a future un-scoped query from silently bypassing isolation?
4. If RabbitMQ is down, the design calls for a fallback DB table for order events — is that fallback fully wired, or can notifications be silently lost during a broker outage?

## Resources

- [PostgreSQL Row-Level Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [Opossum circuit breaker](https://nodeshift.dev/opossum/)
- [Shopify Engineering — e-commerce at scale](https://shopify.engineering/e-commerce-at-scale-inside-shopifys-tech-stack)
