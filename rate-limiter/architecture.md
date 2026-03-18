# Rate Limiter - Architecture Design

## System Overview

A distributed API rate limiting service that prevents abuse by tracking request counts per client across multiple API gateway nodes. The system implements five rate limiting algorithms (Fixed Window, Sliding Window, Sliding Log, Token Bucket, Leaky Bucket) with centralized state in Redis, providing consistent enforcement regardless of which gateway node handles a request. This project explores distributed counting, sub-millisecond latency constraints, and graceful degradation under infrastructure failures.

## Requirements

### Functional Requirements

- **Request Counting**: Track number of requests per client/API key across all gateway nodes
- **Multiple Algorithms**: Support Fixed Window, Sliding Window Counter, Sliding Window Log, Token Bucket, and Leaky Bucket strategies
- **Distributed Limiting**: Enforce limits consistently across N API gateway nodes sharing Redis state
- **Custom Rules**: Configure different limits per endpoint, user tier, and API key
- **Response Headers**: Return standard `X-RateLimit-*` headers with remaining quota and reset time
- **Batch Checking**: Check multiple identifiers in a single request for batch operations

### Non-Functional Requirements

- **Low Latency**: Rate check must add < 5ms to request processing (5% of 100ms latency budget)
- **High Availability**: Must not become a single point of failure; fail-open on Redis outage
- **Accuracy**: Limits respected within 1-5% tolerance (depending on algorithm)
- **Scalability**: Handle 100K+ requests per second per Redis instance; 1M+ with sharding
- **Observability**: Full Prometheus metrics for tuning limits and detecting abuse

### Out of Scope

- DDoS protection (layer 3/4 attacks)
- Geographic-based rate limiting
- Machine learning-based anomaly detection
- Request content inspection

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| API customers | 100,000 |
| Total RPS (all APIs) | 1,000,000 |
| Peak per-customer RPS | 100 |
| API gateway nodes | 10 |
| RPS per gateway node | 100,000 |

### Storage Estimates

| Data | Size | Notes |
|------|------|-------|
| Rate limit state per customer | ~100 bytes | Counter + metadata |
| Total active state (Redis) | ~10 MB | 100K customers x 100 bytes |
| With sliding window buckets | ~50 MB | 2 windows per customer |
| With sliding log (worst case) | ~500 MB | 1000 timestamps per customer |

### Latency Budget

| Component | Budget |
|-----------|--------|
| Total API latency target | 100 ms |
| Rate limiting overhead | < 5 ms (5%) |
| Network to Redis (same DC) | ~1 ms |
| Redis operation | ~0.1 ms |
| Lua script execution | ~0.5 ms |

## High-Level Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Client A   │  │   Client B   │  │   Client N   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                ┌────────▼────────┐
                │   L7 Load       │
                │   Balancer      │
                └────────┬────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
┌────────▼────────┐ ┌────▼────────┐ ┌────▼────────┐
│  API Gateway 1  │ │ API Gateway 2│ │API Gateway N│
│  ┌────────────┐ │ │             │ │             │
│  │ Auth MW    │ │ │  (same      │ │  (same      │
│  ├────────────┤ │ │   stack)    │ │   stack)    │
│  │ Rate Limit │ │ │             │ │             │
│  │ Middleware │ │ │             │ │             │
│  ├────────────┤ │ │             │ │             │
│  │ Route to   │ │ │             │ │             │
│  │ Backend    │ │ │             │ │             │
│  └────────────┘ │ │             │ │             │
└────────┬────────┘ └──────┬──────┘ └──────┬──────┘
         │                 │               │
         └─────────────────┼───────────────┘
                           │
              ┌────────────▼────────────┐
              │     Redis Cluster       │
              │   (Rate Limit State)    │
              │                         │
              │  Counters, Sorted Sets, │
              │  Hashes, Lua Scripts    │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │      PostgreSQL         │
              │   (Rule Configuration)  │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │      RabbitMQ           │
              │  (Metrics Aggregation,  │
              │   Audit Events)         │
              └─────────────────────────┘
