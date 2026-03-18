# Design Scalable API - Architecture

## System Overview

A high-performance API system designed to serve millions of users with low latency, high availability, and resilience. The system demonstrates horizontal scaling patterns, multi-level caching, distributed rate limiting, circuit breakers, and comprehensive observability -- the foundational infrastructure that every production API platform requires.

**Learning Goals:**
- Build horizontally scalable API services with stateless design
- Design effective multi-level caching strategies
- Implement distributed rate limiting and circuit breakers
- Create comprehensive observability with per-endpoint metrics

## Requirements

### Functional Requirements

1. **Serve**: Handle API requests efficiently with CRUD operations on resources
2. **Authenticate**: Verify user identity via session-based auth and API keys with tiered permissions
3. **Rate Limit**: Protect from abuse with per-key and per-IP sliding window limits
4. **Cache**: Reduce latency and database load with two-level caching (local + Redis)
5. **Monitor**: Track per-endpoint latency percentiles, error rates, cache hit ratios, and circuit breaker state

### Non-Functional Requirements (Production Scale)

- **Latency**: p99 < 100ms for cached responses, p99 < 500ms for uncached
- **Throughput**: 100K+ requests per second across the cluster
- **Availability**: 99.99% uptime with graceful degradation
- **Scalability**: Linear throughput scaling with additional API server instances

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Clients                                    │
│                (Web, Mobile, Third-party Apps)                        │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        CDN / Edge                                    │
│                (Static content, edge caching)                        │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       API Gateway                                    │
│        (TLS termination, rate limiting, auth, routing)                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Load Balancer                                   │
│       (Least connections, health checks, circuit breakers)           │
└──────┬──────────────────┬──────────────────┬────────────────────────┘
       │                  │                  │
       ▼                  ▼                  ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│ API Server  │   │ API Server  │   │ API Server  │
│ Instance 1  │   │ Instance 2  │   │ Instance N  │
│             │   │             │   │             │
│ Local Cache │   │ Local Cache │   │ Local Cache │
│ Compression │   │ Compression │   │ Compression │
│ Metrics     │   │ Metrics     │   │ Metrics     │
└──────┬──────┘   └──────┬──────┘   └──────┬──────┘
       │                 │                  │
       └─────────────────┼──────────────────┘
                         │
       ┌─────────────────┼─────────────────┐
       ▼                 ▼                 ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   Redis     │   │ PostgreSQL  │   │ Message     │
│   Cluster   │   │  Primary +  │   │ Queue       │
│ (Cache +    │   │  Replicas   │   │ (RabbitMQ)  │
│  Rate Limit │   │             │   │             │
│  + Sessions)│   │             │   │             │
└─────────────┘   └─────────────┘   └─────────────┘
```

Each API server instance is stateless -- all shared state lives in Redis (sessions, rate limit counters, cache) or PostgreSQL (persistent data). This allows horizontal scaling by simply adding instances behind the load balancer.

## Core Components

### API Gateway

The gateway is the single entry point for all client traffic. It handles:

- **TLS termination** -- Clients connect via HTTPS; internal traffic is plaintext for performance
- **Rate limiting** -- Sliding window algorithm using Redis sorted sets, with per-tier limits (anonymous: 100/min, free: 1K/min, pro: 10K/min, enterprise: 100K/min)
- **Authentication** -- Validates session cookies or API key hashes, attaches user context to requests
- **Request ID propagation** -- Generates or forwards `X-Request-ID` for distributed tracing

Rate limiting uses the sliding window algorithm because it provides smoother throttling than fixed windows. A fixed 100-requests-per-minute window allows all 100 requests in the first second, then blocks for 59 seconds. The sliding window spreads the budget evenly, preventing burst-then-starve patterns that cause poor client experience.

### Load Balancer

Uses **least connections** algorithm with per-server circuit breakers:

- **Least connections** distributes traffic to the server with the fewest active connections, naturally routing around slow servers. Round-robin would send equal traffic to a server that is struggling with a slow query, making it worse.
- **Health checks** run every 5 seconds against each server's `/health` endpoint. Servers that fail 3 consecutive checks are removed from the pool.
- **Circuit breakers** per backend server open after 3 failures with a 15-second reset timeout. This prevents the load balancer from sending traffic to a crashed server while it restarts.
- **Dynamic weight adjustment** based on health check latency -- servers with faster response times receive proportionally more traffic.

### API Server

Stateless Express.js servers that handle business logic:

- **Request pipeline**: Request ID -> Compression -> JSON parsing -> Rate limit check -> Auth -> Route handler -> Error handler -> Response logging
- **Two-level caching**: Local in-memory cache (5-second TTL) eliminates Redis round-trips for hot data. Redis cache (configurable TTL) is shared across all instances. Cache-aside pattern with `getOrFetch()` automatically populates cache on miss.
- **Connection pooling**: PostgreSQL pool with configurable max connections prevents connection exhaustion under load.

### Caching Strategy

```
┌────────────┐     ┌────────────┐     ┌────────────┐     ┌────────────┐
│   Client   │────▶│ API Server │────▶│   Redis    │────▶│ PostgreSQL │
│            │     │ Local Cache│     │   Cache    │     │  Database  │
│            │     │  (L1, 5s)  │     │ (L2, 5min) │     │  (source)  │
└────────────┘     └────────────┘     └────────────┘     └────────────┘
                     Hit: <1ms          Hit: 1-2ms         Miss: 10-50ms
