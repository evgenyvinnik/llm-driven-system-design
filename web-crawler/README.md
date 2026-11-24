# Web Crawler

A distributed web crawling system for indexing the internet with a focus on politeness, scalability, and efficient URL management.

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 10,300 |
| Source Files | 62 |
| .ts | 6,035 |
| .md | 1,986 |
| .tsx | 1,632 |
| .yml | 197 |
| .json | 170 |

## Features

- **URL Frontier with Priority Queue**: Manages URLs to crawl with three priority levels (high, medium, low)
- **Distributed Workers**: Multiple crawler workers that can run in parallel
- **Politeness**: Respects robots.txt directives and implements per-domain rate limiting
- **Deduplication**: Uses Redis sets for efficient URL deduplication
- **Content Extraction**: Parses HTML to extract links, titles, and metadata
- **Real-time Dashboard**: Monitor crawl progress, view statistics, and manage the crawler
- **Admin Interface**: Add seed URLs, recover stale jobs, and manage system settings

## Architecture

```
                    +------------------+
                    |   Frontend       |
                    |   (Dashboard)    |
                    +--------+---------+
                             |
                    +--------v---------+
                    |   API Server     |
                    |   (Express.js)   |
                    +--------+---------+
                             |
         +-------------------+-------------------+
         |                   |                   |
+--------v-------+  +--------v-------+  +--------v-------+
| Worker 1       |  | Worker 2       |  | Worker N       |
| - Fetch pages  |  | - Fetch pages  |  | - Fetch pages  |
| - Parse HTML   |  | - Parse HTML   |  | - Parse HTML   |
| - Extract links|  | - Extract links|  | - Extract links|
+----------------+  +----------------+  +----------------+
         |                   |                   |
         +-------------------+-------------------+
                             |
              +-----------------------------+
              |           Data Layer        |
              |  +----------+ +----------+  |
              |  |PostgreSQL| |  Redis   |  |
              |  | Frontier | | Dedup/   |  |
              |  | Metadata | | Cache    |  |
              |  +----------+ +----------+  |
              +-----------------------------+
```

## Tech Stack

- **Frontend**: TypeScript, React 19, Vite, TanStack Router, Zustand, Tailwind CSS
- **Backend**: Node.js, Express.js, TypeScript
- **Database**: PostgreSQL (URL frontier, crawled pages metadata)
- **Cache/Dedup**: Redis (visited URLs set, rate limiting, robots.txt cache)
- **Parsing**: Cheerio (HTML parsing)

## Getting Started

### Prerequisites

- Node.js 20+
- Docker and Docker Compose
- npm or yarn

### Quick Start with Docker

The easiest way to run the entire system:

```bash
# Clone and navigate to project
cd web-crawler

# Start all services (PostgreSQL, Redis, API, 3 workers, frontend)
docker-compose up -d

# View logs
docker-compose logs -f

# Access the dashboard
open http://localhost:5173
```

### Local Development Setup

For development, you can run the infrastructure in Docker and the application natively:

#### 1. Start Infrastructure

```bash
# Start PostgreSQL and Redis only
docker-compose -f docker-compose.dev.yml up -d
```

#### 2. Setup Backend

```bash
cd backend

# Install dependencies
npm install

# Schema is applied automatically: the Docker Postgres runs backend/db/init.sql
# on first boot, and the API also runs CREATE TABLE IF NOT EXISTS on startup.
# No separate migrate step.

# Seed initial URLs (optional)
npm run db:seed

# Start API server (port 3001)
npm run dev
```

#### 3. Start Crawler Workers

Open additional terminals to run workers:

```bash
cd backend

# Terminal 2: Start worker 1
npm run dev:worker1

# Terminal 3: Start worker 2
npm run dev:worker2

# Terminal 4: Start worker 3
npm run dev:worker3
```

#### 4. Setup Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server (port 5173)
npm run dev
```

#### 5. Access Dashboard

Open http://localhost:5173 in your browser. Reading the dashboard needs no login.
To seed URLs, recover leases, change domain settings or clear the frontier, sign in on
the **Admin** page (default dev credentials: `admin` / `password123`). Admins can add
more accounts — admins, or read-only users — from the Admin page.

### Running Distributed Crawlers

To run multiple crawler instances on different ports/machines:

```bash
# Terminal 1: API server
PORT=3001 npm run dev

