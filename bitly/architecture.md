# Bit.ly - URL Shortener - Architecture Design

## System Overview

A URL shortening service that converts long URLs into short, memorable links with analytics tracking. The system is designed to handle billions of redirects per day at production scale, with sub-50ms redirect latency and strong consistency for URL creation.

## Requirements

### Functional Requirements

- **URL shortening**: Convert long URLs to 7-character Base62 short codes
- **URL redirection**: Redirect short URLs to original destinations with 302 response
- **Analytics tracking**: Record clicks with referrer, device type, and timestamp
- **Custom short URLs**: Allow users to specify custom short codes
- **Link expiration**: Support optional expiration dates for URLs
- **User authentication**: Session-based login for URL management
- **Admin dashboard**: System-wide statistics, user management, key pool management

### Non-Functional Requirements

| Requirement | Target | Rationale |
|-------------|--------|-----------|
| Availability | 99.99% (52 min downtime/year) | Redirect is a critical path; unavailability breaks all shortened links |
| Redirect p99 latency | < 50ms | Users perceive redirect delays as broken links |
| API p99 latency | < 200ms | Standard for CRUD API operations |
| Write throughput | 1,000 URLs/s | Supports tens of millions of URLs created per day |
| Read throughput | 100,000 redirects/s | 100:1 read-to-write ratio typical for URL shorteners |
| Consistency | Strong for URL creation, eventual for analytics | Duplicate short codes are unacceptable; analytics delays are tolerable |
| Durability | Zero data loss for URL mappings | Lost mappings permanently break links |

## Capacity Estimation

### Production Scale

| Metric | Value | Calculation |
|--------|-------|-------------|
| Daily Active Users | 10M | |
| URLs created per day | 50M | ~580 RPS average, ~5,000 RPS peak |
| Redirects per day | 5B | ~58,000 RPS average, ~200,000 RPS peak |
| Storage per URL | ~500 bytes | short_code + long_url + metadata |
| URL storage (1 year) | ~9 TB | 50M/day x 365 x 500B |
| Click events per day | 5B | ~30 bytes each |
| Analytics storage (1 year) | ~55 TB | Partitioned by month, archived after 90 days |
| Cache size (hot URLs) | ~50 GB | Top 100M URLs x 500B |

### Key Pool Sizing

With 7-character Base62 codes: 62^7 = 3.5 trillion possible codes. At 50M URLs/day, this provides 192,000 years of unique codes.

### Local Development Scale

| Metric | Value |
|--------|-------|
| DAU | 10-100 |
| URLs created per day | 500 |
| Redirects per day | 10,000 |
| Total storage (1 year) | ~200 MB |

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                CLIENTS                                       │
│              Web Browser / Mobile App / API Consumer                         │
└──────────────────────────┬───────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                           CDN / Edge Layer                                   │
│              (CloudFront / Cloudflare for static assets)                     │
└──────────────────────────┬───────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        API Gateway / Load Balancer                           │
│           (nginx / ALB — rate limiting, TLS termination)                     │
└────────┬─────────────────┬─────────────────┬────────────────────────────────┘
         │                 │                 │
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  API Server 1   │ │  API Server 2   │ │  API Server N   │
│  (Express.js)   │ │  (Express.js)   │ │  (Express.js)   │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Redis Cluster  │ │  PostgreSQL     │ │   RabbitMQ      │
│  (URL Cache +   │ │  (Primary +     │ │   (Analytics    │
│   Sessions +    │ │   Read Replicas)│ │    Events)      │
│   Rate Limits)  │ │                 │ │                 │
└─────────────────┘ └─────────────────┘ └────────┬────────┘
                                                  │
                                                  ▼
                                         ┌─────────────────┐
                                         │ Analytics Worker │
                                         │ (Batch Insert)   │
                                         └─────────────────┘
```

### Core Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| Load Balancer | Distribute requests, TLS termination, rate limiting | nginx / ALB |
| API Server | Handle URL operations and redirects | Node.js + Express + TypeScript |
| Cache | Fast URL lookups, session storage, rate limiting | Redis Cluster |
| Primary Database | URL metadata, users, key pool | PostgreSQL (primary + read replicas) |
| Message Queue | Async analytics processing | RabbitMQ |
| Analytics Worker | Batch-insert click events from queue | Node.js background service |
| CDN | Static asset delivery, edge caching | CloudFront / Cloudflare |

## Request Flows

### URL Shortening (Write Path)

```
1. Client → POST /api/v1/urls { long_url, custom_code?, expires_at? }
2. Load balancer routes to API server (least connections)
3. API validates URL format and length (max 2048 chars)
4. Idempotency check: hash(long_url + custom_code + user_id) → Redis lookup
5. If idempotent hit: return cached response
6. API fetches unused short_code from local key cache (or DB if cache empty)
7. API inserts URL record into PostgreSQL (transaction)
8. API writes to Redis cache: url:{short_code} → long_url
9. API caches idempotency response in Redis with 24h TTL
10. API returns { short_url, short_code, expires_at }
```

### URL Redirect (Read Path)

```
1. Client → GET /{short_code}
2. API checks Redis cache for url:{short_code}         → ~0.5ms
3. If cache hit: proceed to step 5                      → Total: ~1ms
4. If cache miss: query PostgreSQL, populate cache      → ~20ms
5. If URL expired or not found: return 404
6. API returns 302 redirect to long_url
7. API publishes click event to RabbitMQ (async, non-blocking)
8. Analytics worker consumes event, batch-inserts to click_events table
```

### Key Pool Allocation

```
1. Background job monitors key pool size
2. When pool drops below 5,000 unused keys, generate 10,000 new keys
3. Each API server fetches a batch of 100 unused keys to local memory
4. Keys marked allocated_to={server_id} in database
5. On URL creation, local cache provides key instantly (no DB round trip)
6. If local cache empty, fetch new batch from database
```

## Database Schema

```sql
-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

