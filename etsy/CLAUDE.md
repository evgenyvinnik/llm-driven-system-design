# Etsy — Development with Claude

## Project Context

A marketplace of mass-produced goods and a marketplace of handmade goods look similar and are architecturally different in two ways that touch almost every subsystem.

First, **inventory is usually one**. On Amazon, "out of stock" is a scheduling problem — the item comes back. Here, quantity 1 is the norm and there is no restock, no equivalent substitute, and no second chance: two buyers racing for the same item means one of them gets an error page for a thing that will never exist again. That makes checkout a genuine concurrency problem rather than a bookkeeping one, and it's why the cart carries a reservation concept at all.

Second, **the catalog has no canonical vocabulary**. There is no UPC, no manufacturer spec sheet, no normalized title. One seller writes "handmade leather billfold", another "artisan cowhide wallet", and a buyer searches "hand-made purse" — three descriptions of one product class sharing zero tokens. Exact-match search returns nothing and the buyer concludes the marketplace is empty. This is why search is Elasticsearch with a synonym-expanding analyzer rather than a `LIKE '%query%'` in Postgres.

Third, and quietly the most structural: **a cart spans sellers but an order cannot**. Three items from three shops ship from three places, get fulfilled independently, and can each be cancelled or refunded independently.

**Learning goals:** relevance tuning for an unnormalized catalog (synonyms, fuzziness, function scoring), splitting one checkout into per-seller orders inside a single transaction, cache-aside with stampede protection, idempotent payment-bearing endpoints, and the inventory race that one-of-a-kind items force you to confront.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **Express API** (`backend/src/index.ts`) | **3000** | Single process; session-based auth with `express-session` + `connect-redis` — a marketplace needs immediate session revocation on logout, which JWTs don't give you |
| **PostgreSQL 16** | 5432 | Orders, order items, and inventory decrements must be transactional. `DECIMAL` for money, which has downstream consequences — see the repair log |
| **Elasticsearch 8.11** | 9200 / 9300 | The `products` index with a custom `etsy_analyzer`. This exists *only* because the catalog is unnormalized; a normalized catalog would be served fine by Postgres full-text |
| **Valkey (Redis)** | 6379 | Two distinct roles: session store, and a cache-aside layer with per-key locks for products, shops, search results, and trending |

Backend routes are one file per resource in `backend/src/routes/` (`products`, `shops`, `categories`, `cart`, `orders`, `reviews`, `favorites`, `auth`), with cross-cutting concerns in `backend/src/shared/` — `cache.ts` (cache-aside + stampede lock + invalidation), `circuit-breaker.ts` (Opossum, wrapping the simulated payment gateway), `idempotency.ts`, `metrics.ts`, `logger.ts`. Search lives entirely in `backend/src/services/elasticsearch.ts`. Frontend is React 19 + TanStack Router + Zustand + Tailwind, with routes for browse, search, category, product, shop, cart, checkout, orders, favorites, and a `seller/` section (dashboard, create shop, new product).

## Key Design Decisions

### 1. Synonym expansion at index time, with fuzzy matching layered on top

`etsy_analyzer` chains `lowercase → synonym_filter → stemmer`, with hand-curated equivalence groups (`handmade, handcrafted, artisan, homemade, hand-made`; `wallet, billfold, purse, cardholder`; `silver, sterling, 925`). Queries then use `multi_match` across `title^3`, `description`, and `tags^2` with `fuzziness: AUTO` and `prefix_length: 2`.

Postgres `tsvector` search was the alternative and it fails on exactly the case that matters. Its dictionaries handle *morphology* — "wallets" → "wallet" — but not *vocabulary*: nothing in a stemmer knows that "billfold" and "wallet" are the same object. A buyer searching "billfold" gets zero results while the marketplace holds forty matching listings. Elasticsearch's synonym filter operates on a curated mapping, which is the only mechanism that can bridge that gap.

The two features solve orthogonal problems and both are needed: synonyms handle *different words for the same thing*, fuzziness handles *the same word misspelled*. `prefix_length: 2` means the first two characters must match exactly, which stops "ring" from fuzzy-matching "king" — short queries are where edit-distance matching does the most damage.

What we give up is real: the synonym list is manually maintained and lives in application code, so adding a term means a redeploy *and* a reindex (index-time synonyms are baked into the stored tokens). Search-time synonyms would avoid the reindex but cost query performance and break phrase matching. We also now run a second datastore that must be kept in sync with Postgres, with no change-data-capture — `indexProduct` is called from the write path, so a failure there silently leaves the index stale. Note that `searchProducts` returns a `fallback` flag, because a search path that hard-fails when Elasticsearch is down would take the whole storefront with it.

### 2. Ranking is `function_score` on shop signals, not pure text relevance

Text score is multiplied by three functions summed together: `shop_rating` (`sqrt` modifier, factor 1.5), `shop_sales_count` (`log1p`, factor 1.2), and a `gauss` decay on `created_at` with a 30-day scale.

