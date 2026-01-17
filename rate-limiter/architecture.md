# Rate Limiter - Architecture Design

## System Overview

An API rate limiting service to prevent abuse, implementing multiple algorithms for different use cases.

## Requirements

### Functional Requirements

- **Request Counting** - Track number of requests per client/API key
- **Multiple Algorithms** - Support different rate limiting strategies:
  - Fixed Window Counter
  - Sliding Window Counter
  - Sliding Window Log
  - Token Bucket
  - Leaky Bucket
- **Distributed Limiting** - Work across multiple API servers consistently
- **Custom Rules** - Configure different limits per endpoint, user tier, API key
- **Response Headers** - Return remaining quota and reset time to clients

### Non-Functional Requirements

- **Low Latency** - Rate check must add <5ms to request processing
- **High Availability** - Must not become a single point of failure
- **Accuracy** - Limits should be respected within 1-5% tolerance
- **Scalability** - Handle 100K+ requests per second per Redis instance

### Out of Scope

- DDoS protection (layer 3/4 attacks)
- Geographic-based limiting
- Machine learning-based anomaly detection

## Capacity Estimation

### Assumptions
- 100,000 API customers
- 1 million requests per second across all APIs
- Average customer makes 100 requests/second during peak
- 10 API gateway nodes

### Storage Estimates
- Rate limit state per customer: ~100 bytes
- 100,000 customers x 100 bytes = 10 MB
- With sliding window buckets: ~50 MB total

### Latency Budget
- Total API latency target: 100ms
- Rate limiting overhead: <5ms (5% of budget)
- Network round-trip to Redis: ~1ms within same datacenter

## High-Level Architecture

```
┌──────────────┐     ┌───────────────────────────────────────────────────┐
│   Client     │────▶│                  API Gateway                      │
│              │     │  ┌─────────────┐  ┌──────────┐  ┌─────────────┐  │
└──────────────┘     │  │ Auth        │──│  Rate    │──│  Route to   │  │
                     │  │ Middleware  │  │  Limiter │  │  Backend    │  │
                     │  └─────────────┘  └────┬─────┘  └─────────────┘  │
                     └────────────────────────┼──────────────────────────┘
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     │                        │                        │
              ┌──────▼──────┐         ┌───────▼───────┐        ┌───────▼───────┐
              │ API Gateway │         │ API Gateway   │        │ API Gateway   │
              │   Node 1    │         │   Node 2      │        │   Node N      │
              └──────┬──────┘         └───────┬───────┘        └───────┬───────┘
                     │                        │                        │
                     └────────────────────────┼────────────────────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │   Redis Cluster   │
                                    │  (Rate Counters)  │
                                    └─────────┬─────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │    PostgreSQL     │
                                    │  (Configuration)  │
                                    └───────────────────┘
```

### Core Components

1. **Rate Limiter Middleware** - Express middleware that intercepts requests
2. **Algorithm Factory** - Creates appropriate rate limiter based on configuration
3. **Redis Client** - Manages distributed state
4. **Metrics Collector** - Tracks performance and usage metrics
5. **Configuration Service** - Loads rules from PostgreSQL (future)

## Data Model

### Redis Keys Structure

```
# Fixed Window
ratelimit:fixed:{identifier}:{window_start}  -> count (integer)

# Sliding Window
ratelimit:sliding:{identifier}:{window_number}  -> count (integer)

# Sliding Log
ratelimit:log:{identifier}  -> sorted set (timestamp -> request_id)

# Token Bucket
ratelimit:token:{identifier}  -> hash {tokens: float, last_refill: timestamp}

# Leaky Bucket
ratelimit:leaky:{identifier}  -> hash {water: float, last_leak: timestamp}

# Metrics
metrics:{minute}  -> hash {total, allowed, denied, latency_sum}
metrics:latencies:{minute}  -> list of latency values
```

### PostgreSQL Schema (Future)

```sql
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
    enabled         BOOLEAN DEFAULT true
);
```

