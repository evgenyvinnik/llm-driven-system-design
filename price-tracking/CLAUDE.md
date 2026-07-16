# Price Tracking Service — Development with Claude

## Project Context

An e-commerce price monitor: users track product URLs, a fleet of scrapers records prices over time, and alerts fire when a price crosses a threshold. The core tensions are *scraping the open web reliably* (every retailer has different HTML, rate limits, and JS requirements) and *storing a firehose of time-series price points* efficiently enough to chart history and detect drops.

**Learning goals:** resilient large-scale scraping (Cheerio vs. headless), domain-sharded job queues with per-domain failure isolation, time-series storage with TimescaleDB hypertables + continuous aggregates, and threshold-based alerting.

## Architecture at a Glance (what actually runs)

Three infrastructure services in `docker-compose.yml`:

| Store | Role | Why this one |
|-------|------|--------------|
| **TimescaleDB** (`pg`, image `timescale/timescaledb:pg16`) | Relational data (users, products, alerts, scraper_configs) **and** the `price_history` hypertable + daily continuous aggregate | One engine for both: SQL joins across products/users/prices, plus hypertable partitioning and rollups for time-series — no separate TSDB to sync |
| **Valkey/Redis** (`ioredis`) | Sessions, response cache, rate-limit counters | Revocable session state + a cache that keeps hot product/chart reads off the DB |
| **RabbitMQ** (`amqplib`) | Domain-sharded scrape-job queue + `alerts.send` queue, with DLQ | Decouples scraping from the API; per-domain routing enables independent scaling and failure isolation |

Backend: Express API (`index.ts`, routes `auth`/`products`/`alerts`/`admin`) plus two workers — `scraper-worker.ts` (consumes jobs, parses pages) and `job-scheduler.ts` (node-cron enqueues due scrapes). Shared: `resilience.ts` (cockatiel circuit breakers), `retention.ts`, `queue.ts`, `metrics.ts` (prom-client). Scraping stack: axios + Cheerio + Puppeteer + JSON-LD, zod validation, bcrypt. Frontend: React 19 + TanStack Router + Zustand + Recharts + date-fns.

## Key Design Decisions

### 1. TimescaleDB over a separate time-series database (InfluxDB)
Price history is the high-volume time-series (`price_history` is a hypertable on `recorded_at`, with a daily continuous aggregate + refresh policy), but it must join to relational data — "chart this product's price for users who track it." TimescaleDB is a Postgres extension, so it's one engine, familiar SQL, and one connection pool. InfluxDB would mean a second datastore, a different query language, and cross-store joins done in application code. Trade-off given up: InfluxDB's specialized compression/ingest at extreme cardinality — not worth a second system at this scale.

### 2. Cheerio by default, Puppeteer only when a site needs JS
Most retailers render prices in server HTML (often as JSON-LD), so the scraper parses with Cheerio — no browser, far less CPU/RAM, much faster. Sites flagged `requires_js` in `scraper_configs` fall back to Puppeteer. Trade-off: Puppeteer is heavy (a headless Chrome per scrape), so it's the exception, not the default; defaulting to Puppeteer would 10×+ the scraper fleet's resource cost.

### 3. Domain-sharded queues + per-domain circuit breakers
Scrape jobs are routed by domain, and each domain has its own cockatiel circuit breaker (`resilience.ts`). One retailer going down or rate-limiting trips *its* breaker and skips *its* jobs, without backing up or degrading scrapes for every other site. Trade-off: more queue/breaker bookkeeping than a single global queue, but the isolation is the whole point — a payment-grade scraper can't let one flaky site stall the pipeline.

### 4. Extraction-health monitoring instead of blind trust
Retailers change their HTML without notice, silently breaking a parser. The system tracks per-domain extraction success rate; when it drops below ~70%, that's the signal a parser needs human review (rather than quietly recording nulls). Trade-off: it's a heuristic, not a guarantee — a subtle layout change that still parses *something* wrong won't trip it.

### 5. Session auth over JWT
Redis-backed sessions (cookie-parser + bcrypt), per repo convention: simpler than JWT rotation/refresh, with instant revocation. Trade-off: server-side session state, which the Redis dependency already provides.

## Current State

Implemented end to end: session auth (register/login), product tracking CRUD, the scraper worker (Cheerio + Puppeteer + JSON-LD extraction) behind per-domain circuit breakers, node-cron job scheduler, RabbitMQ domain-sharded scrape queue + alert queue with DLQ, TimescaleDB hypertable + daily continuous aggregate + retention policy, threshold alerts, admin dashboard with stats, Redis caching + rate limiting, Prometheus metrics, pino logging, and a React frontend with Recharts price-history charts.

Intentionally omitted / simulated: real proxy rotation and anti-bot evasion, a notification-delivery integration (alerts are recorded/queued, not sent via real email/push), distributed scraper coordination across regions, and CAPTCHA handling. Scraping runs against whatever URLs are added; there's no curated retailer parser library beyond the configurable `scraper_configs`.

## Iteration & Repair Log

- **2026-07 (CLAUDE.md rewrite):** Replaced the template phase checklist — which marked "Scaling and Optimization" and "Polish" as *Not started* while their bullets said "Redis caching implemented" and "continuous aggregates defined" (self-contradictory) — with an accurate Current State plus the Architecture table and this log. Kept the (correct) TimescaleDB / Cheerio / domain-queue / session-auth decisions.
- **Schema-apply path:** there is no `migrate.ts`; the schema (including `create_hypertable` and the continuous aggregate) loads from `backend/src/db/init.sql` via the `docker-entrypoint-initdb.d` mount. The README's setup (`docker-compose up` + `npm run dev` + `npm run dev:scraper`) reflects this — no `db:migrate` step to reference.
- **Repo-wide fixes that touched this project:** DB/Redis/RabbitMQ connection-string fallbacks to the docker-compose creds (`pricetracker:pricetracker123`, RabbitMQ `guest:guest`); `pino` logger hardening; DECIMAL price values formatted at the edge (prices are stored as numeric and formatted client-side).
- **CI:** the repo-wide smoke-test workflow was removed (no Docker services in CI).

## Open Questions

1. Continuous aggregates give daily rollups — at what scrape frequency / product count does charting need finer pre-aggregation (hourly) vs. querying raw hypertable chunks?
2. The 70% extraction-success threshold is a blunt signal; could per-field validation (price is a plausible number, currency present) catch silent mis-extraction the rate misses?
3. Scrape scheduling is node-cron in one process — how does this shard across multiple scheduler instances without double-enqueuing the same product?
4. Alerts are queued but delivery is simulated; where should the notification fan-out (email/push/webhook) and dedup/rate-limiting of alert spam live?

## Resources

- [TimescaleDB hypertables & continuous aggregates](https://docs.timescale.com/)
- [Cheerio](https://cheerio.js.org/) / [Puppeteer](https://pptr.dev/)
- [cockatiel (per-domain circuit breakers)](https://github.com/connor4312/cockatiel)