Pure BM25 relevance is wrong for a marketplace because textual match quality doesn't correlate with purchase satisfaction. A brand-new shop with zero sales and a keyword-stuffed title outranks an established shop with 4.9 stars — and since sellers write their own titles, pure text ranking is directly gameable by whoever writes the most repetitive description. Blending in trust signals makes the ranking reflect "which of these will make the buyer happy", not "which one mentioned the word most".

The modifiers matter more than the factors. `log1p` on sales count is what stops a shop with 10,000 sales from outranking everything on every query forever — raw sales count would make the marketplace a permanent winner-take-all, and new sellers would never surface. `sqrt` on rating similarly compresses the 4.5-to-5.0 range where most shops actually sit. The `gauss` recency decay exists to counteract both: it gives new listings a temporary boost so the catalog doesn't ossify.

The trade-off is a rich-get-richer dynamic we've only *dampened*, not removed, and three tuning constants with no A/B framework to validate them against. They're guesses that look reasonable.

### 3. One order row per shop, created inside one transaction

Checkout groups cart items by `shop_id`, then inserts one `orders` row per shop — each with its own `order_number`, subtotal, shipping, status, and eventual tracking number — plus `order_items` children, decrements `products.quantity`, bumps `shops.sales_count`, and clears the cart. All of it in a single `BEGIN`/`COMMIT`.

A single order spanning shops fails immediately on state: order status is per-fulfillment. Shop A ships next day, shop B takes two weeks, shop C cancels. One `status` column cannot represent that, and every downstream feature — tracking numbers, seller dashboards ("your orders"), refunds, the seller's `sales_count` — is naturally scoped to a shop. You'd end up denormalizing status down to the line item, at which point you've rebuilt per-shop orders with extra steps.

The trade-off is that the buyer sees three orders for one checkout, which is a worse experience than one receipt, and there's no parent "purchase" entity tying them together — no single object to attach a combined-shipping discount or a whole-basket refund to. The atomic transaction is what keeps this honest: either all three shop orders exist or none do, so a buyer is never charged for a checkout that half-committed.

### 4. Payment is called *before* the transaction opens, behind a circuit breaker

`processPayment` (simulated, 100ms delay, 5% decline rate) runs through an Opossum breaker with a fallback that marks the order `payment_pending` rather than failing. Only after payment resolves does `BEGIN` execute.

The ordering is deliberate. Calling an external payment gateway *inside* an open transaction means holding row locks on `products` for the entire network round-trip to the payment provider — hundreds of milliseconds, or seconds under provider degradation. Every other buyer touching those product rows blocks behind it, so one slow payment call serializes checkout for unrelated shoppers. Keeping the external call outside the transaction means the database work is short and lock hold times are measured in milliseconds.

What we pay for that is a consistency gap: payment succeeds, then the transaction rolls back, and money moved with no order to show for it. The idempotency middleware on the endpoint narrows this (a retried checkout with the same key returns the stored result instead of charging twice), but the real fix is a saga with an explicit compensating refund, which isn't implemented. The breaker's `payment_pending` fallback is the closest thing here to a durable intent.

### 5. Cache-aside with a per-key lock, not plain cache-aside

`cacheAsideWithLock` in `shared/cache.ts` takes a Redis lock on `lock:<key>` before letting a request rebuild a missed cache entry. Plain cache-aside is fine until a hot key expires: if a popular product's cached entry drops while 500 requests per second are reading it, all 500 miss simultaneously and all 500 hit Postgres with the same query. That's a cache stampede, and the failure isn't slow responses — it's the database saturating and taking down endpoints that had nothing to do with that product. The lock means one request rebuilds and the rest wait for the result.

The cost is that the waiters are now blocked on a Redis round-trip plus the rebuild, so a *cold* key is slower than it would be uncached, and a crashed lock holder means waiters stall until the lock TTL expires. For read-heavy product pages where the same items are hot, that's the right trade.

## Current State

Runs end to end on backend 3000 + Vite 5173, with Postgres, Redis, and Elasticsearch from `docker-compose.yml`. Working: register/login with bcrypt and Redis-backed sessions, category browsing, Elasticsearch search with facets (category terms + price-range buckets) and sort options (price asc/desc, newest, popular), product detail pages with view-history tracking, shop pages, favorites for products and shops, a cart grouped by shop, checkout producing per-shop orders with simulated payment and idempotency keys, order history and status updates, reviews tied to purchases, a seller section (create shop, add products, dashboard), Prometheus metrics (checkout duration, order value, orders by shop), Pino structured logging, Opossum circuit breakers, and cache-aside with stampede locks and targeted invalidation.

Seeded logins (all created by `npm run db:seed`): sellers **`alice@example.com`**, **`bob@example.com`**, **`carol@example.com`** and buyer **`buyer@example.com`**, all with password **`password123`**; admin **`admin@example.com`** with password **`admin123`**.