```

The two-level approach reduces Redis round-trips by 80-90% for hot data. The 5-second L1 TTL is short enough to bound staleness while long enough to absorb burst traffic. The Redis L2 cache with longer TTLs (5-30 minutes depending on data type) serves as the shared cache across all API instances.

**Cache invalidation** uses pattern-based deletion: when a resource is updated, both `resources:detail:{id}` and `resources:list:*` keys are invalidated. This is simpler than event-driven invalidation and acceptable because cache misses gracefully fall through to the database.

### Circuit Breaker Pattern

Each downstream dependency (database, Redis, external services) is wrapped in its own circuit breaker with three states:

- **Closed** (normal): Requests pass through. Failures increment a counter.
- **Open** (protecting): After 5 failures, the circuit opens. All requests fail immediately (0ms latency vs 30-second timeout). This prevents thread/connection pool exhaustion.
- **Half-open** (testing): After 30 seconds, the circuit allows 3 test requests through. If all succeed, the circuit closes. If any fail, it reopens.

Per-dependency isolation is critical. If the payment service is down, the circuit breaker for payments opens, but user lookups and session management continue working. A single global circuit breaker would take down everything when one dependency fails.

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(64) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    tier VARCHAR(20) DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(64) NOT NULL,
    name VARCHAR(100),
    tier VARCHAR(20) DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'enterprise')),
    scopes TEXT[],
    rate_limit_override JSONB,
    last_used TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS request_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id VARCHAR(36) NOT NULL,
    api_key_id UUID REFERENCES api_keys(id),
    user_id UUID REFERENCES users(id),
    method VARCHAR(10) NOT NULL,
    path VARCHAR(500) NOT NULL,
    status_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    ip_address INET,
    user_agent TEXT,
    error_message TEXT,
    instance_id VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rate_limit_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier VARCHAR(200) NOT NULL,
    requests_per_minute INTEGER NOT NULL,
    burst_limit INTEGER,
    reason TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    content TEXT,
    metadata JSONB DEFAULT '{}',
    created_by UUID REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_metrics (
    id BIGSERIAL PRIMARY KEY,
    instance_id VARCHAR(50) NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    metric_value DOUBLE PRECISION NOT NULL,
    labels JSONB DEFAULT '{}',
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_expires ON api_keys(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_request_logs_time ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_api_key ON request_logs(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status_code, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_limit_identifier ON rate_limit_configs(identifier);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_created ON resources(created_at);
CREATE INDEX IF NOT EXISTS idx_metrics_instance ON system_metrics(instance_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_metrics_name ON system_metrics(metric_name, recorded_at);

-- Auto-update trigger for updated_at columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_resources_updated_at
    BEFORE UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

### Schema Design Rationale

**Users as central entity**: All authentication and authorization flows through the users table. The `tier` column enables tiered rate limiting without a separate configuration table -- simpler for the common case where API key tier matches user tier. The `role` column enables simple RBAC without a separate roles/permissions table.

**API keys with independent tier**: API keys can have different tiers than their owning user. A "pro" user might create a "free" API key for a less-trusted integration. The `scopes` array restricts what the key can access. Soft-delete via `revoked_at` preserves audit trail -- we never hard-delete keys.

**Request logs with denormalization**: Both `user_id` and `api_key_id` are stored despite the FK relationship between them. This denormalization enables fast analytics queries ("show me all requests from user X") without joins. The `instance_id` column enables debugging which server handled a request.

**JSONB for flexibility**: `rate_limit_override` allows custom rate limit shapes per key. `resources.metadata` allows extensible resource attributes. `system_metrics.labels` stores Prometheus-style dimensional labels.

### Request Logs Partitioning (Production Scale)

At production volume (millions of requests per day), the `request_logs` table should be range-partitioned by `created_at`:

```
request_logs (parent, partitioned by RANGE on created_at)
├── request_logs_2025_w01  (2025-01-01 to 2025-01-08)
├── request_logs_2025_w02  (2025-01-08 to 2025-01-15)
└── ...
```

Benefits: partition pruning makes time-range queries fast, dropping old partitions is O(1) instead of slow `DELETE` operations, and detaching partitions enables easy archival to object storage.

## API Design

### Authentication
```
POST /api/v1/auth/login     Login with email/password, returns session cookie
POST /api/v1/auth/logout    Destroy session
GET  /api/v1/auth/me        Get current authenticated user
```

### Resources (CRUD)
```
GET    /api/v1/resources          List resources with pagination and type filter
GET    /api/v1/resources/:id      Get resource by ID
POST   /api/v1/resources          Create resource (requires auth)
PUT    /api/v1/resources/:id      Update resource (owner or admin)
DELETE /api/v1/resources/:id      Delete resource (owner or admin)
```

### API Keys
```
GET    /api/v1/keys               List API keys for current user
POST   /api/v1/keys               Create new API key
DELETE /api/v1/keys/:id           Revoke API key (soft delete)
```

### Admin
```
GET  /api/v1/admin/users          List all users (admin only)
GET  /api/v1/admin/stats          System statistics and metrics
GET  /api/v1/admin/servers        Load balancer server pool status
POST /api/v1/admin/servers/:port/drain    Drain server for deployment
POST /api/v1/admin/servers/:port/enable   Re-enable server
```

### Observability
```
GET  /health                      Health check (DB + Redis connectivity)
GET  /ready                       Readiness probe for load balancer
GET  /metrics                     Prometheus-format metrics
GET  /api/v1/status               Service status with instance ID
```

## Key Design Decisions

### Stateless API Servers

All shared state lives in Redis or PostgreSQL, never in server memory (except the L1 cache with 5-second TTL). This means any API server can handle any request, enabling horizontal scaling by simply adding instances. The trade-off is that every state access requires a network round-trip to Redis or PostgreSQL, which the two-level cache mitigates for read-heavy workloads.

### Redis for Distributed Rate Limiting

Rate limiting must be consistent across all API server instances -- otherwise, a client could get N times their limit by hitting N different servers. Redis sorted sets implement the sliding window algorithm with atomic operations (`ZREMRANGEBYSCORE`, `ZADD`, `ZCARD` in a pipeline), ensuring correctness in a distributed environment.

The fail-open design means that if Redis is unreachable, rate limiting is skipped rather than blocking all traffic. This is a deliberate availability-over-consistency trade-off: a brief period without rate limiting is acceptable; blocking all API traffic because the rate limiter is down is not.

### Two-Level Caching vs Redis-Only

Adding an in-memory L1 cache in front of Redis seems like premature optimization, but at 100K+ requests per second, even Redis round-trips (1-2ms each) accumulate. The 5-second L1 TTL bounds staleness while absorbing 80-90% of Redis lookups for hot keys. The trade-off is that each API server has a slightly different view of the cache for up to 5 seconds, which is acceptable for read-heavy workloads where eventual consistency is fine.

### Session Auth with API Keys (Not JWT)

Sessions stored in Redis enable immediate revocation -- deleting the session key instantly logs the user out. JWTs require either short expiry (bad UX) or a revocation list (defeats the purpose of stateless JWTs). API keys provide programmatic access with the same revocation capability via the `revoked_at` soft-delete column.

## Consistency and Idempotency

- **Resource creation** is not idempotent by default. At production scale, an idempotency key header (`X-Idempotency-Key`) would be checked against a Redis set before processing, returning the cached response for duplicate requests.
- **API key revocation** is idempotent -- revoking an already-revoked key returns success.
- **Rate limit counters** use Redis sorted sets with atomic pipeline operations, ensuring correct counts even under concurrent access from multiple API servers.

## Observability

- **Per-endpoint metrics**: Track request count, duration histogram (p50/p90/p99), and error count for each `method:path` combination. This identifies which specific endpoints need optimization.
- **Cache metrics**: Hit/miss ratios for both L1 (local) and L2 (Redis) caches, enabling tuning of TTLs and cache sizing.
- **Circuit breaker metrics**: Current state, failure count, and rejection count per dependency. Alerts when a circuit opens.
- **Structured JSON logging** with Pino: Every log line includes `instanceId`, `requestId`, `userId`, `method`, `path`, `status`, and `duration` for filtering and correlation.

## Failure Handling

- **Circuit breakers** per dependency prevent cascade failures. When a downstream service fails, requests fail fast (0ms) instead of timing out (30s), preserving thread/connection pool capacity.
- **Graceful degradation**: When in degraded mode, expensive endpoints (`/search`, `/analytics`) return 503 while core CRUD continues working. Stale cached data is served with a `_stale: true` flag when the primary source is unavailable.
- **Fail-open rate limiting**: Redis unavailability skips rate checks rather than blocking traffic.
- **Connection pool limits**: PostgreSQL pool cap prevents connection exhaustion. Queue overflow returns 503 rather than crashing.
- **Graceful shutdown**: On SIGTERM, stop accepting new connections, drain in-flight requests (5-second timeout), then close database and Redis connections.

## Scalability Considerations

### What breaks first
1. **Single PostgreSQL instance** -- At ~10K writes/second, the single writer becomes the bottleneck. Solution: read replicas for queries, write sharding by tenant for multi-tenant deployments.
2. **Request logs table** -- Grows unboundedly and slows down analytics queries. Solution: time-based partitioning with automated archival to object storage.
3. **Redis memory** -- Rate limit sorted sets and cached responses compete for memory. Solution: separate Redis instances for cache (evictable) and rate limiting (non-evictable), or Redis Cluster.
4. **Single load balancer** -- Becomes a SPOF at very high throughput. Solution: DNS-based load balancing across multiple LB instances, or cloud provider ALB.

### Scaling path
- **Horizontal API scaling**: Add instances behind the load balancer. Stateless design means zero coordination needed.
- **Read replicas**: Route read-heavy endpoints to replicas, writes to primary.
- **Request log archival**: Daily job exports logs older than 7 days to compressed object storage, then drops the partition.
- **Cache tiering**: Increase Redis memory or add Redis Cluster nodes as cache working set grows.
- **Queue-based processing**: Move analytics and audit logging to async RabbitMQ workers to reduce request latency.

## Data Lifecycle and Retention

| Data Type | Hot Retention | Warm Retention | Archive/Delete |
|-----------|---------------|----------------|----------------|
| Request logs | 7 days in PostgreSQL | 30 days gzipped in object storage | Delete after 90 days |
| API keys | Indefinite (active) | N/A | Soft delete; hard delete after 1 year |
| Rate limit data | Redis TTL (1-5 min) | N/A | Auto-expires |
| Session tokens | Redis TTL (24 hours) | N/A | Auto-expires |
| System metrics | 24 hours in memory | 30 days in Prometheus | Delete after 30 days |

The 7-day hot retention covers most production debugging (issues are typically found within 48 hours). The 30-day warm tier in compressed object storage handles billing disputes and delayed customer complaints. The 90-day cold limit meets common compliance requirements (PCI-DSS, SOC2).

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Load balancing | Least connections | Round-robin | Routes around slow servers naturally |
| Rate limiting | Sliding window (Redis) | Fixed window | Smoother throttling, no burst-then-starve |
| Caching | Two-level (local + Redis) | Redis only | Eliminates 80-90% of Redis round-trips for hot data |
| Auth | Session + API keys | JWT | Immediate revocation, simpler key management |
| Degradation | Feature-flag based | All or nothing | Core CRUD survives when non-essential features fail |
| Request logs | Partitioned + archived | Single table | Enables fast queries and O(1) partition drops |

## Frontend Architecture

### Component Hierarchy

```
App.tsx (root)
├── Login                             ← Shown when no auth token
└── (authenticated)
    ├── Header                        ← Top bar with user info and logout
    └── Dashboard                     ← Main admin dashboard
        ├── StatCard (x4)             ← Uptime, heap used, cache hit rate, total requests
        ├── MetricsCard               ← System metrics (memory, counters, gauges)
        ├── RequestsCard              ← Per-endpoint request counts and latency percentiles
        ├── CircuitBreakersCard       ← Circuit breaker states with reset actions
        ├── CacheCard                 ← L1/L2 cache hit/miss stats
        ├── ActionsCard               ← Admin actions (clear cache, reset metrics, test external)
        └── LoadBalancerCard          ← Server pool status with drain/enable controls
