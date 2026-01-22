# Scalable API - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 1. Problem Statement (2 minutes)

"Design a scalable API platform that can handle millions of requests per day with consistent low latency, high availability, and protection against abuse."

This is an **infrastructure-focused problem** requiring expertise in:
- Horizontal scaling and stateless design
- Multi-level caching strategies
- Rate limiting algorithms
- Circuit breaker patterns
- Load balancing and health monitoring

---

## 2. Requirements Clarification (3 minutes)

### Functional Requirements
- RESTful API endpoints with versioning
- API key authentication and authorization
- Tiered rate limiting (anonymous, free, pro, enterprise)
- Request/response logging and analytics
- Health check endpoints for orchestration

### Non-Functional Requirements
- **Latency**: P99 < 100ms for cached responses
- **Throughput**: 100K+ requests per minute at peak
- **Availability**: 99.9% uptime (8.7 hours downtime/year)
- **Scalability**: Horizontal scaling without code changes

### Backend-Specific Clarifications
- "What caching strategy?" - Two-level: local L1 (5s TTL) + Redis L2 (configurable)
- "Rate limiting algorithm?" - Sliding window with Redis sorted sets
- "Failure handling?" - Circuit breakers per dependency, graceful degradation
- "Database choice?" - PostgreSQL with partitioned tables for request logs

---

## 3. High-Level Architecture (5 minutes)

```
                                    ┌─────────────────┐
                                    │   API Gateway   │
                                    │  (Rate Limit)   │
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │  Load Balancer  │
                                    │ (Least Conns)   │
                                    └────────┬────────┘
                         ┌───────────────────┼───────────────────┐
                         │                   │                   │
                    ┌────▼────┐         ┌────▼────┐         ┌────▼────┐
                    │ API-1   │         │ API-2   │         │ API-3   │
                    │ :3001   │         │ :3002   │         │ :3003   │
                    └────┬────┘         └────┬────┘         └────┬────┘
                         │                   │                   │
         ┌───────────────┴───────────────────┴───────────────────┘
         │
    ┌────▼────┐     ┌─────────────┐     ┌──────────────┐
    │ L1 Cache│────▶│ Redis (L2)  │     │  PostgreSQL  │
    │ (Local) │     │   Cache     │     │  (Primary)   │
    └─────────┘     └─────────────┘     └──────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| API Gateway | Rate limiting, authentication, request routing |
| Load Balancer | Traffic distribution, health checking, connection management |
| API Servers | Stateless request processing, business logic |
| L1 Cache | In-memory hot data, reduces Redis round-trips |
| Redis (L2) | Distributed cache, rate limit counters, session storage |
| PostgreSQL | Persistent storage, request logs, API key metadata |

---

## 4. Deep Dives (25 minutes)

### Deep Dive 1: Two-Level Caching Architecture (8 minutes)

**Challenge**: Minimize latency while maintaining cache consistency across distributed servers.

**Solution**: Cache-aside pattern with local L1 and Redis L2 caches.

```javascript
// backend/shared/services/cache.js
class CacheService {
  constructor() {
    this.localCache = new Map();
    this.localTTLs = new Map();
    this.redisClient = createClient({ url: process.env.REDIS_URL });
    this.defaultTTL = 300; // 5 minutes for L2
    this.localTTL = 5000;  // 5 seconds for L1
  }

  async get(key) {
    // Level 1: Check local cache first
    const localValue = this.getLocal(key);
    if (localValue !== null) {
      metrics.increment('cache.l1.hit');
      return localValue;
    }

    // Level 2: Check Redis
    const redisValue = await this.redisClient.get(key);
    if (redisValue !== null) {
      const parsed = JSON.parse(redisValue);
      // Populate L1 from L2 hit
      this.setLocal(key, parsed);
      metrics.increment('cache.l2.hit');
      return parsed;
    }

    metrics.increment('cache.miss');
    return null;
  }

  async set(key, value, ttlSeconds = this.defaultTTL) {
    // Set both levels
    this.setLocal(key, value);
    await this.redisClient.setEx(
      key,
      ttlSeconds,
      JSON.stringify(value)
    );
  }

  async getOrFetch(key, fetchFn, ttlSeconds = this.defaultTTL) {
    const cached = await this.get(key);
    if (cached !== null) return cached;

    const fresh = await fetchFn();
    if (fresh !== null) {
      await this.set(key, fresh, ttlSeconds);
    }
    return fresh;
  }

  getLocal(key) {
    const expiry = this.localTTLs.get(key);
    if (!expiry || Date.now() > expiry) {
      this.localCache.delete(key);
      this.localTTLs.delete(key);
      return null;
    }
    return this.localCache.get(key);
  }