# Terminal 2-4: Workers with different IDs
WORKER_ID=1 npm run dev:worker
WORKER_ID=2 npm run dev:worker
WORKER_ID=3 npm run dev:worker
```

For true distributed deployment, configure workers to connect to the same PostgreSQL and Redis instances by setting environment variables:

```bash
export POSTGRES_HOST=your-db-host
export REDIS_HOST=your-redis-host
export WORKER_ID=unique-worker-id
npm run start:worker
```

## API Documentation

### Authentication

Read endpoints are public. Every endpoint that changes crawler state is **admin-only**
(marked *admin* below) and requires the `crawler.sid` session cookie from a login:

```
POST /api/auth/login      {"username": "admin", "password": "password123"}
POST /api/auth/logout
GET  /api/auth/me
POST /api/auth/password   {"currentPassword": "...", "newPassword": "..."}   (any signed-in user)
```

Accounts live in the `users` table with two roles: `admin` (changes crawler state,
manages accounts) and `user` (read-only). On startup, if no active admin exists, one is
created — or restored — from `ADMIN_USERNAME` / `ADMIN_PASSWORD`, so restarting the API
with those set is the way back in if every admin is lost.

Login and password change are rate-limited to 10 attempts per 15 minutes per client.
Sessions live in Redis (`connect-redis` v7, which supports ioredis) for 24 hours and
are regenerated on login. Disabling a user, changing their role, or changing their
password **revokes their existing sessions immediately**. Unauthenticated calls to admin
endpoints return 401; signed-in non-admins get 403.

### User Management (admin)

```
GET    /api/admin/users
POST   /api/admin/users         {"username": "ops", "password": "at-least-8", "role": "user"}
PATCH  /api/admin/users/:id     {"role"?: "admin"|"user", "disabled"?: true, "password"?: "..."}
DELETE /api/admin/users/:id
```

Usernames are case-insensitive. The last active admin can't be demoted, disabled, or
deleted (409), and admins can't change their own role or delete themselves (400).

```
POST /api/admin/users/:id/revoke-sessions   Sign a user out everywhere
POST /api/auth/logout-others                Sign out your other sessions (keeps this one)
```

**Why sessions, not JWT:** the requirement here is *immediate* revocation (offboarding,
a leaked cookie). A JWT stays valid until it expires unless every request checks a
denylist — the same per-request lookup sessions need, plus rotation machinery. Session
checks read a small Redis record of each user's role / disabled flag / session version
(written through on every account change, with a Lua guard so a stale write can't undo a
revocation), so protected requests don't query Postgres. Change accounts through the API
or Admin page: a raw SQL `UPDATE users` isn't seen until the 10-minute cache entry expires.

### Audit Log (admin)

```
GET /api/admin/audit?limit=50&before=<id>&action=<prefix>&actor=<username>
```

Every sign-in attempt (including failures) and every change to crawler state or accounts
is recorded in `audit_log`: who, when, from which IP / user agent, what it targeted, and
details (never secrets — a password reset is recorded as `passwordReset: true`). Newest
first; page with `before=<nextBefore>`; `action=user.` filters by prefix. The table is
append-only (an UPDATE trigger rejects edits) and pruned after `AUDIT_RETENTION_DAYS`.

### IP Policy (admin)

```
GET  /api/admin/ip-policy           Per-IP delay, exempt ranges, source status
POST /api/admin/ip-policy/refresh   Re-fetch exempt-range sources now
```

```bash
# curl example
curl -c jar -H 'content-type: application/json' \
  -d '{"username":"admin","password":"password123"}' localhost:3001/api/auth/login
curl -b jar -H 'content-type: application/json' \
  -d '{"urls":["https://example.com"]}' localhost:3001/api/frontier/seed
```

### Health Check

```
GET /health          (also /api/health, reachable through the frontend proxy)
```

Returns the health status of the API and connected services.

### Statistics

```
GET /api/stats
```

Returns comprehensive crawl statistics including:
- Pages crawled/failed
- Bytes downloaded
- Links discovered
- Frontier status
- Active workers
- Recent pages
- Top domains

```
GET /api/stats/timeseries?hours=24
```

Returns time-series data for charts.

### URL Frontier

```
GET /api/frontier/stats
```

Returns frontier statistics (pending, in-progress, completed, failed counts).

```
GET /api/frontier/urls?limit=50&status=pending
```

Returns URLs from the frontier with optional status filter.

```
POST /api/frontier/add
Content-Type: application/json