Simplified or absent: payment is a simulated function with a random 5% decline rate, not a gateway; there is no shipping-rate calculation (shipping is a flat per-product `shipping_price`); no image upload pipeline (products carry image URLs); no personalized homepage or "because you viewed" recommendations, despite `view_history` being populated; and no admin moderation UI.

**Two gaps worth naming precisely.** First, `cart_items.reserved_until` is *written* — 15 minutes ahead, only for products with `quantity = 1` — but never *read*. Nothing at checkout, nothing in a sweeper job, nothing in the availability query consults it. So the reservation the schema advertises does not currently exist as behavior. Second, checkout validates availability with a plain `SELECT` *before* `BEGIN`, with no `SELECT ... FOR UPDATE` and no constraint preventing `products.quantity` from going negative. Two buyers checking out the same one-of-a-kind item concurrently can both pass validation and both decrement, leaving quantity at -1 and two orders for one object. For a marketplace whose defining characteristic is that inventory is one, that's the most important correctness gap in the codebase.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md with this structure. The checklist's most misleading claim was under "Key Challenges": it stated 15-minute cart reservations as the **Solution** to one-of-a-kind inventory, as settled fact. The column is written and never read — the stated solution to the project's signature problem isn't wired up. The checklist also listed Phase 2 as "IN PROGRESS" with all five items checked, and never mentioned idempotency, circuit breakers, cache stampede protection, or metrics, all of which are implemented.
- **Missing database schema (2026-07-12):** commit `439fde56` deleted `src/db/migrate.js` (schema + triggers) on the assumption that migrations were "handled elsewhere" — they weren't, so a fresh clone had no tables at all. The schema was recovered from git history as `backend/src/db/init.sql`, `backend/src/db/migrate.ts` and `npm run db:migrate` were added, and `init.sql` is now mounted into `docker-entrypoint-initdb.d` so `docker-compose up` self-initializes.
- **`init.sql` made idempotent:** the recovered schema used `DROP TABLE` statements, so re-running the migration silently wiped seeded data — you'd migrate, seed, migrate again out of habit, and be left with an empty storefront and no error. Every statement is now `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, and the seeder uses `ON CONFLICT ... DO NOTHING`, so migrate and seed are both safely repeatable.
- **Backend crash on boot (`pino-http`):** `src/shared/logger.ts` used CommonJS `require('pino-http')` inside an ESM package (`"type": "module"`), throwing `ReferenceError: require is not defined` at import time — the server never started. Replaced with the named ESM import `{ pinoHttp }` (pino-http v11+).
- **`price.toFixed()` crashing the UI (~25 call sites):** Postgres `DECIMAL`/`NUMERIC` columns come back from `pg` as **strings**, not numbers — deliberately, to avoid IEEE-754 precision loss on money. The frontend treated them as numbers, so every `price.toFixed(2)` threw `TypeError: price.toFixed is not a function` and blanked the component. Added `frontend/src/utils/format.ts` with `toNumber`, `formatPrice`, and `isFree`, which coerce string-or-number safely, and routed all money rendering through it across ProductCard, cart, checkout, product detail, orders, favorites, and the seller dashboard.
- **README drift:** the README instructed `npm run migrate`, which did not exist; it now documents `npm run db:migrate`.
- **CI:** the repo-wide smoke-test workflow was removed — a CI runner can't provide Postgres + Redis + Elasticsearch, so it failed on every PR without signalling a real defect.

## Open Questions

1. The inventory race is real: validation happens before `BEGIN` with no row lock. Is the right fix `SELECT ... FOR UPDATE` on the product rows (correct, but serializes checkout for popular items), a `CHECK (quantity >= 0)` constraint plus catching the violation (optimistic, but the buyer learns late), or making `reserved_until` actually authoritative so the race is resolved at add-to-cart time instead of checkout?
2. If reservations *are* enforced, who releases them? A background sweeper adds a process; checking `reserved_until > NOW()` lazily at read time means expired reservations linger in `cart_items` and every availability query grows a timestamp comparison. And what does the UI show a buyer whose 15 minutes lapsed while they were entering an address?
3. Synonyms are baked in at index time, so vocabulary changes require a full reindex. At what catalog size does that stop being a "run it overnight" operation and force a move to search-time synonyms or an alias-swap reindex pipeline?
4. `indexProduct` is called inline from the product write path with errors only logged. A failed index write leaves a product invisible to search but visible everywhere else — silently. Should indexing move to an outbox table drained by a worker, and is the resulting search staleness (seconds) more acceptable than the current possibility of permanent invisibility?

## Resources

- [Elasticsearch synonym token filter](https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-synonym-tokenfilter.html) — the mechanism behind decision 1
- [Elasticsearch function_score query](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-function-score-query.html) — modifiers and score/boost modes used in decision 2
- [Etsy Code as Craft](https://www.etsy.com/codeascraft) — Etsy's own engineering blog
- [node-postgres: data types](https://node-postgres.com/features/types) — why `DECIMAL` arrives as a string, the root cause of the `toFixed` bug
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) — `SELECT ... FOR UPDATE`, the candidate fix in open question 1
