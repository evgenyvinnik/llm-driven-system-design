# Etsy Marketplace Architecture

## System Overview

This learning project explores discovery and purchasing in a marketplace for handmade, vintage, and small-batch goods. A listing can have one unit or many; scarce stock makes the boundary between browsing, a saved cart, and an accepted purchase central to correctness. A buyer can purchase from several shops, while each seller owns a separate fulfillment order.

This document has two explicit layers. Requirements, estimates, the main diagram, and design decisions describe a **proposed production system**, not Etsy's private architecture or measured traffic. The Database Schema reproduces the **current local schema**; API Design inventories the **implemented routes**. The final Implementation Notes trace actual code and known defects. The [README](./README.md) covers running the project; the three interview answers present a smaller spoken version of the proposal.

**Current local blocker:** [checkout](./backend/src/routes/orders.ts) inserts `payment_transaction_id` into `orders`, but the supplied schema has no such column. On a fresh database, checkout can run its simulated payment and then fail the SQL insert. The transaction rolls back database writes; this is not a functioning payment/checkout guarantee.

## Requirements

### Functional requirements — proposed production scope

Buyers search and filter listings, inspect seller reputation and delivery terms, save favorites, maintain a cart across devices, and purchase a selected basket across multiple shops. Sellers publish and revise listings, manage stock, and fulfill their own orders. Purchases retain immutable item and price snapshots. Cancellation and refund processing must reconcile inventory, buyer money, and seller order state.

A saved cart does not reserve stock. Starting checkout obtains a versioned quote and a short inventory hold, initially five minutes. All selected lines must be available before the buyer proceeds. A missing item produces an explicit revised selection; the service does not silently charge for a partial basket. Each seller then fulfills independently after purchase confirmation.

Begin with one transaction region and one currency per checkout. International tax computation, seller payouts, advanced promotions, variations, recommendations, disputes, and moderation are separate extensions. Production authorization still needs seller ownership and publication eligibility even before full moderation tooling exists.

### Non-functional requirements — proposed, unmeasured targets

| Concern | Initial design target | Boundary |
|---------|-----------------------|----------|
| Availability | 99.9% monthly for regional browse and checkout APIs | Dependency failures may pause purchasing |
| Search | p95 below 500 ms server response | Bound query cost and disclose degraded mode |
| Quote creation | p95 below 500 ms without payment-provider latency | Short database transaction, bounded contention |
| Search freshness | 99% of listing changes visible within 10 seconds in normal operation | Measure projection lag; no hard promise during outages |
| Inventory | No accepted reservation exceeds sellable stock | Authoritative guarded database transition |
| Retry correctness | One purchase outcome for the same buyer operation and payload | Durable receipt; repeated delivery is expected |
| Recovery | Reconcile interrupted payment and expired holds | Persist intermediate state and retryable work |

A search card can be stale; a successful purchase cannot depend on that card's quantity. Search availability and checkout consistency therefore have different failure policies.

## Capacity Estimation

These are interview sizing assumptions, not measurements of this implementation or the real Etsy service.

| Assumption | Calculation / implication |
|------------|---------------------------|
| 1 million daily active buyers, 10 searches each | 10 million searches/day, about 116/s average, 1,160/s at a 10× peak |
| 50,000 purchase attempts/day | About 0.58/s average and 5.8/s at 10× peak; allow much hotter individual listings |
| Three lines and 1.5 shops per purchase | About 150,000 line claims and 75,000 seller orders/day if all attempts convert |
| 10 million active listings, 2 KiB indexed source each | About 19 GiB source data before index structures, replicas, and operational headroom |
| Four 300 KiB image derivatives per listing | About 11.2 TiB of derivatives, excluding originals and revisions |

Average checkout throughput is modest compared with search. A single promoted one-unit listing can still serialize thousands of attempts, so overload protection belongs around inventory claims rather than being inferred from global averages. An image-heavy frontend should deliver suitably sized images through a CDN rather than through application servers.

### Local Development Scale