{
  "urls": ["https://example.com", "https://another.com"],
  "priority": 2
}
```

*admin* — Adds URLs to the frontier. Priority: 1 (low), 2 (medium), 3 (high).

```
POST /api/frontier/seed
Content-Type: application/json

{
  "urls": ["https://example.com"],
  "priority": 3
}
```

*admin* — Adds seed URLs with high priority (seeds bypass the per-domain page budget).

```
POST /api/frontier/recover?minutes=10
```

*admin* — Recovers stale in-progress URLs now (the API also does this automatically every minute).

```
DELETE /api/frontier/clear
```

*admin* — Clears the entire frontier and its Redis queues and page-budget counters (use with caution).

### Crawled Pages

```
GET /api/pages?limit=50&offset=0&domain=example.com&search=keyword
```

Returns crawled pages with optional filtering.

```
GET /api/pages/:urlHash
```

Returns details for a specific crawled page.

```
GET /api/pages/domain/:domain?limit=50
```

Returns pages for a specific domain.

### Domains

```
GET /api/domains?limit=50&offset=0&sortBy=page_count&order=desc
```

Returns all crawled domains.

```
GET /api/domains/:domain
```

Returns details for a specific domain.

```
GET /api/domains/:domain/robots
```

Returns the cached robots.txt for a domain.

```
POST /api/domains/:domain/refresh-robots
```

*admin* — Forces a refresh of the robots.txt cache (makes an outbound request).

```
PUT /api/domains/:domain/settings
Content-Type: application/json

{
  "crawlDelay": 2.0,
  "isAllowed": true
}
```

*admin* — Updates operator settings and returns the domain. `crawlDelay` is an override
in seconds (or `null` to remove it); workers use `max(override, robots.txt delay)`, so an
override can only slow a domain down. `isAllowed: false` blocks the domain. Settings are
stored in Postgres and republished to Redis every minute, so they survive a Redis restart.

## Configuration

### Environment Variables

#### Backend/API

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | API server port |
| `NODE_ENV` | `development` | Environment mode |
| `POSTGRES_HOST` | `localhost` | PostgreSQL host |
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `POSTGRES_DB` | `webcrawler` | Database name |
| `POSTGRES_USER` | `postgres` | Database user |
| `POSTGRES_PASSWORD` | `postgres` | Database password |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `ADMIN_USERNAME` | `admin` | Bootstrap admin, created/restored only when no active admin exists |
| `ADMIN_PASSWORD` | `password123` | Bootstrap admin password — **required** in production when no active admin exists |
| `SESSION_SECRET` | dev placeholder | Session cookie signing secret — **required** when `NODE_ENV=production` |
| `COOKIE_SECURE` | `true` in production | Set `false` for plain-HTTP setups (the compose file does) |
| `TRUST_PROXY` | unset | Set (e.g. `1`) behind a TLS-terminating proxy so Secure cookies and client IPs work |
| `AUDIT_RETENTION_DAYS` | `365` | Audit log entries older than this are pruned by the cleanup job |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated origins allowed to make credentialed cross-origin calls |

#### Crawler Workers

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ID` | `1` | Unique worker identifier |
| `CRAWLER_USER_AGENT` | `WebCrawlerBot/1.0` | User agent string |
| `CRAWLER_DELAY` | `1000` | Default delay between requests (ms) |
| `MAX_CONCURRENT` | `10` | Max concurrent requests per worker |
| `REQUEST_TIMEOUT` | `30000` | Request timeout (ms) |
| `MAX_PAGE_SIZE` | `10485760` | Max page size to download (10MB) |
| `ROBOTS_CACHE_TTL` | `3600` | Robots.txt cache TTL (seconds) |
| `CRAWLER_MAX_DEPTH` | `6` | Max link hops from a seed (crawler-trap defense) |
| `CRAWLER_MAX_URL_LENGTH` | `2048` | URLs longer than this are dropped |
| `CRAWLER_MAX_LINKS_PER_PAGE` | `500` | Max outbound links enqueued per page |
| `CRAWLER_MAX_PAGES_PER_DOMAIN` | `10000` | Max URLs enqueued per domain (seeds exempt; `0` = unlimited) |
| `CRAWLER_IP_DELAY_MS` | `250` | Min spacing between requests to one IP across all its domains (`0` disables) |
| `CRAWLER_DNS_CACHE_TTL` | `300` | Seconds a resolved domain IP is cached |
| `CRAWLER_IP_EXEMPT_CIDRS` | none | Comma-separated CDN ranges: these IPs get `CRAWLER_CDN_IP_DELAY_MS` instead of the normal per-IP limit |
| `CRAWLER_IP_EXEMPT_SOURCES` | none | Comma-separated URLs of published CDN range lists (text or JSON), refreshed by the API |
| `CRAWLER_IP_EXEMPT_REFRESH_HOURS` | `24` | How often exempt-range sources are re-fetched |
| `CRAWLER_CDN_IP_DELAY_MS` | `50` | Per-IP spacing for CDN ranges (capped at `CRAWLER_IP_DELAY_MS`; `0` = fully exempt) |
| `CRAWLER_MAX_RETRIES` | `3` | Frontier-level retries for transient failures (timeout, 5xx, 429) |
| `CRAWLER_RETRY_BASE_DELAY` | `60000` | Base retry backoff (ms), doubled per attempt with jitter |
| `CRAWLER_STALE_LEASE_MINUTES` | `10` | `in_progress` URLs older than this are returned to the queue |
| `CRAWLER_MAINTENANCE_INTERVAL` | `60000` | How often the API runs lease recovery + queue rehydration (ms) |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | Pino log level |

