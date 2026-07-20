# Yelp — Development with Claude

## Project Context

"Find me a good taco place nearby" is two different queries wearing one sentence. *Taco* is a relevance problem — tokenize, stem, score against names, descriptions, and categories. *Nearby* is a geometry problem — points within a radius, sorted by distance. The two want opposite index structures: an inverted index sorts by term relevance and has no idea what a kilometer is; an R-tree sorts by proximity and has no idea what a taco is. Every serious local-discovery system ends up running both and deciding, per query shape, which one leads.

The second thing that shapes this codebase is that reviews are the expensive write and ratings are the hot read. Every business card in every search result shows a star rating. Computing `AVG(rating)` at render time means aggregating a business's entire review history on every impression — so the rating has to be denormalized, which immediately raises the question of who maintains it and what happens when a review is edited or deleted.

Third: reviews are the attack surface. Ratings drive revenue for the businesses being rated, which means there is a real adversary, and rate limiting stops being a politeness feature and becomes the product's integrity mechanism.

**Learning goals:** dual-index search (Elasticsearch relevance + PostGIS proximity) with graceful degradation, denormalized aggregate maintenance via database triggers, async search indexing through a durable queue, and layered anti-abuse rate limiting.

## Architecture at a Glance (what actually runs)

| Component | Port | Why this one |
|-----------|------|--------------|
| **API server** (`backend/src/index.ts`) | **3000** | Express with `helmet`, request IDs, and per-request timing; `dev:server1/2/3` run 3001–3003 for multi-instance testing |
| **Index worker** (`workers/indexWorker.ts`) | — | Consumes `business_index` messages from RabbitMQ and writes to Elasticsearch, off the request path (`npm run dev:worker`) |
| **PostgreSQL** (`postgis/postgis:16-3.4`) | 5432 | Source of truth *and* the proximity index — `businesses.location` is `GEOGRAPHY(POINT, 4326)` with a GIST index |
| **Elasticsearch 8.11** | 9200 | Relevance ranking, geo-filtered search, and a `completion`-typed subfield for autocomplete |
| **Valkey (Redis)** | 6379 | Sessions, search-result cache (2 min), autocomplete cache (5 min), and every rate-limit counter |
| **RabbitMQ 3** | 5672 / 15672 | Durable queue decoupling Elasticsearch writes from API responses |
| **MinIO** | 9000 / 9001 | S3-compatible storage for business and review photos |

Business routes are split by operation under `backend/src/routes/businesses/` (`create`, `get`, `update`, `nearby`, `reviews`, `actions`) rather than one large file. Utilities in `backend/src/utils/`: `elasticsearch.ts` (index mapping and query helpers), `queue.ts` (publish/consume plus `publishBusinessIndexUpdate` / `Reindex` / `Delete`), `circuitBreaker.ts` (Opossum with metrics on every state transition), `reviewRateLimit.ts`, `syncElasticsearch.ts`, `redis.ts` (typed `cache.get`/`cache.set`), `storage.ts`, `idempotency.ts`, `logger.ts`, `metrics.ts`. Schema and triggers are in `backend/src/db/init.sql`.

Frontend is React 19 + TanStack Router + Zustand + Tailwind, with components grouped by surface (`components/business/`, `components/dashboard/`, `components/admin/`). Vite proxies `/api` → `localhost:3000`.

## Key Design Decisions

### 1. Elasticsearch and PostGIS both stay live, serving different query shapes

`routes/search.ts` goes to Elasticsearch: `multi_match` across name/description/categories, optionally filtered by `geo_distance`, ranked by relevance. `routes/businesses/nearby.ts` never touches Elasticsearch — it runs `ST_DWithin(...)` against the GIST index and orders by `ST_Distance`.

Collapsing to one engine fails in a specific direction each way. Postgres-only means implementing relevance with `ILIKE` or `tsvector`: no per-field boosting (a match on the business *name* should outrank a match buried in a description), no fuzzy tolerance for "tacoo", and no completion suggester. Elasticsearch-only means the "browse what's near me" path — which has no text query at all — depends on a search cluster to answer a pure geometry question, and inherits its availability and its index freshness for data that Postgres already holds authoritatively and exactly.

The give-up is two indexes over the same entities and therefore a sync problem, which is what decision 3 exists to manage. It also means "search" and "nearby" can disagree about which businesses exist during an indexing lag.