Compose provides one PostgreSQL 16 instance, one Valkey 7 instance, and one Elasticsearch 8.11.0 node with a 512 MiB heap. Both seed alternatives create ten products on a fresh database. The API and Vite run on the host. This fits a small local demonstration; multiple API scripts do not establish production throughput or transaction safety.

## High-Level Architecture

Production proposal; each box expresses responsibility and need not initially be a separate deployment.

```
┌─────────────────────┐        ┌─────────────────────┐
│ Browser / mobile    │───────▶│ CDN / image storage │
└──────────┬──────────┘        └─────────────────────┘
           ▼
┌─────────────────────┐
│ API gateway / auth  │
└──────────┬──────────┘
           ▼
┌─────────────────────┐        ┌─────────────────────┐
│ Catalog / search    │───────▶│ Elasticsearch       │
│ Favorites / cart    │        │ Redis read caches   │
└──────────┬──────────┘        └─────────────────────┘
           ▼
┌─────────────────────┐        ┌─────────────────────┐
│ Checkout / orders   │───────▶│ PostgreSQL          │
│ Stock / ownership   │        │ State + outbox      │
└─────────────────────┘        └──────────┬──────────┘
                                         ▼
┌─────────────────────┐        ┌─────────────────────┐
│ Payment provider    │◀───────│ Durable workers     │
│ Status / webhooks   │───────▶│ Payment / indexing  │
└─────────────────────┘        └─────────────────────┘
```

PostgreSQL owns inventory, purchases, receipts, and seller orders. Redis and Elasticsearch contain rebuildable browsing projections; losing a cache cannot authorize another sale. Durable workers consume committed outbox work and apply versioned, repeatable effects. Payment webhooks and reconciliation both use the same guarded purchase transitions.

## Core Components / Request Flows

### Discovery and listing changes — production proposal

Catalog writes validate seller ownership, price, quantity, and publication rules, then commit a new listing version with an outbox event. The indexer applies versions monotonically, including tombstones for removed listings. A rebuild loads a database snapshot into a new index, catches up the change stream, verifies counts and representative queries, and switches an alias. An old snapshot must not overwrite a newer update.

Search retrieves text candidates, applies hard filters, and ranks eligible results. Title relevance dominates; seller reputation and freshness provide bounded secondary signals so established shops do not permanently bury new sellers. A query-time synonym policy needs evaluation against actual buyer intent: a pendant and a choker may be related without being interchangeable.

Results carry the applied filters, approximation/degradation information, and a stable pagination cursor. Product details can use a brief cache, but a quote reads authoritative listing and seller state. Review aggregates and purchase counts are projections with their own refresh cadence, not proof of current inventory.

### Quote, hold, payment, and fulfillment — production proposal

1. The buyer submits selected cart line IDs, quantities, expected listing/price versions, delivery information, and a stable operation ID. The service binds the operation to the authenticated buyer and canonical request digest.
2. One short database transaction validates shop/listing eligibility and locks stock rows in a deterministic order. It checks current prices and available quantities, creates the quote and hold records, and records the operation receipt. Any unavailable line aborts this entire attempt.
3. The buyer accepts the returned quote before its server-side expiry. A guarded transition claims payment processing and extends the hold to cover a bounded reconciliation window. The transaction emits durable payment work; it does not wait on the provider while holding row locks.
4. The payment worker uses a stable provider operation ID. An ambiguous timeout leaves payment in an unknown state for reconciliation. A decline can release the hold; an unknown result cannot be treated as a decline merely because a request timed out.
5. Confirmed payment consumes the protected stock reservation, records the purchase result, and creates immutable seller-order snapshots in one database transaction. Retries read the same result. Notifications and search updates follow from committed outbox work.
6. Fulfillment proceeds per seller. Guarded cancellation decides whether stock can be returned and creates an idempotent refund request. A purchase cancellation is not just a status label; any required money and inventory effects remain observable until complete.

An expiry worker can release only an eligible unpaid hold. It must not race a worker that has already claimed payment processing. If payment cannot be resolved within policy, record compensation work and do not publish a confirmed order whose reservation has been reassigned.

The local route instead reads and validates the cart before `BEGIN`, simulates payment, and attempts seller-order inserts and stock decrements in one SQL transaction. It has no purchase parent, quote, durable hold, worker, or provider reconciliation.