## API Design

### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ratelimit/check` | POST | Check rate limit and consume token |
| `/api/ratelimit/state/:id` | GET | Get current state without consuming |
| `/api/ratelimit/reset/:id` | DELETE | Reset rate limit for identifier |
| `/api/ratelimit/batch-check` | POST | Check multiple identifiers |
| `/api/metrics` | GET | Get aggregated metrics |
| `/api/metrics/health` | GET | Health check endpoint |
| `/api/algorithms` | GET | List available algorithms |

### Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1704067260
X-RateLimit-Algorithm: sliding_window
Retry-After: 60  (only when rate limited)
```

## Key Design Decisions

### Distributed Counting with Redis

All rate limiting state is stored in Redis, which provides:
- Atomic operations (INCR, ZADD)
- Sub-millisecond latency
- Built-in expiration
- Lua scripting for complex atomic operations

### Algorithm Selection

| Algorithm | Accuracy | Memory | Burst Handling | Use Case |
|-----------|----------|--------|----------------|----------|
| Fixed Window | Low | Very Low | Allows 2x at boundary | Simple quotas |
| Sliding Window | ~98% | Low | Smooth | General purpose (default) |
| Sliding Log | 100% | High | Perfect | Exact counting |
| Token Bucket | N/A | Low | Controlled bursts | Traffic shaping |
| Leaky Bucket | N/A | Low | No bursts | Smooth output rate |

### Fail-Open Strategy

When Redis is unavailable, requests are allowed to pass (fail-open) because:
- Rate limiting protects against sustained abuse, not individual requests
- Temporary failures should not block legitimate users
- Aggressive alerting compensates for the risk

## Technology Stack

- **Application Layer**: Node.js + Express + TypeScript
- **Data Layer**: Redis 7 (primary), PostgreSQL 16 (configuration)
- **Caching Layer**: Redis (same as data layer)
- **Frontend**: React 19 + Vite + Tailwind CSS + Zustand

## Scalability Considerations

### Horizontal Scaling

1. **API Servers**: Stateless, scale horizontally behind load balancer
2. **Redis**: Use Redis Cluster for sharding by identifier hash
3. **Local Caching**: Implement in-memory cache with periodic sync for hot paths

### Performance Optimizations

1. **Lua Scripts**: Atomic multi-step operations for Token/Leaky Bucket
2. **Pipelining**: Batch Redis operations where possible
3. **Connection Pooling**: Reuse Redis connections

## Trade-offs and Alternatives

### Trade-off 1: Centralized vs. Local Rate Limiting

**Chose**: Centralized Redis for accuracy
**Trade-off**: Adds 1-2ms latency; Redis becomes critical dependency
**Alternative**: Pure local limiting (faster but limits can be exceeded)

### Trade-off 2: Exact vs. Approximate Counting

**Chose**: Sliding window counter (approximate)
**Trade-off**: ~1-2% error tolerance acceptable for most use cases
**Alternative**: Sliding log for exact counting (10x more memory)

## Monitoring and Observability

### Key Metrics

- `rate_limit_checks_total` - Total checks by result (allowed/denied)
- `rate_limit_latency` - Histogram of check latencies
- `rate_limit_remaining` - Gauge of remaining quota per identifier

### Alerting Rules

- High denial rate (>10% in 5 minutes)
- Rate limiter latency p99 > 10ms
- Redis connection failures

## Security Considerations

- Validate identifiers to prevent injection
- Rate limit the rate limiter API itself
- Use secure Redis connections in production
- Implement IP-based fallback for missing API keys

## Future Optimizations

1. **Local Caching**: Hybrid approach with local counters synced periodically
2. **Rule Engine**: Dynamic rules from PostgreSQL with caching
3. **Analytics**: Historical analysis of rate limit patterns
4. **Distributed Tracing**: OpenTelemetry integration
5. **Prometheus Export**: Native Prometheus metrics endpoint
