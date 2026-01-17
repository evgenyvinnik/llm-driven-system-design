# Scalable API - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design a highly scalable API system capable of serving millions of users with low latency, high availability, and resilience to failures. The core challenge is building a horizontally scalable architecture that can add capacity by simply adding instances, while implementing proper traffic management to protect the system from abuse and overload.

This involves three key technical challenges: designing stateless services that scale horizontally behind load balancers, implementing multi-level caching to reduce latency and database load, and building rate limiting with circuit breakers to protect against cascading failures."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Serve Requests**: Handle API requests with consistent response format
- **Authentication**: Verify user identity via API keys or tokens
- **Rate Limiting**: Protect from abuse with configurable limits
- **Caching**: Reduce latency for repeated queries
- **Monitoring**: Track performance, errors, and usage

### Non-Functional Requirements
- **Latency**: P99 < 100ms for cached, < 500ms for uncached
- **Throughput**: 100k+ requests per second
- **Availability**: 99.99% uptime (< 53 minutes downtime/year)
- **Scalability**: Linear scaling by adding instances

### Scale Estimates
- **Requests/second**: 100,000+ at peak
- **API Endpoints**: 100+ across services
- **Users**: 10M+ with API keys
- **Cache hit rate target**: > 90%

### Key Questions I'd Ask
1. What's the read vs. write ratio?
2. Are there specific endpoints with higher latency tolerance?
3. What's the acceptable cache staleness?

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Clients                                   │
│              (Web, Mobile, Third-party Apps)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CDN / Edge                                  │
│              (Static content, edge caching)                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Load Balancer                                 │
│          (Health checks, SSL termination, routing)               │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  API Server   │    │  API Server   │    │  API Server   │
│   Instance 1  │    │   Instance 2  │    │   Instance N  │
│               │    │               │    │               │
│ - Rate limit  │    │ - Rate limit  │    │ - Rate limit  │
│ - Auth        │    │ - Auth        │    │ - Auth        │
│ - Routing     │    │ - Routing     │    │ - Routing     │
└───────────────┘    └───────────────┘    └───────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│    Redis      │    │  PostgreSQL   │    │ Message Queue │
│    Cache      │    │   Primary +   │    │   (RabbitMQ)  │
│               │    │   Replicas    │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
```

### Core Design Principles

1. **Stateless API Servers**: No local state, easy horizontal scaling
2. **Centralized Shared State**: Redis for cache/sessions, PostgreSQL for data
3. **Health-Aware Load Balancing**: Route around failing instances
4. **Defense in Depth**: Rate limiting at edge and application layer

## Deep Dive: Multi-Level Caching (8 minutes)

Caching is the primary mechanism for achieving sub-100ms latency at scale.

### Two-Level Cache Architecture

```javascript
class CacheService {
  constructor(redis) {
    this.redis = redis;
    this.localCache = new Map();
    this.localCacheTTL = 5000; // 5 seconds for local cache
  }

  async get(key) {
    // Level 1: Local in-memory cache (fastest)
    const local = this.localCache.get(key);
    if (local && local.expiry > Date.now()) {
      this.metrics.recordHit('local');
      return local.value;
    }

    // Level 2: Redis cache (shared across instances)
    const cached = await this.redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Populate local cache for subsequent requests
      this.localCache.set(key, {
        value: parsed,
        expiry: Date.now() + this.localCacheTTL
      });
      this.metrics.recordHit('redis');
      return parsed;
    }