### 2. Ratings are maintained by a trigger that stores `rating_sum` alongside `review_count`

The trigger on `reviews` updates three columns: `rating_sum`, `review_count`, and the derived `rating`. Insert adds the new rating to the sum; update subtracts the old and adds the new; delete subtracts and guards against dividing by zero.

Recomputing `AVG(rating)` at read time is the obvious alternative and it's misplaced work: ratings are read on every search result card and every business page, and written only when someone reviews — a ratio that argues for paying at write time. Storing only the *average* and trying to update it incrementally doesn't work either, because you can't back out one contribution from a mean without knowing the count and the total. Keeping `rating_sum` makes edit and delete exact rather than approximate: an updated review is `sum - old + new` in one statement, no recomputation and no drift.

Doing it in a trigger rather than in application code matters for the same reason it does elsewhere in this repo — the aggregate and the row it aggregates commit in one transaction, so a crash can't leave a business with 47 reviews and a rating computed from 46. The cost is the usual one: this logic is invisible to anyone reading TypeScript, and a bulk review import fires the trigger per row.

### 3. Elasticsearch writes go through RabbitMQ, and the queue is explicitly non-critical

Business and review mutations call `publishBusinessIndexUpdate()` and return; the worker consumes and indexes. If RabbitMQ isn't available, `start()` catches the connection error, logs "RabbitMQ not available, async indexing disabled", and boots anyway — `/health` reports `degraded`, not `unhealthy`.

Synchronous indexing puts a second datastore's latency and availability into the write path of posting a review. A slow ES cluster makes review submission slow; an unreachable one makes it *fail* — and the failure is nonsensical to the user, because their review was perfectly valid and Postgres accepted it. Worse, the naive recovery (write Postgres, then index, roll back on failure) means a search-index problem can reject a durable write. Queuing inverts the priority correctly: the write always succeeds, and search catches up. Durable queues mean a worker restart doesn't lose the index update.

What we accept is a visible consistency window — a new business is findable by ID and by `nearby` immediately, but won't appear in text search until the worker drains. And with the queue down, that window is unbounded, which is what `syncElasticsearch.ts` exists to repair.

### 4. Search falls back to PostgreSQL through a circuit breaker — and fallback results are never cached

The `elasticsearch_search` breaker wraps the ES call; on open it logs "Using PostgreSQL fallback for search" and answers from Postgres. Results are cached in Redis for 120 seconds — but only `if (!results.fallback)`.

That conditional is the interesting half. Without it, an Elasticsearch outage doesn't just degrade search quality for its duration, it *poisons the cache*: every degraded result gets written under a normal cache key and continues being served for two minutes after ES recovers. Users would see relevance-free results long after the underlying problem was fixed, and the cache would keep repopulating with degraded results for as long as the breaker stayed open. Refusing to cache fallback responses means recovery is immediate — the moment the breaker closes, the next request produces a real result and caches that. The cost is that the fallback path gets zero cache relief exactly when the system is under stress, so Postgres absorbs the full search load during an ES outage.

### 5. Review abuse is limited on four independent axes, not one

`reviewRateLimit.ts` enforces: 10 reviews per user per hour, 2 reviews per user per *business* per day, 20 review-related actions per IP per hour, and 5 votes per user per minute — all as atomic Redis `MULTI` operations.

A single global limit can't express what abuse looks like here, because the abusive pattern is shaped differently from the legitimate one. A per-user hourly cap alone permits the actual attack: one account posting a review of the same competitor every hour, forever, which is well within any reasonable global budget. The per-user-per-business-per-day limit targets that directly, while leaving a prolific honest reviewer covering many businesses unaffected. The per-IP limit catches the opposite pattern — many fresh accounts from one source — which per-user limits are blind to by construction. The vote limit exists separately because vote-brigading a review to bury it is cheaper than writing a review and needs a tighter bound.

What we give up: four counters per action, four ways to be wrong, and a false-positive surface (shared office IPs hit the per-IP limit) that a single limit wouldn't have.

## Current State