  setLocal(key, value) {
    this.localCache.set(key, value);
    this.localTTLs.set(key, Date.now() + this.localTTL);
  }
}
```

**Cache Invalidation Strategies**:

| Strategy | Use Case | Implementation |
|----------|----------|----------------|
| TTL-based | Static resources, config | Automatic expiry |
| Event-driven | User data updates | Pub/sub invalidation |
| Write-through | Critical data | Update cache on write |
| Stale-while-revalidate | Non-critical data | Serve stale, refresh async |

**L1 Cache Considerations**:
- Short TTL (5s) prevents stale data across instances
- No coordination needed between servers
- Automatic cleanup via TTL checks
- Memory bounded by LRU eviction

---

### Deep Dive 2: Sliding Window Rate Limiting (8 minutes)

**Challenge**: Accurate rate limiting across distributed servers without race conditions.

**Solution**: Sliding window algorithm using Redis sorted sets for atomic operations.

```javascript
// backend/shared/services/rateLimiter.js
class RateLimiter {
  constructor(redisClient) {
    this.redis = redisClient;
    this.tiers = {
      anonymous: { requests: 100, window: 60 },
      free: { requests: 1000, window: 60 },
      pro: { requests: 10000, window: 60 },
      enterprise: { requests: 100000, window: 60 }
    };
  }

  async checkLimit(identifier, tier = 'anonymous') {
    const config = this.tiers[tier];
    const key = `ratelimit:${tier}:${identifier}`;
    const now = Date.now();
    const windowStart = now - (config.window * 1000);

    // Atomic Lua script for sliding window
    const script = `
      -- Remove expired entries
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])

      -- Count current requests
      local count = redis.call('ZCARD', KEYS[1])

      -- Check if under limit
      if count < tonumber(ARGV[3]) then
        -- Add new request
        redis.call('ZADD', KEYS[1], ARGV[2], ARGV[2])
        -- Set expiry
        redis.call('EXPIRE', KEYS[1], ARGV[4])
        return {1, count + 1, tonumber(ARGV[3]) - count - 1}
      else
        return {0, count, 0}
      end
    `;

    const result = await this.redis.eval(script, {
      keys: [key],
      arguments: [
        windowStart.toString(),
        now.toString(),
        config.requests.toString(),
        (config.window + 1).toString()
      ]
    });

    return {
      allowed: result[0] === 1,
      current: result[1],
      remaining: result[2],
      resetAt: now + (config.window * 1000)
    };
  }
}
```

**Rate Limit Headers**:

```javascript
// Middleware to add standard rate limit headers
function rateLimitMiddleware(rateLimiter) {
  return async (req, res, next) => {
    const identifier = req.apiKey?.id || req.ip;
    const tier = req.apiKey?.tier || 'anonymous';

    const result = await rateLimiter.checkLimit(identifier, tier);

    // Standard rate limit headers
    res.set('X-RateLimit-Limit', result.current + result.remaining);
    res.set('X-RateLimit-Remaining', result.remaining);
    res.set('X-RateLimit-Reset', Math.ceil(result.resetAt / 1000));

    if (!result.allowed) {
      res.set('Retry-After', Math.ceil((result.resetAt - Date.now()) / 1000));
      return res.status(429).json({
        error: 'Too Many Requests',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000)
      });
    }

    next();
  };
}
```

**Why Sliding Window over Fixed Window**:
- Fixed window: Allows 2x burst at window boundaries
- Sliding window: Smooth distribution, accurate limiting
- Memory cost: O(requests per window) in sorted set
- Atomic operations prevent race conditions

---

### Deep Dive 3: Circuit Breaker Pattern (5 minutes)

**Challenge**: Prevent cascading failures when downstream dependencies fail.

**Solution**: Per-dependency circuit breakers with three states.

```javascript
// backend/shared/services/circuitBreaker.js
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;

    this.options = {
      failureThreshold: options.failureThreshold || 5,
      successThreshold: options.successThreshold || 3,
      timeout: options.timeout || 30000,  // 30 seconds
      resetTimeout: options.resetTimeout || 60000  // 1 minute
    };
  }

  async execute(operation, fallback = null) {
    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.state = 'HALF_OPEN';
      } else {
        metrics.increment(`circuit.${this.name}.rejected`);
        return this.handleFallback(fallback);
      }
    }

    try {
      const result = await this.executeWithTimeout(operation);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      return this.handleFallback(fallback, error);
    }
  }

  async executeWithTimeout(operation) {
    return Promise.race([
      operation(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), this.options.timeout)
      )
    ]);
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        metrics.increment(`circuit.${this.name}.closed`);
      }
    } else {
      this.failureCount = 0;
    }
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.successCount = 0;
      metrics.increment(`circuit.${this.name}.opened`);
    } else if (this.failureCount >= this.options.failureThreshold) {
      this.state = 'OPEN';
      metrics.increment(`circuit.${this.name}.opened`);
    }
  }

  shouldAttemptReset() {
    return Date.now() - this.lastFailureTime >= this.options.resetTimeout;
  }

  handleFallback(fallback, error = null) {
    if (fallback) {
      return typeof fallback === 'function' ? fallback(error) : fallback;
    }
    throw error || new Error('Circuit breaker open');
  }
}
```

**State Transitions**:

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
    ┌──────────┐  failure   ┌──────────┐  timeout   ┌────┴─────┐
    │  CLOSED  │──threshold─▶│   OPEN   │───────────▶│HALF_OPEN │
    │          │            │          │            │          │
    └────┬─────┘            └──────────┘            └────┬─────┘
         │                        ▲                      │
         │                        │                      │
         └────────────────────────┼──────────────────────┘
                             failure               success threshold
```

