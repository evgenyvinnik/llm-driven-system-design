# Bitly (URL Shortener) — Development with Claude

## Project Context

A URL shortener is deceptively small: two endpoints, one table. What makes it a real system-design problem is the **read/write asymmetry**. Creating a short link is rare and can afford a database write, a uniqueness check, and a hundred milliseconds. Following one is the opposite — it happens thousands of times more often, it sits directly in a user's page load, and it must answer in single-digit milliseconds or the link feels broken. Every decision in this project is downstream of that ratio.

The second problem is generating unique short codes without coordination. Three API instances must never hand out the same code, and the obvious answers all fail in interesting ways: a shared counter serializes every creation through one row; hashing the long URL means two users shortening the same link collide (and gives an attacker an oracle); random-with-retry degrades as the space fills. This project uses a **pre-generated key pool** — codes are minted in bulk ahead of time and leased in batches to instances, so the uniqueness question is answered once, offline, instead of on every request.

Third, analytics is a write amplifier sitting on the hottest path in the system. Every redirect wants to record a click, but an `INSERT` in the redirect handler makes the fast path as slow as the slowest write and couples link resolution to analytics availability. Decoupling the two is what RabbitMQ is doing here.

**Learning goals:** pre-generated key pools with batch leasing, read-through caching for a read-dominated workload, async event ingestion via a queue with a synchronous fallback, the 301-vs-302 trade-off, and circuit-breaking the database.

## Architecture at a Glance (what actually runs)

| Component | Port | Role | Why this one |
|-----------|------|------|--------------|
| **Express API** (`backend/src/index.ts`) | **3000** | `/api/v1/{auth,urls,analytics,admin}` plus the root-mounted `/:shortCode` redirect | Redirects mount at `/` *after* the API routes so `/api/...` can't be swallowed as a short code |
| **Analytics worker** (`backend/src/workers/analytics-worker.ts`) | — | Consumes `click_events` from RabbitMQ, prefetch 10, manual ack | Separate process so a slow write path cannot back up redirects; `dev:worker1/2` run two in parallel |
| **PostgreSQL 16** | 5432 | `urls`, `key_pool`, `click_events`, `users`, `sessions` — plus a `populate_key_pool()` SQL function | Source of truth; `key_pool` needs row-level locking, which is exactly what a relational DB is for |
| **Valkey 7** | 6379 | `url:{code}` → long URL (24h TTL), `session:{token}` (7d TTL), rate-limit counters | The redirect fast path; a cache miss is always recoverable from Postgres |
| **RabbitMQ 3** | 5672 / 15672 | Durable `click_events` queue | Buffers the write amplification; management UI at 15672 |

Services in `backend/src/services/`: `keyService.ts` (pool leasing), `urlService.ts`, `analyticsService.ts` (including the `recordClickSync` fallback), `authService.ts`, `adminService.ts`. Cross-cutting utilities in `backend/src/utils/`: `cache.ts`, `queue.ts`, `database.ts` (queries wrapped in an Opossum breaker), `circuitBreaker.ts`, `metrics.ts`, `logger.ts`. Helmet, CORS, and two rate limiters (general + a stricter one on URL creation) sit in front. Frontend is React + TanStack Router + Zustand + Tailwind on 5173, proxying `/api` → 3000.

## Key Design Decisions

### 1. Pre-generated key pool leased in batches of 100, not a counter or a hash
`fetchKeyBatch()` claims a batch with `UPDATE key_pool … WHERE short_code IN (SELECT … WHERE is_used = false AND allocated_to IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED)`, stamping `allocated_to = SERVER_ID`. Keys then live in a process-local array and are popped without touching the database at all; a refill fires when the cache drops below 50. The alternatives each break somewhere specific. A shared counter (base62-encoded) makes every URL creation contend on one row, so creation throughput is bounded by a single row's lock, and the codes are sequential — meaning anyone can enumerate every link ever created by counting. Hashing the long URL means two users shortening the same target get the same code and therefore share analytics, and it lets an attacker test whether a given URL has been shortened. Random-with-retry works while the space is empty and degrades as it fills, with no bound on retries. The pool answers uniqueness once, in bulk, offline. `FOR UPDATE SKIP LOCKED` is what makes concurrent instances refill without blocking each other — they skip rows another instance is already claiming instead of queueing behind it. The cost is a three-state lifecycle (`available` → `allocated` → `used`) that has to be monitored, and **keys leased into a process that then dies are stranded** — marked `allocated_to` forever with nothing to reclaim them.

