# Web Crawler — Development with Claude

## Project Context

A distributed web crawler: seed it with URLs, and a pool of workers fetch pages, extract links and metadata, and feed newly-discovered URLs back into a shared frontier — all while respecting robots.txt and per-domain crawl delays. The core hard problem is the **URL frontier**: a queue that must be prioritized, deduplicated, politeness-throttled per domain, and safely shared across crashing workers, without ever crawling the same URL twice or hammering one host.

**Learning goals:** priority-queue frontier design, exact deduplication at scale, distributed politeness (one crawler per domain), and crash-safe work distribution across stateless workers.

## Architecture at a Glance (what actually runs)

Matches `docker-compose.yml` (Postgres, Valkey, an API container, and three worker containers) and `backend/package.json`:

| Store | Client | Role | Why this one |
|-------|--------|------|--------------|
| **PostgreSQL 16** | `pg` | Durable frontier state (`url_frontier` with status), crawled-page metadata, domains + robots cache, crawl stats | ACID + queryability: inspect/recover/reprioritize the queue, which a log-based queue can't do |
| **Redis / Valkey** | `ioredis` | Three priority sorted-sets (high/medium/low), the `VISITED_URLS` dedup set, per-domain crawl locks, live counters, sessions | O(1) dedup + fast priority pop on the hot path; self-expiring domain locks |

**No message queue** — the frontier *is* the queue, split across Redis (fast) and Postgres (durable). One Express **API/dashboard** server + **three worker processes** (`backend/src/worker.ts`, run as `webcrawler-worker-1/2/3`). Key deps: `cheerio` (HTML parse), `robots-parser` (politeness), `cockatiel` (retry/circuit-breaker/timeout in `shared/resilience.ts`), `express-session` + `connect-redis` (admin auth), `helmet`/`compression`/`express-rate-limit`, `prom-client`, `pino`. **Frontend:** React 19 + TanStack Router + Zustand + Tailwind dashboard that polls stats.

## Key Design Decisions

### 1. Hybrid frontier: Redis priority queues + PostgreSQL durability
`addUrl` writes the URL to `url_frontier` with `ON CONFLICT (url_hash) DO NOTHING` *and* pushes its hash onto one of three Redis sorted-sets by priority. `getNextUrl` pops from Redis high→medium→low, loads the row from Postgres, re-checks `status='pending'` (dropping stale queue entries), and marks it `in_progress`. Trade-off: the two stores are eventually consistent — a hash can linger in Redis after its row moved on — which is why the read path re-validates against Postgres, the source of truth. Chose this over pure-Postgres `FOR UPDATE SKIP LOCKED` to keep the hot dequeue off the priority index.

### 2. Exact dedup via Redis SET (not a Bloom filter)
Each URL is normalized then SHA-256 hashed; `addUrl` checks membership in the Redis `VISITED_URLS` set (`SISMEMBER`, O(1)) and the Postgres `url_hash` UNIQUE index backstops it. Trade-off: exact dedup means zero false negatives (we never skip a real page), but the set grows unbounded — at 10B URLs it's ~640GB. A Bloom filter is the production answer (10× less memory, ~0.1% false positives); exact is correct and simple at the 100K-URL learning scale.

### 3. Politeness = per-domain Redis lock, not a global rate limiter
Before crawling, a worker runs `SET crawler:domain:{d}:lock {workerId} NX EX {crawlDelay}`. Winning the lock is permission to crawl that domain; the TTL equals the domain's crawl-delay (from robots.txt or a 1s default), so the lock self-releases and the next fetch can't happen until the delay elapses. This *also* provides worker exclusivity — two workers can't hold one domain's lock, so they can't double-crawl. Trade-off: domain-level (not path-level) granularity means one busy domain is a single-lane road regardless of worker count, and workers burn cycles when every eligible domain is locked; token-bucket would smooth this but adds complexity for marginal gain.

### 4. Crash recovery by leasing, not transactions
A worker marks a URL `in_progress` and crawls it outside any long transaction. If the worker dies, that row is stuck — so `recoverStaleUrls` periodically resets `in_progress` rows older than N minutes back to `pending`. Trade-off: a crashed worker's URL is re-crawled (at-least-once), which is fine because crawling is idempotent; the alternative (holding a DB lock for the whole fetch) would tie up connections for slow pages and turn a hung request into a stuck lock.