---

### Deep Dive 4: Load Balancer with Health Checks (4 minutes)

**Solution**: Least connections algorithm with active health monitoring.

```javascript
// backend/load-balancer/src/index.js
class LoadBalancer {
  constructor(servers) {
    this.servers = servers.map(s => ({
      ...s,
      healthy: true,
      connections: 0,
      weight: s.weight || 1,
      consecutiveFailures: 0
    }));

    this.startHealthChecks();
  }

  selectServer() {
    const healthy = this.servers.filter(s => s.healthy);
    if (healthy.length === 0) {
      throw new Error('No healthy servers available');
    }

    // Least connections with weights
    return healthy.reduce((best, server) => {
      const score = server.connections / server.weight;
      const bestScore = best.connections / best.weight;
      return score < bestScore ? server : best;
    });
  }

  async healthCheck(server) {
    try {
      const response = await fetch(`${server.url}/health/ready`, {
        timeout: 5000
      });

      if (response.ok) {
        server.consecutiveFailures = 0;
        if (!server.healthy) {
          server.healthy = true;
          logger.info(`Server ${server.id} marked healthy`);
        }
      } else {
        this.markUnhealthy(server);
      }
    } catch (error) {
      this.markUnhealthy(server);
    }
  }

  markUnhealthy(server) {
    server.consecutiveFailures++;
    if (server.consecutiveFailures >= 3) {
      server.healthy = false;
      logger.warn(`Server ${server.id} marked unhealthy`);
    }
  }

  startHealthChecks() {
    setInterval(() => {
      this.servers.forEach(s => this.healthCheck(s));
    }, 10000); // Every 10 seconds
  }
}
```

**Health Check Endpoints**:

```javascript
// Liveness: Is the process running?
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok' });
});

// Readiness: Can we serve traffic?
app.get('/health/ready', async (req, res) => {
  const checks = {
    database: await checkDatabase(),
    redis: await checkRedis(),
    memory: process.memoryUsage().heapUsed < MAX_HEAP
  };

  const healthy = Object.values(checks).every(Boolean);
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ready' : 'not_ready',
    checks
  });
});
```

---

## 5. Database Schema (3 minutes)

```sql
-- API key management
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  key_hash VARCHAR(64) NOT NULL UNIQUE,  -- SHA-256 of key
  key_prefix VARCHAR(8) NOT NULL,         -- First 8 chars for display
  tier VARCHAR(20) DEFAULT 'free',
  scopes TEXT[] DEFAULT '{}',
  rate_limit_override INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

-- Partitioned request logs for analytics
CREATE TABLE request_logs (
  id BIGSERIAL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  api_key_id UUID REFERENCES api_keys(id),
  method VARCHAR(10) NOT NULL,
  path VARCHAR(255) NOT NULL,
  status_code INTEGER NOT NULL,
  response_time_ms INTEGER NOT NULL,
  request_size INTEGER,
  response_size INTEGER,
  ip_address INET,
  user_agent TEXT,
  error_message TEXT,
  server_id VARCHAR(50)
) PARTITION BY RANGE (timestamp);

-- Auto-create monthly partitions
CREATE TABLE request_logs_2024_01 PARTITION OF request_logs
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Rate limit configurations
CREATE TABLE rate_limit_configs (
  id SERIAL PRIMARY KEY,
  tier VARCHAR(20) UNIQUE NOT NULL,
  requests_per_minute INTEGER NOT NULL,
  burst_allowance INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_request_logs_timestamp ON request_logs (timestamp DESC);
CREATE INDEX idx_request_logs_api_key ON request_logs (api_key_id, timestamp DESC);
CREATE INDEX idx_api_keys_hash ON api_keys (key_hash) WHERE is_active = true;
```

**Data Lifecycle**:

| Data Type | Retention | Storage |
|-----------|-----------|---------|
| Request logs (raw) | 7 days | Hot partition |
| Request logs (aggregated) | 90 days | Warm partition |
| API key metadata | Indefinite | Primary tables |
| Rate limit state | Window duration | Redis |

---

## 6. Trade-offs Summary (2 minutes)

| Decision | Trade-off | Rationale |
|----------|-----------|-----------|
| Two-level cache | Memory duplication | L1 reduces Redis latency by 90% for hot keys |
| Sliding window | More Redis operations | Prevents window boundary bursts |
| Per-dependency circuit breakers | Complexity | Isolates failures, prevents cascade |
| Partitioned logs | Query complexity | Enables efficient data lifecycle |
| Stateless servers | No local state | Enables true horizontal scaling |

---

## 7. Future Enhancements

1. **Adaptive Rate Limiting**: Adjust limits based on server load
2. **Request Coalescing**: Deduplicate concurrent identical requests
3. **Geographic Distribution**: Multi-region deployment with routing
4. **Token Bucket Hybrid**: Combine sliding window with burst tokens
5. **Predictive Scaling**: Auto-scale based on traffic patterns