### 2. 302 rather than 301, accepting permanently higher load to keep analytics
`res.redirect(302, longUrl)`. A 301 is the semantically correct answer — the mapping really is permanent — and browsers cache it aggressively, which would make repeat visits cost us literally nothing. That is exactly the problem: a cached 301 means the second and every subsequent click by that browser never reaches us, so click counts silently under-report by an amount that varies with browser cache behavior and is unmeasurable from our side. For a product whose entire value beyond redirection *is* the analytics, undercounting by an unknown factor is worse than serving more traffic. So we take the load: every click is a request, forever. That is a permanent, structural cost accepted for data fidelity, and it's the single biggest reason the Redis cache in decision 3 exists.

### 3. Redis read-through on the redirect path, and the click write pushed off it entirely
The redirect handler checks `url:{shortCode}` in Redis first and only falls through to Postgres on a miss, back-filling the cache with a 24-hour TTL. Then the click record is deferred with `setImmediate()` and published to RabbitMQ *after* the response is already on its way. Doing the analytics insert inline would put a durable write in front of every redirect — the fast path would inherit the write path's latency and, worse, its availability: a slow or full database would turn link resolution into a timeout. Publishing to a queue makes the redirect's cost a cache read plus a fire-and-forget enqueue. The trade-off is that click counts are eventually consistent — a user who clicks and immediately opens the analytics page may not see their own click — and if the process dies between responding and publishing, that click is simply lost. Losing an occasional click is acceptable; losing a redirect is not. There is a deliberate fallback: `isQueueConnected()` is checked, and if RabbitMQ is down the handler calls `recordClickSync()` instead, trading latency for not dropping data during a broker outage.

### 4. Custom codes are validated against `urls` *and* `key_pool`, not just `urls`
`isCodeAvailable()` rejects reserved words (`admin`, `api`, `login`, `health`, …) and then checks both tables. Checking only `urls` looks sufficient and isn't: a code sitting unused in the pool would pass validation, get claimed as a custom code, and then be handed to some instance later as a "fresh" pool key — producing a collision on `urls.short_code` at insert time, long after the user was told their custom code was available. Checking the pool closes that. It also means custom-code validation costs two indexed lookups instead of one, and there is still a narrow race between the check and the insert that only the unique constraint actually closes. The reserved-word list matters for a subtler reason: the redirect router is mounted at `/`, so without it a user could claim the code `api` and shadow a real route.

### 5. Database queries run behind a circuit breaker; the cache does not
`utils/database.ts` wraps `query` in an Opossum breaker exposed on the health endpoint. Postgres is the dependency whose failure mode is *slow*, not *down* — connections that hang rather than refuse, which is the case where retries make things worse by holding connections and exhausting the pool while the database recovers. Failing fast when the error rate crosses the threshold sheds load and lets it recover. Redis is deliberately left unbreakered because its failure is already handled by design: a cache miss falls through to Postgres, so an unavailable Redis degrades performance rather than correctness, and a breaker on it would add a failure mode where we refuse to even *try* the cache. The cost of the database breaker is that an open circuit rejects requests that might have succeeded — acceptable, because a rejected redirect is an error the user can retry, while a wedged connection pool takes the whole service down.

## Current State

Runs end to end: `docker-compose up -d` (Postgres, Valkey, RabbitMQ), backend on 3000, at least one analytics worker, frontend on 5173. Implemented: URL shortening with pool-allocated or custom codes, expiration (checked lazily at redirect time), 302 redirects with Redis read-through, click tracking with referrer/device-type/IP through RabbitMQ with a sync fallback, per-URL analytics aggregation, session auth with bcrypt, per-IP rate limiting on both general API and URL creation, Helmet, Prometheus metrics, structured Pino logging, an Opossum breaker on the database, and an admin dashboard with stats, URL management, user management, and a key-pool tab (backed by `getKeyPoolStats()` and a `repopulateKeyPool()` action).