Runs end to end: API on 3000, session auth in Redis with `user` / `business_owner` / `admin` roles, business CRUD with automatic PostGIS point maintenance, category browsing, business hours, photo upload to MinIO, reviews with one-per-user-per-business enforced by a unique constraint, review votes and owner responses, Elasticsearch-backed search with geo filtering and completion-suggester autocomplete, PostGIS proximity search, trigger-maintained rating aggregates, async indexing through RabbitMQ with a standalone worker, layered review rate limiting, idempotency keys on mutating operations, Prometheus `/metrics`, `/health` with per-dependency latency and circuit-breaker states, plus `/ready` and `/live` probes.

Frontend covers home, search results, business detail with photo gallery and review form, owner dashboard (business info editing and review management), user profile, and an admin panel with overview/users/businesses/reviews tabs.

Seeded logins (all `password123`): `alice@example.com` and the other users in `backend/db-seed/seed.sql`.

Not implemented: Bayesian or confidence-weighted rating (a business with one 5-star review outranks one with two hundred 4.8-star reviews), automated spam/fake-review detection beyond rate limiting, WebSocket notifications, map-based browsing with marker clustering, and any scheduled invocation of `syncElasticsearch.ts` — it exists as a repair tool but nothing runs it.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md. It listed Phase 3 "Scaling and Optimization" as **Not started**, with focus areas "Add caching layer" and "Add monitoring" — while the same file's own decision log already described Redis caching with 2-minute search TTLs, and `utils/metrics.ts` was serving a full Prometheus endpoint with circuit-breaker state gauges and DB-pool metrics that `/health` also reports. Phase 2 was marked "In progress" with every listed feature complete. The old file also never mentioned the fallback-caching rule (decision 4), which is the least obvious line in the search path.
- **Backend port is 3000, not 3001:** `dev` is a bare `tsx watch src/index.ts` and `index.ts` defaults to `process.env.PORT || 3000`, matching the Vite proxy target. Don't pin it to 3001 without changing `frontend/vite.config.ts`.
- **Schema requires the PostGIS image:** `init.sql` runs `CREATE EXTENSION postgis` and creates a GIST index on `businesses.location`; on plain `postgres:16` the schema load fails at container init and the database comes up empty, which later surfaces as a login failure rather than a schema error.
- **RabbitMQ startup made non-fatal:** `connectQueue()` is wrapped in its own try/catch inside `start()`, so a missing broker disables async indexing and logs a warning instead of aborting the boot. `isQueueConnected()` feeds `/health`, which downgrades to `degraded` rather than `unhealthy`.
- **Elasticsearch is degraded-not-fatal in health reporting:** an ES ping failure sets `degraded` (HTTP 200) while Postgres or Redis failures set `unhealthy` (503) — the tiering matches what each dependency actually blocks.
- **CI:** the repo-wide smoke-test workflow was removed (a CI runner can't provide the Docker services these tests need).

## Open Questions

1. Ratings are unweighted arithmetic means, so a single 5-star review beats a long track record. Is a Bayesian prior (shrinking toward the global mean by review count) worth the loss of explainability — users understand "4.5 stars from 200 reviews" and won't understand a shrunk score?
2. Nothing schedules `syncElasticsearch.ts`, so a RabbitMQ outage leaves Postgres and Elasticsearch permanently divergent until someone notices. Should the worker detect and self-heal, or does this need an explicit reconciliation job with a drift metric?
3. Search caches on a key built from `JSON.stringify` of all query params, including the caller's exact lat/long. Two users a hundred meters apart never share a cache entry. Should coordinates be snapped to a grid before keying — and how coarse can that grid get before "nearby" starts lying?
4. Rate limits are the only spam defense, and they only bound *volume*. What is the cheapest signal that would catch a coordinated review campaign staying under every limit — account age, review-text similarity, or the timing correlation between accounts?

## Resources

- [PostGIS reference](https://postgis.net/docs/) — `ST_DWithin` and `ST_Distance` over the `geography` type
- [Elasticsearch geo-distance query](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-geo-distance-query.html) — the geo filter layered onto relevance search
- [Elasticsearch completion suggester](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-suggesters.html#completion-suggester) — the mapping backing autocomplete
- [RabbitMQ durable queues and publisher confirms](https://www.rabbitmq.com/docs/confirms) — the delivery guarantees behind async indexing
- [Martin Fowler: Circuit Breaker](https://martinfowler.com/bliki/CircuitBreaker.html) — the pattern wrapping the Elasticsearch call