## Project Structure

```
web-crawler/
├── backend/
│   ├── src/
│   │   ├── config.ts           # Configuration
│   │   ├── server.ts           # API server entry point
│   │   ├── worker.ts           # Crawler worker entry point
│   │   ├── models/
│   │   │   ├── database.ts     # PostgreSQL setup
│   │   │   └── redis.ts        # Redis setup
│   │   ├── routes/
│   │   │   ├── frontier.ts     # Frontier API routes
│   │   │   ├── stats.ts        # Statistics API routes
│   │   │   ├── pages.ts        # Pages API routes
│   │   │   └── domains.ts      # Domains API routes
│   │   ├── services/
│   │   │   ├── frontier.ts     # URL Frontier service
│   │   │   ├── crawler.ts      # Crawler worker service
│   │   │   ├── robots.ts       # Robots.txt service
│   │   │   └── stats.ts        # Statistics service
│   │   ├── utils/
│   │   │   └── url.ts          # URL utilities
│   │   └── scripts/
│   │       ├── migrate.ts      # Database migration
│   │       └── seed.ts         # Seed URLs
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── Dockerfile.worker
├── frontend/
│   ├── src/
│   │   ├── main.tsx            # Entry point
│   │   ├── App.tsx             # Main app component
│   │   ├── router.tsx          # TanStack Router setup
│   │   ├── components/         # Reusable components
│   │   ├── routes/             # Page components
│   │   ├── stores/             # Zustand stores
│   │   ├── services/           # API client
│   │   └── types/              # TypeScript types
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── Dockerfile
│   └── nginx.conf
├── docker-compose.yml          # Full stack deployment
├── docker-compose.dev.yml      # Development (infra only)
├── architecture.md             # System design docs
├── claude.md                   # Development notes
└── README.md                   # This file
```

## Politeness Features