    this.metrics.recordMiss();
    return null;
  }

  async set(key, value, ttlSeconds = 300) {
    // Set in Redis (source of truth)
    await this.redis.setex(key, ttlSeconds, JSON.stringify(value));

    // Set in local cache (shorter TTL)
    this.localCache.set(key, {
      value,
      expiry: Date.now() + Math.min(ttlSeconds * 1000, this.localCacheTTL)
    });
  }

  // Cache-aside pattern
  async getOrFetch(key, fetchFn, ttl = 300) {
    const cached = await this.get(key);
    if (cached !== null) {
      return cached;
    }

    const value = await fetchFn();
    await this.set(key, value, ttl);
    return value;
  }
}
```

### Why Two Levels?

| Level | Latency | Shared | Use Case |
|-------|---------|--------|----------|
| Local (L1) | < 1ms | No | Hot data, same instance |
| Redis (L2) | 1-5ms | Yes | Warm data, cross-instance |
| Database (L3) | 10-100ms | Yes | Source of truth |

The local cache prevents Redis round-trips for frequently accessed data. With 5-second TTL, we accept 5 seconds of potential staleness for huge performance gains.

### Cache Invalidation

```javascript
async invalidate(pattern) {
  // Invalidate Redis keys matching pattern
  const keys = await this.redis.keys(pattern);
  if (keys.length > 0) {
    await this.redis.del(...keys);
  }

  // Clear local cache entries matching pattern
  const regex = new RegExp(pattern.replace('*', '.*'));
  for (const key of this.localCache.keys()) {
    if (regex.test(key)) {
      this.localCache.delete(key);
    }
  }
}
```

**Note**: Local cache invalidation only affects the current instance. For critical invalidation, we could use Redis pub/sub to notify all instances.

## Deep Dive: Rate Limiting (7 minutes)

Rate limiting protects the system from abuse and ensures fair usage.

### Sliding Window Algorithm

```javascript
class RateLimiter {
  constructor(redis, config) {
    this.redis = redis;
    this.config = config;
  }

  async checkLimit(identifier, limit) {
    const key = `ratelimit:${identifier}`;
    const now = Date.now();
    const windowStart = now - limit.windowMs;

    // Use sorted set for sliding window
    const pipeline = this.redis.pipeline();

    // Remove entries outside window
    pipeline.zremrangebyscore(key, 0, windowStart);

    // Count current entries
    pipeline.zcard(key);

    // Add current request
    pipeline.zadd(key, now, `${now}:${uuid()}`);

    // Set expiry
    pipeline.expire(key, Math.ceil(limit.windowMs / 1000));

    const results = await pipeline.exec();
    const currentCount = results[1][1];

    if (currentCount >= limit.requests) {
      // Calculate retry-after
      const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
      const retryAfter = Math.ceil((parseInt(oldest[1]) + limit.windowMs - now) / 1000);

      return {
        allowed: false,
        remaining: 0,
        resetAt: Math.ceil((now + limit.windowMs) / 1000),
        retryAfter
      };
    }

    return {
      allowed: true,
      remaining: limit.requests - currentCount - 1,
      resetAt: Math.ceil((now + limit.windowMs) / 1000)
    };
  }
}
```

### Tiered Rate Limits

```javascript
const rateLimitConfig = {
  limits: {
    anonymous: { requests: 100, windowMs: 60000 },     // 100/min
    free:      { requests: 1000, windowMs: 60000 },    // 1000/min
    pro:       { requests: 10000, windowMs: 60000 },   // 10k/min
    enterprise: { requests: 100000, windowMs: 60000 }  // 100k/min
  }
};