### Client interaction — production proposal

TanStack Router owns canonical search parameters and navigation. A request cache keys server data by query and account identity; Zustand can hold cross-route UI state. Local component state holds image selection and unsaved form fields. Session hydration is an explicit loading phase before protected-route decisions.

Search transitions cancel obsolete requests and reject responses for old query generations. Preserve the previous result set with a loading indicator, without presenting it as the new query's results. Filters and back navigation reconstruct the same request. Buying uses pessimistic confirmation and a durable operation ID; a temporary favorite can use optimistic feedback with rollback and mutation ordering.

The purchase status page can poll while payment is unresolved and reconnect after reload using the purchase ID. A button spinner or local countdown does not establish payment completion or reservation ownership.

## Database Schema

### Current local schema — exact supplied SQL

The following reproduces [backend/src/db/init.sql](./backend/src/db/init.sql), including its present constraints and omissions. It is the implemented baseline, not the complete proposed production model.

```sql
-- Etsy schema. Idempotent: safe to re-run (npm run db:migrate) without destroying data.

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  full_name VARCHAR(200),
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Categories table
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  parent_id INTEGER REFERENCES categories(id),
  image_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Shops (sellers)
CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) UNIQUE NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  banner_image VARCHAR(500),
  logo_image VARCHAR(500),
  rating DECIMAL(2, 1) DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  sales_count INTEGER DEFAULT 0,
  shipping_policy JSONB DEFAULT '{}',
  return_policy TEXT,
  location VARCHAR(200),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Products
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL,
  compare_at_price DECIMAL(10, 2),
  quantity INTEGER DEFAULT 1,
  category_id INTEGER REFERENCES categories(id),
  tags TEXT[] DEFAULT '{}',
  images TEXT[] DEFAULT '{}',
  is_vintage BOOLEAN DEFAULT FALSE,
  is_handmade BOOLEAN DEFAULT TRUE,
  shipping_price DECIMAL(10, 2) DEFAULT 0,
  processing_time VARCHAR(100),
  view_count INTEGER DEFAULT 0,
  favorite_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Favorites (items and shops)
CREATE TABLE IF NOT EXISTS favorites (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  favoritable_type VARCHAR(20) NOT NULL,
  favoritable_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, favoritable_type, favoritable_id)
);

-- View history for personalization
CREATE TABLE IF NOT EXISTS view_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  viewed_at TIMESTAMP DEFAULT NOW()
);

-- Shopping cart items
CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER DEFAULT 1,
  reserved_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, product_id)
);

-- Orders (one per shop per checkout)
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  buyer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL,
  order_number VARCHAR(50) UNIQUE NOT NULL,
  subtotal DECIMAL(10, 2) NOT NULL,
  shipping DECIMAL(10, 2) DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  status VARCHAR(30) DEFAULT 'pending',
  shipping_address JSONB,
  tracking_number VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Order items
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title VARCHAR(200) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  quantity INTEGER NOT NULL,
  image_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
  shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  images TEXT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_products_shop_id ON products(shop_id);
CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cart_items_user_id ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_id ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_shop_id ON orders(shop_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user_id ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_view_history_user_id ON view_history(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product_id ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_shop_id ON reviews(shop_id);
```

The schema has ten tables. `orders.payment_transaction_id` is absent despite being referenced by checkout. `reserved_until` is only a nullable timestamp, with no reservation ledger, stock claim, expiry worker, or constraint. Quantity and price checks, an order status enum/check, and a unique review per purchased line are absent. Several ownership foreign keys permit null values. Polymorphic favorites have no foreign key to their target product/shop.

`DECIMAL` values arrive through the default `pg` parser as strings; route code converts monetary values to JavaScript floating-point numbers. Foreign-key actions retain order headers when a buyer/shop disappears, but deleting referenced orders/products can remove reviews. There are no automatic `updated_at` triggers. `CREATE TABLE IF NOT EXISTS` does not evolve an existing table definition.

### Production additions — proposed, not migrated