1. **robots.txt Compliance**: Fetched and cached per origin (scheme + host + port). 4xx means no restrictions; 5xx or unreachable means "don't crawl yet" — URLs are retried later rather than crawled blind (RFC 9309)
2. **Crawl-Delay**: Honors robots.txt Crawl-delay (capped at 60s). An operator override from the Domains page can only slow a domain down, never go below robots.txt
3. **Per-Domain Rate Limiting**: A Redis lock with TTL = crawl delay spaces every request start to a domain across all workers — including in-process retries
4. **Per-IP Rate Limiting**: a second, looser lock on the domain's resolved IP (default 250ms) protects shared hosts where many domains live on one server. Measured on a two-domain, one-IP fixture with two workers: with the IP lock off, 12 of 25 request gaps were under 100ms (min 0ms); with it on at 1500ms, the min gap was 1505ms
5. **CDN ranges get a reduced per-IP rate**: CDNs serve unrelated sites from shared anycast IPs, so the normal per-IP limit would throttle all of them as one server — but no limit at all would let a crawler bug or burst hammer one edge. IPs in CDN ranges get `CRAWLER_CDN_IP_DELAY_MS` (default 50ms, ~20 req/s per edge IP) instead of 250ms, never stricter than ordinary IPs; `0` exempts them fully. Per-domain politeness always applies. Measured with two workers on two domains sharing one IP, per-IP limit 1500ms: ordinary IP → min gap 1519ms; CDN range at 700ms → 1008ms (the 700ms window rounds up to the workers' 500ms idle-poll tick); CDN range at 0 → 0ms. No ranges ship by default (they change, and a wrong range removes protection from real servers); point `CRAWLER_IP_EXEMPT_SOURCES` at the providers' own lists, e.g. `https://www.cloudflare.com/ips-v4,https://www.cloudflare.com/ips-v6,https://api.fastly.com/public-ip-list`. Use CDN-only lists — exempting a whole cloud provider would unprotect single-tenant servers. A failed fetch keeps the last good list
6. **Redirects via the frontier**: 3xx targets are enqueued as new URLs, so the target domain gets its own robots.txt check and politeness lock
7. **nofollow**: `rel="nofollow|sponsored|ugc"` links and `<meta name="robots" content="nofollow">` pages are not followed
8. **Retry-After**: 429/408 responses are rescheduled no earlier than the server asks
9. **User-Agent**: Sends a proper User-Agent string identifying the crawler

## Testing

```bash
# Backend
cd backend
npm run lint
npm run type-check
npm test                    # unit tests (vitest)

# Integration tests against real Postgres + Redis (docker-compose up -d first):
# - crawl: a local fixture site crawled by three workers (dedup, politeness
#   spacing, retries, redirects, robots.txt handling)
# - api: admin-only routes, login/logout + rate limit, user accounts and session
#   revocation, domain settings surviving Redis loss, per-IP locking, page budget
# - ops: audit trail (append-only, filters, keyset paging), auth cache (no
#   Postgres query per request, stale writes can't undo revocation), CDN
#   exemptions from static config and published lists
# WARNING: flushes the Redis DB and truncates the crawler tables.
# Stop any running API server/workers first - they share the same stores.
npm run test:integration

# Frontend
cd frontend
npm run lint
npm run build

# UI smoke tests (frontend + backend running; signs in as admin first)
cd ..
npm run test:e2e
```

## Future Enhancements

- [ ] Content storage (S3/local filesystem)
- [ ] Near-duplicate detection (SimHash)
- [ ] Distributed work stealing for load balancing
- [ ] Sitemap.xml parsing
- [ ] JavaScript rendering (Puppeteer integration)
- [ ] Ship audit entries to an external append-only sink (today: an append-only Postgres table, best-effort writes)

## License

MIT

## See Also

- [architecture.md](./architecture.md) - System design documentation
- [system-design-answer-fullstack.md](./system-design-answer-fullstack.md) - Detailed system design interview answer
- [CLAUDE.md](./CLAUDE.md) - Development notes and iteration history

## References & Inspiration

- [Mercator: A Scalable, Extensible Web Crawler](https://courses.cs.washington.edu/courses/cse454/10wi/papers/mercator.pdf) - Foundational paper on scalable web crawler architecture from Compaq/HP Labs
- [The Anatomy of a Large-Scale Hypertextual Web Search Engine](http://infolab.stanford.edu/~backrub/google.html) - Original Google paper describing their crawler architecture
- [IRLbot: Scaling to 6 Billion Pages and Beyond](https://irl.cse.tamu.edu/people/hsin-tsang/papers/www2008.pdf) - Academic paper on high-performance web crawling
- [Politeness for Web Crawlers](https://en.wikipedia.org/wiki/Robots.txt) - The robots exclusion protocol standard
- [Web Crawling Best Practices](https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers) - Google's guidelines for well-behaved crawlers
- [Heritrix Web Crawler](https://github.com/internetarchive/heritrix3) - Internet Archive's open-source web crawler
- [Scrapy Architecture](https://docs.scrapy.org/en/latest/topics/architecture.html) - Architecture overview of the popular Python crawling framework
- [Distributed Web Crawling with Apache Nutch](https://nutch.apache.org/documentation.html) - Apache's distributed crawler built on Hadoop