```

### Zustand Stores

The frontend uses two Zustand stores:

**`useAuthStore`** (`stores/auth.ts`) manages authentication state with `persist` middleware that saves the session token to localStorage under the key `auth-storage`. It stores a `token` string, a `User` object, and loading/error state. The `login` action calls `api.login()`, stores the returned token and user, and persists the token across page refreshes. The `checkAuth` action uses the stored token to call `api.getMe()` on mount, validating the session is still alive. If validation fails, it clears both token and user, causing the app to re-render with the Login component. The `partialize` option ensures only the `token` is persisted (not the full user object), so the user is always re-validated from the server on load.

**`useDashboardStore`** (`stores/dashboard.ts`) manages dashboard metrics with auto-refresh. It stores the full `DashboardData` response (metrics, circuit breakers, cache stats), load balancer status, timestamps, and refresh configuration. The `fetchDashboard` action reads the token from `useAuthStore.getState()` (cross-store access) and calls the admin dashboard API. The store supports configurable auto-refresh via `autoRefresh` (boolean toggle) and `refreshInterval` (default 5 seconds), controlled by the Dashboard component via `setInterval`. The `fetchLbStatus` action fetches load balancer pool status from a separate endpoint (`/lb/status`).

### Routing

This project uses a simple conditional rendering approach rather than TanStack Router. The `App` component checks `useAuthStore.token`: if null, it renders the `Login` component; if present, it renders the `Header` and `Dashboard`. There is no URL-based routing because the application has only two views (login and dashboard). On mount, `App` calls `checkAuth()` and shows a loading spinner until the session check completes.

### Data Fetching

All API communication flows through a singleton `ApiClient` class in `services/api.ts`. The client wraps `fetch()` with token-based `Authorization: Bearer` headers, JSON content type, and error handling. It exposes methods for auth (`login`, `logout`, `getMe`), admin operations (`getDashboard`, `getCircuitBreakers`, `resetCircuitBreaker`, `getMetrics`, `resetMetrics`, `getCacheStats`, `clearCache`), resource CRUD (`getResources`), and external service testing (`callExternalService`). The gateway URL base is `/api/v1`, and all requests pass through the API gateway on port 8080 (proxied by Vite in development). The Dashboard component triggers a fetch on mount and optionally re-fetches on a configurable interval.

### Key UI Patterns

**Auto-refreshing dashboard**: The `Dashboard` component uses `setInterval` tied to `useDashboardStore.autoRefresh` and `refreshInterval` to poll the admin stats endpoint every 5 seconds. A checkbox toggle lets users pause auto-refresh during debugging. The `lastUpdated` timestamp shows when data was last fetched.

**Stat cards with icons**: The dashboard displays four top-level `StatCard` components (uptime, heap usage, cache hit rate, total requests) using SVG path data mapped from icon names. Each card shows a title, primary value, optional subtitle, and colored icon.

**Circuit breaker visualization**: The `CircuitBreakersCard` displays each circuit breaker's name, current state (closed/open/half-open), failure count, and call statistics. Admin users can reset individual breakers.

**Admin actions panel**: The `ActionsCard` provides one-click buttons for operational tasks: clearing the Redis cache, resetting metrics counters, and triggering a test call to an external service (to demonstrate circuit breaker behavior).

**Load balancer status**: The `LoadBalancerCard` shows the server pool with per-server health, active connections, and drain/enable controls for deployment workflows.

## Deep Pattern Explanations

This section explains the production-grade patterns used in this project from first principles. Each pattern solves a specific operational problem that emerges at scale.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents a failing downstream service from dragging down the entire application. The name comes from electrical circuit breakers that trip to prevent a short circuit from causing a fire.

The pattern works through three states. In the **closed** state (normal operation), all requests pass through to the downstream service. The circuit breaker silently tracks the success/failure ratio of recent calls. When the failure count crosses a threshold (configured at 5 failures in this project), the breaker transitions to the **open** state. In the open state, all requests fail immediately with a pre-defined error -- the application does not even attempt to call the downstream service. This is the key benefit: instead of every request waiting 30 seconds for a timeout against a dead service (which exhausts connection pools and causes cascading failures), requests fail in 0 milliseconds. After a 30-second timeout, the breaker enters the **half-open** state, allowing 3 test requests through. If those succeed, the breaker closes and normal traffic resumes. If they fail, the breaker reopens.

This project implements per-dependency circuit breakers, meaning the database, Redis, and external services each have their own independent breaker. If Redis goes down, only cache operations fail fast -- database queries and API responses continue working normally. A single global circuit breaker would be catastrophic because one failing dependency would shut down all functionality.

**File**: `shared/services/circuit-breaker.ts`

### Redis Cache-Aside (Two-Level)

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. On a cache hit, the cached value is returned immediately. On a cache miss, the application queries the database, stores the result in the cache with a time-to-live (TTL), and returns it to the caller.

This project extends the basic pattern with two cache levels. **L1 (local in-memory cache)** lives inside each API server process with a 5-second TTL. **L2 (Redis)** is shared across all API server instances with configurable TTLs (5-30 minutes depending on data type). When a request arrives, the server checks L1 first (sub-millisecond, no network hop). On L1 miss, it checks L2 Redis (1-2ms network round-trip). On L2 miss, it queries PostgreSQL (10-50ms), stores the result in both L2 and L1, and returns it.

The `getOrFetch()` helper method encapsulates this pattern: it takes a cache key and a fetcher function, checks both cache levels, and automatically populates caches on miss. Cache invalidation uses pattern-based deletion -- when a resource is updated, both `resources:detail:{id}` and `resources:list:*` keys are deleted from Redis, and L1 caches across all instances expire naturally within 5 seconds.

The two-level approach reduces Redis round-trips by 80-90% for hot data. The 5-second L1 TTL is short enough that staleness is bounded (at most 5 seconds of stale data), while long enough to absorb burst traffic where the same key is requested hundreds of times per second. The trade-off is that each API server instance has a slightly different view of the cache for up to 5 seconds.

**File**: `shared/services/cache.ts`

### Structured Logging

Structured logging means writing log entries as machine-parseable data (typically JSON) rather than free-form text strings. Traditional logs look like `"User 123 logged in from 192.168.1.1"` -- a human can read this, but extracting the user ID or IP address programmatically requires fragile regex parsing. Structured logs look like `{"event":"login","userId":"123","ip":"192.168.1.1","timestamp":"2025-01-01T00:00:00Z"}` -- every field is a named key-value pair that log aggregation tools (Elasticsearch, Datadog, CloudWatch) can index, search, and alert on.

This project uses Pino, a high-performance Node.js logging library that outputs JSON in production and pretty-printed text in development. Each log line includes `instanceId` (which API server handled the request), `requestId` (for correlating logs across services), `userId`, `method`, `path`, `status`, and `duration`. The `instanceId` field is critical in this project because three API server instances run behind a load balancer -- when debugging a slow request, you need to know which instance served it.

**File**: `shared/services/logger.ts`

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical measurements (metrics) from applications at regular intervals. The application exposes an HTTP endpoint (`/metrics`) that returns current metric values in a specific text format. A Prometheus server scrapes this endpoint every 15-30 seconds and stores the data, enabling dashboards (Grafana) and alerting rules.

There are four main metric types. **Counters** only go up (total requests served, total errors). **Gauges** go up and down (current memory usage, active connections). **Histograms** track the distribution of values (request duration buckets, so you can compute p50/p90/p99 latencies). **Summaries** are similar to histograms but compute quantiles on the client side.

This project tracks per-endpoint metrics: request count, duration histograms (with p50/p90/p99 computation), and error counts, all labeled by `method:path`. It also tracks cache-specific metrics: L1 hits, L2 (Redis) hits, and cache misses, enabling tuning of TTLs based on actual hit ratios. Circuit breaker state changes are also tracked, allowing alerts when a breaker opens. The admin dashboard in the frontend renders these metrics in a human-readable format, but at production scale they would feed into Grafana dashboards with alerting rules.

**File**: `shared/services/metrics.ts`

### Rate Limiting (Sliding Window)

Rate limiting restricts how many requests a client can make within a time window, protecting the server from abuse, accidental loops, and denial-of-service attacks. Without rate limiting, a single misbehaving client could consume all server resources and deny service to legitimate users.

This project implements a **sliding window** algorithm using Redis sorted sets. Each rate limit entry is a sorted set where the score is the request timestamp. When a request arrives: (1) remove all entries older than the window size (`ZREMRANGEBYSCORE`), (2) count remaining entries (`ZCARD`), (3) if under the limit, add the current timestamp (`ZADD`). These three operations execute as an atomic Redis pipeline, ensuring correctness even when multiple API server instances check the same key concurrently.

The sliding window is superior to fixed windows for user experience. A fixed 100-requests-per-minute window allows all 100 requests in the first second, then blocks for 59 seconds -- a burst-then-starve pattern that frustrates API consumers. The sliding window spreads the budget evenly across time.

Rate limits are tiered by user subscription level: anonymous (100/min), free (1K/min), pro (10K/min), enterprise (100K/min). The API key's tier determines which limit applies. Critically, the rate limiter uses a **fail-open** design: if Redis is unreachable, rate limiting is skipped rather than blocking all traffic. A brief period without rate limiting is acceptable; blocking all API traffic because the rate limiter is down is not.

**File**: `shared/services/rate-limiter.ts`

### Health Checks

A health check is an HTTP endpoint that reports whether the application is functioning correctly. Load balancers, container orchestrators (Kubernetes), and monitoring systems call this endpoint periodically to determine if an instance should receive traffic.

This project implements two health check variants. The `/health` endpoint verifies both database (PostgreSQL) and cache (Redis) connectivity by running simple test queries. If both succeed, it returns `200 OK`; if either fails, it returns `503 Service Unavailable` with details about which dependency is down. The `/ready` endpoint is a readiness probe -- it confirms the application is fully initialized and all dependencies are connected, making it safe for the load balancer to route traffic. The load balancer in this project runs health checks every 5 seconds against each API server instance and removes servers that fail 3 consecutive checks from the pool.

At production scale, health checks typically distinguish between **liveness** (is the process running and not deadlocked?) and **readiness** (can the process serve traffic?). A failing liveness check restarts the container. A failing readiness check removes the instance from the load balancer pool without restarting it -- useful during startup when the database connection pool is warming up.

**Files**: `gateway/src/index.ts`, `load-balancer/src/index.ts`

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. This is critical in distributed systems where network failures cause retries: if a client sends a `POST /resources` request and the network drops the response (but the server processed it), the client will retry, potentially creating a duplicate resource.

The solution is an idempotency key. The client includes a unique `X-Idempotency-Key` header with each request. The server checks this key against a Redis cache before processing. If the key exists, the server returns the cached response from the first execution without re-processing. If the key does not exist, the server processes the request, caches the response (with a 24-hour TTL), and returns it. This guarantees exactly-once semantics from the client's perspective, even with multiple retries.

In this project, API key revocation is inherently idempotent (revoking an already-revoked key returns success), but resource creation is not idempotent by default. At production scale, the idempotency key mechanism would be implemented as middleware that intercepts all state-changing requests.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of granting individual permissions to each user (which becomes unmanageable with thousands of users), you define roles like "user" and "admin" and assign a set of permissions to each role.

In this project, the `users` table has a `role` column with values `'user'` or `'admin'` (enforced by a CHECK constraint). Regular users can access resource CRUD endpoints and their own API keys. Admin users can additionally access system statistics (`/admin/stats`), server pool management (`/admin/servers`), and server drain/enable controls. The API key system adds another authorization dimension: each key has a `scopes` array that restricts which endpoints the key can access, and a `tier` that determines rate limits.

The key advantage of RBAC over direct permission assignment is scalability of administration: when a new endpoint is added, you update the role's permission set once rather than granting access to every individual user. The trade-off is that roles can become too coarse-grained, leading to either over-privileged users (admin role has access to everything) or role explosion (creating dozens of fine-grained roles).

## Implementation Notes

### Local Setup Diagram

```
┌───────────────────┐
│  React Frontend   │
│  (Vite :5173)     │
│                   │
│  Admin Dashboard  │
│  Zustand stores   │
│  TanStack Router  │
└────────┬──────────┘
         │
         ▼