// Middleware extracts tier from API key
async function rateLimitMiddleware(req, res, next) {
  const tier = req.user?.tier || 'anonymous';
  const identifier = req.user?.apiKey || req.ip;
  const limit = rateLimitConfig.limits[tier];

  const result = await rateLimiter.checkLimit(identifier, limit);

  res.setHeader('X-RateLimit-Limit', limit.requests);
  res.setHeader('X-RateLimit-Remaining', result.remaining);
  res.setHeader('X-RateLimit-Reset', result.resetAt);

  if (!result.allowed) {
    res.setHeader('Retry-After', result.retryAfter);
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  next();
}
```

### Why Sliding Window?

| Algorithm | Pros | Cons |
|-----------|------|------|
| Fixed Window | Simple | Allows 2x burst at boundary |
| Sliding Window | Smooth limiting | More storage |
| Token Bucket | Configurable burst | Complex |

Sliding window provides the smoothest rate limiting without boundary burst issues.

## Deep Dive: Circuit Breaker (5 minutes)

Circuit breakers prevent cascading failures when downstream services fail.

### Implementation

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.halfOpenRequests = options.halfOpenRequests || 3;

    this.state = 'closed';  // closed, open, half-open
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
  }

  async execute(fn) {
    // Check if circuit should transition from open to half-open
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure >= this.resetTimeout) {
        this.state = 'half-open';
        this.successes = 0;
      } else {
        throw new CircuitOpenError('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.halfOpenRequests) {
        this.state = 'closed';  // Circuit healed
        this.failures = 0;
      }
    } else {
      this.failures = Math.max(0, this.failures - 1);  // Decay failures
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailure = Date.now();

    if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
    }
  }
}
```

### Usage Pattern

```javascript
class ExternalServiceClient {
  constructor() {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000
    });
  }

  async callService(endpoint, data) {
    return this.circuitBreaker.execute(async () => {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(data),
        timeout: 5000
      });

      if (!response.ok) {
        throw new Error(`Service error: ${response.status}`);
      }

      return response.json();
    });
  }
}
```

### Circuit Breaker States

```
CLOSED → (failures reach threshold) → OPEN
OPEN → (after resetTimeout) → HALF-OPEN
HALF-OPEN → (successes reach threshold) → CLOSED
HALF-OPEN → (any failure) → OPEN
```

## Trade-offs and Alternatives (5 minutes)

### 1. Stateless vs. Stateful Servers

**Chose: Stateless**
- Pro: Easy horizontal scaling
- Pro: Simple deployment/rollback
- Pro: No sticky sessions needed
- Con: Need external state store (Redis)

### 2. Load Balancing Algorithm

**Chose: Least Connections with Weights**
- Pro: Better distribution than round-robin
- Pro: Adapts to slow instances
- Con: Slightly more complex
- Alternative: Round-robin (simpler but less adaptive)

### 3. Rate Limiting Location

**Chose: Application layer (centralized Redis)**
- Pro: Consistent across all instances
- Pro: Tied to authentication
- Con: Adds latency
- Alternative: Edge (faster, but less context)

### 4. Cache Consistency

**Chose: Cache-aside with TTL**
- Pro: Simple to implement
- Pro: Automatic staleness handling
- Con: Cache stampede possible
- Alternative: Write-through (consistent but slower writes)

### 5. Authentication

**Chose: API Keys (stateless verification)**
- Pro: Simple, works offline
- Pro: No session storage needed
- Con: Revocation requires key database check
- Alternative: JWT (self-contained, harder revocation)

### Graceful Degradation

```javascript
class GracefulDegradation {
  async executeWithFallback(primaryFn, fallbackFn, cacheKey) {
    try {
      const result = await primaryFn();
      // Cache successful result for fallback
      if (cacheKey) {
        await this.cache.set(`fallback:${cacheKey}`, result, 3600);
      }
      return result;
    } catch (error) {
      console.warn(`Primary failed, trying fallback:`, error.message);

      // Try fallback function
      if (fallbackFn) {
        try {
          return await fallbackFn();
        } catch (e) {
          console.warn(`Fallback failed:`, e.message);
        }
      }

      // Try stale cached data
      if (cacheKey) {
        const cached = await this.cache.get(`fallback:${cacheKey}`);
        if (cached) {
          return { ...cached, _stale: true };
        }
      }

      throw error;
    }
  }
}
```

## Closing Summary (1 minute)

"The scalable API system is built on three foundational patterns:

1. **Stateless horizontal scaling** - API servers hold no local state, enabling us to add capacity by simply adding instances behind the load balancer. All shared state lives in Redis or PostgreSQL.

2. **Two-level caching** - Local in-memory cache (5ms) for hot data, Redis (1-5ms) for warm data, dramatically reducing database load and achieving sub-100ms P99 latency.

3. **Defense in depth** - Rate limiting at application layer with per-tier limits, circuit breakers per external dependency, and graceful degradation with stale cache fallback.

The main trade-off is complexity vs. resilience. We chose sliding window rate limiting and per-dependency circuit breakers because at scale, protecting the system from cascading failures is worth the operational overhead. Future improvements would include distributed tracing for cross-service debugging and adaptive rate limiting based on system load."