**Seeded logins:** `alice@example.com` and `bob@example.com`, both `password123`. `admin@bitly.local` also exists, but its hash differs from the other two and is not a documented password — use `alice` for admin-less flows and check the seed file before relying on the admin account.

Not built: no local in-memory LRU in front of Redis (the redirect is one Redis round trip today), no sharding or read replicas, no malicious-URL screening, no dead-letter queue, and no automated tests.

## Iteration & Repair Log

- **2026-07 (docs rewrite):** replaced the phase-checklist CLAUDE.md with this structure. The old file marked **"Phase 2: Initial Implementation — *In Progress*"** while listing 20 completed sub-items covering the entire application, and marked **"Phase 3: Scaling and Optimization — *Not started*"** while `dev:server1/2/3`, `dev:worker1/2`, the Opossum database breaker, Prometheus metrics, and the RabbitMQ pipeline were all already in place. The one genuinely unbuilt Phase 3 item — the local LRU tier — was buried in a list of things that already existed.
- **Backend port is 3000 here, not 3001:** the `dev` script is bare `tsx watch src/index.ts` and `config.ts` defaults `SERVER_CONFIG.port` to 3000, which matches the Vite proxy. The repo-wide "pin `PORT=3001`" fix does **not** apply — 3000 is also the `baseUrl` used to build the short links themselves, so changing it changes generated URLs.
- **Stranded key leases (open issue):** keys are leased into a process-local array in `keyService.ts` and popped in memory. A restart loses the array, but the rows stay `allocated_to = SERVER_ID` with `is_used = false` forever. Nothing reclaims them, so the admin key-pool tab's "allocated" number grows monotonically across restarts. A reaper on `allocated_at` older than N hours would fix it.
- **`keyPoolCache` in `utils/cache.ts` is dead code:** it implements the same lease cache as a Redis list (`local_key_pool`), and nothing imports it. `keyService.ts` uses a plain in-process array instead. One of the two should go — the Redis version would actually survive restarts and fix the issue above.
- **Poison messages requeue forever:** the worker's error path is `ch.nack(msg, false, true)` — requeue unconditionally. A message that fails deterministically (malformed payload, FK violation) is redelivered in a tight loop indefinitely. There is no dead-letter exchange declared. Needs a retry count and a DLQ.
- **CI:** the repo-wide smoke-test workflow was removed — a CI runner can't provide Postgres, Valkey, and RabbitMQ. Verify locally with `npm run triage bitly`.

## Open Questions

1. Expiration is evaluated lazily in the redirect query (`expires_at IS NULL OR expires_at > NOW()`), but a *cached* entry has no expiry check at all — it just lives for its 24h TTL. Should the cached value carry the expiry so the fast path can enforce it, or should URL expiry simply never be shorter than the cache TTL?
2. Rate limiting is per-IP on creation. Authenticated users behind one corporate NAT share a budget; anonymous users behind a rotating proxy have none. Is per-user-when-authenticated / per-IP-otherwise the right split, or does that just move the abuse to unauthenticated creation?
3. A local LRU in front of Redis would remove a network hop from the hottest path, but a deactivated URL would keep redirecting from each instance's memory until its TTL lapsed — with no invalidation channel. Is the hop worth eliminating given the correctness cost, or is that only worth it above some RPS the project will never see?
4. Click analytics currently aggregate on read. At what click volume does that stop working, and is the answer pre-computed rollup tables in Postgres or a real column store — given the queue that would feed either is already in place?

## Resources

- [PostgreSQL: SELECT … FOR UPDATE SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) — the mechanism behind batch leasing in decision 1
- [MDN: 301 vs 302 redirects](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/302) — the caching behavior decision 2 turns on
- [RabbitMQ dead letter exchanges](https://www.rabbitmq.com/dlx.html) — the missing piece in the poison-message issue above
- [RabbitMQ consumer prefetch](https://www.rabbitmq.com/consumer-prefetch.html) — why the worker sets prefetch to 10
- [Opossum circuit breaker](https://nodeshift.dev/opossum/) — the library wrapping database queries in decision 5