| Entity / change | Responsibility and invariant |
|-----------------|------------------------------|
| Listing / stock version | Nonnegative price and stock; explicit currency and publish eligibility; guarded revision |
| Purchase + quote | Buyer, selected lines, accepted totals, currency, shipping terms, expiry, revision, state |
| Reservation + reservation lines | Ownership, quantity, expiry, state; stock counters change atomically with reservation transitions |
| Operation receipt | Unique buyer + operation ID, request digest, durable state/result; reject conflicting reuse |
| Payment attempt | Stable provider reference, amount, state, event deduplication, reconciliation history |
| Seller order | Purchase relation, immutable item snapshots, legal fulfillment transitions, cancellation effects |
| Outbox / consumer receipt | Committed work, aggregate version, retry status and idempotent effect identity |
| Review eligibility | Reference a delivered purchased line; unique author/line; transactionally maintained aggregate or rebuildable projection |

Use integer minor units with explicit currency and defined rounding boundaries for the proposed payment contract. Keep an audit trail for inventory adjustments and refund effects. A database constraint backs up request validation; neither replaces guarded concurrent transitions.

## API Design

### Implemented route inventory

All paths below are mounted under `/api`; identifiers are local numeric IDs. JSON uses camelCase for many write fields and database snake_case in responses. This is an inventory of code, not an assurance that every route succeeds with the supplied schema.

| Method | Path | Actual purpose / boundary |
|--------|------|---------------------------|
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | Cookie session lifecycle; login takes email/password |
| GET | `/auth/me` | Database user and shop objects; differs from login's `shopIds` response |
| GET | `/products`, `/products/trending` | SQL product lists; trending weights lifetime views and favorites |
| GET | `/products/search` | Cached Elasticsearch search with SQL fallback |
| GET | `/products/:id` | Cached product, view update, optional user history, similar products |
| POST / PUT / DELETE | `/products`, `/products/:id`, `/products/:id` | Seller create/update/soft-delete and best-effort indexing |
| POST | `/products/upload` | Authenticated multipart `images`, up to five files, 5 MiB each |
| GET | `/shops`, `/shops/:id`, `/shops/slug/:slug`, `/shops/:id/products` | Public shop metadata and active listing pages |
| POST / PUT | `/shops`, `/shops/:id` | Create shop or update owned shop |
| GET | `/shops/:id/orders`, `/shops/:id/stats` | Session-authorized seller views |
| GET | `/categories`, `/categories/slug/:slug`, `/categories/:id/products` | Category navigation and products |
| GET / DELETE | `/cart` | Read grouped SQL cart / delete entire user's cart |
| POST / PUT / DELETE | `/cart/items`, `/cart/items/:itemId`, `/cart/items/:itemId` | Add, change, or remove a cart row |
| POST | `/orders/checkout` | Optional `Idempotency-Key`; shipping address required; schema mismatch blocks fresh setup |
| GET | `/orders`, `/orders/:id` | Buyer list / buyer or seller detail |
| PUT / POST | `/orders/:id/status`, `/orders/:id/cancel` | Seller status update / buyer pending-order cancellation |
| GET / POST | `/favorites` | Read favorites, add using `type` and `id` |
| DELETE / GET | `/favorites/:type/:id`, `/favorites/check/:type/:id` | Remove or check favorite |
| GET | `/reviews/product/:productId`, `/reviews/shop/:shopId` | Review lists |
| POST / PUT / DELETE | `/reviews`, `/reviews/:id`, `/reviews/:id` | Review creation and author editing/removal |

Search parameters are `q`, `categoryId`, `priceMin`, `priceMax`, `isVintage`, `isHandmade`, `freeShipping`, `sort`, `limit`, and `offset`. Implemented sorts are relevance, `price_asc`, `price_desc`, `newest`, and `popular`. There is no `/api/search`, availability endpoint, personalized feed, or `/api/v1` namespace.

A cart mutation uses `productId` and `quantity`; cart changes do not reserve global stock. Checkout accepts `shippingAddress`, optional `notes`, and optional `paymentDetails`; address validation checks presence rather than its fields. Shipping is summed once per cart line, while subtotal multiplies unit price by quantity. There is no tax or currency contract.