```

## Core Components

### 1. Rate Limiter Middleware

Express middleware that intercepts every request before it reaches the backend. Extracts the client identifier (API key, user ID, or IP), selects the appropriate algorithm based on configuration, and either allows or denies the request.

**Critical design constraint:** The middleware must add < 5ms to every request. This means no database queries in the hot path -- only Redis operations.

### 2. Algorithm Factory

Creates the appropriate rate limiter instance based on the rule configuration. Each algorithm implements a common interface (`check`, `getState`, `reset`) but uses different Redis data structures and Lua scripts internally.

### 3. Algorithm Implementations

| Algorithm | Redis Structure | Atomicity | Accuracy | Memory | Best For |
|-----------|----------------|-----------|----------|--------|----------|
| Fixed Window | `INCR` + `EXPIRE` | Native atomic | Low (2x burst at boundary) | Very low | Simple quotas |
| Sliding Window | Two `INCR` keys (current + previous) | Native atomic | ~98% | Low | General purpose (default) |
| Sliding Log | `ZADD` sorted set | Native atomic | 100% exact | High (stores every timestamp) | Exact counting |
| Token Bucket | `HSET` hash + Lua script | Lua atomic | N/A (rate-based) | Low | Controlled bursts |
| Leaky Bucket | `HSET` hash + Lua script | Lua atomic | N/A (rate-based) | Low | Smooth output rate |

**Why Lua scripts for Token/Leaky Bucket:** These algorithms require read-compute-write sequences (read current tokens, calculate refill since last access, update state). Without Lua, a race condition between two gateway nodes could both read "5 tokens available" and both allow a request, granting 2 tokens from a budget of 1. Lua scripts execute atomically on the Redis server, eliminating this race.

### 4. Circuit Breaker (Opossum)

Wraps all Redis operations. When Redis becomes unavailable, the circuit breaker prevents every request from waiting for the connection timeout (3-30 seconds), which would cause thread pool exhaustion and cascading latency spikes across all API clients. Instead, the circuit opens after 5 failures in 30 seconds and immediately falls back to the configured degradation mode (fail-open or fail-closed).

### 5. Metrics Collector

Prometheus metrics exposed at `/metrics` for monitoring rate limit operations, latency distributions, circuit breaker states, and Redis health. These metrics enable data-driven tuning of rate limits.

### 6. Background Workers

- **Analytics Worker**: Consumes metrics from RabbitMQ and persists aggregated data to PostgreSQL for historical analysis
- **Metrics Worker**: Processes rate limit decision events for audit logging and anomaly detection

## Database Schema

### Redis Key Structure

```
# Fixed Window
ratelimit:fixed:{identifier}:{window_start}  → count (integer)
TTL: 2x window size

# Sliding Window
ratelimit:sliding:{identifier}:{window_number}  → count (integer)
TTL: 2x window size

# Sliding Log
ratelimit:log:{identifier}  → sorted set (score: timestamp, member: request_id)
TTL: window size + 1 minute

# Token Bucket
ratelimit:token:{identifier}  → hash { tokens: float, last_refill: timestamp }
TTL: 24 hours (reset inactive buckets)

# Leaky Bucket
ratelimit:leaky:{identifier}  → hash { water: float, last_leak: timestamp }
TTL: 24 hours