-- Sessions table
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Pre-generated key pool
CREATE TABLE key_pool (
    short_code VARCHAR(10) PRIMARY KEY,
    is_used BOOLEAN DEFAULT FALSE,
    allocated_to VARCHAR(50),  -- server instance ID
    allocated_at TIMESTAMPTZ
);
CREATE INDEX idx_key_pool_unused ON key_pool(is_used) WHERE is_used = FALSE;

-- URLs table
CREATE TABLE urls (
    short_code VARCHAR(10) PRIMARY KEY,
    long_url TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    is_custom BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ,
    click_count BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_urls_user_id ON urls(user_id);
CREATE INDEX idx_urls_expires ON urls(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_urls_active ON urls(is_active) WHERE is_active = TRUE;

-- Click events (analytics) — partitioned by month at production scale
CREATE TABLE click_events (
    id BIGSERIAL PRIMARY KEY,
    short_code VARCHAR(10) NOT NULL REFERENCES urls(short_code),
    clicked_at TIMESTAMPTZ DEFAULT NOW(),
    referrer TEXT,
    user_agent TEXT,
    ip_address INET,
    country VARCHAR(2),
    city VARCHAR(100),
    device_type VARCHAR(20)
);
CREATE INDEX idx_click_events_short_code ON click_events(short_code);
CREATE INDEX idx_click_events_time ON click_events(clicked_at);

-- PL/pgSQL function to generate and populate key pool
CREATE OR REPLACE FUNCTION generate_short_code(length INTEGER DEFAULT 7) RETURNS VARCHAR AS $$
DECLARE
    chars VARCHAR := 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    result VARCHAR := '';
    i INTEGER;
BEGIN
    FOR i IN 1..length LOOP
        result := result || substr(chars, floor(random() * 62 + 1)::integer, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION populate_key_pool(count INTEGER DEFAULT 1000) RETURNS INTEGER AS $$
DECLARE
    inserted INTEGER := 0;
    new_code VARCHAR;
BEGIN
    FOR i IN 1..count LOOP
        new_code := generate_short_code(7);
        BEGIN
            INSERT INTO key_pool (short_code) VALUES (new_code);
            inserted := inserted + 1;
        EXCEPTION WHEN unique_violation THEN
            -- Skip duplicates
        END;
    END LOOP;
    RETURN inserted;
END;
$$ LANGUAGE plpgsql;

-- Populate initial key pool
SELECT populate_key_pool(10000);
```

### Storage Strategy

| Data Type | Storage | TTL/Retention | Rationale |
|-----------|---------|---------------|-----------|
| URL metadata | PostgreSQL | Indefinite (or until expired) | Strong consistency, relational queries |
| Key pool | PostgreSQL | Indefinite | Transactional allocation |
| Sessions | Redis + PostgreSQL | 7 days | Fast lookup, DB fallback |
| URL cache | Redis | 24 hours | Hot path optimization |
| Click events | PostgreSQL (partitioned) | 90 days hot, then archive | Sufficient for analytics |
| Rate limit counters | Redis | 1 minute sliding window | Atomic operations |

### Redis Key Patterns

```
url:{short_code}              → long_url (string, 24h TTL)
session:{token}               → user_id + metadata (hash, 7d TTL)
rate:{ip}:{endpoint}          → request count (string, 1m TTL)
idempotency:{request_hash}    → cached response (string, 24h TTL)
```

## API Design

### Core Endpoints

```
# Public API
POST   /api/v1/urls               Create short URL
GET    /api/v1/urls/:code          Get URL metadata
GET    /api/v1/urls/:code/stats    Get click analytics
DELETE /api/v1/urls/:code          Deactivate URL

# Redirect (no /api prefix)
GET    /:short_code                302 redirect to long URL

# Authentication
POST   /api/v1/auth/register       Create account
POST   /api/v1/auth/login          Start session
POST   /api/v1/auth/logout         End session
GET    /api/v1/auth/me             Get current user

# User Dashboard
GET    /api/v1/user/urls           List user's URLs
GET    /api/v1/user/stats          User's aggregate stats

# Admin API
GET    /api/v1/admin/stats         System-wide statistics
GET    /api/v1/admin/urls          List all URLs (paginated)
GET    /api/v1/admin/users         List all users
POST   /api/v1/admin/key-pool      Repopulate key pool
DELETE /api/v1/admin/urls/:code    Force-delete any URL
```

## Key Design Decisions

### 1. Short Code Generation: Pre-generated Key Pool

**Chosen**: Generate random 7-character Base62 codes in advance and store in `key_pool` table.

**Why this works for URL shortening:**
- No coordination needed between API servers — each server fetches a batch of unused keys to local memory, eliminating write contention
- Random codes are not predictable, unlike sequential counters that leak business information (total URL count, creation rate)
- Guaranteed unique at generation time, unlike hash-based approaches that require collision detection and retries
- 62^7 = 3.5 trillion possible codes provides effectively unlimited capacity

**Why counter-based fails:** A global counter requires coordination. A single counter service becomes a bottleneck at 5,000 writes/s. Distributed counters (Snowflake-style) add operational complexity and still produce predictable codes. The key pool eliminates this coordination entirely by pre-allocating unique codes.

**What we give up:** Slight complexity in pool management — a background job must monitor pool size and repopulate when it drops below threshold. Some keys are "wasted" if a server crashes with allocated keys still in its local cache. At 3.5 trillion total keys, this waste is negligible.

### 2. Redirect Response: 302 Temporary

**Chosen**: 302 (Temporary Redirect) instead of 301 (Permanent).

**Why 302 works for analytics:** 301 redirects are cached by browsers indefinitely. Once cached, subsequent clicks to the same short URL never hit our server — the browser redirects directly. This makes click analytics fundamentally inaccurate. With 302, every click hits our server, ensuring accurate tracking.

**Why 301 fails:** For a URL shortener where analytics is a core feature, 301 makes analytics unreliable. You cannot measure what you cannot observe. Bit.ly's entire value proposition (beyond shortening) is click analytics.

**What we give up:** Higher server load. Every redirect requires a server round trip. At 200,000 RPS peak, this is significant. We mitigate this with Redis caching (sub-millisecond lookups) and horizontal scaling of stateless API servers.

### 3. Caching Strategy: Cache-Aside with Redis

**Chosen**: Cache-aside pattern with 24-hour TTL.

```
Read:  Check cache → if miss, query DB → populate cache → return
Write: Write to DB → write to cache (write-through)
Delete: Delete from DB → delete from cache
```

**Why cache-aside for this workload:** URL shorteners have a Zipf-distributed access pattern — a small percentage of URLs receive the vast majority of traffic. Cache-aside naturally keeps hot URLs in cache while letting cold URLs expire. With a 90%+ cache hit ratio, average redirect latency drops from ~20ms (DB) to ~1ms (Redis).

**Why write-through on URL creation:** New URLs should be immediately available via cache. The write-through on creation eliminates the cold-start problem where the first redirect to a new URL would always miss cache.

**Why not write-behind:** Write-behind (queue writes and batch to DB) risks data loss if Redis crashes before flushing. For URL mappings where durability is critical, this is unacceptable.

### 4. Analytics: Async via Message Queue

**Chosen**: Publish click events to RabbitMQ, process asynchronously with batch inserts.

**Why async analytics works:** Click recording must not slow down redirects. A synchronous DB insert adds 5-20ms to every redirect. At 200,000 RPS, this creates enormous database load. By publishing to a queue (~0.5ms) and batch-inserting in a worker, we decouple redirect latency from analytics write throughput.

**Why not Kafka:** RabbitMQ is simpler to operate and sufficient for this use case. Kafka's log-based architecture provides replay and multi-consumer capabilities we don't need. If analytics grows to require real-time streaming pipelines, Kafka would be the right migration path.

**What we give up:** Analytics have eventual consistency — there's a brief delay (typically <5 seconds) between a click and its appearance in analytics. For a URL shortener's analytics dashboard, this is acceptable.

## Security

### Authentication and Authorization

| Mechanism | Implementation |
|-----------|----------------|
| Password hashing | bcrypt (cost factor 12) |
| Session tokens | 256-bit random (crypto.randomBytes), stored in httpOnly cookie |
| Cookie settings | httpOnly, sameSite: lax, secure in production |
| Session expiration | 7 days with sliding window |
| RBAC | Two roles: `user` (own URLs) and `admin` (all resources) |

### Rate Limiting

| Endpoint | Limit | Window | Scope |
|----------|-------|--------|-------|
| POST /api/v1/urls | 100 | 1 hour | Per IP |
| GET /{short_code} | 1,000 | 1 minute | Per IP |
| POST /api/v1/auth/* | 5 | 1 minute | Per IP |
| All authenticated | 200 | 1 minute | Per user |

Implementation: Redis-based sliding window counter with atomic INCR + EXPIRE.

### Input Validation

- URL format: Valid HTTP/HTTPS URL, max 2,048 characters
- Custom codes: 4-20 alphanumeric characters, no reserved words
- Reserved paths: `api`, `admin`, `auth`, `static`, `health`, `metrics`

## Consistency and Idempotency

### Idempotency for URL Creation

Clients may retry URL creation after network failures. Without idempotency, retries create duplicate short URLs for the same long URL, wasting key pool resources.

**Approach:**
1. Generate a fingerprint: `hash(long_url + custom_code + user_id)`
2. Check Redis for `idempotency:{fingerprint}`
3. If exists: return cached response (no DB operation)
4. If not: process request, cache response with 24h TTL

This ensures the same long URL + user combination always returns the same short code, regardless of how many times the request is retried.

### Consistency Model

| Operation | Consistency | Mechanism |
|-----------|-------------|-----------|
| URL creation | Strong | PostgreSQL transaction + unique constraint on short_code |
| URL redirect | Strong read-your-writes | Cache populated on write (write-through) |
| Click analytics | Eventual (~5s delay) | Async via RabbitMQ, batch insert by worker |
| Key pool allocation | Strong | SELECT ... FOR UPDATE with server-level batching |

## Observability

### Metrics (Prometheus)

| Metric | Type | Purpose |
|--------|------|---------|
| `http_requests_total{method, endpoint, status}` | Counter | Request volume and error rate |
| `http_request_duration_seconds{method, endpoint}` | Histogram | Latency percentiles |
| `url_redirects_total{cached, status}` | Counter | Redirect volume, cache effectiveness |
| `cache_hits_total` / `cache_misses_total` | Counter | Cache hit ratio (target >90%) |
| `key_pool_available` | Gauge | Unused keys remaining (alert <1,000) |
| `rate_limit_hits_total{endpoint}` | Counter | Abuse detection |
| `circuit_breaker_state{service}` | Gauge | Dependency health (0=closed, 1=open) |
| `queue_messages_pending` | Gauge | RabbitMQ queue depth (alert >5,000) |

### SLI Targets

| SLI | Target | Alert Threshold |
|-----|--------|-----------------|
| Redirect p99 latency | < 50ms | > 100ms for 5m |
| API p99 latency | < 200ms | > 500ms for 5m |
| Error rate (5xx) | < 0.1% | > 1% for 5m |
| Cache hit ratio | > 90% | < 80% for 15m |
| Key pool available | > 1,000 | < 500 |

### Structured Logging (Pino)

JSON-formatted logs with consistent fields: `level`, `time`, `service`, `server_id`, `req_id`, `method`, `path`, `status`, `duration_ms`, `cache_hit`. Sensitive headers (cookies, authorization) are redacted.

## Failure Handling

### Retry Strategy

| Operation | Retries | Backoff | Idempotency |
|-----------|---------|---------|-------------|
| Cache read/write | 1 | None | Safe (idempotent) |
| DB write (URL create) | 0 | N/A | Use idempotency key |
| Queue publish | 3 | Exponential (100ms, 200ms, 400ms) | Message dedup by click_id |
| External URL validation | 2 | Linear (1s) | Safe (read-only) |

### Circuit Breakers

Applied to database and Redis connections. Configuration: timeout 5s, error threshold 50%, reset timeout 30s. When open, the system degrades gracefully:

| Failure | Degraded Behavior |
|---------|-------------------|
| Redis down | Read from DB directly, skip caching |
| RabbitMQ down | Log click synchronously to DB (slower but functional) |
| Key pool empty | Generate on-demand with DB function (slower but functional) |
| DB connection pool exhausted | Return 503, reject new requests |

### Graceful Shutdown

On SIGTERM/SIGINT: stop accepting new connections, drain in-flight requests, close RabbitMQ channel, close Redis connection, close PostgreSQL pool, then exit.

## Scalability Considerations

### Horizontal Scaling Path

**Phase 1: Multi-instance** — 3 API servers behind nginx load balancer (least connections). Shared PostgreSQL + Redis + RabbitMQ.

**Phase 2: Read replicas** — PostgreSQL primary + 2 read replicas. Route analytics queries (read-heavy) to replicas. Redis cluster for cache partitioning.

**Phase 3: Sharding** — Shard URLs by short_code prefix using consistent hashing. Separate analytics cluster (migrate click_events to ClickHouse for OLAP queries). CDN edge workers for sub-10ms redirect latency.

### What Breaks First

1. **Database writes** at ~5,000 RPS — mitigated by key pool pre-generation and async analytics
2. **Redis memory** at ~100M cached URLs — mitigated by TTL expiration and LRU eviction
3. **Analytics volume** at ~100,000 events/s — mitigated by batch inserts and eventual migration to ClickHouse

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Short code generation | Pre-generated pool | Counter + Base62 | No coordination, unpredictable codes |
| Redirect type | 302 Temporary | 301 Permanent | Accurate analytics at cost of higher load |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler server-side |
| Analytics processing | Async (RabbitMQ) | Synchronous DB insert | Decouples redirect latency from analytics |
| Analytics storage | PostgreSQL | ClickHouse | Simpler for current scale; migrate later |
| Cache invalidation | TTL-based (24h) | Event-driven | Simpler, acceptable staleness for URLs |
| Queue technology | RabbitMQ | Kafka | Easier operations, sufficient throughput |

## Frontend Architecture

### Component Hierarchy

```
__root.tsx (Header + Outlet + Footer)
├── / (HomePage)
│   └── UrlShortener
├── /login (LoginPage)
│   └── AuthForms
├── /dashboard (DashboardPage) [auth required]
│   ├── UrlShortener
│   └── UrlList
│       └── AnalyticsModal (per-URL click analytics)
└── /admin (AdminPage) [admin role required]
    └── AdminDashboard
        ├── StatsSection (system overview, top URLs)
        ├── UrlsSection (search, toggle active/inactive)
        ├── UsersSection (role management)
        └── KeyPoolSection (pool stats, repopulate)
```

The root layout (`__root.tsx`) renders a persistent `Header` with role-aware navigation (Home, Dashboard for users, Admin for admins) and a footer. All child routes render into the `<Outlet />` within this shared layout.

### TanStack Router Structure

The project uses TanStack Router's file-based routing with routes defined in `frontend/src/routes/`. The route tree is auto-generated into `routeTree.gen.ts`.

| Route File | Path | Purpose |
|------------|------|---------|
| `__root.tsx` | N/A | Root layout with Header, Outlet, Footer |
| `index.tsx` | `/` | Public landing page with URL shortener |
| `login.tsx` | `/login` | Login/register forms; redirects to `/dashboard` if already authenticated |
| `dashboard.tsx` | `/dashboard` | Authenticated user's URL management |
| `admin.tsx` | `/admin` | Admin dashboard; redirects non-admins to `/dashboard` |

Route guards are implemented imperatively: each protected route calls `checkAuth()` via `useEffect` and navigates away if the user is missing or lacks the required role. There is no centralized route middleware; each route handles its own auth check.

### Zustand Stores

**`authStore`** -- Manages user session state with `persist` middleware to survive page reloads. Stores the `user` object (id, email, role) in localStorage. Provides `login`, `register`, `logout`, and `checkAuth` actions. `checkAuth` calls `GET /api/v1/auth/me` to validate the server-side session cookie; if the session is expired or invalid, the user is cleared from the store.

**`urlStore`** -- Manages the authenticated user's URL list. Provides `createUrl`, `loadUrls`, and `deleteUrl` actions. On `createUrl`, the new URL is prepended to the local array immediately (optimistic local update) so the user sees the result without waiting for a full list reload. The `createdUrl` field holds the most recently created URL for the success display with copy-to-clipboard functionality.

### Data Fetching Pattern

All API calls are centralized in `frontend/src/services/api.ts` as a single `api` object organized by resource (`auth`, `urls`, `analytics`, `admin`). Each method wraps `fetch` with `credentials: 'include'` to send the httpOnly session cookie. A shared `handleResponse` function parses JSON and throws typed errors on non-2xx responses. There is no query caching library (no React Query or SWR) -- data is fetched imperatively via `useEffect` or Zustand actions and stored in component state or Zustand stores.

### Key UI Patterns

**Tabbed admin dashboard**: The `AdminDashboard` component uses a `useState`-driven tab system (`stats`, `urls`, `users`, `keys`). Each tab is a separate sub-component that fetches its own data on mount. Tabs are not lazy-loaded; switching tabs mounts and unmounts the sub-component, triggering fresh API calls.

**Analytics modal**: Clicking "Analytics" on any URL in `UrlList` opens a modal overlay that fetches `GET /api/v1/analytics/{shortCode}` on mount and displays clicks by day, top referrers, and device breakdown. The modal is rendered conditionally based on `selectedUrl` state.

**Optimistic delete with confirmation**: Delete actions in `UrlList` use a two-step flow -- clicking "Delete" shows "Confirm" and "Cancel" buttons. On confirmation, the URL is removed from the Zustand store immediately and the API call fires in the background. Errors are displayed if the API call fails, but the URL is not re-added (no rollback).

**Copy to clipboard**: Both `UrlShortener` (on creation) and `UrlList` provide clipboard copy for short URLs using `navigator.clipboard.writeText`.

## Deep Pattern Explanations

This section explains each production-grade pattern implemented in the backend, why it matters for a URL shortener, and how it works in practice.

### RBAC (Role-Based Access Control)

**What it is:** RBAC is a method of restricting system access based on roles assigned to users rather than checking individual permissions for each action. Each user has a role (in this system, either `user` or `admin`), and each API endpoint checks the caller's role before allowing the operation.

**Why Bitly needs it:** A URL shortener has two distinct user personas with fundamentally different access needs. Regular users should only manage their own URLs and view their own analytics. Admins need system-wide visibility: viewing all URLs, managing any user, monitoring the key pool, and deactivating malicious links. Without RBAC, either every user would have admin power (dangerous -- anyone could deactivate anyone's URLs) or no one would have admin power (no way to moderate abuse).

**How it works here:** The `users` table has a `role` column constrained to `('user', 'admin')`. The auth middleware (`backend/src/middleware/auth.ts`) reads the session cookie, looks up the user, and attaches the user object (including role) to `req.user`. Admin endpoints check `req.user.role === 'admin'` before proceeding. If the check fails, the server returns 403 Forbidden. The frontend mirrors this by conditionally rendering the "Admin" navigation link only when `user.role === 'admin'` in the auth store.

### Redis Cache-Aside

**What it is:** Cache-aside (also called lazy-loading) is a caching strategy where the application checks the cache first for each read request. On a cache hit, the cached value is returned immediately without touching the database. On a cache miss, the application queries the database, stores the result in the cache for future requests, and then returns it. The cache is not automatically synchronized with the database -- the application is responsible for keeping them consistent.

**Why Bitly needs it:** The redirect path (`GET /{short_code}`) is the hottest path in the entire system. At production scale, this endpoint handles 100,000+ requests per second with a 100:1 read-to-write ratio. Every redirect that hits PostgreSQL costs ~20ms; every redirect that hits Redis costs ~0.5ms. Cache-aside naturally adapts to the Zipf-distributed access pattern of URL shorteners -- a small percentage of URLs receive the vast majority of traffic. Those hot URLs stay in cache because they are accessed frequently, while cold URLs expire via TTL and do not consume cache memory.

**How it works here:** The `urlCache` object in `backend/src/utils/cache.ts` provides `get`, `set`, `delete`, and `exists` methods. On redirect, the server calls `urlCache.get(shortCode)`. If the result is non-null (cache hit), it redirects immediately. If null (cache miss), it queries PostgreSQL, calls `urlCache.set(shortCode, longUrl)` with a 24-hour TTL, and then redirects. On URL creation, `urlCache.set` is called immediately (write-through) so the first redirect never misses cache. On URL deactivation, `urlCache.delete` removes the stale entry. Every hit and miss increments a Prometheus counter (`cache_hits_total` / `cache_misses_total`) so operators can monitor the cache hit ratio and alert if it drops below 80%.

### Circuit Breaker

**What it is:** A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing dependency. It works like an electrical circuit breaker: when failures exceed a threshold, the circuit "opens" and all subsequent calls fail immediately without attempting the operation. After a cooldown period, the circuit enters a "half-open" state where a single test request is allowed through. If it succeeds, the circuit closes and normal operation resumes. If it fails, the circuit reopens.

**Why Bitly needs it:** The API server depends on PostgreSQL, Redis, and RabbitMQ. If PostgreSQL becomes slow (e.g., a long-running query is holding locks), continuing to send queries will exhaust the connection pool, causing all requests to hang -- not just database-dependent ones. The circuit breaker detects the slowdown (via timeout or error rate), stops sending queries to PostgreSQL, and returns errors immediately. This prevents cascading failure where one slow dependency brings down the entire service. It also gives the failing dependency time to recover without being hammered by retry storms.

**How it works here:** The `createCircuitBreaker` function in `backend/src/utils/circuitBreaker.ts` wraps async functions with the Opossum circuit breaker library. Configuration: 3-5 second timeout per operation, circuit opens when 50% of requests fail within a 10-second window, and resets after 30 seconds. There are separate configurations for database operations (5s timeout, higher volume threshold) and Redis operations (1s timeout, since cache should be fast). State changes are logged via Pino and exposed as a Prometheus gauge (`circuit_breaker_state`) with values 0 (closed/healthy), 0.5 (half-open/testing), and 1 (open/failing).

### Structured Logging

**What it is:** Structured logging means emitting log entries as machine-parseable JSON objects instead of free-form text strings. Each log entry has consistent fields (timestamp, level, service, message) plus context-specific fields that vary by event type. This enables log aggregation tools (ELK stack, Datadog, CloudWatch) to filter, search, and alert on specific fields rather than parsing unstructured text with regular expressions.

**Why Bitly needs it:** A URL shortener running multiple API server instances generates enormous log volume -- every redirect, every cache hit/miss, every rate limit event produces a log entry. At 100,000 redirects per second, searching through unstructured text logs ("redirect for abc123 took 2ms from IP 1.2.3.4") is impractical. Structured logging with fields like `{ "short_code": "abc123", "duration_ms": 2, "cache_hit": true }` enables operators to filter for slow redirects (`duration_ms > 50`), track specific short codes, or aggregate error rates by endpoint -- all without writing custom parsers.

**How it works here:** The `logger` in `backend/src/utils/logger.ts` uses Pino, a high-performance JSON logger for Node.js. Each log entry includes: `level`, `time` (epoch ms), `service` (server instance identifier), `req_id` (request correlation ID), `method`, `path`, `status`, `duration_ms`, and `cache_hit` (for redirect requests). Sensitive headers (cookies, authorization) are redacted from request logs. Child loggers are created per-request to carry the request ID through the entire call chain, enabling correlated log traces across cache, database, and queue operations.

### Prometheus Metrics

**What it is:** Prometheus is a time-series monitoring system that scrapes metrics from application endpoints at regular intervals. The application exposes a `/metrics` endpoint returning metric values in Prometheus text format. Prometheus stores these time series and enables querying, alerting, and dashboarding (typically via Grafana). Metrics come in three types: counters (monotonically increasing values like total requests), gauges (point-in-time values like active connections), and histograms (distributions like request latency percentiles).

**Why Bitly needs it:** A URL shortener must monitor several critical health signals that are invisible without instrumentation. Is the cache hit ratio above 90%? Is the key pool running low? Is the redirect p99 latency under 50ms? Are rate limit hits spiking (indicating abuse)? Is the analytics queue backing up? Without metrics, operators discover problems only when users complain. With metrics, they can set alerts and detect issues before they impact users. The metrics also enable capacity planning -- if redirects per second are growing 10% monthly, operators can plan infrastructure scaling.

**How it works here:** The `backend/src/utils/metrics.ts` file uses the `prom-client` library to define and register metrics. Key metrics: `http_requests_total` (counter, labeled by method/endpoint/status), `http_request_duration_seconds` (histogram for latency percentiles), `url_redirects_total` (counter, labeled by cache hit/miss), `cache_hits_total` / `cache_misses_total` (counters for cache ratio), `key_pool_available` (gauge for remaining keys), `rate_limit_hits_total` (counter for abuse detection), `circuit_breaker_state` (gauge per dependency), and `queue_messages_pending` (gauge for analytics queue depth). Express middleware records request duration automatically. The `/metrics` endpoint is scraped by Prometheus.

### Rate Limiting

**What it is:** Rate limiting restricts how many requests a client can make to an API within a time window. When a client exceeds the limit, the server responds with HTTP 429 (Too Many Requests) and a `Retry-After` header. Rate limits are typically tracked per IP address for unauthenticated endpoints and per user ID for authenticated endpoints, using atomic counters in Redis with TTL-based expiration.

**Why Bitly needs it:** Without rate limiting, a single malicious actor could exhaust the key pool by creating millions of URLs, overwhelm the analytics pipeline by scripting millions of fake clicks, or brute-force login credentials. URL shorteners are also attractive targets for abuse -- creating thousands of short URLs pointing to phishing sites. Rate limiting provides three defenses: it prevents resource exhaustion (key pool, database connections), it slows down brute-force attacks (5 attempts per minute on auth endpoints), and it ensures fair usage (no single user can monopolize URL creation capacity).

**How it works here:** Rate limiting is implemented in `backend/src/index.ts` using `express-rate-limit` with Redis as the backing store. Four rate limit tiers: URL creation (100 per hour per IP), redirects (1,000 per minute per IP), auth endpoints (5 per minute per IP), and authenticated API calls (200 per minute per user). Redis-based tracking uses atomic `INCR` with `EXPIRE` for sliding window counting. When a client hits the limit, the response includes `X-RateLimit-Remaining` and `Retry-After` headers. Rate limit hits are counted in the `rate_limit_hits_total` Prometheus metric for abuse pattern detection.

### Idempotency

**What it is:** Idempotency means that performing the same operation multiple times produces the same result as performing it once. For API endpoints, this means that if a client sends the same request twice (due to a network timeout, browser retry, or double-click), the server returns the same response without creating duplicate resources. The server achieves this by generating a fingerprint of each request, checking whether that fingerprint was already processed, and returning the cached response if so.

**Why Bitly needs it:** URL creation allocates a unique short code from the key pool. If a client submits a URL creation request, the network drops the response, and the client retries, the server would create two different short codes for the same long URL -- wasting key pool resources and confusing the user who now has two links for the same destination. At scale with millions of URL creations per day, even a 1% retry rate means 10,000 wasted keys daily. Idempotency ensures retries return the original short code without consuming additional keys.

**How it works here:** The `idempotencyMiddleware` in `backend/src/utils/idempotency.ts` intercepts POST requests to URL creation. It generates a SHA-256 fingerprint from `{ long_url, custom_code, user_id }` (or uses a client-provided `Idempotency-Key` header). It checks Redis for `idempotency:{fingerprint}`. If found, it returns the cached response immediately (incrementing `idempotency_hits_total` in Prometheus). If not found, it intercepts `res.json()` to cache the successful response in Redis with a 24-hour TTL. If Redis is down, the middleware degrades gracefully -- it logs the error and proceeds without idempotency protection rather than failing the request.

### Health Checks

**What it is:** Health check endpoints are HTTP endpoints that report whether the application and its dependencies are functioning correctly. They are consumed by load balancers (to route traffic away from unhealthy instances), container orchestrators (to restart failed containers), and monitoring systems (to trigger alerts). There are typically three tiers: liveness (is the process running?), readiness (can it serve traffic?), and deep (are all dependencies healthy?).

**Why Bitly needs it:** A URL shortener running behind a load balancer with multiple API server instances needs health checks to ensure traffic is only routed to healthy instances. If one instance loses its Redis connection, the load balancer should stop sending redirect traffic to it (since every redirect would miss cache and hit the database). If an instance's database connection pool is exhausted, it should be temporarily removed from rotation. Without health checks, the load balancer distributes traffic blindly, and users randomly experience errors depending on which instance their request hits.

**How it works here:** Three endpoints are implemented in `backend/src/index.ts`: `/health` returns 200 if the process is alive (liveness probe for Kubernetes). `/health/detailed` checks each dependency (PostgreSQL connectivity, Redis connectivity, key pool remaining count, RabbitMQ channel status) and returns a JSON report with per-dependency latency measurements and status. `/ready` returns 200 only if all critical dependencies (PostgreSQL and Redis) are reachable, making it suitable as a load balancer health check. If any critical dependency is unreachable, `/ready` returns 503 and the load balancer stops routing traffic to that instance.

## Implementation Notes

This section documents the actual local development setup and maps production design decisions to the working implementation.

### Local Architecture

```
┌─────────────────┐
│   Web Browser   │
│   (React app)   │
│   Port 5173     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  API Server     │
│  (Express.js)   │
│  Port 3001      │
│  (or 3002/3003) │
└────────┬────────┘
         │
    ┌────┼────────────────┐
    │    │                │
    ▼    ▼                ▼
┌──────┐ ┌──────────┐ ┌──────────┐
│Redis │ │PostgreSQL│ │ RabbitMQ │
│:6379 │ │  :5432   │ │  :5672   │
└──────┘ └──────────┘ └──────────┘
```

All infrastructure runs via Docker Compose. The frontend connects to a single API server (no load balancer by default). Multiple API instances can be run on ports 3001-3003 for distributed testing.

### Production Patterns Actually Implemented

| Pattern | File Path | Description |
|---------|-----------|-------------|
| Idempotency middleware | `backend/src/utils/idempotency.ts` | Redis-backed request fingerprinting prevents duplicate URL creation on retries |
| Circuit breakers (Opossum) | `backend/src/utils/circuitBreaker.ts` | Wraps database queries; fails fast when DB is unhealthy |
| Prometheus metrics (prom-client) | `backend/src/utils/metrics.ts` | Exposes `/metrics` endpoint with HTTP, cache, redirect, and key pool metrics |
| Structured logging (Pino) | `backend/src/utils/logger.ts` | JSON logs with service ID, request context, and redacted sensitive headers |
| Rate limiting | `backend/src/index.ts` | express-rate-limit with per-endpoint configuration |
| Health checks | `backend/src/index.ts` | `/health`, `/health/detailed`, `/ready` endpoints with dependency status |
| Pre-generated key pool | `backend/src/services/keyService.ts` | Local in-memory cache of keys fetched from DB in batches |
| Cache-aside with Redis | `backend/src/utils/cache.ts` | URL cache with 24h TTL, cache hit/miss metrics |
| Async analytics worker | `backend/src/workers/analytics-worker.ts` | Consumes click events from RabbitMQ, writes to PostgreSQL |
| Graceful shutdown | `backend/src/index.ts` | SIGTERM/SIGINT handlers close DB, Redis, and RabbitMQ connections |
| Security headers (Helmet) | `backend/src/index.ts` | Adds X-Content-Type-Options, X-Frame-Options, etc. |
| Session-based auth (bcrypt) | `backend/src/middleware/auth.ts` | Cookie-based sessions with Redis storage and DB fallback |

### What Was Simplified or Substituted

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| Redis Cluster | Single Valkey instance (Docker) | No cache partitioning; sufficient for dev scale |
| PostgreSQL primary + replicas | Single PostgreSQL instance (Docker) | No read replicas; all queries hit one instance |
| nginx load balancer | Direct connection to single API server | Can run manually with multiple servers on ports 3001-3003 |
| CDN for static assets | Vite dev server on port 5173 | No edge caching |
| Partitioned click_events table | Single unpartitioned table | No monthly partitioning |
| OAuth / social login | Email + password with bcrypt | Simpler auth flow |
| Kafka for high-throughput analytics | RabbitMQ | Sufficient for dev scale |

### What Was Omitted

- CDN / edge workers for redirect latency
- Multi-region deployment and global load balancing
- Kubernetes orchestration
- Database sharding by short_code prefix
- ClickHouse migration for analytics OLAP queries
- URL blacklist / malicious URL detection (Google Safe Browsing API)
- Bloom filter for non-existent short code detection
- Webhook notifications on click thresholds
- Bulk URL creation API
- Geographic distribution of API servers