The proposed production API adds quote creation/acceptance and durable purchase-status reads. Responses distinguish unavailable lines, quote changes, accepted processing, definitive decline, and completed purchase. HTTP success for accepting work must not imply confirmed payment.

## Key Design Decisions

### Short checkout holds over reserving every saved cart

A one-unit vintage listing cannot be promised to two buyers. Reserve it in PostgreSQL only when a buyer starts checkout, using a short transaction that checks all selected lines and commits the corresponding stock claims together. This makes a hold a durable business fact and gives the buyer a meaningful payment window.

Reserving on add-to-cart encourages abandoned carts and automated hoarding to hide the catalog. Checking only a stale product cache at final payment allows competing buyers to proceed. A short checkout hold costs an expiry worker, abuse limits, and handling for payment that outlives the initial deadline. Limit active holds per account and protect the transition into payment processing; expiry alone is not a concurrency protocol.

PostgreSQL row locks serialize conflicting writers and remain until transaction end; lock ordering and short transactions reduce contention and deadlock risk. Ordinary reads do not obtain those protections. See [PostgreSQL's locking documentation](https://www.postgresql.org/docs/16/explicit-locking.html). The local read-before-transaction flow does not implement the proposed hold.

### Durable purchase workflow over one database transaction around payment

Keep quote/stock decisions atomic in the database, but drive the remote payment operation from durable state. A database rollback cannot undo a provider charge. Waiting on the provider inside a transaction would also hold scarce-stock locks and consume connections during an outage.

A durable workflow gives retries a stable purchase and provider reference. Its cost is explicit intermediate states, reconciliation, and compensation. The user can see “payment being checked” rather than a false failure or success. Begin with one database for the all-line hold; sharding inventory by seller later requires cross-partition coordination and must not silently change basket semantics.

### Search projection over querying the transactional catalog for every search

An inverted index supports linguistic matching and facets without expensive catalog joins on each query. A small metadata cache saves repeated reads. Both are allowed to lag because the quote revalidates authoritative data. This separation protects the stock database from browsing load.

The price is a durable indexing pipeline, tombstones, rebuild procedures, and visible degradation. Inline best-effort index writes can lose updates permanently after a database commit; a cache TTL cannot repair a missing index update. SQL search is a viable smaller-system alternative, including full-text extensions, but the local `ILIKE` fallback has different matching, filtering, and counting semantics.

## Consistency and Idempotency

In the proposal, receipt lookup and mutation are scoped to the authenticated buyer, operation ID, and canonical request digest. A unique SQL receipt prevents two workers creating independent purchases. A different payload with the same operation ID is rejected; an identical retry returns the stored state/result. Receipt retention follows the business retry/reconciliation period rather than a cache eviction policy.

Provider requests, webhooks, expiry processing, confirmation, cancellation, and refunds all require stable effect IDs and guarded state transitions. Delivery is at least once; a unique effect plus transactional state changes supplies once-only business effects. Do not claim end-to-end exactly-once delivery. Search and notification consumers discard obsolete aggregate versions and retry safely.

The implemented [Redis middleware](./backend/src/shared/idempotency.ts) is optional, uses a global `idempotency:<key>` key, claims processing for 60 seconds, and asynchronously caches successful JSON responses for 24 hours. It does not bind the key to buyer or body, write a SQL receipt, renew/fence the lock, or atomically couple the cached result to the order commit. Another authenticated buyer reusing a completed key can receive the first buyer's response, including delivery data. The browser sends no idempotency key.

## Security / Auth

Production requests need server-side ownership checks against current authorization, input bounds, authenticated session rotation, CSRF protections appropriate to deployment, and rate limits on login, uploads, search, and holds. Upload original files to private object storage, validate actual image content, produce safe derivatives, and publish only those assets. Limit retained delivery data and redact credentials, session identifiers, and private query fields from logs.

Locally, bcrypt hashes passwords with cost 10 and `express-session` stores sessions through `connect-redis` using the ioredis client. Cookies last seven days, are HttpOnly, and are Secure/SameSite Strict in production or non-Secure/SameSite Lax in development. Sessions store `userId`, role, and a snapshot of shop IDs. Seller authorization trusts that snapshot. `/auth/me` fetches shops for its response but does not refresh the session authorization list; other sessions do not learn newly created shops immediately.

Helmet and credentialed CORS are wired in [the API entry point](./backend/src/index.ts). There is no rate limiter, session regeneration at login, or admin moderation API. Backend registration checks required values but does not enforce the frontend's password length rule. Upload validation checks client-declared MIME type and size; files retain the original filename extension under a UUID, and there is no content decoding or cleanup service.

## Observability

Production metrics should measure search p95, stale/filtered-out hits, projection lag, hold contention/expiry, purchases stuck in unknown payment state, duplicate effects prevented, refund backlog, and stock reconciliation discrepancies. Record money outcomes from committed state rather than from attempted writes. Use bounded labels; per-shop IDs can create excessive metric cardinality.

Locally, [metrics.ts](./backend/src/shared/metrics.ts) exposes process/HTTP, cache, search, breaker, checkout, and order metrics through `/metrics`. [logger.ts](./backend/src/shared/logger.ts) and HTTP middleware emit structured Pino logs. There is no bundled Prometheus/Grafana deployment or distributed tracing. Order counters and values are observed inside the SQL transaction and can count attempts that later roll back. `ordersByShop` labels contain shop IDs. Query timing is not instrumented around every database operation.

`/api/live` reports process liveness. `/api/ready` and `/api/health` check PostgreSQL and Valkey; health includes breaker information but does not make an Elasticsearch probe or validate checkout schema. A green health response therefore does not prove successful search or purchasing. Dependency checks lack an explicit overall deadline.

## Failure Handling

| Failure | Production policy | Current implementation |
|---------|-------------------|------------------------|
| Lost checkout response | Read/retry the same durable purchase operation | Browser has no operation ID; optional Redis result may be absent |
| Payment timeout | Keep unknown state and reconcile by stable reference | Simulation fallback reports queued without durable work |
| Stock contention | Guard all selected line claims; return explicit conflict | Reads precede transaction; unguarded decrement after schema-compatible insert |
| Elasticsearch unavailable | Budgeted fallback preserving supported filters; disclose capability limits | SQL fallback ignores several filters/sort; UI ignores `fallback` |
| Index update lost | Retry committed outbox event; compare versions | Helper logs error and resolves; no retry job |
| Redis unavailable | Browse can use bounded source reads; critical effects use SQL receipt | Lock-backed product/shop reads can fail; sessions also depend on Redis |
| Duplicate cancellation | Guard transition and unique inventory/refund effects | Buyer path may restock twice; seller status path does not restock |
| Search overload | Bound query length, result size, concurrency, and fallback load | Pagination inputs are parsed but not consistently capped |

Opossum is wired for search (3-second timeout, 50% threshold after minimum 10 requests, 15-second reset) and simulated payment (5 seconds, 25% after minimum 5, 30-second reset). These are rolling-statistics thresholds, not a fixed “last ten requests” policy. Fallbacks also run for individual rejected actions; a simulated decline can become a “queued” result. The breaker does not cancel the underlying action. Similar-product queries bypass it and swallow errors into an empty list.

Shutdown closes the HTTP server, PostgreSQL pool, and Redis client with a 30-second forced-exit limit. The source does not close the Elasticsearch client in that shutdown path. Startup awaits index initialization, but that helper catches failures and allows the server to listen.

## Scalability Considerations

Scale read-heavy catalog/search processes independently from checkout; cache images and public content at the edge. Add Elasticsearch replicas and explicit shard planning after measuring index/query size. Coalesce indexing events by listing version and keep projection lag within the target. Avoid letting an index outage send unlimited full-table fallback queries to the stock database.

Keep inventory and purchase writes on an authoritative regional database initially. Bound connection pools across API instances, order stock locks consistently, and shed excess attempts for hot listings. A waiting room can provide admission control; a Redis queue is not inventory ownership. Batch order-item reads to avoid the local list route's per-order query loop.

As order history grows, partition immutable history and move seller analytics to a reporting projection. Shop revenue must distinguish paid, refunded, and cancelled amounts. Cross-region active stock writers require explicit ownership or consensus; adding read replicas does not solve overselling. Moving seller stock to separate shards requires revisiting the all-basket reservation transaction.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Stock ownership | Short database checkout holds | Holds on every cart add | Protect payment window while reducing abandoned-cart hoarding |
| Basket consent | All selected lines held, explicit re-quote on conflict | Silent partial checkout | Buyer controls what is purchased and charged |
| Payment coordination | Durable workflow and reconciliation | Remote call inside SQL transaction | Database rollback cannot reverse a remote charge |
| Retry identity | Buyer-scoped SQL receipt and digest | Redis-only response cache | Durable business result survives cache loss and prevents cross-user replay |
| Discovery | Versioned search projection | Heavy primary-database searches | Separate retrieval load from stock transactions |
| Client mutations | Confirm purchases; optionally predict favorites | Optimistically confirm all writes | Money and scarce stock require authoritative acknowledgment |

## Implementation Notes

### Patterns actually wired, with their limits

The implementation is one Express application with [route modules](./backend/src/index.ts), PostgreSQL, Valkey, Elasticsearch, and a client-rendered React app. Shared helpers are real, but their presence does not establish the production guarantees above.

**SQL transaction pattern.** Checkout places seller-order inserts, item snapshots, stock decrements, shop counters, and cart deletion inside `BEGIN`/`COMMIT`. This can group database effects atomically, but availability was read outside it and the schema mismatch prevents normal fresh-schema completion. If the missing column is supplied externally, two buyers can both pass the earlier one-unit stock check and decrement below zero. Negative quantities/prices are not consistently rejected by routes or database constraints.

The stock update currently used in [orders.ts](./backend/src/routes/orders.ts) is:

```sql
UPDATE products SET quantity = quantity - $1 WHERE id = $2;
```

It lacks a current-availability predicate and corresponding affected-row check. Payment simulation happens before `BEGIN`. Product invalidation and order metrics occur before commit; invalidation can race cache refill with old data. Checkout deletes every cart row for the buyer, including inactive products omitted from the selected query. Concurrently added rows can also be removed without being purchased. The browser then sends another whole-cart deletion.

**Cache-aside and stampede control.** [cache.ts](./backend/src/shared/cache.ts) is used for product/shop metadata, shop product pages, search, and trending results:

| Cache | Real key / TTL | Important limitation |
|-------|----------------|----------------------|
| Product | `product:<id>` / 300 seconds | Includes stock snapshot; no authoritative reservation |
| Shop | `shop:<id-or-slug>` / 600 seconds | Numeric slug/ID namespace can collide; aggregates may lag |
| Shop products | `shop:products:<id>:<limit>:<offset>` / 180 seconds | Invalidation deletes an unpaginated key |
| Search | `search:<query-or-all>:<serialized filters>` / 120 seconds | Category invalidation scans a different key format; fallback responses also cached |
| Trending | `trending:<limit>` / 900 seconds | Views × 0.3 + favorites × 0.7, without time window or personalization |

Category and inventory TTL constants exist but their dedicated caches are not used. Cart routes read PostgreSQL; checkout invalidates a cart key, but no route populates that cache. There is no Redis write-through cart cache. Product/shop cache misses acquire `SET lock:<key> 1 EX 5 NX`, wait recursively in 50 ms intervals, and release with unconditional `DEL`. There is no owner token or bounded wait. Lock acquisition/release errors can fail a request even though plain cache get/set helpers catch Redis errors.

**Search and projections.** [elasticsearch.ts](./backend/src/services/elasticsearch.ts) creates an index if absent but never backfills SQL rows. Both seeds leave it empty. Product create/update/delete routes attempt index maintenance inline; helpers swallow failures. Changes to sales, reviews, favorites, views, and checkout stock do not reliably update indexed fields. There is no outbox, repair worker, alias rebuild, or version fence.

Title and description use standard tokenization, lowercase, a synonym filter, and stemming. No separate `search_analyzer` is configured, so the mapped analyzer also applies to queries by default; this is not index-time-only expansion. See [Elastic's analyzer documentation](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/search-analyzer). Tags are keyword fields. Text retrieval uses title ×3, description, tags ×2, `AUTO` fuzziness, and a two-character exact prefix. Ranking multiplies text score by summed transformed shop rating, sales, and 30-day freshness. Explicit price/newest/popular sorting supersedes score ordering.

Search filters positive quantity but does not index/filter product or shop active status. Updating `isActive` to false can leave a searchable document; the explicit delete route separately removes it best-effort. Similar-item retrieval has no stock/active filter. SQL fallback matches title/description plus category and active/in-stock eligibility, ignores price/attribute/free-shipping filters and requested sort, returns the page length as `total`, and supplies no facets. The UI does not render Elasticsearch facet aggregations.

**Idempotency, logs, health, and breakers.** The shared modules are [idempotency.ts](./backend/src/shared/idempotency.ts), [logger.ts](./backend/src/shared/logger.ts), [metrics.ts](./backend/src/shared/metrics.ts), and [circuit-breaker.ts](./backend/src/shared/circuit-breaker.ts). Their wiring and boundaries are detailed in the corresponding sections above. There are no implemented rate limiting, durable payment retries, or stock reconciliation helpers to cite.

### UI and domain behavior to account for

[authStore.ts](./frontend/src/stores/authStore.ts) and [cartStore.ts](./frontend/src/stores/cartStore.ts) hold in-memory state. API calls use credentials and JSON through [api.ts](./frontend/src/services/api.ts); there is no request cancellation, idempotency header generation, React Query integration, or persistent offline queue. Protected routes can redirect before root session hydration completes. Login returns shop IDs, while the dashboard expects shop objects returned by `/auth/me`. It only operates on the first shop.

Search filters partly originate in the URL but use local state and raw history updates, with no debounce or request-generation guard. An API error can trigger a general-product fetch that drops the search intent. Product and favorite requests can resolve after navigation and overwrite newer state. Cart fetch failures become an empty cart; logout does not clear all account-specific store data. Checkout's success path ignores queued payment status and can report failure if its redundant cart-clear request fails.

Seller statistics sum order totals across statuses, including cancelled or payment-pending orders. Seller status updates check an allowed label and session shop ownership but not legal transitions or an expected version. Buyer cancellation reads pending status before its transaction and restocks without a guarded transition. Reviews verify buyer/order/product association but not paid/delivered eligibility; duplicate checks lack a unique database constraint. Repeating a favorite add leaves one favorite row yet increments the product counter again. These counters are not reliable accounting or reputation aggregates.

Frontend grids are ordinary DOM lists with no virtualization, responsive-image pipeline, or pagination controls for several API-paginated views. The new-product form collects image URLs; the upload API writes to local disk. There is no review UI, listing edit form, order cancellation UI, or working multi-shop selector. Numeric formatting converts decimal strings, but the product discount comparison still compares two raw price strings lexically. Forms and hover menus need further keyboard/label/error-state work before claiming accessibility coverage.

### Substitutions and omissions

Docker supplies a single database/cache/search node; host processes replace independently deployed services. Images use seed URLs or an `uploads/` directory instead of object storage/CDN. Payments are a 100 ms randomized simulation with a 5% thrown decline; the fallback's `queued` flag has no durable queue behind it. Redis sessions replace a more elaborate identity integration. Seeds provide demonstration data rather than derived ratings or financial totals.

The TypeScript seed uses `admin123` for admin and `password123` for other accounts; the screenshot SQL seed uses `password123` for all. Both insert products on every run and neither indexes them. Source startup and migration do not repair those fixture/index discrepancies. The [README](./README.md) explains choosing one seed and explicitly indexing a fresh demo catalog.

Omitted production pieces include reservation expiry/ownership, a purchase parent, durable operation receipts, real payment authorization/capture/refunds, provider reconciliation, an outbox/index repair pipeline, CDN/private object storage, moderation/admin workflows, rate limiting, multi-region writes, and personalized ranking. Existing smoke tests exercise basic page rendering and login, not those guarantees. This review verified source and isolated mocked control flows; it did not run the full application stack or benchmark targets.