# Metrics (short-lived)
metrics:{minute}  → hash { total, allowed, denied, latency_sum }
TTL: 1 hour
```

**Why explicit TTLs on every key:** Redis stores all state in memory. Without TTL, inactive API keys accumulate indefinitely. At 1M unique keys with 200 bytes each, that is 200MB of dead state after a year. TTL ensures automatic cleanup. The 2x window multiplier for sliding window keys ensures the previous window's count is available for the weighted calculation.

### PostgreSQL Schema

Defined in `backend/src/db/init.sql`. Used for rule configuration and historical metrics, not in the hot path.

```sql
-- Rate limit rules (future: dynamic configuration)
CREATE TABLE rate_limit_rules (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    endpoint_pattern VARCHAR(255),
    identifier_type VARCHAR(50),
    user_tier       VARCHAR(50),
    algorithm       VARCHAR(50) NOT NULL,
    limit_value     INTEGER NOT NULL,
    window_seconds  INTEGER NOT NULL,
    burst_capacity  INTEGER,
    refill_rate     DECIMAL(10,2),
    leak_rate       DECIMAL(10,2),
    priority        INTEGER DEFAULT 0,
    enabled         BOOLEAN DEFAULT true,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Historical metrics for analysis
CREATE TABLE rate_limit_metrics (
    id              SERIAL PRIMARY KEY,
    timestamp       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    identifier      VARCHAR(255) NOT NULL,
    algorithm       VARCHAR(50) NOT NULL,
    allowed         BOOLEAN NOT NULL,
    remaining       INTEGER,
    latency_ms      DECIMAL(10,2)
);

-- Cleanup function (keep last 7 days)
CREATE OR REPLACE FUNCTION clean_old_metrics() RETURNS void AS $$
BEGIN
    DELETE FROM rate_limit_metrics WHERE timestamp < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;
```

## API Design

### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ratelimit/check` | POST | Check rate limit and consume token |
| `/api/ratelimit/state/:id` | GET | Get current state without consuming |
| `/api/ratelimit/reset/:id` | DELETE | Reset rate limit for identifier |
| `/api/ratelimit/batch-check` | POST | Check multiple identifiers atomically |
| `/api/metrics` | GET | Aggregated metrics dashboard |
| `/api/metrics/health` | GET | Health check (Redis, PG, RabbitMQ) |
| `/api/algorithms` | GET | List available algorithms with descriptions |
| `/metrics` | GET | Prometheus metrics endpoint |

### Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1704067260
X-RateLimit-Algorithm: sliding_window
Retry-After: 60  (only when rate limited, 429 response)
```

## Key Design Decisions

### 1. Centralized vs. Local Rate Limiting

**Chosen: Centralized Redis** for accuracy across distributed gateway nodes.

With 10 API gateway nodes, a client sending 100 requests could hit all 10 nodes. Local-only counting would see 10 requests per node and allow all 100, even if the limit is 50. Centralized Redis ensures all nodes share a single counter, enforcing the limit globally.

**The trade-off is latency and availability:** Every rate check adds a ~1-2ms Redis round-trip. If Redis fails, rate limiting fails. We accept this because:
- 1-2ms is within our 5ms budget
- The circuit breaker + fail-open strategy prevents Redis failures from blocking legitimate users
- Rate limiting protects against sustained abuse patterns, not individual requests; missing a few checks during a brief Redis outage is acceptable

**Alternative rejected: Pure local limiting** would be faster (no network hop) but would allow N*limit requests across N nodes. For security-sensitive APIs, this inaccuracy is unacceptable.

### 2. Sliding Window Counter as Default Algorithm

**Chosen: Sliding Window Counter** with ~98% accuracy.

The Fixed Window algorithm has a well-known boundary burst problem: a client can send `limit` requests at the end of window 1 and `limit` requests at the start of window 2, effectively consuming 2x the limit within a 1x time window. For a 100 req/min limit, this means 200 requests in a 2-second window spanning the boundary.

The Sliding Window Counter eliminates this by weighting the previous window's count proportionally. At 30 seconds into a 60-second window, it calculates: `previous_count * 0.5 + current_count`. This smooths the boundary burst from 2x to ~1.01x with minimal additional memory (one extra key per identifier).

**Why not Sliding Log (100% accurate)?** The Sliding Log stores every request timestamp in a sorted set. For a client making 100 req/sec, that is 6,000 entries per minute. At 100K active clients, that is 600M entries consuming ~6GB of Redis memory. The ~2% error of Sliding Window is acceptable for rate limiting, and the 100x memory savings matters.

### 3. Fail-Open on Redis Failure

**Chosen: Fail-open (allow requests when Redis is down).**

Rate limiting protects against sustained abuse -- bots, scrapers, credential stuffing attacks that send thousands of requests over minutes to hours. A 30-second Redis outage does not enable meaningful abuse because the attacker would need to know Redis is down and execute their attack within that window.

Fail-closed (deny all requests when Redis is down) would turn every Redis hiccup into a full service outage. Redis connection blips are common during deployments, network reconfigurations, and maintenance. Making rate limiting a hard dependency of every API call means Redis availability directly determines API availability.

**Exception: Security-critical endpoints** (authentication, payment) should fail-closed because the cost of unauthorized access exceeds the cost of brief unavailability. The implementation makes this configurable per-endpoint via `DEGRADATION_MODE`.

## Consistency and Idempotency

### Rate Check Idempotency

Rate limit checks are inherently idempotent in the mathematical sense: calling `check("user_123")` twice subtracts two tokens, which is the correct behavior (two requests should consume two tokens). However, for retried requests that failed after the check but before the response, we support optional idempotency keys.

**Idempotency key format:** `check:{identifier}:{timestamp_bucket}`

This ensures that a retried request within the same second-bucket does not double-decrement the counter. The 1-second bucket granularity is intentional: finer granularity would prevent legitimate rapid requests; coarser would allow abuse.

### Retry Strategy

All Redis operations use exponential backoff with jitter:

| Attempt | Delay | With 25% Jitter |
|---------|-------|-----------------|
| 1st retry | 100 ms | 75-125 ms |
| 2nd retry | 200 ms | 150-250 ms |
| 3rd retry | 400 ms | 300-500 ms |
| After 3 failures | Fail-open | Circuit breaker trips |

**Why jitter:** Without jitter, all gateway nodes retry simultaneously after a Redis blip, creating a "thundering herd" that can prevent Redis from recovering.

## Security

- **Identifier validation**: Sanitize and length-limit all identifiers to prevent Redis key injection
- **Self-rate-limiting**: The rate limiter API itself is rate-limited to prevent recursive abuse
- **Secure Redis**: TLS connections in production; no auth in local dev for simplicity
- **IP fallback**: When API key is missing, fall back to IP-based limiting
- **Sensitive field redaction**: Authorization headers and API keys are redacted from Pino logs

## Observability

### Prometheus Metrics

| Metric | Type | Purpose |
|--------|------|---------|
| `ratelimiter_checks_total{result, algorithm}` | Counter | Allowed vs denied ratio per algorithm |
| `ratelimiter_check_duration_seconds{algorithm}` | Histogram | Latency distribution (must stay < 5ms p99) |
| `ratelimiter_active_identifiers` | Gauge | Memory pressure indicator |
| `ratelimiter_circuit_breaker_state{name, state}` | Gauge | Redis health visibility (open/closed/half-open) |
| `ratelimiter_circuit_breaker_calls_total{name, result}` | Counter | Circuit breaker call outcomes |
| `ratelimiter_fallback_activations_total{reason}` | Counter | How often fail-open is triggered |
| `ratelimiter_redis_connected` | Gauge | Redis connection status |
| `ratelimiter_redis_operation_duration_seconds{operation}` | Histogram | Redis operation latency |
| `ratelimiter_redis_operations_total{operation, result}` | Counter | Redis operation outcomes |
| `ratelimiter_http_requests_total{method, path, status}` | Counter | HTTP request tracking |
| `ratelimiter_http_request_duration_seconds{method, path}` | Histogram | HTTP latency |
| `ratelimiter_remaining_quota{identifier_hash}` | Gauge | Sampled remaining quota |

### Tuning Workflow

1. **High denial rate (>10%)**: Limits may be too restrictive. Check `ratelimiter_checks_total{result="denied"}` / total. Consider increasing limits for specific endpoints.
2. **Low denial rate (<1%)**: Limits may be too permissive. Attackers might not be hitting limits.
3. **Latency spikes**: Check `ratelimiter_check_duration_seconds` p99. Should be < 5ms. Investigate Redis connectivity.
4. **Memory growth**: Check `ratelimiter_active_identifiers`. May need shorter TTLs or key cleanup.

### Alerting Rules

| Alert | Condition | Severity |
|-------|-----------|----------|
| HighDenialRate | denial rate > 10% for 5 min | Warning |
| CircuitBreakerOpen | Redis circuit breaker open for 1 min | Critical |
| HighLatency | check p99 > 10ms for 5 min | Warning |
| RedisDisconnected | `ratelimiter_redis_connected` = 0 for 1 min | Critical |

## Failure Handling

### Circuit Breaker Configuration

Each external dependency has its own circuit breaker:

| Dependency | Failure Threshold | Recovery Timeout | Half-Open Requests |
|------------|------------------|------------------|-------------------|
| Redis Primary | 5 failures in 30s | 10 seconds | 3 |
| Redis Replica | 10 failures in 60s | 30 seconds | 5 |
| PostgreSQL | 5 failures in 60s | 30 seconds | 2 |
| RabbitMQ | 5 failures in 30s | 15 seconds | 3 |

### Circuit Breaker State Machine

```
CLOSED ──(failures exceed threshold)──▶ OPEN
  ▲                                       │
  │                              (recovery timeout)
  │                                       │
  │                                       ▼
  └──────(test requests succeed)──── HALF-OPEN
                                          │
                              (test requests fail)
                                          │
                                          ▼
                                        OPEN
```

### Failure Scenarios

| Scenario | Behavior | Recovery |
|----------|----------|----------|
| Redis down | Circuit opens, fail-open for rate checks | Auto-recover when Redis returns; counters reset naturally |
| Redis slow (>3s) | Circuit opens on timeout | Half-open tests after 10s |
| PostgreSQL down | Rule config unavailable; use cached/default rules | No impact on hot-path rate checks |
| RabbitMQ down | Metrics queue fails; rate checks unaffected | Retry metrics on reconnection |
| Network partition | Inconsistent counts across partitioned nodes | Eventual consistency on heal; brief over-limit |

## Scalability Considerations

### Horizontal Scaling

| Component | Strategy |
|-----------|----------|
| API Gateway nodes | Stateless, scale behind load balancer |
| Redis | Redis Cluster, shard by identifier hash |
| Local caching | In-memory cache with periodic sync for hot paths (future) |

### Performance Optimizations

1. **Lua scripts**: Atomic multi-step operations for Token/Leaky Bucket eliminate round-trips
2. **Redis pipelining**: Batch Redis commands where possible (batch-check endpoint)
3. **Connection pooling**: Reuse Redis connections across requests
4. **Key design**: Short key names, LowCardinality identifiers to minimize Redis memory

### What Breaks First

At 100K RPS per Redis instance, Redis CPU becomes the bottleneck (Lua script execution is single-threaded). Mitigation: shard across Redis Cluster by identifier hash, spreading load across N shards.

At 1M+ unique identifiers, Redis memory grows linearly. Mitigation: shorter TTLs for inactive identifiers, or a two-tier approach with local in-memory cache for hot identifiers synced periodically to Redis.

## Async Queue/Stream Architecture

For background jobs and fanout operations, RabbitMQ handles async workloads without impacting the critical path of rate limit checks.

### Queue Types

| Queue Name | Purpose | Delivery | TTL |
|------------|---------|----------|-----|
| `ratelimit.metrics.aggregate` | Batch metrics to PostgreSQL | At-least-once | 1 hour |
| `ratelimit.audit.events` | Rate limit decision audit log | At-least-once | 24 hours |
| `ratelimit.rules.sync` | Config change fanout to API nodes | At-most-once | 5 minutes |
| `ratelimit.alerts.trigger` | Threshold breach notifications | At-least-once | 30 minutes |

### Data Lifecycle

| Data | Hot Storage | Warm | Cold | Delete After |
|------|-------------|------|------|-------------|
| Rate limit rules | PostgreSQL (indefinite) | N/A | N/A | Manual |
| Redis state | In-memory (TTL-based) | N/A | N/A | Auto-expire |
| Hourly metrics | PostgreSQL (7 days) | Compressed (30 days) | S3 (1 year) | 1 year |
| Audit events | PostgreSQL (24 hours) | Compressed (7 days) | S3 (30 days) | 30 days |

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State store | Centralized Redis | Local in-memory | Accuracy across distributed nodes; 1-2ms latency acceptable |
| Default algorithm | Sliding Window (~98%) | Sliding Log (100%) | 100x less memory; 2% error acceptable for rate limiting |
| Redis failure | Fail-open | Fail-closed | Rate limiting protects against sustained abuse, not individual requests |
| Atomicity | Lua scripts for complex algos | Multi-command transactions | Lua is atomic on server; MULTI/EXEC has race window between WATCH and EXEC |
| Metrics pipeline | RabbitMQ async | Synchronous writes | Metrics must not add latency to the rate check hot path |
| Rule storage | PostgreSQL | Redis | Rules change rarely; PG provides SQL queries, schema, backups |
| Clock source | Redis server time (via Lua) | Client system time | Eliminates clock skew across distributed gateway nodes |

## Frontend Architecture

### Component Hierarchy

The rate limiter frontend is a single-page application without routing -- all components render on one page in a vertical layout:

```
App (root layout: Header + main content + footer)
├── Header
│   ├── Title ("Rate Limiter Dashboard")
│   └── HealthStatus (real-time Redis/service health indicator)
├── MetricsDashboard (6 metric cards in grid: total/allowed/denied requests, success rate, avg/p99 latency)
├── AlgorithmSelector (5 algorithm buttons with expandable documentation panel showing pros/cons)
├── TestConfiguration + TestRunner (side-by-side in 2-column grid)
│   ├── TestConfiguration (identifier input, limit/window/burst/refill/leak parameters)
│   └── TestRunner (manual send, auto-test with interval, clear/reset controls)
└── TestResults (scrollable list of test results with allowed/denied color coding)
```

### Routing

This project does not use TanStack Router or any client-side routing. The entire application is a single page rendered by `App.tsx`. This design choice reflects the project's nature -- it is an interactive testing tool for rate limiting algorithms, not a multi-view dashboard. All components are always visible, enabling the user to adjust configuration, run tests, and observe results without page navigation.

### Zustand Store

A single store (`useRateLimiterStore`) in `frontend/src/stores/rateLimiterStore.ts` manages all application state across three domains:

**Test Configuration State:**

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `identifier` | string | `"test-user-1"` | Client identifier for rate limit testing |
| `algorithm` | Algorithm | `"sliding_window"` | Selected algorithm |
| `limit` | number | 10 | Maximum requests per window |
| `windowSeconds` | number | 60 | Window duration |
| `burstCapacity` | number | 10 | Token/leaky bucket capacity |
| `refillRate` | number | 1 | Tokens per second (token bucket) |
| `leakRate` | number | 1 | Requests per second (leaky bucket) |

**Test Execution State:**

| Field | Type | Purpose |
|-------|------|---------|
| `testResults` | TestResult[] | Last 100 test results (newest first) |
| `isRunning` | boolean | Whether a test is in progress |
| `autoTestInterval` | number or null | setInterval ID for auto-testing |

**Monitoring State:**

| Field | Type | Source |
|-------|------|--------|
| `metrics` | Metrics | `GET /api/metrics` (2-second polling) |
| `health` | HealthStatus | `GET /api/metrics/health` |
| `algorithms` | AlgorithmInfo[] | `GET /api/algorithms` |

The store provides setter functions for each configuration field, a `runTest()` action that sends a rate limit check to the backend and appends the result to `testResults` (capped at 100 entries), `startAutoTest(intervalMs)` and `stopAutoTest()` for automated testing, and `resetRateLimit()` to clear the server-side state for the current identifier.

### Data Fetching

API communication is centralized in `frontend/src/services/api.ts` as an `api` object with typed methods. A notable design choice: the response handler treats HTTP 429 (Too Many Requests) as a successful response rather than an error, since rate limit exceeded is a valid and expected test result. The API client covers four categories: rate limit operations (check, get state, reset, batch check), metrics, health, and algorithm metadata.

### Key UI Patterns

- **Algorithm documentation panel**: Selecting an algorithm expands a panel showing its description, pros, and cons fetched from the backend. This serves as in-app documentation for each algorithm's trade-offs
- **Auto-test with configurable interval**: Users can start automated testing at a configurable interval (50ms-5000ms), visually demonstrating how each algorithm behaves under sustained load. A green status message shows the active interval
- **Real-time metrics refresh**: The MetricsDashboard polls the backend every 2 seconds, showing total/allowed/denied request counts, success rate percentage, and avg/p99 latency -- enabling users to observe the effect of their tests in near real-time
- **Health indicator in header**: The HealthStatus component in the top-right corner shows Redis connectivity status. If the backend or Redis goes down, the indicator immediately reflects the failure, demonstrating the fail-open degradation mode
- **Color-coded test results**: Each test result shows whether the request was allowed (green) or denied (red) with the remaining quota, making it easy to visualize when the rate limit is reached
- **Parameter adaptation**: The TestConfiguration panel dynamically shows relevant parameters based on the selected algorithm -- window-based algorithms show limit/window fields, while bucket-based algorithms show capacity/rate fields

## Deep Pattern Explanations

This section explains the production-grade patterns used in this project for readers unfamiliar with them.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window to prevent abuse, protect backend resources, and ensure fair access. Without rate limiting, a single client could consume all server capacity -- whether intentionally (API abuse, credential stuffing attacks) or accidentally (buggy client in a retry loop).

This project implements five rate limiting algorithms, each with different characteristics. The key insight is that there is no single "best" algorithm -- the choice depends on the specific requirements around accuracy, memory usage, burst tolerance, and implementation complexity. The Sliding Window Counter is the default because it provides approximately 98% accuracy with minimal memory (two integer counters per client) and avoids the boundary burst problem that plagues Fixed Window counters.

### Circuit Breaker

A circuit breaker is a pattern that detects repeated failures to an external service and stops sending requests to it, preventing two problems: (1) wasting time waiting for a service that is down (each timeout blocks a thread or connection), and (2) cascading failures where backed-up requests from one failing dependency overwhelm the rest of the system.

The circuit has three states: Closed (normal operation -- requests pass through and failures are counted), Open (failure threshold exceeded -- requests immediately fail with a fallback response, no attempt is made to reach the service), and Half-Open (after a recovery timeout, a small number of test requests are allowed through to check if the service has recovered).

In this project, circuit breakers wrap all Redis operations using the Opossum library. Each dependency (Redis, PostgreSQL, RabbitMQ) has its own circuit with independent thresholds. The Redis circuit is configured to open after 5 failures within 30 seconds and attempt recovery after 10 seconds. When the circuit opens, the rate limiter middleware falls back to the configured `DEGRADATION_MODE` -- typically "allow" (fail-open), meaning requests pass through without rate limiting. This prevents a Redis hiccup from becoming a full API outage. Prometheus metrics track circuit state transitions, making it possible to alert when a circuit opens and to audit how often the fallback path is used.

### Prometheus Metrics

Prometheus is a pull-based monitoring system where the application exposes metrics at an HTTP endpoint and Prometheus periodically scrapes that endpoint to collect data. This is fundamentally different from "push-based" systems where the application sends data to a metrics server -- pull-based has the advantage that the monitoring system controls the collection rate and the application does not need to know about monitoring infrastructure.

Four metric types exist: Counter (monotonically increasing value, like `ratelimiter_checks_total`), Gauge (value that goes up and down, like `ratelimiter_active_identifiers`), Histogram (distribution of values grouped into configurable buckets, like `ratelimiter_check_duration_seconds`), and Summary (similar but calculates quantiles on the client side).

This project exposes 15+ metrics via `prom-client` at `GET /metrics`. The most operationally important are: `ratelimiter_checks_total{result, algorithm}` (allowed vs denied ratio per algorithm -- a high denial rate suggests limits are too restrictive), `ratelimiter_check_duration_seconds{algorithm}` (must stay under 5ms p99 -- the entire latency budget for rate limiting), `ratelimiter_circuit_breaker_state` (Redis health visibility), and `ratelimiter_fallback_activations_total` (how often fail-open is triggered).

### Structured Logging

Structured logging means emitting log entries as machine-parseable JSON objects instead of free-form text. Traditional text logs like `"[2024-01-15 10:30:00] INFO: Rate limit check for user-123: allowed, 7 remaining"` are human-readable but difficult to search programmatically. Structured logs like `{"timestamp":"2024-01-15T10:30:00Z","level":"info","identifier":"user-123","allowed":true,"remaining":7}` enable precise queries: "show all denied requests for user-123 in the last hour."

This project uses Pino, chosen for its performance (Pino writes logs 5-10x faster than Winston because it avoids synchronous string concatenation). Sensitive fields (Authorization headers, API keys) are automatically redacted from log output via custom serializers. In development, `pino-pretty` converts JSON to colored, indented output. In production, raw JSON would be shipped to a log aggregation system like Elasticsearch or Datadog for centralized searching and alerting.

### Health Checks

Health checks are HTTP endpoints that report whether a service is operating correctly. They serve three audiences: (1) Load balancers use them to decide whether to route traffic to an instance. (2) Container orchestrators (Docker, Kubernetes) use them to decide whether to restart a container. (3) Monitoring systems use them to trigger alerts.

This project exposes a health check at `GET /api/metrics/health` that reports Redis connectivity, PostgreSQL connectivity, RabbitMQ connectivity, and process uptime. The health check is designed to be cheap to execute (simple PING/SELECT 1 queries) because it may be called every few seconds. If Redis is down, the health check reports unhealthy, but the rate limiter continues operating in degraded mode (fail-open) -- the health check signals the infrastructure that something is wrong, while the circuit breaker handles the operational fallback.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. For rate limiting, this concept has an interesting nuance: calling `check("user-123")` twice should consume two tokens (both are real requests), so rate limit checks are intentionally non-idempotent. However, when a client retries a request that failed after the rate check but before the response, the retry should not double-decrement the counter.

This project supports optional idempotency keys formatted as `check:{identifier}:{timestamp_bucket}`. If a client retries the same request within the same one-second bucket, the duplicate check is detected and the counter is not decremented again. The one-second granularity is intentional: finer granularity (milliseconds) would prevent legitimate rapid requests, while coarser granularity (minutes) would allow abuse.

### Redis Cache-Aside

Cache-aside is a caching strategy where the application checks the cache first and only queries the primary database on a cache miss. In this project, rate limit rules are stored in PostgreSQL but checked on every request. Since rules change rarely (maybe once per day), caching them in Redis avoids a database query on every request.

The current implementation uses hardcoded configuration rather than database-loaded rules, but the architecture is designed for cache-aside: rules would be loaded from PostgreSQL into Redis with a TTL, and a RabbitMQ message would trigger cache invalidation across all API gateway nodes when rules change. The `ratelimit.rules.sync` queue is already defined for this purpose.

### RBAC (Role-Based Access Control)

RBAC restricts system access based on roles (admin, user, viewer) rather than individual permissions. This is relevant for rate limiting because different users need different access levels: operators need to update rate limit rules, developers need to inspect rate limit state for debugging, and the rate limiting middleware itself needs unrestricted access to check and decrement counters.

The current implementation does not include RBAC (the API is open), but the production architecture would implement it at the API gateway level: the rate limiter middleware executes before authentication (to protect the auth service itself from abuse), while configuration endpoints require admin roles.

## Implementation Notes

This section maps the production architecture to what actually runs locally with Docker + Node.js + React.

### Local Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Local Machine                         │
│                                                           │
│  ┌─────────────┐    ┌────────────────────────────────┐   │
│  │  Frontend    │    │       Backend (Express)         │   │
│  │  Vite :5173  │───▶│  :3001 (or :3001-3003)         │   │
│  │  React +     │    │                                 │   │
│  │  Tailwind    │    │  Algorithms: 5 implementations  │   │
│  │              │    │  Middleware: rate-limit.ts       │   │
│  └─────────────┘    └──────┬──────────┬──────────┬────┘   │
│                             │          │          │        │
│                     ┌───────▼──┐ ┌─────▼─────┐ ┌─▼──────┐ │
│                     │  Redis   │ │ PostgreSQL│ │RabbitMQ│ │
│                     │  :6379   │ │   :5432   │ │  :5672 │ │
│                     │ (Valkey) │ │ratelimiter│ │ :15672 │ │
│                     └──────────┘ └───────────┘ └────────┘ │
│                                                           │
│  Optional:  Redis Commander :8081 (dev profile)           │
│                                                           │
│                     docker-compose up -d                   │
└──────────────────────────────────────────────────────────┘
```

### Production-Grade Patterns Implemented

| Pattern | File(s) | Description |
|---------|---------|-------------|
| 5 rate limiting algorithms | `src/algorithms/*.ts` | Fixed Window, Sliding Window, Sliding Log, Token Bucket, Leaky Bucket with Redis Lua scripts for atomicity. |
| Circuit breaker (Opossum) | `src/shared/circuit-breaker.ts` | Wraps Redis operations with configurable failure threshold, recovery timeout, and Prometheus metrics per circuit state. |
| Prometheus metrics (prom-client) | `src/shared/metrics.ts` | 15+ metrics covering rate limit checks, latency, circuit breaker state, Redis health, HTTP requests, and fallback activations. Exposed at `GET /metrics`. |
| Structured JSON logging (Pino) | `src/shared/logger.ts` | Environment-aware log levels, sensitive field redaction, custom serializers, pino-pretty in dev. |
| Fail-open degradation | `src/config/index.ts`, `src/middleware/rate-limit.ts` | Configurable `DEGRADATION_MODE` (allow/deny) when Redis is unavailable. |
| RabbitMQ async workers | `src/workers/analytics-worker.ts`, `src/workers/metrics-worker.ts`, `src/shared/queue.ts` | Background workers consuming from metrics and audit queues. |
| Health checks | `src/index.ts` | `/api/metrics/health` checking Redis, PostgreSQL, and RabbitMQ connectivity. |
| Multi-instance support | `package.json` scripts | `dev:server1` (:3001), `dev:server2` (:3002), `dev:server3` (:3003) for testing distributed behavior. |
| TTL management | `src/config/index.ts`, `src/utils/redis.ts` | Explicit TTLs on all Redis keys with configurable window multipliers. |
| Response headers | `src/middleware/rate-limit.ts` | Standard `X-RateLimit-*` headers on every response. |

### Simplifications from Production Design

| Production Design | Local Substitute | Impact |
|-------------------|-----------------|--------|
| Redis Cluster (sharded) | Single Valkey instance (:6379) | No sharding; single point of failure |
| Multiple API gateway nodes | Single Express process (or 3 via dev scripts) | No real load balancing |
| L7 Load Balancer | Direct HTTP | No TLS, no request distribution |
| Dynamic rule engine from PostgreSQL | Hardcoded config in `src/config/index.ts` | Rules require code changes to update |
| Local in-memory cache tier | Not implemented | Every check hits Redis (no hot-path optimization) |
| Prometheus + Grafana + Alertmanager | Metrics endpoint only | Metrics exposed but no scraping/visualization/alerting infrastructure |
| Multi-region Redis with replication | Not implemented | No failover testing |
| OAuth/JWT for API authentication | No authentication | API is open |
| S3/MinIO cold storage for audit logs | Not implemented | All data stays in PostgreSQL |

### What Was Omitted

- **Local caching tier**: Hybrid approach with in-memory counters synced periodically to Redis for the hottest identifiers. This would reduce Redis RPS by 10-100x.
- **Dynamic rule engine**: Loading rate limit rules from PostgreSQL with caching and config change fanout via RabbitMQ. Currently rules are hardcoded.
- **Distributed tracing**: OpenTelemetry integration for end-to-end request tracing across gateway nodes.
- **Grafana dashboards**: Visual monitoring of the Prometheus metrics already being collected.
- **Multi-region deployment**: Geographic distribution with per-region Redis instances and cross-region sync.
- **Kubernetes/container orchestration**: Auto-scaling gateway nodes based on traffic volume.
- **Rate limit analytics UI**: Historical analysis of rate limit patterns, abuse detection trends, and limit tuning recommendations.
