# Scalable API - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

---

## 1. Problem Statement (2 minutes)

"Design a scalable API platform with an admin dashboard, implementing rate limiting, caching, and real-time monitoring across both frontend and backend."

This is a **full-stack problem** requiring expertise in:
- End-to-end request flow through multiple layers
- API design with proper error handling and headers
- Real-time data synchronization between server and UI
- Session management and authentication
- Graceful degradation across the stack

---

## 2. Requirements Clarification (3 minutes)

### Functional Requirements
- API key management (create, revoke, view usage)
- Tiered rate limiting with usage tracking
- Real-time metrics dashboard
- Request logging and analytics
- Health monitoring for all services

### Non-Functional Requirements
- **Latency**: P99 < 100ms for cached API responses
- **Throughput**: 100K+ requests per minute
- **Availability**: 99.9% uptime
- **Dashboard Refresh**: Metrics update every 5 seconds

### Full-Stack Clarifications
- "Authentication flow?" - API keys for public API, sessions for admin dashboard
- "How does rate limit state reach the UI?" - Headers on API responses, polling for dashboard
- "Error handling?" - Consistent error format, appropriate HTTP status codes
- "Caching coordination?" - Backend cache with frontend stale-while-revalidate

---

## 3. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           ADMIN DASHBOARD                                │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  Metrics Overview  │  Server Health  │  API Keys  │  Request Logs  ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                   │                                      │
│                          Polling (5s) / REST                             │
└───────────────────────────────────┼─────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│                            API GATEWAY                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  Auth/Keys  │  │ Rate Limit  │  │   Routing   │  │   Logging   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼─────────────────────────────────────┐
│                          LOAD BALANCER                                   │
│                    (Least Connections + Health Checks)                   │
└───────────────────────────────────┬─────────────────────────────────────┘
                     ┌──────────────┼──────────────┐
                     │              │              │
              ┌──────▼──────┐┌──────▼──────┐┌──────▼──────┐
              │  API-1      ││  API-2      ││  API-3      │
              │  :3001      ││  :3002      ││  :3003      │
              └──────┬──────┘└──────┬──────┘└──────┬──────┘
                     │              │              │
              ┌──────┴──────────────┴──────────────┘
              │
    ┌─────────▼─────────┐  ┌─────────────────┐  ┌─────────────────┐
    │   L1 + L2 Cache   │  │   PostgreSQL    │  │     Redis       │
    │   (Two-Level)     │  │   (Primary)     │  │  (Rate Limits)  │
    └───────────────────┘  └─────────────────┘  └─────────────────┘
```

### Request Flow Layers

| Layer | Responsibility | Technology |
|-------|---------------|------------|
| Dashboard | Metrics visualization, key management | React + Zustand |
| Gateway | Authentication, rate limiting | Express middleware |
| Load Balancer | Traffic distribution, health checks | NGINX / Node.js |
| API Servers | Business logic, caching | Express + Two-level cache |
| Data Stores | Persistence, rate limit state | PostgreSQL + Redis |

---

## 4. Deep Dives (25 minutes)

### Deep Dive 1: End-to-End API Request Flow (8 minutes)

**Sequence**: Complete request from client to response with all middleware.

```
Client                Gateway              LB              API Server           Redis          PostgreSQL
  │                      │                  │                    │                │                 │
  │  GET /api/v1/users   │                  │                    │                │                 │
  │  X-API-Key: sk_...   │                  │                    │                │                 │
  │─────────────────────▶│                  │                    │                │                 │
  │                      │                  │                    │                │                 │
  │                      │ Validate API Key │                    │                │                 │
  │                      │──────────────────────────────────────────────────────▶│                 │
  │                      │                  │                    │                │                 │
  │                      │◀─────────────────────────────────────────────key data─│                 │
  │                      │                  │                    │                │                 │
  │                      │ Check Rate Limit │                    │                │                 │
  │                      │─────────────────────────────────────▶│                │                 │
  │                      │                  │                    │                │                 │
  │                      │◀────────────────────────────allowed──│                │                 │
  │                      │                  │                    │                │                 │
  │                      │ Forward Request  │                    │                │                 │
  │                      │─────────────────▶│                    │                │                 │
  │                      │                  │                    │                │                 │
  │                      │                  │ Select Server      │                │                 │
  │                      │                  │───────────────────▶│                │                 │
  │                      │                  │                    │                │                 │
  │                      │                  │                    │ Check L1 Cache │                 │
  │                      │                  │                    │ (miss)         │                 │
  │                      │                  │                    │                │                 │
  │                      │                  │                    │ Check L2 Cache │                 │
  │                      │                  │                    │───────────────▶│                 │
  │                      │                  │                    │                │                 │
  │                      │                  │                    │◀──────(miss)───│                 │
  │                      │                  │                    │                │                 │
  │                      │                  │                    │ Query Database │                 │
  │                      │                  │                    │───────────────────────────────▶│
  │                      │                  │                    │                │                 │
  │                      │                  │                    │◀────────────────────────data────│
  │                      │                  │                    │                │                 │
  │                      │                  │                    │ Set L1 + L2    │                 │
  │                      │                  │                    │───────────────▶│                 │
  │                      │                  │                    │                │                 │
  │                      │                  │◀──────────────────│                │                 │
  │                      │                  │                    │                │                 │
  │                      │◀─────────────────│                    │                │                 │
  │                      │                  │                    │                │                 │
  │◀─────────────────────│                  │                    │                │                 │
  │  200 OK              │                  │                    │                │                 │
  │  X-RateLimit-Remaining: 950            │                    │                │                 │
  │  X-Cache: MISS       │                  │                    │                │                 │