┌────────────────────┐
│  API Gateway       │
│  (Express :8080)   │
│  Rate limiting     │
│  Auth middleware    │
│  Request logging   │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐     ┌────────────┐  ┌────────────┐  ┌────────────┐
│  Load Balancer     │────▶│ API Server │  │ API Server │  │ API Server │
│  (Express :3000)   │     │   :3001    │  │   :3002    │  │   :3003    │
│  Least connections │     │  (api-1)   │  │  (api-2)   │  │  (api-3)   │
│  Health checks     │     │  L1 Cache  │  │  L1 Cache  │  │  L1 Cache  │
│  Circuit breakers  │     │  Metrics   │  │  Metrics   │  │  Metrics   │
└────────────────────┘     └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
                                 │               │               │
                                 └───────────────┼───────────────┘
                                                 │
                                 ┌───────────────┼───────────────┐
                                 ▼                               ▼
                          ┌─────────────┐                 ┌─────────────┐
                          │ PostgreSQL  │                 │    Redis    │
                          │   :5432     │                 │   :6379     │
                          │ scalable_api│                 │ (cache +    │
                          │  (6 tables) │                 │  rate limit │
                          └─────────────┘                 │  + sessions)│
                                                          └─────────────┘
```

Five backend processes run simultaneously via `concurrently`: the gateway (:8080), the load balancer (:3000), and three API server instances (:3001, :3002, :3003). This simulates a real distributed deployment on a single machine.

### Production-Grade Patterns Implemented

| Pattern | File Path | Purpose |
|---------|-----------|---------|
| Two-level cache | `shared/services/cache.ts` | Local L1 (5s TTL) + Redis L2 with cache-aside `getOrFetch()` |
| Sliding window rate limiter | `shared/services/rate-limiter.ts` | Redis sorted sets for distributed, per-tier rate limiting |
| Circuit breaker | `shared/services/circuit-breaker.ts` | Per-dependency failure isolation with closed/open/half-open states |
| Structured logging | `shared/services/logger.ts` | Pino JSON logs with request ID, instance ID, user ID correlation |
| Per-endpoint metrics | `shared/services/metrics.ts` | Latency percentiles, request counts, cache hit ratios |
| Health checks | `gateway/src/index.ts`, `load-balancer/src/index.ts` | `/health` and `/ready` endpoints verifying DB + Redis connectivity |
| Request ID propagation | `shared/middleware/common.ts` | `X-Request-ID` header generation and forwarding across services |
| Data retention | `shared/services/retention.ts` | Configurable hot/warm/cold lifecycle for request logs |
| Load balancing | `load-balancer/src/index.ts` | Least-connections with per-server circuit breakers and dynamic weights |
| Gzip compression | `gateway/src/index.ts` | Response compression for bandwidth reduction |

### What Was Simplified

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| NGINX/HAProxy load balancer | Custom Express load balancer | Fewer features, lower throughput ceiling |
| Redis Cluster | Single Redis instance | No HA, single point of failure |
| PostgreSQL primary + replicas | Single PostgreSQL instance | No read/write split |
| Prometheus + Grafana dashboards | In-memory metrics with `/metrics` endpoint | No persistent metric storage or alerting |
| API key auth with SHA-256 | Session auth with SHA-256 passwords | Simpler, no API key generation UI |
| Distributed tracing (Jaeger/Zipkin) | Request ID propagation only | No trace visualization or span analysis |
| Automated partition management | Manual schema.sql | No auto-creation/dropping of partitions |

### What Was Omitted

- CDN and edge caching
- TLS/HTTPS termination (plaintext HTTP locally)
- Multi-region deployment
- Kubernetes orchestration with liveness/readiness probes
- Distributed tracing backend (Jaeger/Zipkin)
- Alerting rules and PagerDuty/Slack integration
- Automated canary and blue-green deployments
- Log aggregation (Elasticsearch/Loki)
- RabbitMQ async processing (dependency in package.json but not fully wired)
- Load testing scripts (k6/Artillery)