### 5. Metadata-only page storage
`crawled_pages` stores `title`, `description`, `content_hash`, `content_length`, `status_code`, `links_count` — **not the raw HTML body**. Content dedup is by `content_hash`. Trade-off: we can detect duplicate content and drive the dashboard without an object store; storing full pages (for a real index) is the explicit v2 that would add S3/MinIO.

## Current State

Implemented end to end: the hybrid frontier with 3-level priority, URL normalization + SHA-256 dedup (Redis set + PG unique), robots.txt fetch/parse/cache (`robots-parser`, Redis 1h TTL + PG), per-domain NX-lock politeness, three workers pulling from the shared frontier with `cheerio` link/metadata extraction, `cockatiel`-wrapped fetches (retry + circuit breaker + timeout), stale-URL recovery, crawl-stats aggregation, a session-authenticated admin API (add seeds, recover jobs), Prometheus metrics, pino logging, and a polling React dashboard.

Intentionally omitted: raw-HTML/content storage (S3/MinIO, v2), JavaScript rendering (Puppeteer for SPAs, v2), Bloom-filter dedup, near-duplicate/shingle detection, and any real distributed queue (Kafka/Redis Streams) — the Redis+PG frontier stands in.

## Iteration & Repair Log

- **Distributed rate-limit + politeness** (`services/frontier.ts`): settled on `SET NX EX` per-domain locks after noting that a naive shared queue lets all three workers stampede one domain; the lock TTL doubles as the crawl-delay timer.
- **Stale-URL recovery added**: early runs left URLs pinned in `in_progress` when a worker was killed mid-fetch; `recoverStaleUrls` (reset after 10 min) makes the frontier self-healing at at-least-once cost.
- **Schema self-applies (no `db:migrate`):** there is no migrate script — Docker runs `backend/db/init.sql` via `docker-entrypoint-initdb.d`, and `models/database.ts` runs `CREATE TABLE IF NOT EXISTS` on API startup. README previously told users to run `npm run db:migrate` (nonexistent); corrected this pass to explain the auto-apply and keep `npm run db:seed`.
- **Doc drift fixes (this pass):** the old CLAUDE.md was Phase-1/2/3/4 checklists with "Not started" placeholders; rewritten to real decisions. `architecture.md` Decision 1 (and the "worker claim" / consistency notes) claimed a Postgres `FOR UPDATE SKIP LOCKED` dequeue that the code doesn't use — corrected to the actual Redis-queue + PG-durability hybrid with Redis-lock exclusivity.
- **CI note (repo-wide):** the GitHub Actions smoke-test workflow was removed; don't treat it as active.

## Open Questions

1. The `VISITED_URLS` Redis set is exact but unbounded — at what crawl size does it need to become a Bloom filter with Postgres as the exact-check backstop, and how do we migrate without a full re-crawl?
2. Politeness is per-domain; a CDN or shared host behind one IP can still be overwhelmed across many domains. Should throttling key on resolved IP as well?
3. Cheerio can't see JS-rendered content — worth detecting empty extractions and flagging those URLs for a Puppeteer lane, or is that a separate crawler entirely?
4. Priority is three coarse levels; does a continuous score (domain authority × freshness × depth) actually improve coverage, or just add starvation risk for low-priority URLs?

## Notes / Known Gaps

- The dashboard admin login is `admin` / `admin`, hardcoded (pbkdf2) in `backend/src/middleware/auth.ts` — it is **not** the repo-standard `password123`. Normalizing it requires a source-code change (out of scope for a docs pass), so the README intentionally doesn't advertise a login credential.

## Resources

- [Mercator: A Scalable, Extensible Web Crawler](https://www.cs.cornell.edu/courses/cs685/2002fa/mercator.pdf)
- [robots-parser](https://www.npmjs.com/package/robots-parser) · [Cheerio](https://cheerio.js.org/) · [Cockatiel](https://github.com/connor4312/cockatiel)