```

### Gateway Middleware Chain

"I designed the middleware chain with careful ordering - request ID first for tracing, then logging, then auth, then rate limiting. This ensures every request is traceable even if it fails authentication."

**Middleware order (critical):**
1. requestIdMiddleware - Assign unique request ID
2. loggingMiddleware - Log request start
3. apiKeyAuthMiddleware - Validate API key
4. rateLimitMiddleware - Check rate limits
5. proxyMiddleware - Forward to load balancer
6. errorHandler - Catch and format errors (must be last)

### API Key Authentication

**Flow:**
1. Extract X-API-Key header
2. Return 401 if missing
3. Check cache first (1-hour TTL), then database
4. Validate key is active
5. Attach keyData to request for downstream use

### Rate Limiting with Headers

"I always set rate limit headers regardless of whether the request is allowed. This gives clients visibility into their quota before they hit limits."

**Response headers (always set):**
- X-RateLimit-Limit: Total requests allowed
- X-RateLimit-Remaining: Requests left in window
- X-RateLimit-Reset: Unix timestamp when window resets

**On 429 (rate limited):**
- Retry-After header with seconds until reset
- Error body with retryAfter field

---

### Deep Dive 2: API Contract and Error Handling (6 minutes)

### Consistent API Response Format

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         APIResponse<T>                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │ data?: T                    │ Response payload (success only)       │ │
│  ├────────────────────────────────────────────────────────────────────┤ │
│  │ error?: {                   │ Error details (error only)            │ │
│  │   message: string           │   Human-readable message              │ │
│  │   code: string              │   Machine-readable code               │ │
│  │   details?: Record<...>     │   Field-level validation errors       │ │
│  │ }                           │                                       │ │
│  ├────────────────────────────────────────────────────────────────────┤ │
│  │ meta?: {                    │ Request metadata (always present)     │ │
│  │   requestId: string         │   For tracing/debugging               │ │
│  │   timestamp: string         │   ISO 8601 response time              │ │
│  │   pagination?: {            │   For paginated responses             │ │
│  │     page, limit, total,     │                                       │ │
│  │     hasMore                 │                                       │ │
│  │   }                         │                                       │ │
│  │ }                           │                                       │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Frontend API Client

"I designed the API client to automatically extract rate limit headers and update the UI store. This way, any component can display current quota without extra API calls."

**Key features:**
- Automatic rate limit header extraction on every response
- Updates Zustand store for UI display
- Custom APIError class with helper methods (isRateLimited, isUnauthorized, isServerError)
- Typed methods for common operations (getMetrics, createAPIKey, revokeAPIKey)

### Error Handling Strategy

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Error Handling Flow                                │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│   API Response                                                            │
│        │                                                                  │
│        ▼                                                                  │
│   ┌────────────────┐                                                      │
│   │ response.ok?   │                                                      │
│   └───────┬────────┘                                                      │
│           │                                                               │
│     ┌─────┴─────┐                                                         │
│     ▼           ▼                                                         │
│   [Yes]       [No]                                                        │
│     │           │                                                         │
│     │           ▼                                                         │
│     │    ┌──────────────────────────────────────┐                         │
│     │    │ throw APIError(message, code, status)│                         │
│     │    └───────────────┬──────────────────────┘                         │
│     │                    │                                                │
│     │                    ▼                                                │
│     │    ┌──────────────────────────────────────┐                         │
│     │    │ ErrorBoundary catches                │                         │
│     │    └───────────────┬──────────────────────┘                         │
│     │                    │                                                │
│     │         ┌──────────┼──────────┐                                     │
│     │         ▼          ▼          ▼                                     │
│     │    [429]       [401]      [500+]                                    │
│     │       │           │          │                                      │
│     │       ▼           ▼          ▼                                      │
│     │  RateLimit    Redirect   Generic                                    │
│     │  Countdown    to Login   Error UI                                   │
│     │                                                                     │
│     ▼                                                                     │
│  Return data                                                              │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

### Deep Dive 3: Admin Session Management (6 minutes)

**Challenge**: Secure admin access with session management, separate from API key authentication.

### Backend Session Setup

**Configuration:**
- Store: RedisStore with prefix 'session:'
- Cookie name: 'admin_session'
- maxAge: 24 hours
- httpOnly: true, secure in production, sameSite: 'lax'

### Admin Route Protection

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Admin Auth Middleware Chain                          │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Request to /api/v1/admin/*                                               │
│            │                                                              │
│            ▼                                                              │
│  ┌─────────────────────┐                                                  │
│  │ sessionMiddleware   │  Parse session cookie, load from Redis           │
│  └──────────┬──────────┘                                                  │
│             │                                                             │
│             ▼                                                             │
│  ┌─────────────────────┐     No                                           │
│  │ req.session.userId? │──────────▶ 401 AUTH_REQUIRED                     │
│  └──────────┬──────────┘                                                  │
│             │ Yes                                                         │
│             ▼                                                             │
│  ┌─────────────────────┐     No                                           │
│  │ role === 'admin'?   │──────────▶ 403 FORBIDDEN                         │
│  └──────────┬──────────┘                                                  │
│             │ Yes                                                         │
│             ▼                                                             │
│  ┌─────────────────────┐                                                  │
│  │     next()          │  Continue to route handler                       │
│  └─────────────────────┘                                                  │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Frontend Auth Store (Zustand)

**State:**
- user: AdminUser | null
- isLoading: boolean
- error: string | null

**Actions:**
- login(email, password): POST to /admin/login, set user on success
- logout(): POST to /admin/logout, clear user
- checkSession(): GET /admin/me on app startup

### Protected Route Component

**Behavior:**
1. On mount, call checkSession()
2. While loading, show LoadingSpinner
3. If no user after load, redirect to /login
4. If authenticated, render children

---

### Deep Dive 4: Real-Time Metrics Synchronization (5 minutes)

**Challenge**: Keep dashboard metrics current while minimizing server load.

### Backend Metrics Aggregation

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Metrics Collection Flow                              │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  GET /api/v1/admin/metrics/current                                        │
│            │                                                              │
│            ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ Promise.all([                                                        │ │
│  │   getRequestMetrics(),    ◀── Redis counters + latency samples      │ │
│  │   getCacheMetrics(),      ◀── L1/L2 hit rates                       │ │
│  │   getRateLimitMetrics(),  ◀── Blocked requests, top offenders       │ │
│  │   getServerHealth()       ◀── Health check results per server       │ │
│  │ ])                                                                   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│            │                                                              │
│            ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ Response: {                                                          │ │
│  │   requests: { perSecond, total24h, errorRate }                       │ │
│  │   latency: { p50, p95, p99 }                                         │ │
│  │   cache: { hitRate, l1Hits, l2Hits, misses }                         │ │
│  │   rateLimit: { blocked24h, topBlockedKeys }                          │ │
│  │   servers: [ { id, status, latency, load } ]                         │ │
│  │ }                                                                    │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Latency Percentile Calculation

**Using Redis sorted samples:**
1. Store last 100 latency samples in Redis list
2. Sort samples in memory
3. Calculate p50 (50th percentile), p95, p99 from sorted array

### Frontend Polling with Stale State Handling

"I implemented a polling hook that marks data as stale after 3 consecutive failures. This lets users know when the dashboard data might be outdated while still showing the last known values."

**useMetricsPolling behavior:**
- Poll at configurable interval (default 5 seconds)
- Track last successful fetch timestamp
- Mark data as stale after intervalMs * 3 without success
- Display warning banner when stale

### Stale Data UI Pattern

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Dashboard State Handling                           │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  isStale: true                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ ⚠️ Data may be outdated. Last update: 2 minutes ago                  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  error && !isStale                                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ ❌ Failed to fetch metrics: Connection refused                       │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │                     Metrics Cards (dimmed if stale)                  │ │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────┐   │ │
│  │  │  RPS: 1,234 │ │ P99: 45ms   │ │ Cache: 94%  │ │ Errors: 0.1% │   │ │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └──────────────┘   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Rate Limit Display Integration (3 minutes)

### Zustand Store for Rate Limits

**State:**
- limit: number
- remaining: number
- resetAt: number (Unix timestamp)
- update(info): Action to update from headers

### Rate Limit Indicator Component

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     Rate Limit Visual Indicator                           │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  percentage = (remaining / limit) * 100                                   │
│                                                                           │
│  > 50%  ──▶  ████████████████████░░░░░░░░░░  GREEN                       │
│                                                                           │
│  20-50% ──▶  ████████░░░░░░░░░░░░░░░░░░░░░░  AMBER                       │
│                                                                           │
│  < 20%  ──▶  ████░░░░░░░░░░░░░░░░░░░░░░░░░░  RED                         │
│              + "Resets in 5 minutes" warning                              │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Display format:** "{remaining}/{limit} requests"

---

## 6. Trade-offs Summary (2 minutes)

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Polling over WebSocket | 5s delay vs complexity | Dashboard tolerates slight delay |
| Session auth for admin | Cookie management | Simpler than JWT for admin UI |
| Consistent error format | Response size overhead | Better DX, easier debugging |
| Rate limit in headers | Every response overhead | Enables proactive UI warnings |
| L1 + L2 cache | Memory duplication | 90% latency reduction for hot data |
| Redis rate limit state | External dependency | Required for distributed correctness |

---

## 7. Two-Level Caching Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Two-Level Cache Strategy                             │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Request ──▶ L1 (In-Memory)                                               │
│                   │                                                       │
│           ┌──────┴──────┐                                                 │
│           ▼             ▼                                                 │
│         [HIT]        [MISS]                                               │
│           │             │                                                 │
│           │             ▼                                                 │
│           │      L2 (Redis)                                               │
│           │             │                                                 │
│           │     ┌──────┴──────┐                                           │
│           │     ▼             ▼                                           │
│           │   [HIT]        [MISS]                                         │
│           │     │             │                                           │
│           │     │ Populate    │                                           │
│           │     │ L1 cache    ▼                                           │
│           │     │         Database                                        │
│           │     │             │                                           │
│           │     │             │ Populate L1 + L2                          │
│           │     │             │                                           │
│           ▼     ▼             ▼                                           │
│        Return Data                                                        │
│                                                                           │
├──────────────────────────────────────────────────────────────────────────┤
│ L1 Config: 5-second TTL, 1000 items max, per-instance                    │
│ L2 Config: Configurable TTL, shared across instances                      │
│ Benefit: 90% of requests served from L1, sub-millisecond latency          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Sliding Window Rate Limiting

"I chose sliding window over fixed window for more accurate rate limiting. Fixed windows can allow 2x the intended rate at window boundaries."

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Sliding Window Rate Limiting                           │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Redis Sorted Set: rate_limit:{key_id}                                    │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Score: timestamp    │    Member: request_id                        │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ 1705312800000       │    req_001                                   │  │
│  │ 1705312801000       │    req_002                                   │  │
│  │ 1705312802500       │    req_003                                   │  │
│  │ ...                 │    ...                                       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Check limit:                                                             │
│  1. ZREMRANGEBYSCORE to remove entries older than window                  │
│  2. ZCARD to count current requests                                       │
│  3. If count < limit, ZADD new request                                    │
│  4. Return allowed: true/false, remaining count                           │
│                                                                           │
│  Benefits:                                                                │
│  - Atomic operations (Lua script)                                         │
│  - Works across multiple gateway instances                                │
│  - More accurate than fixed window                                        │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 9. Future Enhancements

1. **WebSocket for Alerts**: Push critical alerts immediately to dashboard
2. **Request Tracing**: Propagate request IDs through all services
3. **Optimistic Updates**: Update UI before server confirmation
4. **Offline Support**: Cache dashboard data for network interruptions
5. **Role-Based Access**: Granular admin permissions (read-only, full access)
6. **API Versioning UI**: Show deprecation warnings for old API versions
